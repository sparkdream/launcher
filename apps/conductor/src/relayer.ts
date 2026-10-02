import fs from "node:fs";
import path from "node:path";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { stringToPath } from "@cosmjs/crypto";
import {
  chainId,
  RELAY_CHANNELS,
  relayerPaths,
  withDefaults,
  type LaunchSpec,
  type RelayerPath,
} from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, LaunchRow } from "./db.js";
import type { Tunnel } from "./components/types.js";
import { readSecretFile, writeSecretFile } from "./secrets.js";
import { mayUseFleet } from "./bridge-target.js";

/**
 * The relayer component: one Hermes process relaying every path in
 * topology.components.relayer. This module turns the spec into what the
 * relayer image consumes (deploy/docker/hermes/ in the chain repo): a Hermes
 * config, a path manifest for relayer-bringup, and the mesh tunnels that put
 * each Spark Dream chain's sentry-0 gRPC and RPC on the relayer's localhost.
 */

/** Where the image keeps its config, manifest, keys and channels.json. */
export const RELAYER_DIR = "/data/relayer";
/** Hermes key name on every chain (one key store per chain id). */
export const RELAYER_KEY_NAME = "relayer";
/** mnemonics.json entry holding the relayer's mnemonic, the one secret every
 *  chain's key derives from (each with its own prefix and HD path). */
export const RELAYER_ACCOUNT = "relayer";
const DEFAULT_HD_PATH = "m/44'/118'/0'/0/0";

const GRPC_PORT = 9090;
const RPC_PORT = 26657;
/** Hermes' gas_multiplier unless an endpoint counterparty sets its own. 1.5
 *  ran out creating a client on Spark Dream chains (see deploy/relayer). */
const GAS_MULTIPLIER = 2.5;

/** A tunnel peer in another fleet: `<component>@<launchId>`. Colon-free, so
 *  the TS_TUNNEL_n=<local>:<target>:<remote> env stays unambiguous. */
export function fleetPeer(key: string, launchId: string): string {
  return `${key}@${launchId}`;
}

export function parseFleetPeer(peer: string): { key: string; launchId?: string } {
  const at = peer.indexOf("@");
  return at < 0 ? { key: peer } : { key: peer.slice(0, at), launchId: peer.slice(at + 1) };
}

/** Distinct fleet counterparties reached over the mesh, in path order. Their
 *  index fixes their tunnel ports, so the order must not depend on anything
 *  but the spec. */
export function relayFleets(spec: LaunchSpec): string[] {
  const out: string[] = [];
  for (const p of relayerPaths(spec)) {
    const cp = p.counterparty;
    if ("fleet" in cp && cp.via !== "public" && !out.includes(cp.fleet)) out.push(cp.fleet);
  }
  return out;
}

/** Distinct fleet counterparties reached over their sentry's public ports
 *  (a sister chain on another mesh), in path order. */
export function publicRelayFleets(spec: LaunchSpec): string[] {
  const out: string[] = [];
  for (const p of relayerPaths(spec)) {
    const cp = p.counterparty;
    if ("fleet" in cp && cp.via === "public" && !out.includes(cp.fleet)) out.push(cp.fleet);
  }
  return out;
}

/** Where a fleet's sentry-0 answers publicly for relayers on other meshes:
 *  its provider-forwarded gRPC and RPC, read from lease status when a link
 *  opened them. Keyed by that sentry's dseq, since a relaunch moves both. */
export interface PublicRelayEndpoint {
  dseq: string;
  grpc: string;
  rpc: string;
}

const publicEndpointSetting = (launchId: string) => `relay-public:${launchId}`;

export function savePublicRelayEndpoint(db: ConductorDb, launchId: string, ep: PublicRelayEndpoint): void {
  db.setSetting(publicEndpointSetting(launchId), JSON.stringify(ep));
}

/** The stored public endpoint of a fleet's sentry-0, if it is still that
 *  sentry's (a relaunched sentry-0 answers on other ports). */
/** True when a public endpoint was recorded for a sentry-0 that has since
 *  moved to another deployment: relayers using it dial dead ports. */
