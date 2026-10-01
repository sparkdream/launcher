import { z, ZodError } from "zod";
import { fromBase64, fromBech32 } from "@cosmjs/encoding";
import { launchSpecSchema, type LaunchSpec, type NetworkType } from "./schema.js";
import {
  chainId,
  deriveDreamDenom,
  defaultLoginDomain,
  isServicesFleet,
  mastodonLoginDomain,
  mastodonStreamingDomain,
  SERVICES_FLEET_COMPONENTS,
} from "./derive.js";
import { COMPONENT_KEYS, COMPONENT_KINDS, componentDomain } from "./components.js";
import { profiles } from "./profiles.js";
import { VENDORED_CHAIN_VERSION } from "./vendor-info.js";

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
  const filled = input.kind === "services" ? servicesFill(input) : input;
  const type = (filled.network as Record<string, unknown>).type as NetworkType;
  const profile = profiles[type];
  if (!profile) return launchSpecSchema.parse(filled);
  return launchSpecSchema.parse(merge(profile, filled));
}

/**
 * A services fleet has no chain, but the schema still carries the chain's
 * token, accounts and node topology: fill what the spec leaves out with
 * inert values, so a services spec only has to say what it runs.
 */
function servicesFill(input: Record<string, unknown>): Record<string, unknown> {
  const topology = isPlainObject(input.topology) ? input.topology : {};
  const network = isPlainObject(input.network) ? input.network : {};
  const components = isPlainObject(topology.components) ? topology.components : {};
  return {
    token: { baseDenom: "uspark.services", displayDenom: "SPARK" },
    accounts: { initial: [], validatorSelfDelegation: "1" },
    ...input,
    // network.name names the fleet. The type only picks placement defaults:
    // a shared, long-lived service gets the audited-provider profile unless
    // the spec asks for devnet's looser one; the prefix is never used.
    network: { type: "testnet", bech32Prefix: "sprkdrm", ...network },
    topology: {
      validators: { count: 1 },
      sentries: { count: 0 },
      headscale: {},
      ...topology,
      // the chain's own components stay off unless the spec says otherwise
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false }, ...components },
    },
  };
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

export interface SpecCheck extends ValidationResult {
  /** The parsed spec, or null when it failed the schema. */
  spec: LaunchSpec | null;
}

/** "accounts.initial.0.address" (zod) → "accounts.initial[0].address". */
function formatPath(path: (string | number)[]): string {
  return path.reduce<string>(
    (out, seg) => (typeof seg === "number" ? `${out}[${seg}]` : out ? `${out}.${seg}` : seg),
    "",
  );
}

/** Strip wrappers (optional/nullable/default/effects) to the meaningful node. */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  for (;;) {
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
      schema = schema.unwrap() as z.ZodTypeAny;
    } else if (schema instanceof z.ZodDefault) {
      schema = schema._def.innerType as z.ZodTypeAny;
    } else if (schema instanceof z.ZodEffects) {
      schema = schema._def.schema as z.ZodTypeAny;
    } else {
      return schema;
    }
  }
}

/**
 * Non-strict zod objects STRIP unknown keys instead of complaining, so a
 * misspelled or misplaced key (providers.policy.exclude, say) vanishes from
 * the parsed spec without a trace and the launch runs with different
 * settings than the user wrote. Walk the raw input against the schema's
 * shape and warn on every key the parse will drop. Runs on raw user input
 * only: after withDefaults the unknown keys are already gone.
 */
export function unknownKeyIssues(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const walk = (schema: z.ZodTypeAny, value: unknown, path: string): void => {
    const node = unwrapZod(schema);
    if (value === undefined || value === null) return;
    if (node instanceof z.ZodObject) {
      if (!isPlainObject(value)) return;
      const shape = node.shape as Record<string, z.ZodTypeAny>;
      for (const [k, v] of Object.entries(value)) {
        const p = path ? `${path}.${k}` : k;
        if (!shape[k]) {
          issues.push({
            path: p,
            message: "unrecognized key; the schema strips it silently (check spelling and placement)",
          });
        } else {
          walk(shape[k], v, p);
        }
      }
      return;
    }
    if (node instanceof z.ZodArray) {
      if (!Array.isArray(value)) return;
      value.forEach((item, i) => walk(node.element as z.ZodTypeAny, item, `${path}[${i}]`));
      return;
    }
    if (node instanceof z.ZodUnion) {
      // route object/array input to the structurally matching option;
      // scalar unions (e.g. literal enums) carry no keys to check
      const options = node._def.options as z.ZodTypeAny[];
      const match = options.find((o) => {
        const u = unwrapZod(o);
        return isPlainObject(value) ? u instanceof z.ZodObject : Array.isArray(value) && u instanceof z.ZodArray;
      });
      if (match) walk(match, value, path);
      return;
    }
    // everything else (scalars, records, literals) has no fixed keys to check
  };
  walk(launchSpecSchema, input, "");
  return issues;
}

/**
 * The one-call validation pipeline: profile defaults + schema parse (all
 * issues collected, not just the first) followed by the cross-field checks.
 * Never throws; schema failures come back as issues with zod paths.
 */
export function checkSpec(input: unknown): SpecCheck {
  let spec: LaunchSpec;
  try {
    spec = withDefaults(input);
  } catch (e) {
    const errors: ValidationIssue[] =
      e instanceof ZodError
        ? e.issues.map((i) => ({ path: formatPath(i.path), message: i.message }))
        : [{ path: "", message: String(e instanceof Error ? e.message : e) }];
    return { spec: null, errors, warnings: [], ok: false };
  }
  const res = validateSpec(spec);
  return { spec, errors: res.errors, warnings: [...unknownKeyIssues(input), ...res.warnings], ok: res.ok };
}

