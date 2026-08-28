import type { LaunchSpec } from "./schema.js";

/**
 * Fields a chain reset cannot change: the deployed fleet embodies them.
 * A reset rebuilds genesis on the SAME deployments, so anything the
 * running leases encode — topology, domains, resources, the identity the
 * bech32 prefix and network type feed into — has to stay as launched.
 * Genesis-shaping fields (accounts + members, chainParams, token) and the
 * node image are free to move.
 *
 * The chain-id is frozen too, suffix included: a reset restarts the SAME
 * chain, so everything pointed at it (explorers, wallets, peers, the
 * signers' own config) keeps working. What the reset does discard is the
 * signer watermark that made the old chain-id safe to leave behind, which
 * is why the op stops for the operator to clear signer state before any
 * node restarts.
 *
 * Each entry is a dotted path into the spec; `get`/`set` walk it so both
 * the conductor's guard and the web UI's reset flow read one list.
 */
export const RESET_FROZEN_PATHS = [
  "network.name",
  "network.type",
  "network.chainIdSuffix",
  "network.bech32Prefix",
  "security.keyMode",
  "topology.validators.count",
  "topology.sentries.count",
  "topology.components",
  "topology.publicEndpoints",
  "topology.headscale",
  "infra",
  "images.headscale",
  "images.explorer",
  "images.frontend",
  "images.hub",
] as const;

type Obj = Record<string, unknown>;

function get(spec: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (v, key) => (v === null || typeof v !== "object" ? undefined : (v as Obj)[key]),
    spec,
  );
}

/** Writes `value` at `path`, creating intermediate objects as needed. */
function set(spec: Obj, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cur: Obj = spec;
  for (const key of keys) {
    const next = cur[key];
    if (next === null || typeof next !== "object") cur[key] = {};
    cur = cur[key] as Obj;
  }
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/** Every frozen path where `proposed` differs from the deployed spec. */
export function frozenResetViolations(current: LaunchSpec, proposed: LaunchSpec): string[] {
  return RESET_FROZEN_PATHS.filter(
    (path) => JSON.stringify(get(current, path)) !== JSON.stringify(get(proposed, path)),
  );
}

/**
 * Copy the deployed spec's frozen fields onto a proposed one, in place.
 * Lets a caller offer a reset built from an edited spec without the edits
 * being able to contradict the running fleet: what the reset can change,
 * it takes from the edit; what it cannot, it takes from the deployment.
 */
export function applyFrozenReset<T extends LaunchSpec>(current: LaunchSpec, proposed: T): T {
  for (const path of RESET_FROZEN_PATHS) set(proposed as unknown as Obj, path, get(current, path));
  return proposed;
}
