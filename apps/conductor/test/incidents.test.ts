import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { allSteps } from "../src/index.js";
import { alertSettings, classify, publicAlertSettings, sendAlert, setAlertSettings, trackIncident } from "../src/incidents.js";
import { fakeServices, FakeSigner } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-incidents-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

function bareDb(): ConductorDb {
  const db = new ConductorDb(path.join(tmp(), "state.db"));
  db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
  return db;
}

describe("classifying an outage", () => {
  it("tells a dead provider, a dead container and a stuck service apart", () => {
    expect(classify("sentry-0", "unreachable", "unreachable").action).toBe("relaunch");
    expect(classify("sentry-0", "unreachable", "service-down").action).toBe("force-redeploy");
    expect(classify("sentry-0", "unreachable", "up").action).toBe("restart");
    // answering inside its container: the public path is broken, a restart fixes nothing
    expect(classify("headscale", "unreachable", "public-only")).toMatchObject({ action: null, severity: "down" });
    // a relayer whose mesh tunnel dials a dead address: repair re-aims it,
    // where a relaunch would only move a container that is fine
    expect(classify("relayer", "stale-tunnel", "unknown")).toMatchObject({ action: "repair", severity: "down" });
    // the container runs but the provider's own hostname serves nothing: a
    // restart cannot fix the provider's ingress, a move can
    expect(classify("explorer", "unreachable", "ingress-broken")).toMatchObject({ action: "relaunch", severity: "down" });
    expect(classify("val-0", "lease-not-active", "unknown").action).toBe("relaunch");
    expect(classify("val-0", "jailed", "unknown").action).toBe("unjail");
    expect(classify("val-0", "low-escrow", "unknown")).toMatchObject({ action: "topup", severity: "warn" });
  });
});

describe("incident lifecycle", () => {
  it("a blip never becomes an incident", async () => {
    const db = bareDb();
    const probe = async () => "unreachable" as const;
    expect(await trackIncident(db, "fl", "sentry-0", "unreachable", "x", probe)).toBeUndefined();
    expect(await trackIncident(db, "fl", "sentry-0", "healthy", null, probe)).toBeUndefined();
    expect(db.openIncident("fl", "sentry-0")).toBeUndefined();
    expect(db.listIncidents("fl")).toEqual([]);
  });

  it("opens after three bad checks with the probe's diagnosis, and resolves when healthy", async () => {
    const db = bareDb();
    let probed = 0;
    const probe = async () => {
      probed++;
      return "unreachable" as const;
    };
    expect(await trackIncident(db, "fl", "sentry-0", "unreachable", "ECONNREFUSED", probe)).toBeUndefined();
    expect(await trackIncident(db, "fl", "sentry-0", "unreachable", "ECONNREFUSED", probe)).toBeUndefined();
    const opened = await trackIncident(db, "fl", "sentry-0", "unreachable", "ECONNREFUSED", probe);
    expect(opened?.kind).toBe("opened");
    expect(opened?.incident.action).toBe("relaunch");
    expect(probed).toBe(1);
    // still down: no second alert, no second probe
    expect(await trackIncident(db, "fl", "sentry-0", "unreachable", "ECONNREFUSED", probe)).toBeUndefined();
    expect(probed).toBe(1);
    // catching up after the fix is not yet recovered
    expect(await trackIncident(db, "fl", "sentry-0", "catching-up", null, probe)).toBeUndefined();
    const resolved = await trackIncident(db, "fl", "sentry-0", "healthy", null, probe);
    expect(resolved?.kind).toBe("resolved");
    expect(db.listIncidents("fl")[0]!.closed_at).toBeTruthy();
  });

  it("a lease the chain reports closed confirms on the second check", async () => {
    const db = bareDb();
    const probe = async () => "unknown" as const;
    await trackIncident(db, "fl", "val-0", "lease-not-active", "lease: closed", probe);
    const ev = await trackIncident(db, "fl", "val-0", "lease-not-active", "lease: closed", probe);
    expect(ev?.kind).toBe("opened");
  });
});

