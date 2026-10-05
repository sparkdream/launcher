import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { dataBackups } from "../src/data-backup.js";
import { setAlertSettings } from "../src/incidents.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-databk-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

process.env.TEST_DATA_S3_SECRET = "s3cr3t";

function spec(sentries = 2): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: sentries },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: {
        domain: "headscale.sparkdream.io",
        backup: {
          s3: {
            endpoint: "https://endpoint.4everland.co",
            bucket: "bk",
            region: "us-west-2",
            accessKeyId: "AK",
            secretRef: "env:TEST_DATA_S3_SECRET",
          },
        },
      },
    },
  });
}

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  fleet: FleetService;
  signer: FakeSigner;
}

async function launched(s = spec()): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  expect((await runWithSigner(db, "fl", s, work, allSteps(), services, signer)).status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  return { work, db, services, fleet, signer };
}

async function driveOps(w: World) {
  const s = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
  const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", s, w.work, steps, w.services, w.signer);
}

const row = (w: World, key: string) => w.db.listFleetComponents("fl").find((c) => c.key === key)!;
const sshId = (w: World, key: string) => `${row(w, key).ssh_host}:${row(w, key).ssh_port}`;

async function backedUp(): Promise<World> {
  const w = await launched();
  w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
  expect((await driveOps(w)).status).toBe("completed");
  return w;
}

