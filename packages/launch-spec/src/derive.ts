import type { LaunchSpec, RelayerPath } from "./schema.js";
import { COMPONENT_KEYS, COMPONENT_KINDS, componentDomain, type ComponentKey } from "./components.js";
import { NODE_SIZES, type NodeSize, type RoleResources } from "./profiles.js";

/**
 * sparkdream + suffix 1 → "sparkdream-1" (§4). In join mode the chain
 * already exists, so its id comes from the join bundle instead.
 */
export function chainId(spec: LaunchSpec): string {
  return spec.join?.chainId ?? `${spec.network.name}-${spec.network.chainIdSuffix}`;
}

/**
 * The chain's second token. The identity module accepts any bond-denom-shaped
 * value (`u<2-5 letters>.<suffix>`); "udream." + the bond denom's suffix is
 * the conventional default when token.dreamDenom doesn't pick a name. Returns
 * undefined when the bond denom has no suffix to borrow — validateSpec turns
 * that into an error unless token.dreamDenom is set.
 */
export function deriveDreamDenom(token: LaunchSpec["token"]): string | undefined {
  if (token.dreamDenom) return token.dreamDenom;
  const bond = token.bondDenom ?? token.baseDenom;
  const dot = bond.indexOf(".");
  return dot > 0 ? `udream${bond.slice(dot)}` : undefined;
}

/**
 * The mesh's public login URL host. A spec with reuseFleet gets its domain
 * filled from the owning fleet when the launch is created, so by the time
 * any step or renderer runs this is always set; throwing here catches a
 * spec that skipped that resolution (e.g. handed to the engine directly).
 */
export function headscaleDomain(spec: LaunchSpec): string {
  const d = spec.topology.headscale.domain;
  if (!d) {
    throw new Error(
      "headscale domain not resolved — a reuseFleet spec must be resolved against its owning fleet before launch",
    );
  }
  return d;
}

export function validatorMoniker(spec: LaunchSpec, v: number): string {
  return spec.topology.validators.monikers?.[v] ?? `${spec.network.name}-val-${v}`;
}

export function sentryMoniker(spec: LaunchSpec, s: number): string {
  return `${spec.network.name}-sentry-${s}`;
}

/** Tunnel port on a sentry for validator v (§5 step 4): 16656 + v. */
export function tunnelPort(v: number): number {
  return 16656 + v;
}

export interface Topology {
  /** sentryValidators[s] = validator indices sentry s fronts. */
  sentryValidators: number[][];
  /** validatorSentries[v] = sentry indices fronting validator v. */
  validatorSentries: number[][];
}

/** Expand round-robin or explicit mapping into both directions. */
export function resolveTopology(spec: LaunchSpec): Topology {
  // a services fleet runs no nodes
  if (isServicesFleet(spec)) return { sentryValidators: [], validatorSentries: [] };
  const V = spec.topology.validators.count;
  const S = spec.topology.sentries.count;
  const mapping = spec.topology.sentries.mapping;

  const sentryValidators: number[][] =
    mapping === "round-robin"
      ? Array.from({ length: S }, (_, s) => [s % V])
      : mapping.map((vals) => [...vals]);

  const validatorSentries: number[][] = Array.from({ length: V }, () => []);
  for (const [s, vals] of sentryValidators.entries()) {
    for (const v of vals) validatorSentries[v]!.push(s);
  }

  // Round-robin with S < V leaves validators uncovered only when S < V;
  // with S >= V every validator gets at least one sentry. Callers needing
  // coverage guarantees run validateSpec() first (explicit mappings) or
  // check here for round-robin.
  return { sentryValidators, validatorSentries };
}

export type NodeRole = "validator" | "sentry";

export interface NodeRef {
  role: NodeRole;
  index: number;
  /** e.g. "val-0", "sentry-1" — stable key used in state db, tailnet hostnames, SDL names. */
  key: string;
  moniker: string;
}

/** A fleet of shared components with no chain of its own (spec.kind). */
export function isServicesFleet(spec: Pick<LaunchSpec, "kind"> | { kind?: string }): boolean {
  return spec.kind === "services";
}

/** The kinds a services fleet may run: chain-independent ones. */
export const SERVICES_FLEET_COMPONENTS: readonly ComponentKey[] = ["mastodon", "hub", "ntfy", "battle"];

