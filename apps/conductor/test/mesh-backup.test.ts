import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TypeUrl } from "@sparkdream/akash-tx";
import { chainId, testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runLaunch, runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { backupComplete } from "../src/steps/phase-bcd.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-meshbk-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(name = "sparkdream", backup?: object): LaunchSpec {
  return testnetSpec({
    network: { name, type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: { domain: `headscale.${name}.io`, ...(backup ? { backup } : {}) },
    },
  });
}

const STORAGE = {
  endpoint: "https://endpoint.4everland.co",
  bucket: "example-bucket",
  accessKeyId: "AKFAKE",
};

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  fleet: FleetService;
  signer: FakeSigner;
}

function world(): World {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  return { work, db, services, fleet: new FleetService(db, services, work), signer: new FakeSigner() };
}

async function launch(w: World, id: string, s: LaunchSpec): Promise<void> {
  w.db.createLaunch(id, JSON.stringify(s), "akash1owner");
  expect((await runWithSigner(w.db, id, s, w.work, allSteps(), w.services, w.signer)).status).toBe("completed");
  w.fleet.materialize(id);
}

async function driveOps(w: World, id: string) {
  const s = withDefaults(JSON.parse(w.db.getLaunch(id)!.spec_json));
  const steps = [...buildPreLaunchOpSteps(w.db, id), ...allSteps(), ...buildOpSteps(w.db, id)];
  return runWithSigner(w.db, id, s, w.work, steps, w.services, w.signer);
}

const hsRow = (w: World, id: string) => w.db.listFleetComponents(id).find((c) => c.key === "headscale")!;

describe("reading a backup listing", () => {
  it("needs the keys archive and a litestream snapshot", () => {
    expect(backupComplete("")).toEqual({ archive: false, replica: false });
    expect(
      backupComplete(
        "2026/10/03 12:00:00  1024  state-keys.tar.age\n2026/10/03 12:00:00  1024  generations/0a1b/snapshots/00000000.snapshot.lz4\n",
      ),
    ).toEqual({ archive: true, replica: true });
  });
});