export function publicRelayEndpointStale(db: ConductorDb, launchId: string): boolean {
  const raw = db.getSetting(publicEndpointSetting(launchId));
  if (!raw) return false;
  const sentry = db.listFleetComponents(launchId).find((c) => c.key === "sentry-0");
  return Boolean(sentry && sentry.state !== "closed" && sentry.dseq !== (JSON.parse(raw) as PublicRelayEndpoint).dseq);
}

export function publicRelayEndpoint(db: ConductorDb, launchId: string): PublicRelayEndpoint | undefined {
  const raw = db.getSetting(publicEndpointSetting(launchId));
  if (!raw) return undefined;
  const ep = JSON.parse(raw) as PublicRelayEndpoint;
  const sentry = db.listFleetComponents(launchId).find((c) => c.key === "sentry-0");
  return sentry && sentry.dseq === ep.dseq ? ep : undefined;
}

/** Local ports the relayer reaches chain `i` on: 0 is this fleet's own
 *  sentry-0, 1..n the fleet counterparties in relayFleets order. */
function tunnelPorts(i: number): { grpc: number; rpc: number } {
  return { grpc: GRPC_PORT + i, rpc: RPC_PORT + i };
}

/** The relayer's mesh tunnels: gRPC + RPC on this fleet's sentry-0 and on
 *  each fleet counterparty's. Endpoint counterparties are dialed directly. */
export function relayerTunnels(spec: LaunchSpec): Tunnel[] {
  const out: Tunnel[] = [];
  const add = (i: number, peer: string) => {
    const ports = tunnelPorts(i);
    out.push({ local: ports.grpc, remote: GRPC_PORT, peer });
    out.push({ local: ports.rpc, remote: RPC_PORT, peer });
  };
  add(0, "sentry-0");
  relayFleets(spec).forEach((launchId, i) => add(i + 1, fleetPeer("sentry-0", launchId)));
  return out;
}

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

/** The mesh a fleet's components join: either fleet borrows the other's
 *  headscale, or both borrow a third's. A launch not created yet is its own. */
function meshOf(launchId: string | undefined, spec: LaunchSpec): string | undefined {
  return spec.topology.headscale.reuseFleet ?? launchId;
}

/** Whether two fleets share a mesh, so the relayer can tunnel to the other's sentry. */
export function sameMesh(db: ConductorDb, spec: LaunchSpec, selfId: string | undefined, otherId: string): boolean {
  const other = db.getLaunch(otherId);
  return Boolean(other) && meshOf(otherId, specOf(other!)) === meshOf(selfId, spec);
}

/**
 * Resolve a fleet counterparty in place: its reference becomes the launch id
 * and its route is settled. A fleet on this fleet's mesh is tunnelled to
 * unless the path asks for public; one on another mesh can only be reached
 * over its sentry's public ports, so asking for mesh there is refused.
 */
export function resolveRelayCounterparty(
  db: ConductorDb,
  spec: LaunchSpec,
  owner: string,
  cp: { fleet: string; via?: "mesh" | "public" | undefined },
  selfId?: string,
): void {
  const id = resolveRelayFleet(db, spec, owner, cp.fleet, selfId);
  cp.fleet = id;
  if (sameMesh(db, spec, selfId, id)) {
    if (cp.via !== "public") delete cp.via;
    return;
  }
  if (cp.via === "mesh") {
    throw new Error(
      `relayer path to "${id}": that fleet is on a different mesh, so its sentry can only be reached ` +
        `over its public ports (via: public), or set topology.headscale.reuseFleet to share one mesh`,
    );
  }
  cp.via = "public";
}

/**
 * Resolve a path's fleet reference (launch id or unique network name) to the
 * launch id, checking the other fleet is one this relayer can relay to: this
 * wallet's or shared with it (sharing.wallets), on the same Akash network,
 * finished launching, with a running sentry-0.
 * Throws with a user-facing message otherwise. The route (mesh or public) is
 * resolveRelayCounterparty's to settle.
 */
