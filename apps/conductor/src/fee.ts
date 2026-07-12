/**
 * Launcher service fees — all bank sends to the same address, each batched
 * into a tx the user already signs (no extra signature; visible in the
 * Keplr prompt):
 *
 *  - launch:  one-time cut of the fleet's leased MONTHLY rate, on the
 *             create-leases tx (initial launch only).
 *  - upgrade: flat amount per rolling / halt-height upgrade op, on the op's
 *             first MsgUpdateDeployment tx.
 *  - top-up:  cut of each escrow deposit, on the fleet:topup tx.
 *
 * Relaunches move an existing deployment (often forced by a dead provider),
 * so they are NOT charged.
 *
 * Fees are computed in the pricing denom but SENT in a transferable one:
 * mainnet prices in uact, and ACT credits cannot be bank-sent (the chain
 * disables uact transfers — credits are mint-and-spend only), so uact fee
 * amounts convert to uakt at the chain oracle's AKT/USD price (see feeCoin).
 *
 * The launcher is open source, so every knob is env-overridable — a fork can
 * change or disable any fee, and being upfront costs nothing.
 */

export interface FeeConfig {
  /** Recipient of every fee (bank send). */
  address: string;
  /** Launch fee: basis points of the leased monthly rate (1000 = 10%). 0 disables. */
  launchBps: number;
  /** Upgrade fee: flat micro-denom per upgrade op (500_000 = 0.5 ACT). 0 disables. */
  upgradeFlat: number;
  /** Top-up fee: basis points of the deposit amount (50 = 0.5%). 0 disables. */
  topupBps: number;
}

const DEFAULT_FEE_ADDRESS = "akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w";
const DEFAULT_LAUNCH_BPS = 1000;
const DEFAULT_UPGRADE_FLAT = 500_000;
const DEFAULT_TOPUP_BPS = 50;

export function feeConfig(): FeeConfig {
  const num = (v: string | undefined, d: number) => (v !== undefined ? Number(v) : d);
  return {
    address: process.env.LAUNCH_FEE_ADDRESS ?? DEFAULT_FEE_ADDRESS,
    launchBps: num(process.env.LAUNCH_FEE_BPS, DEFAULT_LAUNCH_BPS),
    upgradeFlat: num(process.env.LAUNCH_FEE_UPGRADE, DEFAULT_UPGRADE_FLAT),
    topupBps: num(process.env.LAUNCH_FEE_TOPUP_BPS, DEFAULT_TOPUP_BPS),
  };
}

/** Fee in micro-denom from a basis-point rate on a micro-denom base (round up). */
export function bpsAmount(base: string | number, bps: number): string {
  return String(Math.ceil(Number(base) * (bps / 10_000)));
}

/** Same block/month math the UI and console-air use (~6.098s blocks). */
export const BLOCKS_PER_MONTH = (30.437 * 24 * 60 * 60) / 6.098;

/**
 * Launch fee in micro-denom from the fleet's per-block lease prices (DecCoin
 * amount strings). Rounded up so a dust-priced fleet still pays ≥1u.
 */
export function launchFeeAmount(perBlockPrices: string[], bps: number): string {
  const perBlock = perBlockPrices.reduce((sum, p) => sum + Number(p), 0);
  return bpsAmount(perBlock * BLOCKS_PER_MONTH, bps);
}

/** uact (USD-pegged micro-credits) → uakt at the oracle AKT/USD price (round up). */
export function uactToUakt(uact: string | number, aktUsd: number): string {
  return String(Math.ceil(Number(uact) / aktUsd));
}

/**
 * The coin a service fee is actually sent as. Fees are computed in the
 * pricing denom, but on mainnet that is uact — ACT credits are mint-and-spend
 * only (bank sends disabled), so a uact fee converts to uakt at the chain
 * oracle's AKT/USD price. undefined = price unavailable; fees are best-effort
 * and must never block the op that carries them, so callers skip the send.
 */
export async function feeCoin(
  pricingDenom: string,
  amount: string,
  api: { aktUsdPrice(): Promise<number | undefined> },
): Promise<{ denom: string; amount: string } | undefined> {
  if (pricingDenom !== "uact") return { denom: pricingDenom, amount };
  const price = await api.aktUsdPrice().catch(() => undefined);
  if (!price) return undefined;
  return { denom: "uakt", amount: uactToUakt(amount, price) };
}
