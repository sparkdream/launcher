import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AwaitUser, type StepCtx } from "../engine.js";
import { readSecretBuffer, writeSecretFile } from "../secrets.js";
import { componentLease } from "../sessions.js";
import { loadCert } from "./phase-bcd.js";

/**
 * Carrying a Mastodon instance's data from one deployment to another (a
 * resize: Akash fixes a deployment's resources, so a new size is a new
 * deployment, and its volumes start empty).
 *
 * What moves is what cannot be rebuilt: the database (accounts, posts,
 * follows, the accounts' ActivityPub keys, the bridge's app token) and the
 * uploaded media under public/system, minus the remote-media cache, which
 * the instance fetches again. Redis (queues, caches) and the bridge's state
 * file (a cache of what the chain already holds) start over.
 *
 * Lease-shell is the only way in (no sshd in these images). Its stdout
 * streams, so a backup is one command per artifact, base64 on the wire. It
 * has no usable stdin, so a restore appends base64 chunks through the
 * command itself, then decodes and checks the digest before touching the
 * database. The backup is kept encrypted with the launcher's other secrets,
 * since the dump holds every account's signing key and password hash.
 */

/** A backup bigger than this pauses: pushing it back in over lease-shell
 *  chunks would take hours. */
const MAX_BYTES = 256 * 1024 * 1024;
/** Base64 characters per upload command; halved when a provider refuses a
 *  long request line. */
const CHUNK = 48_000;
const DB = "mastodon";
export const MEDIA = "/opt/mastodon/public/system";

export interface MastodonBackup {
  /** The deployment the data came from. */
  dseq: string;
  dir: string;
  db: { bytes: number; sha256: string };
  media: { bytes: number; sha256: string } | null;
  at: string;
}

function backupDir(ctx: StepCtx, dseq: string): string {
  return path.join(ctx.dirs.secrets, "backups", `mastodon-${dseq}`);
}

export type Lease = { hostUri: string; dseq: string; gseq: number; oseq: number };

