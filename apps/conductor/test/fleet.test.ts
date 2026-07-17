import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { allSteps, buildServer } from "../src/index.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-fleet-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(validators = 1, sentries = 1): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: validators },
      sentries: { count: sentries },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

/** Run a full simulated launch so the fleet has something to manage. */
async function launched(validators = 1, sentries = 1) {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const s = spec(validators, sentries);
  const services = fakeServices();
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  const result = await runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner());
  expect(result.status).toBe("completed");
  return { work, db, services, spec: s };
}

describe("fleet read-model + reconciliation", () => {
  it("materializes components from step outputs, scoped to the owner", async () => {
    const { db, services, work } = await launched();
    const fleet = new FleetService(db, services, work);

    const view = await fleet.fleetForOwner("akash1owner");
    expect(view.fleets).toHaveLength(1);
    const keys = view.fleets[0]!.components.map((c) => c.key).sort();
    expect(keys).toEqual(["headscale", "sentry-0", "val-0"]);
    expect(view.fleets[0]!.chainId).toBe("sparkdream-1");
    // escrow balance (deployment funds) is surfaced per active component
    expect(view.fleets[0]!.components.find((c) => c.key === "val-0")!.escrow).toBe("5000000");
    expect(view.unmanaged).toEqual([]);

    // other wallets see nothing
    const other = await fleet.fleetForOwner("akash1someoneelse");
    expect(other.fleets).toEqual([]);
  }, 120_000);

  it("marks closed-out-of-band components and surfaces unmanaged deployments", async () => {
    const { db, services, work } = await launched();
    const fleet = new FleetService(db, services, work);
    await fleet.fleetForOwner("akash1owner"); // materialize

    const sentry = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    services.api.leaseStates.set(sentry.dseq, "closed"); // closed via another tool
    services.api.extraDeployments.push({ dseq: "999999", state: "active" }); // other instance's
    services.api.extraDeployments.push({ dseq: "888888", state: "closed" }); // history — hidden

    const view = await fleet.fleetForOwner("akash1owner");
    expect(view.fleets[0]!.components.find((c) => c.key === "sentry-0")!.state).toBe("closed");
    expect(view.unmanaged).toEqual([{ dseq: "999999", state: "active" }]);
  }, 120_000);

  it("refuses to relaunch mesh components once the fleet is shut down", async () => {
    const { db, services, work } = await launched();
    const fleet = new FleetService(db, services, work);
    await fleet.fleetForOwner("akash1owner"); // materialize
    const launch = db.getLaunch("fl")!;
    for (const c of db.listFleetComponents("fl")) {
      db.setComponentState("fl", c.key, "closed");
    }
    const sentry = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(() => fleet.requestRelaunch(launch, sentry)).toThrow(/headscale is closed/);
  }, 120_000);
});

describe("fleet health monitor", () => {
  it("reports healthy with runway, and distinct failure states", async () => {
    const { db, services, work } = await launched();
    const fleet = new FleetService(db, services, work);
    // deterministic runway well above the 3-day alert threshold
    fleet.materialize("fl");
    for (const c of db.listFleetComponents("fl")) {
      services.api.escrowBalances.set(c.dseq, { denom: "uact", amount: "100000000" });
    }
    await fleet.tick("fl");

    const health = new Map(db.listComponentHealth("fl").map((h) => [h.component, h]));
    expect(health.get("val-0")!.status).toBe("healthy");
    expect(health.get("sentry-0")!.status).toBe("healthy");
    // sentry height now lives in the live indicator, not the health detail
    expect(health.get("sentry-0")!.detail).not.toContain("height");
    expect(health.get("headscale")!.detail).toContain("runway");

    // low escrow → warning state
    const val = db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    services.api.escrowBalances.set(val.dseq, { denom: "uact", amount: "100" });
    await fleet.tick("fl");
    expect(db.listComponentHealth("fl").find((h) => h.component === "val-0")!.status).toBe(
      "low-escrow",
    );

    // lease gone → lease-not-active
    services.api.leaseStates.set(val.dseq, "closed");
    await fleet.tick("fl");
    expect(db.listComponentHealth("fl").find((h) => h.component === "val-0")!.status).toBe(
      "lease-not-active",
    );
  }, 120_000);
});