export function nodes(spec: LaunchSpec): NodeRef[] {
  if (isServicesFleet(spec)) return [];
  const out: NodeRef[] = [];
  for (let v = 0; v < spec.topology.validators.count; v++) {
    out.push({ role: "validator", index: v, key: `val-${v}`, moniker: validatorMoniker(spec, v) });
  }
  for (let s = 0; s < spec.topology.sentries.count; s++) {
    out.push({ role: "sentry", index: s, key: `sentry-${s}`, moniker: sentryMoniker(spec, s) });
  }
  return out;
}

/** The role a node key names: "val-N" is a validator, "sentry-N" a sentry. */
export function nodeRole(key: string): NodeRole {
  return key.startsWith("val-") ? "validator" : "sentry";
}

/**
 * What one node deploys with: its infra.nodeSizes tier, else its role's
 * infra.roleSizes tier, else its role's infra.resources.
 */
export function nodeResources(spec: LaunchSpec, key: string): RoleResources {
  const role = nodeRole(key);
  const size = spec.infra.nodeSizes?.[key] ?? spec.infra.roleSizes?.[role];
  return size ? NODE_SIZES[size][role] : spec.infra.resources[role];
}

/**
 * The tier a node runs at: its infra.nodeSizes entry, its role's
 * infra.roleSizes entry, or the tier its role's
 * resources match exactly, or "custom" for hand-edited resources that match
 * none (a resize then moves the node onto a tier).
 */
export function nodeSize(spec: LaunchSpec, key: string): NodeSize | "custom" {
  const role = nodeRole(key);
  const own = spec.infra.nodeSizes?.[key] ?? spec.infra.roleSizes?.[role];
  if (own) return own;
  const res = spec.infra.resources[role];
  const same = (a: RoleResources) =>
    a.cpu === res.cpu &&
    a.memory === res.memory &&
    a.storage.root === res.storage.root &&
    a.storage.data === res.storage.data &&
    a.storage.persistent === res.storage.persistent &&
    a.storage.class === res.storage.class;
  return (Object.keys(NODE_SIZES) as NodeSize[]).find((s) => same(NODE_SIZES[s][role])) ?? "custom";
}

export interface ComponentRef {
  key: ComponentKey;
  /** Public HTTPS domain; set exactly when the kind serves one (COMPONENT_KINDS). */
  domain?: string;
  image: string;
  /** Joins the headscale mesh (needs a preauth key + tunnel wiring). */
  mesh: boolean;
  /** Runs sshd on 2222 (uploads, SSH-driven configuration). */
  ssh: boolean;
}

/**
 * Enabled service components, in COMPONENT_KEYS order. They are deployed in
 * the Phase D batch alongside the nodes; what each one needs (mesh, SSH, a
 * domain, a sentry) comes from its entry in COMPONENT_KINDS.
 */
export function serviceComponents(spec: LaunchSpec): ComponentRef[] {
  const out: ComponentRef[] = [];
  for (const key of COMPONENT_KEYS) {
    const kind = COMPONENT_KINDS[key];
    const toggle = spec.topology.components[key];
    if (!toggle?.enabled) continue;
    const image = spec.images[key];
    const domain = kind.domain ? componentDomain(spec, key) : undefined;
    if (!image || (kind.domain && !domain)) {
      throw new Error(`${key} enabled but ${image ? "domain" : "image"} missing — validate-spec should have caught this`);
    }
    out.push({ key, ...(domain ? { domain } : {}), image, mesh: kind.mesh, ssh: kind.ssh });
  }
  return out;
}

/**
 * The IBC port and channel version each relay path kind opens. They must
 * match the modules on both chains: ICS-20 for transfer, x/federation's
 * params (ibc_port, ibc_channel_version) for federation — its
 * OnChanOpenInit/Try refuse any other version.
 */
export const RELAY_CHANNELS = {
  transfer: { port: "transfer", version: "ics20-1" },
  federation: { port: "federation", version: "federation-1" },
} as const;

/** The enabled relayer's paths, or none. */
export function relayerPaths(spec: LaunchSpec): RelayerPath[] {
  const relayer = spec.topology.components.relayer;
  return relayer?.enabled ? relayer.paths : [];
}

