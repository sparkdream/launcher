import path from "node:path";
import fs from "node:fs";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import type { Msg } from "./akash/messages.js";
import type { Services } from "./services.js";
import { resolveChainAssets, runWithAssets } from "./chain-assets/index.js";

export interface LaunchDirs {
  /** Root of this launch's workspace. */
  root: string;
  /** Per-node sparkdreamd homes: nodes/<key>. */
  node(key: string): string;
  /** Rendered SDLs: sdl/<key>.yaml. */
  sdl: string;
  /** Packaged node-data tarballs. */
  bundles: string;
  /** Launch-scoped secrets (SSH/age keys) until moved into the encrypted db (M6). */
  secrets: string;
}

export function launchDirs(workRoot: string, launchId: string): LaunchDirs {
  const root = path.join(workRoot, "launches", launchId);
  return {
    root,
    node: (key) => path.join(root, "nodes", key),
    sdl: path.join(root, "sdl"),
    bundles: path.join(root, "bundles"),
    secrets: path.join(root, "secrets"),
  };
}

/**
 * Proto-JSON bytes must be base64 STRINGS, never raw byte arrays. Msgs are
 * persisted here with JSON.stringify, which turns a Uint8Array into
 * {"0":5,"1":179,...} without complaining; the browser then decodes it with
 * atob (packages/akash-tx), where that object coerces to "[object Object]"
 * and throws a bare DOM "InvalidCharacterError: String contains an invalid
 * character" at Keplr signing time, naming neither the field nor the step.
 * The CLI path hides the same mistake behind Buffer.from's lenient parsing.
 * So reject it at enqueue, where the offending field can still be named.
 */
