import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runLaunch } from "../src/engine.js";
import { phaseASteps } from "../src/steps/phase-a.js";
import { fakeServices } from "./fakes.js";

/**
 * Golden tests (design §11 M1): full Phase A against the real sparkdreamd
 * binary and the vendored templates. The binary's bech32 prefix is baked in
 * (sprkdrm), so the fixture overrides the design sample's "spark".
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-phase-a-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(validators: number, sentries: number, extra: Record<string, unknown> = {}): LaunchSpec {
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
    ...extra,
  });
}

async function runPhaseA(s: LaunchSpec, id: string) {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  db.createLaunch(id, JSON.stringify(s));
  const result = await runLaunch(db, id, s, work, phaseASteps(), fakeServices());
  return { work, db, result, dirs: launchDirs(work, id) };
}

describe("Phase A golden run — 2 validators × 2 sentries", () => {
  it("completes with a valid genesis and correctly wired configs", async () => {
    const s = spec(2, 2);
    const { db, result, dirs } = await runPhaseA(s, "g22");
    if (result.status !== "completed") {
      throw new Error(`paused at ${result.failedStep}: ${db.getStep("g22", result.failedStep!)?.error}`);
    }

    // genesis: validate ran inside build-genesis; both gentxs collected
    const genesisOut = db.stepOutput<{ chainId: string; gentxCount: number }>("g22", "build-genesis")!;
    expect(genesisOut.chainId).toBe("sparkdream-1");
    expect(genesisOut.gentxCount).toBe(2);

    const genesis = JSON.parse(
      fs.readFileSync(path.join(dirs.node("val-0"), "config", "genesis.json"), "utf8"),
    );
    expect(genesis.chain_id).toBe("sparkdream-1");
    expect(genesis.app_state.staking.params.bond_denom).toBe("uspark.sparkdreamtest");
    expect(genesis.app_state.staking.params.unbonding_time).toBe("1814400s");
    expect(genesis.app_state.slashing.params.slash_fraction_double_sign).toBe(
      "0.050000000000000000",
    );
    expect(genesis.app_state.genutil.gen_txs).toHaveLength(2);

    // every node got the same final genesis
    const master = fs.readFileSync(path.join(dirs.node("val-0"), "config", "genesis.json"));
    for (const key of ["val-1", "sentry-0", "sentry-1"]) {
      expect(fs.readFileSync(path.join(dirs.node(key), "config", "genesis.json")).equals(master)).toBe(true);
    }

    // peer wiring (§5 step 4): round-robin 2×2 → sentry s fronts val s
    const keys = db.stepOutput<{ nodeIds: Record<string, string> }>("g22", "generate-keys")!;
    const val0 = fs.readFileSync(path.join(dirs.node("val-0"), "config", "config.toml"), "utf8");
    expect(val0).toContain(
      `persistent_peers = "${keys.nodeIds["sentry-0"]}@{{TAILNET_IP:sentry-0}}:26656"`,
    );
    expect(val0).toContain('moniker = "sparkdream-val-0"');
    expect(val0).toContain('timeout_commit = "3s"');
    // softsign: file-based privval — the template's tmkms socket is cleared
    // (a socket laddr makes the node block waiting for a signer)
    expect(val0).toContain('priv_validator_laddr = ""');
    expect(val0).toContain("allow_duplicate_ip = true");

    const sentry1 = fs.readFileSync(path.join(dirs.node("sentry-1"), "config", "config.toml"), "utf8");
    expect(sentry1).toContain(
      `persistent_peers = "${keys.nodeIds["val-1"]}@127.0.0.1:16657"`,
    );
    expect(sentry1).toContain(`private_peer_ids = "${keys.nodeIds["val-1"]}"`);

    const app = fs.readFileSync(path.join(dirs.node("sentry-0"), "config", "app.toml"), "utf8");
    expect(app).toContain('minimum-gas-prices = "25000uspark.sparkdreamtest"');
    expect(app).toContain("snapshot-interval = 1000");

    // SDLs: image, placeholders, tunnels, persistent storage, pricing denom
    const sentrySdl = fs.readFileSync(path.join(dirs.sdl, "sentry-1.yaml"), "utf8");
    expect(sentrySdl).toContain("TS_TUNNEL_1=16657:{{TAILNET_IP:val-1}}:26656");
    expect(sentrySdl).toContain("TS_AUTHKEY={{TS_AUTHKEY:sentry-1}}");
    expect(sentrySdl).toContain("WAIT_FOR_CONFIG=true");
    expect(sentrySdl).toContain("denom: uact");
    expect(sentrySdl).toContain("persistent: true");
    expect(sentrySdl).toContain("class: beta3");

    const valSdl = fs.readFileSync(path.join(dirs.sdl, "val-0.yaml"), "utf8");
    expect(valSdl).toContain(`image: ${s.images.sparkdreamd}`);
    expect(valSdl).toContain("size: 50Gi");
    expect(valSdl).not.toContain("TS_TUNNEL_");

    // bundles: softsign validators keep their consensus key, no keyring leaks
    const listing = execFileSync("tar", ["tzf", path.join(dirs.bundles, "val-0.tgz")]).toString();
    expect(listing).toContain("config/priv_validator_key.json");
    expect(listing).toContain("config/genesis.json");
    expect(listing).not.toContain("keyring-test");
    expect(listing).not.toContain("config/gentx");
    db.close();
  }, 120_000);
});

describe("Phase A golden run — 1 validator × 1 sentry, tmkms", () => {
  it("completes and never packages the consensus key", async () => {
    const s = spec(1, 1, { security: { keyMode: "tmkms" } });
    const { db, result, dirs } = await runPhaseA(s, "g11");
    if (result.status !== "completed") {
      throw new Error(`paused at ${result.failedStep}: ${db.getStep("g11", result.failedStep!)?.error}`);
    }

    expect(db.stepOutput<{ gentxCount: number }>("g11", "build-genesis")!.gentxCount).toBe(1);

    const listing = execFileSync("tar", ["tzf", path.join(dirs.bundles, "val-0.tgz")]).toString();
    expect(listing).not.toContain("priv_validator_key.json");
    expect(listing).toContain("config/node_key.json");

    // sentry bundle unaffected
    const sentryListing = execFileSync("tar", ["tzf", path.join(dirs.bundles, "sentry-0.tgz")]).toString();
    expect(sentryListing).toContain("config/config.toml");
    db.close();
  }, 120_000);
});

describe("Phase A golden run — explorer + frontend enabled", () => {
  it("renders component SDLs and flips the sentry LCD on", async () => {
    const s = spec(1, 2, {
      network: {
        name: "sparkdream",
        type: "testnet",
        bech32Prefix: "sprkdrm",
        displayName: "Spark Dream",
      },
      topology: {
        validators: { count: 1 },
        sentries: { count: 2 },
        components: {
          explorer: { enabled: true, domain: "explorer.sparkdream.io" },
          frontend: { enabled: true, domain: "app.sparkdream.io" },
          hub: { enabled: false },
        },
        publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const { db, result, dirs } = await runPhaseA(s, "gcomp");
    if (result.status !== "completed") {
      throw new Error(`paused at ${result.failedStep}: ${db.getStep("gcomp", result.failedStep!)?.error}`);
    }

    // explorer: mesh member tunneling to sentry-0's LCD/RPC, nginx on 80
    const explorer = fs.readFileSync(path.join(dirs.sdl, "explorer.yaml"), "utf8");
    expect(explorer).toContain(`image: ${s.images.explorer}`);
    expect(explorer).toContain("TS_AUTHKEY={{TS_AUTHKEY:explorer}}");
    expect(explorer).toContain("TS_TUNNEL_1=11317:{{TAILNET_IP:sentry-0}}:1317");
    expect(explorer).toContain("TS_TUNNEL_2=26657:{{TAILNET_IP:sentry-0}}:26657");
    expect(explorer).toContain("explorer.sparkdream.io");
    expect(explorer).toContain("NODE_API_ENDPOINT=/api");
    expect(explorer).toContain("persistent: true");
    expect(explorer).toContain("denom: uact");

    // frontend: pure runtime env, no mesh, port 3000 behind the domain
    const frontend = fs.readFileSync(path.join(dirs.sdl, "frontend.yaml"), "utf8");
    expect(frontend).toContain(`image: ${s.images.frontend}`);
    expect(frontend).toContain("CHAIN_ID=sparkdream-1");
    expect(frontend).toContain("CHAIN_NAME=Spark Dream");
    expect(frontend).toContain("LCD_ENDPOINT=https://api.sparkdream.io");
    expect(frontend).toContain("RPC_ENDPOINT=https://rpc.sparkdream.io");
    expect(frontend).toContain("CHAIN_DENOM=uspark.sparkdreamtest");
    expect(frontend).toContain("BECH32_PREFIX=sprkdrm");
    expect(frontend).toContain("EXPLORER_URL=https://explorer.sparkdream.io/sparkdream");
    expect(frontend).not.toContain("TS_AUTHKEY");
    expect(frontend).toContain("app.sparkdream.io");

    // sentry-0 carries the public accept-domain exposes; sentry-1 does not
    const sentry0 = fs.readFileSync(path.join(dirs.sdl, "sentry-0.yaml"), "utf8");
    expect(sentry0).toContain("api.sparkdream.io");
    expect(sentry0).toContain("rpc.sparkdream.io");
    const sentry1 = fs.readFileSync(path.join(dirs.sdl, "sentry-1.yaml"), "utf8");
    expect(sentry1).not.toContain("api.sparkdream.io");
    expect(sentry1).not.toContain("rpc.sparkdream.io");

    // the sentry LCD is on and reachable from outside the container; the
    // validator app.toml is untouched
    const sentryApp = fs.readFileSync(path.join(dirs.node("sentry-0"), "config", "app.toml"), "utf8");
    expect(sentryApp).toContain('address = "tcp://0.0.0.0:1317"');
    expect(sentryApp).not.toContain("enable = false");
    const valApp = fs.readFileSync(path.join(dirs.node("val-0"), "config", "app.toml"), "utf8");
    expect(valApp).not.toContain('address = "tcp://0.0.0.0:1317"');
    db.close();
  }, 120_000);
});

describe("Phase A re-run", () => {
  it("is a no-op on a completed launch (checkpoint skip)", async () => {
    const s = spec(1, 0, {});
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    db.createLaunch("rerun", JSON.stringify(s));
    const first = await runLaunch(db, "rerun", s, work, phaseASteps(), fakeServices());
    expect(first.status).toBe("completed");
    const stamps = db.listSteps("rerun").map((r) => r.finished_at);
    const second = await runLaunch(db, "rerun", s, work, phaseASteps(), fakeServices());
    expect(second.status).toBe("completed");
    expect(db.listSteps("rerun").map((r) => r.finished_at)).toEqual(stamps);
    db.close();
  }, 120_000);
});