export function shell(ctx: StepCtx, lease: Lease, service: string, script: string, timeoutMs = 60_000) {
  return ctx.services.provider.shellExec(
    loadCert(ctx), lease.hostUri, lease.dseq, lease.gseq, lease.oseq, service, ["sh", "-c", script], { timeoutMs },
  );
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** One artifact out of a container: the command's stdout is base64. */
async function pull(ctx: StepCtx, lease: Lease, service: string, script: string): Promise<Buffer> {
  const { stdout } = await shell(ctx, lease, service, `set -o pipefail 2>/dev/null; ${script} | base64 -w0`, 15 * 60_000);
  const text = stdout.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error(`${service}: the backup stream was not base64`);
  return Buffer.from(text, "base64");
}

/**
 * Back up the running instance (the deployment the fleet row names). Runs
 * before the old deployment closes; posts made after it are not carried.
 */
export async function backupMastodon(ctx: StepCtx, stepName: string): Promise<MastodonBackup> {
  const lease = componentLease(ctx, "mastodon");
  // the media lives on the web container's volume: a container that does
  // not run (2026-10-14: a pod wedged on a bad image) leaves only the
  // database to carry. That loses the media, so the move asks once, and
  // resuming is the operator's go-ahead (0 below: no media to copy)
  const withoutMedia = `mastodon-move-without-media:${ctx.launchId}:${stepName}`;
  let measured = 0;
  try {
    measured = await shell(
      ctx, lease, "mastodon",
      // du's --exclude matches names (tar's below matches ./-relative paths)
      `du -sb --exclude=cache --exclude=lost+found ${MEDIA} 2>/dev/null | cut -f1`,
    ).then((r) => Number(r.stdout.trim()) || 0);
    ctx.db.deleteSetting(withoutMedia);
  } catch (e) {
    if (ctx.db.getSetting(withoutMedia) === null) {
      ctx.db.setSetting(withoutMedia, "asked");
      throw new AwaitUser(
        stepName,
        `Mastodon's web container does not answer (${String(e instanceof Error ? e.message : e).slice(0, 160)}), ` +
          "so its uploaded media (local avatars and attachments) cannot be copied; the database can. Nothing has " +
          "been closed yet. Resume to move without the media: accounts, posts, follows, the owner and the bridge " +
          "token come along, and remote media is fetched again. Or abort the op to keep the instance as it is.",
      );
    }
    ctx.log("mastodon: the web container does not answer; moving the database only, as resumed");
  }
  const dbSize = await shell(ctx, lease, "db", `psql -U postgres -tAc "select pg_database_size('${DB}')"`)
    .then((r) => Number(r.stdout.trim()) || 0);
  if (measured + dbSize > MAX_BYTES) {
    throw new AwaitUser(
      stepName,
      `this instance holds ${Math.round((measured + dbSize) / 1048576)} MiB (database and uploaded media), ` +
        `more than the ${MAX_BYTES / 1048576} MiB a resize carries over lease-shell. Abort the op; ` +
        "set a backup bucket for Mastodon (backups… on its row) and resize again: the move then goes through the bucket",
    );
  }

  const dump = await pull(ctx, lease, "db", `pg_dump -U postgres -Fc ${DB}`);
  if (dump.length === 0) throw new Error("the database dump came back empty");
  const media = measured > 0
    ? await pull(ctx, lease, "mastodon", `cd ${MEDIA} && tar --exclude=./cache --exclude=./lost+found -czf - .`)
    : null;

  const dir = backupDir(ctx, lease.dseq);
  writeSecretFile(path.join(dir, "db.dump"), dump);
  if (media) writeSecretFile(path.join(dir, "media.tgz"), media);
  const out: MastodonBackup = {
    dseq: lease.dseq,
    dir,
    db: { bytes: dump.length, sha256: sha256(dump) },
    media: media ? { bytes: media.length, sha256: sha256(media) } : null,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify(out, null, 2));
  ctx.log(
    `mastodon: backed up deployment ${lease.dseq}: database ${dump.length} bytes` +
      (media ? `, media ${media.length} bytes` : ", no uploaded media"),
  );
  return out;
}

/** Put a file into a container, chunk by chunk, and check what arrived. */
async function push(ctx: StepCtx, lease: Lease, service: string, dest: string, data: Buffer): Promise<void> {
  const b64 = data.toString("base64");
  const staging = `${dest}.b64`;
  await shell(ctx, lease, service, `: > ${staging}`);
  let size = CHUNK;
  for (let at = 0; at < b64.length; ) {
    const chunk = b64.slice(at, at + size);
    try {
      // base64 is quote-safe inside single quotes
      await shell(ctx, lease, service, `printf '%s' '${chunk}' >> ${staging}`);
      at += chunk.length;
    } catch (e) {
      // a provider with a short request-line limit refuses the long URL
      // before running anything: nothing was appended, retry smaller
      if (size > 4000 && /414|too large|too long|header/i.test(String(e))) {
        size = Math.floor(size / 2);
        continue;
      }
      throw e;
    }
  }
  const { stdout } = await shell(
    ctx, lease, service,
    `base64 -d ${staging} > ${dest} && rm -f ${staging} && sha256sum ${dest} | cut -c1-64`,
  );
  if (stdout.trim() !== sha256(data)) {
    throw new Error(`${service}: ${dest} arrived damaged (digest mismatch); the step retries the upload`);
  }
}

/** Retry a command while the container is still coming up. */
export async function whenUp(ctx: StepCtx, lease: Lease, service: string, script: string, what: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    try {
      return (await shell(ctx, lease, service, script)).stdout;
    } catch (e) {
      last = String(e).slice(0, 200);
      await ctx.services.sleep(15_000);
    }
  }
  throw new Error(`${what} never became ready: ${last}`);
}

/**
 * Restore a backup into the freshly leased deployment, before anything
 * configures it: otherwise the empty instance would get a new owner account
 * and a new bridge token. The web container has meanwhile prepared an empty
 * schema; the dump goes into a scratch database first and only then replaces
 * it, so a failed restore leaves an instance that still starts. Mastodon is
 * restarted last, which migrates the restored schema to the running image.
 */
