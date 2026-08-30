import type { LaunchSpec, LaunchSpecInput } from "@sparkdream/launch-spec";

/**
 * "Prefill spec from join bundle" (§5 "Public peering & the join bundle"):
 * turn the public join document into a launch-spec DRAFT. The bundle's
 * eight fields land in four places (join, network.bech32Prefix, token,
 * images.sparkdreamd), which is the transcription this saves; everything
 * else is the joiner's own and arrives as a note.
 *
 * Two modes, one transform:
 *
 * - **bundle only** — a third-party operator who has nothing but the JSON.
 *   The draft is a skeleton: one validator, one sentry, profile defaults
 *   for the rest.
 * - **bundle + base** — the origin operator expanding their own chain
 *   (`GET /api/fleet/:id/join-spec`). The fleet's own spec carries over so
 *   resources, provider policy and key mode are not retyped, minus every
 *   field that belongs to the chain rather than to a fleet, and minus the
 *   fields whose reuse would quietly break the second pair (see
 *   `stripOrigin`). What survives is still a draft: it is read and edited
 *   in the spec editor like any other, never launched blind.
 */

export interface JoinPrefillResult {
  spec: LaunchSpecInput;
  /** Human-facing caveats: what was dropped, defaulted, or left to fill in. */
  notes: string[];
}

export interface JoinPrefillOptions {
  /**
   * The origin fleet's stored spec. Present only for the self-expansion
   * path, where the launcher has the fleet the bundle came from.
   */
  base?: LaunchSpec;
  /** Fleet name for the draft; the caller picks one no launch holds yet. */
  fleetName?: string;
  /**
   * Providers already hosting the origin's own validators and sentries.
   * Seeded into the new pair's exclusions: a second pair sharing a
   * provider with the first buys availability it does not have.
   */
  colocatedProviders?: string[];
}

type Json = Record<string, any>;

function asArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`join bundle: ${field} must be a list of strings`);
  }
  return value as string[];
}

/**
 * Fleet name for the draft: the chain id without its revision suffix, plus
 * "-join" (schema: lowercase, inner hyphens, 3-32 chars). It names the
 * fleet and its monikers only — the chain id comes from the join block.
 */
function fleetNameFrom(chainId: string): string {
  const stem = chainId
    .replace(/-[1-9][0-9]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 27)
    .replace(/-+$/, "");
  return stem.length >= 1 ? `${stem}-join` : "chain-join";
}

/** Same guess the genesis prefill makes, and the same caveat. */
function networkTypeFrom(chainId: string): "devnet" | "testnet" | "mainnet" {
  return /dev/.test(chainId) ? "devnet" : /test/.test(chainId) ? "testnet" : "mainnet";
}

/**
 * A fresh headscale hostname in the zone the origin already uses:
 * "headscale.sparkdream.io" → "headscale-join.sparkdream.io". The record
 * still has to be created by hand, so this is a suggestion, not a value the
 * draft can be launched on unread.
 */
function suggestHeadscaleDomain(origin: unknown): string | undefined {
  if (typeof origin !== "string" || !origin.includes(".")) return undefined;
  const [label, ...rest] = origin.split(".");
  const stem = label!.replace(/-join(-[0-9]+)?$/, "");
  return [`${stem}-join`, ...rest].join(".");
}

/**
 * Fields of the origin spec that must NOT carry into a join launch, each
 * for its own reason. The genesis-shaping ones validate-spec would reject
 * anyway; the rest are the quiet ones, where a copied value produces a
 * launch that validates, runs, and is wrong.
 */
