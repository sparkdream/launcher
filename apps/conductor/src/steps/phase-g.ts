import fs from "node:fs";
import path from "node:path";
import { chainId } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { sparkdreamd } from "../exec.js";
import { commissionFlags } from "../genesis-params.js";
import {
  assembleGentxJson,
  buildCreateValidatorSignDoc,
  valoperAddress,
  verifySignedDoc,
  type GentxInputs,
  type GentxSignResponse,
} from "../gentx.js";
import { nodeRpcUrl, nodeTarget, type Assignments, type DeploymentPlan } from "./phase-bcd.js";
import type { GenerateKeysOutput } from "./phase-a.js";

/**
 * Phase G — promote-validator (§5 "Join mode"). Join-mode only; every step
 * no-ops on ordinary launches (whose validators bonded at genesis). The
 * joined pair is a synced full-node deployment by Phase F; these steps turn
 * it into a bonded validator:
 *   await-funds       pause until each operator account holds the stake
 *   create-validators MsgCreateValidator per validator (keyring or wallet)
 *   verify-bonded     the validator enters the set
 * Stopping after Phase F (aborting here) leaves a valid sovereign RPC/full-
 * node deployment — promotion is optional by design.
 */

/** Gas budget for MsgCreateValidator (heavier than a bank send). */
const CREATE_VALIDATOR_GAS = 400_000;

function bondDenom(ctx: StepCtx): string {
  return ctx.spec.token.bondDenom ?? ctx.spec.token.baseDenom;
}

/** Fee the operator pays for the create-validator tx, in baseDenom. */
export function promoteFee(ctx: StepCtx): { amount: string; denom: string } {
  const amount = Math.ceil(Number(ctx.spec.token.minGasPrice) * CREATE_VALIDATOR_GAS);
  return { amount: String(amount), denom: ctx.spec.token.baseDenom };
}

/** The joiner's own sentry-0 RPC — every chain query and broadcast goes here. */
async function ownRpcUrl(ctx: StepCtx): Promise<string> {
  const assignments = ctx.output<Assignments>("collect-bids")!;
  const plan = ctx.output<DeploymentPlan>("create-deployments")!;
  const a = assignments.perNode["sentry-0"]!;
  return nodeRpcUrl(ctx, a.hostUri, plan.perNode["sentry-0"]!.dseq, a.gseq, a.oseq);
}

function keysOutput(ctx: StepCtx): GenerateKeysOutput {
  const keys = ctx.output<GenerateKeysOutput>("generate-keys");
  if (!keys) throw new Error("generate-keys output missing");
  return keys;
}

export async function queryJson(args: string[], rpc: string): Promise<any> {
  const { stdout } = await sparkdreamd([...args, "--node", rpc, "--output", "json"]);
  return JSON.parse(stdout);
}

/**
 * Bond gate: verify-bonded can only see the chain-side bond — a validator
 * whose NODE is still catching up (or was just restarted by persist-start's
 * manifest push) enters the active set signing nothing and is downtime-
 * jailed within the first signed-blocks window (observed on the first
 * devnet join: bonded 20:35:36, jailed 20:37:21, zero blocks signed). The
 * start-chain sync check is minutes stale by now — await-funds pauses for
 * arbitrarily long — so re-verify the node is AT THE HEAD right before the
 * bond, not merely that it was synced once.
 */
async function awaitValidatorAtHead(ctx: StepCtx, v: number, rpc: string): Promise<number> {
  const key = `val-${v}`;
  let lastProblem = "no probe yet";
  for (let i = 0; i < 60; i++) {
    if (i > 0) await ctx.services.sleep(5000);
    let head: number;
    try {
      head = (await ctx.services.rpc.status(rpc)).latestBlockHeight;
    } catch (e) {
      lastProblem = `sentry rpc unreachable (${String(e).slice(0, 80)})`;
      continue;
    }
    // validators expose no public RPC — probe localhost over SSH, exactly
    // like the start-chain sync gate
    const probe = await ctx.services.ssh.exec(
      nodeTarget(ctx, key),
      "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true",
      { quick: true },
    );
    const height = Number(/latest_block_height"?\s*:\s*"?(\d+)/.exec(probe.stdout)?.[1]);
    const catchingUp = /catching_up"?\s*:\s*"?(\w+)/.exec(probe.stdout)?.[1] === "true";
    if (Number.isFinite(height) && !catchingUp && height >= head - 3) {
      ctx.log(`${key}: at the chain head (${height}/${head}) — safe to bond`);
      return height;
    }
    lastProblem = Number.isFinite(height)
      ? `${catchingUp ? "catching up " : ""}at height ${height}, chain head ${head}`
      : "local RPC not answering";
  }
  throw new Error(
    `${key} is not at the chain head after ~5 min (${lastProblem}) — bonding it now ` +
      "would downtime-jail it as soon as it enters the set. Fix the node, then resume.",
  );
}

