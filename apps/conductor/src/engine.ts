import path from "node:path";
import fs from "node:fs";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import type { Msg } from "./akash/messages.js";
import type { Services } from "./services.js";

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

export interface StepCtx {
  launchId: string;
  spec: LaunchSpec;
  dirs: LaunchDirs;
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
}

export interface StepDef {
  name: string;
  run(ctx: StepCtx): Promise<unknown>;
}

export interface RunResult {
  status: "completed" | "paused" | "awaiting-signature" | "awaiting-user";
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
  db.setLaunchStatus(launchId, "running");

  const ctx: StepCtx = {
    launchId,
    spec,
    dirs,
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
  };

  for (const step of steps) {
    const existing = db.getStep(launchId, step.name);
    if (existing?.status === "done") {
      continue;
    }
    log(`run ${step.name}`);
    db.stepStarted(launchId, step.name);
    try {
      const output = await step.run(ctx);
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
      const message = cause instanceof Error ? cause.message : String(cause);
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

/**
 * Headless driver (M2): auto-signs every pending tx with the given signer
 * and resumes until the launch completes, fails, or needs the user.
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
): Promise<RunResult> {
  for (;;) {
    const result = await runLaunch(db, launchId, spec, workRoot, steps, services, log);
    if (result.status !== "awaiting-signature") return result;
    const pending = db.nextPendingTx(launchId);
    if (!pending) throw new Error("awaiting-signature with no pending tx");
    const txHash = await signer.sign(JSON.parse(pending.msgs_json));
    db.setPendingTxSigned(launchId, pending.step, txHash);
  }
}
