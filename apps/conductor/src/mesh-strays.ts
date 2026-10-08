import { nodes, serviceComponents, type LaunchSpec } from "@sparkdream/launch-spec";
import type { FleetComponentRow } from "./db.js";

/**
 * Stray mesh members: headscale nodes that carry one of this fleet's
 * component names but are not that component's live instance.
 *
 * A replaced component leaves its old node behind on headscale, and closing
 * its lease does not always stop the container: on 2026-10-08 a sentry whose
 * lease had been closed four days earlier was still running on its provider,
 * still on the tailnet, still holding a tunnel to the validator. After a
 * reset-chain (same chain id, same validator key) it served the fresh
 * validator its old blocks 53 and 54 as catch-up, their commits verified,
 * and the new chain halted at 54 with the validator panicking on replay.
 *
 * Every node the launcher places joins with TS_HOSTNAME = its component key,
 * which headscale records as the node's `name` (the unique `given_name` gets
 * a random suffix on collisions). So a node named after a component, at an
 * address that component does not hold, is a leftover. Nodes with any other
 * name (the tmkms host, the operator's machines) are never touched.
 */

export interface MeshNode {
  id: number;
  /** TS_HOSTNAME: the component key for launcher-placed nodes. */
  name: string;
  givenName: string;
  ip: string;
  online: boolean;
  user: string;
  preAuthKeyId?: number;
}

export interface MeshKey {
  id: number;
  key: string;
  /** Unix seconds; 0 when headscale reports none. */
  expiresAt: number;
}

export interface StrayPlan {
  strays: MeshNode[];
  /** Component keys whose live address could not be read: their
   *  namesakes are left alone, since none can be told apart from the live one. */
  unsure: string[];
  /** Preauth keys used only by strays (and not pinned by an op). */
  expire: MeshKey[];
}

type Json = Record<string, any>;

export function parseMeshNodes(stdout: string): MeshNode[] {
  const list = JSON.parse(stdout.trim() || "[]") as Json[];
  return list.map((n) => ({
    id: Number(n.id),
    name: String(n.name ?? ""),
    givenName: String(n.given_name ?? n.givenName ?? n.name ?? ""),
    ip: String((n.ip_addresses ?? n.ipAddresses ?? []).find((a: string) => a.includes(".")) ?? ""),
    online: Boolean(n.online),
    user: String(n.user?.name ?? ""),
    ...(n.pre_auth_key?.id !== undefined ? { preAuthKeyId: Number(n.pre_auth_key.id) } : {}),
  }));
}

export function parseMeshKeys(stdout: string): MeshKey[] {
  const list = JSON.parse(stdout.trim() || "[]") as Json[];
  return list.map((k) => ({
    id: Number(k.id),
    key: String(k.key ?? ""),
    expiresAt: Number(k.expiration?.seconds ?? 0),
  }));
}

/** Every key a node of this fleet may join the mesh under: the spec's nodes
 *  and mesh components, plus any component the fleet has ever placed (a
 *  removed one's leftovers are strays too). */
export function fleetMeshKeys(spec: LaunchSpec, rows: FleetComponentRow[]): Set<string> {
  const keys = new Set<string>();
  for (const n of nodes(spec)) keys.add(n.key);
  for (const c of serviceComponents(spec)) if (c.mesh) keys.add(c.key);
  for (const r of rows) if (r.key !== "headscale" && r.key !== "frontend") keys.add(r.key);
  return keys;
}

/**
 * Decide what to evict. `live` maps each placed component to the address it
 * reports right now; `unreadable` lists placed components that could not be
 * asked. A key with no active row has no live instance, so every node by
 * that name is a leftover.
 */
export function planStrays(opts: {
  nodes: MeshNode[];
  keys: MeshKey[];
  user: string;
  fleetKeys: Set<string>;
  live: Record<string, string>;
  unreadable: Set<string>;
  /** Preauth keys an op still needs (pinned for a placement in progress). */
  protectedKeys?: Set<string>;
  now?: number;
}): StrayPlan {
  const unsure = new Set(opts.unreadable);
  // namesakes on the list but none at the live address means the listing
  // and the component disagree: trust neither and leave that key's nodes alone
  for (const [key, ip] of Object.entries(opts.live)) {
    const namesakes = opts.nodes.filter((n) => n.user === opts.user && n.name === key);
    if (namesakes.length > 0 && !namesakes.some((n) => n.ip === ip)) unsure.add(key);
  }
  const strays = opts.nodes.filter(
    (n) =>
      n.user === opts.user &&
      opts.fleetKeys.has(n.name) &&
      !unsure.has(n.name) &&
      opts.live[n.name] !== n.ip,
  );
  const gone = new Set(strays.map((n) => n.id));
  const stillUsed = new Set(
    opts.nodes.filter((n) => !gone.has(n.id) && n.preAuthKeyId !== undefined).map((n) => n.preAuthKeyId!),
  );
  const strayKeyIds = new Set(strays.filter((n) => n.preAuthKeyId !== undefined).map((n) => n.preAuthKeyId!));
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expire = opts.keys.filter(
    (k) =>
      strayKeyIds.has(k.id) &&
      !stillUsed.has(k.id) &&
      !(opts.protectedKeys?.has(k.key) ?? false) &&
      (k.expiresAt === 0 || k.expiresAt > now),
  );
  return { strays, unsure: [...unsure].sort(), expire };
}