export function resolveRelayFleet(
  db: ConductorDb,
  spec: LaunchSpec,
  owner: string,
  ref: string,
  selfId?: string,
): string {
  let target = db.getLaunch(ref);
  if (!target) {
    const matches = db.listLaunches().filter((l) => {
      if (l.status === "aborted" || l.id === selfId) return false;
      try {
        return specOf(l).network.name === ref;
      } catch {
        return false;
      }
    });
    if (matches.length > 1) {
      throw new Error(`relayer path to "${ref}" matches ${matches.length} fleets — reference the launch id instead`);
    }
    target = matches[0];
  }
  const at = `relayer path to "${ref}"`;
  if (!target) throw new Error(`${at}: no such fleet on this launcher`);
  if (target.id === selfId) throw new Error(`${at}: a fleet cannot relay to itself`);
  if (target.status === "aborted") throw new Error(`${at}: that fleet was shut down`);
  if (!mayUseFleet(target, owner)) {
    throw new Error(`${at}: that fleet belongs to a different wallet (its owner can add this wallet to its sharing list)`);
  }
  const other = specOf(target);
  if (other.infra.akashNetwork !== spec.infra.akashNetwork) {
    throw new Error(`${at}: that fleet runs on Akash ${other.infra.akashNetwork}, this one on ${spec.infra.akashNetwork}`);
  }
  if (db.getStep(target.id, "finalize")?.status !== "done") {
    throw new Error(`${at}: that fleet has not finished launching`);
  }
  const sentry = db.listFleetComponents(target.id).find((c) => c.key === "sentry-0");
  if (!sentry || sentry.state === "closed") throw new Error(`${at}: that fleet has no running sentry-0`);
  return target.id;
}

/** One chain the relayer signs on. */
export interface RelayChain {
  chainId: string;
  bech32Prefix: string;
  gasDenom: string;
  gasPrice: number;
  /** Follow the chain's fee market, never above max (Hermes dynamic_gas_price). */
  dynamicGasPrice?: { multiplier: number; max: number };
  gasMultiplier: number;
  hdPath: string;
  trustingPeriod?: string;
  rpc: string;
  grpc: string;
  eventSource: "push" | "pull";
  ws: string;
  /** LCD, when known: lets relayer-fundcheck see whether the key's account exists. */
  lcd?: string;
  /** The launch running it, for a Spark Dream chain on this launcher. */
  launchId?: string;
}

/** Relay transactions a suggested top-up covers: weeks of light traffic. */
const TOPUP_TXS = 1_000;
/** Gas of a typical relay tx (client update + one packet). */
export const RELAY_TX_GAS = 300_000;

/**
 * The most the relayer key should hold on `chain`, in its gas denom, if the
 * spec bounds it: relayer.maxBalance for a Spark Dream fleet, the path's own
 * maxBalance for a chain named by endpoints. The key sits on the relayer's
 * provider, so this is what a compromised provider can take.
 */
export function relayerCap(spec: LaunchSpec, chain: Pick<RelayChain, "chainId" | "launchId">): bigint | undefined {
  const relayer = spec.topology.components.relayer;
  if (!relayer) return undefined;
  if (chain.launchId) return BigInt(relayer.maxBalance);
  for (const p of relayer.paths) {
    const cp = p.counterparty;
    if (!("fleet" in cp) && cp.chainId === chain.chainId && cp.maxBalance) return BigInt(cp.maxBalance);
  }
  return undefined;
}

/** A top-up worth asking for: ~1000 relay txs of gas, never above the cap.
 *  On a fee market that is at its max price, the most Hermes will pay. */
export function suggestedTopUp(chain: Pick<RelayChain, "gasPrice" | "dynamicGasPrice">, cap: bigint | undefined): bigint {
  const price = Math.max(chain.gasPrice, chain.dynamicGasPrice?.max ?? 0);
  const gas = BigInt(Math.ceil(price * RELAY_TX_GAS * TOPUP_TXS));
  return cap !== undefined && cap < gas ? cap : gas;
}

