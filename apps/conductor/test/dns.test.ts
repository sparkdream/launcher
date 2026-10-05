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
import { CloudflareDns, onlyHost, type DnsUpdater } from "../src/dns.js";
import { fakeServices, FakeSigner } from "./fakes.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A Cloudflare API holding one zone and its records. */
function fakeCloudflare(
  zone: string,
  records: { id: string; type: string; name: string; content: string; proxied: boolean }[],
  opts: { failCnamePost?: boolean; badToken?: boolean; noDnsRead?: boolean; noZones?: boolean } = {},
) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (opts.failCnamePost && method === "POST" && JSON.parse(String(init!.body)).type === "CNAME") {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "rate limited" }] }), { status: 429 });
    }
    if (opts.badToken) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "Invalid API Token" }] }), { status: 403 });
    }
    if (u.pathname.endsWith("/zones")) {
      const name = u.searchParams.get("name");
      if (opts.noZones) return ok([]);
      return ok(name === null || name === zone ? [{ id: "z1", name: zone }] : []);
    }
    if (opts.noDnsRead && u.pathname.endsWith("/dns_records")) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 });
    }
    if (u.pathname.endsWith("/dns_records") && method === "GET") {
      return ok(records.filter((r) => r.name === u.searchParams.get("name")));
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const id = u.pathname.split("/").pop()!;
    if (method === "DELETE") records.splice(records.findIndex((r) => r.id === id), 1);
    if (method === "PUT") Object.assign(records.find((r) => r.id === id)!, body);
    if (method === "POST") records.push({ id: `r${records.length + 10}`, ...body });
    return ok({});
  }) as typeof fetch;
  return { fetchImpl, calls, records };
}

describe("Cloudflare DNS updates", () => {
  it("finds the zone by suffix and repoints an existing CNAME, keeping its proxy setting", async () => {
    const cf = fakeCloudflare("sparkdream.io", [
      { id: "r1", type: "CNAME", name: "rpc.sparkdream.io", content: "old.ingress", proxied: false },
    ]);
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    expect(await dns.pointCname("rpc.sparkdream.io", "new.ingress")).toBe(true);
    expect(cf.records).toEqual([{ id: "r1", type: "CNAME", name: "rpc.sparkdream.io", content: "new.ingress", proxied: false, ttl: 1 }]);
    // already right: no write
    const writes = cf.calls.length;
    expect(await dns.pointCname("rpc.sparkdream.io", "new.ingress")).toBe(true);
    expect(cf.calls.slice(writes).some((c) => !c.startsWith("GET"))).toBe(false);
  });

  it("replaces an A record with a CNAME, keeping its proxy setting", async () => {
    const cf = fakeCloudflare("sparkdream.io", [{ id: "r1", type: "A", name: "api.sparkdream.io", content: "1.2.3.4", proxied: true }]);
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    expect(await dns.pointCname("api.sparkdream.io", "ing.example")).toBe(true);
    expect(cf.records.map((r) => [r.type, r.content, r.proxied])).toEqual([["CNAME", "ing.example", true]]);
  });

  it("creates a new name proxied, as every fleet domain is (SSL Flexible)", async () => {
    const cf = fakeCloudflare("sparkdream.io", []);
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    expect(await dns.pointCname("ntfy.sparkdream.io", "ing.example")).toBe(true);
    expect(cf.records.map((r) => [r.type, r.content, r.proxied])).toEqual([["CNAME", "ing.example", true]]);
  });

  it("leaves a name that holds other records (mail, verification) to the operator", async () => {
    const records = [
      { id: "r1", type: "A", name: "api.sparkdream.io", content: "1.2.3.4", proxied: false },
      { id: "r2", type: "TXT", name: "api.sparkdream.io", content: "site-verification=abc", proxied: false },
    ];
    const cf = fakeCloudflare("sparkdream.io", records.map((r) => ({ ...r })));
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    expect(await dns.pointCname("api.sparkdream.io", "ing.example")).toBe(false);
    expect(cf.records).toEqual(records);
  });

  it("puts the old records back when the new CNAME cannot be written", async () => {
    const cf = fakeCloudflare("sparkdream.io", [{ id: "r1", type: "A", name: "api.sparkdream.io", content: "1.2.3.4", proxied: false }], {
      failCnamePost: true,
    });
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    await expect(dns.pointCname("api.sparkdream.io", "ing.example")).rejects.toThrow(/rate limited/);
    expect(cf.records.map((r) => [r.type, r.name, r.content])).toEqual([["A", "api.sparkdream.io", "1.2.3.4"]]);
  });

  it("checks a token by what DNS updates do: zones it sees, then their records (account-owned tokens too)", async () => {
    const good = await new CloudflareDns(() => null, fakeCloudflare("sparkdream.io", []).fetchImpl).check("tok");
    expect(good).toMatchObject({ ok: true, zones: ["sparkdream.io"] });
    const bad = await new CloudflareDns(() => null, fakeCloudflare("sparkdream.io", [], { badToken: true }).fetchImpl).check("tok");
    expect(bad).toMatchObject({ ok: false, reason: expect.stringContaining("Invalid API Token") });
    const noZone = await new CloudflareDns(() => null, fakeCloudflare("sparkdream.io", [], { noZones: true }).fetchImpl).check("tok");
    expect(noZone).toMatchObject({ ok: false, reason: expect.stringContaining("sees no zone") });
    const noDns = await new CloudflareDns(() => null, fakeCloudflare("sparkdream.io", [], { noDnsRead: true }).fetchImpl).check("tok");
    expect(noDns).toMatchObject({ ok: false, reason: expect.stringContaining("cannot read its DNS records") });
  });

  it("does nothing without a token, or for a domain in no zone it can see", async () => {
    const cf = fakeCloudflare("sparkdream.io", []);
    expect(await new CloudflareDns(() => null, cf.fetchImpl).pointCname("a.sparkdream.io", "x")).toBe(false);
    expect(await new CloudflareDns(() => "tok", cf.fetchImpl).pointCname("a.other.org", "x")).toBe(false);
    expect(cf.records).toEqual([]);
  });
});

