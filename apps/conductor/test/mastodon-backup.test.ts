import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chainId, testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { MASTODON_S3_SECRET_FILE, mastodonBackups } from "../src/mastodon-backup.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-mbackup-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

process.env.TEST_MASTO_S3_SECRET = "mesh-s3cr3t";

const DOMAIN = "social.phoenix.example";
const owner = { username: "admin", email: "admin@phoenix.example" };
const off = { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } };
const meshBucket = {
  s3: { endpoint: "https://endpoint.4everland.co", bucket: "meshbk", region: "us-west-2", accessKeyId: "AK", secretRef: "env:TEST_MASTO_S3_SECRET" },
};

/** A chain fleet whose Mastodon backs up to the mesh backup's bucket. */
function chainSpec(): LaunchSpec {
  return testnetSpec({
    network: { name: "phoenix", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { ...off, mastodon: { enabled: true, domain: DOMAIN, owner } },
      headscale: { domain: "hs.phoenix.example", backup: meshBucket },
    },
  });
}

/** A services fleet: no mesh, so no bucket until Mastodon is given one. */
function servicesSpec(): LaunchSpec {
  return testnetSpec({
    kind: "services",
    network: { name: "zenith-commons", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { ...off, mastodon: { enabled: true, domain: DOMAIN, owner } },
      headscale: {},
    },
  } as any);
}

interface World {
  id: string;
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  fleet: FleetService;
  signer: FakeSigner;
}

async function launched(s: LaunchSpec, id = "fl"): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  db.createLaunch(id, JSON.stringify(s), "akash1owner");
  const result = await runWithSigner(db, id, s, work, allSteps(s), services, signer);
  expect(result.reason ?? "").toBe("");
  const fleet = new FleetService(db, services, work);
  fleet.materialize(id);
  return { id, work, db, services, fleet, signer };
}

async function driveOps(w: World) {
  const s = withDefaults(JSON.parse(w.db.getLaunch(w.id)!.spec_json));
  const steps = [...buildPreLaunchOpSteps(w.db, w.id), ...allSteps(s), ...buildOpSteps(w.db, w.id)];
  return runWithSigner(w.db, w.id, s, w.work, steps, w.services, w.signer);
}

const launchRow = (w: World) => w.db.getLaunch(w.id)!;
const mastodonRow = (w: World) => w.db.listFleetComponents(w.id).find((c) => c.key === "mastodon")!;
const instance = (w: World) => w.services.provider.mastodon.get(mastodonRow(w).dseq)!;
const objects = (w: World) => [...w.services.provider.mastodonBucket.keys()].sort();

async function backUp(w: World): Promise<number> {
  const opId = w.fleet.requestMastodonBackup(launchRow(w));
  const done = await driveOps(w);
  expect(done.reason ?? "").toBe("");
  expect(done.status).toBe("completed");
  expect(w.db.listFleetOps(w.id).find((o) => o.id === opId)!.status).toBe("done");
  return opId;
}