describe("monitor to alert", () => {
  it("a provider that closes the sentry's lease is alerted on ntfy, with relaunch suggested", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
    expect((await runWithSigner(db, "fl", spec(), work, allSteps(), services, new FakeSigner())).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    fleet.alertFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response("ok");
    }) as typeof fetch;
    setAlertSettings(db, { ntfy: { server: "https://ntfy.sh", topic: "sparkdream-alerts" } });

    const sentry = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    services.api.leaseStates.set(sentry.dseq, "closed");
    // the fake escrow drains too, so other components raise runway warnings:
    // only sentry-0's alerts are this test's
    const sentryAlerts = () => sent.filter((x) => x.headers.Title!.includes("sentry-0"));
    for (let i = 0; i < 2; i++) {
      await fleet.tick("fl");
      await fleet.trackIncidents("fl");
    }
    expect(sentryAlerts()).toHaveLength(1);
    expect(sentryAlerts()[0]!.url).toBe("https://ntfy.sh/sparkdream-alerts");
    expect(sentryAlerts()[0]!.headers.Title).toBe("sparkdream: sentry-0 is down");
    expect(sentryAlerts()[0]!.headers.Priority).toBe("high");
    expect(sentryAlerts()[0]!.body).toContain("Suggested fix: relaunch it");

    const view = (await fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    expect(view.incidents.find((i) => i.component === "sentry-0")).toMatchObject({ component: "sentry-0", action: "relaunch", closedAt: null });

    services.api.leaseStates.set(sentry.dseq, "active");
    await fleet.tick("fl");
    await fleet.trackIncidents("fl");
    expect(sentryAlerts()).toHaveLength(2);
    expect(sentryAlerts()[1]!.headers.Title).toBe("sparkdream: sentry-0 is back");
  }, 120_000);

  it("keeps watching a fleet paused inside an op, leaving out what the op is working on", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
    expect((await runWithSigner(db, "fl", spec(), work, allSteps(), services, new FakeSigner())).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    const sent: string[] = [];
    fleet.alertFetch = (async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>).Title!);
      return new Response("ok");
    }) as typeof fetch;
    setAlertSettings(db, { ntfy: { server: "https://ntfy.sh", topic: "sparkdream-alerts" } });

    // a relaunch of val-0 failed and left the launch paused; meanwhile
    // sentry-0's provider closes its lease
    db.createFleetOp("fl", "relaunch", { key: "val-0", generation: 1 });
    db.setLaunchStatus("fl", "paused");
    const rows = db.listFleetComponents("fl");
    for (const key of ["sentry-0", "val-0"]) {
      services.api.leaseStates.set(rows.find((c) => c.key === key)!.dseq, "closed");
    }
    for (let i = 0; i < 2; i++) {
      await fleet.tick("fl");
      await fleet.trackIncidents("fl");
    }
    expect(sent).toContain("sparkdream: sentry-0 is down");
    // val-0 is the op's to move: no reading, no alert
    expect(sent.some((t) => t.includes("val-0"))).toBe(false);
    expect(db.listComponentHealth("fl").find((h) => h.component === "val-0")).toBeUndefined();

    // an op that may touch anything (a chain reset) leaves the fleet alone
    const sentBefore = sent.length;
    db.createFleetOp("fl", "reset-chain", {});
    services.api.leaseStates.set(rows.find((c) => c.key === "sentry-0")!.dseq, "active");
    await fleet.tick("fl");
    await fleet.trackIncidents("fl");
    expect(sent).toHaveLength(sentBefore);
    expect(db.listComponentHealth("fl").find((h) => h.component === "sentry-0")?.status).toBe("lease-not-active");
  }, 120_000);

  it("refuses an ntfy topic that would not be a URL path segment", () => {
    const db = bareDb();
    expect(() => setAlertSettings(db, { ntfy: { server: "", topic: "a/b" } })).toThrow(/letters, digits/);
  });

  it("falls back to a second ntfy topic when the server does not take the alert, never sending it the token", async () => {
    const db = bareDb();
    const token = "tk_0123456789abcdefghijklmnopqrs";
    setAlertSettings(db, {
      ntfy: { server: "https://ntfy.sparkdream.io", topic: "sparkdream-alerts", token },
      ntfyFallback: { server: "", topic: "sparkdream-k3v9x2q7" },
    });
    const sent: { url: string; headers: Record<string, string> }[] = [];
    let down = true;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string> });
      if (down && url.startsWith("https://ntfy.sparkdream.io")) throw new Error("connect ECONNREFUSED");
      return new Response("ok");
    }) as typeof fetch;
    const alert = { fleet: "f", component: "ntfy", kind: "opened" as const, severity: "down" as const, title: "f: ntfy is down", message: "m" };
    const failures = await sendAlert(alertSettings(db), alert, fetchImpl);
    expect(sent.map((x) => x.url)).toEqual(["https://ntfy.sparkdream.io/sparkdream-alerts", "https://ntfy.sh/sparkdream-k3v9x2q7"]);
    expect(sent[1]!.headers.Authorization).toBeUndefined();
    expect(failures.join(" ")).toMatch(/sent to the fallback/);
    // while the server takes alerts, the fallback stays quiet
    down = false;
    sent.length = 0;
    expect(await sendAlert(alertSettings(db), alert, fetchImpl)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("logs in to a self-hosted ntfy with a token it never sends back to the browser", async () => {
    const db = bareDb();
    const token = "tk_0123456789abcdefghijklmnopqrs";
    setAlertSettings(db, { ntfy: { server: "https://ntfy.sparkdream.io/", topic: "sparkdream-alerts", token } });
    expect(publicAlertSettings(db)).toEqual({
      ntfy: { server: "https://ntfy.sparkdream.io", topic: "sparkdream-alerts" },
      ntfyTokenSet: true,
    });
    // the form saves without the token (it never had it): the stored one stays
    setAlertSettings(db, { ntfy: { server: "https://ntfy.sparkdream.io", topic: "sparkdream-alerts" } });
    expect(alertSettings(db).ntfy?.token).toBe(token);

    const sent: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response("ok");
    }) as typeof fetch;
    await sendAlert(alertSettings(db), { fleet: "f", component: "c", kind: "test", severity: "warn", title: "t", message: "m" }, fetchImpl);
    expect(sent[0]!.Authorization).toBe(`Bearer ${token}`);

    setAlertSettings(db, { ntfy: { server: "https://ntfy.sparkdream.io", topic: "sparkdream-alerts", token: "" } });
    expect(publicAlertSettings(db).ntfyTokenSet).toBe(false);
    expect(() => setAlertSettings(db, { ntfy: { server: "", topic: "t", token: "hunter2" } })).toThrow(/starts with tk_/);
  });
});
