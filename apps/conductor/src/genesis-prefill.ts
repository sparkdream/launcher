import { fromBech32, toBech32 } from "@cosmjs/encoding";
import type { LaunchSpecInput } from "@sparkdream/launch-spec";

/**
 * "Prefill spec from genesis": reverse-map a genesis document (typically a
 * previous network's, like the manual sparkdream-test-1) into a launch-spec
 * DRAFT plus notes on everything that could not be mapped. Read-only
 * convenience for the spec editor — genesis is never an input to the launch
 * pipeline itself; the produced spec is reviewed and edited like any other.
 *
 * What maps: chain id → name + suffix, denoms/display from identity +
 * staking, accounts/balances (module accounts excluded) with membership and
 * season cosmetics, founding council members, community pool, gentx-derived
 * validators (operators, monikers, self-delegation, commission), and the
 * spec-expressible module params. What cannot map is reported in notes:
 * infra/topology beyond validators (providers, sentries, domains), genesis
 * time, min gas price (node config, not genesis), and any post-genesis
 * history.
 */

type Json = Record<string, any>;

export interface PrefillResult {
  spec: LaunchSpecInput;
  /** Human-facing caveats: guessed, defaulted, or unmappable facts. */
  notes: string[];
}

const num = (v: unknown): number => Number(v);
/** "1814400s" | "1814400.5s" kept verbatim; anything else dropped. */
const duration = (v: unknown): string | undefined =>
  typeof v === "string" && /^[0-9]+(\.[0-9]+)?s$/.test(v) ? v : undefined;

function accountName(username: string | undefined, index: number, used: Set<string>): string {
  let base = username && /^[a-z][a-z0-9-]{0,31}$/.test(username) ? username : `account${index + 1}`;
  while (used.has(base)) base = `${base}x`;
  used.add(base);
  return base;
}