describe("fleet actions over HTTP", () => {
  it("guards a last-peer-path close, then closes through the signing loop", async () => {
    const { db, services, work, spec: s } = await launched();
    const app = buildServer({
      db,
      services,
      workRoot: work,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    void s;
    // the UI's first fleet query materializes the components
    const summary = (
      await app.inject({ method: "GET", url: "/api/fleet?owner=akash1owner" })
    ).json() as any;
    expect(summary.fleets).toHaveLength(1);
    const sentry = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;

    // guard: sentry-0 is val-0's only peer path → 409 with warnings
    const guarded = await app.inject({
      method: "POST",
      url: `/api/fleet/fl/${sentry.dseq}/actions`,
      payload: { action: "close" },
    });
    expect(guarded.statusCode).toBe(409);
    expect((guarded.json() as any).warnings[0]).toContain("only peer path");

    // confirmed close → pending signature in the launch's signing loop
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/fleet/fl/${sentry.dseq}/actions`,
      payload: { action: "close", confirm: true },
    });
    expect((confirmed.json() as any).status).toBe("awaiting-signature");

    const pending = await app.inject({ method: "GET", url: "/api/launches/fl/pending-tx" });
    expect(pending.statusCode).toBe(200);
    const { step, msgs } = pending.json() as any;
    expect(step).toBe(`fleet:close:${sentry.dseq}`);
    expect(msgs[0].typeUrl).toContain("MsgCloseDeployment");

    const settled = await app.inject({
      method: "POST",
      url: "/api/launches/fl/tx-result",
      payload: { txHash: "F1".repeat(32) },
    });
    expect((settled.json() as any).status).toBe("settled");
    expect(db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!.state).toBe("closed");

    // restart action reaches the node over SSH
    const val = db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const restarted = await app.inject({
      method: "POST",
      url: `/api/fleet/fl/${val.dseq}/actions`,
      payload: { action: "restart" },
    });
    expect((restarted.json() as any).status).toBe("restarted");
    expect(
      services.ssh.execLog.some((e) => e.command.includes("pkill -x sparkdreamd")),
    ).toBe(true);
  }, 120_000);
});

describe("progressive materialization", () => {
  it("adds components as their outputs land — an early pass must not block later ones", () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    db.createLaunch("pm", JSON.stringify(testnetSpec()), "akash1owner");
    const fleet = new FleetService(db, fakeServices() as any, work);

    const done = (name: string, output: unknown) => {
      db.stepStarted("pm", name);
      db.stepDone("pm", name, output);
    };
    // mid-launch: only headscale has output (the UI polls the fleet here)
    done("deploy-headscale", {
      dseq: "100", provider: "akash1p1", hostUri: "https://p1:8443", price: "1", gseq: 1, oseq: 1,
    });
    fleet.materialize("pm");
    expect(db.listFleetComponents("pm").map((c) => c.key)).toEqual(["headscale"]);

    // later: node outputs exist — the nodes must appear (and endpoints backfill)
    done("create-deployments", { perNode: { "val-0": { dseq: "101" } } });
    done("collect-bids", {
      perNode: { "val-0": { provider: "akash1p2", hostUri: "https://p2:8443", price: "2", gseq: 1, oseq: 1 } },
    });
    fleet.materialize("pm");
    expect(db.listFleetComponents("pm").map((c) => c.key)).toEqual(["headscale", "val-0"]);
    expect(db.listFleetComponents("pm").find((c) => c.key === "val-0")!.ssh_host).toBeNull();

    done("send-manifests", { perNode: { "val-0": { host: "p2", port: 30001 } } });
    fleet.materialize("pm");
    expect(db.listFleetComponents("pm").find((c) => c.key === "val-0")!.ssh_host).toBe("p2");
    db.close();
  });
});

describe("abort op", () => {
  it("stops a stuck op's steps and closes its deployment", async () => {
    const { db, services, work } = await launched();
    const app = buildServer({ db, services, workRoot: work, steps: allSteps(), monitorIntervalMs: 0 });
    await app.inject({ method: "GET", url: "/api/fleet?owner=akash1owner" });

    // simulate an in-progress relaunch that already leased a new deployment
    const opId = db.createFleetOp("fl", "relaunch", { key: "sentry-0", generation: 2 });
    db.stepStarted("fl", `op${opId}:deploy`);
    db.stepDone("fl", `op${opId}:deploy`, { dseq: "555001" });
    services.api.knownDseqs.add("555001"); // deploymentInfo → active

    const res = await app.inject({ method: "POST", url: `/api/fleet/fl/ops/${opId}/abort` });
    expect(res.statusCode).toBe(200);
    // op no longer contributes steps, and its deployment close is queued
    expect(db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("aborted");
    // and its step rows are erased so they stop showing as the launch error
    db.stepStarted("fl", `op${opId}:configure`);
    db.stepFailed("fl", `op${opId}:configure`, "boom");
    await app.inject({ method: "POST", url: `/api/fleet/fl/ops/${opId}/abort` });
    expect(db.listSteps("fl").some((s) => s.name.startsWith(`op${opId}:`))).toBe(false);
    const pending = db.getPendingTx("fl", "fleet:close:555001");
    expect(pending).toBeDefined();
    expect(JSON.parse(pending!.msgs_json)[0].typeUrl).toContain("MsgCloseDeployment");
  }, 120_000);
});

describe("provider preferences", () => {
  it("persists avoid/prefer lists and relaunch honors them", async () => {
    const { db, services, work } = await launched();
    const app = buildServer({ db, services, workRoot: work, steps: allSteps(), monitorIntervalMs: 0 });
    await app.inject({ method: "GET", url: "/api/fleet?owner=akash1owner" }); // materialize

    const sentry = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const val = db.listFleetComponents("fl").find((c) => c.key === "val-0")!;

    // add sentry's provider to avoid, val's to prefer
    await app.inject({
      method: "POST",
      url: "/api/fleet/fl/provider-prefs",
      payload: { provider: sentry.provider, kind: "avoid" },
    });
    const prefs = (
      await app.inject({
        method: "POST",
        url: "/api/fleet/fl/provider-prefs",
        payload: { provider: val.provider, kind: "prefer" },
      })
    ).json() as any;
    expect(prefs.avoid).toContain(sentry.provider);
    expect(prefs.prefer).toContain(val.provider);

    // GET reflects the persisted lists
    const fetched = (
      await app.inject({ method: "GET", url: "/api/fleet/fl/provider-prefs" })
    ).json() as any;
    expect(fetched).toEqual(prefs);

    // relaunch bakes avoid (own provider + list) and prefer into the op params
    await app.inject({
      method: "POST",
      url: `/api/fleet/fl/${sentry.dseq}/actions`,
      payload: { action: "relaunch", confirm: true },
    });
    const op = db.listFleetOps("fl").find((o) => o.kind === "relaunch")!;
    const params = JSON.parse(op.params_json);
    expect(params.avoidProviders).toContain(sentry.provider);
    expect(params.preferProviders).toContain(val.provider);

    // removal works
    const cleared = (
      await app.inject({
        method: "POST",
        url: "/api/fleet/fl/provider-prefs",
        payload: { provider: sentry.provider, kind: "none" },
      })
    ).json() as any;
    expect(cleared.avoid).not.toContain(sentry.provider);
  }, 120_000);

  it("is wallet-global: shared across the owner's launches", async () => {
    const { db, services, work } = await launched();
    // a second launch owned by the SAME wallet
    db.createLaunch("fl2", JSON.stringify(spec()), "akash1owner");
    const app = buildServer({ db, services, workRoot: work, steps: allSteps(), monitorIntervalMs: 0 });

    await app.inject({
      method: "POST",
      url: "/api/fleet/fl/provider-prefs",
      payload: { provider: "akash1bad", kind: "avoid", name: "bad.provider" },
    });
    // the OTHER launch sees it too (same wallet)
    const other = (
      await app.inject({ method: "GET", url: "/api/fleet/fl2/provider-prefs" })
    ).json() as any;
    expect(other.avoid).toContain("akash1bad");
    expect(other.names["akash1bad"]).toBe("bad.provider");

    // a different wallet's launch does NOT
    db.createLaunch("fl3", JSON.stringify(spec()), "akash1other");
    const foreign = (
      await app.inject({ method: "GET", url: "/api/fleet/fl3/provider-prefs" })
    ).json() as any;
    expect(foreign.avoid).not.toContain("akash1bad");
  }, 120_000);

  it("migrates pre-existing per-launch prefs into the global list on boot", () => {
    const work = tmp();
    const dbPath = path.join(work, "state.db");
    const db1 = new ConductorDb(dbPath);
    db1.createLaunch("m1", JSON.stringify(testnetSpec()), "akash1migrate");
    // simulate a legacy per-launch row (the global table starts empty)
    db1.db
      .prepare("INSERT INTO provider_prefs (launch_id, provider, kind, name) VALUES (?,?,?,?)")
      .run("m1", "akash1legacy", "avoid", "legacy.provider");
    expect(db1.providerPrefs("akash1migrate").avoid).not.toContain("akash1legacy"); // not global yet
    db1.close();

    // reopen: constructor migrate() lifts it into the global list
    const db2 = new ConductorDb(dbPath);
    const prefs = db2.providerPrefs("akash1migrate");
    expect(prefs.avoid).toContain("akash1legacy");
    expect(prefs.names["akash1legacy"]).toBe("legacy.provider");
    db2.close();
  });
});

describe("fleet utilities", () => {
  it("serves component SDLs, genesis, and shuts the fleet down in one tx", async () => {
    const { db, services, work } = await launched();
    const app = buildServer({ db, services, workRoot: work, steps: allSteps(), monitorIntervalMs: 0 });
    await app.inject({ method: "GET", url: "/api/fleet?owner=akash1owner" }); // materialize

    // SDL download — node component and headscale both serve
    const val = db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const sdl = await app.inject({ method: "GET", url: `/api/fleet/fl/${val.dseq}/sdl` });
    expect(sdl.statusCode).toBe(200);
    expect(sdl.body).toContain("sparkdreamd");
    const hs = db.listFleetComponents("fl").find((c) => c.key === "headscale")!;
    const hsSdl = await app.inject({ method: "GET", url: `/api/fleet/fl/${hs.dseq}/sdl` });
    expect(hsSdl.statusCode).toBe(200);
    expect(hsSdl.body).toContain("headscale");

    // genesis download
    const genesis = await app.inject({ method: "GET", url: "/api/launches/fl/genesis" });
    expect(genesis.statusCode).toBe(200);
    expect(JSON.parse(genesis.body).chain_id).toBeDefined();

    // shutdown: one pending tx with a close per active component
    const shutdown = await app.inject({ method: "POST", url: "/api/fleet/fl/shutdown" });
    expect(shutdown.statusCode).toBe(200);
    const activeCount = db.listFleetComponents("fl").filter((c) => c.state !== "closed").length;
    const pending = (
      await app.inject({ method: "GET", url: "/api/launches/fl/pending-tx" })
    ).json() as any;
    expect(pending.step).toBe("fleet:shutdown");
    expect(pending.msgs).toHaveLength(activeCount);
    expect(pending.msgs.every((m: any) => m.typeUrl.includes("MsgCloseDeployment"))).toBe(true);

    // sign → settle → everything closed
    await app.inject({
      method: "POST",
      url: "/api/launches/fl/tx-result",
      payload: { txHash: "AB".repeat(32) },
    });
    expect(db.listFleetComponents("fl").every((c) => c.state === "closed")).toBe(true);
  }, 120_000);
});

describe("fleet bundle", () => {
  it("round-trips: export from one instance, import into another", async () => {
    const { db, services, work } = await launched();
    const fleet = new FleetService(db, services, work);
    await fleet.fleetForOwner("akash1owner"); // materialize
    const launch = db.getLaunch("fl")!;
    // node homes ride in the bundle since v2 (consensus/node keys + keyring)
    const nodeCfg = path.join(work, "launches/fl/nodes/val-0/config");
    fs.mkdirSync(nodeCfg, { recursive: true });
    fs.writeFileSync(path.join(nodeCfg, "node_key.json"), '{"priv_key":"fake"}');
    const bundlePath = await fleet.exportBundle(launch);
    expect(fs.existsSync(bundlePath)).toBe(true);

    // second launcher instance (fresh db + workdir); user has run `age -d`
    const work2 = tmp();
    const db2 = new ConductorDb(path.join(work2, "state.db"));
    const app2 = buildServer({
      db: db2,
      services: fakeServices(),
      workRoot: work2,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    const res = await app2.inject({
      method: "POST",
      url: "/api/fleet/import",
      headers: { "content-type": "application/octet-stream" },
      payload: fs.readFileSync(bundlePath),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).launchId).toBe("fl");

    // the second instance now manages the fleet: components + secrets restored
    const view = (
      await app2.inject({ method: "GET", url: "/api/fleet?owner=akash1owner" })
    ).json() as any;
    expect(view.fleets).toHaveLength(1);
    expect(view.fleets[0].components.map((c: any) => c.key).sort()).toEqual([
      "headscale",
      "sentry-0",
      "val-0",
    ]);
    expect(
      fs.existsSync(path.join(work2, "launches/fl/secrets/ssh_ed25519.pem")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(work2, "launches/fl/nodes/val-0/config/node_key.json")),
    ).toBe(true);
    db2.close();
    db.close();
  }, 120_000);

  it("still imports a v1 bundle that has no nodes directory", async () => {
    const { db, services, work } = await launched();
    const fleet = new FleetService(db, services, work);
    await fleet.fleetForOwner("akash1owner"); // materialize
    const bundlePath = await fleet.exportBundle(db.getLaunch("fl")!);

    // reshape into a v1 bundle: extract (fake encryptBackup is a plain
    // tarball), drop nodes/, re-tar
    const { execFileSync } = await import("node:child_process");
    const unpack = tmp();
    execFileSync("tar", ["xzf", bundlePath, "-C", unpack]);
    fs.rmSync(path.join(unpack, "nodes"), { recursive: true, force: true });
    const v1Bundle = path.join(tmp(), "v1-bundle.tar.gz");
    execFileSync("tar", ["czf", v1Bundle, "-C", unpack, "."]);

    const work2 = tmp();
    const db2 = new ConductorDb(path.join(work2, "state.db"));
    const app2 = buildServer({
      db: db2,
      services: fakeServices(),
      workRoot: work2,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    const res = await app2.inject({
      method: "POST",
      url: "/api/fleet/import",
      headers: { "content-type": "application/octet-stream" },
      payload: fs.readFileSync(v1Bundle),
    });
    expect(res.statusCode).toBe(200);
    expect(db2.getLaunch("fl")).toBeTruthy();
    expect(fs.existsSync(path.join(work2, "launches/fl/nodes"))).toBe(false);
    db2.close();
    db.close();
  }, 120_000);
});

// keep the FakeWorld import "used" for its type-level guarantees
type _Check = FakeWorld;
