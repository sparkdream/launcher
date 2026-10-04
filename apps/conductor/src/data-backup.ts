import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chainId, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow } from "./db.js";
import { AwaitUser, type StepCtx, type StepDef } from "./engine.js";
import { componentRow, rowTarget, refreshSshEndpoints } from "./fleet-ops.js";
import { NODE_HOME, NODE_RUNNING_PROBE } from "./node-ops.js";
import type { SshTarget } from "./services.js";
import { ageIdentityAt, resolveS3Secret } from "./steps/phase-bcd.js";
import type { GenerateKeysOutput } from "./steps/phase-a.js";

/**
 * Chain-data backups (robustness plan step 4). A node's data directory is
 * streamed (tar | zstd | age | s5cmd pipe, nothing written to its disk) to
 * the bucket the fleet's mesh backup already uses, under
 * sparkdream-launcher/<chain-id>/chain-data/, and a relaunched node restores
 * the latest one before its first boot instead of replaying the chain from
 * block 1. Full history is kept: it is the whole data directory, blocks
 * included.
 *
 * The node must be stopped for a consistent copy, and it is PID 1, so the
 * op restarts its container under a "launcher hold" (a deadline file the
 * entrypoint honours by not starting the node) and removes the hold when
 * the upload is done; the deadline brings the node back by itself if the
 * launcher never returns. The source is a sentry other than sentry-0 when
 * the fleet has one, so the public endpoints and the validator's main path
 * stay up. Needs a node image with s5cmd, age, zstd and the hold.
 */

/** Backups kept in the bucket; older ones are deleted after each upload. */
export const DATA_BACKUP_KEEP = 3;
const HOLD_FILE = `${NODE_HOME}/.launcher-hold`;
/** A held node comes back by itself this long after the last refresh. */
const HOLD_SECS = 30 * 60;

export interface DataBackupStorage {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secret: string;
  prefix: string;
}

export interface DataBackupRecord {
  name: string;
  height: number;
  takenAt: string;
  from: string;
  /** sha256 of the genesis the chain ran when it was taken (a reset keeps the chain id) */
  genesisSha?: string;
}