/** Does the operator's valoper address already exist in the validator set machinery? */
async function validatorExists(ctx: StepCtx, rpc: string, operator: string): Promise<boolean> {
  try {
    await queryJson(["query", "staking", "validator", valoperAddress(operator)], rpc);
    return true;
  } catch (e) {
    // only the CLI's actual not-found means "not promoted yet". This check
    // is the sole idempotency guard on re-run: mapping a transient RPC
    // failure to false re-broadcasts MsgCreateValidator for a bonded
    // validator, which burns its fee in DeliverTx ("validator already
    // exist") or demands a pointless wallet signature
    if (/not found/i.test(String(e))) return false;
    throw e;
  }
}

async function bankBalance(ctx: StepCtx, rpc: string, address: string, denom: string): Promise<bigint> {
  const out = await queryJson(["query", "bank", "balances", address], rpc);
  const entry = (out.balances ?? []).find((b: { denom: string }) => b.denom === denom);
  return BigInt(entry?.amount ?? "0");
}

export const awaitFundsStep: StepDef = {
  name: "await-funds",
  async run(ctx) {
    if (!ctx.spec.join) return { skipped: true };
    const keys = keysOutput(ctx);
    const rpc = await ownRpcUrl(ctx);
    const denom = bondDenom(ctx);
    const fee = promoteFee(ctx);
    // stake + fee must be in place before create-validator; fee denom can
    // differ from the bond denom, so state both when they diverge
    const needed = BigInt(ctx.spec.accounts.validatorSelfDelegation);
    const shortfalls: string[] = [];
    const balances: Record<string, string> = {};
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const address = keys.accounts[`op-val-${v}`]!;
      if (await validatorExists(ctx, rpc, address)) continue; // already promoted
      const bond = await bankBalance(ctx, rpc, address, denom);
      const feeBalance =
        fee.denom === denom ? bond : await bankBalance(ctx, rpc, address, fee.denom);
      balances[`op-val-${v}`] = bond.toString();
      const feeShort = fee.denom === denom ? bond < needed + BigInt(fee.amount) : feeBalance < BigInt(fee.amount);
      if (bond < needed || feeShort) {
        shortfalls.push(
          `op-val-${v} (${address}): holds ${bond} ${denom}, needs ${needed} ${denom} self-delegation` +
            ` plus a ${fee.amount} ${fee.denom} fee`,
        );
      }
    }
    if (shortfalls.length > 0) {
      throw new AwaitUser(
        "await-funds",
        "fund the operator account(s) on the live chain (the launcher cannot create stake " +
          "on a chain that already exists):\n" +
          shortfalls.join("\n") +
          "\nThen resume. Aborting here instead leaves a working sentry/full-node deployment.",
      );
    }
    return { balances };
  },
};

/** Fields `tx staking create-validator` reads from its json file (SDK 0.50). */
function validatorJson(ctx: StepCtx, v: number, consensusPubkey: string): string {
  const commission = commissionFlags(ctx.spec);
  return JSON.stringify({
    pubkey: { "@type": "/cosmos.crypto.ed25519.PubKey", key: consensusPubkey },
    amount: `${ctx.spec.accounts.validatorSelfDelegation}${bondDenom(ctx)}`,
    moniker: `${ctx.spec.network.name}-val-${v}`,
    "commission-rate": commission.rate,
    "commission-max-rate": commission.maxRate,
    "commission-max-change-rate": commission.maxChangeRate,
    "min-self-delegation": "1",
  });
}

/** Poll a broadcast tx to inclusion; throws on a non-zero code. */
export async function awaitTxIncluded(ctx: StepCtx, rpc: string, txHash: string): Promise<void> {
  let lastError = "not found";
  for (let i = 0; i < 24; i++) {
    if (i > 0) await ctx.services.sleep(5000);
    try {
      const out = await queryJson(["query", "tx", txHash], rpc);
      const code = Number(out.code ?? 0);
      if (code !== 0) {
        throw new Error(`tx ${txHash} failed on-chain (code ${code}): ${out.raw_log ?? ""}`);
      }
      return;
    } catch (e) {
      lastError = String(e);
      if (/failed on-chain/.test(lastError)) throw e;
    }
  }
  throw new Error(`tx ${txHash} not found after ~2 min: ${lastError}`);
}

