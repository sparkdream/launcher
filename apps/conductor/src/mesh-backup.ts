import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import { loadSdl, sdlArtifacts } from "./akash/sdl-groups.js";
import type { ConductorDb } from "./db.js";
import { AwaitUser, type StepCtx, type StepDef } from "./engine.js";
import { componentRow, sdlPathFor, updateOnChainAndPush } from "./fleet-ops.js";
import {
  ageIdentityAt,
  backupComplete,
  headscaleBackupPath,
  LIST_BACKUP_SCRIPT,
  SEED_STATIC_KEYS_SCRIPT,
  loadCert,
  resolveS3Secret,
  templateHeadscaleSdl,
} from "./steps/phase-bcd.js";

/**
 * Headscale mesh backup (§5 "Headscale backup"): litestream streams the
 * database to S3 (age-encrypted), and the static keys litestream does not
 * cover (noise_private.key, derp_server_private.key) go up once as
 * <path>/state-keys.tar.age, which the entrypoint restores on a fresh
 * volume. Without that archive a relaunch on another provider mints new
 * keys and every client of the mesh is locked out until it re-registers.
 *
 * The scripts (phase-bcd.ts) run inside the headscale container.
 */

export interface MeshBackupParams {
  /** where the backup goes, without the secret (it lives in the launch's secrets) */
  endpoint: string;
  bucket: string;
  path: string;
  /** spec.topology.headscale.backup before the request, put back when the op is
   *  abandoned before headscale got the new settings (null: there was none) */
  backupBefore?: unknown;
}

const unverifiedKey = (launchId: string) => `mesh-backup-unverified:${launchId}`;

/**
 * Whether the spec's headscale backup is still unproven: a mesh-backup op
 * wrote it into the spec and has not yet seen both halves land in the
 * bucket. Such a backup may be empty, so nothing may restore from it alone.
 */
export function meshBackupUnverified(db: ConductorDb, launchId: string): boolean {
  return db.getSetting(unverifiedKey(launchId)) !== null;
}

export function markMeshBackupUnverified(db: ConductorDb, launchId: string, opId: number): void {
  db.setSetting(unverifiedKey(launchId), String(opId));
}

/** Secret file a mesh-backup request replaces, kept until its op ends. */
export const S3_SECRET_FILE = "s3-backup";
const PREVIOUS_SECRET_FILE = "s3-backup.prev";

/** Keep the S3 secret file a request is about to overwrite. */
export function keepPreviousS3Secret(secretsDir: string): void {
  const file = path.join(secretsDir, S3_SECRET_FILE);
  const prev = path.join(secretsDir, PREVIOUS_SECRET_FILE);
  if (fs.existsSync(file)) fs.copyFileSync(file, prev);
  else fs.rmSync(prev, { force: true });
}

/**
 * Undo a mesh-backup op abandoned before headscale was updated: the spec
 * and secret go back to what they were. Past the update, headscale already
 * streams with the new settings, so they stay, still marked unverified.
 * Returns a note for the abort's caller in that case.
 */
export function undoMeshBackup(db: ConductorDb, secretsDir: string, launchId: string, opId: number, params: MeshBackupParams): string | undefined {
  if (db.getStep(launchId, `op${opId}:update`)?.status === "done") {
    return (
      "headscale already runs with the new backup settings, but the backup was never verified: " +
      "it is not trusted for a restore until back up mesh… completes"
    );
  }
  const launch = db.getLaunch(launchId);
  if (launch && params.backupBefore !== undefined) {
    const stored = JSON.parse(launch.spec_json);
    const { backup: _, ...headscale } = stored.topology.headscale;
    stored.topology.headscale = params.backupBefore ? { ...headscale, backup: params.backupBefore } : headscale;
    db.setLaunchSpec(launchId, JSON.stringify(stored));
    const file = path.join(secretsDir, S3_SECRET_FILE);
    const prev = path.join(secretsDir, PREVIOUS_SECRET_FILE);
    if (fs.existsSync(prev)) fs.renameSync(prev, file);
    else if (!params.backupBefore) fs.rmSync(file, { force: true });
  }
  if (db.getSetting(unverifiedKey(launchId)) === String(opId)) db.deleteSetting(unverifiedKey(launchId));
  return undefined;
}