/** The Mastodon streaming API's domain: its own, or streaming.<domain>. */
export function mastodonStreamingDomain(spec: LaunchSpec): string | undefined {
  const m = spec.topology.components.mastodon;
  if (!m?.enabled || !m.domain) return undefined;
  return m.streamingDomain ?? `streaming.${m.domain}`;
}

/**
 * The default wallet sign-in domain for an instance at `domain`, at the same
 * depth: mstdn.example.io → mstdn-login.example.io. A proxy's free edge
 * certificate (Cloudflare's covers the zone and one level below it) then
 * covers it whenever it covers the instance, which login.mstdn.example.io
 * would not. A two-label domain, most likely the zone itself, gets
 * login.<domain>, one level below.
 */
export function defaultLoginDomain(domain: string): string {
  const labels = domain.split(".");
  if (labels.length <= 2) return `login.${domain}`;
  return [`${labels[0]}-login`, ...labels.slice(1)].join(".");
}

/** The Mastodon wallet sign-in's own ingress, when it is on. */
export function mastodonLoginDomain(spec: LaunchSpec): string | undefined {
  const m = spec.topology.components.mastodon;
  if (!m?.enabled || !m.domain || !m.walletLogin?.enabled) return undefined;
  return m.walletLogin.domain ?? defaultLoginDomain(m.domain);
}

/** True when some enabled workload consumes sentry-0's gRPC (9090). */
export function grpcRequired(spec: LaunchSpec): boolean {
  return serviceComponents(spec).some((c) => COMPONENT_KINDS[c.key].needsGrpc);
}

/** True when some enabled workload consumes the sentries' LCD (1317). */
export function lcdRequired(spec: LaunchSpec): boolean {
  return (
    serviceComponents(spec).some((c) => COMPONENT_KINDS[c.key].needsLcd) ||
    Boolean(spec.topology.publicEndpoints?.api)
  );
}

/** Genesis session.max_expiration, in days (§5 session keys). */
export function sessionMaxDays(spec: LaunchSpec): number {
  return spec.chainParams.session?.maxExpirationDays ?? (spec.network.type === "mainnet" ? 30 : 90);
}

/** A daemon's session-key lifetime, before the chain's own cap applies. */
export function sessionDays(spec: LaunchSpec, session: { days?: number | undefined } | undefined): number {
  return session?.days ?? (spec.network.type === "mainnet" ? 30 : 90);
}

/**
 * The bridge's account name on its Mastodon instance: the spec's, else by
 * the network the bridge anchors to, so one instance can carry a bridge per
 * network ("bridge" for mainnet, "bridgetest", "bridgedev").
 */
export function bridgeAccount(spec: LaunchSpec): string {
  const own = spec.topology.components.mastodon?.bridge?.enabled
    ? spec.topology.components.mastodon.bridge.account
    : spec.topology.components.bridge?.account;
  if (own) return own;
  return spec.network.type === "mainnet" ? "bridge" : spec.network.type === "testnet" ? "bridgetest" : "bridgedev";
}

/** The fleet's bridge, whichever form it takes: the Mastodon component's
 *  sidecar or a standalone bridge component. Undefined when it runs none. */
export function fleetBridge(spec: LaunchSpec):
  | { kind: "sidecar" | "standalone"; domain: string | undefined; link: NonNullable<LaunchSpec["topology"]["components"]["bridge"]> | NonNullable<NonNullable<LaunchSpec["topology"]["components"]["mastodon"]>["bridge"]> }
  | undefined {
  const m = spec.topology.components.mastodon;
  if (m?.enabled && m.bridge?.enabled) return { kind: "sidecar", domain: m.domain, link: m.bridge };
  const b = spec.topology.components.bridge;
  if (b?.enabled) return { kind: "standalone", domain: b.target.domain, link: b };
  return undefined;
}

/** Every peer the fleet's bridge anchors for: its instance's domain, then
 *  the other servers bridged as peers of their own (bridge peers). */
export function bridgePeerIds(spec: LaunchSpec): string[] {
  const b = fleetBridge(spec);
  if (!b?.domain) return [];
  return [b.domain, ...(b.link.peers ?? []).map((p) => p.id)];
}

