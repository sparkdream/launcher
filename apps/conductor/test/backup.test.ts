import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { BackupService, passphraseDecryptFile, passphraseEncryptFile } from "../src/backup.js";
import { writeSecretFile, readSecretFile } from "../src/secrets.js";
import { allSteps, buildServer } from "../src/index.js";
import { fakeServices } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-backup-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.LAUNCHER_SECRET;
});

/** A launcher instance with one launch's rows and on-disk keys, no fake
 *  world needed: backup cares about state fidelity, not launch mechanics. */
function seeded() {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const spec = testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
  });
  db.createLaunch("bk", JSON.stringify(spec), "akash1owner");
  db.setLaunchStatus("bk", "completed");
  db.stepStarted("bk", "generate-keys");
  db.stepDone("bk", "generate-keys", { ageRecipient: "age1fake" });
  db.upsertFleetComponent({
    launch_id: "bk",
    key: "val-0",
    dseq: "12345",
    provider: "akash1prov",
    host_uri: "https://prov:8443",
    price: "1.5",
    state: "active",
    ssh_host: "1.2.3.4",
    ssh_port: 22,
  });
  db.createFleetOp("bk", "relaunch", { key: "val-0" });
  db.enqueuePendingTx("bk", "create-deployments", "[]");
  db.enqueuePendingGentx("bk", 1, "sprkdrm1ext", "{}");
  db.setSetting("chain_asset_mode", "offline");
  db.setProviderPref("akash1owner", "akash1prov", "prefer", "Good Provider");

  const secrets = path.join(work, "launches/bk/secrets");
  writeSecretFile(path.join(secrets, "mnemonics.json"), '{"val-0":"word word word"}');
  const nodeCfg = path.join(work, "launches/bk/nodes/val-0/config");
  fs.mkdirSync(nodeCfg, { recursive: true });
  fs.writeFileSync(path.join(nodeCfg, "node_key.json"), '{"priv_key":"fake"}');
  fs.writeFileSync(path.join(nodeCfg, "priv_validator_key.json"), '{"priv_key":"fake-consensus"}');
  const keyring = path.join(work, "launches/bk/nodes/val-0/keyring-test");
  fs.mkdirSync(keyring, { recursive: true });
  fs.writeFileSync(path.join(keyring, "master.info"), "keyring-entry");
  return { work, db };
}

function fresh() {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  return { work, db };
}

describe("passphrase file encryption", () => {
  it("round-trips and rejects tampering and wrong passphrases", async () => {
    const dir = tmp();
    const src = path.join(dir, "payload");
    fs.writeFileSync(src, "hello backup");
    const enc = path.join(dir, "payload.enc");
    await passphraseEncryptFile(src, "hunter2", enc);

    const out = path.join(dir, "payload.out");
    await passphraseDecryptFile(enc, "hunter2", out);
    expect(fs.readFileSync(out, "utf8")).toBe("hello backup");

    await expect(passphraseDecryptFile(enc, "wrong", out)).rejects.toThrow(/wrong passphrase/);

    const bytes = fs.readFileSync(enc);
    bytes[bytes.length - 20] ^= 0xff; // flip a ciphertext bit
    fs.writeFileSync(enc, bytes);
    await expect(passphraseDecryptFile(enc, "hunter2", out)).rejects.toThrow(/wrong passphrase/);

    fs.writeFileSync(enc, "not a backup at all");
    await expect(passphraseDecryptFile(enc, "hunter2", out)).rejects.toThrow(/not a launcher backup/);
  });
});