export interface RelayPlanPath {
  id: string;
  kind: RelayerPath["kind"];
  port: string;
  version: string;
  /** This fleet's chain id. */
  a: string;
  b: string;
}

export interface RelayPlan {
  /** This fleet's chain first. */
  chains: RelayChain[];
  paths: RelayPlanPath[];
}

/** A Spark Dream chain as the relayer reaches it: over its local tunnel ports. */
function sparkDreamChain(spec: LaunchSpec, index: number, launchId: string): RelayChain {
  const ports = tunnelPorts(index);
  return {
    chainId: chainId(spec),
    bech32Prefix: spec.network.bech32Prefix,
    gasDenom: spec.token.baseDenom,
    gasPrice: Number(spec.token.minGasPrice),
    gasMultiplier: GAS_MULTIPLIER,
    hdPath: DEFAULT_HD_PATH,
    rpc: `http://127.0.0.1:${ports.rpc}`,
    grpc: `http://127.0.0.1:${ports.grpc}`,
    eventSource: "push",
    ws: `ws://127.0.0.1:${ports.rpc}/websocket`,
    ...(spec.topology.publicEndpoints?.api ? { lcd: `https://${spec.topology.publicEndpoints.api}` } : {}),
    launchId,
  };
}

/** A Spark Dream fleet on another mesh, as the relayer reaches it: over its
 *  sentry-0's provider-forwarded ports. */
function publicSparkDreamChain(spec: LaunchSpec, launchId: string, ep: PublicRelayEndpoint | undefined): RelayChain {
  const rpc = ep?.rpc ?? "";
  return {
    ...sparkDreamChain(spec, 0, launchId),
    rpc,
    grpc: ep?.grpc ?? "",
    ws: rpc ? `${rpc.replace(/^http/, "ws")}/websocket` : "",
  };
}

/** Everything the relayer needs to know, resolved against the launcher's db. */
export function relayPlan(db: ConductorDb, launchId: string, spec: LaunchSpec): RelayPlan {
  const own = sparkDreamChain(spec, 0, launchId);
  const chains: RelayChain[] = [own];
  const fleetSpec = (id: string) => {
    const launch = db.getLaunch(id);
    if (!launch) throw new Error(`relayer counterparty fleet ${id} is gone from this launcher`);
    return specOf(launch);
  };
  relayFleets(spec).forEach((id, i) => chains.push(sparkDreamChain(fleetSpec(id), i + 1, id)));
  for (const id of publicRelayFleets(spec)) {
    // the link opens these ports before rendering anything; until then (or
    // once its sentry moved) the chain is known but has nowhere to dial
    chains.push(publicSparkDreamChain(fleetSpec(id), id, publicRelayEndpoint(db, id)));
  }
  const paths: RelayPlanPath[] = [];
  for (const p of relayerPaths(spec)) {
    const cp = p.counterparty;
    let b: string;
    if ("fleet" in cp) {
      b = chains.find((c) => c.launchId === cp.fleet)!.chainId;
    } else {
      b = cp.chainId;
      if (!chains.some((c) => c.chainId === cp.chainId)) {
        chains.push({
          chainId: cp.chainId,
          bech32Prefix: cp.bech32Prefix,
          gasDenom: cp.gasDenom,
          gasPrice: cp.gasPrice,
          ...(cp.dynamicGasPrice ? { dynamicGasPrice: cp.dynamicGasPrice } : {}),
          gasMultiplier: cp.gasMultiplier ?? GAS_MULTIPLIER,
          hdPath: cp.hdPath,
          ...(cp.trustingPeriod ? { trustingPeriod: cp.trustingPeriod } : {}),
          rpc: cp.rpc,
          grpc: cp.grpc,
          eventSource: cp.eventSource ?? "push",
          ws: cp.ws ?? `${cp.rpc.replace(/^http/, "ws").replace(/\/$/, "")}/websocket`,
          ...(cp.lcd ? { lcd: cp.lcd } : {}),
        });
      }
    }
    const ch = RELAY_CHANNELS[p.kind];
    paths.push({ id: p.id, kind: p.kind, port: ch.port, version: ch.version, a: own.chainId, b });
  }
  return { chains, paths };
}