/**
 * Strict account-address check: bech32 checksum, expected prefix, 20-byte
 * payload. Returns the problem or null. A bad address passes genesis
 * assembly but wedges the launch at add-genesis-account (or worse, mints to
 * an unspendable account), so it must fail here.
 */
function addressProblem(addr: string, expectedPrefix: string): string | null {
  let prefix: string;
  let data: Uint8Array;
  try {
    ({ prefix, data } = fromBech32(addr));
  } catch {
    return "not a valid bech32 address (bad checksum or format)";
  }
  if (prefix !== expectedPrefix) {
    return `address prefix "${prefix}" does not match bech32 prefix "${expectedPrefix}"`;
  }
  if (data.length !== 20) {
    return `address payload is ${data.length} bytes, expected 20 (account address)`;
  }
  return null;
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

  // a services fleet: shared components and nothing chain-shaped (its chain
  // fields keep their defaults and are never used)
  if (isServicesFleet(spec)) {
    validateServicesFleet(spec, err, warn);
    return { ok: errors.length === 0, errors, warnings };
  }

  if (spec.sharing?.wallets?.length) {
    warn("sharing", "sharing applies to services fleets: a chain fleet's components are not linked from other wallets");
  }

  const mainnet = spec.network.type === "mainnet";
  const join = spec.join;
  const V = spec.topology.validators.count;
  const S = spec.topology.sentries.count;

  // Join mode (§5 "Join mode"): the chain already exists, so every
  // genesis-shaping field is rejected. What survives parameterizes the
  // joiner's own nodes: token (min gas price, verified against the fetched
  // genesis), chainParams.consensus + validatorDefaults, and
  // accounts.validatorSelfDelegation (the create-validator stake).
  if (join) {
    if (spec.accounts.initial.length > 0) {
      err(
        "accounts.initial",
        "join mode joins an existing chain: genesis accounts cannot be created; " +
          "fund the operator accounts on the live chain instead (§5 await-funds)",
      );
    }
    if (spec.accounts.communityPool) {
      err(
        "accounts.communityPool",
        "join mode joins an existing chain: its community pool already exists",
      );
    }
    for (const section of ["staking", "gov", "mint", "distribution", "slashing"] as const) {
      if (spec.chainParams[section] && Object.keys(spec.chainParams[section]!).length > 0) {
        err(
          `chainParams.${section}`,
          "join mode: these parameters already exist on the live chain; only consensus " +
            "(node-local timing) and validatorDefaults (your create-validator tx) apply",
        );
      }
    }
    if (!join.genesisSha256) {
      (mainnet ? err : warn)(
        "join.genesisSha256",
        "pin the genesis sha256 (from the join bundle) so the genesis host is not trusted for integrity",
      );
    }
    if (S === 0) {
      err(
        "topology.sentries.count",
        "join mode needs at least one sentry: sentries state-sync from the network and front your validators",
      );
    }
    const seenPeers = new Set<string>();
    for (const [i, peer] of join.peers.entries()) {
      const id = peer.split("@")[0]!;
      if (seenPeers.has(id)) {
        warn(`join.peers[${i}]`, `duplicate peer node id ${id}`);
      }
      seenPeers.add(id);
    }
    // the light-client trust hash is cross-checked across two RPCs; the
    // same endpoint listed twice would "cross-check" a lying RPC against
    // itself, so duplicates are an error, not a warning
    const seenRpcs = new Set<string>();
    for (const [i, rpc] of join.stateSyncRpcs.entries()) {
      const normalized = rpc.replace(/\/+$/, "");
      if (seenRpcs.has(normalized)) {
        err(
          `join.stateSyncRpcs[${i}]`,
          `duplicate state-sync RPC ${rpc}: the trust-hash cross-check needs two distinct endpoints`,
        );
      }
      seenRpcs.add(normalized);
    }
  }

  // Denoms & addresses — the shapes below are enforced by the chain's
  // identity module at genesis (x/identity ChainIdentity.Validate); catching
  // them here fails the launch/reset before any state changes hands.
  if (spec.token.bondDenom && spec.token.bondDenom !== spec.token.baseDenom) {
    warn("token.bondDenom", "bond denom differs from fee denom — double-check gentx amounts");
  }
  const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;
  if (!/^u[a-z]{2,5}\.[a-z][a-z0-9-]{2,15}$/.test(bondDenom)) {
    err(
      spec.token.bondDenom ? "token.bondDenom" : "token.baseDenom",
      `"${bondDenom}" violates the chain's bond denom rule ` +
        "u<2-5 letters>.<3-16 char suffix>, e.g. uspark.sparkdreamdev (x/identity)",
    );
  }
  const dreamDenom = deriveDreamDenom(spec.token);
  if (!dreamDenom || !/^u[a-z]{2,5}\.[a-z][a-z0-9-]{2,15}$/.test(dreamDenom)) {
    err(
      "token.dreamDenom",
      `"${dreamDenom ?? "<underivable>"}" violates the chain's dream denom rule ` +
        "u<2-5 letters>.<3-16 char suffix>, e.g. udream.sparkdreamdev (x/identity)",
    );
  } else if (dreamDenom === bondDenom) {
    err(
      "token.dreamDenom",
      `"${dreamDenom}" equals the bond denom: x/identity rejects the collision at genesis`,
    );
  }
  for (const [field, symbol] of [
    ["token.displayDenom", spec.token.displayDenom],
    ["token.dreamDisplayDenom", spec.token.dreamDisplayDenom],
  ] as const) {
    if (!/^[A-Z][A-Z0-9]{2,7}$/.test(symbol)) {
      err(field, `"${symbol}" violates the chain's display symbol rule: 3-8 chars, [A-Z][A-Z0-9]+ (x/identity)`);
    }
  }
  if (spec.token.dreamDisplayDenom === spec.token.displayDenom) {
    err(
      "token.dreamDisplayDenom",
      `"${spec.token.dreamDisplayDenom}" equals the bond display symbol: x/identity rejects the collision at genesis`,
    );
  }
  const seenNames = new Map<string, number>();
  const seenAddrs = new Map<string, number>();
  for (const [i, acct] of spec.accounts.initial.entries()) {
    if (acct.address) {
      const problem = addressProblem(acct.address, spec.network.bech32Prefix);
      if (problem) err(`accounts.initial[${i}].address`, problem);
    }
    // duplicate names collide in the launcher's key map; a duplicate address
    // is silently skipped at add-genesis-account, losing the second allocation
    const prevName = seenNames.get(acct.name);
    if (prevName !== undefined) {
      err(`accounts.initial[${i}].name`, `duplicate account name "${acct.name}" (also accounts.initial[${prevName}])`);
    } else {
      seenNames.set(acct.name, i);
    }
    if (acct.address) {
      const prevAddr = seenAddrs.get(acct.address);
      if (prevAddr !== undefined) {
        err(
          `accounts.initial[${i}].address`,
          `duplicate address (also accounts.initial[${prevAddr}]): only the first allocation would reach genesis`,
        );
      } else {
        seenAddrs.set(acct.address, i);
      }
    }
  }

  // Governance bootstrap: x/commons builds the founding councils at genesis
  // from the spec's council accounts (founding_members), or, when the spec
  // has none, from the image's compiled-in founder addresses. A chain that
  // ends up with neither starts without any councils, permanently: council
  // creation permissions live on the councils themselves. Join mode skips
  // all of this — governance already exists on the live chain.
  const councilAccounts = spec.accounts.initial
    .map((a, i) => ({ acct: a, i }))
    .filter(({ acct }) => acct.council);
  if (councilAccounts.length > 0) {
    const founders = councilAccounts.filter(
      ({ acct }) => typeof acct.council === "object" && acct.council.founder,
    );
    if (founders.length === 0) {
      err(
        "accounts.initial",
        "council accounts need exactly one founder: set council: { founder: true } on one of them " +
          "(the chain panics at genesis on a founderless council set)",
      );
    } else if (founders.length > 1) {
      for (const { i } of founders.slice(1)) {
        err(
          `accounts.initial[${i}].council.founder`,
          `only one account can be the founder (also accounts.initial[${founders[0]!.i}])`,
        );
      }
    }
    if (councilAccounts.length < 3) {
      warn(
        "accounts.initial",
        `${councilAccounts.length} council account(s): the Commons Council starts below its minimum membership of 3`,
      );
    }
    const seenHandles = new Map<string, number>();
    for (const { acct, i } of councilAccounts) {
      if (typeof acct.council !== "object" || !acct.council.handles) continue;
      for (const handle of acct.council.handles) {
        const prev = seenHandles.get(handle);
        if (prev !== undefined) {
          err(
            `accounts.initial[${i}].council.handles`,
            `handle "${handle}" is already claimed by accounts.initial[${prev}]`,
          );
        } else {
          seenHandles.set(handle, i);
        }
      }
    }
  } else if (!join) {
    // Without council accounts the bootstrap falls back to the image's
    // compiled-in founder addresses. Generated accounts can never match
    // them; explicit addresses might (a canonical-network relaunch), so
    // only the all-generated case is a certainty.
    const anyExplicit = spec.accounts.initial.some((a) => a.address);
    if (!anyExplicit) {
      err(
        "accounts.initial",
        "no account is flagged council and all accounts are generated, so none can match the image's " +
          "compiled-in founder addresses, so the chain would start with no governance councils. " +
          "Flag the founding members with council (one of them founder: true)",
      );
    } else {
      warn(
        "accounts.initial",
        "no account is flagged council: governance only bootstraps if the image's compiled-in founder " +
          "addresses are among accounts.initial; flag council accounts to override them explicitly",
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
  if (mapping === "round-robin" && S > 0 && S < V) {
    // round-robin assigns sentry s to validator s % V, so with fewer
    // sentries than validators the tail validators get none
    (mainnet ? err : warn)(
      "topology.sentries.count",
      `round-robin with ${S} sentries covers only the first ${S} of ${V} validators; the rest would be publicly exposed`,
    );
  }
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

  // Connectivity: the renderer emits exactly these p2p edges — the sentry
  // layer as a full mesh, plus each sentry's fronted validators (validators
  // run pex=false and peer only through their own sentries). A disconnected
  // graph can never gossip votes across its islands, so a fresh chain never
  // reaches block 1. Join mode instead requires every validator to have a
  // sentry: the public network bridges the sentries, but a sentry-less join
  // validator would boot with an empty peer list.
  const frontsOf = (s: number): number[] =>
    mapping === "round-robin"
      ? V > 0 ? [s % V] : []
      : (mapping[s] ?? []).filter((v) => v >= 0 && v < V);
  if (spec.join) {
    for (let v = 0; v < V; v++) {
      const covered = Array.from({ length: S }, (_, s) => frontsOf(s)).some((f) => f.includes(v));
      if (!covered) {
        err(
          "topology",
          `validator ${v} has no sentry: join validators peer only through their own sentries, ` +
            `so it would boot with no peers at all`,
        );
      }
    }
  } else if (V + S > 1) {
    // nodes 0..V-1 are validators, V..V+S-1 are sentries
    const adjacent: number[][] = Array.from({ length: V + S }, () => []);
    for (let s = 0; s < S; s++) {
      for (let s2 = 0; s2 < S; s2++) if (s2 !== s) adjacent[V + s]!.push(V + s2);
      for (const v of frontsOf(s)) {
        adjacent[V + s]!.push(v);
        adjacent[v]!.push(V + s);
      }
    }
    const reached = new Set([0]);
    const queue = [0];
    while (queue.length > 0) {
      for (const m of adjacent[queue.shift()!]!) {
        if (!reached.has(m)) {
          reached.add(m);
          queue.push(m);
        }
      }
    }
    if (reached.size < V + S) {
      const stranded = Array.from({ length: V + S }, (_, n) => n)
        .filter((n) => !reached.has(n))
        .map((n) => (n < V ? `val-${n}` : `sentry-${n - V}`));
      err(
        "topology",
        `the p2p graph is disconnected: ${stranded.join(", ")} cannot reach the rest of the ` +
          `fleet, so the chain could never produce a block. Give every validator at least one ` +
          `sentry (sentries interconnect automatically).`,
      );
    }
  }

  // Validator monikers: one per validator when spelled out
  const monikers = spec.topology.validators.monikers;
  if (monikers && monikers.length !== V) {
    err(
      "topology.validators.monikers",
      `${monikers.length} monikers for ${V} validators — provide one per validator or omit`,
    );
  }
  // Pre-existing consensus pubkeys (hardware tmkms signers): one per
  // validator, only in tmkms mode — softsign uploads the launcher-generated
  // priv_validator_key.json to the node, so a pinned pubkey whose private
  // key never reaches the node would produce a validator that can never
  // sign. Duplicates are an equivocation hazard: two validators holding one
  // consensus key double-sign the first conflicting block they both see.
  const consensusPubkeys = spec.topology.validators.consensusPubkeys;
  if (consensusPubkeys) {
    if (consensusPubkeys.length !== V) {
      err(
        "topology.validators.consensusPubkeys",
        `${consensusPubkeys.length} pubkeys for ${V} validators — provide one per validator or omit`,
      );
    }
    if (spec.security.keyMode !== "tmkms") {
      err(
        "topology.validators.consensusPubkeys",
        "pre-existing consensus keys require security.keyMode tmkms: in softsign mode the node " +
          "signs with the launcher-generated key uploaded to it, and the pinned pubkey's private " +
          "key never reaches the node",
      );
    }
    const seenPubkeys = new Map<string, number>();
    for (const [i, key] of consensusPubkeys.entries()) {
      let bytes: Uint8Array | null = null;
      try {
        bytes = fromBase64(key);
      } catch {
        // falls through to the error below
      }
      if (!bytes || bytes.length !== 32) {
        err(
          `topology.validators.consensusPubkeys[${i}]`,
          "not a base64 ed25519 pubkey (32 bytes — e.g. the \"key\" field of a gentx pubkey or `comet show-validator` output)",
        );
        continue;
      }
      const prev = seenPubkeys.get(key);
      if (prev !== undefined) {
        err(
          `topology.validators.consensusPubkeys[${i}]`,
          `duplicate pubkey (also consensusPubkeys[${prev}]): two validators on one consensus key will double-sign`,
        );
      } else {
        seenPubkeys.set(key, i);
      }
    }
  }

  // CometBFT rejects non-ASCII monikers in config.toml at startup ("valid
  // non-empty ASCII text without tabs"). The renderer writes an
  // ASCII-sanitized form there while the on-chain validator description
  // (gentx) keeps the original, so this is a warning, not an error.
  for (const [i, m] of (monikers ?? []).entries()) {
    if (!/^[\x20-\x7e]+$/.test(m)) {
      warn(
        `topology.validators.monikers[${i}]`,
        "moniker is not ASCII: config.toml gets a sanitized form (CometBFT validates it at startup); the on-chain validator description keeps the original",
      );
    }
  }

  // Seeded season usernames must be unique — x/season enforces uniqueness
  // and a duplicate fails InitGenesis after deposits are spent
  const usernames = spec.accounts.initial
    .map((a) => (typeof a.member === "object" ? a.member.username : undefined))
    .filter((u): u is string => Boolean(u));
  if (new Set(usernames).size !== usernames.length) {
    err("accounts.initial", "duplicate member usernames");
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
      const problem = addressProblem(addr, spec.network.bech32Prefix);
      if (problem) {
        err(`topology.validators.operators[${i}]`, problem);
        continue;
      }
      // an operator listed in accounts.initial keeps that allocation instead
      // of the automatic self-delegation funding, so it must cover the gentx
      const acct = spec.accounts.initial.find((a) => a.address === addr);
      if (acct && BigInt(acct.amount) < BigInt(spec.accounts.validatorSelfDelegation)) {
        err(
          `topology.validators.operators[${i}]`,
          `operator is account "${acct.name}" whose amount ${acct.amount} is less than ` +
            `validatorSelfDelegation ${spec.accounts.validatorSelfDelegation} (the gentx self-delegates that much)`,
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

  // Service components (§5 step 12): what each kind needs is in COMPONENT_KINDS
  const comps = spec.topology.components;
  for (const key of COMPONENT_KEYS) {
    const kind = COMPONENT_KINDS[key];
    if (!comps[key]?.enabled) continue;
    if (kind.domain && !componentDomain(spec, key)) {
      err(`topology.components.${key}.domain`, "domain is required when enabled");
    }
    if (!spec.images[key]) {
      err(`images.${key}`, "image is required when enabled");
    }
    if (kind.needsSentry && S === 0) {
      err(
        `topology.components.${key}.enabled`,
        "requires at least one sentry — components read chain data from sentry-0",
      );
    }
  }
  const pub = spec.topology.publicEndpoints;
  if (comps.frontend.enabled && !(pub?.api && pub?.rpc)) {
    err(
      "topology.publicEndpoints",
      "frontend needs public api + rpc domains (LCD/RPC served by sentry-0 via accept-domain ingress)",
    );
  }
  // Relayer (one Hermes process, many paths). Fleet counterparties are
  // resolved and mesh-checked by the conductor at launch creation, where the
  // other launch is visible; everything checkable from the spec alone is here.
  const relayer = comps.relayer;
  if (relayer?.enabled) {
    if (relayer.paths.length === 0) {
      err("topology.components.relayer.paths", "an enabled relayer needs at least one path");
    }
    const ids = new Set<string>();
    const ends = new Set<string>();
    relayer.paths.forEach((p, i) => {
      const at = `topology.components.relayer.paths.${i}`;
      if (ids.has(p.id)) err(`${at}.id`, `path id "${p.id}" is used twice`);
      ids.add(p.id);
      const cp = p.counterparty;
      const end = "fleet" in cp ? `fleet:${cp.fleet}` : `chain:${cp.chainId}`;
      if (ends.has(`${p.kind}/${end}`)) {
        err(at, `a ${p.kind} path to ${end.replace(/^[a-z]+:/, "")} is already listed`);
      }
      ends.add(`${p.kind}/${end}`);
      if (!("fleet" in cp)) {
        if (cp.chainId === chainId(spec)) {
          err(`${at}.counterparty.chainId`, "a path cannot lead back to this chain");
        }
        warn(
          `${at}.counterparty.grpc`,
          "the relayer dials this gRPC directly: it must be reachable from the provider, not just from your network",
        );
        if (cp.dynamicGasPrice && cp.dynamicGasPrice.max < cp.gasPrice) {
          err(
            `${at}.counterparty.dynamicGasPrice.max`,
            `${cp.dynamicGasPrice.max} is below gasPrice (${cp.gasPrice}), the fallback Hermes pays when the fee query fails`,
          );
        }
        if (cp.eventSource === "pull" && cp.ws) {
          warn(`${at}.counterparty.ws`, "ignored: eventSource pull polls the RPC instead of the websocket");
        }
        if (p.kind === "federation") {
          warn(
            `${at}.kind`,
            "federation relays x/federation packets, so the counterparty must be a Spark Dream chain; " +
              "content moves only once both chains register and activate each other as peers",
          );
        }
      }
    });
    if (BigInt(relayer.genesisBalance) > BigInt(relayer.maxBalance)) {
      err(
        "topology.components.relayer.genesisBalance",
        `${relayer.genesisBalance} is above the relayer's maxBalance (${relayer.maxBalance}): ` +
          "the key lives on the relayer's provider, so fund it with gas money only",
      );
    }
    warn(
      "topology.components.relayer",
      "the relayer's key is a hot key: it sits on the relayer's provider (Hermes cannot sign through a " +
        "session key), so anything it holds on any chain is at that provider's mercy. Fund each chain " +
        "with gas money only, and top up rather than pre-fund",
    );
  }

  // Mastodon: the owner account is the only way in, and the bridge talks to
  // the chain through the public api domain
  const masto = comps.mastodon;
  if (masto?.enabled) {
    if (!masto.owner) {
      err("topology.components.mastodon.owner", "an owner (username + email) is required: it is the instance's only way in");
    }
    if (!spec.images.mastodonStreaming) {
      err("images.mastodonStreaming", "image is required when mastodon is enabled");
    }
    if (!masto.smtp) {
      // with registrations "none" nobody signs up, so there is nothing to confirm
      if (masto.registrations !== "none") {
        warn(
          "topology.components.mastodon.smtp",
          "no SMTP relay: confirmation emails are never sent, so people who sign up cannot confirm their address",
        );
      }
    } else if (!/@/.test(masto.smtp.fromAddress)) {
      err("topology.components.mastodon.smtp.fromAddress", "must contain an email address");
    }
    validateWalletLogin(spec, err, warn);
    if (masto.walletLogin?.enabled && (!pub?.api || !pub?.rpc)) {
      err(
        "topology.publicEndpoints",
        "wallet sign-in reads membership through the chain's public api domain, and Keplr needs its rpc: set publicEndpoints.api and publicEndpoints.rpc",
      );
    }
    if (masto.bridge?.enabled) {
      if (!pub?.api) {
        err(
          "topology.publicEndpoints.api",
          "the mastodon bridge broadcasts through the chain's public api domain — set publicEndpoints.api",
        );
      }
      if (!spec.images.sdap) err("images.sdap", "image is required when the mastodon bridge is enabled");
      const extra = (masto.bridge.peers ?? []).map((p) => p.id.toLowerCase());
      if (masto.domain && extra.includes(masto.domain.toLowerCase())) {
        err("topology.components.mastodon.bridge.peers", `${masto.domain} is this instance's own peer: list only other servers`);
      }
      if (new Set(extra).size !== extra.length) {
        err("topology.components.mastodon.bridge.peers", "each server may be listed once");
      }
      warn(
        "topology.components.mastodon.bridge",
        "anchored posts stay unverified until an independent verifier (sdapverify, on another host and " +
          "account with a federation-verifier bond) runs against this chain",
      );
    }
  }

  // Standalone bridge: its Mastodon runs in another fleet (resolved, and
  // its domain filled in, by the conductor)
  const standalone = comps.bridge;
  if (standalone?.enabled) {
    if (masto?.enabled && masto.bridge?.enabled) {
      err("topology.components.bridge", "this fleet already bridges its own Mastodon: run the sidecar or a standalone bridge, not both");
    }
    if (!pub?.api) err("topology.publicEndpoints.api", "the bridge broadcasts through this chain's public api domain");
    if (!(spec.images.bridge ?? spec.images.sdap)) err("images.bridge", "image is required when the bridge is enabled");
    const extra = (standalone.peers ?? []).map((p) => p.id.toLowerCase());
    if (standalone.target.domain && extra.includes(standalone.target.domain.toLowerCase())) {
      err("topology.components.bridge.peers", `${standalone.target.domain} is the instance's own peer: list only other servers`);
    }
    if (new Set(extra).size !== extra.length) err("topology.components.bridge.peers", "each server may be listed once");
  }

  // Verifier: checks here are the ones this spec can answer; a fleet target
  // is resolved, and its account checked, by the conductor
  const verifier = comps.verifier;
  if (verifier?.enabled) {
    if (Boolean(verifier.account) === Boolean(verifier.wallet)) {
      err(
        "topology.components.verifier",
        "set exactly one of verifier.account (a launcher-generated member) or verifier.wallet (a member address whose key stays in your wallet)",
      );
    }
    if (!verifier.target && verifier.wallet && !verifier.wallet.startsWith(`${spec.network.bech32Prefix}1`)) {
      err("topology.components.verifier.wallet", `"${verifier.wallet}" is not a ${spec.network.bech32Prefix} address`);
    }
    if (!verifier.target) {
      const acct = spec.accounts.initial.find((a) => a.name === verifier.account);
      const trust = acct && typeof acct.member === "object" ? acct.member.trustLevel : undefined;
      if (!verifier.account) {
        // a wallet member's standing is checked on chain, when it bonds
      } else if (!acct?.generate) {
        err("topology.components.verifier.account", `"${verifier.account}" must be a generated account in accounts.initial (the launcher signs as it)`);
      } else if (!trust || !["established", "trusted", "core"].includes(trust)) {
        err("topology.components.verifier.account", `"${verifier.account}" must be a member with trustLevel established or above`);
      }
      if (!pub?.api) err("topology.publicEndpoints.api", "the verifier reads and broadcasts through the public api domain");
      if (!verifier.peers?.length && !comps.mastodon?.enabled && !comps.bridge?.enabled) {
        err("topology.components.verifier.peers", "name the ActivityPub peers to verify (there is no Mastodon here to default to)");
      }
    }
    warn(
      "topology.components.verifier",
      verifier.wallet
        ? "the verifier runs on its own deployment and provider as your member account, but you also run the " +
            "bridge: host independence only. A verifier run by another member is the independent one"
        : "the verifier runs on its own deployment and provider, but the same wallet and launcher hold its key and " +
            "the bridge's: host independence only. A verifier run by another member is the independent one",
    );
  }

  if ((pub?.api || pub?.rpc) && S === 0) {
    err("topology.publicEndpoints", "public endpoints are served by sentry-0 — add a sentry");
  }

  // Mesh custody: a fleet either runs its own headscale (domain) or shares
  // another fleet's (reuseFleet). The conductor resolves reuseFleet into the
  // owning fleet's domain at launch creation, so both being set is normal
  // for a stored spec; neither is never valid.
  const hs = spec.topology.headscale;
  if (!hs.domain && !hs.reuseFleet) {
    err(
      "topology.headscale",
      "set domain (this fleet deploys its own headscale) or reuseFleet (share an existing fleet's mesh)",
    );
  }
  if (hs.reuseFleet && hs.backup) {
    err(
      "topology.headscale.backup",
      "a shared mesh is backed up by the fleet that owns it — remove backup when reuseFleet is set",
    );
  }

  // Every ingress hostname routes to a different service, so a domain can
  // appear only once across the fleet
  const domainUses: [string, string | undefined][] = [
    ...COMPONENT_KEYS.map((key): [string, string | undefined] => [
      `topology.components.${key}.domain`,
      comps[key]?.enabled ? componentDomain(spec, key) : undefined,
    ]),
    ["topology.components.hub.domain", comps.hub.enabled ? comps.hub.domain : undefined],
    ["topology.components.mastodon.streamingDomain", mastodonStreamingDomain(spec)],
    ["topology.components.mastodon.walletLogin.domain", mastodonLoginDomain(spec)],
    ["topology.publicEndpoints.api", pub?.api],
    ["topology.publicEndpoints.rpc", pub?.rpc],
    ["topology.headscale.domain", spec.topology.headscale.domain],
  ];
  const seenDomains = new Map<string, string>();
  for (const [path, dom] of domainUses) {
    if (!dom) continue;
    const first = seenDomains.get(dom);
    if (first) {
      err(path, `domain "${dom}" is already used by ${first}`);
    } else {
      seenDomains.set(dom, path);
    }
  }

  // Chain parameter sanity: values the chain would accept structurally but
  // that reject the gentx or misconfigure minting
  const mint = spec.chainParams.mint;
  if (
    mint?.inflationMin !== undefined &&
    mint?.inflationMax !== undefined &&
    mint.inflationMin > mint.inflationMax
  ) {
    err("chainParams.mint.inflationMin", `inflationMin ${mint.inflationMin} exceeds inflationMax ${mint.inflationMax}`);
  }
  const comm = spec.chainParams.validatorDefaults;
  if (
    comm?.commissionRate !== undefined &&
    comm?.commissionMaxRate !== undefined &&
    comm.commissionRate > comm.commissionMaxRate
  ) {
    err(
      "chainParams.validatorDefaults.commissionRate",
      `commissionRate ${comm.commissionRate} exceeds commissionMaxRate ${comm.commissionMaxRate} (gentx would be rejected)`,
    );
  }
  if (
    comm?.commissionMaxChangeRate !== undefined &&
    comm?.commissionMaxRate !== undefined &&
    comm.commissionMaxChangeRate > comm.commissionMaxRate
  ) {
    err(
      "chainParams.validatorDefaults.commissionMaxChangeRate",
      `commissionMaxChangeRate ${comm.commissionMaxChangeRate} exceeds commissionMaxRate ${comm.commissionMaxRate} (gentx would be rejected)`,
    );
  }

  // Provider preference entries are Akash owner addresses regardless of the
  // chain being launched
  for (const [i, addr] of spec.providers.policy.preference.entries()) {
    const problem = addressProblem(addr, "akash");
    if (problem) err(`providers.policy.preference[${i}]`, problem);
  }

  // Provider exclusion entries: akash1 owner addresses (exact match) or
  // hostname fragments (case-insensitive substring). Anything address-shaped
  // gets a hard check so a typo'd address fails loudly instead of silently
  // never matching; fragment rules keep the substring matcher predictable.
  const exclusionLists: [string, string[]][] = [
    ["providers.exclude", spec.providers.exclude],
    ...Object.entries(spec.providers.components).map(
      ([group, c]): [string, string[]] => [
        `providers.components.${group}.exclude`,
        c?.exclude ?? [],
      ],
    ),
  ];
  for (const [path, entries] of exclusionLists) {
    for (const [i, entry] of entries.entries()) {
      const at = `${path}[${i}]`;
      if (entry.startsWith("akash1")) {
        const problem = addressProblem(entry, "akash");
        if (problem) err(at, problem);
      } else if (/^[a-z][a-z0-9]{1,15}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{10,}$/i.test(entry)) {
        err(
          at,
          "looks like a bech32 address with a non-akash prefix; exclusions take akash1 owner addresses or hostname fragments",
        );
      } else if (entry.includes("://") || entry.includes("/") || /\s/.test(entry)) {
        err(
          at,
          "hostname fragments match against the provider's hostname only; give a plain fragment like \"jjozzietech\", not a URL",
        );
      } else if (entry.length < 4) {
        warn(at, `fragment "${entry}" matches by substring and may exclude more providers than intended`);
      }
    }
  }

  // SSH keys land verbatim in authorized_keys; a malformed one silently
  // locks the operator out of every node
  if (
    spec.security.sshPublicKey !== null &&
    !/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+/.test(
      spec.security.sshPublicKey.trim(),
    )
  ) {
    err("security.sshPublicKey", "not an OpenSSH public key (authorized_keys format, e.g. \"ssh-ed25519 AAAA... comment\")");
  }

  // Mainnet hardening
  if (mainnet) {
    // a shared mesh is backed up by its owning fleet, not this one
    if (!spec.topology.headscale.backup && !spec.topology.headscale.reuseFleet) {
      err("topology.headscale.backup", "mainnet requires headscale S3 backup credentials");
    }
    if (spec.security.keyMode === "softsign") {
      warn("security.keyMode", "softsign on mainnet: consensus keys live on provider disk");
    }
    if (spec.providers.policy.antiAffinity === "off") {
      warn(
        "providers.policy.antiAffinity",
        "anti-affinity off: nothing stops the whole fleet landing on one provider",
      );
    }
  }

  // Escrow / gas sanity
  if (spec.token.minGasPrice === "0" && mainnet) {
    warn("token.minGasPrice", "zero min gas price on mainnet invites spam");
  }

  // stateSync serving at genesis is meaningless (no snapshots exist yet) —
  // a joined fleet syncs into a live chain, where serving makes sense
  if (spec.infra.sentrySettings.stateSync && !join) {
    warn("infra.sentrySettings.stateSync", "state-sync serving is pointless at genesis launch");
  }

  // The vendored reference genesis requires a binary that knows every param
  // it carries; older images reject it at InitChain — AFTER deployments and
  // escrow are funded, so this must fail at validation. The floor is the
  // vendored chain version (vendor-info.ts, regenerated by sync-vendor.sh),
  // so re-vendoring for a different chain version moves it automatically.
  // Only enforceable for the known image naming scheme with a semver tag;
  // join mode is exempt (the live chain's genesis, not the vendored
  // reference, is what matters — run whatever the join bundle names).
  if (!join) {
    if (/^sparkdreamnft\/sparkdreamd-[a-z]+-ssh:/.test(spec.images.sparkdreamd)) {
      if (imageBefore(spec.images.sparkdreamd, VENDORED_CHAIN_VERSION)) {
        err(
          "images.sparkdreamd",
          `${spec.images.sparkdreamd} predates the vendored reference genesis ` +
            `(${VENDORED_CHAIN_VERSION}): older binaries reject its params at InitChain ` +
            "(the chain would never reach block 1, after deployments are already funded)",
        );
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** An image's vX.Y.Z tag, when it has one. */
export function versionTag(image: string): [number, number, number] | undefined {
  const m = /:v(\d+)\.(\d+)\.(\d+)$/.exec(image);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `image` carries a version tag older than `version` (vX.Y.Z).
 *  Images tagged otherwise (dev, latest, a digest) cannot be told apart:
 *  false. */
export function imageBefore(image: string, version: string): boolean {
  const tag = versionTag(image);
  const floor = versionTag(`:${version}`);
  if (!tag || !floor) return false;
  for (let i = 0; i < 3; i++) if (tag[i] !== floor[i]) return tag[i]! < floor[i]!;
  return false;
}

/**
 * The first chain release whose images carry wallet sign-in: the sdap image
 * ships sdaplogin, the Mastodon image the zz_sparkdream_wallet_login.rb
 * initializer and the `login-chain` bootstrap action. Older images deploy
 * cleanly and then fail (the login service crash-loops, the chain sync never
 * lands), so this refuses them at validation, before anything is signed.
 */
export const WALLET_LOGIN_MIN_VERSION = "v1.0.46";

/**
 * Mastodon wallet sign-in, in a chain or a services fleet: the sdaplogin
 * sidecar runs on the sdap image, on an ingress of its own.
 */
function validateWalletLogin(
  spec: LaunchSpec,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  const m = spec.topology.components.mastodon;
  if (!m?.enabled || !m.walletLogin?.enabled) return;
  if (!spec.images.sdap) err("images.sdap", "image is required for mastodon.walletLogin (sdaplogin ships in it)");
  for (const key of ["sdap", "mastodon"] as const) {
    const image = spec.images[key];
    if (image && imageBefore(image, WALLET_LOGIN_MIN_VERSION)) {
      err(
        `images.${key}`,
        `${image} predates wallet sign-in (${WALLET_LOGIN_MIN_VERSION} or later): upgrade the ${key} image first ` +
          "(on a running fleet, \"upgrade…\" on the Mastodon row records it even when no service runs it yet)",
      );
    }
  }
  const login = mastodonLoginDomain(spec);
  if (login && (login === m.domain || login === mastodonStreamingDomain(spec))) {
    err("topology.components.mastodon.walletLogin.domain", `"${login}" is already the instance's own domain: sign-in needs one of its own`);
  }
  if (login && m.domain && login.split(".").length > m.domain.split(".").length) {
    warn(
      "topology.components.mastodon.walletLogin.domain",
      `"${login}" sits a level deeper than the instance (${m.domain}): behind Cloudflare, whose free edge ` +
        "certificate covers only one level below the zone, browsers would reject its certificate. " +
        `A name at the instance's depth, like ${defaultLoginDomain(m.domain)}, avoids that`,
    );
  }
}

/**
 * A services fleet (spec.kind "services"): only chain-independent
 * components, at least one, and none of the chain's own machinery.
 */
function validateServicesFleet(
  spec: LaunchSpec,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  const comps = spec.topology.components as Record<string, { enabled?: boolean } | undefined>;
  const enabled = Object.entries(comps).filter(([, c]) => c?.enabled).map(([k]) => k);
  for (const key of enabled) {
    if (!(SERVICES_FLEET_COMPONENTS as readonly string[]).includes(key)) {
      err(
        `topology.components.${key}`,
        `a services fleet runs chain-independent components only (${SERVICES_FLEET_COMPONENTS.join(", ")}); ` +
          `${key} belongs in a chain fleet`,
      );
    }
  }
  if (enabled.length === 0) warn("topology.components", "a services fleet with no component deploys nothing");
  const shared = spec.sharing?.wallets ?? [];
  if (new Set(shared).size !== shared.length) err("sharing.wallets", "each wallet may be listed once");
  if (spec.join) err("join", "a services fleet runs no chain to join");
  if (spec.topology.headscale.reuseFleet || spec.topology.headscale.domain) {
    warn("topology.headscale", "a services fleet runs no mesh: the headscale settings are ignored");
  }
  if (spec.topology.publicEndpoints) warn("topology.publicEndpoints", "a services fleet serves no chain endpoints: ignored");
  const masto = spec.topology.components.mastodon;
  if (masto?.enabled) {
    if (masto.bridge?.enabled) {
      err(
        "topology.components.mastodon.bridge",
        "a services fleet has no chain to anchor to: each chain fleet links this instance with a standalone bridge component",
      );
    }
    if (!masto.domain) err("topology.components.mastodon.domain", "the instance's domain is required");
    if (!masto.owner) err("topology.components.mastodon.owner", "an owner (username + email) is required: it is the instance's only way in");
    if (!spec.images.mastodon) err("images.mastodon", "image is required when mastodon is enabled");
    if (!spec.images.mastodonStreaming) err("images.mastodonStreaming", "image is required when mastodon is enabled");
    validateWalletLogin(spec, err, warn);
    if (masto.walletLogin?.enabled) {
      warn(
        "topology.components.mastodon.walletLogin",
        "only members of chains whose fleets link this instance with a standalone bridge can sign in: until one does, the sign-in page has no chain to offer",
      );
    }
  }
  if (spec.topology.components.hub?.enabled) {
    if (!spec.topology.components.hub.domain) err("topology.components.hub.domain", "domain is required when enabled");
    if (!spec.images.hub) err("images.hub", "image is required when enabled");
  }
}