/** account_number/sequence for the operator, tolerant of wrapped account types. */
export async function accountCoordinates(
  ctx: StepCtx,
  rpc: string,
  address: string,
): Promise<{ accountNumber: number; sequence: number }> {
  const out = await queryJson(["query", "auth", "account", address], rpc);
  const acct = out.account ?? out;
  const base = acct.base_account ?? acct.base_vesting_account?.base_account ?? acct;
  if (base.account_number === undefined) {
    throw new Error(`cannot read account_number for ${address}: ${JSON.stringify(out).slice(0, 200)}`);
  }
  return { accountNumber: Number(base.account_number), sequence: Number(base.sequence ?? 0) };
}

export const createValidatorsStep: StepDef = {
  name: "create-validators",
  async run(ctx) {
    if (!ctx.spec.join) return { skipped: true };
    const keys = keysOutput(ctx);
    const rpc = await ownRpcUrl(ctx);
    const cid = chainId(ctx.spec);
    const fee = promoteFee(ctx);
    const operators = ctx.spec.topology.validators.operators;
    const master = ctx.dirs.node("val-0");
    const created: string[] = [];

    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const address = keys.accounts[`op-val-${v}`]!;
      if (await validatorExists(ctx, rpc, address)) continue; // idempotent re-run
      // never bond a node that isn't participating in consensus RIGHT NOW —
      // re-checked on every resume (a signature pause can last days)
      await awaitValidatorAtHead(ctx, v, rpc);

      if (!Array.isArray(operators)) {
        // generated operator: the conductor holds the key — sign via the
        // master keyring, exactly like genesis gentxs do (§3)
        const file = path.join(ctx.dirs.root, `create-validator-${v}.json`);
        fs.writeFileSync(file, validatorJson(ctx, v, keys.consensusPubkeys[`val-${v}`]!));
        const { stdout } = await sparkdreamd([
          "tx", "staking", "create-validator", file,
          "--from", `op-val-${v}`,
          "--keyring-backend", "test",
          "--home", master,
          "--chain-id", cid,
          "--node", rpc,
          "--gas", String(CREATE_VALIDATOR_GAS),
          "--fees", `${fee.amount}${fee.denom}`,
          "--yes",
          "--output", "json",
        ]);
        const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
        if (res.code) {
          throw new Error(`create-validator ${v} rejected at broadcast (code ${res.code}): ${res.raw_log ?? ""}`);
        }
        await awaitTxIncluded(ctx, rpc, res.txhash);
        created.push(`val-${v}`);
        continue;
      }

      // external operator: the wallet signs (amino, Ledger-capable) via the
      // gentx signing loop — same UI banner, live coordinates this time
      const coords = await accountCoordinates(ctx, rpc, address);
      const inputs: GentxInputs = {
        spec: ctx.spec,
        valIndex: v,
        operatorAddress: address,
        consensusPubkey: keys.consensusPubkeys[`val-${v}`]!,
        nodeId: "", // no peer memo on a live tx
        chainId: cid,
      };
      const signDoc = buildCreateValidatorSignDoc(inputs, {
        ...coords,
        fee: { amount: [{ denom: fee.denom, amount: fee.amount }], gas: String(CREATE_VALIDATOR_GAS) },
      });
      const responseJson = ctx.requireGentx(v, address, JSON.stringify(signDoc));
      const response = JSON.parse(responseJson) as GentxSignResponse;
      const verdict = await verifySignedDoc(signDoc, response, address);
      if (!verdict.ok) {
        ctx.db.resetGentx(ctx.launchId, v);
        throw new Error(`create-validator signature for validator ${v} rejected: ${verdict.reason}`);
      }
      const txFile = path.join(ctx.dirs.root, `create-validator-${v}.signed.json`);
      fs.writeFileSync(txFile, assembleGentxJson(inputs, response));
      try {
        const { stdout } = await sparkdreamd([
          "tx", "broadcast", txFile, "--node", rpc, "--output", "json",
        ]);
        const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
        if (res.code) {
          throw new Error(`broadcast rejected (code ${res.code}): ${res.raw_log ?? ""}`);
        }
        await awaitTxIncluded(ctx, rpc, res.txhash);
      } catch (e) {
        // a stale sequence (the operator transacted between sign and
        // broadcast) needs a FRESH sign doc — never replay the cached one
        ctx.db.resetGentx(ctx.launchId, v);
        throw e;
      }
      created.push(`val-${v}`);
    }
    return { created };
  },
};

