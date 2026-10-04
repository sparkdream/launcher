import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TypeUrl } from "@sparkdream/akash-tx";
import { testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runLaunch, runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-addsentry-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec1x1(mapping?: number[][]): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1, ...(mapping ? { mapping } : {}) },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
      headscale: { domain: "headscale.sparkdream.io" },
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

async function launched(spec: LaunchSpec): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  db.createLaunch("fl", JSON.stringify(spec), "akash1owner");
  expect((await runWithSigner(db, "fl", spec, work, allSteps(), services, signer)).status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  return { work, db, services, fleet, signer };
}

async function driveOps(w: World) {
  const s = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
  const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", s, w.work, steps, w.services, w.signer);
}

const row = (w: World, key: string) => w.db.listFleetComponents("fl").find((c) => c.key === key);
const ids = (w: World) => w.db.stepOutput<{ nodeIds: Record<string, string> }>("fl", "generate-keys")!.nodeIds;

describe("adding a sentry to a running fleet", () => {
  it("builds its home, places it, and wires it into the live fleet", async () => {
    const w = await launched(spec1x1());
    // before: sentry-0 is val-0's only way to the chain
    const warnedBefore = w.fleet.relaunchWarnings(w.db.getLaunch("fl")!, row(w, "sentry-0")!).join(" ");
    expect(warnedBefore).toMatch(/only connection to the chain/);
    const signedBefore = w.signer.signed.length;
    const { opId, key } = w.fleet.requestAddSentry(w.db.getLaunch("fl")!, { size: "small" });
    expect(key).toBe("sentry-1");
    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");

    // the spec counts it, sized as asked
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    expect(stored.topology.sentries.count).toBe(2);
    expect(stored.infra.nodeSizes["sentry-1"]).toBe("small");

    // a placed, active row on its own provider (strict anti-affinity)
    const s1 = row(w, "sentry-1")!;
    const s0 = row(w, "sentry-0")!;
    const v0 = row(w, "val-0")!;
    expect(s1.state).toBe("active");
    expect(s1.dseq).not.toBe("0");
    expect(s1.tailnet_ip).toMatch(/^100\./);
    expect(s1.provider).not.toBe(s0.provider);
    // one deployment created, one lease; nothing closed
    const msgs = w.signer.signed.slice(signedBefore).flat();
    expect(msgs.filter((m) => m.typeUrl === TypeUrl.CreateDeployment)).toHaveLength(1);
    expect(msgs.filter((m) => m.typeUrl === TypeUrl.CloseDeployment)).toHaveLength(0);

    // its node id is where every peer-line writer reads ids
    const id1 = ids(w)["sentry-1"]!;
    expect(id1).toMatch(/^[0-9a-f]{40}$/);

    // its SDL: booted (out of wait mode), tunnel to val-0's live address, no public hosts
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/sentry-1.yaml"), "utf8");
    expect(sdl).toContain("WAIT_FOR_CONFIG=false");
    expect(sdl).toContain(`${v0.tailnet_ip}:26656`);
    expect(sdl).not.toContain("api.sparkdream.io");

    // live wiring: sentry-0 peers with it directly, val-0 keeps it unconditionally
    const s0Target = `${s0.ssh_host}:${s0.ssh_port}`;
    const v0Target = `${v0.ssh_host}:${v0.ssh_port}`;
    const on = (t: string) => w.services.ssh.execLog.filter((e) => e.target === t).map((e) => e.command);
    expect(on(s0Target).some((c) => c.includes("persistent_peers") && c.includes(`${id1}@${s1.tailnet_ip}:26656`))).toBe(true);
    expect(on(v0Target).some((c) => c.includes("unconditional_peer_ids") && c.includes(id1))).toBe(true);
    // val-0's peer line is rebuilt with both sentries
    expect(on(v0Target).some((c) => c.includes("persistent_peers") && c.includes(id1) && c.includes(ids(w)["sentry-0"]!))).toBe(true);

    // launcher-side: the other homes know it, so their next relaunch does
    const s0Config = fs.readFileSync(path.join(w.work, "launches/fl/nodes/sentry-0/config/config.toml"), "utf8");
    expect(s0Config).toContain(`${id1}@{{TAILNET_IP:sentry-1}}:26656`);
    const s1Config = fs.readFileSync(path.join(w.work, "launches/fl/nodes/sentry-1/config/config.toml"), "utf8");
    expect(s1Config).toContain(ids(w)["sentry-0"]!);
    expect(fs.existsSync(path.join(w.work, "launches/fl/bundles/sentry-1.tgz"))).toBe(true);

    // and the confirm warning about sentry-0 being val-0's only path is gone
    const warnings = w.fleet.relaunchWarnings(w.db.getLaunch("fl")!, s0).join(" ");
    expect(warnings).not.toMatch(/only connection to the chain/);
  }, 240_000);

  it("extends an explicit sentry mapping", async () => {
    const w = await launched(spec1x1([[0]]));
    w.fleet.requestAddSentry(w.db.getLaunch("fl")!);
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.sentries.mapping).toEqual([[0], [0]]);
  }, 120_000);

  it("an abandoned add puts the spec, row, ids and peer lists back as they were", async () => {
    const w = await launched(spec1x1());
    const s0Config = path.join(w.work, "launches/fl/nodes/sentry-0/config/config.toml");
    const configBefore = fs.readFileSync(s0Config, "utf8");
    const specBefore = JSON.parse(w.db.getLaunch("fl")!.spec_json).topology.sentries;
    const { opId } = w.fleet.requestAddSentry(w.db.getLaunch("fl")!, { size: "small" });
    // no signer: the op builds the home and row, then waits on its deployment tx
    const s = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const parked = await runLaunch(w.db, "fl", s, w.work, [...allSteps(), ...buildOpSteps(w.db, "fl")], w.services);
    expect(parked.status).not.toBe("completed");
    expect(row(w, "sentry-1")).toBeDefined();
    const id1 = ids(w)["sentry-1"]!;
    expect(fs.readFileSync(s0Config, "utf8")).toContain(id1);

    await w.fleet.requestAbortOp(w.db.getLaunch("fl")!, opId);
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    expect(stored.topology.sentries).toEqual(specBefore);
    expect(stored.infra?.nodeSizes?.["sentry-1"]).toBeUndefined();
    expect(row(w, "sentry-1")).toBeUndefined();
    expect(ids(w)["sentry-1"]).toBeUndefined();
    expect(fs.readFileSync(s0Config, "utf8")).toBe(configBefore);
    expect(fs.existsSync(path.join(w.work, "launches/fl/nodes/sentry-1"))).toBe(false);

    // and the fleet still relaunches its sentry, which used to throw on the missing sentry-1
    const s0 = row(w, "sentry-0")!;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, s0);
    w.services.api.leaseStates.set(s0.dseq, "closed");
    w.services.ssh.failHosts.add(`${s0.ssh_host}:${s0.ssh_port}`);
    w.services.rpc.darkUrls.clear();
    const res = await driveOps(w);
    expect(res.status).toBe("completed");
  }, 240_000);

  it("refuses while another operation runs", async () => {
    const w = await launched(spec1x1());
    w.fleet.requestAddSentry(w.db.getLaunch("fl")!);
    expect(() => w.fleet.requestAddSentry(w.db.getLaunch("fl")!)).toThrow(/another operation/);
  }, 120_000);
});