function assertBytesAreBase64(msgs: Msg[], stepName: string): void {
  const walk = (v: unknown, at: string): void => {
    if (ArrayBuffer.isView(v)) {
      throw new Error(
        `${stepName}: msg field ${at} is raw bytes; proto-JSON needs a base64 string. ` +
          `Wrap it in Buffer.from(x).toString("base64")`,
      );
    }
    if (Array.isArray(v)) {
      v.forEach((e, i) => walk(e, `${at}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, e] of Object.entries(v)) walk(e, `${at}.${k}`);
    }
  };
  msgs.forEach((m, i) => walk(m.value, `msgs[${i}] (${m.typeUrl})`));
}

/** Thrown by a step to pause the launch until the browser/CLI signs. */
export class AwaitSignature extends Error {
  constructor(readonly step: string) {
    super(`awaiting signature for step ${step}`);
  }
}

/** Thrown by a step to pause for non-signature user action (DNS, tmkms). */
/**
 * A transaction a user's own wallet must sign on a fleet's chain (§5
 * wallet-signed pauses): the launcher holds no key that may send it, so the
 * web UI connects the wallet, fills in its address and broadcasts. The step
 * re-checks the chain when resumed, so nothing is taken on trust.
 */
export interface WalletRequest {
  /** One line on what the signature authorizes, for the pause card. */
  title: string;
  chain: {
    chainId: string;
    chainName: string;
    /** CometBFT RPC and LCD the browser reaches (the fleet's public ones). */
    rpc: string;
    rest?: string;
    bech32Prefix: string;
    denom: string;
    displayDenom: string;
    decimals: number;
    gasPrice: number;
  };
  /** Who may sign ("an Operations Committee member", "any funded account"). */
  signerRole: string;
  /** The one address that must sign, when it matters who (a member bonding
   *  or granting from its own account). The messages carry it literally, so
   *  another account's signature would be rejected by the chain anyway: the
   *  pause card checks first and asks to switch accounts. */
  signer?: string;
  /** Messages as proto-JSON ("@type" + proto field names), for display and
   *  the CLI route. */
  msgs: unknown[];
  /** The same messages as protobuf Anys (base64 value), encoded by the
   *  chain's own binary so enums, nested messages and every field come out
   *  exactly as the chain parses them. Every string equal to WALLET_SIGNER
   *  in a decoded message is the connected wallet's address. */
  encoded: Array<{ typeUrl: string; value: string }>;
  /** Gas limit for the tx; the wallet simulates when unset. */
  gas?: number;
  /** A fee floor the chain enforces beyond gas (commons proposal_fee). */
  minFee?: { denom: string; amount: string };
  /** Equivalent CLI commands, for a key kept outside a browser wallet. */
  cli?: string;
}

/** Placeholder for the signing wallet's address in WalletRequest.msgs. */
export const WALLET_SIGNER = "<signer>";

export class AwaitUser extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
    readonly wallet?: WalletRequest,
    /** Accounts to send money to (relayer keys), one row each, so the pause
     *  card can offer a copy button and a wallet send per row. */
    readonly funding?: unknown[],
    /** A federation peer's remaining setup on a chain whose committee key the
     *  launcher does not hold: the ways to finish it elsewhere (CLI script,
     *  the chain's frontend) and what the monitor watches to resume by
     *  itself (peering.ts PeerSetup). */
    readonly peerSetup?: unknown,
  ) {
    super(reason);
  }
}

/**
 * Thrown by a step that found its earlier steps' result unusable (a
 * placement on a provider whose ingress serves nothing): the engine forgets
 * `steps` (the thrower included, when listed) and runs the plan again from
 * the top in the same drive, so the re-placement goes on without a resume.
 */
export class RerunFrom extends Error {
  constructor(
    readonly steps: string[],
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * Thrown from an op step's sleep once the op has been aborted, so a step
 * polling a node (a restore, a sync, a health wait) unwinds at its next poll
 * instead of holding the drive, and every op queued behind it, for hours.
 */
class OpAbortedWhileRunning extends Error {}

/** Reruns one drive allows before it gives up (each is a re-placement). */
const MAX_RERUNS = 6;

/** Thrown by build-genesis to pause for an external-operator gentx (§5 3b). */
export class AwaitGentx extends Error {
  constructor(readonly valIndex: number) {
    super(`awaiting gentx signature for validator ${valIndex}`);
  }
}

export interface StepCtx {
  launchId: string;
  spec: LaunchSpec;
  dirs: LaunchDirs;
  /** DATA_DIR root — launch workspaces and the chain-asset cache live under it. */
  workRoot: string;
  db: ConductorDb;
  services: Services;
  log: (message: string) => void;
  /** Output of an earlier, completed step. */
  output<T>(stepName: string): T | undefined;
  /**
   * Signing loop (§8): returns the confirmed tx hash, or throws
   * AwaitSignature until the tx is signed & confirmed on-chain.
   */
  requireTx(stepName: string, msgs: Msg[]): Promise<string>;
  /**
   * Gentx loop (§5 3b): returns the wallet's raw sign response for this
   * validator, or throws AwaitGentx. The CALLER verifies the signature and
   * calls db.resetGentx + throws if it doesn't hold up.
   */
  requireGentx(valIndex: number, address: string, signDocJson: string): string;
}

export interface StepDef {
  name: string;
  run(ctx: StepCtx): Promise<unknown>;
}

export interface RunResult {
  status: "completed" | "paused" | "awaiting-signature" | "awaiting-gentx" | "awaiting-user";
  failedStep?: string;
  reason?: string;
}

/**
 * Execute steps in order with checkpointing (§5): done steps skip, failures
 * pause, AwaitSignature/AwaitUser park the step as 'waiting'. Re-run resumes.
 */
/**
 * Drop failed step rows that are no longer in the plan. Such a step never
 * runs again (a finished op rebuilt without it), so its error would stay on
 * the panel, and count as an unfinished step, for good. `steps` must be the
 * whole plan, as every drive passes. Returns how many were dropped.
 */
export function dropStaleFailures(
  db: ConductorDb,
  launchId: string,
  steps: StepDef[],
  log: (message: string) => void = () => {},
): number {
  const planned = new Set(steps.map((s) => s.name));
  let dropped = 0;
  for (const row of db.listSteps(launchId)) {
    if (row.status === "error" && !planned.has(row.name)) {
      db.resetStep(launchId, row.name);
      log(`dropped ${row.name}: it failed, and is no longer part of the plan`);
      dropped++;
    }
  }
  return dropped;
}

export async function runLaunch(
  db: ConductorDb,
  launchId: string,
  spec: LaunchSpec,
  workRoot: string,
  steps: StepDef[],
  services: Services,
  log: (message: string) => void = () => {},
): Promise<RunResult> {
  const dirs = launchDirs(workRoot, launchId);
  fs.mkdirSync(dirs.root, { recursive: true });
  // a previous driver may have died mid-step (restart/crash), leaving a row
  // stuck at 'running' that the UI renders as a spinner forever — and which
  // hides the earlier step actually holding the launch up
  const orphaned = db.clearOrphanedRunningSteps(launchId);
  if (orphaned > 0) log(`cleared ${orphaned} orphaned running step(s) from a previous driver`);
  dropStaleFailures(db, launchId, steps, log);
  db.setLaunchStatus(launchId, "running");

  const ctx: StepCtx = {
    launchId,
    spec,
    dirs,
    workRoot,
    db,
    services,
    log,
    output: (name) => db.stepOutput(launchId, name),
    requireTx: async (stepName, msgs) => {
      assertBytesAreBase64(msgs, stepName);
      const row = db.getPendingTx(launchId, stepName);
      if (!row) {
        db.enqueuePendingTx(launchId, stepName, JSON.stringify(msgs));
        throw new AwaitSignature(stepName);
      }
      if (row.status === "confirmed") return row.tx_hash!;
      if (row.status === "pending" || row.status === "failed") {
        // nothing signed yet — steps regenerate msgs deterministically
        // (pinnedValue), so drift means the code producing them changed
        // since the tx was enqueued; refresh so the user doesn't keep
        // re-signing a stale (possibly invalid) payload
        const msgsJson = JSON.stringify(msgs);
        if (row.msgs_json !== msgsJson) db.updatePendingTxMsgs(launchId, stepName, msgsJson);
        throw new AwaitSignature(stepName);
      }
      // signed → verify on-chain
      const status = await services.api.txStatus(row.tx_hash!);
      if (status === "confirmed") {
        db.setPendingTxStatus(launchId, stepName, "confirmed");
        return row.tx_hash!;
      }
      if (status === "pending") throw new AwaitSignature(stepName);
      // failed on-chain: require a fresh signature
      db.setPendingTxStatus(launchId, stepName, "pending");
      throw new Error(`tx ${row.tx_hash} failed on-chain for step ${stepName}; re-sign required`);
    },
    requireGentx: (valIndex, address, signDocJson) => {
      const row = db.getPendingGentx(launchId, valIndex);
      if (!row) {
        db.enqueuePendingGentx(launchId, valIndex, address, signDocJson);
        throw new AwaitGentx(valIndex);
      }
      if (row.status !== "signed" || !row.response_json) {
        // doc drift mirrors requireTx's msgs refresh: genesis gentx docs are
        // deterministic (no-op), but promote-validator docs carry the live
        // account sequence — after a broadcast failure the caller resets the
        // row and rebuilds the doc, and the wallet must be served the fresh
        // one or it re-signs a stale sequence forever
        if (row.sign_doc_json !== signDocJson) {
          db.updatePendingGentxDoc(launchId, valIndex, signDocJson);
        }
        throw new AwaitGentx(valIndex);
      }
      return row.response_json;
    },
  };

  // The step list is fixed for the whole drive, so an op aborted while the
  // drive runs still has its remaining steps in it: skip them, and leave no
  // row behind for one that was mid-run when the abort came (its inputs are
  // gone, and a failed row would surface as the launch's error).
  const abortedOp = (name: string): number | undefined => {
    const m = /^op(\d+):/.exec(name);
    if (!m) return undefined;
    const op = db.listFleetOps(launchId).find((o) => o.id === Number(m[1]));
    return op?.status === "aborted" ? op.id : undefined;
  };
  let reruns = 0;
  pass: for (;;) {
    for (const step of steps) {
      const existing = db.getStep(launchId, step.name);
      if (existing?.status === "done") {
        continue;
      }
      if (abortedOp(step.name) !== undefined) continue;
      log(`run ${step.name}`);
      db.stepStarted(launchId, step.name);
      // abort only flips the op's row; the step itself learns of it here
      const stepCtx: StepCtx = /^op\d+:/.test(step.name)
        ? {
            ...ctx,
            services: {
              ...services,
              sleep: async (ms: number) => {
                await services.sleep(ms);
                if (abortedOp(step.name) !== undefined) throw new OpAbortedWhileRunning(step.name);
              },
            },
          }
        : ctx;
      try {
        // §13: every step runs inside this launch's chain-assets context so
        // sparkdreamd()/vendorDir() resolve the per-version binary and deploy
        // data. Null (nothing resolved yet — before prepare-chain-assets
        // materializes, or a pre-M9 launch) falls through to baked behavior.
        const output = await runWithAssets(resolveChainAssets(spec, workRoot), () => step.run(stepCtx));
        const gone = abortedOp(step.name);
        if (gone !== undefined) {
          db.deleteOpSteps(launchId, gone);
          continue;
        }
        db.stepDone(launchId, step.name, output);
      } catch (cause) {
        const gone = abortedOp(step.name);
        if (gone !== undefined) {
          db.deleteOpSteps(launchId, gone);
          log(`${step.name} stopped: its operation was aborted`);
          continue;
        }
        if (cause instanceof AwaitSignature) {
          db.stepWaiting(launchId, step.name, "awaiting signature");
          db.setLaunchStatus(launchId, "paused");
          return { status: "awaiting-signature", failedStep: step.name };
        }
        if (cause instanceof AwaitUser) {
          // a pause with funding rows stores both under one object; one with a
          // wallet request only keeps the bare WalletRequest it always stored
          db.stepWaiting(
            launchId,
            step.name,
            cause.reason,
            cause.funding?.length || cause.peerSetup
              ? {
                  wallet: cause.wallet,
                  ...(cause.funding?.length ? { funding: cause.funding } : {}),
                  ...(cause.peerSetup ? { peerSetup: cause.peerSetup } : {}),
                }
              : cause.wallet,
          );
          db.setLaunchStatus(launchId, "paused");
          return { status: "awaiting-user", failedStep: step.name, reason: cause.reason };
        }
        if (cause instanceof AwaitGentx) {
          db.stepWaiting(launchId, step.name, `awaiting gentx for validator ${cause.valIndex}`);
          db.setLaunchStatus(launchId, "paused");
          return { status: "awaiting-gentx", failedStep: step.name };
        }
        if (cause instanceof RerunFrom && reruns < MAX_RERUNS) {
          reruns++;
          for (const name of cause.steps) db.resetStep(launchId, name);
          db.resetStep(launchId, step.name);
          log(`${step.name}: ${cause.message}; running the plan again from ${cause.steps[0] ?? step.name}`);
          continue pass;
        }
        // some libraries throw Errors with EMPTY messages — fall back to the
        // error name + first stack frame so the UI never shows a blank banner
        const message =
          cause instanceof Error
            ? cause.message ||
              `${cause.name || "Error"} (no message): ${(cause.stack ?? "").split("\n")[1]?.trim() ?? "no stack"}`
            : String(cause);
        db.stepFailed(launchId, step.name, message);
        db.setLaunchStatus(launchId, "paused");
        log(`pause at ${step.name}: ${message}`);
        return { status: "paused", failedStep: step.name };
      }
    }
    break;
  }

  db.setLaunchStatus(launchId, "completed");
  return { status: "completed" };
}

export interface Signer {
  /** Sign & broadcast; returns the tx hash. (Browser Keplr in M4; CLI signer in M2.) */
  sign(msgs: Msg[]): Promise<string>;
}

export interface GentxSigner {
  /** Amino-sign a gentx sign doc; returns the AminoSignResponse JSON. */
  signGentx(signDocJson: string, address: string): Promise<string>;
}

/**
 * Headless driver (M2): auto-signs every pending tx (and gentx, when a
 * gentx signer is provided) and resumes until the launch completes, fails,
 * or needs the user.
 */
export async function runWithSigner(
  db: ConductorDb,
  launchId: string,
  spec: LaunchSpec,
  workRoot: string,
  steps: StepDef[],
  services: Services,
  signer: Signer,
  log?: (message: string) => void,
  gentxSigner?: GentxSigner,
): Promise<RunResult> {
  for (;;) {
    const result = await runLaunch(db, launchId, spec, workRoot, steps, services, log);
    if (result.status === "awaiting-signature") {
      const pending = db.nextPendingTx(launchId);
      if (!pending) throw new Error("awaiting-signature with no pending tx");
      const txHash = await signer.sign(JSON.parse(pending.msgs_json));
      db.setPendingTxSigned(launchId, pending.step, txHash);
      continue;
    }
    if (result.status === "awaiting-gentx" && gentxSigner) {
      const pending = db.nextPendingGentx(launchId);
      if (!pending) throw new Error("awaiting-gentx with no pending gentx");
      const response = await gentxSigner.signGentx(pending.sign_doc_json, pending.address);
      db.setGentxSigned(launchId, pending.val_index, response);
      continue;
    }
    return result;
  }
}