/** Cloudflare's origin-rules entrypoint for one zone, over the DNS fake's records. */
function fakeOriginRules(initial: { id: string; expression: string; action: string; action_parameters?: any; description?: string }[] | null) {
  let ruleset = initial ? { id: "rs1", rules: initial.map((r) => ({ ...r })) } : null;
  const dns = fakeCloudflare("sparkdream.io", []);
  const writes: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (u.pathname.endsWith("/rulesets/phases/http_request_origin/entrypoint")) {
      if (method === "GET") {
        return ruleset ? ok(ruleset) : new Response(JSON.stringify({ success: false, errors: [{ message: "could not find entrypoint ruleset" }] }), { status: 404 });
      }
      writes.push("PUT entrypoint");
      ruleset = { id: "rs1", rules: JSON.parse(String(init!.body)).rules.map((r: any, i: number) => ({ id: `n${i}`, ...r })) };
      return ok(ruleset);
    }
    const rule = /\/rulesets\/rs1\/rules(?:\/(\w+))?$/.exec(u.pathname);
    if (rule) {
      const body = JSON.parse(String(init!.body));
      writes.push(`${method} ${rule[1] ?? "rule"}`);
      if (method === "POST") ruleset!.rules.push({ id: `n${ruleset!.rules.length}`, ...body });
      else Object.assign(ruleset!.rules.find((r) => r.id === rule[1])!, body);
      return ok(ruleset);
    }
    return dns.fetchImpl(url, init);
  }) as typeof fetch;
  return { fetchImpl, writes, rules: () => ruleset?.rules ?? [], records: dns.records };
}

