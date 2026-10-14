import fs from "node:fs";
import path from "node:path";
import { fleetBridge, type LaunchSpec } from "@sparkdream/launch-spec";
import { BRIDGE_OPERATOR, readBridgeOperatorAddress } from "./components/mastodon-secrets.js";
import { SCANNER_OPERATOR, readScannerOperatorAddress } from "./components/scanner-secrets.js";
import type { StepCtx } from "./engine.js";
import { fleetActor, sendTx, type ChainActor } from "./peering.js";
import { queryJson } from "./steps/phase-g.js";

/**
 * Pay for the daemons (§5 operator pay). A council pays a launcher-held
 * operator (the scanner's, the bridge's) through a recurring payment: an
 * x/session RecurringPull grant the council schedules with
 * MsgScheduleRecurringSpend. Each period has to be claimed by the grantee
 * itself (claims are not session-delegable), and only the launcher holds
 * that key, so the launcher claims: the monitor looks hourly for a payment
 * that has come due and queues a "claims" op, which signs
 * MsgClaimRecurringPull locally. A missed period is not lost (each claim
 * advances the schedule by one period), so claims catch up, a batch per run
 * within the grant's per-day ceiling.
 *
 * A claim the chain refuses (the council's term lapsed, its daily cap is
 * spent, its treasury is empty) costs a fee, so the grant is left alone for
 * a day before it is tried again.
 */

/** Most claims one tx batches (sparkdream-ui's MAX_CLAIMS_PER_TX). */
const MAX_CLAIMS_PER_TX = 10;
/** Gas per claim in a batch (a bank send plus the grant update and hooks). */
const CLAIM_GAS = 200_000;
/** How long a refused grant is left alone. */
const BACKOFF_MS = 24 * 3_600_000;

const FAILURES_FILE = "pay-claims.json";

/** A launcher-held account a council may pay. */
export interface Claimant {
  /** Keyring name in val-0's keyring. */
  key: string;
  address: string;
}

/** The fleet's launcher-held operators: the ones the launcher can claim for. */
export function payClaimants(spec: LaunchSpec, secretsDir: string): Claimant[] {
  const out: Claimant[] = [];
  const scanner = spec.topology.components.scanner?.enabled ? readScannerOperatorAddress(secretsDir) : undefined;
  if (scanner) out.push({ key: SCANNER_OPERATOR, address: scanner });
  const bridge = fleetBridge(spec) ? readBridgeOperatorAddress(secretsDir) : undefined;
  if (bridge) out.push({ key: BRIDGE_OPERATOR, address: bridge });
  return out;
}

/** A RecurringPull grant as the CLI prints it (int64s as strings). */
export interface PayGrant {
  id: string;
  granter: string;
  grantee: string;
  type: string;
  status: string;
  expires_at: string;
  note?: string;
  recurring_pull?: {
    amount_per_period?: { denom: string; amount: string };
    period_seconds?: string;
    last_claim_advance?: string;
    max_per_epoch?: string;
  };
}