describe("launcher backup", () => {
  it("round-trips the whole launcher into a fresh instance", async () => {
    const a = seeded();
    const archive = await new BackupService(a.db, a.work).exportBackup("hunter2");
    expect(fs.existsSync(archive)).toBe(true);
    // staging is cleaned up
    expect(fs.readdirSync(a.work).filter((f) => f.startsWith("backup-stage-"))).toEqual([]);

    const b = fresh();
    const report = await new BackupService(b.db, b.work).importBackup(archive, "hunter2");
    expect(report.restored).toEqual(["bk"]);
    expect(report.skipped).toEqual([]);
    expect(report.settingsAdded).toContain("chain_asset_mode");
    expect(report.prefsAdded).toBe(1);

    const launch = b.db.getLaunch("bk")!;
    expect(launch.owner).toBe("akash1owner");
    expect(launch.status).toBe("completed");
    expect(b.db.stepOutput<{ ageRecipient: string }>("bk", "generate-keys")).toEqual({
      ageRecipient: "age1fake",
    });
    const comp = b.db.listFleetComponents("bk")[0]!;
    expect(comp.dseq).toBe("12345");
    expect(comp.ssh_host).toBe("1.2.3.4");
    expect(b.db.listFleetOps("bk")).toHaveLength(1);
    expect(b.db.getPendingTx("bk", "create-deployments")).toBeTruthy();
    expect(b.db.getPendingGentx("bk", 1)).toBeTruthy();
    expect(b.db.getSetting("chain_asset_mode")).toBe("offline");
    expect(b.db.providerPrefs("akash1owner").prefer).toEqual(["akash1prov"]);

    expect(readSecretFile(path.join(b.work, "launches/bk/secrets/mnemonics.json"))).toContain(
      "word word word",
    );
    expect(
      fs.readFileSync(path.join(b.work, "launches/bk/nodes/val-0/config/node_key.json"), "utf8"),
    ).toContain("fake");
    expect(
      fs.existsSync(path.join(b.work, "launches/bk/nodes/val-0/keyring-test/master.info")),
    ).toBe(true);
    a.db.close();
    b.db.close();
  });

  it("moves secrets between instances with different LAUNCHER_SECRETs", async () => {
    process.env.LAUNCHER_SECRET = "secret-a";
    const a = seeded(); // mnemonics.json written encrypted under secret-a
    const archive = await new BackupService(a.db, a.work).exportBackup("hunter2");

    process.env.LAUNCHER_SECRET = "secret-b";
    const b = fresh();
    await new BackupService(b.db, b.work).importBackup(archive, "hunter2");
    // readable under the new instance's secret (re-encrypted on import)
    expect(readSecretFile(path.join(b.work, "launches/bk/secrets/mnemonics.json"))).toContain(
      "word word word",
    );
    process.env.LAUNCHER_SECRET = "secret-a";
    expect(() =>
      readSecretFile(path.join(b.work, "launches/bk/secrets/mnemonics.json")),
    ).toThrow();
    a.db.close();
    b.db.close();
  });

  it("merge-import skips launches that already exist and never overwrites settings", async () => {
    const a = seeded();
    const archive = await new BackupService(a.db, a.work).exportBackup("hunter2");

    // re-import into the source: everything conflicts
    a.db.setSetting("chain_asset_mode", "online"); // local value differs from the archived one
    const report = await new BackupService(a.db, a.work).importBackup(archive, "hunter2");
    expect(report.restored).toEqual([]);
    expect(report.skipped).toEqual(["bk"]);
    expect(report.settingsAdded).toEqual([]);
    expect(a.db.getSetting("chain_asset_mode")).toBe("online"); // local wins
    a.db.close();
  });

  it("serves export and import over the API with passphrase errors as 400", async () => {
    const a = seeded();
    const appA = buildServer({
      db: a.db,
      services: fakeServices(),
      workRoot: a.work,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    const noPass = await appA.inject({ method: "POST", url: "/api/backup/export", payload: {} });
    expect(noPass.statusCode).toBe(400);

    const res = await appA.inject({
      method: "POST",
      url: "/api/backup/export",
      payload: { passphrase: "hunter2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("launcher-backup-");
    const archive = res.rawPayload;

    const b = fresh();
    const appB = buildServer({
      db: b.db,
      services: fakeServices(),
      workRoot: b.work,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    const bad = await appB.inject({
      method: "POST",
      url: "/api/backup/import",
      headers: { "content-type": "application/octet-stream", "x-backup-passphrase": "wrong" },
      payload: archive,
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as any).error).toContain("wrong passphrase");

    const ok = await appB.inject({
      method: "POST",
      url: "/api/backup/import",
      headers: { "content-type": "application/octet-stream", "x-backup-passphrase": "hunter2" },
      payload: archive,
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as any).restored).toEqual(["bk"]);
    expect(b.db.getLaunch("bk")).toBeTruthy();
    a.db.close();
    b.db.close();
  });
});