describe("taking a chain-data backup", () => {
  it("copies the non-public sentry while it is held, then lets it start again", async () => {
    const w = await launched();
    const { opId, source } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    expect(source).toBe("sentry-1");
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");

    const id = sshId(w, "sentry-1");
    // stopped by one container restart under the hold (the fake throws if
    // the copy starts while the node runs), and running again after
    expect(w.services.ssh.containerRestarts.get(id)).toBe(1);
    expect(w.services.ssh.holds.has(id)).toBe(false);
    expect(w.services.ssh.started.has(id)).toBe(true);
    // sentry-0 (public endpoints) was never touched
    expect(w.services.ssh.containerRestarts.get(sshId(w, "sentry-0"))).toBeUndefined();

    const [record] = dataBackups(w.db, "fl");
    expect(record!.from).toBe("sentry-1");
    expect(record!.genesisSha).toMatch(/^[0-9a-f]{64}$/);
    // read back and unpacked before it was recorded, with the upload's hash
    expect(record!.verified).toBe(true);
    expect(record!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.services.ssh.files.get(`${id}|/tmp/sd-verify.age`)).toMatch(/^AGE-SECRET-KEY-/);
    expect([...w.services.ssh.s3Objects]).toEqual([`bk/sparkdream-launcher/sparkdream-1/chain-data/${record!.name}`]);
    // the secret reached the node only through the uploaded env file
    expect(w.services.ssh.execLog.some((e) => e.command.includes("s3cr3t"))).toBe(false);
  }, 180_000);

  it("parks with the reason when the node image has no backup tools", async () => {
    const w = await launched();
    w.services.ssh.backupToolsMissing = "missing s5cmd\nmissing hold";
    const { opId } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:prepare`);
    expect(parked.reason).toContain("missing s5cmd, missing hold");
    expect(w.services.ssh.containerRestarts.size).toBe(0);
  }, 180_000);

  it("a failed upload releases the node and pauses", async () => {
    const w = await launched();
    w.services.ssh.backupFails = true;
    const { opId } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    const parked = await driveOps(w);
    expect(parked.failedStep).toBe(`op${opId}:upload`);
    expect(w.services.ssh.holds.has(sshId(w, "sentry-1"))).toBe(false);
    expect(dataBackups(w.db, "fl")).toEqual([]);
  }, 180_000);

  it("a resumed upload stops the node again before copying", async () => {
    const w = await launched();
    w.services.ssh.backupFails = true;
    const { opId } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    expect((await driveOps(w)).failedStep).toBe(`op${opId}:upload`);
    const id = sshId(w, "sentry-1");
    expect(w.services.ssh.started.has(id)).toBe(true); // released after the failure

    w.services.ssh.backupFails = false;
    // the fake throws if the copy starts while the node runs
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.services.ssh.containerRestarts.get(id)).toBe(2);
    expect(w.services.ssh.holds.has(id)).toBe(false);
    expect(dataBackups(w.db, "fl")).toHaveLength(1);
  }, 240_000);

  it("a copy that dies with its container is stopped, released and paused, not waited on forever", async () => {
    const w = await launched();
    const id = () => sshId(w, "sentry-1");
    w.services.ssh.scriptsDie.add(id());
    const { opId } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    const parked = await driveOps(w);
    expect(parked.failedStep).toBe(`op${opId}:upload`);
    expect(parked.reason).toContain("stopped without finishing");
    expect(w.services.ssh.stoppedScripts).toContain(`${id()}|sd-backup`);
    expect(w.services.ssh.holds.has(id())).toBe(false);
    expect(dataBackups(w.db, "fl")).toEqual([]);
  }, 180_000);

  it("refuses to hold a node in wait mode instead of restarting it into nothing", async () => {
    const w = await launched();
    const id = sshId(w, "sentry-1");
    w.services.ssh.waitMode.add(id);
    w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    const res = await driveOps(w);
    expect(res.status).not.toBe("completed");
    expect(w.services.ssh.containerRestarts.get(id)).toBeUndefined();
    expect(w.services.ssh.holds.has(id)).toBe(false);
  }, 180_000);

  it("schedules only with a sentry to spare", async () => {
    const one = await launched(spec(1));
    one.fleet.setDataBackupSchedule(one.db.getLaunch("fl")!, "daily");
    expect(one.fleet.dataBackupDue("fl")).toBe(false);

    const two = await launched();
    expect(two.fleet.dataBackupDue("fl")).toBe(false); // off by default
    two.fleet.setDataBackupSchedule(two.db.getLaunch("fl")!, "daily");
    expect(two.fleet.dataBackupDue("fl")).toBe(true);
    two.fleet.requestDataBackup(two.db.getLaunch("fl")!, { auto: true });
    expect((await driveOps(two)).status).toBe("completed");
    expect(two.fleet.dataBackupDue("fl")).toBe(false);
    expect(two.fleet.dataBackupDue("fl", Date.now() + 25 * 3_600_000)).toBe(true);
  }, 240_000);

  it("backs up again right after a node upgrade, not after a bridge one", async () => {
    const w = await backedUp();
    w.fleet.setDataBackupSchedule(w.db.getLaunch("fl")!, "daily");
    expect(w.fleet.dataBackupDue("fl")).toBe(false);
    const bridge = w.db.createFleetOp("fl", "upgrade", { components: ["bridge"] });
    w.db.setFleetOpStatus(bridge, "done");
    expect(w.fleet.dataBackupDue("fl")).toBe(false);
    const nodes = w.db.createFleetOp("fl", "upgrade", { components: ["sentry-0", "sentry-1", "val-0"] });
    w.db.setFleetOpStatus(nodes, "done");
    expect(w.fleet.dataBackupDue("fl")).toBe(true);
    w.fleet.requestDataBackup(w.db.getLaunch("fl")!, { auto: true });
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.fleet.dataBackupDue("fl")).toBe(false);
  }, 300_000);

  it("copies the chosen sentry, except a scheduled backup never takes sentry-0", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    expect(w.fleet.backupSourceFor("fl")!.key).toBe("sentry-1");
    expect(() => w.fleet.setDataBackupSource(launch, "val-0")).toThrow(/not a sentry/);
    w.fleet.setDataBackupSource(launch, "sentry-0");
    expect(w.fleet.backupSourceFor("fl")!.key).toBe("sentry-0");
    expect(w.fleet.backupSourceFor("fl", { auto: true })!.key).toBe("sentry-1");
    w.fleet.setDataBackupSchedule(launch, "daily");
    expect(w.fleet.dataBackupDue("fl")).toBe(true);
    const { source } = w.fleet.requestDataBackup(launch);
    expect(source).toBe("sentry-0");
    expect((await driveOps(w)).status).toBe("completed");
    expect(dataBackups(w.db, "fl")[0]!.from).toBe("sentry-0");
    w.fleet.setDataBackupSource(launch, null);
    expect(w.fleet.backupSourceFor("fl")!.key).toBe("sentry-1");
  }, 240_000);

  it("keeps a rolling pair", async () => {
    const w = await backedUp();
    for (let i = 0; i < 2; i++) {
      w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
      expect((await driveOps(w)).status).toBe("completed");
      await new Promise((r) => setTimeout(r, 1100)); // names carry the second
    }
    expect(dataBackups(w.db, "fl")).toHaveLength(2);
  }, 300_000);
});

describe("checking a backup after its upload", () => {
  it("deletes a backup that does not read back and takes it again", async () => {
    const w = await launched();
    w.services.ssh.corruptUploads = 1;
    const { opId } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    const records = dataBackups(w.db, "fl");
    expect(records).toHaveLength(1);
    expect(records[0]!.verified).toBe(true);
    // only the good copy is left in the bucket, and the node was held twice
    expect([...w.services.ssh.s3Objects]).toEqual([`bk/sparkdream-launcher/sparkdream-1/chain-data/${records[0]!.name}`]);
    const id = sshId(w, "sentry-1");
    expect(w.services.ssh.containerRestarts.get(id)).toBe(2);
    expect(w.services.ssh.started.has(id)).toBe(true);
  }, 240_000);

  it("pauses after a second failure with what the hashes say, and records nothing", async () => {
    const w = await launched();
    w.services.ssh.corruptUploads = 2;
    const { opId } = w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:verify`);
    expect(parked.reason).toContain("different bytes than the node uploaded");
    expect(dataBackups(w.db, "fl")).toEqual([]);
    expect(w.services.ssh.s3Objects.size).toBe(0);
    expect(w.services.ssh.started.has(sshId(w, "sentry-1"))).toBe(true);

    // resume takes it again, and this copy is good
    expect((await driveOps(w)).status).toBe("completed");
    expect(dataBackups(w.db, "fl")[0]!.verified).toBe(true);
  }, 300_000);

  it("blames the node when the bucket returns exactly what it uploaded", async () => {
    const w = await launched();
    w.services.ssh.corruptUploads = 2;
    w.services.ssh.corruptInTransit = false;
    w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    const parked = await driveOps(w);
    expect(parked.reason).toContain("sentry-1 produced a broken stream");
  }, 300_000);
});

