import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkSpec, testnetSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { buildServer } from "../src/server.js";
import { joinSpecFromBundle } from "../src/join-prefill.js";
import { fakeServices, FakeSigner } from "./fakes.js";

/**
 * "Prefill spec from join bundle" (§5). Two paths: a stranger holding only
 * the published JSON, and the origin operator expanding their own chain off
 * their own fleet's spec. The second one is where the interesting rules
 * live — what must NOT carry over.
 */

const NODE_ID = "ab".repeat(20);
const PROVIDER_A = "akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w";
const PROVIDER_B = "akash1qyqszqgpqyqszqgpqyqszqgpqyqszqgplgve5x";

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    chainId: "sparkdream-1",
    bech32Prefix: "sprkdrm",
    token: {
      baseDenom: "uspark.sparkdream",
      displayDenom: "SPARK",
      exponent: 6,
      minGasPrice: "0.025",
      dreamDisplayDenom: "DREAM",
    },
    image: "sparkdreamnft/sparkdreamd:v1.0.33",
    genesisUrl: "https://rpc.sparkdream.io/genesis",
    genesisSha256: "b".repeat(64),
    peers: [`${NODE_ID}@provider.example.com:31234`],
    stateSyncRpcs: ["https://rpc.sparkdream.io", "http://provider2.example.com:31235"],
    ...overrides,
  };
}

/** An origin fleet spec carrying every field whose reuse is a hazard. */
function originSpec() {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    topology: {
      validators: {
        count: 2,
        operators: ["sprkdrm1aaa", "sprkdrm1bbb"],
        monikers: ["origin-one", "origin-two"],
        consensusPubkeys: [`${"A".repeat(43)}=`, `${"B".repeat(43)}=`],
      },
      sentries: { count: 2, mapping: [[0], [1]] },
      components: {
        explorer: { enabled: true, domain: "explorer.sparkdream.io" },
        frontend: { enabled: true, domain: "sparkdream.io" },
        hub: { enabled: false },
      },
      publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
      headscale: {
        domain: "headscale.sparkdream.io",
        backup: {
          s3: {
            endpoint: "https://s3.example.com",
            bucket: "sparkdream-headscale",
            accessKeyId: "AKIA",
            secretRef: "env:S3_SECRET",
          },
        },
      },
    },
    providers: { components: { validators: { exclude: ["deadprovider"] } } },
    chainParams: {
      staking: { unbondingTime: "1814400s" },
      slashing: { signedBlocksWindow: 100 },
      consensus: { timeoutCommit: "2s" },
      validatorDefaults: { commissionRate: 0.1 },
    },
    accounts: {
      initial: [{ name: "treasury", generate: true, amount: "500000000000000" }],
      validatorSelfDelegation: "400000000000",
      communityPool: "95000000000000",
    },
  });
}

