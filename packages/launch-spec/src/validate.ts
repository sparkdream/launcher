import { launchSpecSchema, type LaunchSpec, type NetworkType } from "./schema.js";
import { profiles } from "./profiles.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge: values from `over` win; arrays replace, objects merge. */
function merge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
    return out;
  }
  return over;
}

/**
 * Fill a partial spec with the network-type profile's defaults, then parse.
 * Throws ZodError on schema violations.
 */
export function withDefaults(input: unknown): LaunchSpec {
  if (!isPlainObject(input) || !isPlainObject(input.network)) {
    return launchSpecSchema.parse(input); // let zod produce the error
  }
  const type = input.network.type as NetworkType;
  const profile = profiles[type];
  if (!profile) return launchSpecSchema.parse(input);
  return launchSpecSchema.parse(merge(profile, input));
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  ok: boolean;
}

/**
 * Cross-field checks beyond the zod schema — §5 step 1 (validate-spec).
 * Operates on a schema-valid spec.
 */
export function validateSpec(spec: LaunchSpec): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  const mainnet = spec.network.type === "mainnet";
  const V = spec.topology.validators.count;
  const S = spec.topology.sentries.count;

  // Denoms & addresses
  if (spec.token.bondDenom && spec.token.bondDenom !== spec.token.baseDenom) {
    warn("token.bondDenom", "bond denom differs from fee denom — double-check gentx amounts");
  }
  for (const [i, acct] of spec.accounts.initial.entries()) {
    if (acct.address && !acct.address.startsWith(spec.network.bech32Prefix + "1")) {
      err(
        `accounts.initial[${i}].address`,
        `address does not match bech32 prefix "${spec.network.bech32Prefix}"`,
      );
    }
  }

  // Storage persistence (§4): validators and sentries must keep persistent data volumes.
  for (const role of ["validator", "sentry"] as const) {
    if (!spec.infra.resources[role].storage.persistent) {
      err(`infra.resources.${role}.storage.persistent`, "persistent storage is required");
    }
  }

  // Topology & mapping
  if (S === 0) {
    (mainnet ? err : warn)(
      "topology.sentries.count",
      "no sentries: validators would be publicly exposed",
    );
  }
  const mapping = spec.topology.sentries.mapping;
  if (Array.isArray(mapping)) {
    if (mapping.length !== S) {
      err("topology.sentries.mapping", `mapping has ${mapping.length} entries for ${S} sentries`);
    }
    const covered = new Set<number>();
    for (const [s, vals] of mapping.entries()) {
      if (vals.length === 0) err(`topology.sentries.mapping[${s}]`, "sentry fronts no validator");
      for (const v of vals) {
        if (v >= V) err(`topology.sentries.mapping[${s}]`, `validator index ${v} out of range`);
        covered.add(v);
      }
    }
    for (let v = 0; v < V; v++) {
      if (!covered.has(v) && S > 0) {
        err("topology.sentries.mapping", `validator ${v} has no sentry`);
      }
    }
  }

  // Operator custody (§3)
  const operators = spec.topology.validators.operators;
  if (Array.isArray(operators)) {
    if (operators.length !== V) {
      err(
        "topology.validators.operators",
        `${operators.length} operator addresses for ${V} validators`,
      );
    }
    for (const [i, addr] of operators.entries()) {
      if (!addr.startsWith(spec.network.bech32Prefix + "1")) {
        err(
          `topology.validators.operators[${i}]`,
          `address does not match bech32 prefix "${spec.network.bech32Prefix}"`,
        );
      }
    }
    if (new Set(operators).size !== operators.length) {
      err("topology.validators.operators", "duplicate operator addresses");
    }
  } else if (mainnet) {
    warn(
      "topology.validators.operators",
      "generated operators on mainnet: mnemonics exist on the launcher until swept — consider external (hardware-wallet) operators",
    );
  }

  // Stateless components (§5 step 12): both serve chain data from a sentry
  const comps = spec.topology.components;
  for (const key of ["explorer", "frontend"] as const) {
    if (!comps[key].enabled) continue;
    if (!comps[key].domain) {
      err(`topology.components.${key}.domain`, "domain is required when enabled");
    }
    if (!spec.images[key]) {
      err(`images.${key}`, "image is required when enabled");
    }
    if (S === 0) {
      err(
        `topology.components.${key}.enabled`,
        "requires at least one sentry — components read chain data from sentry-0",
      );
    }
  }
  if (comps.hub.enabled) {
    warn("topology.components.hub", "hub deployment is not implemented yet — toggle is ignored");
  }
  const pub = spec.topology.publicEndpoints;
  if (comps.frontend.enabled && !(pub?.api && pub?.rpc)) {
    err(
      "topology.publicEndpoints",
      "frontend needs public api + rpc domains (LCD/RPC served by sentry-0 via accept-domain ingress)",
    );
  }
  if ((pub?.api || pub?.rpc) && S === 0) {
    err("topology.publicEndpoints", "public endpoints are served by sentry-0 — add a sentry");
  }

  // Mainnet hardening
  if (mainnet) {
    if (!spec.topology.headscale.backup) {
      err("topology.headscale.backup", "mainnet requires headscale S3 backup credentials");
    }
    if (spec.security.keyMode === "softsign") {
      warn("security.keyMode", "softsign on mainnet: consensus keys live on provider disk");
    }
    if (spec.providers.policy.antiAffinity !== "strict") {
      warn("providers.policy.antiAffinity", "mainnet should use strict anti-affinity");
    }
  }

  // Escrow / gas sanity
  if (spec.token.minGasPrice === "0" && mainnet) {
    warn("token.minGasPrice", "zero min gas price on mainnet invites spam");
  }

  // stateSync serving at genesis is meaningless (no snapshots exist yet)
  if (spec.infra.sentrySettings.stateSync) {
    warn("infra.sentrySettings.stateSync", "state-sync serving is pointless at genesis launch");
  }

  return { errors, warnings, ok: errors.length === 0 };
}