export async function restoreMastodon(
  ctx: StepCtx,
  stepName: string,
  backup: MastodonBackup,
): Promise<{ dseq: string; restoredFrom: string; accounts: number }> {
  const lease = componentLease(ctx, "mastodon");
  if (lease.dseq === backup.dseq) {
    throw new Error(`restore target is the deployment the backup came from (${lease.dseq})`);
  }
  const dump = readSecretBuffer(path.join(backup.dir, "db.dump"));
  if (sha256(dump) !== backup.db.sha256) throw new Error(`the backup in ${backup.dir} does not match its record`);

  await createScratchDb(ctx, lease);
  await push(ctx, lease, "db", "/tmp/restore.dump", dump);
  // pg_restore reports harmless noise (extension comments owned by another
  // role) with a non-zero exit, so the check is the data itself
  await shell(
    ctx, lease, "db",
    `pg_restore -U postgres --no-owner --role=postgres -d ${SCRATCH_DB} /tmp/restore.dump 2>&1 | tail -5; true`,
    15 * 60_000,
  );
  const accounts = await swapInScratchDb(ctx, lease, stepName, `the backup is kept in ${backup.dir}`);
  await shell(ctx, lease, "db", "rm -f /tmp/restore.dump").catch(() => undefined);

  if (backup.media) {
    const media = readSecretBuffer(path.join(backup.dir, "media.tgz"));
    await whenUp(ctx, lease, "mastodon", `test -d ${MEDIA} && echo ok`, "mastodon");
    await push(ctx, lease, "mastodon", "/tmp/media.tgz", media);
    await shell(ctx, lease, "mastodon", `tar -xzf /tmp/media.tgz -C ${MEDIA} && chown -R 991:991 ${MEDIA} && rm -f /tmp/media.tgz`, 15 * 60_000);
  }

  await restartMastodon(ctx, lease);
  ctx.log(`mastodon: restored ${accounts} accounts from deployment ${backup.dseq} into ${lease.dseq}`);
  return { dseq: lease.dseq, restoredFrom: backup.dseq, accounts };
}

/** The database a restore fills before it replaces the instance's own. */
export const SCRATCH_DB = `${DB}_restore`;

/** A fresh, empty scratch database (postgres must be up). */
export async function createScratchDb(ctx: StepCtx, lease: Lease): Promise<void> {
  await whenUp(ctx, lease, "db", "pg_isready -U postgres -q && echo ok", "postgres");
  await shell(
    ctx, lease, "db",
    `psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}" -c "CREATE DATABASE ${SCRATCH_DB}"`,
  );
}

/**
 * Replace the instance's database with the restored scratch one, once it
 * holds accounts (a restore that produced none pauses, `kept` saying where
 * the backup still is). Returns the account count.
 */
export async function swapInScratchDb(ctx: StepCtx, lease: Lease, stepName: string, kept: string): Promise<number> {
  const accounts = Number(
    (await shell(ctx, lease, "db", `psql -U postgres -d ${SCRATCH_DB} -tAc "select count(*) from accounts"`)).stdout.trim(),
  );
  if (!Number.isFinite(accounts) || accounts < 1) {
    throw new AwaitUser(
      stepName,
      `the restored database has no accounts (${accounts}); ${kept}. ` +
        "The instance still runs on its own database. Inspect, then resume to retry the restore",
    );
  }
  // swap: two statements in one session, a moment apart, so the instance's
  // restart cannot prepare a new empty schema in between
  await shell(
    ctx, lease, "db",
    `psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" ` +
      `-c "ALTER DATABASE ${SCRATCH_DB} RENAME TO ${DB}"`,
  );
  return accounts;
}

/** Restart web + sidekiq: rails db:prepare migrates the restored schema, and
 *  the processes reconnect to the database that replaced the one they held.
 *  Streaming too: the swap's forced drop cut its connection, and left to
 *  crash it came back only after Kubernetes' restart back-off (2026-10-14:
 *  ~7 minutes, past the move's health gate). Its node is PID 1 and exits
 *  cleanly on SIGTERM. */
export async function restartMastodon(ctx: StepCtx, lease: Lease): Promise<void> {
  await shell(ctx, lease, "mastodon", "kill 1").catch(() => undefined);
  await shell(ctx, lease, "streaming", "kill 1").catch(() => undefined);
}
