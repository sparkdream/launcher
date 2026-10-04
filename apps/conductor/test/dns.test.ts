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
import { CloudflareDns, type DnsUpdater } from "../src/dns.js";
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

  it("creates a new name DNS only (headscale's DERP and STUN do not pass the proxy)", async () => {
    const cf = fakeCloudflare("sparkdream.io", []);
    const dns = new CloudflareDns(() => "tok", cf.fetchImpl);
    expect(await dns.pointCname("headscale.sparkdream.io", "ing.example")).toBe(true);
    expect(cf.records.map((r) => [r.type, r.content, r.proxied])).toEqual([["CNAME", "ing.example", false]]);
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
    expect(good).toEqual({ ok: true, zones: ["sparkdream.io"] });
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
    services.dns = {
      async pointCname(name) {
        pointed.push(name);
        services.rpc.darkUrls.delete(name);
        return true;
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
  }, 240_000);
});
