import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps, standbyProblem } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { withStandbyApiPort } from "../src/sentry-serve.js";
import { servingSentry } from "../src/serving-sentry.js";
import { setCloudflareToken } from "../src/dns.js";
import { setAlertSettings } from "../src/incidents.js";
import { UNREACHABLE_HOLD_MS } from "../src/fleet.js";
import { vi } from "vitest";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function spec(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 2 },
      components: {
        explorer: { enabled: true, domain: "explorer.sparkdream.io" },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
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
  spec: LaunchSpec;
  /** every Origin Rule the launcher set: domain → "host:port" */
  origins: string[];
}

async function launched(opts: { dns?: boolean } = {}): Promise<World> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-switch-"));
  tmpDirs.push(work);
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  const s = spec();
  const origins: string[] = [];
  if (opts.dns !== false) {
    services.dns = {
      pointCname: async () => true,
      pointOrigin: async (name: string, target: string, port: number) => {
        origins.push(`${name} → ${target}:${port}`);
        return true;
      },
    } as unknown as NonNullable<FakeWorld["dns"]>;
  }
  if (opts.dns !== false) setCloudflareToken(work, "token");
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  expect((await runWithSigner(db, "fl", s, work, allSteps(), services, signer)).status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  return { work, db, services, fleet, signer, spec: s, origins };
}

async function driveOps(w: World) {
  const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer);
}

const row = (w: World, key: string) => w.db.listFleetComponents("fl").find((c) => c.key === key)!;
const sdl = (w: World, key: string) => fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", `${key}.yaml`), "utf8");
const host = (hostUri: string) => new URL(hostUri).hostname;

describe("every sentry can serve", () => {
  it("forwards the LCD port on each sentry, with the domain accepts on sentry-0 alone", async () => {
    const w = await launched();
    const expose = (key: string) => (yaml.load(sdl(w, key)) as any).services.sparkdreamd.expose as any[];
    expect(expose("sentry-0").find((e) => e.port === 1317)).toMatchObject({ accept: ["api.sparkdream.io"] });
    const standby = expose("sentry-1").find((e) => e.port === 1317);
    expect(standby).toMatchObject({ to: [{ global: true }] });
    expect(standby.accept).toBeUndefined();
    expect(expose("sentry-1").find((e) => e.port === 26657).accept).toBeUndefined();
    w.db.close();
  }, 120_000);

  it("adds the port to a sentry SDL stored before that, once, and says what a lease without it lacks", () => {
    const s = spec();
    const old = yaml.dump({ services: { sparkdreamd: { expose: [{ port: 26657, as: 26657, to: [{ global: true }] }] } } });
    const next = withStandbyApiPort(old, s);
    expect((yaml.load(next) as any).services.sparkdreamd.expose.map((e: any) => e.port)).toEqual([26657, 1317]);
    expect(withStandbyApiPort(next, s)).toBe(next);

    const lease = (ports: number[]) => ({ forwarded_ports: { sparkdreamd: ports.map((port) => ({ host: "p.example", port, externalPort: 30000 + port })) } });
    expect(standbyProblem(s, "sentry-1", lease([26657, 1317]))).toBeNull();
    expect(standbyProblem(s, "sentry-1", lease([26657]))).toMatch(/forwards no API port \(1317\).*relaunch sentry-1 once/);
  });
});

