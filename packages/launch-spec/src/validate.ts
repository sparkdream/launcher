import { z, ZodError } from "zod";
import { fromBase64, fromBech32 } from "@cosmjs/encoding";
import { launchSpecSchema, type LaunchSpec, type NetworkType } from "./schema.js";
import { deriveDreamDenom } from "./derive.js";
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
    ["topology.components.explorer.domain", comps.explorer.enabled ? comps.explorer.domain : undefined],
    ["topology.components.frontend.domain", comps.frontend.enabled ? comps.frontend.domain : undefined],
    ["topology.components.hub.domain", comps.hub.enabled ? comps.hub.domain : undefined],
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
    if (spec.providers.policy.antiAffinity !== "strict") {
      warn("providers.policy.antiAffinity", "mainnet should use strict anti-affinity");
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
    const floor = /^v(\d+)\.(\d+)\.(\d+)$/.exec(VENDORED_CHAIN_VERSION);
    const m = /^sparkdreamnft\/sparkdreamd-[a-z]+-ssh:v(\d+)\.(\d+)\.(\d+)$/.exec(
      spec.images.sparkdreamd,
    );
    if (floor && m) {
      const minVersion = [Number(floor[1]), Number(floor[2]), Number(floor[3])];
      const tag = [Number(m[1]), Number(m[2]), Number(m[3])];
      const older =
        tag[0]! !== minVersion[0] ? tag[0]! < minVersion[0]!
        : tag[1]! !== minVersion[1] ? tag[1]! < minVersion[1]!
        : tag[2]! < minVersion[2]!;
      if (older) {
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