/** Set (or replace) env entries in every service of an SDL document. */
export function withServiceEnv(text: string, values: Record<string, string>): string {
  const doc = yaml.load(text) as { services?: Record<string, { env?: string[] }> };
  for (const svc of Object.values(doc.services ?? {})) {
    const env = (svc.env ?? []).filter((e) => !(e.split("=")[0]! in values));
    svc.env = [...env, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
  }
  return yaml.dump(doc, { lineWidth: 120 });
}

export function meshBackupSteps(opId: number, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const backup = spec.topology.headscale.backup;
  const shell = (ctx: StepCtx, script: string) => {
    const row = componentRow(ctx, "headscale");
    return ctx.services.provider.shellExec(loadCert(ctx), row.host_uri, row.dseq, 1, 1, "headscale", ["sh", "-c", script]);
  };

  return [
    {
      // the running headscale's own SDL gains the backup env; nothing else
      // in it changes, so the update restarts it on the same volume (its
      // database and keys stay, and litestream starts streaming them)
      name: p("update"),
      async run(ctx) {
        if (!backup) throw new Error("the spec has no headscale backup configured");
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const row = componentRow(ctx, "headscale");
        const sdlPath = sdlPathFor(ctx, "headscale");
        const ageRecipient = ctx.output<{ ageRecipient: string }>("generate-keys")?.ageRecipient;
        const ageIdentity = ageIdentityAt(ctx.dirs.secrets);
        const secret = resolveS3Secret(backup, ctx.dirs.secrets);
        if (!ageRecipient || !ageIdentity) throw new Error("this launch has no age key pair to encrypt the backup with");
        if (!secret) throw new Error(`the S3 secret (${backup.s3.secretRef}) is missing from this launch`);
        const current = fs.existsSync(sdlPath)
          ? fs.readFileSync(sdlPath, "utf8")
          : yaml.dump(templateHeadscaleSdl(spec), { lineWidth: 120 });
        const text = withServiceEnv(current, {
          LITESTREAM_S3_ENDPOINT: backup.s3.endpoint,
          LITESTREAM_S3_BUCKET: backup.s3.bucket,
          LITESTREAM_S3_PATH: headscaleBackupPath(spec),
          LITESTREAM_S3_REGION: backup.s3.region,
          LITESTREAM_S3_ACCESS_KEY_ID: backup.s3.accessKeyId,
          LITESTREAM_S3_SECRET_ACCESS_KEY: secret,
          AGE_RECIPIENT: ageRecipient,
          AGE_IDENTITY: ageIdentity,
        });
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        await updateOnChainAndPush(ctx, owner, loadCert(ctx), p("update"), [
          { row, hash: Buffer.from(artifacts.hash).toString("base64"), manifestJson: artifacts.manifestJson },
        ]);
        return { path: headscaleBackupPath(spec) };
      },
    },
    {
      name: p("seed"),
      async run(ctx) {
        // the manifest push restarted headscale: wait for it, then upload
        // the static keys from inside (it has the env now)
        let last = "";
        for (let i = 0; i < 36; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          try {
            const res = await shell(ctx, SEED_STATIC_KEYS_SCRIPT);
            ctx.log(`headscale: ${res.stdout.trim()}`);
            return { seeded: true };
          } catch (e) {
            last = String(e instanceof Error ? e.message : e).slice(0, 300);
          }
        }
        // wrong credentials or bucket: the operator's to fix (resume after
        // editing them through the same action re-runs the whole op)
        throw new AwaitUser(
          p("seed"),
          `headscale could not upload its static keys to s3://${backup!.s3.bucket}/${headscaleBackupPath(spec)}: ` +
            `${last}\nCheck the bucket, its access key and secret, then resume.`,
        );
      },
    },
    {
      // proof, not hope: both halves of the backup are in the bucket. The
      // replica's first snapshot lands within litestream's first sync.
      name: p("verify"),
      async run(ctx) {
        let state = { archive: false, replica: false };
        for (let i = 0; i < 36 && !(state.archive && state.replica); i++) {
          if (i > 0) await ctx.services.sleep(5000);
          const res = await shell(ctx, LIST_BACKUP_SCRIPT).catch(() => ({ stdout: "" }));
          state = backupComplete(res.stdout);
        }
        if (!state.archive || !state.replica) {
          throw new AwaitUser(
            p("verify"),
            `the backup did not show up in s3://${backup!.s3.bucket}/${headscaleBackupPath(spec)}: ` +
              `${state.archive ? "" : "no state-keys.tar.age"}${!state.archive && !state.replica ? ", " : ""}` +
              `${state.replica ? "" : "no litestream replica"}. Check the bucket's credentials and ` +
              "the headscale log (litestream reports its upload errors there), then resume.",
          );
        }
        ctx.db.deleteSetting(unverifiedKey(ctx.launchId));
        fs.rmSync(path.join(ctx.dirs.secrets, PREVIOUS_SECRET_FILE), { force: true });
        ctx.db.setFleetOpStatus(opId, "done");
        return state;
      },
    },
  ];
}