const num = (s: string | undefined): number => {
  const n = parseInt(s ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
};

/** Periods claimable now, catch-up included (the chain's rule: claim k opens
 *  at last_claim_advance + k·period and must not pass expires_at). */
export function claimableNow(g: PayGrant, nowSec: number): number {
  const rp = g.recurring_pull;
  const period = num(rp?.period_seconds);
  const live = g.status === "GRANT_STATUS_ACTIVE" || g.status === "GRANT_STATUS_PAUSED_INSUFFICIENT_FUNDS";
  if (!rp || period <= 0 || !live) return 0;
  const last = num(rp.last_claim_advance);
  const expires = Math.floor(Date.parse(g.expires_at) / 1000);
  const due = Math.floor((nowSec - last) / period);
  const left = Number.isFinite(expires) ? Math.floor((expires - last) / period) : due;
  return Math.max(0, Math.min(due, left));
}

/** Claims for one tx: what is due, within the grant's per-day ceiling. */
export function claimBatch(g: PayGrant, nowSec: number): number {
  const due = claimableNow(g, nowSec);
  let amount = 0n;
  let perDay = 0n;
  try {
    amount = BigInt(g.recurring_pull?.amount_per_period?.amount ?? "0");
    perDay = BigInt(g.recurring_pull?.max_per_epoch ?? "0");
  } catch {
    // unreadable: one at a time
  }
  const byCeiling = amount > 0n && perDay > 0n ? Number(perDay / amount) : 1;
  return Math.max(0, Math.min(due, byCeiling || 1, MAX_CLAIMS_PER_TX));
}

function readFailures(secretsDir: string): Record<string, number> {
  const file = path.join(secretsDir, FAILURES_FILE);
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeFailures(secretsDir: string, failures: Record<string, number>): void {
  fs.writeFileSync(path.join(secretsDir, FAILURES_FILE), JSON.stringify(failures, null, 2));
}

/** A due payment: which account claims which grant, how many periods now. */
export interface DueClaim {
  claimant: Claimant;
  grant: PayGrant;
  count: number;
}

/** Recurring payments to the claimants that can be claimed now. */
export async function dueClaims(rpc: string, claimants: Claimant[], secretsDir: string, now = Date.now()): Promise<DueClaim[]> {
  const failures = readFailures(secretsDir);
  const out: DueClaim[] = [];
  for (const claimant of claimants) {
    const res = await queryJson(["query", "session", "grants-by-grantee", claimant.address], rpc);
    for (const grant of (res.grants ?? []) as PayGrant[]) {
      if (grant.type !== "GRANT_TYPE_RECURRING_PULL" || grant.grantee !== claimant.address) continue;
      if (now - (failures[grant.id] ?? 0) < BACKOFF_MS) continue;
      const count = claimBatch(grant, Math.floor(now / 1000));
      if (count > 0) out.push({ claimant, grant, count });
    }
  }
  return out;
}

export interface ClaimOutcome {
  grantId: string;
  claimant: string;
  claimed: number;
  amount?: string;
  error?: string;
}

/** The "claims" op body: claim every payment due, as its grantee. */
export async function claimPayments(ctx: StepCtx, spec: LaunchSpec): Promise<ClaimOutcome[]> {
  const chain = await fleetActor(ctx, ctx.launchId, "this fleet");
  const due = await dueClaims(chain.rpc, payClaimants(spec, ctx.dirs.secrets), ctx.dirs.secrets);
  const failures = readFailures(ctx.dirs.secrets);
  const out: ClaimOutcome[] = [];
  for (const { claimant, grant, count } of due) {
    const signer: ChainActor = { ...chain, signer: { home: ctx.dirs.node("val-0"), key: claimant.key, address: claimant.address } };
    const msgs = Array.from({ length: count }, () => ({
      "@type": "/sparkdream.session.v1.MsgClaimRecurringPull",
      grantee: claimant.address,
      grant_id: grant.id,
    }));
    const coin = grant.recurring_pull?.amount_per_period;
    const amount = coin ? `${BigInt(coin.amount) * BigInt(count)}${coin.denom}` : undefined;
    try {
      await sendTx(ctx, signer, `${chain.chainId}-claim-${grant.id}-${Date.now()}`, msgs, { gas: CLAIM_GAS * count });
      delete failures[grant.id];
      ctx.log(`pay: ${claimant.key} claimed ${count} period(s) of payment #${grant.id} from ${grant.granter}${amount ? ` (${amount})` : ""}`);
      out.push({ grantId: grant.id, claimant: claimant.address, claimed: count, ...(amount ? { amount } : {}) });
    } catch (e) {
      failures[grant.id] = Date.now();
      const error = String(e instanceof Error ? e.message : e);
      ctx.log(`pay: claim of payment #${grant.id} for ${claimant.key} refused, retrying in a day: ${error}`);
      out.push({ grantId: grant.id, claimant: claimant.address, claimed: 0, error });
    }
  }
  writeFailures(ctx.dirs.secrets, failures);
  return out;
}