describe("Cloudflare origin rules (the sentry's forwarded API/RPC ports)", () => {
  it("reads one-host expressions only", () => {
    expect(onlyHost('(http.host eq "api.sparkdream.io")')).toBe("api.sparkdream.io");
    expect(onlyHost('http.host == "API.sparkdream.io"')).toBe("api.sparkdream.io");
    expect(onlyHost('(http.host in {"rpc.sparkdream.io"})')).toBe("rpc.sparkdream.io");
    expect(onlyHost('(http.host in {"api.a" "rpc.a"})')).toBeUndefined();
    expect(onlyHost('(http.host eq "api.a" and starts_with(http.request.uri.path, "/x"))')).toBeUndefined();
  });

  it("moves the port of the operator's existing rule in place, and leaves a right one alone", async () => {
    const cf = fakeOriginRules([
      { id: "u1", expression: '(http.host eq "api.sparkdream.io")', action: "route", action_parameters: { origin: { port: 31111 } }, description: "testnet api" },
      { id: "u2", expression: '(http.host eq "api-dev.sparkdream.io")', action: "route", action_parameters: { origin: { port: 32222 } } },
    ]);
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    expect(await dns.pointOrigin("api.sparkdream.io", "provider.example", 30555)).toBe(true);
    expect(cf.rules().find((r) => r.id === "u1")).toMatchObject({ description: "testnet api", action_parameters: { origin: { port: 30555 } } });
    expect(cf.rules().find((r) => r.id === "u2")!.action_parameters.origin.port).toBe(32222);
    expect(cf.writes).toEqual(["PATCH u1"]);
    expect(cf.records.map((r) => [r.name, r.content])).toEqual([["api.sparkdream.io", "provider.example"]]);
    await dns.pointOrigin("api.sparkdream.io", "provider.example", 30555);
    expect(cf.writes).toEqual(["PATCH u1"]);
  });

  it("adds a rule of its own, creating the zone's origin ruleset when there is none", async () => {
    const none = fakeOriginRules(null);
    expect(await new CloudflareDns(() => "tok", none.fetchImpl).pointOrigin("rpc.sparkdream.io", "p.example", 30001)).toBe(true);
    expect(none.writes).toEqual(["PUT entrypoint"]);
    expect(none.rules()[0]).toMatchObject({ expression: '(http.host eq "rpc.sparkdream.io")', action: "route", action_parameters: { origin: { port: 30001 } } });

    const other = fakeOriginRules([{ id: "u1", expression: '(http.host eq "api.sparkdream.io")', action: "route", action_parameters: { origin: { port: 1 } } }]);
    expect(await new CloudflareDns(() => "tok", other.fetchImpl).pointOrigin("rpc.sparkdream.io", "p.example", 30001)).toBe(true);
    expect(other.writes).toEqual(["POST rule"]);
    expect(other.rules()).toHaveLength(2);
  });

  it("leaves a wider rule of the operator's that covers the host alone", async () => {
    const cf = fakeOriginRules([
      { id: "u1", expression: '(http.host in {"api.sparkdream.io" "rpc.sparkdream.io"})', action: "route", action_parameters: { origin: { port: 1 } } },
    ]);
    expect(await new CloudflareDns(() => "tok", cf.fetchImpl).pointOrigin("api.sparkdream.io", "p.example", 30001)).toBe(false);
    expect(cf.writes).toEqual([]);
  });
});