describe("backups taken before verification", () => {
  it("are not restored, and can be deleted from the bucket and the list", async () => {
    const w = await backedUp();
    // a record as the launcher kept them before 2026-10-05: no verified flag
    const [good] = dataBackups(w.db, "fl");
    const legacy = { ...good!, name: "data-20261004T231932Z-h216415.tar.zst.age" };
    delete (legacy as { verified?: boolean }).verified;
    const bucket = `bk/sparkdream-launcher/sparkdream-1/chain-data`;
    w.services.ssh.s3Objects.add(`${bucket}/${legacy.name}`);
    w.services.ssh.s3Objects.delete(`${bucket}/${good!.name}`);
    w.db.setSetting("data-backups:fl", JSON.stringify([legacy]));

    const view = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.dataBackups!.backups[0]).toMatchObject({ verified: false, blocker: expect.stringMatching(/never read back/) });
    const v = row(w, "val-0");
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, v);
    w.services.api.leaseStates.set(v.dseq, "closed");
    w.services.ssh.failHosts.add(`${v.ssh_host}:${v.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.services.ssh.restoredFrom.size).toBe(0);

    await w.fleet.deleteDataBackup(w.db.getLaunch("fl")!, legacy.name);
    expect(dataBackups(w.db, "fl")).toEqual([]);
    expect(w.services.ssh.s3Objects.size).toBe(0);
    await expect(w.fleet.deleteDataBackup(w.db.getLaunch("fl")!, legacy.name)).rejects.toThrow(/no backup named/);
  }, 300_000);

  it("a bridge-only upgrade does not make a backup stale", async () => {
    const w = await backedUp();
    const opId = w.db.createFleetOp("fl", "upgrade", { components: ["bridge"] });
    w.db.setFleetOpStatus(opId, "done");
    const view = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.dataBackups!.backups[0]!.blocker).toBeNull();
  }, 240_000);
});

describe("suggesting a backup before a long replay", () => {
  it("warns a node move with nothing to restore, with an estimate, and stops once a backup exists", async () => {
    const w = await launched();
    const s1 = row(w, "sentry-1");
    const warned = await w.fleet.scratchSyncWarnings(w.db.getLaunch("fl")!, "sentry-1");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/No chain-data backup to start from \(this fleet has no chain-data backup\)/);
    expect(warned[0]).toMatch(/blocks\/s/);
    expect(warned[0]).toMatch(/chain backups… → Back up now/);
    // service components never replay a chain
    expect(await w.fleet.scratchSyncWarnings(w.db.getLaunch("fl")!, "explorer")).toEqual([]);
    const view = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.dataBackups!.scratchSync!.blocks).toBeGreaterThan(0);

    // the measured rate replaces the default in the estimate
    w.db.setSetting("sync-rate:fl", "2.5");
    (w.fleet as any).headCache.clear();
    expect((await w.fleet.scratchSyncWarnings(w.db.getLaunch("fl")!, "sentry-1"))[0]).toMatch(/~2\.5 blocks\/s/);

    w.fleet.requestDataBackup(w.db.getLaunch("fl")!);
    expect((await driveOps(w)).status).toBe("completed");
    expect(await w.fleet.scratchSyncWarnings(w.db.getLaunch("fl")!, "sentry-1")).toEqual([]);
    const resize = (await w.fleet.nodeResizeWarnings(w.db.getLaunch("fl")!, s1, "large")).join(" ");
    expect(resize).toMatch(/starts from the chain-data backup taken at height/);
    const after = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(after.dataBackups!.scratchSync).toBeUndefined();
    expect(after.dataBackups!.latestAgeDays).toBe(0);
  }, 240_000);

  it("alerts a fleet without a backup at most once a day", async () => {
    const w = await launched();
    const sent: string[] = [];
    w.fleet.alertFetch = (async (_url: string, init: RequestInit) => {
      sent.push(String((init.headers as Record<string, string>).Title));
      return new Response("ok");
    }) as typeof fetch;
    setAlertSettings(w.db, { ntfy: { server: "https://ntfy.sh", topic: "t" } });
    await w.fleet.backupStaleCheck("fl");
    await w.fleet.backupStaleCheck("fl");
    expect(sent.filter((t) => /no chain-data backup/.test(t))).toHaveLength(1);
  }, 180_000);
});

describe("with secrets encrypted at rest (LAUNCHER_SECRET)", () => {
  it("the node still receives plain env files, scripts and age key", async () => {
    process.env.LAUNCHER_SECRET = "at-rest";
    try {
      const w = await backedUp();
      const [record] = dataBackups(w.db, "fl");
      expect([...w.services.ssh.s3Objects]).toEqual([`bk/sparkdream-launcher/sparkdream-1/chain-data/${record!.name}`]);
      const name = record!.name;
      w.fleet.requestDataRestore(w.db.getLaunch("fl")!, row(w, "sentry-0"), name);
      expect((await driveOps(w)).status).toBe("completed");
      const id = sshId(w, "sentry-0");
      expect(w.services.ssh.restoredFrom.get(id)).toBe(name);
      const sent = [...w.services.ssh.files].filter(([k]) => /\|\/tmp\/sd-(backup|restore)\./.test(k));
      expect(sent.length).toBeGreaterThanOrEqual(5);
      for (const [file, text] of sent) {
        expect(text.startsWith("SDLSEC1"), file).toBe(false);
      }
      expect(w.services.ssh.files.get(`${id}|/tmp/sd-restore.age`)).toMatch(/^AGE-SECRET-KEY-/);
    } finally {
      delete process.env.LAUNCHER_SECRET;
    }
  }, 240_000);
});

describe("restoring chain data", () => {
  it("a relaunched validator starts from the latest backup", async () => {
    const w = await backedUp();
    const before = row(w, "val-0");
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.services.ssh.restoredFrom.get(sshId(w, "val-0"))).toBe(dataBackups(w.db, "fl")[0]!.name);
  }, 240_000);

  it("a restore that dies is stopped before the relaunched node starts, which then syncs from peers", async () => {
    const w = await backedUp();
    const before = row(w, "val-0");
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    // every node the relaunch could land on loses its restore script
    const scriptsDie = w.services.ssh.scriptsDie;
    w.services.ssh.scriptsDie = { has: () => true } as unknown as Set<string>;
    expect((await driveOps(w)).status).toBe("completed");
    w.services.ssh.scriptsDie = scriptsDie;
    const id = sshId(w, "val-0");
    expect(w.services.ssh.restoredFrom.has(id)).toBe(false);
    expect(w.services.ssh.stoppedScripts).toContain(`${id}|sd-restore`);
  }, 240_000);

  it("not when automatic restore is off, nor after an upgrade", async () => {
    const off = await backedUp();
    off.fleet.setAutoRestore(off.db.getLaunch("fl")!, false);
    const v = row(off, "val-0");
    await off.fleet.requestRelaunch(off.db.getLaunch("fl")!, v);
    off.services.api.leaseStates.set(v.dseq, "closed");
    off.services.ssh.failHosts.add(`${v.ssh_host}:${v.ssh_port}`);
    expect((await driveOps(off)).status).toBe("completed");
    expect(off.services.ssh.restoredFrom.size).toBe(0);

    const upgraded = await backedUp();
    const opId = upgraded.db.createFleetOp("fl", "upgrade", {});
    upgraded.db.setFleetOpStatus(opId, "done");
    const view = (await upgraded.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.dataBackups!.backups[0]!.blocker).toMatch(/predates the fleet's upgrade/);
    const s1 = row(upgraded, "sentry-1");
    expect(() => upgraded.fleet.requestDataRestore(upgraded.db.getLaunch("fl")!, s1, view.dataBackups!.backups[0]!.name)).toThrow(
      /predates/,
    );
  }, 300_000);

  it("replaces a running node's data in place and starts it again", async () => {
    const w = await backedUp();
    const name = dataBackups(w.db, "fl")[0]!.name;
    const opId = w.fleet.requestDataRestore(w.db.getLaunch("fl")!, row(w, "sentry-0"), name);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    const id = sshId(w, "sentry-0");
    expect(w.services.ssh.restoredFrom.get(id)).toBe(name);
    expect(w.services.ssh.started.has(id)).toBe(true);
    expect(w.services.ssh.holds.has(id)).toBe(false);
  }, 240_000);
});