function stripOrigin(base: LaunchSpec, notes: string[], colocated: string[]): Json {
  const spec: Json = structuredClone(base) as Json;

  // --- genesis-shaping: the chain already exists (validate-spec rejects
  //     these in join mode; dropping them here keeps the draft clean) ---
  const dropped: string[] = [];
  if (spec.accounts?.initial?.length) dropped.push(`accounts.initial (${spec.accounts.initial.length})`);
  if (spec.accounts?.communityPool) dropped.push("accounts.communityPool");
  spec.accounts = { initial: [], validatorSelfDelegation: base.accounts.validatorSelfDelegation };
  for (const section of ["staking", "gov", "mint", "distribution", "slashing"] as const) {
    if (spec.chainParams?.[section]) {
      dropped.push(`chainParams.${section}`);
      delete spec.chainParams[section];
    }
  }
  if (dropped.length) {
    notes.push(
      `dropped from the origin spec (they belong to the live chain, not to your nodes): ${dropped.join(", ")}`,
    );
  }

  // --- identity the origin still holds ---
  const validators = spec.topology.validators as Json;
  if (Array.isArray(validators.operators)) {
    validators.operators = "generated";
    notes.push(
      "topology.validators.operators was reset to \"generated\": an operator address can hold only " +
        "one validator, and create-validator SKIPS an address that already has one, so the launch " +
        "would finish green with a synced but unbonded node. To sign with your own wallet, list " +
        "addresses that hold no validator on this chain yet",
    );
  }
  if (validators.consensusPubkeys) {
    delete validators.consensusPubkeys;
    notes.push(
      "topology.validators.consensusPubkeys was dropped: those keys are signing for the origin " +
        "fleet, and two nodes holding one consensus key double-sign the first conflicting block " +
        "they both see (tombstoned, not just jailed)",
    );
  }
  if (validators.monikers) {
    delete validators.monikers;
    notes.push(
      `topology.validators.monikers was dropped: monikers now default to "<network.name>-val-N", ` +
        "so the new validators are distinguishable from the origin's in explorers",
    );
  }
  validators.count = 1;
  const sentries = spec.topology.sentries as Json;
  if (Array.isArray(sentries.mapping)) {
    sentries.mapping = "round-robin";
    notes.push("topology.sentries.mapping was reset to round-robin for the new counts");
  }
  sentries.count = 1;
  notes.push(
    "topology is one validator and one sentry: raise the counts if you are adding more than a pair",
  );

  // --- DNS the origin fleet's ingress already answers for ---
  if (spec.topology.publicEndpoints) {
    delete spec.topology.publicEndpoints;
    notes.push(
      "topology.publicEndpoints was dropped: those names resolve to the origin fleet's sentry-0. " +
        "Give the new sentry its own api/rpc names to serve them, or leave it off the public web",
    );
  }
  const enabled = (["explorer", "frontend", "hub"] as const).filter(
    (c) => (spec.topology.components as Json)[c]?.enabled,
  );
  for (const c of ["explorer", "frontend", "hub"] as const) {
    const comp = (spec.topology.components as Json)[c];
    if (!comp) continue;
    comp.enabled = false;
    delete comp.domain;
  }
  if (enabled.length) {
    notes.push(
      `${enabled.join(", ")} turned off (the origin fleet's copy keeps serving on those domains): ` +
        "re-enable with fresh domains if you want a second copy of them",
    );
  }
  const headscale = spec.topology.headscale as Json;
  delete headscale.reuseFleet;
  const suggested = suggestHeadscaleDomain(headscale.domain);
  if (suggested) headscale.domain = suggested;
  else delete headscale.domain;
  notes.push(
    `topology.headscale.domain is a SUGGESTION${suggested ? ` (${suggested})` : ""}: the new pair ` +
      "runs its own mesh, so this must be a name you control and have pointed at the new headscale " +
      "(the launch pauses for that DNS record). topology.headscale.reuseFleet would instead share " +
      "the origin fleet's headscale, which is one tailscale login for both fleets but puts the new " +
      "pair's mesh behind the origin's server and blocks that fleet from ever shutting down",
  );
  if (headscale.backup) {
    delete headscale.backup;
    notes.push(
      "topology.headscale.backup was dropped: both fleets would replicate their headscale database " +
        "into one bucket path. Re-add it pointed at a bucket of its own",
    );
  }

  // --- placement: a second pair on the first pair's provider is not a
  //     second pair for any failure that takes the provider out ---
  if (colocated.length) {
    const components = (spec.providers.components ?? {}) as Json;
    for (const group of ["validators", "sentries"] as const) {
      const rules = (components[group] ?? {}) as Json;
      const exclude: string[] = Array.isArray(rules.exclude) ? rules.exclude : [];
      rules.exclude = [...new Set([...exclude, ...colocated])];
      components[group] = rules;
    }
    spec.providers.components = components;
    notes.push(
      `providers.components.{validators,sentries}.exclude now carries the providers hosting the ` +
        `origin's own nodes (${colocated.join(", ")}), so the new pair lands somewhere else. ` +
        "providers.policy.preference is unchanged and may still name them",
    );
  }

  return spec;
}

/**
 * Build a spec draft from a join bundle (the JSON a fleet publishes at
 * `GET /api/fleet/:id/join-bundle`), optionally on top of the origin
 * fleet's own spec.
 */