export interface StraySweepDeps {
  /** Run a shell command inside the headscale container; returns stdout. */
  headscale: (script: string) => Promise<string>;
  /** A placed component's live tailnet IPv4, or null when it cannot be asked. */
  liveIp: (row: FleetComponentRow) => Promise<string | null>;
  log: (msg: string) => void;
}

export interface StraySweepResult {
  evicted: Array<{ name: string; givenName: string; ip: string; online: boolean }>;
  expiredKeys: number[];
  unsure: string[];
}

/** Read the mesh and the fleet, evict the strays, expire their keys. */
export async function sweepMeshStrays(
  spec: LaunchSpec,
  rows: FleetComponentRow[],
  deps: StraySweepDeps,
  protectedKeys: Set<string> = new Set(),
): Promise<StraySweepResult> {
  const fleetKeys = fleetMeshKeys(spec, rows);
  const live: Record<string, string> = {};
  const unreadable = new Set<string>();
  for (const row of rows) {
    if (row.state !== "active" || !fleetKeys.has(row.key)) continue;
    // a component off the mesh (or without tailscale at all) reads as
    // unreadable, which protects its namesakes rather than evicting them
    const ip = await deps.liveIp(row).catch(() => null);
    if (ip && /^100\./.test(ip)) live[row.key] = ip;
    else unreadable.add(row.key);
  }
  const meshNodes = parseMeshNodes(await deps.headscale("headscale nodes list --output json"));
  const meshKeys = parseMeshKeys(await deps.headscale("headscale preauthkeys list --output json"));
  const plan = planStrays({
    nodes: meshNodes,
    keys: meshKeys,
    user: spec.network.name,
    fleetKeys,
    live,
    unreadable,
    protectedKeys,
  });
  for (const n of plan.strays) {
    await deps.headscale(`headscale nodes delete --identifier ${n.id} --force`);
    deps.log(
      `evicted stray mesh node ${n.givenName} (${n.ip}, ${n.online ? "online" : "offline"}): ` +
        `${n.name}'s live address is ${live[n.name] ?? "none (not placed)"}`,
    );
  }
  for (const k of plan.expire) {
    await deps.headscale(`headscale preauthkeys expire --id ${k.id} --force`);
  }
  if (plan.expire.length > 0) {
    deps.log(`expired ${plan.expire.length} preauth key(s) only strays used, so a leftover container cannot rejoin`);
  }
  return {
    evicted: plan.strays.map((n) => ({ name: n.name, givenName: n.givenName, ip: n.ip, online: n.online })),
    expiredKeys: plan.expire.map((k) => k.id),
    unsure: plan.unsure,
  };
}

/**
 * Make a node container that is about to be abandoned inert, while it can
 * still be reached: its config and data move aside (nothing is deleted, so
 * a mistake is recoverable by hand), it logs out of the mesh, and the node
 * process stops. A provider that keeps the container running after the
 * lease closes then holds a box that cannot start a node, serve old blocks
 * or sign. The work runs detached because stopping PID 1 ends the shell.
 */
export function disableNodeCmd(nodeHome: string, meshSocket: string): string {
  return (
    `D=${nodeHome}/disabled-$(date +%s); mkdir -p "$D"; ` +
    `for d in config data; do [ -e ${nodeHome}/$d ] && mv ${nodeHome}/$d "$D"/; done; ` +
    `echo "disabled-node:$D"; ` +
    `(sleep 2; tailscale --socket=${meshSocket} logout >/dev/null 2>&1; kill 1) >/dev/null 2>&1 &`
  );
}

/** Matches the tailscale CLI's socket for a component from its rendered SDL
 *  (TS_STATE_DIR), falling back to the node image's default. */
export function meshSocketFromSdl(sdlText: string | undefined, nodeHome: string): string {
  const stateDir = sdlText ? /^\s*-\s*"?TS_STATE_DIR=([^\s"']+)/m.exec(sdlText)?.[1] : undefined;
  return `${stateDir ?? `${nodeHome}/tailscale`}/tailscaled.sock`;
}

/** Preauth keys pinned by the fleet's unfinished ops (a placement mid-flight
 *  joins with one of these and must still be able to). */
export function pinnedOpKeys(readPin: (opId: number) => string | undefined, activeOpIds: number[]): Set<string> {
  const keys = new Set<string>();
  for (const id of activeOpIds) {
    const k = readPin(id)?.trim();
    if (k) keys.add(k);
  }
  return keys;
}