/** sha256 of the fleet's genesis as the launcher holds it (val-0's home, the authority after a reset). */
export function fleetGenesisSha(nodeDir: (key: string) => string): string | undefined {
  const file = path.join(nodeDir("val-0"), "config", "genesis.json");
  if (!fs.existsSync(file)) return undefined;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Op kinds after which older chain data must not be restored. */
const DATA_BREAKING_OPS = new Set(["upgrade", "halt-upgrade", "reset-chain"]);

/**
 * Why a backup must not be restored into this fleet now, or null when it
 * can be: taken on another genesis (a reset since keeps the chain id, so
 * nothing else tells the chains apart), or before an upgrade or reset (the
 * running binary cannot replay the blocks between the backup and the
 * upgrade height).
 */
export function restoreBlocker(
  db: ConductorDb,
  launchId: string,
  nodeDir: (key: string) => string,
  record: DataBackupRecord,
): string | null {
  const sha = fleetGenesisSha(nodeDir);
  if (record.genesisSha && sha && record.genesisSha !== sha) {
    return `${record.name} was taken on a different genesis (the chain was reset since)`;
  }
  const breaking = db
    .listFleetOps(launchId)
    .filter((o) => o.status === "done" && DATA_BREAKING_OPS.has(o.kind) && Date.parse(o.created_at) > Date.parse(record.takenAt));
  if (breaking.length > 0) {
    return `${record.name} predates the fleet's ${breaking[breaking.length - 1]!.kind} (op ${breaking[breaking.length - 1]!.id}): take a new backup`;
  }
  return null;
}

/** Whether relaunched and added nodes start from the latest backup (default on). */
export function autoRestoreEnabled(db: ConductorDb, launchId: string): boolean {
  return db.getSetting(`data-restore-auto:${launchId}`) !== "off";
}

/** The fleet's mesh-backup bucket, reused for chain data; null when it has none. */
export function dataBackupStorage(spec: LaunchSpec, secretsDir: string): DataBackupStorage | null {
  const backup = spec.topology.headscale.backup;
  if (!backup) return null;
  const secret = resolveS3Secret(backup, secretsDir);
  if (!secret) return null;
  return {
    endpoint: backup.s3.endpoint,
    bucket: backup.s3.bucket,
    region: backup.s3.region,
    accessKeyId: backup.s3.accessKeyId,
    secret,
    prefix: `sparkdream-launcher/${chainId(spec)}/chain-data`,
  };
}

const historyKey = (launchId: string) => `data-backups:${launchId}`;

/** The backups the bucket holds for this fleet, newest first (the launcher's record of them). */
export function dataBackups(db: ConductorDb, launchId: string): DataBackupRecord[] {
  const raw = db.getSetting(historyKey(launchId));
  return raw ? (JSON.parse(raw) as DataBackupRecord[]) : [];
}

export function lastDataBackup(db: ConductorDb, launchId: string): DataBackupRecord | null {
  return dataBackups(db, launchId)[0] ?? null;
}

function recordBackup(db: ConductorDb, launchId: string, record: DataBackupRecord): void {
  const next = [record, ...dataBackups(db, launchId).filter((r) => r.name !== record.name)].slice(0, DATA_BACKUP_KEEP);
  db.setSetting(historyKey(launchId), JSON.stringify(next));
}

/** Which node to copy: never a validator; a sentry other than sentry-0 when there is one. */
export function backupSource(rows: FleetComponentRow[]): FleetComponentRow | undefined {
  const sentries = rows
    .filter((r) => r.key.startsWith("sentry-") && r.state === "active" && r.ssh_host)
    .sort((a, b) => Number(b.key.split("-")[1]) - Number(a.key.split("-")[1]));
  return sentries.find((r) => r.key !== "sentry-0") ?? sentries[0];
}

/** A shell file of exported variables, values single-quoted. */
function envFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`)
    .join("\n") + "\n";
}

function s3Env(storage: DataBackupStorage): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: storage.accessKeyId,
    AWS_SECRET_ACCESS_KEY: storage.secret,
    AWS_REGION: storage.region,
    S3_ENDPOINT: storage.endpoint,
    S3_BUCKET: storage.bucket,
    S3_PREFIX: storage.prefix,
  };
}

/** Upload the backup: data dir → zstd → age → S3, then the manifest and pruning. Detached. */
export const BACKUP_SCRIPT = `#!/bin/bash
# sd-data-backup (launcher data-backup op)
set -o pipefail
. /tmp/sd-backup.env && rm -f /tmp/sd-backup.env
ST=/tmp/sd-backup.status; LOG=/tmp/sd-backup.log
echo $$ > /tmp/sd-backup.pid; echo running > $ST; : > $LOG
S5="s5cmd --endpoint-url $S3_ENDPOINT"
if tar -C ${NODE_HOME} -cf - data 2>>$LOG | zstd -q -T0 -3 | age -r "$AGE_RECIPIENT" \\
     | $S5 pipe --concurrency 2 --part-size 32 "s3://$S3_BUCKET/$S3_PREFIX/$NAME" >>$LOG 2>&1 \\
   && printf '%s' "$MANIFEST" | $S5 pipe "s3://$S3_BUCKET/$S3_PREFIX/latest.json" >>$LOG 2>&1; then
  $S5 ls "s3://$S3_BUCKET/$S3_PREFIX/data-*" 2>>$LOG | awk '{print $NF}' | sed 's|.*/||' | sort \\
    | awk -v k=$KEEP '{a[NR]=$0} END {for (i = 1; i <= NR - k; i++) print a[i]}' \\
    | while read -r old; do $S5 rm "s3://$S3_BUCKET/$S3_PREFIX/$old" >>$LOG 2>&1; done
  echo done > $ST
else
  echo failed > $ST
fi
`;

/** Restore a backup into an empty home's data dir, keeping the node's own signing watermark. Detached. */
export const RESTORE_SCRIPT = `#!/bin/bash
# sd-data-restore (launcher relaunch)
set -o pipefail
. /tmp/sd-restore.env && rm -f /tmp/sd-restore.env
ST=/tmp/sd-restore.status; LOG=/tmp/sd-restore.log; H=${NODE_HOME}; KEY=/tmp/sd-restore.age
echo $$ > /tmp/sd-restore.pid; echo running > $ST; : > $LOG
S5="s5cmd --endpoint-url $S3_ENDPOINT"
rm -rf $H/data.restore && mkdir -p $H/data.restore
# a swap a killed run left half done: put the old data back
[ -d $H/data ] || { [ -d $H/data.old ] && mv $H/data.old $H/data; }
rm -rf $H/data.old
if $S5 cat "s3://$S3_BUCKET/$S3_PREFIX/$NAME" 2>>$LOG | age -d -i $KEY | zstd -dq \\
     | tar -C $H/data.restore -xf - 2>>$LOG; then
  rm -f $KEY
  # never swap under a running node: a held node keeps its hold past the
  # swap, and one that started anyway (the hold ran out) keeps its data
  [ -f ${HOLD_FILE} ] && echo $(( $(date +%s) + ${HOLD_SECS} )) > ${HOLD_FILE}
  if [ "$(${NODE_RUNNING_PROBE})" = yes ]; then
    echo "the node started during the restore: its data was left as it was" >>$LOG
    rm -rf $H/data.restore; echo failed > $ST; exit 0
  fi
  # the backup is another node's: keep this node's own watermark, and none
  # of the source's consensus WAL
  if [ -f $H/data/priv_validator_state.json ]; then
    cp $H/data/priv_validator_state.json $H/data.restore/data/priv_validator_state.json
  fi
  rm -rf $H/data.restore/data/cs.wal
  [ -d $H/data ] && mv $H/data $H/data.old
  if ! mv $H/data.restore/data $H/data; then
    [ -d $H/data.old ] && mv $H/data.old $H/data
    rm -rf $H/data.restore; echo failed > $ST; exit 0
  fi
  rm -rf $H/data.old $H/data.restore
  echo done > $ST
else
  rm -f $KEY; rm -rf $H/data.restore
  echo failed > $ST
fi
`;

/**
 * Upload a text file to a node through a local temp file (the secret never
 * touches a command line). Written plain, never with writeSecretFile: under
 * LAUNCHER_SECRET that encrypts, and the node would receive ciphertext. The
 * file lives only for the upload, in the secrets directory (mode 0700).
 */
async function uploadText(ctx: StepCtx, target: SshTarget, remote: string, text: string): Promise<void> {
  const local = path.join(ctx.dirs.secrets, `.upload-${path.basename(remote)}-${process.pid}`);
  fs.mkdirSync(ctx.dirs.secrets, { recursive: true, mode: 0o700 });
  fs.writeFileSync(local, text, { mode: 0o600 });
  try {
    await ctx.services.ssh.upload(target, local, remote);
  } finally {
    fs.rmSync(local, { force: true });
  }
}

const TOOLS_PROBE =
  `for t in s5cmd age zstd; do command -v $t >/dev/null || echo "missing $t"; done; ` +
  `grep -q launcher-hold /usr/local/bin/entrypoint_ssh.sh 2>/dev/null || echo "missing hold"`;

/** How long a copy may run before it is given up (a stuck upload keeps the node held). */
const MAX_COPY_SECS = 12 * 3600;
/** A restore whose data stopped growing this long is given up. */
const RESTORE_STALL_SECS = 20 * 60;
/** Consecutive failed polls (15s apart) before the launcher stops waiting on a node. */
const MAX_POLL_ERRORS = 20;

/**
 * Start a detached launcher script (/tmp/<name>.sh) in its own session, so
 * its whole pipeline can be stopped, and wait for it to record its pid.
 */
export const startScriptCmd = (name: string) =>
  `rm -f /tmp/${name}.pid /tmp/${name}.status; ` +
  `$(command -v setsid) nohup bash /tmp/${name}.sh >/dev/null 2>&1 < /dev/null & ` +
  `for i in 1 2 3 4 5 6 7 8 9 10; do [ -f /tmp/${name}.pid ] && break; sleep 1; done`;

/**
 * "<status> <alive|dead>" for a launcher script. Status and pid live in
 * /tmp, which a container restart empties: a script that died with its
 * container reads "none dead".
 */
export const scriptStateCmd = (name: string) =>
  `s=$(cat /tmp/${name}.status 2>/dev/null); p=$(cat /tmp/${name}.pid 2>/dev/null); ` +
  `a=dead; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && a=alive; echo "\${s:-none} $a"`;

async function scriptState(ctx: StepCtx, target: SshTarget, name: string): Promise<{ status: string; alive: boolean }> {
  const [status = "none", alive] = (await ctx.services.ssh.exec(target, scriptStateCmd(name))).stdout.trim().split(/\s+/);
  return { status, alive: alive === "alive" };
}

/** Stop a launcher script and its whole pipeline (its session), then run `cleanup`; prints "stopped". */
export const stopScriptCmd = (name: string, cleanup = "") =>
  `p=$(cat /tmp/${name}.pid 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then ` +
  `kill -TERM -- -"$p" 2>/dev/null || { pkill -TERM -P "$p"; kill -TERM "$p"; }; ` +
  `for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$p" 2>/dev/null || break; sleep 1; done; ` +
  `kill -KILL -- -"$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; sleep 1; fi; ` +
  `echo failed > /tmp/${name}.status; ${cleanup ? `${cleanup}; ` : ""}echo stopped`;

/**
 * Stop a launcher script and everything it started, then run `cleanup`.
 * True once it is confirmed gone; false when the node could not be reached.
 */
async function stopScript(ctx: StepCtx, target: SshTarget, name: string, cleanup = ""): Promise<boolean> {
  const cmd = stopScriptCmd(name, cleanup);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await ctx.services.ssh.exec(target, cmd).catch(() => null);
    if (res?.stdout.includes("stopped")) return true;
    await ctx.services.sleep(10_000);
  }
  return false;
}

/**
 * Wait for a launcher script to finish. Returns null when it is done, or
 * why it is not: it failed, died (its container restarted), ran past
 * `maxSecs`, stopped making progress, or the node stopped answering. The
 * caller stops the script on anything but null.
 */
async function watchScript(
  ctx: StepCtx,
  target: () => SshTarget,
  name: string,
  opts: { maxSecs: number; progressMb?: () => Promise<number>; stallSecs?: number; tick?: (secs: number, mb: number) => Promise<void> | void },
): Promise<string | null> {
  const started = Date.now();
  let errors = 0;
  let mb = 0;
  let grewAt = Date.now();
  for (;;) {
    await ctx.services.sleep(15_000);
    const secs = Math.round((Date.now() - started) / 1000);
    try {
      const { status, alive } = await scriptState(ctx, target(), name);
      errors = 0;
      if (status === "done") return null;
      if (status === "failed") {
        const log = (await ctx.services.ssh.exec(target(), `tail -n 15 /tmp/${name}.log 2>/dev/null || true`)).stdout.trim();
        return log || `${name} failed`;
      }
      if (!alive) return "the copy stopped without finishing (its container restarted?)";
      if (opts.progressMb) {
        const now = await opts.progressMb();
        if (now > mb) {
          mb = now;
          grewAt = Date.now();
        } else if (opts.stallSecs && Date.now() - grewAt > opts.stallSecs * 1000) {
          return `no progress for ${Math.round(opts.stallSecs / 60)} minutes (stuck at ${mb} MB)`;
        }
      }
      await opts.tick?.(secs, mb);
    } catch (e) {
      if (++errors >= MAX_POLL_ERRORS) {
        return `the node stopped answering (${String(e instanceof Error ? e.message : e).slice(0, 160)})`;
      }
    }
    if (secs > opts.maxSecs) return `still running after ${Math.round(opts.maxSecs / 3600)} hours`;
  }
}

/** Thrown when a restore had to be given up but its script could not be stopped. */
export class RestoreStillRunning extends Error {}

export interface DataBackupParams {
  /** the node copied; picked by backupSource at request time */
  source: string;
  auto?: boolean;
}

export function dataBackupSteps(opId: number, params: DataBackupParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const key = params.source;
  const target = (ctx: StepCtx) => rowTarget(ctx, componentRow(ctx, key));
  const refreshHold = (ctx: StepCtx) => refreshHoldOn(ctx, target(ctx));

  return [
    {
      name: p("prepare"),
      async run(ctx) {
        if (!dataBackupStorage(spec, ctx.dirs.secrets)) {
          throw new Error("this fleet has no mesh backup bucket: turn on the mesh backup first (chain data goes to the same bucket)");
        }
        const missing = (await ctx.services.ssh.exec(target(ctx), TOOLS_PROBE)).stdout.trim();
        if (missing) {
          throw new AwaitUser(
            p("prepare"),
            `${key}'s node image cannot take a chain-data backup (${missing.split("\n").join(", ")}): ` +
              "upgrade the fleet to a node image built with s5cmd, age, zstd and the launcher hold " +
              "(chain repo deploy/docker), then resume or abandon this backup.",
          );
        }
        // the height the copy will hold: the node's own, read while it runs
        const status = await ctx.services.ssh
          .exec(target(ctx), "curl -s -m 5 localhost:26657/status")
          .catch(() => ({ stdout: "" }));
        const height = Number(/"latest_block_height":"(\d+)"/.exec(status.stdout)?.[1] ?? 0);
        return { height };
      },
    },
    holdStep(p, key),
    {
      name: p("upload"),
      async run(ctx) {
        const storage = dataBackupStorage(spec, ctx.dirs.secrets)!;
        const { height } = ctx.output<{ height: number }>(p("prepare"))!;
        const keys = ctx.output<GenerateKeysOutput>("generate-keys")!;
        let name = ctx.output<{ name?: string }>(p("upload"))?.name;
        const state = await scriptState(ctx, target(ctx), "sd-backup");
        if (!(state.status === "done" || (state.status === "running" && state.alive))) {
          // a resumed copy (the last one failed and let the node start) must
          // stop it again: never copy a data directory that is changing
          await ensureHeld(ctx, key);
          const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
          name = `data-${stamp}-h${height}.tar.zst.age`;
          const genesisSha = fleetGenesisSha(ctx.dirs.node);
          const record: DataBackupRecord = {
            name,
            height,
            takenAt: new Date().toISOString(),
            from: key,
            ...(genesisSha ? { genesisSha } : {}),
          };
          await uploadText(
            ctx,
            target(ctx),
            "/tmp/sd-backup.env",
            envFile({
              ...s3Env(storage),
              AGE_RECIPIENT: keys.ageRecipient,
              NAME: name,
              MANIFEST: JSON.stringify(record),
              KEEP: String(DATA_BACKUP_KEEP),
            }),
          );
          await uploadText(ctx, target(ctx), "/tmp/sd-backup.sh", BACKUP_SCRIPT);
          ctx.db.setSetting(`data-backup-pending:${ctx.launchId}`, JSON.stringify(record));
          await ctx.services.ssh.exec(target(ctx), startScriptCmd("sd-backup"));
        }
        const failure =
          state.status === "done"
            ? null
            : await watchScript(ctx, () => target(ctx), "sd-backup", {
                maxSecs: MAX_COPY_SECS,
                // keep the node held while the copy runs, and say how long it has been
                tick: async (secs) => {
                  await refreshHold(ctx).catch(() => undefined);
                  ctx.db.setFleetOpProgress(opId, {
                    label: `copying ${key}'s chain data to the bucket`,
                    elapsedSeconds: secs,
                    updatedAt: new Date().toISOString(),
                  });
                },
              });
        if (failure) {
          ctx.db.setFleetOpProgress(opId, null);
          ctx.db.deleteSetting(`data-backup-pending:${ctx.launchId}`);
          // never leave the node held for a failed copy, unless the copy may
          // still be reading its data (then the hold runs out by itself)
          const stopped = await stopScript(ctx, target(ctx), "sd-backup");
          if (stopped) await ctx.services.ssh.exec(target(ctx), `rm -f ${HOLD_FILE}`).catch(() => undefined);
          throw new AwaitUser(
            p("upload"),
            `the chain-data upload from ${key} failed (${
              stopped ? "the node is running again" : `the node could not be reached; it starts by itself within ${HOLD_SECS / 60} minutes`
            }):\n${failure}\n` + "Check the bucket and its credentials (the mesh backup's), then resume to try again.",
          );
        }
        const pending = ctx.db.getSetting(`data-backup-pending:${ctx.launchId}`);
        if (pending) {
          recordBackup(ctx.db, ctx.launchId, JSON.parse(pending) as DataBackupRecord);
          ctx.db.deleteSetting(`data-backup-pending:${ctx.launchId}`);
        }
        ctx.db.setFleetOpProgress(opId, null);
        return { name };
      },
    },
    releaseStep(p, key, opId),
  ];
}

const nodeTarget = (ctx: StepCtx, key: string) => rowTarget(ctx, componentRow(ctx, key));

async function nodeRunning(ctx: StepCtx, target: SshTarget): Promise<boolean> {
  const res = await ctx.services.ssh.exec(target, NODE_RUNNING_PROBE, { quick: true }).catch(() => ({ stdout: "" }));
  return res.stdout.trim() === "yes";
}

function refreshHoldOn(ctx: StepCtx, target: SshTarget) {
  return ctx.services.ssh.exec(target, `echo $(( $(date +%s) + ${HOLD_SECS} )) > ${HOLD_FILE}`);
}

/**
 * Stop a node for a data-directory operation: restart its container under
 * the launcher hold (PID 1 is the node; the container restarts, and the
 * entrypoint then leaves the node stopped). A node already held and stopped
 * is left as it is.
 */
async function ensureHeld(ctx: StepCtx, key: string): Promise<void> {
  const target = () => nodeTarget(ctx, key);
  const held = (await ctx.services.ssh.exec(target(), `test -f ${HOLD_FILE} && echo held || true`)).stdout.trim();
  if (held !== "held" || (await nodeRunning(ctx, target()))) {
    // a wait-mode container's PID 1 is a tail: restarting it would bring
    // back nothing that starts the node, so the hold cannot work there
    const pid1 = (await ctx.services.ssh.exec(target(), "cat /proc/1/comm 2>/dev/null || true")).stdout.trim();
    if (pid1 === "tail") {
      throw new Error(
        `${key} runs in wait mode (its node was started over SSH, not by the container), so the launcher hold ` +
          "cannot stop and restart it: relaunch or repair it first",
      );
    }
    await refreshHoldOn(ctx, target());
    await ctx.services.ssh.exec(target(), "(sleep 1; kill -TERM 1) >/dev/null 2>&1 &").catch(() => undefined);
  } else {
    await refreshHoldOn(ctx, target());
  }
  for (let i = 0; i < 60; i++) {
    await ctx.services.sleep(5000);
    if (i % 6 === 5) await refreshSshEndpoints(ctx, [componentRow(ctx, key)]).catch(() => undefined);
    const up = await ctx.services.ssh.exec(target(), "true", { quick: true }).then(() => true).catch(() => false);
    if (up && !(await nodeRunning(ctx, target()))) {
      ctx.log(`${key}: stopped under the launcher hold`);
      return;
    }
  }
  throw new Error(`${key} did not come back stopped under the hold within 5 minutes`);
}

function holdStep(p: (s: string) => string, key: string): StepDef {
  return {
    name: p("hold"),
    async run(ctx) {
      await ensureHeld(ctx, key);
      return { held: true };
    },
  };
}

/** Remove the hold; the entrypoint starts the node within ~15s. Closes the op. */
function releaseStep(p: (s: string) => string, key: string, opId: number): StepDef {
  return {
    name: p("release"),
    async run(ctx) {
      const target = () => nodeTarget(ctx, key);
      await ctx.services.ssh.exec(target(), `rm -f ${HOLD_FILE}`);
      for (let i = 0; i < 36; i++) {
        if (await nodeRunning(ctx, target())) {
          ctx.log(`${key}: running again`);
          ctx.db.setFleetOpStatus(opId, "done");
          return { running: true };
        }
        await ctx.services.sleep(5000);
      }
      throw new Error(`${key} did not start after the hold was released: check its container log`);
    },
  };
}

/**
 * Run the restore script on a stopped node (fresh volume, or `held` under
 * the launcher hold, which is renewed while it runs) and wait for it.
 * Returns the failure text, or null when the data is in place. A restore
 * given up is stopped first; when it cannot be, RestoreStillRunning is
 * thrown, and the node must not be started.
 */
async function runRestore(
  ctx: StepCtx,
  spec: LaunchSpec,
  key: string,
  target: SshTarget,
  record: DataBackupRecord,
  opts: { held?: boolean; progress?: (elapsedSeconds: number, mb: number) => void } = {},
): Promise<string | null> {
  const storage = dataBackupStorage(spec, ctx.dirs.secrets);
  const identity = ageIdentityAt(ctx.dirs.secrets);
  if (!storage || !identity) return "this fleet has no backup bucket or age key";
  const missing = (await ctx.services.ssh.exec(target, TOOLS_PROBE)).stdout.trim();
  if (/s5cmd|age|zstd/.test(missing)) return `the node image has no backup tools (${missing.split("\n").join(", ")})`;
  const state = await scriptState(ctx, target, "sd-restore");
  if (!(state.status === "running" && state.alive)) {
    // a resume after the hold ran out: stop the node again first
    if (opts.held) await ensureHeld(ctx, key);
    await uploadText(ctx, target, "/tmp/sd-restore.age", `${identity}\n`);
    await uploadText(ctx, target, "/tmp/sd-restore.env", envFile({ ...s3Env(storage), NAME: record.name }));
    await uploadText(ctx, target, "/tmp/sd-restore.sh", RESTORE_SCRIPT);
    try {
      await ctx.services.ssh.exec(target, startScriptCmd("sd-restore"));
    } catch (e) {
      await giveUpRestore(ctx, target, key);
      throw e;
    }
  }
  const failure = await watchScript(ctx, () => target, "sd-restore", {
    maxSecs: MAX_COPY_SECS,
    stallSecs: RESTORE_STALL_SECS,
    progressMb: async () =>
      Number((await ctx.services.ssh.exec(target, `du -sm ${NODE_HOME}/data.restore 2>/dev/null | cut -f1`)).stdout.trim()) || 0,
    tick: async (secs, mb) => {
      if (opts.held) await refreshHoldOn(ctx, target).catch(() => undefined);
      opts.progress?.(secs, mb);
    },
  });
  if (failure) await giveUpRestore(ctx, target, key);
  return failure;
}

/** Stop a restore and drop its partial copy, putting back old data a half-done swap moved aside. */
async function giveUpRestore(ctx: StepCtx, target: SshTarget, key: string): Promise<void> {
  const H = NODE_HOME;
  const stopped = await stopScript(
    ctx,
    target,
    "sd-restore",
    `rm -f /tmp/sd-restore.age /tmp/sd-restore.env; rm -rf ${H}/data.restore; ` +
      `if [ -d ${H}/data ]; then rm -rf ${H}/data.old; elif [ -d ${H}/data.old ]; then mv ${H}/data.old ${H}/data; fi`,
  );
  if (!stopped) {
    throw new RestoreStillRunning(
      `the chain-data restore on ${key} could not be stopped (the node does not answer); ` +
        "it may still be replacing the data, so the node was not started. Resume once the node answers again.",
    );
  }
}

/**
 * Restore the latest chain-data backup into a node's fresh home before its
 * first boot (relaunch, add-sentry, resize staging). Never fails the step:
 * without a backup, tools or a working bucket, the node syncs from its
 * peers as before.
 */
export async function restoreChainData(
  ctx: StepCtx,
  spec: LaunchSpec,
  key: string,
  target: SshTarget,
): Promise<{ restored: boolean; height?: number }> {
  const latest = lastDataBackup(ctx.db, ctx.launchId);
  if (!latest || !dataBackupStorage(spec, ctx.dirs.secrets)) return { restored: false };
  if (!autoRestoreEnabled(ctx.db, ctx.launchId)) {
    ctx.log(`${key}: automatic restore from backups is off for this fleet; syncing from peers`);
    return { restored: false };
  }
  const blocker = restoreBlocker(ctx.db, ctx.launchId, ctx.dirs.node, latest);
  if (blocker) {
    ctx.log(`${key}: not restoring the chain-data backup (${blocker}); syncing from peers`);
    return { restored: false };
  }
  try {
    ctx.log(`${key}: restoring the chain-data backup taken at height ${latest.height} (${latest.name})`);
    let last = 0;
    const failure = await runRestore(ctx, spec, key, target, latest, {
      progress: (secs, mb) => {
        if (secs - last >= 120) {
          last = secs;
          ctx.log(`${key}: restoring chain data, ${mb} MB so far (${Math.round(secs / 60)} min)`);
        }
      },
    });
    if (failure) {
      ctx.log(`${key}: chain-data restore not used, syncing from peers instead: ${failure}`);
      return { restored: false };
    }
    ctx.log(`${key}: chain data restored to height ${latest.height}; it syncs the rest from its peers`);
    return { restored: true, height: latest.height };
  } catch (e) {
    // the restore may still be swapping the data: starting the node now
    // would run it on a directory that is being replaced
    if (e instanceof RestoreStillRunning) throw e;
    ctx.log(`${key}: chain-data restore skipped (${String(e instanceof Error ? e.message : e).slice(0, 200)}); syncing from peers`);
    return { restored: false };
  }
}

export interface DataRestoreParams {
  /** the node whose data is replaced in place */
  key: string;
  /** the backup restored (its name in the bucket) */
  name: string;
}

/**
 * Replace a running node's chain data with a backup, in place ("data-restore"
 * op): the cure for a node whose data went bad (an AppHash mismatch, a
 * corrupted store) without moving it. The node keeps its keys and its own
 * signing watermark; it syncs from the backup's height to the head after.
 */
export function dataRestoreSteps(opId: number, params: DataRestoreParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const { key } = params;
  return [
    holdStep(p, key),
    {
      name: p("restore"),
      async run(ctx) {
        const record = dataBackups(ctx.db, ctx.launchId).find((r) => r.name === params.name);
        if (!record) throw new Error(`no backup named ${params.name} is recorded for this fleet`);
        const failure = await runRestore(ctx, spec, key, nodeTarget(ctx, key), record, {
          held: true,
          progress: (secs, mb) =>
            ctx.db.setFleetOpProgress(opId, {
              label: `restoring ${key}'s chain data (${mb} MB written)`,
              elapsedSeconds: secs,
              updatedAt: new Date().toISOString(),
            }),
        });
        ctx.db.setFleetOpProgress(opId, null);
        if (failure) {
          throw new AwaitUser(
            p("restore"),
            `restoring ${record.name} into ${key} failed; its old data is untouched and it is still stopped ` +
              `under the hold (it starts by itself within ${HOLD_SECS / 60} minutes):\n${failure}\n` +
              "Resume to try again, or abandon the op to let the node start on its old data.",
          );
        }
        ctx.log(`${key}: data replaced with ${record.name} (height ${record.height})`);
        return { height: record.height };
      },
    },
    releaseStep(p, key, opId),
  ];
}