export function prefillSpecFromGenesis(input: Json): PrefillResult {
  const notes: string[] = [];
  // accept raw genesis or a CometBFT RPC /genesis response wrapper
  const genesis: Json = input?.result?.genesis ?? input?.genesis ?? input;
  const app = genesis?.app_state as Json | undefined;
  if (!app) throw new Error("not a genesis document: no app_state");

  // --- network identity ---
  const chainIdRaw = String(genesis.chain_id ?? "");
  const idMatch = /^(.*?)-([1-9][0-9]*)$/.exec(chainIdRaw);
  const name = idMatch ? idMatch[1]! : chainIdRaw;
  const suffix = idMatch ? Number(idMatch[2]) : 1;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length < 3 || name.length > 32) {
    throw new Error(`chain id "${chainIdRaw}" does not split into a usable network name`);
  }
  const type = /dev/.test(name) ? "devnet" : /test/.test(name) ? "testnet" : "mainnet";
  notes.push(
    `network.type "${type}" is guessed from the chain id — correct it if wrong (it selects profile defaults and hardening rules)`,
  );

  const bondDenom: string | undefined = app.staking?.params?.bond_denom;
  if (!bondDenom) throw new Error("genesis has no staking bond denom");
  const identity = app.identity?.identity ?? {};

  // --- module accounts are chain machinery, not spec accounts ---
  const moduleAddresses = new Set<string>(
    ((app.auth?.accounts ?? []) as Json[])
      .filter((a) => a["@type"] === "/cosmos.auth.v1beta1.ModuleAccount")
      .map((a) => a.base_account?.address)
      .filter(Boolean),
  );
  const anyAddress: string | undefined =
    ((app.bank?.balances ?? []) as Json[]).find((b) => !moduleAddresses.has(b.address))?.address;
  if (!anyAddress) throw new Error("genesis has no non-module account balances");
  const bech32Prefix = fromBech32(anyAddress).prefix;

  // --- validators from gentxs (delegator_address is deprecated-empty on
  //     newer SDKs; the valoper address always carries the operator) ---
  const gentxs = (app.genutil?.gen_txs ?? []) as Json[];
  const operators: string[] = [];
  const monikers: string[] = [];
  let selfDelegation: string | undefined;
  let commission: Json | undefined;
  for (const tx of gentxs) {
    const msg = (tx.body?.messages ?? []).find(
      (m: Json) => m["@type"] === "/cosmos.staking.v1beta1.MsgCreateValidator",
    );
    if (!msg) continue;
    const valoper = fromBech32(msg.validator_address);
    operators.push(toBech32(bech32Prefix, valoper.data));
    monikers.push(String(msg.description?.moniker ?? ""));
    if (selfDelegation && msg.value?.amount !== selfDelegation) {
      notes.push(
        `gentxs self-delegate different amounts (${selfDelegation} vs ${msg.value?.amount}); the spec supports one validatorSelfDelegation — using the first`,
      );
    }
    selfDelegation ??= msg.value?.amount;
    commission ??= msg.commission;
  }
  if (operators.length === 0) {
    notes.push("genesis has no gentxs — validator count/operators/self-delegation left as placeholders");
  }
  const defaultMonikers = monikers.every((m, v) => m === `${name}-val-${v}`);

  // --- membership + season cosmetics ---
  const members = new Map<string, Json>(
    ((app.rep?.member_map ?? []) as Json[]).map((m) => [m.address, m]),
  );
  const profiles = new Map<string, Json>(
    ((app.season?.member_profile_map ?? []) as Json[]).map((p) => [p.address, p]),
  );
  const councils = new Map<string, Json>(
    ((app.commons?.founding_members ?? []) as Json[]).map((c) => [c.address, c]),
  );

  const usedNames = new Set<string>();
  const initial: Json[] = [];
  ((app.bank?.balances ?? []) as Json[]).forEach((b, i) => {
    if (moduleAddresses.has(b.address)) return;
    const amount = (b.coins ?? []).find((c: Json) => c.denom === bondDenom)?.amount;
    if (!amount) {
      notes.push(`${b.address} holds no ${bondDenom} at genesis — skipped`);
      return;
    }
    const member = members.get(b.address);
    const profile = profiles.get(b.address);
    const council = councils.get(b.address);
    const entry: Json = {
      name: accountName(profile?.username || undefined, i, usedNames),
      address: b.address,
      amount,
    };
    if (member) {
      const level = String(member.trust_level ?? "TRUST_LEVEL_CORE")
        .replace("TRUST_LEVEL_", "")
        .toLowerCase();
      entry.member = {
        trustLevel: level,
        dreamBalance: member.dream_balance ?? "0",
        ...(profile?.username ? { username: profile.username } : {}),
        ...(profile?.display_name ? { displayName: profile.display_name } : {}),
        ...(profile?.achievements?.length ? { achievements: profile.achievements } : {}),
      };
    }
    if (council) {
      entry.council = {
        ...(council.founder ? { founder: true } : {}),
        ...(council.display_name ? { displayName: council.display_name } : {}),
        ...(Array.isArray(council.handles) && council.handles.length
          ? { handles: council.handles }
          : {}),
      };
    }
    initial.push(entry);
  });

  // --- community pool ---
  const pool = ((app.distribution?.fee_pool?.community_pool ?? []) as Json[]).find(
    (c) => c.denom === bondDenom,
  );
  // DecCoin amounts may carry a fractional part; genesis pools are integral
  const communityPool = pool ? String(pool.amount).split(".")[0] : undefined;

  // --- chainParams (redundant when they match the reference genesis, but
  //     explicit parity is the point of this import) ---
  const dist = app.distribution?.params ?? {};
  const slash = app.slashing?.params ?? {};
  const stakingP = app.staking?.params ?? {};
  const gov = app.gov?.params ?? {};
  const mint = app.mint?.params ?? {};
  const chainParams: Json = {
    ...(dist.community_tax !== undefined
      ? { distribution: { communityTax: num(dist.community_tax) } }
      : {}),
    slashing: {
      ...(slash.signed_blocks_window !== undefined
        ? { signedBlocksWindow: num(slash.signed_blocks_window) }
        : {}),
      ...(slash.min_signed_per_window !== undefined
        ? { minSignedPerWindow: num(slash.min_signed_per_window) }
        : {}),
      ...(duration(slash.downtime_jail_duration)
        ? { downtimeJailDuration: duration(slash.downtime_jail_duration) }
        : {}),
      ...(slash.slash_fraction_downtime !== undefined
        ? { slashFractionDowntime: num(slash.slash_fraction_downtime) }
        : {}),
      ...(slash.slash_fraction_double_sign !== undefined
        ? { slashFractionDoubleSign: num(slash.slash_fraction_double_sign) }
        : {}),
    },
    staking: {
      ...(duration(stakingP.unbonding_time)
        ? { unbondingTime: duration(stakingP.unbonding_time) }
        : {}),
      ...(stakingP.max_validators !== undefined
        ? { maxValidators: num(stakingP.max_validators) }
        : {}),
    },
    gov: {
      ...(duration(gov.voting_period) ? { votingPeriod: duration(gov.voting_period) } : {}),
      ...(gov.min_deposit?.[0]?.amount ? { minDeposit: gov.min_deposit[0].amount } : {}),
    },
    mint: {
      ...(mint.inflation_min !== undefined ? { inflationMin: num(mint.inflation_min) } : {}),
      ...(mint.inflation_max !== undefined ? { inflationMax: num(mint.inflation_max) } : {}),
      ...(mint.goal_bonded !== undefined ? { goalBonded: num(mint.goal_bonded) } : {}),
    },
    ...(commission
      ? {
          validatorDefaults: {
            commissionRate: num(commission.rate),
            commissionMaxRate: num(commission.max_rate),
            commissionMaxChangeRate: num(commission.max_change_rate),
          },
        }
      : {}),
  };
  for (const key of Object.keys(chainParams)) {
    if (Object.keys(chainParams[key]).length === 0) delete chainParams[key];
  }

  const spec: Json = {
    version: 1,
    network: {
      name,
      type,
      ...(suffix !== 1 ? { chainIdSuffix: suffix } : {}),
      bech32Prefix,
      ...(identity.chain_human_name ? { displayName: identity.chain_human_name } : {}),
    },
    token: {
      baseDenom: bondDenom,
      displayDenom: identity.bond_display_symbol ?? "TOKEN",
      ...(identity.bond_display_decimals !== undefined
        ? { exponent: num(identity.bond_display_decimals) }
        : {}),
      ...(identity.dream_display_symbol ? { dreamDisplayDenom: identity.dream_display_symbol } : {}),
    },
    accounts: {
      initial,
      validatorSelfDelegation: selfDelegation ?? "1000000000000",
      ...(communityPool ? { communityPool } : {}),
    },
    topology: {
      validators: {
        count: Math.max(1, operators.length),
        ...(operators.length ? { operators } : {}),
        ...(operators.length && !defaultMonikers ? { monikers } : {}),
      },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.example.com" },
    },
    chainParams,
  };

  notes.push(
    "genesis carries no infrastructure: sentry count, components, headscale domain (placeholder headscale.example.com), providers, resources, and security.keyMode are profile defaults — review them",
    "token.minGasPrice is node config, not genesis — the profile default applies unless you set it",
    operators.length
      ? "operators are imported as external (your wallets sign the gentxs; use the offline signing panel for airgapped keys) — replace with \"generated\" for launcher-held keys"
      : "set topology.validators and accounts.validatorSelfDelegation by hand",
    "post-genesis history (posts, balances moved after launch, timestamps) is not in a genesis file and cannot carry over",
  );
  if (identity.bond_display_symbol === undefined) {
    notes.push("genesis has no identity module state — token display fields are placeholders");
  }

  return { spec: spec as LaunchSpecInput, notes };
}
