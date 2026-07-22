import { sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { deriveDreamDenom, type LaunchSpec } from "@sparkdream/launch-spec";

/**
 * Cosmos SDK decimal string: 18 fractional digits. Pads the number's exact
 * short decimal form instead of toFixed(18), which leaks float noise
 * (0.05 → "0.050000000000000003").
 */
function dec(n: number): string {
  const s = String(n);
  if (s.includes("e") || s.includes("E")) throw new Error(`rate ${s} out of supported range`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 18) throw new Error(`rate ${s} has more than 18 decimals`);
  return `${whole}.${frac.padEnd(18, "0")}`;
}

type Json = Record<string, any>;

/**
 * Deep-fill: keys the reference genesis predates fall back to the init
 * skeleton's values — the defaults of the very binary that will validate
 * them. The reference wins wherever it says anything (arrays and scalars
 * replace outright); only genuinely missing object keys are filled. Without
 * this, a binary that grew a module param after the reference genesis was
 * cut sees it as nil and refuses the genesis at gentx/validate time
 * (observed: x/rep self_assigned_* params, sparkdreamd v1.0.25).
 */
function fillDefaults(value: any, defaults: any): any {
  if (
    value === null || defaults === null ||
    typeof value !== "object" || typeof defaults !== "object" ||
    Array.isArray(value) || Array.isArray(defaults)
  ) {
    return value;
  }
  const out: Json = { ...value };
  for (const [key, def] of Object.entries(defaults)) {
    out[key] = key in out ? fillDefaults(out[key], def) : def;
  }
  return out;
}

/**
 * Overlay the vendored per-network reference genesis (chain repo
 * deploy/config/network/<type>/genesis.json) onto the freshly-init'd
 * genesis, so a launched chain starts from the same module parameters and
 * bootstrap state (identity, denom metadata, forum categories, rep tags,
 * seeded members, the genesis season) as the reference network.
 *
 * The launcher stays the owner of what it constructs itself: gentxs
 * (genutil), accounts and balances (auth.accounts, bank balances/supply),
 * and the distribution fee pool — the reference community pool is backed by
 * a module-account balance in the reference bank state, so copying one
 * without the other fails InitGenesis.
 *
 * Reference denoms are rewritten to the spec's wherever they appear,
 * including embedded inside strings (commons proposal_fee is "5000000<denom>").
 */
export function applyReferenceGenesis(genesis: Json, reference: Json, spec: LaunchSpec): Json {
  const refApp = reference.app_state as Json;
  const app = genesis.app_state as Json;

  const refBond = refApp.staking?.params?.bond_denom as string | undefined;
  if (!refBond) throw new Error("reference genesis has no staking bond denom");
  const refDream = refApp.identity?.identity?.dream_denom as string | undefined;
  const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;
  const dreamDenom = deriveDreamDenom(spec.token);
  if (!dreamDenom) {
    throw new Error(
      `cannot derive a dream denom from bond denom "${bondDenom}" — set token.dreamDenom`,
    );
  }

  const substituteDenoms = <T>(value: T): T => {
    let s = JSON.stringify(value);
    s = s.split(refBond).join(bondDenom);
    if (refDream) s = s.split(refDream).join(dreamDenom);
    return JSON.parse(s) as T;
  };

  for (const [module, refState] of Object.entries(refApp)) {
    if (module === "genutil") continue;
    // a module the binary no longer ships (x/crisis left with sdk 0.53):
    // its state is dead weight the running chain can never read
    if (!(module in app)) continue;
    const overlaid = fillDefaults(substituteDenoms(refState), app[module]) as Json;
    if (module === "auth") overlaid.accounts = app.auth?.accounts ?? [];
    if (module === "bank") {
      overlaid.balances = app.bank?.balances ?? [];
      overlaid.supply = app.bank?.supply ?? [];
    }
    if (module === "distribution" && app.distribution?.fee_pool) {
      overlaid.fee_pool = app.distribution.fee_pool;
    }
    app[module] = overlaid;
  }

  // Membership is spec-driven (accounts[].member, applyGenesisMembers) —
  // the reference network's seeded members don't carry over.
  if (app.rep) app.rep.member_map = [];
  if (app.season) app.season.member_profile_map = [];

  // Token display naming follows the spec like the base denoms do. The
  // metadata keeps the reference's lowercase convention (display "spark");
  // identity keeps its display symbols uppercase. Identity display names
  // ("Sparkdream Test Spark") only change when the symbol does — there is
  // nothing to derive the reference's phrasing from.
  const tokens = [
    { base: bondDenom, symbol: spec.token.displayDenom, identityKey: "bond" },
    { base: dreamDenom, symbol: spec.token.dreamDisplayDenom, identityKey: "dream" },
  ];
  for (const { base, symbol, identityKey } of tokens) {
    const display = symbol.toLowerCase();
    const meta = (app.bank?.denom_metadata ?? []).find((m: Json) => m.base === base);
    if (meta) {
      meta.display = display;
      meta.name = display;
      meta.symbol = display;
      meta.denom_units = [
        { denom: base, exponent: 0 },
        { denom: display, exponent: spec.token.exponent },
      ];
    }
    const identity = app.identity?.identity as Json | undefined;
    if (identity) {
      if (identity[`${identityKey}_display_symbol`] !== symbol) {
        identity[`${identityKey}_display_name`] = symbol.charAt(0) + display.slice(1);
      }
      identity[`${identityKey}_display_symbol`] = symbol;
      identity[`${identityKey}_display_decimals`] = spec.token.exponent;
    }
  }

  if (reference.consensus?.params && genesis.consensus) {
    genesis.consensus.params = substituteDenoms(reference.consensus.params);
  }
  return genesis;
}

/**
 * Seed genesis membership from spec accounts with a `member` entry. Each
 * becomes an active x/rep member at the requested trust level (default
 * core), with dream balance and invitation credits defaulting to the
 * reference network's seed for a member of that level (personal history
 * zeroed), plus an x/season profile. Profile cosmetics (username, display
 * name, achievements) are seeded only when the spec spells them out —
 * otherwise they stay blank to claim on-chain (account names would collide
 * with x/name blocked_names: "treasury", "gov", ...). Runs after
 * applyReferenceGenesis; idempotent because that overlay resets the member
 * lists.
 */
export function applyGenesisMembers(
  genesis: Json,
  reference: Json,
  spec: LaunchSpec,
  accounts: Record<string, string>,
): Json {
  const members = spec.accounts.initial.filter((a) => a.member);
  if (members.length === 0) return genesis;

  const refMembers = (reference.app_state?.rep?.member_map ?? []) as Json[];
  const coreTemplate =
    refMembers.find((m) => m.trust_level === "TRUST_LEVEL_CORE") ?? refMembers[0];
  if (!coreTemplate) {
    throw new Error("reference genesis has no rep members to model spec members on");
  }

  const app = genesis.app_state as Json;
  for (const acct of members) {
    const address = acct.address ?? accounts[`acct-${acct.name}`];
    if (!address) throw new Error(`no address for member account ${acct.name}`);
    const opts: {
      trustLevel?: string | undefined;
      dreamBalance?: string | undefined;
      username?: string | undefined;
      displayName?: string | undefined;
      achievements?: string[] | undefined;
    } = typeof acct.member === "object" ? acct.member : {};
    const level = `TRUST_LEVEL_${(opts.trustLevel ?? "core").toUpperCase()}`;
    // the reference seed for this level carries the network's convention for
    // starting dream balance and invitation credits; levels the reference
    // never seeded (e.g. "new") start empty-handed
    const template = refMembers.find((m) => m.trust_level === level) ?? coreTemplate;
    const sameLevel = template.trust_level === level;
    app.rep.member_map.push({
      ...template,
      address,
      trust_level: level,
      dream_balance: opts.dreamBalance ?? (sameLevel ? template.dream_balance : "0"),
      invitation_credits: sameLevel ? template.invitation_credits : 0,
      staked_dream: "0",
      lifetime_earned: opts.dreamBalance ?? (sameLevel ? template.dream_balance : "0"),
      lifetime_burned: "0",
      reputation_scores: {},
      lifetime_reputation: {},
      trust_level_updated_at: 0,
      joined_season: 0,
      joined_at: 0,
      invited_by: "",
      invitation_chain: [],
      status: "MEMBER_STATUS_ACTIVE",
      zeroed_at: 0,
      zeroed_count: 0,
      last_decay_epoch: 0,
      tips_given_this_epoch: 0,
      last_tip_epoch: 0,
      completed_interims_count: 0,
      completed_initiatives_count: 0,
    });
    app.season.member_profile_map.push({
      address,
      username: opts.username ?? "",
      display_name: opts.displayName ?? "",
      display_title: "",
      achievements: opts.achievements ?? [],
      unlocked_titles: [],
      season_xp: 0,
      season_level: 0,
      lifetime_xp: 0,
      votes_cast: 0,
      challenges_won: 0,
      jury_duties_completed: 0,
      forum_helpful_count: 0,
      invitations_successful: 0,
    });
  }
  return genesis;
}

/**
 * Seed the genesis community pool (accounts.communityPool): the
 * distribution fee_pool entry must be backed by a matching balance on the
 * distribution module account, which must itself exist in auth, and the
 * bank supply must cover it — x/distribution's InitGenesis invariant
 * rejects any of the four missing. The module address is the SDK
 * derivation: sha256(module name) truncated to 20 bytes.
 *
 * Runs AFTER genesis accounts are added (it appends to auth.accounts and
 * recomputes supply from balances) and idempotently: re-runs after gentx
 * pauses must not double-seed.
 */
export function applyCommunityPool(genesis: Json, spec: LaunchSpec): Json {
  const amount = spec.accounts.communityPool;
  if (!amount) return genesis;
  const denom = spec.token.bondDenom ?? spec.token.baseDenom;
  const app = genesis.app_state as Json;
  const address = toBech32(
    spec.network.bech32Prefix,
    sha256(new TextEncoder().encode("distribution")).slice(0, 20),
  );

  const balances = (app.bank.balances ?? []) as Json[];
  if (!balances.some((b) => b.address === address)) {
    balances.push({ address, coins: [{ denom, amount }] });
    app.bank.balances = balances;

    const accounts = (app.auth.accounts ?? []) as Json[];
    accounts.push({
      "@type": "/cosmos.auth.v1beta1.ModuleAccount",
      base_account: {
        // account numbers are reassigned contiguously by auth InitGenesis;
        // this just has to be unique within the file
        account_number: String(accounts.length),
        address,
        pub_key: null,
        sequence: "0",
      },
      name: "distribution",
      permissions: [],
    });
    app.auth.accounts = accounts;

    const supply = (app.bank.supply ?? []) as Json[];
    const entry = supply.find((s) => s.denom === denom);
    if (entry) entry.amount = String(BigInt(entry.amount) + BigInt(amount));
    else supply.push({ denom, amount });
    app.bank.supply = supply;
  }

  app.distribution.fee_pool = { community_pool: [{ denom, amount }] };
  return genesis;
}

/**
 * Write x/commons founding_members from spec accounts flagged `council`.
 * The chain's InitGenesis bootstrap builds the founding councils from this
 * list when it is non-empty, instead of the image's compiled-in founder
 * addresses (GenesisNames), which a launched chain's generated accounts can
 * never match. Runs after applyReferenceGenesis (the vendored reference
 * genesis carries an empty founding_members, so nothing is overwritten). With no
 * council accounts the field is left unset: the compiled-in founders apply,
 * which validateSpec only allows when explicit-address accounts might match
 * them.
 */
export function applyFoundingMembers(
  genesis: Json,
  spec: LaunchSpec,
  accounts: Record<string, string>,
): Json {
  const councils = spec.accounts.initial.filter((a) => a.council);
  if (councils.length === 0) return genesis;

  const app = genesis.app_state as Json;
  if (!app.commons) throw new Error("genesis has no commons module state");
  app.commons.founding_members = councils.map((acct) => {
    const address = acct.address ?? accounts[`acct-${acct.name}`];
    if (!address) throw new Error(`no address for council account ${acct.name}`);
    const opts = typeof acct.council === "object" ? acct.council : {};
    return {
      address,
      display_name: opts.displayName ?? acct.name.charAt(0).toUpperCase() + acct.name.slice(1),
      handles: opts.handles ?? [],
      founder: opts.founder ?? false,
    };
  });
  return genesis;
}

/**
 * Apply spec.chainParams + denoms directly onto genesis JSON (§12.4:
 * direct manipulation, no Python dependency). Runs after
 * applyReferenceGenesis: only touches fields the spec sets, so the
 * reference network's values stand unless the user overrides them.
 */
export function applyChainParams(genesis: Json, spec: LaunchSpec): Json {
  const p = spec.chainParams;
  const app = genesis.app_state as Json;
  const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;

  const staking = app.staking?.params as Json | undefined;
  if (staking) {
    staking.bond_denom = bondDenom;
    if (p.staking?.unbondingTime) staking.unbonding_time = p.staking.unbondingTime;
    if (p.staking?.maxValidators !== undefined) staking.max_validators = p.staking.maxValidators;
  }

  const gov = app.gov?.params as Json | undefined;
  if (gov) {
    if (p.gov?.votingPeriod) {
      gov.voting_period = p.gov.votingPeriod;
      // invariant: expedited_voting_period < voting_period
      const seconds = parseInt(p.gov.votingPeriod, 10);
      gov.expedited_voting_period = `${Math.max(1, Math.floor(seconds / 2))}s`;
    }
    if (p.gov?.minDeposit) {
      gov.min_deposit = [{ denom: bondDenom, amount: p.gov.minDeposit }];
      // invariant: expedited_min_deposit > min_deposit (SDK default ratio: 5x)
      gov.expedited_min_deposit = [
        { denom: bondDenom, amount: (5n * BigInt(p.gov.minDeposit)).toString() },
      ];
    }
  }

  const mint = app.mint?.params as Json | undefined;
  if (mint) {
    mint.mint_denom = bondDenom;
    if (p.mint?.inflationMin !== undefined) mint.inflation_min = dec(p.mint.inflationMin);
    if (p.mint?.inflationMax !== undefined) mint.inflation_max = dec(p.mint.inflationMax);
    if (p.mint?.goalBonded !== undefined) mint.goal_bonded = dec(p.mint.goalBonded);
  }

  const distribution = app.distribution?.params as Json | undefined;
  if (distribution && p.distribution?.communityTax !== undefined) {
    distribution.community_tax = dec(p.distribution.communityTax);
  }

  const slashing = app.slashing?.params as Json | undefined;
  if (slashing && p.slashing) {
    const s = p.slashing;
    if (s.signedBlocksWindow !== undefined)
      slashing.signed_blocks_window = String(s.signedBlocksWindow);
    if (s.minSignedPerWindow !== undefined)
      slashing.min_signed_per_window = dec(s.minSignedPerWindow);
    if (s.downtimeJailDuration) slashing.downtime_jail_duration = s.downtimeJailDuration;
    if (s.slashFractionDowntime !== undefined)
      slashing.slash_fraction_downtime = dec(s.slashFractionDowntime);
    if (s.slashFractionDoubleSign !== undefined)
      slashing.slash_fraction_double_sign = dec(s.slashFractionDoubleSign);
  }

  // Legacy module some chains still carry; keep its denom consistent if present.
  const crisis = app.crisis as Json | undefined;
  if (crisis?.constant_fee) crisis.constant_fee.denom = bondDenom;

  return genesis;
}

export interface CommissionFlags {
  rate: string;
  maxRate: string;
  maxChangeRate: string;
}

export function commissionFlags(spec: LaunchSpec): CommissionFlags {
  const d = spec.chainParams.validatorDefaults;
  return {
    rate: dec(d?.commissionRate ?? 0.05),
    maxRate: dec(d?.commissionMaxRate ?? 0.2),
    maxChangeRate: dec(d?.commissionMaxChangeRate ?? 0.01),
  };
}