/** One opened path, as relayer-bringup writes it to channels.json. */
export interface RelayChannel {
  id: string;
  port: string;
  version: string;
  a: { chain: string; client: string; connection: string; channel: string };
  b: { chain: string; client: string; connection: string; channel: string };
}

const q = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** TOML float: Hermes reads gas_price.price as f64, which an integer literal is not. */
const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

/**
 * The Hermes config. Before bringup the packet filter admits each path's port
 * on any channel (bringup opens channels, and must be able to); once the
 * channels are known it is pinned to exactly those, so a stranger opening a
 * transfer channel on the same connection does not get relayed on our gas.
 */
export function renderHermesConfig(plan: RelayPlan, channels?: RelayChannel[]): string {
  const out: string[] = [
    "# Rendered by the SparkDream launcher (relayer component). Edits here are",
    "# overwritten the next time the launcher links the relayer.",
    "[global]",
    "log_level = 'info'",
    "",
    "[mode.clients]",
    "enabled = true",
    "refresh = true",
    "misbehaviour = true",
    "",
    "[mode.connections]",
    "enabled = true",
    "",
    "[mode.channels]",
    "enabled = true",
    "",
    "[mode.packets]",
    "enabled = true",
    "clear_interval = 100",
    "clear_on_start = true",
    "tx_confirmation = true",
    "",
    // Hermes requires host and port on both blocks even when disabled
    "[rest]",
    "enabled = false",
    "host = '127.0.0.1'",
    "port = 3000",
    "",
    "[telemetry]",
    "enabled = false",
    "host = '127.0.0.1'",
    "port = 3001",
    "",
  ];
  for (const c of plan.chains) {
    const filter: string[] = [];
    for (const p of plan.paths) {
      if (p.a !== c.chainId && p.b !== c.chainId) continue;
      const opened = channels?.find((ch) => ch.id === p.id);
      const end = opened ? (opened.a.chain === c.chainId ? opened.a : opened.b) : undefined;
      const entry = `[${q(p.port)}, ${q(end?.channel ?? "*")}]`;
      if (!filter.includes(entry)) filter.push(entry);
    }
    out.push(
      "[[chains]]",
      `id = ${q(c.chainId)}`,
      "type = 'CosmosSdk'",
      `rpc_addr = ${q(c.rpc)}`,
      `grpc_addr = ${q(c.grpc)}`,
      c.eventSource === "pull"
        ? "event_source = { mode = 'pull', interval = '1s', max_retries = 4 }"
        : `event_source = { mode = 'push', url = ${q(c.ws)}, batch_delay = '500ms' }`,
      "rpc_timeout = '20s'",
      `account_prefix = ${q(c.bech32Prefix)}`,
      `key_name = ${q(RELAYER_KEY_NAME)}`,
      `key_store_folder = ${q(`${RELAYER_DIR}/keys`)}`,
      "address_type = { derivation = 'cosmos' }",
      "store_prefix = 'ibc'",
      "default_gas = 200000",
      "max_gas = 4000000",
      `gas_price = { price = ${float(c.gasPrice)}, denom = ${q(c.gasDenom)} }`,
      ...(c.dynamicGasPrice
        ? [
            `dynamic_gas_price = { enabled = true, multiplier = ${float(c.dynamicGasPrice.multiplier)}, ` +
              `max = ${float(c.dynamicGasPrice.max)} }`,
          ]
        : []),
      `gas_multiplier = ${float(c.gasMultiplier)}`,
      "max_msg_num = 30",
      "max_tx_size = 180000",
      "clock_drift = '10s'",
      "max_block_time = '30s'",
      ...(c.trustingPeriod ? [`trusting_period = ${q(c.trustingPeriod)}`] : []),
      "trust_threshold = { numerator = '2', denominator = '3' }",
      "memo_prefix = 'sparkdream-launcher'",
      "",
      "[chains.packet_filter]",
      "policy = 'allow'",
      `list = [${filter.join(", ")}]`,
      "",
    );
  }
  return out.join("\n");
}

