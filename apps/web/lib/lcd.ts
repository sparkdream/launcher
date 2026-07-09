/**
 * Direct LCD (REST) reads against the compute network — wallet balances and
 * the BME (burn-mint-earn) module used to mint ACT from AKT. Follows the
 * console-air flow: MsgMintACT burns uakt; the uact is settled
 * asynchronously by the module's epoch ledger, tracked via /ledger records.
 * The output amount is only known at settlement (oracle rate), so mints
 * below params.min_mint are accepted on-chain and CANCELED at the epoch —
 * the UI must estimate and gate before submitting, as console-air does.
 */

export interface Coin {
  denom: string;
  amount: string;
}

async function getJson(rest: string, path: string): Promise<any> {
  const res = await fetch(`${rest.replace(/\/$/, "")}${path}`);
  if (!res.ok) throw new Error(`LCD ${path} → ${res.status}`);
  return res.json();
}

/** All spendable balances for `address` (uakt, uact, …). */
export async function fetchBalances(rest: string, address: string): Promise<Coin[]> {
  const body = await getJson(rest, `/cosmos/bank/v1beta1/balances/${address}`);
  return body.balances ?? [];
}

export interface BmeInfo {
  /** Minimum mint output in uact, or null when params carry no uact floor. */
  min_mint_uact: string | null;
  /** On-chain conversion spread, basis points (params.mint_spread_bps). */
  mint_spread_bps: number;
  /** Circuit breaker: false when ACT mints are currently halted. */
  mints_allowed: boolean;
}

/**
 * BME module params + circuit-breaker status. Returns null when the network
 * has no BME module (e.g. the Akash sandbox, where deployments pay uakt).
 */
export async function fetchBmeInfo(rest: string): Promise<BmeInfo | null> {
  let params: any;
  try {
    params = (await getJson(rest, "/akash/bme/v1/params")).params;
  } catch {
    return null;
  }
  const minMint: Coin[] = params?.min_mint ?? [];
  const uact = minMint.find((c) => c.denom === "uact");
  let mintsAllowed = true;
  try {
    mintsAllowed = (await getJson(rest, "/akash/bme/v1/status")).mints_allowed !== false;
  } catch {
    // status endpoint unavailable → assume healthy, the chain enforces anyway
  }
  return {
    min_mint_uact: uact?.amount ?? null,
    mint_spread_bps: Number(params?.mint_spread_bps ?? 0),
    mints_allowed: mintsAllowed,
  };
}

/** Friendly text for LedgerCanceledRecord.BMCancelReason enum names. */
export const BME_CANCEL_REASONS: Record<string, string> = {
  epsilon: "conversion result was below the smallest representable amount",
  zero_price: "the oracle price was zero",
  insufficient_funds: "the BME vault had insufficient funds",
  invalid_denom: "the denom is not registered with the BME module",
  invalid_amount: "the burn amount was zero or invalid",
  minimum_mint: "the mint output was below the network's minimum mint",
  mint_failed: "the mint operation failed on-chain",
  burn_failed: "the burn operation failed on-chain",
  max_attempts: "settlement exceeded the maximum processing attempts",
};

export interface BmeLedgerSummary {
  /** Records still awaiting settlement. */
  pending: number;
  /** Status of the newest record: pending | executed | canceled | null (none). */
  last_status: string | null;
  /** Cancel reason (enum name, see BME_CANCEL_REASONS) when the newest record was canceled. */
  last_cancel_reason: string | null;
  /** Minted uact of the newest record when it executed. */
  last_minted_uact: string | null;
}

/** This wallet's mint/burn ledger records, condensed for the UI. */
export async function fetchBmeLedger(rest: string, address: string): Promise<BmeLedgerSummary> {
  // status is filtered client-side, matching console-air — the LCD filter
  // expects the raw enum encoding
  const body = await getJson(
    rest,
    `/akash/bme/v1/ledger?filters.source=${address}&pagination.limit=50`,
  );
  const records: any[] = body.records ?? [];
  const pending = records.filter((r) => r.status === "ledger_record_status_pending").length;
  const newest = records
    .slice()
    .sort((a, b) => Number(b.id?.height ?? 0) - Number(a.id?.height ?? 0))[0];
  return {
    pending,
    last_status: newest?.status?.replace("ledger_record_status_", "") ?? null,
    last_cancel_reason: newest?.canceled_record?.cancel_reason ?? null,
    last_minted_uact: newest?.executed_record?.minted?.coin?.amount ?? null,
  };
}

/**
 * AKT market price in USD — ACT is USD-pegged (1 ACT = $1), so this doubles
 * as the AKT→ACT estimate rate, exactly like console-air's UI estimate. The
 * chain applies the real oracle rate at settlement; this is display/gating
 * only. Returns null when the price API is unreachable.
 */
export async function fetchAktUsdPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=akash-network&vs_currencies=usd",
    );
    if (!res.ok) return null;
    const price = (await res.json())?.["akash-network"]?.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null;
  }
}
