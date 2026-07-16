import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { joinSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runLaunch } from "../src/engine.js";
import { phaseASteps } from "../src/steps/phase-a.js";
import { canonicalGenesisSha256, unwrapGenesis } from "../src/steps/join.js";
import { fakeServices } from "./fakes.js";

/**
 * Join mode (§5 "Join mode"): Phase A against the real binary — genesis is
 * FETCHED and verified instead of built, sentries render with [statesync]
 * and the network's public peers, validators stay mesh-only.
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-join-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const JOIN_PEER = `${"ab".repeat(20)}@p2p.origin.example:31234`;
const TRUST_HASH = "F".repeat(64);

/**
 * A minimal stand-in for the origin chain's genesis — the join path only
 * reads chain_id and the staking bond denom; no gentx machinery runs, so
 * the document doesn't need to InitChain.
 */
const ORIGIN_GENESIS = JSON.stringify(
  {
    chain_id: "sparkdream-1",
    genesis_time: "2026-01-01T00:00:00Z",
    app_state: {
      staking: { params: { bond_denom: "uspark.sparkdreamtest" } },
      bank: { balances: [] },
    },
  },
  null,
  2,
);

function joinerSpec(overrides: Record<string, unknown> = {}): LaunchSpec {
  return joinSpec({
    network: { name: "joiner", type: "testnet", bech32Prefix: "sprkdrm" },
    token: { baseDenom: "uspark.sparkdreamtest", displayDenom: "SPARK" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: { domain: "headscale.joiner.example" },
    },
    ...overrides,
  });
}

async function run(s: LaunchSpec, id: string, services = fakeServices()) {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  db.createLaunch(id, JSON.stringify(s));
  const result = await runLaunch(db, id, s, work, phaseASteps(), services);
  return { work, db, result, dirs: launchDirs(work, id) };
}

function joinServices(genesisBody: string) {
  const services = fakeServices();
  services.rpc.texts.set("origin.example/genesis", genesisBody);
  // resolveStateSyncTrust: FakeRpc.status yields height 5 → trust height 1,
  // hash cross-checked across both RPCs
  const block = JSON.stringify({ result: { block_id: { hash: TRUST_HASH } } });
  services.rpc.texts.set("rpc-a.example/block?height=1", block);
  services.rpc.texts.set("rpc-b.example/block?height=1", block);
  return services;
}

function joinBlock(genesisBody: string, sha?: string) {
  return {
    chainId: JSON.parse(genesisBody).chain_id as string,
    genesisUrl: "https://origin.example/genesis",
    genesisSha256: sha ?? canonicalGenesisSha256(JSON.parse(genesisBody)),
    peers: [JOIN_PEER],
    stateSyncRpcs: ["https://rpc-a.example", "https://rpc-b.example"],
  };
}

describe("canonical genesis hashing", () => {
  it("is serialization-order independent", () => {
    const a = { chain_id: "x-1", app_state: { bank: { balances: [] }, staking: {} } };
    const b = { app_state: { staking: {}, bank: { balances: [] } }, chain_id: "x-1" };
    expect(canonicalGenesisSha256(a)).toBe(canonicalGenesisSha256(b));
    expect(canonicalGenesisSha256({ ...a, chain_id: "x-2" })).not.toBe(canonicalGenesisSha256(a));
  });

  it("hashes the SDK file format and CometBFT's RPC re-serialization identically", () => {
    // observed live: `init` writes the SDK shape to disk, but the RPC's
    // /genesis re-serializes the same document as a CometBFT GenesisDoc —
    // a file-derived pin must still verify the RPC-served copy
    const params = { block: { max_bytes: "22020096" }, validator: { pub_key_types: ["ed25519"] } };
    const sdkFile = {
      app_name: "sparkdreamd",
      app_version: "1.0.26",
      app_hash: null,
      chain_id: "x-1",
      initial_height: 1,
      consensus: { params },
      app_state: { bank: { balances: [] } },
    };
    const rpcDoc = {
      chain_id: "x-1",
      initial_height: "1",
      app_hash: "",
      consensus_params: params,
      app_state: { bank: { balances: [] } },
    };
    expect(canonicalGenesisSha256(sdkFile)).toBe(canonicalGenesisSha256(rpcDoc));
    expect(
      canonicalGenesisSha256({ ...rpcDoc, consensus_params: { ...params, evidence: {} } }),
    ).not.toBe(canonicalGenesisSha256(rpcDoc));
  });

  it("unwraps raw, JSONRPC-wrapped, and bare-wrapped genesis documents", () => {
    const genesis = { chain_id: "x-1", app_state: {} };
    expect(unwrapGenesis(JSON.stringify(genesis))).toEqual({ genesis, wasRaw: true });
    expect(unwrapGenesis(JSON.stringify({ result: { genesis } }))).toEqual({ genesis, wasRaw: false });
    expect(unwrapGenesis(JSON.stringify({ genesis }))).toEqual({ genesis, wasRaw: false });
    expect(() => unwrapGenesis("not json")).toThrow(/not JSON/);
    expect(() => unwrapGenesis(JSON.stringify({ error: { code: -32603 } }))).toThrow(/host the raw genesis/);
    expect(() => unwrapGenesis(JSON.stringify({ hello: 1 }))).toThrow(/chain_id/);
  });
});