describe("Mastodon backups: where they go", () => {
  it("a chain fleet's go to the mesh backup's bucket, under a mastodon prefix of their own", async () => {
    const w = await launched(chainSpec());
    instance(w).token = "token-original";
    w.services.provider.mastodonMedia.set(mastodonRow(w).dseq, Buffer.from("avatars"));
    await backUp(w);

    const [record] = mastodonBackups(w.db, w.id);
    expect(record).toMatchObject({ dseq: mastodonRow(w).dseq, verified: true });
    expect(record!.name).toMatch(/^mastodon-\d{8}T\d{6}Z$/);
    expect(record!.dbSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record!.mediaSha256).toMatch(/^[0-9a-f]{64}$/);
    // the size of each object as uploaded, for the dialog
    expect(record!.mediaBytes).toBe("avatars".length);
    expect(record!.dbBytes).toBeGreaterThan(0);
    const prefix = `meshbk/sparkdream-launcher/${chainId(chainSpec())}/mastodon/${record!.name}`;
    expect(objects(w)).toEqual([`${prefix}/db.dump.age`, `${prefix}/media.tar.age`]);
    // the bucket's secret never crossed a command line as itself
    expect(w.services.provider.shellLog.some((l) => l.script.includes("mesh-s3cr3t"))).toBe(false);
    // the check got the age identity it needs, through the same kind of file
    expect(w.services.provider.shellLog.some((l) => l.script.includes("/tmp/sd-mverify.age"))).toBe(true);
  }, 180_000);

  it("a services fleet needs a bucket of its own, kept in the spec without its secret", async () => {
    const w = await launched(servicesSpec(), "svc");
    expect(() => w.fleet.requestMastodonBackup(launchRow(w))).toThrow(/no backup bucket/);
    expect(() => w.fleet.setMastodonBackupSchedule(launchRow(w), "daily")).toThrow(/no backup bucket/);
    // no secret given and none held for this key anywhere
    expect(() =>
      w.fleet.setMastodonBackupStorage(launchRow(w), { endpoint: "https://s3.example", bucket: "own", accessKeyId: "AK2" }),
    ).toThrow(/secret key is required/);
    w.fleet.setMastodonBackupStorage(launchRow(w), {
      endpoint: "https://s3.example",
      bucket: "own",
      accessKeyId: "AK2",
      secret: "own-s3cr3t",
    });
    const stored = JSON.parse(launchRow(w).spec_json).topology.components.mastodon.backup;
    expect(stored.s3).toMatchObject({ bucket: "own", accessKeyId: "AK2", secretRef: `secret:${MASTODON_S3_SECRET_FILE}` });
    expect(launchRow(w).spec_json).not.toContain("own-s3cr3t");

    await backUp(w);
    const [record] = mastodonBackups(w.db, w.id);
    expect(objects(w)[0]).toBe(`own/sparkdream-launcher/${chainId(servicesSpec())}/mastodon/${record!.name}/db.dump.age`);
    expect(w.services.provider.shellLog.some((l) => l.script.includes("own-s3cr3t"))).toBe(false);

    // the fleet card sees where they go, never the secret
    const view = await w.fleet.fleetForOwner("akash1owner");
    const card = view.fleets.find((f: any) => f.launchId === "svc") as any;
    expect(card.mastodonBackups.storage).toEqual({
      bucket: "own",
      path: `sparkdream-launcher/${chainId(servicesSpec())}/mastodon`,
      own: true,
    });
    expect(card.mastodonBackups.backups).toEqual([
      { name: record!.name, takenAt: record!.takenAt, verified: true, dbBytes: record!.dbBytes },
    ]);
    expect(JSON.stringify(card)).not.toContain("own-s3cr3t");

    // clearing it leaves a services fleet with nowhere to back up again
    w.fleet.setMastodonBackupStorage(launchRow(w), null);
    expect(() => w.fleet.requestMastodonBackup(launchRow(w))).toThrow(/no backup bucket/);
  }, 180_000);
});