describe("a move with the DNS token set", () => {
  function spec(): LaunchSpec {
    return testnetSpec({
      network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
      security: { keyMode: "tmkms" },
      providers: { policy: { antiAffinity: "strict" } },
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
  }

  it("a launch places headscale again when its first provider's ingress serves nothing", async () => {
    const launchOnce = async (brokenHost?: string) => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dns-"));
      tmpDirs.push(work);
      const db = new ConductorDb(path.join(work, "state.db"));
      const services = fakeServices();
      const signer = new FakeSigner();
      services.dns = {
        async pointCname(name, target) {
          if (![...services.rpc.darkUrls].some((d) => target.includes(d))) services.rpc.darkUrls.delete(`${name}/health`);
          return true;
        },
      } satisfies DnsUpdater;
      if (brokenHost) {
        services.rpc.darkUrls.add("headscale.sparkdream.io/health");
        services.rpc.darkUrls.add(`fake.ingress.${brokenHost}`);
      }
      db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
      const res = await runWithSigner(db, "fl", spec(), work, allSteps(), services, signer);
      const hs = db.stepOutput<{ provider: string; hostUri: string }>("fl", "deploy-headscale")!;
      const avoid = db.providerPrefs("akash1owner").avoid;
      db.close();
      return { res, hs, avoid };
    };
    const usual = await launchOnce();
    expect(usual.res.status).toBe("completed");
    const moved = await launchOnce(new URL(usual.hs.hostUri).hostname);
    expect(moved.res.reason ?? "").toBe("");
    expect(moved.res.status).toBe("completed");
    expect(moved.hs.provider).not.toBe(usual.hs.provider);
    expect(moved.avoid).toContain(usual.hs.provider);
  }, 300_000);

  it("a fresh launch sets its own records instead of pausing at verify-chain", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dns-"));
    tmpDirs.push(work);
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const ports: Record<string, number> = {};
    services.dns = {
      async pointCname(name) {
        services.rpc.darkUrls.delete(name);
        return true;
      },
      async pointOrigin(name, target, port) {
        ports[name] = port;
        return this.pointCname(name, target);
      },
    } satisfies DnsUpdater;
    // nothing answers until the launcher has set it
    services.rpc.darkUrls.add("api.sparkdream.io");
    services.rpc.darkUrls.add("rpc.sparkdream.io");
    db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
    const res = await runWithSigner(db, "fl", spec(), work, allSteps(), services, new FakeSigner());
    expect(res.status).toBe("completed");
    expect(Object.keys(ports).sort()).toEqual(["api.sparkdream.io", "rpc.sparkdream.io"]);
  }, 240_000);

  it("a relaunched sentry-0 whose provider does not forward its ports moves again, and avoids it", async () => {
    const world = async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dns-"));
      tmpDirs.push(work);
      const db = new ConductorDb(path.join(work, "state.db"));
      const services = fakeServices();
      const signer = new FakeSigner();
      db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
      expect((await runWithSigner(db, "fl", spec(), work, allSteps(), services, signer)).status).toBe("completed");
      const fleet = new FleetService(db, services, work);
      fleet.materialize("fl");
      // DNS that works when pointed at a host that forwards: a broken one stays dark
      services.dns = {
        async pointCname(name, target) {
          if (![...services.rpc.darkUrls].some((d) => d.startsWith("http://") && d.includes(target))) services.rpc.darkUrls.delete(name);
          return true;
        },
        async pointOrigin(name, target) {
          return this.pointCname(name, target);
        },
      } satisfies DnsUpdater;
      const before = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
      await fleet.requestRelaunch(db.getLaunch("fl")!, before);
      services.api.leaseStates.set(before.dseq, "closed");
      services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
      services.rpc.darkUrls.add("api.sparkdream.io");
      services.rpc.darkUrls.add("rpc.sparkdream.io");
      const drive = () => {
        const st = withDefaults(JSON.parse(db.getLaunch("fl")!.spec_json));
        return runWithSigner(db, "fl", st, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")], services, signer);
      };
      return { db, services, fleet, drive };
    };
    const first = await world();
    expect((await first.drive()).status).toBe("completed");
    const usual = first.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const usualHost = new URL(usual.host_uri).hostname;

    const w = await world();
    // that provider answers SSH and lease status, but forwards no public port
    w.services.rpc.darkUrls.add(`http://${usualHost}`);
    const res = await w.drive();
    expect(res.reason ?? "").toBe("");
    expect(res.status).toBe("completed");
    const moved = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(moved.provider).not.toBe(usual.provider);
    expect(w.fleet.providerPrefs("akash1owner").avoid).toContain(usual.provider);
    expect(JSON.parse(w.db.listFleetOps("fl").find((o) => o.kind === "relaunch")!.params_json).ingressReplacements).toBe(1);
  }, 300_000);

  it("repair points dark domains at where their components run, and leaves answering ones alone", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dns-"));
    tmpDirs.push(work);
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
    expect((await runWithSigner(db, "fl", spec(), work, allSteps(), services, signer)).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    const pointed: string[] = [];
    services.dns = {
      async pointCname(name) {
        pointed.push(name);
        services.rpc.darkUrls.delete(name);
        return true;
      },
      async pointOrigin(name, target) {
        return this.pointCname(name, target);
      },
    } satisfies DnsUpdater;
    // the RPC record was edited by hand; the API still answers
    services.rpc.darkUrls.add("rpc.sparkdream.io");
    fleet.requestRepair(db.getLaunch("fl")!, db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!);
    const st = withDefaults(JSON.parse(db.getLaunch("fl")!.spec_json));
    const res = await runWithSigner(db, "fl", st, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")], services, signer);
    expect(res.status).toBe("completed");
    expect(pointed).toEqual(["rpc.sparkdream.io"]);
  }, 240_000);

  it("relaunching sentry-0 repoints its public domains itself instead of pausing", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dns-"));
    tmpDirs.push(work);
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    db.createLaunch("fl", JSON.stringify(spec()), "akash1owner");
    expect((await runWithSigner(db, "fl", spec(), work, allSteps(), services, signer)).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");

    const pointed: string[] = [];
    // DNS that works: once a domain is pointed, it answers
    const ports: Record<string, number> = {};
    services.dns = {
      async pointCname(name) {
        pointed.push(name);
        services.rpc.darkUrls.delete(name);
        return true;
      },
      // the sentry's API and RPC are forwarded ports: CNAME plus Origin Rule
      async pointOrigin(name, target, port) {
        ports[name] = port;
        return this.pointCname(name, target);
      },
    } satisfies DnsUpdater;
    const before = db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const opId = await fleet.requestRelaunch(db.getLaunch("fl")!, before);
    services.api.leaseStates.set(before.dseq, "closed");
    services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    services.rpc.darkUrls.add("api.sparkdream.io");
    services.rpc.darkUrls.add("rpc.sparkdream.io");

    const s = withDefaults(JSON.parse(db.getLaunch("fl")!.spec_json));
    const res = await runWithSigner(db, "fl", s, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")], services, signer);
    expect(res.status).toBe("completed");
    expect(db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(pointed.sort()).toEqual(["api.sparkdream.io", "rpc.sparkdream.io"]);
    // each to its forwarded port on the new lease, not port 80
    expect(ports["api.sparkdream.io"]).toBeGreaterThan(1000);
    expect(ports["rpc.sparkdream.io"]).toBeGreaterThan(1000);
  }, 240_000);
});