describe("join-mode Phase A golden run — 1 validator × 1 sentry", () => {
  it("fetches + verifies genesis and wires statesync + public peers", async () => {
    const genesisBody = ORIGIN_GENESIS;
    const s = joinerSpec({ join: joinBlock(genesisBody) });
    const { db, result, dirs } = await run(s, "join-launch", joinServices(genesisBody));
    expect(result.status).toBe("completed");

    // build-genesis output has the join shape: fetched chain id, 0 gentxs
    const out = db.stepOutput<{ chainId: string; gentxCount: number; genesisSha256: string }>(
      "join-launch",
      "build-genesis",
    )!;
    expect(out.chainId).toBe(JSON.parse(genesisBody).chain_id);
    expect(out.gentxCount).toBe(0);
    expect(out.genesisSha256).toBe(canonicalGenesisSha256(JSON.parse(genesisBody)));

    // the origin's genesis lands byte-identical in every node home
    for (const key of ["val-0", "sentry-0"]) {
      expect(fs.readFileSync(path.join(dirs.node(key), "config", "genesis.json"), "utf8")).toBe(
        genesisBody,
      );
    }

    // sentry: statesync on, trust anchor resolved, network peers appended
    const sentryConfig = fs.readFileSync(
      path.join(dirs.node("sentry-0"), "config", "config.toml"),
      "utf8",
    );
    expect(sentryConfig).toContain("enable = true");
    expect(sentryConfig).toContain('rpc_servers = "https://rpc-a.example,https://rpc-b.example"');
    expect(sentryConfig).toContain("trust_height = 1");
    expect(sentryConfig).toContain(`trust_hash = "${TRUST_HASH}"`);
    expect(sentryConfig).toContain(JOIN_PEER);
    // still fronts its own validator over the local tunnel
    expect(sentryConfig).toContain("@127.0.0.1:16656");

    // validator: mesh-only (no public peers), but it MUST state-sync too —
    // its only peers are state-synced sentries that cannot serve old blocks
    const valConfig = fs.readFileSync(
      path.join(dirs.node("val-0"), "config", "config.toml"),
      "utf8",
    );
    expect(valConfig).not.toContain(JOIN_PEER);
    expect(valConfig).toContain("enable = true");
    expect(valConfig).toContain(`trust_hash = "${TRUST_HASH}"`);
  }, 120_000);

  it("refuses a genesis that does not match the pinned sha256", async () => {
    const genesisBody = ORIGIN_GENESIS;
    const s = joinerSpec({ join: joinBlock(genesisBody, "0".repeat(64)) });
    const { db, result } = await run(s, "join-bad-pin", joinServices(genesisBody));
    expect(result.status).toBe("paused");
    expect(result.failedStep).toBe("build-genesis");
    expect(db.getStep("join-bad-pin", "build-genesis")?.error).toMatch(/integrity/);
  }, 120_000);

  it("refuses a genesis whose chain_id differs from the join block", async () => {
    const genesisBody = ORIGIN_GENESIS;
    const block = { ...joinBlock(genesisBody), chainId: "somewhere-else-9" };
    // re-pin: the sha is right, the chain id is the lie being caught
    const s = joinerSpec({ join: block });
    const { db, result } = await run(s, "join-wrong-chain", joinServices(genesisBody));
    expect(result.status).toBe("paused");
    expect(db.getStep("join-wrong-chain", "build-genesis")?.error).toMatch(/chain_id/);
  }, 120_000);
});
