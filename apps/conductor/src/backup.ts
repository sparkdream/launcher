import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type {
  ConductorDb,
  FleetComponentRow,
  FleetOpRow,
  LaunchRow,
  PendingGentxRow,
  PendingTxRow,
  StepRow,
} from "./db.js";
import { launchDirs } from "./engine.js";
import { copySecretsDecrypted, copySecretsEncrypted } from "./secrets.js";

/**
 * Full launcher backup (export/import): one passphrase-encrypted archive
 * holding a consistent state.db snapshot plus every launch's secrets and
 * node homes, so the launcher can move to another machine. Caches
 * (chain-assets, sdl, bundles, component_health) are excluded: they are
 * re-derived on the target.
 *
 * Outer layer: "SDLBAK1\n" magic, 16-byte random salt, 12-byte IV,
 * AES-256-GCM ciphertext, 16-byte auth tag. Key = scrypt(passphrase, salt).
 * The salt is random (unlike secrets.ts's fixed one) because this file is
 * meant to leave the machine. The age CLI's passphrase mode needs a TTY, so
 * node crypto is used instead. Inner payload: tar.gz of the staged tree.
 */

const MAGIC = Buffer.from("SDLBAK1\n");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const BACKUP_KIND = "launcher-backup";
const BACKUP_VERSION = 1;

/** User-facing failures (wrong passphrase, bad file) — routes map to 400. */
export class BackupError extends Error {}

export interface BackupManifest {
  kind: string;
  version: number;
  launcherVersion: string;
  createdAt: string;
  launchIds: string[];
}

export interface ImportReport {
  restored: string[];
  skipped: string[];
  settingsAdded: string[];
  prefsAdded: number;
}

export async function passphraseEncryptFile(
  src: string,
  passphrase: string,
  out: string,
): Promise<void> {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const dest = fs.createWriteStream(out);
  dest.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, dest);
  fs.appendFileSync(out, cipher.getAuthTag());
}

export async function passphraseDecryptFile(
  src: string,
  passphrase: string,
  out: string,
): Promise<void> {
  const headerLen = MAGIC.length + SALT_LEN + IV_LEN;
  const size = fs.statSync(src).size;
  if (size < headerLen + TAG_LEN) throw new BackupError("not a launcher backup file");
  const fd = fs.openSync(src, "r");
  const header = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, header, 0, headerLen, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError("not a launcher backup file");
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(src, { start: headerLen, end: size - TAG_LEN - 1 }),
      decipher,
      fs.createWriteStream(out),
    );
  } catch {
    throw new BackupError("wrong passphrase or corrupted archive");
  }
}

function tarCz(srcDir: string, outFile: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["czf", outFile, "-C", srcDir, "."]);
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
    tar.on("error", reject);
  });
}

function launcherVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class BackupService {
  constructor(
    private readonly db: ConductorDb,
    private readonly workRoot: string,
  ) {}

  /** Build the encrypted archive; caller streams then deletes the file. */
  async exportBackup(passphrase: string): Promise<string> {
    const stage = fs.mkdtempSync(path.join(this.workRoot, "backup-stage-"));
    const tarPath = `${stage}.tar.gz`;
    try {
      await this.db.backupTo(path.join(stage, "state.db"));
      const launches = this.db.listLaunches();
      for (const launch of launches) {
        const dirs = launchDirs(this.workRoot, launch.id);
        const dest = path.join(stage, "launches", launch.id);
        if (fs.existsSync(dirs.secrets)) {
          // decrypted inside the passphrase encryption — portable across
          // instances with different LAUNCHER_SECRETs
          copySecretsDecrypted(dirs.secrets, path.join(dest, "secrets"));
        }
        const nodes = path.join(dirs.root, "nodes");
        if (fs.existsSync(nodes)) {
          fs.cpSync(nodes, path.join(dest, "nodes"), { recursive: true });
        }
      }
      const manifest: BackupManifest = {
        kind: BACKUP_KIND,
        version: BACKUP_VERSION,
        launcherVersion: launcherVersion(),
        createdAt: new Date().toISOString(),
        launchIds: launches.map((l) => l.id),
      };
      fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
      await tarCz(stage, tarPath);
      const out = path.join(this.workRoot, `launcher-backup-${crypto.randomUUID()}.tar.gz.enc`);
      await passphraseEncryptFile(tarPath, passphrase, out);
      return out;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(tarPath, { force: true });
    }
  }

  /**
   * Merge-import: launches whose id already exists here are skipped; new
   * ones are restored files-first (secrets re-encrypted under the local
   * LAUNCHER_SECRET, node homes verbatim), DB rows last in one transaction,
   * so a crash never leaves a launch row without its secrets. Settings and
   * wallet-global provider prefs only fill gaps.
   */
  async importBackup(archivePath: string, passphrase: string): Promise<ImportReport> {
    const tmp = fs.mkdtempSync(path.join(this.workRoot, "backup-import-"));
    try {
      const tarPath = path.join(tmp, "backup.tar.gz");
      await passphraseDecryptFile(archivePath, passphrase, tarPath);
      try {
        execFileSync("tar", ["xzf", tarPath, "-C", tmp]);
      } catch {
        throw new BackupError("archive is not a valid backup tarball");
      }
      const manifestPath = path.join(tmp, "manifest.json");
      if (!fs.existsSync(manifestPath)) throw new BackupError("archive has no manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
      if (manifest.kind !== BACKUP_KIND) throw new BackupError("not a launcher backup archive");
      if (manifest.version > BACKUP_VERSION) {
        throw new BackupError(
          `backup was made by a newer launcher (format v${manifest.version}); update this launcher first`,
        );
      }
      const snapPath = path.join(tmp, "state.db");
      if (!fs.existsSync(snapPath)) throw new BackupError("archive has no state.db snapshot");
      const snap = new Database(snapPath, { readonly: true, fileMustExist: true });
      try {
        return this.merge(snap, tmp);
      } finally {
        snap.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private merge(snap: Database.Database, extractedDir: string): ImportReport {
    // SELECT * + defaults tolerates snapshots from older schemas (missing
    // columns get null/0); named-parameter binding ignores newer extras.
    const rows = <T>(sql: string, ...params: unknown[]): T[] =>
      snap.prepare(sql).all(...params) as T[];
    const report: ImportReport = { restored: [], skipped: [], settingsAdded: [], prefsAdded: 0 };

    for (const launch of rows<LaunchRow>("SELECT * FROM launches ORDER BY created_at")) {
      if (this.db.getLaunch(launch.id)) {
        report.skipped.push(launch.id);
        continue;
      }
      const dirs = launchDirs(this.workRoot, launch.id);
      const src = path.join(extractedDir, "launches", launch.id);
      try {
        // files first, DB row last: a launch row must never exist without
        // its secrets
        fs.mkdirSync(dirs.root, { recursive: true });
        if (fs.existsSync(path.join(src, "secrets"))) {
          copySecretsEncrypted(path.join(src, "secrets"), dirs.secrets);
          fs.chmodSync(dirs.secrets, 0o700);
        }
        if (fs.existsSync(path.join(src, "nodes"))) {
          fs.cpSync(path.join(src, "nodes"), path.join(dirs.root, "nodes"), { recursive: true });
        }
        this.db.restoreLaunch({
          launch,
          steps: rows<Partial<StepRow>>(
            "SELECT * FROM launch_steps WHERE launch_id = ? ORDER BY id",
            launch.id,
          ).map(
            (s) =>
              ({
                started_at: null,
                finished_at: null,
                output_json: null,
                error: null,
                ...s,
              }) as Omit<StepRow, "id">,
          ),
          components: rows<Partial<FleetComponentRow>>(
            "SELECT * FROM fleet_components WHERE launch_id = ? ORDER BY id",
            launch.id,
          ).map(
            (c) =>
              ({
                generation: 0,
                ssh_host: null,
                ssh_port: null,
                tailnet_ip: null,
                image: null,
                ...c,
              }) as Omit<FleetComponentRow, "id">,
          ),
          ops: rows<FleetOpRow>("SELECT * FROM fleet_ops WHERE launch_id = ? ORDER BY id", launch.id),
          gentxs: rows<Partial<PendingGentxRow>>(
            "SELECT * FROM pending_gentxs WHERE launch_id = ? ORDER BY id",
            launch.id,
          ).map((g) => ({ response_json: null, ...g }) as Omit<PendingGentxRow, "id">),
          txs: rows<Partial<PendingTxRow>>(
            "SELECT * FROM pending_txs WHERE launch_id = ? ORDER BY id",
            launch.id,
          ).map((t) => ({ tx_hash: null, ...t }) as Omit<PendingTxRow, "id">),
          prefs: rows<{ launch_id: string; provider: string; kind: string; name?: string | null }>(
            "SELECT * FROM provider_prefs WHERE launch_id = ?",
            launch.id,
          ).map((p) => ({ name: null, ...p })),
        });
        report.restored.push(launch.id);
      } catch (e) {
        fs.rmSync(dirs.root, { recursive: true, force: true });
        throw new Error(`restoring launch ${launch.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    for (const s of rows<{ key: string; value: string }>("SELECT key, value FROM settings")) {
      if (this.db.addSettingIfAbsent(s.key, s.value)) report.settingsAdded.push(s.key);
    }
    for (const p of rows<{ owner: string; provider: string; kind: string; name: string | null }>(
      "SELECT * FROM provider_prefs_global",
    )) {
      if (this.db.addProviderPrefIfAbsent(p.owner, p.provider, p.kind, p.name ?? null)) {
        report.prefsAdded++;
      }
    }
    return report;
  }
}
