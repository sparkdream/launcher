import type { LaunchSpec } from "./schema.js";

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

export function nodes(spec: LaunchSpec): NodeRef[] {
  const out: NodeRef[] = [];
  for (let v = 0; v < spec.topology.validators.count; v++) {
    out.push({ role: "validator", index: v, key: `val-${v}`, moniker: validatorMoniker(spec, v) });
  }
  for (let s = 0; s < spec.topology.sentries.count; s++) {
    out.push({ role: "sentry", index: s, key: `sentry-${s}`, moniker: sentryMoniker(spec, s) });
  }
  return out;
}

export type ComponentKey = "explorer" | "frontend";

export interface ComponentRef {
  key: ComponentKey;
  domain: string;
  image: string;
  /** Joins the headscale mesh (needs a preauth key + tunnel wiring). */
  mesh: boolean;
}

/**
 * Enabled stateless components (§5 "Component relaunch & close"): the
 * explorer joins the mesh and tunnels to sentry-0's LCD/RPC; the frontend
 * is env-configured only and talks to the public endpoints. Both are
 * deployed in the Phase D batch alongside the nodes.
 */
export function statelessComponents(spec: LaunchSpec): ComponentRef[] {
  const out: ComponentRef[] = [];
  for (const [key, mesh] of [["explorer", true], ["frontend", false]] as const) {
    const toggle = spec.topology.components[key];
    if (!toggle.enabled) continue;
    const image = spec.images[key];
    if (!toggle.domain || !image) {
      throw new Error(`${key} enabled but domain or image missing — validate-spec should have caught this`);
    }
    out.push({ key, domain: toggle.domain, image, mesh });
  }
  return out;
}

/** True when some enabled workload consumes the sentries' LCD (1317). */
export function lcdRequired(spec: LaunchSpec): boolean {
  return (
    spec.topology.components.explorer.enabled ||
    spec.topology.components.frontend.enabled ||
    Boolean(spec.topology.publicEndpoints?.api)
  );
}