export function joinSpecFromBundle(input: unknown, opts: JoinPrefillOptions = {}): JoinPrefillResult {
  const notes: string[] = [];
  const bundle = input as Json;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("join bundle: expected a JSON object");
  }
  const chainId = bundle.chainId;
  if (typeof chainId !== "string" || chainId.length === 0) {
    throw new Error("not a join bundle: no chainId");
  }
  const peers = asArray(bundle.peers, "peers");
  if (peers.length === 0) throw new Error("join bundle: peers is empty, so there is nothing to dial");
  const stateSyncRpcs = asArray(bundle.stateSyncRpcs, "stateSyncRpcs");
  if (stateSyncRpcs.length < 2) {
    throw new Error(
      "join bundle: state sync needs two RPC endpoints and this bundle carries " +
        `${stateSyncRpcs.length} (the origin fleet exports two once it has a second sentry or a ` +
        "public rpc domain; you can also add any independent RPC you trust)",
    );
  }
  const genesisUrl =
    typeof bundle.genesisUrl === "string" && bundle.genesisUrl
      ? bundle.genesisUrl
      : `${stateSyncRpcs[0]!.replace(/\/+$/, "")}/genesis`;
  if (genesisUrl !== bundle.genesisUrl) {
    notes.push(`the bundle names no genesisUrl, so the draft reads it from ${genesisUrl}`);
  }
  const join: Json = {
    chainId,
    genesisUrl,
    ...(typeof bundle.genesisSha256 === "string" ? { genesisSha256: bundle.genesisSha256 } : {}),
    peers,
    stateSyncRpcs,
  };
  if (!join.genesisSha256) {
    notes.push(
      "the bundle carries no genesisSha256, so nothing pins the genesis document and the host " +
        "serving it is trusted for integrity (an error on mainnet). Ask the origin operator for " +
        "the hash, or compute it from a copy you trust",
    );
  }
  if (typeof bundle.notice === "string" && bundle.notice) {
    notes.push(`from the bundle: ${bundle.notice}`);
  }

  const base = opts.base;
  const bech32Prefix = bundle.bech32Prefix ?? base?.network.bech32Prefix;
  if (typeof bech32Prefix !== "string") {
    throw new Error("join bundle: no bech32Prefix (it must match the binary's baked-in prefix)");
  }
  const image = typeof bundle.image === "string" ? bundle.image : undefined;
  if (!image) {
    notes.push(
      "the bundle names no image: set images.sparkdreamd to the binary the live chain runs, or the " +
        "node state-syncs into an apphash divergence",
    );
  }
  const token: Json | undefined = bundle.token;
  if (!token?.baseDenom) {
    notes.push("the bundle carries no token block: token.baseDenom must match the live chain's bond denom");
  }

  const spec: Json = base
    ? stripOrigin(base, notes, opts.colocatedProviders ?? [])
    : {
        version: 1,
        network: { type: networkTypeFrom(chainId) },
        accounts: { initial: [], validatorSelfDelegation: "1000000000" },
        topology: {
          validators: { count: 1, operators: "generated" },
          sentries: { count: 1 },
          components: {
            explorer: { enabled: false },
            frontend: { enabled: false },
            hub: { enabled: false },
          },
          headscale: { domain: "headscale.example.com" },
        },
        images: {},
      };

  spec.network = {
    ...spec.network,
    name: opts.fleetName ?? fleetNameFrom(chainId),
    bech32Prefix,
  };
  delete spec.network.chainIdSuffix; // the chain id comes from the join block
  spec.join = join;
  if (token) spec.token = { ...token };
  if (image) {
    // chainRepoCommit pins deploy data to the OLD image; join mode reads
    // neither, but a stale pin outliving its image is a trap on a later edit
    if (spec.images?.sparkdreamd && spec.images.sparkdreamd !== image) delete spec.images.chainRepoCommit;
    spec.images = { ...spec.images, sparkdreamd: image };
  }

  if (base) {
    notes.push(
      `token and images.sparkdreamd come from the bundle (${image ?? "unchanged"}): run what the ` +
        "live chain runs",
      `accounts.validatorSelfDelegation (${base.accounts.validatorSelfDelegation}) is now a real ` +
        "transfer on a live chain, not a genesis allocation: the operator address must hold it plus " +
        "the tx fee before the await-funds step will pass",
    );
    if (base.security.keyMode === "tmkms") {
      notes.push(
        "security.keyMode is tmkms, so the new validator needs its own signer set up and connected " +
          "before it can bond (the tmkms panel walks the same checklist the origin fleet used)",
      );
    }
    notes.push(
      "place the new pair near the origin's: a validator far from the rest of the network gets its " +
        "precommits in after each block is sealed, which reads as downtime and jails it, and no sync " +
        "gate in the launch can see that coming",
    );
  } else {
    notes.push(
      `network.type "${spec.network.type}" is guessed from the chain id, and it selects the profile ` +
        "defaults (resources, images, key mode) and the hardening rules: correct it if wrong",
      "the bundle carries no infrastructure: sentry count, components, providers, resources and " +
        "security.keyMode are profile defaults, and topology.headscale.domain is a placeholder " +
        "(headscale.example.com) you must replace with a DNS name you control",
      "accounts.validatorSelfDelegation is a placeholder: set the stake you will actually bond, and " +
        "fund the operator address with it (plus the tx fee) before the await-funds step",
      "stopping before Phase G leaves a synced sentry and full node that never bonds, which is a " +
        "valid deployment on its own",
    );
    if (spec.network.type === "mainnet") {
      notes.push(
        "read as a mainnet join, so the mainnet rules apply and the draft reports what it cannot " +
          "know as errors: headscale S3 backup credentials, and a pinned genesisSha256",
      );
    }
  }

  return { spec: spec as LaunchSpecInput, notes };
}