describe("turning on the mesh backup of a running fleet", () => {
  it("adds the backup env in place, uploads the static keys and checks both halves landed", async () => {
    const w = world();
    await launch(w, "fl", spec());
    const before = hsRow(w, "fl");
    const signedBefore = w.signer.signed.length;
    const opId = w.fleet.requestMeshBackup(w.db.getLaunch("fl")!, { ...STORAGE, secret: "s3cr3t" });
    const done = await driveOps(w, "fl");
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");

    // one in-place update of the SAME deployment: no relaunch, same volume
    const updates = w.signer.signed.slice(signedBefore).flat().filter((m) => m.typeUrl === TypeUrl.UpdateDeployment);
    expect(updates.map((m) => (m.value as any).id.dseq)).toEqual([before.dseq]);
    expect(hsRow(w, "fl").dseq).toBe(before.dseq);

    // a per-fleet prefix, so fleets can share the bucket
    const cid = chainId(withDefaults(spec()));
    const prefix = `sparkdream-launcher/${cid}/headscale`;
    expect([...w.services.provider.s3Objects]).toEqual([`${STORAGE.bucket}/${prefix}/state-keys.tar.age`]);
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/headscale.yaml"), "utf8");
    expect(sdl).toContain(`LITESTREAM_S3_PATH=${prefix}`);
    expect(sdl).toContain("LITESTREAM_S3_SECRET_ACCESS_KEY=s3cr3t");
    expect(sdl).toMatch(/AGE_IDENTITY=AGE-SECRET-KEY-/);

    // the secret is in the launch's secrets, the spec only names it
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    expect(stored.topology.headscale.backup.s3.secretRef).toBe("secret:s3-backup");
    expect(JSON.stringify(stored)).not.toContain("s3cr3t");
    expect(fs.readFileSync(path.join(w.work, "launches/fl/secrets/s3-backup"), "utf8")).toContain("s3cr3t");

    const view = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.meshBackup).toEqual({ bucket: STORAGE.bucket, path: prefix, verified: true });
  }, 120_000);

  it("pauses with the bucket's error when it refuses the credentials", async () => {
    const w = world();
    await launch(w, "fl", spec());
    w.services.provider.s3Rejects = true;
    const opId = w.fleet.requestMeshBackup(w.db.getLaunch("fl")!, { ...STORAGE, secret: "wrong" });
    const parked = await driveOps(w, "fl");
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:seed`);
    expect(parked.reason).toContain("AccessDenied");

    // the spec names the bucket, but nothing may restore from it yet
    const view = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.meshBackup?.verified).toBe(false);
    expect(w.fleet.relaunchWarnings(w.db.getLaunch("fl")!, hsRow(w, "fl")).join(" ")).toMatch(/never verified/);

    // abandoned past the update: headscale runs the settings, so they stay, unverified
    const { warning } = await w.fleet.requestAbortOp(w.db.getLaunch("fl")!, opId);
    expect(warning).toMatch(/never verified/);
    const after = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(after.meshBackup?.verified).toBe(false);
  }, 120_000);

  it("abandoned before headscale was updated, puts the spec and secret back", async () => {
    const w = world();
    await launch(w, "fl", spec());
    const opId = w.fleet.requestMeshBackup(w.db.getLaunch("fl")!, { ...STORAGE, secret: "s3cr3t" });
    // no signer: the op waits on its deployment update
    const s = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const parked = await runLaunch(w.db, "fl", s, w.work, [...allSteps(), ...buildOpSteps(w.db, "fl")], w.services);
    expect(parked.status).not.toBe("completed");
    expect(w.db.getStep("fl", `op${opId}:update`)?.status).not.toBe("done");

    await w.fleet.requestAbortOp(w.db.getLaunch("fl")!, opId);
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.headscale.backup).toBeUndefined();
    expect(fs.existsSync(path.join(w.work, "launches/fl/secrets/s3-backup"))).toBe(false);
    const view = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.meshBackup).toBeNull();
  }, 120_000);

  it("a second fleet of the same wallet reuses the stored secret and gets its own prefix", async () => {
    const w = world();
    await launch(w, "dev", spec("sparkdream-dev"));
    await launch(w, "test", spec("sparkdream-test"));
    w.fleet.requestMeshBackup(w.db.getLaunch("dev")!, { ...STORAGE, secret: "s3cr3t" });
    expect((await driveOps(w, "dev")).status).toBe("completed");

    expect(w.fleet.knownBackupStorage("akash1owner")).toMatchObject(STORAGE);
    expect(w.fleet.knownBackupStorage("akash1someoneelse")).toBeNull();
    w.fleet.requestMeshBackup(w.db.getLaunch("test")!, { ...STORAGE }); // no secret typed
    expect((await driveOps(w, "test")).status).toBe("completed");
    expect(fs.readFileSync(path.join(w.work, "launches/test/secrets/s3-backup"), "utf8")).toContain("s3cr3t");
    expect(w.services.provider.s3Objects.size).toBe(2);
  }, 240_000);

  it("refuses a blank secret when nothing here holds one for that key", async () => {
    const w = world();
    await launch(w, "fl", spec());
    expect(() => w.fleet.requestMeshBackup(w.db.getLaunch("fl")!, { ...STORAGE })).toThrow(/secret key is required/);
  }, 120_000);

  it("after it, a headscale relaunch keeps the mesh instead of re-keying it", async () => {
    const w = world();
    await launch(w, "fl", spec());
    w.fleet.requestMeshBackup(w.db.getLaunch("fl")!, { ...STORAGE, secret: "s3cr3t" });
    expect((await driveOps(w, "fl")).status).toBe("completed");

    const before = hsRow(w, "fl");
    const opId = await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    const signedBefore = w.signer.signed.length;
    expect((await driveOps(w, "fl")).status).toBe("completed");
    // the new deployment carries the backup env (secret resolved from the
    // launch's secrets, no environment variable needed)
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/headscale.yaml"), "utf8");
    expect(sdl).toContain("LITESTREAM_S3_SECRET_ACCESS_KEY=s3cr3t");
    // and nothing was re-keyed: no deployment updates pushed to mesh members
    const after = w.signer.signed.slice(signedBefore).flat();
    expect(after.filter((m) => m.typeUrl === TypeUrl.UpdateDeployment)).toHaveLength(0);
    expect(w.db.getStep("fl", `op${opId}:rekey`)?.output_json).toContain("skipped");
  }, 120_000);
});

describe("a headscale relaunch onto a provider whose ingress serves nothing", () => {
  it("moves again by itself and avoids that provider", async () => {
    const relaunched = async (brokenHost?: string) => {
      const w = world();
      await launch(w, "fl", spec());
      w.fleet.requestMeshBackup(w.db.getLaunch("fl")!, { ...STORAGE, secret: "s3cr3t" });
      expect((await driveOps(w, "fl")).status).toBe("completed");
      // DNS that works when pointed at an ingress that serves
      w.services.dns = {
        async pointCname(name, target) {
          if (![...w.services.rpc.darkUrls].some((d) => target.includes(d))) w.services.rpc.darkUrls.delete(`${name}/health`);
          return true;
        },
      };
      const before = hsRow(w, "fl");
      await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
      w.services.api.leaseStates.set(before.dseq, "closed");
      if (brokenHost) {
        w.services.rpc.darkUrls.add("headscale.sparkdream.io/health");
        w.services.rpc.darkUrls.add(`fake.ingress.${brokenHost}`);
      }
      const res = await driveOps(w, "fl");
      return { w, res, row: hsRow(w, "fl") };
    };
    const usual = await relaunched();
    expect(usual.res.status).toBe("completed");
    const brokenHost = new URL(usual.row.host_uri).hostname;
    const moved = await relaunched(brokenHost);
    expect(moved.res.reason ?? "").toBe("");
    expect(moved.res.status).toBe("completed");
    expect(moved.row.provider).not.toBe(usual.row.provider);
    expect(moved.w.fleet.providerPrefs("akash1owner").avoid).toContain(usual.row.provider);
  }, 300_000);
});

describe("a launch with backup configured", () => {
  it("uploads the static keys at launch time instead of stopping at a local archive", async () => {
    const w = world();
    process.env.TEST_S3_SECRET = "envsecret";
    await launch(
      w,
      "fl",
      spec("sparkdream", { s3: { ...STORAGE, region: "us-west-2", secretRef: "env:TEST_S3_SECRET" } }),
    );
    const out = w.db.stepOutput<{ uploaded?: boolean }>("fl", "seed-headscale-backup");
    expect(out?.uploaded).toBe(true);
    expect([...w.services.provider.s3Objects][0]).toMatch(/headscale\/state-keys\.tar\.age$/);
  }, 120_000);
});