describe("joinSpecFromBundle: bundle only", () => {
  it("fans the bundle into the four places its fields live, and validates", () => {
    const { spec, notes } = joinSpecFromBundle(bundle({ chainId: "sparkdream-test-1" }));
    const s = spec as any;

    expect(s.join).toEqual({
      chainId: "sparkdream-test-1",
      genesisUrl: "https://rpc.sparkdream.io/genesis",
      genesisSha256: "b".repeat(64),
      peers: [`${NODE_ID}@provider.example.com:31234`],
      stateSyncRpcs: ["https://rpc.sparkdream.io", "http://provider2.example.com:31235"],
    });
    expect(s.network).toMatchObject({ name: "sparkdream-test-join", bech32Prefix: "sprkdrm" });
    expect(s.network.chainIdSuffix).toBeUndefined();
    expect(s.token.baseDenom).toBe("uspark.sparkdream");
    expect(s.token.minGasPrice).toBe("0.025");
    expect(s.images.sparkdreamd).toBe("sparkdreamnft/sparkdreamd:v1.0.33");
    expect(s.topology.validators).toEqual({ count: 1, operators: "generated" });
    expect(s.accounts.initial).toEqual([]);

    // the draft is launch-shaped as it stands (placeholder mesh domain and all)
    const check = checkSpec(spec);
    expect(check.errors).toEqual([]);
    expect(notes.join("\n")).toMatch(/headscale\.example\.com/);
  });

  it("flags a bundle whose gas price is a fee, not a price per gas unit", () => {
    // bundles exported before the check could carry the old chain.env value
    const { spec } = joinSpecFromBundle(
      bundle({ token: { ...bundle().token, minGasPrice: "25000" } }),
    );
    const issue = checkSpec(spec).errors.find((e) => e.path === "token.minGasPrice");
    expect(issue?.message).toMatch(/price per gas unit, not a fee/);
  });

  it("carries the mainnet hardening rules when the chain id reads as mainnet", () => {
    const { spec, notes } = joinSpecFromBundle(bundle());
    // a mainnet guess means mainnet requirements the bundle cannot supply,
    // reported as issues on the draft rather than silently defaulted
    expect(checkSpec(spec).errors.map((e) => e.path)).toEqual(["topology.headscale.backup"]);
    expect(notes.some((n) => /mainnet/.test(n))).toBe(true);
  });

  it("guesses network.type from the chain id, and says so", () => {
    expect((joinSpecFromBundle(bundle({ chainId: "sparkdreamdev-3" })).spec as any).network).toMatchObject({
      type: "devnet",
      name: "sparkdreamdev-join",
    });
    expect((joinSpecFromBundle(bundle({ chainId: "sparkdream-test-1" })).spec as any).network.type).toBe(
      "testnet",
    );
    const { notes } = joinSpecFromBundle(bundle());
    expect(notes.some((n) => /guessed from the chain id/.test(n))).toBe(true);
  });

  it("refuses a bundle that cannot produce a joinable spec", () => {
    expect(() => joinSpecFromBundle({ peers: [], stateSyncRpcs: [] })).toThrow(/no chainId/);
    expect(() => joinSpecFromBundle(bundle({ peers: [] }))).toThrow(/nothing to dial/);
    expect(() => joinSpecFromBundle(bundle({ stateSyncRpcs: ["https://one.example.com"] }))).toThrow(
      /needs two RPC endpoints/,
    );
  });

  it("notes what a thin bundle leaves unpinned", () => {
    const { spec, notes } = joinSpecFromBundle(
      bundle({ genesisSha256: undefined, image: undefined, notice: "single sentry" }),
    );
    expect((spec as any).join.genesisSha256).toBeUndefined();
    expect(notes.some((n) => /trusted for integrity/.test(n))).toBe(true);
    expect(notes.some((n) => /apphash divergence/.test(n))).toBe(true);
    expect(notes.some((n) => /from the bundle: single sentry/.test(n))).toBe(true);
  });
});