/** relayer-bringup's path manifest ($RELAYER_DIR/relayer.json). */
export function renderRelayManifest(plan: RelayPlan): string {
  return JSON.stringify(
    {
      chains: plan.chains.map((c) => ({ id: c.chainId, hd_path: c.hdPath, ...(c.lcd ? { lcd: c.lcd } : {}) })),
      paths: plan.paths.map((p) => ({ id: p.id, a: p.a, b: p.b, port: p.port, version: p.version, order: "unordered" })),
    },
    null,
    2,
  );
}

/**
 * The relayer's mnemonic, generated into secrets/mnemonics.json (beside the
 * fleet's other generated accounts, so it is exported and revealed the same
 * way) the first time anything asks for it.
 */
export async function ensureRelayerMnemonic(secretsDir: string): Promise<string> {
  const file = path.join(secretsDir, "mnemonics.json");
  const all: Record<string, string> = fs.existsSync(file) ? JSON.parse(readSecretFile(file)) : {};
  if (!all[RELAYER_ACCOUNT]) {
    all[RELAYER_ACCOUNT] = (await Secp256k1HdWallet.generate(24)).mnemonic;
    writeSecretFile(file, JSON.stringify(all, null, 2));
  }
  return all[RELAYER_ACCOUNT]!;
}

/** The relayer's address on a chain (same mnemonic everywhere). */
export async function relayerAddress(mnemonic: string, chain: Pick<RelayChain, "bech32Prefix" | "hdPath">): Promise<string> {
  const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: chain.bech32Prefix,
    hdPaths: [stringToPath(chain.hdPath)],
  });
  const [account] = await wallet.getAccounts();
  return account!.address;
}

/** Fleets whose relayer dials this launch's sentry-0 (over the mesh or its
 *  public ports), so it must keep serving gRPC even though its own spec asks
 *  for none. */
export function relayedBy(db: ConductorDb, launchId: string): string[] {
  return db
    .listLaunches()
    .filter((l) => {
      if (l.id === launchId || l.status === "aborted") return false;
      try {
        const s2 = specOf(l);
        return [...relayFleets(s2), ...publicRelayFleets(s2)].includes(launchId);
      } catch {
        return false;
      }
    })
    .map((l) => l.id);
}

/** A tunnel peer's fleet row: own-fleet keys from this launch, `key@launch`
 *  from that launch. */
export function peerRow(db: ConductorDb, launchId: string, peer: string): FleetComponentRow | undefined {
  const { key, launchId: other } = parseFleetPeer(peer);
  return (db.listFleetComponents(other ?? launchId) as FleetComponentRow[]).find((c) => c.key === key);
}

/**
 * Public REST APIs of the chains this fleet's chain relays with, by chain id:
 * fleets its own relayer reaches, fleets whose relayer reaches it, and
 * endpoint counterparties that name an LCD. Handed to its frontend
 * (PEER_CHAINS), whose federation register form fetches a peer chain's
 * identity from it: nothing on chain records where a peer's API answers.
 */
export function sisterChainApis(db: ConductorDb, launchId: string, spec: LaunchSpec): Record<string, string> {
  const out: Record<string, string> = {};
  const addFleet = (id: string) => {
    const launch = db.getLaunch(id);
    if (!launch || launch.status === "aborted") return;
    let other: LaunchSpec;
    try {
      other = specOf(launch);
    } catch {
      return;
    }
    const api = other.topology.publicEndpoints?.api;
    if (api) out[chainId(other)] = `https://${api}`;
  };
  for (const id of [...relayFleets(spec), ...publicRelayFleets(spec)]) addFleet(id);
  for (const id of relayedBy(db, launchId)) addFleet(id);
  for (const p of relayerPaths(spec)) {
    const cp = p.counterparty;
    if (!("fleet" in cp) && cp.lcd) out[cp.chainId] = cp.lcd.replace(/\/+$/, "");
  }
  return out;
}