describe("taking a Mastodon backup", () => {
  it("keeps a rolling pair, deleting the oldest from the bucket once a new one passes", async () => {
    const w = await launched(chainSpec());
    await backUp(w);
    await new Promise((r) => setTimeout(r, 1100)); // names are per second
    await backUp(w);
    const [second, first] = mastodonBackups(w.db, w.id);
    await new Promise((r) => setTimeout(r, 1100));
    await backUp(w);
    const kept = mastodonBackups(w.db, w.id);
    expect(kept.map((r) => r.name)).toEqual([expect.any(String), second!.name]);
    expect(objects(w).some((k) => k.includes(first!.name))).toBe(false);
    expect(objects(w)).toHaveLength(4);
  }, 240_000);

  it("parks with what to do when the running image has no backup tools", async () => {
    const w = await launched(chainSpec());
    w.services.provider.mastodonBackupTools = false;
    w.fleet.requestMastodonBackup(launchRow(w));
    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/missing pg_dump, s5cmd.*Dockerfile-mastodon/);
    expect(objects(w)).toEqual([]);
  }, 180_000);

  it("pauses on a failed upload with the instance untouched, and resumes into a good one", async () => {
    const w = await launched(chainSpec());
    w.services.provider.mastodonUploadFails = true;
    w.fleet.requestMastodonBackup(launchRow(w));
    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/upload failed \(the instance kept running\)/);
    expect(mastodonBackups(w.db, w.id)).toEqual([]);
    w.services.provider.mastodonUploadFails = false;
    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    expect(mastodonBackups(w.db, w.id)).toHaveLength(1);
  }, 180_000);

  it("deletes a backup that fails its check, takes it again once, then pauses with what the hashes say", async () => {
    const w = await launched(chainSpec());
    const provider = w.services.provider;
    // every object the bucket hands back is altered
    const set = provider.mastodonBucket.set.bind(provider.mastodonBucket);
    provider.mastodonBucket.set = (k: string, v: Buffer) => {
      provider.mastodonCorrupt.add(k);
      return set(k, v);
    };
    w.fleet.requestMastodonBackup(launchRow(w));
    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/failed its check 2 times.*different bytes than the container uploaded/s);
    expect(mastodonBackups(w.db, w.id)).toEqual([]);
    // both failed copies were removed
    expect(objects(w)).toEqual([]);
  }, 180_000);

  it("abandoned, stops its script in the container and forgets the half-made backup", async () => {
    const w = await launched(chainSpec());
    const opId = w.fleet.requestMastodonBackup(launchRow(w));
    w.services.provider.mastodonUploadFails = true;
    await driveOps(w);
    await w.fleet.requestAbortOp(launchRow(w), opId);
    expect(w.services.provider.mastodonStopped.length).toBeGreaterThan(0);
    expect(w.db.getSetting(`mastodon-backup-pending:${w.id}`)).toBeNull();
  }, 180_000);

  it("is due on its schedule, and not again until the interval passes", async () => {
    const w = await launched(chainSpec());
    expect(w.fleet.mastodonBackupDue(w.id)).toBe(false);
    w.fleet.setMastodonBackupSchedule(launchRow(w), "daily");
    expect(w.fleet.mastodonBackupDue(w.id)).toBe(true);
    await backUp(w);
    expect(w.fleet.mastodonBackupDue(w.id)).toBe(false);
    expect(w.fleet.mastodonBackupDue(w.id, Date.now() + 86_400_000 + 60_000)).toBe(true);
  }, 180_000);
});