describe("switching the serving sentry", () => {
  it("moves the public domains and the explorer to the other sentry, and leaves the first alone", async () => {
    const w = await launched();
    const s0 = row(w, "sentry-0");
    const s1 = row(w, "sentry-1");
    expect(host(s0.host_uri)).not.toBe(host(s1.host_uri));
    expect(servingSentry(w.db, "fl")).toBe("sentry-0");
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${s0.tailnet_ip}:1317`);
    // scheduled backups copy the sentry that is not serving
    expect(w.fleet.backupSourceFor("fl")?.key).toBe("sentry-1");

    const opId = w.fleet.requestSwitchSentry(w.db.getLaunch("fl")!, s1);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");

    expect(servingSentry(w.db, "fl")).toBe("sentry-1");
    expect(w.origins.filter((o) => o.includes(host(s1.host_uri))).map((o) => o.split(" ")[0]).sort()).toEqual([
      "api.sparkdream.io",
      "rpc.sparkdream.io",
    ]);
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${s1.tailnet_ip}:1317`);
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_2=26657:${s1.tailnet_ip}:26657`);
    expect(w.services.provider.lastManifest.get(row(w, "explorer").dseq)).toContain(`11317:${s1.tailnet_ip}:1317`);
    // the sentry switched away from was not touched
    expect(row(w, "sentry-0")).toMatchObject({ dseq: s0.dseq, state: "active" });
    expect(w.fleet.backupSourceFor("fl")?.key).toBe("sentry-0");
    const card = (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(card.servingSentry).toBe("sentry-1");
    expect(() => w.fleet.requestSwitchSentry(w.db.getLaunch("fl")!, row(w, "sentry-1"))).toThrow(/serving sentry already/);

    // sentry-0, no longer serving, is moved: neither DNS nor the explorer follow it
    const pointedBefore = w.origins.length;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, s0);
    w.services.api.leaseStates.set(s0.dseq, "closed");
    w.services.ssh.failHosts.add(`${s0.ssh_host}:${s0.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");
    expect(row(w, "sentry-0").dseq).not.toBe(s0.dseq);
    expect(w.origins).toHaveLength(pointedBefore);
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${s1.tailnet_ip}:1317`);

    // the serving one is moved: both follow it
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, s1);
    w.services.api.leaseStates.set(s1.dseq, "closed");
    w.services.ssh.failHosts.add(`${s1.ssh_host}:${s1.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");
    const moved = row(w, "sentry-1");
    expect(moved.dseq).not.toBe(s1.dseq);
    expect(w.origins.slice(pointedBefore).some((o) => o.startsWith("api.sparkdream.io") && o.includes(host(moved.host_uri)))).toBe(true);
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${moved.tailnet_ip}:1317`);
    w.db.close();
  }, 240_000);

  it("asks once for the records it cannot set itself, then carries on", async () => {
    const w = await launched({ dns: false });
    const s1 = row(w, "sentry-1");
    w.fleet.requestSwitchSentry(w.db.getLaunch("fl")!, s1);
    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/api\.sparkdream\.io → CNAME .* Origin Rule/);
    // the role moved already: what is left is the owner's DNS
    expect(servingSentry(w.db, "fl")).toBe("sentry-1");
    expect((await driveOps(w)).status).toBe("completed");
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${s1.tailnet_ip}:1317`);
    w.db.close();
  }, 240_000);
});

/** The provider of this deployment stops answering the launcher (the fake
 *  RPC answers any address, so the remembered one is forgotten too). */
function down(w: World, dseq: string): void {
  w.services.provider.apiDownDseqs.add(dseq);
  (w.fleet as unknown as { rpcUrlCache: Map<string, unknown> }).rpcUrlCache.delete(dseq);
}

