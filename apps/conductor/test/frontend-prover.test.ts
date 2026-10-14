import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { checkSpec, testnetSpecInput } from "@sparkdream/launch-spec";
import { renderComponentSdl } from "../src/render-component-sdl.js";

// the "files" of a chain release's prover manifest.json
const DIGESTS = {
  "shield.wasm": "71381b48d28ea0fb82d63d3dd6fd7e50e981c2829cd19cdadf5324802c67ae2f",
  "wasm_exec.js": "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14",
  "proving_key.raw.bin": "71177142e93ebd2fb420da365ef014ee271822cf4eae1a71c8dc784a34d4ea3c",
  "circuit.r1cs": "1e6f4cfe3aeaea043791986d8544a288bb1ce2712e2a9eee89c819da44565816",
};

function specInput(prover?: Record<string, unknown>): unknown {
  return testnetSpecInput({
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: true, domain: "app.sparkdream.io", ...(prover ? { prover } : {}) },
        hub: { enabled: false },
      },
      publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

function frontendEnv(input: unknown): string[] {
  const check = checkSpec(input);
  expect(check.errors).toEqual([]);
  const spec = check.spec!;
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "frontend-prover-")), "frontend.yaml");
  renderComponentSdl({
    spec,
    component: { key: "frontend", image: spec.images.frontend, domain: "app.sparkdream.io" },
    outPath,
  } as any);
  const sdl = yaml.load(fs.readFileSync(outPath, "utf8")) as any;
  return sdl.services.frontend.env as string[];
}

describe("frontend anonymous prover", () => {
  it("renders the pinned release, its digests and the asset base", () => {
    const env = frontendEnv(specInput({ assetsUrl: "https://zk.example/sparkdream", version: "v1.0.53", digests: DIGESTS }));
    expect(env).toContain("ZK_ASSETS_URL=https://zk.example/sparkdream");
    expect(env).toContain("ZK_VERSION=v1.0.53");
    // JSON inside an env entry survives the YAML round trip as the UI parses it
    const digests = env.find((e) => e.startsWith("ZK_DIGESTS="))!;
    expect(JSON.parse(digests.slice("ZK_DIGESTS=".length))).toEqual(DIGESTS);
  });

  it("renders nothing without a prover block, so the UI follows the node's version", () => {
    const env = frontendEnv(specInput());
    expect(env.some((e) => e.startsWith("ZK_"))).toBe(false);
  });

  it("refuses digests without the version they were built for", () => {
    const res = checkSpec(specInput({ digests: DIGESTS }));
    expect(res.errors.map((e) => e.path)).toContain("topology.components.frontend.prover.version");
  });

  it("refuses partial or malformed digests and unknown fields", () => {
    const partial = { ...DIGESTS } as Record<string, string>;
    delete partial["circuit.r1cs"];
    expect(checkSpec(specInput({ version: "v1.0.53", digests: partial })).ok).toBe(false);
    expect(
      checkSpec(specInput({ version: "v1.0.53", digests: { ...DIGESTS, "shield.wasm": "sha256:abc" } })).ok,
    ).toBe(false);
    expect(checkSpec(specInput({ version: "v1.0.53", digests: { ...DIGESTS, "extra.bin": DIGESTS["shield.wasm"] } })).ok).toBe(false);
    expect(checkSpec(specInput({ assetsUrl: "http://zk.example" })).ok).toBe(false);
    expect(checkSpec(specInput({ version: "../v1" })).ok).toBe(false);
  });
});
