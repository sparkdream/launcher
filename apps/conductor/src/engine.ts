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

/** Thrown by a step to pause the launch until the browser/CLI signs. */
export class AwaitSignature extends Error {
  constructor(readonly step: string) {
    super(`awaiting signature for step ${step}`);
  }
}

/** Thrown by a step to pause for non-signature user action (DNS, tmkms). */
export class AwaitUser extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

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

  for (const step of steps) {
    const existing = db.getStep(launchId, step.name);
    if (existing?.status === "done") {
      continue;
    }
    log(`run ${step.name}`);
    db.stepStarted(launchId, step.name);
    try {
      // §13: every step runs inside this launch's chain-assets context so
      // sparkdreamd()/vendorDir() resolve the per-version binary and deploy
      // data. Null (nothing resolved yet — before prepare-chain-assets
      // materializes, or a pre-M9 launch) falls through to baked behavior.
      const output = await runWithAssets(resolveChainAssets(spec, workRoot), () => step.run(ctx));
      db.stepDone(launchId, step.name, output);
    } catch (cause) {
      if (cause instanceof AwaitSignature) {
        db.stepWaiting(launchId, step.name, "awaiting signature");
        db.setLaunchStatus(launchId, "paused");
        return { status: "awaiting-signature", failedStep: step.name };
      }
      if (cause instanceof AwaitUser) {
        db.stepWaiting(launchId, step.name, cause.reason);
        db.setLaunchStatus(launchId, "paused");
        return { status: "awaiting-user", failedStep: step.name, reason: cause.reason };
      }
      if (cause instanceof AwaitGentx) {
        db.stepWaiting(launchId, step.name, `awaiting gentx for validator ${cause.valIndex}`);
        db.setLaunchStatus(launchId, "paused");
        return { status: "awaiting-gentx", failedStep: step.name };
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