describe("joinSpecFromBundle: expanding your own chain", () => {
  const base = originSpec();
  const result = joinSpecFromBundle(bundle(), {
    base,
    colocatedProviders: [PROVIDER_A, PROVIDER_B],
  });
  const s = result.spec as any;
  const notes = result.notes.join("\n");

  it("keeps the operator's own infrastructure choices", () => {
    expect(s.infra.resources).toEqual(base.infra.resources);
    expect(s.infra.akashNetwork).toBe(base.infra.akashNetwork);
    expect(s.providers.policy).toEqual(base.providers.policy);
    expect(s.security.keyMode).toBe("tmkms");
    expect(s.network.type).toBe("testnet");
    expect(s.accounts.validatorSelfDelegation).toBe("400000000000");
    expect(s.chainParams.consensus).toEqual({ timeoutCommit: "2s" });
    expect(s.chainParams.validatorDefaults).toMatchObject({ commissionRate: 0.1 });
  });

  it("drops what belongs to the live chain", () => {
    expect(s.accounts.initial).toEqual([]);
    expect(s.accounts.communityPool).toBeUndefined();
    expect(s.chainParams.staking).toBeUndefined();
    expect(s.chainParams.slashing).toBeUndefined();
    expect(notes).toMatch(/belong to the live chain/);
  });

  it("never reuses the origin's operator addresses or consensus keys", () => {
    expect(s.topology.validators.operators).toBe("generated");
    expect(s.topology.validators.consensusPubkeys).toBeUndefined();
    expect(s.topology.validators.monikers).toBeUndefined();
    expect(notes).toMatch(/can hold only one validator/);
    expect(notes).toMatch(/double-sign/);
  });

  it("never reuses the origin's ingress or its mesh", () => {
    expect(s.topology.publicEndpoints).toBeUndefined();
    expect(s.topology.components.explorer).toEqual({ enabled: false });
    expect(s.topology.components.frontend).toEqual({ enabled: false });
    expect(s.topology.headscale.domain).toBe("headscale-join.sparkdream.io");
    expect(s.topology.headscale.reuseFleet).toBeUndefined();
    expect(s.topology.headscale.backup).toBeUndefined();
    expect(notes).toMatch(/one bucket path/);
  });

  it("keeps the new pair off the providers already hosting the fleet", () => {
    expect(s.providers.components.validators.exclude).toEqual([
      "deadprovider",
      PROVIDER_A,
      PROVIDER_B,
    ]);
    expect(s.providers.components.sentries.exclude).toEqual([PROVIDER_A, PROVIDER_B]);
  });

  it("produces a pair, on the bundle's chain, that validates as a join spec", () => {
    expect(s.topology.validators.count).toBe(1);
    expect(s.topology.sentries).toEqual({ count: 1, mapping: "round-robin" });
    expect(s.join.chainId).toBe("sparkdream-1");
    expect(s.images.sparkdreamd).toBe("sparkdreamnft/sparkdreamd:v1.0.33");
    expect(s.network.name).toBe("sparkdream-join");
    const check = checkSpec(result.spec);
    expect(check.errors).toEqual([]);
  });
});

/**
 * The self-expansion path end to end: a launched fleet, its own live join
 * bundle, and the draft the fleet card's button writes into the editor.
 */
describe("GET /api/fleet/:launchId/join-spec", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("builds the draft off a running fleet, and keeps it away from that fleet's providers", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-joinspec-"));
    tmpDirs.push(work);
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    // two sentries: the trust-hash cross-check is only worth something
    // across distinct nodes, so that is what a bundle needs to export
    const spec = testnetSpec({
      network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
      topology: {
        validators: { count: 1 },
        sentries: { count: 2 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    db.createLaunch("fl", JSON.stringify(spec), "akash1owner");
    const result = await runWithSigner(
      db,
      "fl",
      spec,
      work,
      allSteps(),
      services,
      new FakeSigner(),
    );
    expect(result.status).toBe("completed");

    const app = buildServer({ db, services, workRoot: work, steps: allSteps() });
    const res = await app.inject({ method: "GET", url: "/api/fleet/fl/join-spec" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { spec: any; notes: string[]; issues: Array<{ path: string }> };

    // the live chain, off the fleet's own bundle
    expect(body.spec.join.chainId).toBe("sparkdream-1");
    expect(body.spec.join.peers.length).toBeGreaterThan(0);
    expect(body.spec.join.stateSyncRpcs.length).toBeGreaterThanOrEqual(2);
    expect(body.spec.join.genesisSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.spec.images.sparkdreamd).toBe(spec.images.sparkdreamd);
    expect(body.spec.network.name).toBe("sparkdream-join");
    expect(body.spec.topology.headscale.domain).toBe("headscale-join.sparkdream.io");

    // and off the providers already hosting it
    const hosting = [
      ...new Set(
        db
          .listFleetComponents("fl")
          .filter((c) => /^(val|sentry)-/.test(c.key))
          .map((c) => c.provider),
      ),
    ];
    expect(hosting.length).toBeGreaterThan(0);
    for (const provider of hosting) {
      expect(body.spec.providers.components.validators.exclude).toContain(provider);
      expect(body.spec.providers.components.sentries.exclude).toContain(provider);
    }

    // nothing in the draft is unlaunchable except the fake world's provider
    // "addresses", which are not bech32 (a real fleet's are)
    expect(body.issues.filter((i) => !i.path.startsWith("providers.components."))).toEqual([]);
    expect(body.notes.length).toBeGreaterThan(0);
    await app.close();
  }, 120_000);
});
