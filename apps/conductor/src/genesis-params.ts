import type { LaunchSpec } from "@sparkdream/launch-spec";

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
 * Apply spec.chainParams + denoms directly onto genesis JSON (§12.4:
 * direct manipulation, no Python dependency). Only touches fields the
 * spec sets; profile defaults are already merged into the spec.
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
