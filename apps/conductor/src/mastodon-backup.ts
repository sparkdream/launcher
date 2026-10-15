import { chainId, isServicesFleet, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import {
  MAX_COPY_SECS,
  S3GET_FN,
  UPLOAD_STALL_SECS,
  envFile,
  s3Env,
  scriptStateVia,
  startScriptCmd,
  stopScriptCmd,
  watchScriptVia,
  type DataBackupStorage,
} from "./data-backup.js";
import { AwaitUser, RerunFrom, type StepCtx, type StepDef } from "./engine.js";
import { componentLease } from "./sessions.js";
import { ageIdentityAt, loadCert, resolveS3Secret } from "./steps/phase-bcd.js";
import type { GenerateKeysOutput } from "./steps/phase-a.js";
import {
  MEDIA,
  SCRATCH_DB,
  createScratchDb,
  restartMastodon,
  swapInScratchDb,
  type Lease,
} from "./steps/mastodon-migrate.js";

/**
 * Mastodon backups to object storage: the database (pg_dump, custom format)
 * and the uploaded media under public/system (minus the remote-media cache,
 * which the instance fetches again), each encrypted to the fleet's age
 * recipient and streamed to the bucket from inside the web container, so
 * nothing is written to its disk and nothing passes through the launcher.
 * Each backup is a folder, <prefix>/mastodon-<UTC time>/{db.dump,media.tar}.age.
 *
 * Unlike a chain node, the instance keeps running: pg_dump reads one
 * consistent snapshot, and the database goes first, so media uploaded
 * meanwhile lands in the tar and no restored row points at a file the backup
 * lacks. Redis (queues, caches) and the bridge's state file are not kept;
 * both rebuild themselves.
 *
 * Lease-shell is the only way in (no sshd in these images), and it has no
 * usable stdin: scripts and their settings go in as base64 through the
 * command, then run detached (setsid) and are polled, as the chain-data
 * scripts are over SSH. Needs a Mastodon image carrying pg_dump/pg_restore/
 * psql (the server's major), age, s5cmd and curl (chain repo
 * Dockerfile-mastodon).
 */

/** Backups kept in the bucket: a rolling pair, older ones deleted once a new one passes its check. */
export const MASTODON_BACKUP_KEEP = 2;
/** Secret file holding mastodon.backup's S3 secret (secretRef "secret:s3-mastodon-backup"). */
export const MASTODON_S3_SECRET_FILE = "s3-mastodon-backup";

export interface MastodonBackupRecord {
  /** the backup's folder in the bucket: mastodon-<UTC time> */
  name: string;
  takenAt: string;
  /** the deployment it was taken from */
  dseq: string;
  /** sha256 of each encrypted object as the container uploaded it */
  dbSha256?: string;
  mediaSha256?: string;
  /** bytes of each encrypted object as uploaded (backups before 2026-10-15 lack them) */
  dbBytes?: number;
  mediaBytes?: number;
  /** read back from the bucket and decrypted end to end after the upload */
  verified?: boolean;
}

/**
 * Where the instance's backups go: mastodon.backup, else the fleet's mesh
 * backup bucket (a services fleet has none), under its own prefix. Null
 * when neither is set or the secret is missing.
 */
export function mastodonBackupStorage(spec: LaunchSpec, secretsDir: string): DataBackupStorage | null {
  const own = spec.topology.components.mastodon?.backup;
  const backup = own ?? (isServicesFleet(spec) ? undefined : spec.topology.headscale.backup);
  if (!backup) return null;
  const secret = resolveS3Secret(backup, secretsDir);
  if (!secret) return null;
  return {
    endpoint: backup.s3.endpoint,
    bucket: backup.s3.bucket,
    region: backup.s3.region,
    accessKeyId: backup.s3.accessKeyId,
    secret,
    // the mesh backup's own path is headscale's, never reused
    prefix: own?.s3.path ?? `sparkdream-launcher/${chainId(spec)}/mastodon`,
  };
}

const historyKey = (launchId: string) => `mastodon-backups:${launchId}`;
const pendingKey = (launchId: string) => `mastodon-backup-pending:${launchId}`;

/** The backups the bucket holds for this fleet's instance, newest first (the launcher's record of them). */
export function mastodonBackups(db: ConductorDb, launchId: string): MastodonBackupRecord[] {
  const raw = db.getSetting(historyKey(launchId));
  return raw ? (JSON.parse(raw) as MastodonBackupRecord[]) : [];
}

/** The newest backup that passed its check, or null. */
export function latestMastodonBackup(db: ConductorDb, launchId: string): MastodonBackupRecord | null {
  return mastodonBackups(db, launchId).find((r) => r.verified) ?? null;
}

/** Record a checked backup; returns the ones that fell off the end, for deletion from the bucket. */
function recordBackup(db: ConductorDb, launchId: string, record: MastodonBackupRecord): MastodonBackupRecord[] {
  const all = [record, ...mastodonBackups(db, launchId).filter((r) => r.name !== record.name)];
  db.setSetting(historyKey(launchId), JSON.stringify(all.slice(0, MASTODON_BACKUP_KEEP)));
  return all.slice(MASTODON_BACKUP_KEEP);
}

export function forgetMastodonBackup(db: ConductorDb, launchId: string, name: string): void {
  db.setSetting(historyKey(launchId), JSON.stringify(mastodonBackups(db, launchId).filter((r) => r.name !== name)));
}

/** Whether a relaunched instance starts from the latest backup (default on). */
export function mastodonAutoRestore(db: ConductorDb, launchId: string): boolean {
  return db.getSetting(`mastodon-restore-auto:${launchId}`) !== "off";
}

/** Leave the abandoned op's half-made backup unrecorded. */
export function dropPendingMastodonBackup(db: ConductorDb, launchId: string): void {
  db.deleteSetting(pendingKey(launchId));
}

export const isMastodonBackupName = (name: string) => /^mastodon-[0-9TZ]+$/.test(name);

/** A way to run a shell command in one of the instance's containers. */
export type Shell = (service: string, script: string, timeoutMs?: number) => Promise<string>;

/** Lease-shell into the instance's current deployment. */
export function leaseShell(ctx: StepCtx, lease: Lease = componentLease(ctx, "mastodon")): Shell {
  return async (service, script, timeoutMs = 60_000) =>
    (
      await ctx.services.provider.shellExec(loadCert(ctx), lease.hostUri, lease.dseq, lease.gseq, lease.oseq, service, ["sh", "-c", script], {
        timeoutMs,
      })
    ).stdout;
}

/**
 * Write a file into the web container through the command line (lease-shell
 * has no usable stdin). An env file carries the bucket's secret: a failure
 * reports without the command, which a timeout's error would otherwise quote.
 */
async function writeFile(shell: Shell, remote: string, text: string, what: string): Promise<void> {
  const b64 = Buffer.from(text).toString("base64");
  try {
    await shell("mastodon", `umask 077; printf '%s' '${b64}' | base64 -d > ${remote}`);
  } catch (e) {
    const why = String(e instanceof Error ? e.message : e).split(b64).join("…").slice(0, 200);
    throw new Error(`could not write ${what} into the mastodon container: ${why}`);
  }
}

const TOOLS_PROBE = `for t in pg_dump pg_restore age s5cmd curl setsid; do command -v $t >/dev/null || echo $t; done`;

/** The tools a backup or restore needs, missing from the running image ("" when all are there). */
async function missingTools(shell: Shell): Promise<string> {
  return (await shell("mastodon", TOOLS_PROBE)).trim().split("\n").filter(Boolean).join(", ");
}

/**
 * Whether a move (resize) can carry the instance's data through the bucket:
 * Mastodon has one and the running image the tools. Otherwise it goes over
 * lease-shell, as before backups existed.
 */
export async function bucketBackupReady(ctx: StepCtx, spec: LaunchSpec): Promise<boolean> {
  if (!mastodonBackupStorage(spec, ctx.dirs.secrets)) return false;
  const missing = await missingTools(leaseShell(ctx)).catch(() => "unreachable");
  if (missing) ctx.log(`mastodon: not moving the data through the bucket (${missing}); copying it over lease-shell instead`);
  return !missing;
}

const NEEDS_IMAGE =
  "upgrade Mastodon to an image built with pg_dump, age and s5cmd (chain repo deploy/docker/Dockerfile-mastodon, " +
  "\"upgrade…\" on its row)";

// the instance's own database settings (the container's env): no password
// on a command line
const PG = `PGPASSWORD="$DB_PASS" `;
const PG_ARGS = `-h "\${DB_HOST:-db}" -p "\${DB_PORT:-5432}" -U "\${DB_USER:-postgres}"`;

/** Upload a backup: the database, then the media, each through age to the bucket. Detached. */
export const BACKUP_SCRIPT = `#!/bin/bash
# sd-mastodon-backup (launcher mastodon-backup op)
set -o pipefail
. /tmp/sd-mbackup.env && rm -f /tmp/sd-mbackup.env
ST=/tmp/sd-mbackup.status; LOG=/tmp/sd-mbackup.log
echo $$ > /tmp/sd-mbackup.pid; echo running > $ST; : > $LOG; rm -f /tmp/sd-mbackup.*.sha /tmp/sd-mbackup.*.bytes
echo database > /tmp/sd-mbackup.phase
OBJ="s3://$S3_BUCKET/$S3_PREFIX/$NAME"
# the hash and size of exactly what was uploaded: the check compares the
# bucket's copy against the hash, the dialog shows the size
up() { tee >(sha256sum | cut -d' ' -f1 > /tmp/sd-mbackup.$1.sha) >(wc -c > /tmp/sd-mbackup.$1.bytes) | s5cmd --endpoint-url "$S3_ENDPOINT" pipe --concurrency 2 --part-size 32 "$OBJ/$1.age" >>$LOG 2>&1; }
# the database first: media uploaded meanwhile lands in the tar, so no row
# points at a file the backup lacks
${PG}pg_dump ${PG_ARGS} -Fc "\${DB_NAME:-mastodon}" 2>>$LOG | age -r "$AGE_RECIPIENT" | up db.dump
st=("\${PIPESTATUS[@]}")
if [ "\${st[0]}\${st[1]}\${st[2]}" != 000 ]; then echo "the database dump failed (exit \${st[*]})" >>$LOG; echo failed > $ST; exit 0; fi
echo media > /tmp/sd-mbackup.phase
# tar exits 1 when a file changed while it was read (the instance runs): the copy is still whole
tar -C ${MEDIA} --exclude=./cache --exclude=./lost+found --ignore-failed-read --warning=no-file-changed -cf - . 2>>$LOG \\
  | age -r "$AGE_RECIPIENT" | up media.tar
st=("\${PIPESTATUS[@]}")
if [ "\${st[0]}" -gt 1 ] || [ "\${st[1]}\${st[2]}" != 00 ]; then echo "the media copy failed (exit \${st[*]})" >>$LOG; echo failed > $ST; exit 0; fi
echo done > $ST
`;

/**
 * Read a backup back and decrypt both halves to nowhere (every age chunk is
 * authenticated; the dump must open as one, the media must list as a tar).
 * On a failure, what the bucket returned is hashed into
 * /tmp/sd-mverify.<object>.readback. Detached.
 */
export const VERIFY_SCRIPT = `#!/bin/bash
# sd-mastodon-verify (launcher mastodon-backup op)
set -o pipefail
. /tmp/sd-mverify.env && rm -f /tmp/sd-mverify.env
ST=/tmp/sd-mverify.status; LOG=/tmp/sd-mverify.log; KEY=/tmp/sd-mverify.age
echo $$ > /tmp/sd-mverify.pid; echo running > $ST; : > $LOG; rm -f /tmp/sd-mverify.*.readback
${S3GET_FN}
dump() { [ "$(head -c 5)" = PGDMP ] && cat >/dev/null; }
media() { tar -tf - >/dev/null && cat >/dev/null; }
check() {
  s3get "$S3_PREFIX/$NAME/$1.age" 2>>$LOG | tee >(sha256sum | cut -d' ' -f1 > /tmp/sd-mverify.$1.readback) \\
    | age -d -i $KEY 2>>$LOG | $2 2>>$LOG
}
if check db.dump dump && check media.tar media; then echo done > $ST; else echo failed > $ST; fi
rm -f $KEY
`;

/**
 * Restore a backup: the database into the scratch database (the launcher
 * checks it and swaps it in), the media unpacked over the volume. Detached.
 */
export const RESTORE_SCRIPT = `#!/bin/bash
# sd-mastodon-restore (launcher mastodon-restore, relaunch, resize)
set -o pipefail
. /tmp/sd-mrestore.env && rm -f /tmp/sd-mrestore.env
ST=/tmp/sd-mrestore.status; LOG=/tmp/sd-mrestore.log; KEY=/tmp/sd-mrestore.age
echo $$ > /tmp/sd-mrestore.pid; echo running > $ST; : > $LOG
${S3GET_FN}
fail() { echo "$1" >>$LOG; rm -f $KEY; echo failed > $ST; exit 0; }
# pg_restore reports harmless noise (extension comments owned by another
# role) with a non-zero exit: what counts here is that the whole dump
# arrived and decrypted; the launcher then checks the data itself
s3get "$S3_PREFIX/$NAME/db.dump.age" 2>>$LOG | age -d -i $KEY 2>>$LOG \\
  | ${PG}pg_restore ${PG_ARGS} --no-owner --role="\${DB_USER:-postgres}" -d ${SCRATCH_DB} >>$LOG 2>&1
st=("\${PIPESTATUS[@]}")
[ "\${st[0]}\${st[1]}" = 00 ] || fail "the database download failed (exit \${st[*]})"
# media: unpacked over what the volume holds (a file added since stays)
s3get "$S3_PREFIX/$NAME/media.tar.age" 2>>$LOG | age -d -i $KEY 2>>$LOG | tar -C ${MEDIA} -xf - 2>>$LOG \\
  || fail "the media download failed"
chown -R 991:991 ${MEDIA}
rm -f $KEY
echo done > $ST
`;

/** "<phase> <MB read>" of the backup's current reader (pg_dump or tar), from /proc. */
const PROGRESS_CMD =
  `p=$(cat /tmp/sd-mbackup.pid 2>/dev/null); ph=$(cat /tmp/sd-mbackup.phase 2>/dev/null); [ -n "$p" ] && ` +
  `for d in /proc/[0-9]*; do [ "$(cut -d' ' -f4 $d/stat 2>/dev/null)" = "$p" ] || continue; ` +
  `case "$(cat $d/comm 2>/dev/null)" in pg_dump|tar) ` +
  `echo "$ph $(awk '/^rchar:/ { print int($2 / 1048576) }' $d/io 2>/dev/null)"; break;; esac; done; true`;

/** Stop whatever an abandoned backup or restore left running in the container. */
export const abandonMastodonBackupCmd = () =>
  `${stopScriptCmd("sd-mverify", "rm -f /tmp/sd-mverify.age")} >/dev/null; ` +
  `${stopScriptCmd("sd-mrestore", "rm -f /tmp/sd-mrestore.age")} >/dev/null; ` +
  stopScriptCmd("sd-mbackup");

async function stopScript(shell: Shell, name: string, cleanup = ""): Promise<void> {
  await shell("mastodon", stopScriptCmd(name, cleanup)).catch(() => undefined);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Take a backup of the running instance (resumable: a copy still running is
 * watched again, a finished one read). Leaves the record pending until the
 * check passes. Returns its name.
 */
export async function uploadMastodonBackup(
  ctx: StepCtx,
  spec: LaunchSpec,
  stepName: string,
  opts: { progress?: (label: string, secs: number) => void } = {},
): Promise<MastodonBackupRecord> {
  const storage = mastodonBackupStorage(spec, ctx.dirs.secrets);
  if (!storage) throw new Error("Mastodon has no backup bucket: set one under backups… on its row");
  const lease = componentLease(ctx, "mastodon");
  const shell = leaseShell(ctx, lease);
  const exec = (cmd: string) => shell("mastodon", cmd);
  const pendingRaw = ctx.db.getSetting(pendingKey(ctx.launchId));
  let record = pendingRaw ? (JSON.parse(pendingRaw) as MastodonBackupRecord) : undefined;
  const state = await scriptStateVia(exec, "sd-mbackup");
  // a copy picked back up (a conductor restart) carries on; anything else starts over
  if (!record || record.dseq !== lease.dseq || !(state.status === "done" || (state.status === "running" && state.alive))) {
    const missing = await missingTools(shell);
    if (missing) {
      throw new AwaitUser(stepName, `the running Mastodon image cannot take a backup (missing ${missing}): ${NEEDS_IMAGE}, then resume.`);
    }
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    if (!keys?.ageRecipient) throw new Error("this launch has no age key pair to encrypt the backup with");
    record = { name: `mastodon-${stamp()}`, takenAt: new Date().toISOString(), dseq: lease.dseq };
    await writeFile(shell, "/tmp/sd-mbackup.env", envFile({ ...s3Env(storage), AGE_RECIPIENT: keys.ageRecipient, NAME: record.name }), "the backup settings");
    await writeFile(shell, "/tmp/sd-mbackup.sh", BACKUP_SCRIPT, "the backup script");
    ctx.db.setSetting(pendingKey(ctx.launchId), JSON.stringify(record));
    await exec(startScriptCmd("sd-mbackup"));
    ctx.log(`mastodon: backing up deployment ${lease.dseq} to ${storage.bucket}/${storage.prefix}/${record.name}`);
  }
  // what the current reader (pg_dump, then tar) has read; the media's count
  // goes on from the database's, so the stall check sees one rising number
  let phase = "database";
  let read = 0;
  let dbMb = 0;
  const failure =
    state.status === "done" && record.dseq === lease.dseq && pendingRaw
      ? null
      : await watchScriptVia(ctx, exec, "sd-mbackup", {
          maxSecs: MAX_COPY_SECS,
          stallSecs: UPLOAD_STALL_SECS,
          progressMb: async () => {
            const m = /^(\w+) (\d+)$/.exec((await exec(PROGRESS_CMD)).trim());
            if (!m) return null;
            if (m[1] === "media" && phase !== "media") dbMb = read;
            phase = m[1]!;
            read = Number(m[2]);
            return phase === "media" ? dbMb + 1 + read : read;
          },
          tick: (secs) => opts.progress?.(`copying Mastodon's ${phase} to the bucket (${read.toLocaleString("en-US")} MB)`, secs),
        });
  if (failure) {
    ctx.db.deleteSetting(pendingKey(ctx.launchId));
    await stopScript(shell, "sd-mbackup");
    throw new AwaitUser(
      stepName,
      `the Mastodon backup upload failed (the instance kept running):\n${failure}\n` +
        "Check the bucket and its credentials, then resume to try again.",
    );
  }
  const sha = async (obj: string) => {
    // the hash lands a moment after the upload ends (tee's reader)
    for (let i = 0; i < 5; i++) {
      if (i > 0) await ctx.services.sleep(2000);
      const v = (await exec(`cat /tmp/sd-mbackup.${obj}.sha 2>/dev/null || true`)).trim();
      if (/^[0-9a-f]{64}$/.test(v)) return v;
    }
    return undefined;
  };
  const bytes = async (obj: string) => {
    const v = Number((await exec(`cat /tmp/sd-mbackup.${obj}.bytes 2>/dev/null || true`)).trim());
    return v > 0 ? v : undefined;
  };
  const [dbSha256, mediaSha256] = [await sha("db.dump"), await sha("media.tar")];
  const [dbBytes, mediaBytes] = [await bytes("db.dump"), await bytes("media.tar")];
  record = {
    ...record,
    ...(dbSha256 ? { dbSha256 } : {}),
    ...(mediaSha256 ? { mediaSha256 } : {}),
    ...(dbBytes ? { dbBytes } : {}),
    ...(mediaBytes ? { mediaBytes } : {}),
  };
  ctx.db.setSetting(pendingKey(ctx.launchId), JSON.stringify(record));
  return record;
}

/** Times a backup is taken again after it failed its check, before the op pauses. */
const VERIFY_ATTEMPTS = 2;

/**
 * Read the pending backup back and decrypt it end to end, then record it
 * and delete the ones that fell off the rolling pair. One that fails is
 * deleted from the bucket and, `retake` steps given, taken again once; a
 * second failure pauses with what the hashes say.
 */
export async function verifyMastodonBackup(
  ctx: StepCtx,
  spec: LaunchSpec,
  stepName: string,
  opts: { retake: string[]; attemptsKey: string; progress?: (label: string, secs: number) => void },
): Promise<MastodonBackupRecord> {
  const storage = mastodonBackupStorage(spec, ctx.dirs.secrets);
  const identity = ageIdentityAt(ctx.dirs.secrets);
  if (!storage || !identity) throw new Error("Mastodon has no backup bucket, or this launch no age key");
  const pending = ctx.db.getSetting(pendingKey(ctx.launchId));
  if (!pending) throw new RerunFrom(opts.retake, "no uploaded Mastodon backup is waiting to be checked");
  const record = JSON.parse(pending) as MastodonBackupRecord;
  const shell = leaseShell(ctx);
  const exec = (cmd: string) => shell("mastodon", cmd);
  const state = await scriptStateVia(exec, "sd-mverify");
  if (!(state.status === "done" || (state.status === "running" && state.alive))) {
    await writeFile(shell, "/tmp/sd-mverify.age", `${identity}\n`, "the check's key");
    await writeFile(shell, "/tmp/sd-mverify.env", envFile({ ...s3Env(storage), NAME: record.name }), "the check's settings");
    await writeFile(shell, "/tmp/sd-mverify.sh", VERIFY_SCRIPT, "the check script");
    await exec(startScriptCmd("sd-mverify"));
  }
  const failure =
    state.status === "done"
      ? null
      : await watchScriptVia(ctx, exec, "sd-mverify", {
          maxSecs: MAX_COPY_SECS,
          tick: (secs) => opts.progress?.("reading the Mastodon backup back from the bucket to check it", secs),
        });
  if (!failure) {
    const dropped = recordBackup(ctx.db, ctx.launchId, { ...record, verified: true });
    ctx.db.deleteSetting(pendingKey(ctx.launchId));
    ctx.db.deleteSetting(opts.attemptsKey);
    // clear the finished scripts' status: the next backup must start over
    await exec("rm -f /tmp/sd-mbackup.status /tmp/sd-mverify.status").catch(() => undefined);
    for (const old of dropped) {
      await removeMastodonBackup(shell, storage, old.name).catch((e) =>
        ctx.log(`mastodon: could not delete the older backup ${old.name}: ${e instanceof Error ? e.message : e}`),
      );
    }
    ctx.log(`mastodon: backup ${record.name} checked and recorded`);
    return { ...record, verified: true };
  }

  await stopScript(shell, "sd-mverify", "rm -f /tmp/sd-mverify.age");
  const readback = async (obj: string) =>
    (await exec(`cat /tmp/sd-mverify.${obj}.readback 2>/dev/null || true`).catch(() => "")).trim();
  const pairs: [string | undefined, string][] = [
    [record.dbSha256, await readback("db.dump")],
    [record.mediaSha256, await readback("media.tar")],
  ];
  const known = pairs.filter(([up, back]) => up && /^[0-9a-f]{64}$/.test(back));
  const why =
    known.length === 0
      ? "it did not read back intact"
      : known.some(([up, back]) => up !== back)
        ? "the bucket returned different bytes than the container uploaded: the upload or the storage corrupted it"
        : "the bucket returned exactly the bytes the container uploaded, and they do not decrypt: the container produced a broken stream";
  await removeMastodonBackup(shell, storage, record.name).catch((e) =>
    ctx.log(`mastodon: could not delete the failed backup ${record.name}: ${e instanceof Error ? e.message : e}`),
  );
  ctx.db.deleteSetting(pendingKey(ctx.launchId));
  await exec("rm -f /tmp/sd-mbackup.status /tmp/sd-mbackup.pid /tmp/sd-mverify.status").catch(() => undefined);
  const failures = Number(ctx.db.getSetting(opts.attemptsKey) ?? 0) + 1;
  ctx.db.setSetting(opts.attemptsKey, String(failures));
  ctx.log(`mastodon: ${record.name} failed its check (${why}); deleted from the bucket`);
  if (failures < VERIFY_ATTEMPTS) throw new RerunFrom(opts.retake, `the backup failed its check (${why}); taking it again`);
  throw new AwaitUser(
    stepName,
    `The Mastodon backup failed its check ${failures} times and was deleted from the bucket each time. ` +
      `The last time, ${why}.\n${failure}\nResume to take it again, or abandon.`,
  );
}

/** Delete a backup's folder from the bucket, through the web container (the conductor has no S3 client). */
export async function removeMastodonBackup(shell: Shell, storage: DataBackupStorage, name: string): Promise<void> {
  if (!isMastodonBackupName(name)) throw new Error(`not a Mastodon backup name: ${name}`);
  await writeFile(shell, "/tmp/sd-mrm.env", envFile({ ...s3Env(storage), NAME: name }), "the bucket settings");
  const out = await shell(
    "mastodon",
    `. /tmp/sd-mrm.env && rm -f /tmp/sd-mrm.env && ` +
      `{ out=$(s5cmd --endpoint-url "$S3_ENDPOINT" rm "s3://$S3_BUCKET/$S3_PREFIX/$NAME/*" 2>&1); rc=$?; ` +
      `if [ $rc -eq 0 ] || echo "$out" | grep -qi "no object found"; then echo removed; else echo "$out"; fi; }`,
  );
  if (!out.includes("removed")) throw new Error(`could not delete ${name} from the bucket: ${out.trim().slice(0, 300)}`);
}

/**
 * Restore a recorded backup into the instance's current deployment: the
 * database through a scratch one (checked for accounts before it replaces
 * the instance's), the media over the volume, then a restart that migrates
 * the restored schema to the running image. Returns the account count.
 */
export async function restoreMastodonBackup(
  ctx: StepCtx,
  spec: LaunchSpec,
  stepName: string,
  record: MastodonBackupRecord,
  opts: { progress?: (label: string, secs: number) => void } = {},
): Promise<number> {
  const storage = mastodonBackupStorage(spec, ctx.dirs.secrets);
  const identity = ageIdentityAt(ctx.dirs.secrets);
  if (!storage || !identity) throw new Error("Mastodon has no backup bucket, or this launch no age key");
  const lease = componentLease(ctx, "mastodon");
  const shell = leaseShell(ctx, lease);
  const exec = (cmd: string) => shell("mastodon", cmd);
  const kept = `${record.name} is still in the bucket`;
  // a new deployment is still pulling its image: wait for the container
  let state: { status: string; alive: boolean } | undefined;
  let last = "";
  for (let i = 0; i < 40 && !state; i++) {
    try {
      state = await scriptStateVia(exec, "sd-mrestore");
    } catch (e) {
      last = String(e instanceof Error ? e.message : e).slice(0, 200);
      await ctx.services.sleep(15_000);
    }
  }
  if (!state) throw new Error(`the mastodon container never became ready: ${last}`);
  if (state.status !== "done" && !(state.status === "running" && state.alive)) {
    const missing = await missingTools(shell);
    if (missing) {
      throw new AwaitUser(stepName, `the running Mastodon image cannot restore a backup (missing ${missing}): ${NEEDS_IMAGE}, then resume.`);
    }
    await createScratchDb(ctx, lease);
    await writeFile(shell, "/tmp/sd-mrestore.age", `${identity}\n`, "the restore's key");
    await writeFile(shell, "/tmp/sd-mrestore.env", envFile({ ...s3Env(storage), NAME: record.name }), "the restore settings");
    await writeFile(shell, "/tmp/sd-mrestore.sh", RESTORE_SCRIPT, "the restore script");
    await exec(startScriptCmd("sd-mrestore"));
    ctx.log(`mastodon: restoring ${record.name} into deployment ${lease.dseq}`);
  }
  const failure =
    state.status === "done"
      ? null
      : await watchScriptVia(ctx, exec, "sd-mrestore", {
          maxSecs: MAX_COPY_SECS,
          tick: (secs) => opts.progress?.(`restoring Mastodon from ${record.name}`, secs),
        });
  if (failure) {
    await stopScript(shell, "sd-mrestore", "rm -f /tmp/sd-mrestore.age");
    throw new AwaitUser(
      stepName,
      `restoring ${record.name} failed; the instance still runs on its own database:\n${failure}\nResume to try again.`,
    );
  }
  // the next restore (or a resume of this one) must download again, not
  // read this one's status as done
  const accounts = await swapInScratchDb(ctx, lease, stepName, kept).finally(() =>
    exec("rm -f /tmp/sd-mrestore.status").catch(() => undefined),
  );
  await restartMastodon(ctx, lease);
  ctx.log(`mastodon: restored ${accounts} accounts from ${record.name} (taken ${record.takenAt}) into ${lease.dseq}`);
  return accounts;
}

export interface MastodonBackupParams {
  auto?: boolean;
}

/** Back up the instance now ("mastodon-backup" op): upload, then the check. */
export function mastodonBackupSteps(opId: number, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const progress = (ctx: StepCtx) => (label: string, secs: number) =>
    ctx.db.setFleetOpProgress(opId, { label, elapsedSeconds: secs, updatedAt: new Date().toISOString() });
  return [
    {
      name: p("upload"),
      async run(ctx) {
        const record = await uploadMastodonBackup(ctx, spec, p("upload"), { progress: progress(ctx) }).finally(() =>
          ctx.db.setFleetOpProgress(opId, null),
        );
        return { name: record.name };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const record = await verifyMastodonBackup(ctx, spec, p("verify"), {
          retake: [p("upload")],
          attemptsKey: `mastodon-backup-verify-failures:${opId}`,
          progress: progress(ctx),
        }).finally(() => ctx.db.setFleetOpProgress(opId, null));
        ctx.db.setFleetOpStatus(opId, "done");
        return { verified: true, name: record.name };
      },
    },
  ];
}

export interface MastodonRestoreParams {
  /** the backup restored (its folder in the bucket) */
  name: string;
}

/** Replace the running instance's data with a recorded backup, in place ("mastodon-restore" op). */
export function mastodonRestoreSteps(opId: number, params: MastodonRestoreParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  return [
    {
      name: p("restore"),
      async run(ctx) {
        const record = mastodonBackups(ctx.db, ctx.launchId).find((r) => r.name === params.name);
        if (!record) throw new Error(`no Mastodon backup named ${params.name} is recorded for this fleet`);
        const accounts = await restoreMastodonBackup(ctx, spec, p("restore"), record, {
          progress: (label, secs) =>
            ctx.db.setFleetOpProgress(opId, { label, elapsedSeconds: secs, updatedAt: new Date().toISOString() }),
        }).finally(() => ctx.db.setFleetOpProgress(opId, null));
        ctx.db.setFleetOpStatus(opId, "done");
        return { name: record.name, accounts };
      },
    },
  ];
}

/**
 * A relaunched instance's restore, after its manifest and before anything
 * configures it (which would create a new owner and bridge token): the
 * latest checked backup, when automatic restore is on. Without a bucket or a
 * backup the instance starts empty, as a relaunch always did; a restore that
 * fails pauses, since going on would bury the data under a new instance.
 */
export function relaunchRestoreStep(name: string, spec: LaunchSpec): StepDef {
  return {
    name,
    async run(ctx) {
      const latest = latestMastodonBackup(ctx.db, ctx.launchId);
      if (!latest || !mastodonBackupStorage(spec, ctx.dirs.secrets)) {
        ctx.log("mastodon: no backup to restore; the new instance starts empty");
        return { restored: false };
      }
      if (!mastodonAutoRestore(ctx.db, ctx.launchId)) {
        ctx.log(`mastodon: automatic restore is off; the new instance starts empty (${latest.name} stays in the bucket)`);
        return { restored: false };
      }
      try {
        const accounts = await restoreMastodonBackup(ctx, spec, name, latest);
        return { restored: true, name: latest.name, accounts };
      } catch (e) {
        if (!(e instanceof AwaitUser)) throw e;
        // resumed with automatic restore turned off: start empty instead
        throw new AwaitUser(
          name,
          `${e.reason}\nTo start the instance empty instead, turn off automatic restore in Mastodon's backups… and resume.`,
        );
      }
    },
  };
}