export const verifyBondedStep: StepDef = {
  name: "verify-bonded",
  async run(ctx) {
    if (!ctx.spec.join) return { skipped: true };
    const keys = keysOutput(ctx);
    const rpc = await ownRpcUrl(ctx);
    const bonded: Record<string, string> = {};
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const valoper = valoperAddress(keys.accounts[`op-val-${v}`]!);
      let status = "";
      for (let i = 0; i < 24 && status !== "BOND_STATUS_BONDED"; i++) {
        if (i > 0) await ctx.services.sleep(5000);
        try {
          const out = await queryJson(["query", "staking", "validator", valoper], rpc);
          status = out.validator?.status ?? out.status ?? "";
        } catch {
          status = "";
        }
      }
      if (status !== "BOND_STATUS_BONDED") {
        throw new Error(
          `val-${v} (${valoper}) is ${status || "not found"} after ~2 min: a stake below the ` +
            "active-set cutoff stays unbonded; delegate more or retry once the set has room",
        );
      }
      bonded[`val-${v}`] = valoper;
    }
    return { bonded };
  },
};

/** Blocks of live signing we insist on observing before declaring the
 *  promotion healthy — a quarter of the devnet's 100-block window, reached
 *  well before the jail threshold can. */
const SIGNING_PROBE_BLOCKS = 25;

export const verifySigningStep: StepDef = {
  name: "verify-signing",
  async run(ctx) {
    if (!ctx.spec.join) return { skipped: true };
    // verify-bonded proves the chain accepted the stake; this proves the
    // node is actually SIGNING — the failure mode bonding can't see (a
    // bonded-but-silent validator is downtime-jailed within the window)
    const keys = keysOutput(ctx);
    const rpc = await ownRpcUrl(ctx);
    const observed: Record<string, { signed: number; missed: number }> = {};
    const jailedVals: string[] = [];
    for (let v = 0; v < ctx.spec.topology.validators.count; v++) {
      const valoper = valoperAddress(keys.accounts[`op-val-${v}`]!);
      const pubkeyArg = JSON.stringify({
        "@type": "/cosmos.crypto.ed25519.PubKey",
        key: keys.consensusPubkeys[`val-${v}`]!,
      });
      let baseline: { offset: number; missed: number } | undefined;
      let verdict: { signed: number; missed: number } | undefined;
      let jailed = false;
      let lastProblem = "no signing info yet";
      for (let i = 0; i < 90 && !verdict && !jailed; i++) {
        if (i > 0) await ctx.services.sleep(5000);
        try {
          const out = await queryJson(["query", "staking", "validator", valoper], rpc);
          jailed = Boolean((out.validator ?? out).jailed);
        } catch (e) {
          lastProblem = `validator query failed (${String(e).slice(0, 80)})`;
          continue;
        }
        if (jailed) break;
        let info: any;
        try {
          const out = await queryJson(["query", "slashing", "signing-info", pubkeyArg], rpc);
          info = out.val_signing_info ?? out;
        } catch (e) {
          lastProblem = `signing-info query failed (${String(e).slice(0, 80)})`;
          continue;
        }
        // index_offset advances for every block the validator spends in the
        // active set; missed_blocks_counter for every one it failed to sign
        const offset = Number(info.index_offset ?? 0);
        const missed = Number(info.missed_blocks_counter ?? 0);
        if (!baseline) baseline = { offset, missed };
        const seen = offset - baseline.offset;
        const missedDelta = Math.max(0, missed - baseline.missed);
        if (seen < SIGNING_PROBE_BLOCKS) {
          lastProblem = `observed ${Math.max(0, seen)} of ${SIGNING_PROBE_BLOCKS} blocks`;
          continue;
        }
        if (missedDelta * 2 > seen) {
          throw new Error(
            `val-${v} is bonded but missed ${missedDelta} of the last ${seen} blocks — the ` +
              "node is not signing and will be downtime-jailed; check its sync state and peers",
          );
        }
        verdict = { signed: seen - missedDelta, missed: missedDelta };
      }
      if (jailed) {
        // NOT a step failure: the recovery is the fleet panel's unjail op,
        // and op steps only run once the launch steps are through — a hard
        // error here would block the very op that fixes it. The monitor
        // flags the jailed validator on the fleet card.
        ctx.log(
          `val-${v} is downtime-jailed — its node was not signing while bonded. The launch ` +
            "completes as a full-node deployment; once the node is back at the chain head, " +
            "use the fleet panel's unjail action to re-enter the set.",
        );
        jailedVals.push(`val-${v}`);
        continue;
      }
      if (!verdict) {
        throw new Error(`val-${v}: could not confirm signing after ~7 min (${lastProblem})`);
      }
      ctx.log(
        `val-${v}: signing confirmed (${verdict.signed}/${verdict.signed + verdict.missed} blocks in the probe window)`,
      );
      observed[`val-${v}`] = verdict;
    }
    return jailedVals.length > 0 ? { observed, jailed: jailedVals } : { observed };
  },
};

export function phaseGSteps(): StepDef[] {
  return [awaitFundsStep, createValidatorsStep, verifyBondedStep, verifySigningStep];
}