describe("restoring a Mastodon backup", () => {
  it("in place: the database and media go back to the backup's, and the instance restarts", async () => {
    const w = await launched(chainSpec());
    instance(w).token = "token-original";
    w.services.provider.mastodonMedia.set(mastodonRow(w).dseq, Buffer.from("old media"));
    await backUp(w);
    const [record] = mastodonBackups(w.db, w.id);
    // the instance moves on after the backup
    instance(w).accounts.add("eve");
    instance(w).token = "token-later";
    w.services.provider.mastodonMedia.set(mastodonRow(w).dseq, Buffer.from("new media"));

    const opId = w.fleet.requestMastodonRestore(launchRow(w), record!.name);
    const done = await driveOps(w);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(w.db.stepOutput<any>(w.id, `op${opId}:restore`)).toMatchObject({ name: record!.name, accounts: 1 });
    expect([...instance(w).accounts]).toEqual(["admin"]);
    expect(instance(w).token).toBe("token-original");
    expect(w.services.provider.mastodonMedia.get(mastodonRow(w).dseq)!.toString()).toBe("old media");
    // web + sidekiq and streaming restart onto the restored database
    const restarted = w.services.provider.shellLog
      .filter((l) => l.dseq === mastodonRow(w).dseq && l.script === "kill 1")
      .map((l) => l.service);
    expect(restarted).toEqual(["mastodon", "streaming"]);
  }, 180_000);

  it("refuses a backup it does not know, or one that never passed its check", async () => {
    const w = await launched(chainSpec());
    expect(() => w.fleet.requestMastodonRestore(launchRow(w), "mastodon-20260101T000000Z")).toThrow(/no Mastodon backup named/);
    w.db.setSetting(`mastodon-backups:${w.id}`, JSON.stringify([{ name: "mastodon-20260101T000000Z", takenAt: "x", dseq: "1" }]));
    expect(() => w.fleet.requestMastodonRestore(launchRow(w), "mastodon-20260101T000000Z")).toThrow(/never passed its check/);
  }, 180_000);

  it("a relaunched instance starts from the latest backup, before anything configures it", async () => {
    const w = await launched(chainSpec());
    instance(w).token = "token-original";
    w.services.provider.mastodonMedia.set(mastodonRow(w).dseq, Buffer.from("avatars"));
    await backUp(w);
    const before = mastodonRow(w);
    const password = w.fleet.mnemonic(launchRow(w), "mastodon-owner");
    expect(w.fleet.relaunchWarnings(launchRow(w), before).join(" ")).toMatch(/from its backup of .*take a backup first/);

    const opId = await w.fleet.requestRelaunch(launchRow(w), before);
    const done = await driveOps(w);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    const after = mastodonRow(w);
    expect(after.dseq).not.toBe(before.dseq);
    expect(w.db.stepOutput<any>(w.id, `op${opId}:restore-data`)).toMatchObject({ restored: true, accounts: 1 });
    // no second owner, the bridge token and the media came back
    expect(w.db.stepOutput<any>(w.id, `op${opId}:configure-mastodon`)).toMatchObject({ created: false });
    expect(w.fleet.mnemonic(launchRow(w), "mastodon-owner")).toBe(password);
    expect(instance(w).token).toBe("token-original");
    expect(w.services.provider.mastodonMedia.get(after.dseq)!.toString()).toBe("avatars");
  }, 180_000);

  it("a relaunch with automatic restore off starts empty, as before", async () => {
    const w = await launched(chainSpec());
    await backUp(w);
    w.fleet.setMastodonAutoRestore(launchRow(w), false);
    expect(w.fleet.relaunchWarnings(launchRow(w), mastodonRow(w)).join(" ")).toMatch(/EMPTY volumes/);
    const opId = await w.fleet.requestRelaunch(launchRow(w), mastodonRow(w));
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.stepOutput<any>(w.id, `op${opId}:restore-data`)).toMatchObject({ restored: false });
    expect(w.db.stepOutput<any>(w.id, `op${opId}:configure-mastodon`)).toMatchObject({ created: true });
  }, 180_000);

  it("a resize with a bucket carries the data through it, leaving a checked backup behind", async () => {
    const s = chainSpec();
    s.topology.components.mastodon!.size = "standard";
    const w = await launched(s);
    instance(w).token = "token-original";
    w.services.provider.mastodonMedia.set(mastodonRow(w).dseq, Buffer.from("attachments"));
    const before = mastodonRow(w);
    const opId = await w.fleet.requestMastodonResize(launchRow(w), before, "small");
    // a move and a backup do not run at once
    expect(() => w.fleet.requestMastodonBackup(launchRow(w))).toThrow(/another operation/);
    const done = await driveOps(w);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");

    const backup = w.db.stepOutput<any>(w.id, `op${opId}:backup`)!;
    expect(backup.bucket.name).toMatch(/^mastodon-/);
    expect(backup.dir).toBeUndefined(); // nothing kept in the launcher
    expect(mastodonBackups(w.db, w.id)[0]).toMatchObject({ name: backup.bucket.name, verified: true, dseq: before.dseq });
    const after = mastodonRow(w);
    expect(after.dseq).not.toBe(before.dseq);
    expect(instance(w).token).toBe("token-original");
    expect(w.services.provider.mastodonMedia.get(after.dseq)!.toString()).toBe("attachments");
    expect(w.db.stepOutput<any>(w.id, `op${opId}:restore`)).toMatchObject({ restoredFrom: backup.bucket.name, accounts: 1 });
  }, 180_000);

  it("deletes a backup from the bucket and the list", async () => {
    const w = await launched(chainSpec());
    await backUp(w);
    const [record] = mastodonBackups(w.db, w.id);
    await w.fleet.deleteMastodonBackup(launchRow(w), record!.name);
    expect(mastodonBackups(w.db, w.id)).toEqual([]);
    expect(objects(w)).toEqual([]);
  }, 180_000);
});

describe("upgrading to a malformed image", () => {
  it("is refused before an op exists or anything is signed", async () => {
    const w = await launched(chainSpec());
    const ops = w.db.listFleetOps(w.id).length;
    const signed = w.signer.signed.length;
    const bad = "sparkdreamnft/mastodon:v1.0.54@sha256:sha256:338edff6bae78293d76b39c79f942af9dbcfc16da68f1f9851c0159b00815138";
    expect(() => w.fleet.requestUpgrade(launchRow(w), ["mastodon"], bad)).toThrow(/repeats its "sha256:" prefix/);
    expect(() => w.fleet.requestHaltUpgrade(launchRow(w), bad, 100)).toThrow(/not a valid image/);
    expect(w.db.listFleetOps(w.id)).toHaveLength(ops);
    expect(w.signer.signed).toHaveLength(signed);
    // nor written into the spec a relaunch would deploy from
    expect(launchRow(w).spec_json).not.toContain("sha256:sha256:");
  }, 180_000);
});