describe("failing over", () => {
  /** A world whose monitor alerts are collected, with auto-recovery on. */
  async function watched(opts: { dns?: boolean } = {}) {
    const w = await launched(opts);
    const alerts: string[] = [];
    w.fleet.alertFetch = (async (_url: string, init: RequestInit) => {
      alerts.push(String((init.headers as Record<string, string>).Title));
      return new Response("ok");
    }) as typeof fetch;
    setAlertSettings(w.db, { ntfy: { server: "https://ntfy.sh", topic: "t" } });
    w.fleet.setAutoRecoverPolicy(w.db.getLaunch("fl")!, { enabled: true, sentries: true });
    for (const c of w.db.listFleetComponents("fl")) {
      w.services.api.escrowBalances.set(c.dseq, { denom: "uact", amount: "100000000" });
    }
    const pass = async (n = 1) => {
      for (let i = 0; i < n; i++) {
        await w.fleet.tick("fl");
        await w.fleet.trackIncidents("fl");
      }
    };
    return { w, alerts, pass };
  }

  it("hands the role to the standby as soon as the serving sentry's outage is confirmed, and moves the sentry only after the hold", async () => {
    const { w, alerts, pass } = await watched();
    const s0 = row(w, "sentry-0");
    const s1 = row(w, "sentry-1");
    await pass(); // everything read healthy once: the standby is known good
    down(w, s0.dseq);
    await pass(4);
    expect(w.db.openIncident("fl", "sentry-0")?.confirmed_at).toBeTruthy();
    const ops = w.db.listFleetOps("fl", "active");
    expect(ops.map((o) => o.kind)).toEqual(["switch-sentry"]);
    expect(JSON.parse(ops[0]!.params_json)).toMatchObject({ key: "sentry-1", from: "sentry-0", auto: true });
    expect(alerts).toContain("sparkdream: sentry-1 takes over from sentry-0");
    expect(w.fleet.autoStarted.has("fl")).toBe(true);

    expect((await driveOps(w)).status).toBe("completed");
    expect(servingSentry(w.db, "fl")).toBe("sentry-1");
    expect(w.origins.some((o) => o.startsWith("rpc.sparkdream.io") && o.includes(host(s1.host_uri)))).toBe(true);
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${s1.tailnet_ip}:1317`);

    // sentry-0 itself: still inside the hold, nothing moves it
    await pass(2);
    expect(w.db.listFleetOps("fl", "active")).toHaveLength(0);
    // past the hold and still down: relaunched, as a sentry that no longer serves
    const real = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + UNREACHABLE_HOLD_MS + 60_000);
    try {
      await pass();
    } finally {
      spy.mockRestore();
    }
    const relaunch = w.db.listFleetOps("fl", "active");
    expect(relaunch.map((o) => o.kind)).toEqual(["relaunch"]);
    expect(JSON.parse(relaunch[0]!.params_json)).toMatchObject({ key: "sentry-0", auto: true, serving: false });
    w.db.close();
  }, 240_000);

  it("says so, once, when the standby cannot take over, and falls back to recovering the sentry", async () => {
    const { w, alerts, pass } = await watched({ dns: false });
    await pass();
    down(w, row(w, "sentry-0").dseq);
    await pass(5);
    expect(w.db.listFleetOps("fl", "active")).toHaveLength(0);
    expect(servingSentry(w.db, "fl")).toBe("sentry-0");
    expect(alerts.filter((a) => a.includes("no sentry can take over"))).toHaveLength(1);
    expect(alerts.some((a) => a.includes("left alone for now"))).toBe(true);
    w.db.close();
  }, 240_000);

  it("a relaunch by hand of the serving sentry switches to the standby first", async () => {
    const { w, pass } = await watched();
    const s0 = row(w, "sentry-0");
    const s1 = row(w, "sentry-1");
    await pass();
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, s0);
    const ops = w.db.listFleetOps("fl", "active").sort((a, b) => a.id - b.id);
    expect(ops.map((o) => o.kind)).toEqual(["switch-sentry", "relaunch"]);
    expect(JSON.parse(ops[1]!.params_json)).toMatchObject({ key: "sentry-0", serving: false });
    w.services.api.leaseStates.set(s0.dseq, "closed");
    w.services.ssh.failHosts.add(`${s0.ssh_host}:${s0.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");
    expect(servingSentry(w.db, "fl")).toBe("sentry-1");
    expect(row(w, "sentry-0").dseq).not.toBe(s0.dseq);
    // the domains went to the standby once, and did not follow sentry-0 back
    expect(w.origins.every((o) => o.includes(host(s1.host_uri)))).toBe(true);
    expect(sdl(w, "explorer")).toContain(`TS_TUNNEL_1=11317:${s1.tailnet_ip}:1317`);
    w.db.close();
  }, 240_000);
});
