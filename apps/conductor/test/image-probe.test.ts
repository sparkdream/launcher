import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { allSteps, buildServer } from "../src/index.js";
import { parseRegistryRef, registryImageProber, type ImageAvailability } from "../src/image-probe.js";
import { fakeServices } from "./fakes.js";

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };

/** A registry that answers by "METHOD url" (first match wins), recording what was asked. */
function registry(routes: Record<string, Reply | (() => Reply)>) {
  const asked: { key: string; auth?: string }[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    asked.push({ key, auth: init?.headers?.Authorization });
    const hit = routes[key];
    if (!hit) throw new Error(`fetch failed: ${key}`);
    const r = typeof hit === "function" ? hit() : hit;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { asked, probe: registryImageProber(fetchImpl) };
}

const HUB = "https://registry-1.docker.io/v2/sparkdreamnft/sparkdreamd-testnet-ssh/manifests";
const CHALLENGE = {
  status: 401,
  headers: {
    "www-authenticate":
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:sparkdreamnft/sparkdreamd-testnet-ssh:pull"',
  },
};
const TOKEN_URL =
  "GET https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Asparkdreamnft%2Fsparkdreamd-testnet-ssh%3Apull";

describe("parseRegistryRef", () => {
  it("reads a reference the way a container runtime does", () => {
    expect(parseRegistryRef("sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28")).toEqual({
      registry: "docker.io",
      host: "registry-1.docker.io",
      repository: "sparkdreamnft/sparkdreamd-testnet-ssh",
      reference: "v1.0.28",
    });
    expect(parseRegistryRef("nginx")).toMatchObject({ repository: "library/nginx", reference: "latest" });
    expect(parseRegistryRef("ghcr.io/mastodon/mastodon-streaming:v4.7.2")).toMatchObject({
      host: "ghcr.io",
      repository: "mastodon/mastodon-streaming",
      reference: "v4.7.2",
    });
    expect(parseRegistryRef(`registry.example:5000/a/b:v1@sha256:${"a".repeat(64)}`)).toMatchObject({
      host: "registry.example:5000",
      repository: "a/b",
      reference: `sha256:${"a".repeat(64)}`,
    });
  });
});

describe("registryImageProber", () => {
  it("finds a pushed tag, with the registry's anonymous token", async () => {
    let calls = 0;
    const r = registry({
      [`HEAD ${HUB}/v1.0.28`]: () =>
        calls++ === 0
          ? CHALLENGE
          : { status: 200, headers: { "content-type": "application/vnd.docker.distribution.manifest.v2+json" } },
      [TOKEN_URL]: { status: 200, body: { token: "t0k" } },
    });
    expect(await r.probe("sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28")).toEqual({ state: "available" });
    expect(r.asked.at(-1)).toEqual({ key: `HEAD ${HUB}/v1.0.28`, auth: "Bearer t0k" });
  });

  it("reports a tag the registry does not have", async () => {
    let calls = 0;
    const r = registry({
      [`HEAD ${HUB}/v9.9.9`]: () => (calls++ === 0 ? CHALLENGE : { status: 404 }),
      [TOKEN_URL]: { status: 200, body: { token: "t0k" } },
    });
    const found = (await r.probe("sparkdreamnft/sparkdreamd-testnet-ssh:v9.9.9")) as Extract<ImageAvailability, { state: "missing" }>;
    expect(found.state).toBe("missing");
    expect(found.why).toContain("docker.io has no sparkdreamnft/sparkdreamd-testnet-ssh:v9.9.9");
  });

  it("reports a repository that cannot be read without a login", async () => {
    const r = registry({
      [`HEAD ${HUB}/v1`]: CHALLENGE, // still 401 with the anonymous token
      [TOKEN_URL]: { status: 200, body: { token: "t0k" } },
    });
    const found = await r.probe("sparkdreamnft/sparkdreamd-testnet-ssh:v1");
    expect(found).toMatchObject({ state: "missing" });
    expect((found as { why: string }).why).toContain("without a login");
  });

  it("reports an image with no linux/amd64 build", async () => {
    const index = { status: 200, headers: { "content-type": "application/vnd.oci.image.index.v1+json" } };
    const manifests = (arch: string) => [
      { platform: { os: "linux", architecture: arch } },
      { platform: { os: "unknown", architecture: "unknown" } }, // attestation
    ];
    const arm = registry({
      "HEAD https://ghcr.io/v2/a/b/manifests/v1": index,
      "GET https://ghcr.io/v2/a/b/manifests/v1": { ...index, body: { manifests: manifests("arm64") } },
    });
    expect(await arm.probe("ghcr.io/a/b:v1")).toEqual({
      state: "missing",
      why: "it has no linux/amd64 build (only linux/arm64), which is what providers run",
    });
    const amd = registry({
      "HEAD https://ghcr.io/v2/a/b/manifests/v1": index,
      "GET https://ghcr.io/v2/a/b/manifests/v1": { ...index, body: { manifests: manifests("amd64") } },
    });
    expect(await amd.probe("ghcr.io/a/b:v1")).toEqual({ state: "available" });
  });

  it("does not judge when the registry cannot be asked", async () => {
    expect(await registry({}).probe("ghcr.io/a/b:v1")).toMatchObject({ state: "unknown" });
    for (const status of [429, 500, 503]) {
      const r = registry({ "HEAD https://ghcr.io/v2/a/b/manifests/v1": { status } });
      expect(await r.probe("ghcr.io/a/b:v1")).toMatchObject({ state: "unknown" });
    }
  });
});

describe("an upgrade to an image that cannot be pulled", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-image-probe-"));
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  function server(answer: ImageAvailability) {
    const db = new ConductorDb(path.join(work, `${answer.state}.db`));
    const probed: string[] = [];
    const services = fakeServices();
    services.images = async (image) => (probed.push(image), answer);
    const app = buildServer({ db, services, workRoot: work, steps: allSteps(), monitorIntervalMs: 0 });
    db.createLaunch("fl", JSON.stringify(testnetSpec()), "akash1owner");
    db.upsertFleetComponent({ launch_id: "fl", key: "sentry-0", dseq: "1", provider: "akash1prov", host_uri: "https://p.example:8443", price: "1", state: "active" });
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/fleet/fl/1/actions", payload });
    return { db, probed, post };
  }
  const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v9.9.9";

  it("starts no op and leaves the spec alone", async () => {
    const s = server({ state: "missing", why: "docker.io has no such tag" });
    const before = s.db.getLaunch("fl")!.spec_json;
    for (const payload of [
      { action: "upgrade", image, components: ["sentry-0"] },
      { action: "halt-upgrade", image, haltHeight: 100 },
    ]) {
      const res = await s.post(payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain(`providers could not pull "${image}": docker.io has no such tag`);
    }
    expect(s.probed).toEqual([image, image]);
    expect(s.db.listFleetOps("fl")).toEqual([]);
    expect(s.db.getLaunch("fl")!.spec_json).toBe(before);
  });

  it("goes ahead when the registry could not be asked", async () => {
    const s = server({ state: "unknown", why: "docker.io did not answer" });
    const res = await s.post({ action: "upgrade", image, components: ["sentry-0"] });
    expect(res.statusCode).toBe(200);
    expect(s.db.listFleetOps("fl")).toHaveLength(1);
  });
});