describe("moving a Mastodon whose web container is down", () => {
  it("asks once, then carries the database without the media, before anything configures the new instance", async () => {
    // 2026-10-14: the web pod wedged on a bad image; db kept running
    const w = await launched(servicesSpec(), "svc");
    const before = mastodonRow(w);
    instance(w).token = "token-original";
    const password = w.fleet.mnemonic(launchRow(w), "mastodon-owner");
    w.services.provider.downServices.add(`${before.dseq}/mastodon`);

    // the current size: a move, not a resize
    const opId = await w.fleet.requestMastodonResize(launchRow(w), before, "small");
    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/web container does not answer.*Resume to move without the media/s);
    // nothing was closed or signed for the move yet
    expect(mastodonRow(w).dseq).toBe(before.dseq);

    const done = await driveOps(w);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    const after = mastodonRow(w);
    expect(after.dseq).not.toBe(before.dseq);
    const backup = w.db.stepOutput<any>(w.id, `op${opId}:backup`)!;
    expect(backup).toMatchObject({ dseq: before.dseq, media: null });
    expect(fs.existsSync(path.join(backup.dir, "db.dump"))).toBe(true);
    // the old owner and bridge token came along: no second owner
    expect(instance(w).token).toBe("token-original");
    expect(w.db.stepOutput<any>(w.id, `op${opId}:configure-mastodon`)).toMatchObject({ created: false });
    expect(w.fleet.mnemonic(launchRow(w), "mastodon-owner")).toBe(password);
    // streaming restarts with web + sidekiq rather than crash-looping on the swapped database
    expect(w.services.provider.shellLog.some((l) => l.dseq === after.dseq && l.service === "streaming" && l.script === "kill 1")).toBe(true);
  }, 180_000);

  it("a resize whose web container answers never asks", async () => {
    const w = await launched(servicesSpec(), "svc");
    await w.fleet.requestMastodonResize(launchRow(w), mastodonRow(w), "standard");
    const done = await driveOps(w);
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
  }, 180_000);
});

describe("Mastodon's disk", () => {
  it("reads both volumes, reports the fuller one, and keeps the other when one container is down", async () => {
    const w = await launched(chainSpec());
    const row = mastodonRow(w);
    // the fake's df answers 20 GiB with a quarter used unless told otherwise
    w.services.provider.diskUsedKb.set(row.dseq, 18 * 1024 * 1024);
    const disk = (await w.fleet.componentDisk(launchRow(w), row as any))!;
    expect(disk.volumes!.map((v) => v.name)).toEqual(["media", "database"]);
    expect(disk.percentUsed).toBe(90);
    const reads = w.services.provider.shellLog.filter((l) => l.dseq === row.dseq && l.script.startsWith("df -Pk"));
    expect(reads.map((l) => [l.service, l.script])).toEqual([
      ["mastodon", "df -Pk /opt/mastodon/public/system 2>/dev/null"],
      ["db", "df -Pk /var/lib/postgresql/data 2>/dev/null"],
    ]);

    // a fresh read (past the minute's cache) with the web container down
    const w2 = await launched(chainSpec());
    w2.services.provider.downServices.add(`${mastodonRow(w2).dseq}/mastodon`);
    const partial = (await w2.fleet.componentDisk(launchRow(w2), mastodonRow(w2) as any))!;
    expect(partial.volumes!.map((v) => v.name)).toEqual(["database"]);
  }, 180_000);

  it("a node keeps its single chain-data reading", async () => {
    const w = await launched(chainSpec());
    const sentry = w.db.listFleetComponents(w.id).find((c) => c.key === "sentry-0")!;
    const disk = (await w.fleet.componentDisk(launchRow(w), sentry as any))!;
    expect(disk.volumes).toBeUndefined();
    expect(disk.percentUsed).toBe(25);
  }, 180_000);
});
