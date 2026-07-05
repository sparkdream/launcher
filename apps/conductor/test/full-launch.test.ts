import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { fakeServices, FakeSigner } from "./fakes.js";

/**
 * Full simulated launch: Phase A against the real sparkdreamd binary,
 * Phases B–F against fakes at the adapter seams, signatures auto-provided
 * by the M2-style headless signer.
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-full-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(overrides: Record<string, unknown> = {}): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 2 },
      sentries: { count: 2 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
    },
    ...overrides,
  });
}

describe("full launch, simulated (2×2 softsign testnet)", () => {
  it("runs Phase A → F to completion with 6 signatures", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("full", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const result = await runWithSigner(db, "full", s, work, allSteps(), services, signer);
    if (result.status !== "completed") {
      const step = db.listSteps("full").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    // Signature economics (§2): cert, headscale deploy, headscale lease,
    // node deployments (batched), node leases (batched), persist-start.
    expect(signer.signed).toHaveLength(6);
    expect(signer.signed[3]!).toHaveLength(4); // 4 node deployments in ONE tx
    expect(signer.signed[4]!).toHaveLength(4); // 4 leases in ONE tx
    expect(signer.signed[5]!.every((m) => m.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);

    // Manifests: headscale + 4 nodes + 4 re-PUTs from persist-start
    expect(services.provider.manifests).toHaveLength(9);

    // Anti-affinity: headscale + 4 nodes on 5 distinct providers
    const assignments = db.stepOutput<any>("full", "collect-bids")!;
    const headscale = db.stepOutput<any>("full", "deploy-headscale")!;
    const providers = new Set([
      headscale.provider,
      ...Object.values(assignments.perNode).map((a: any) => a.provider),
    ]);
    expect(providers.size).toBe(5);

    // persist-start rewrote SDLs: no placeholders left, WAIT_FOR_CONFIG=false
    const dirs = launchDirs(work, "full");
    for (const key of ["val-0", "val-1", "sentry-0", "sentry-1"]) {
      const sdl = fs.readFileSync(path.join(dirs.sdl, `${key}.yaml`), "utf8");
      expect(sdl).not.toContain("{{TAILNET_IP");
      expect(sdl).not.toContain("{{TS_AUTHKEY");
      expect(sdl).toContain("WAIT_FOR_CONFIG=false");
    }

    // chain started on every node, validators first
    expect(services.ssh.started.size).toBe(4);

    // all pending txs confirmed, none dangling
    expect(db.nextPendingTx("full")).toBeUndefined();
    db.close();
  }, 120_000);

  it("tmkms launch pauses at await-signer until the probe passes", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({ security: { keyMode: "tmkms" } });
    db.createLaunch("tmkms", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    services.ssh.signerConnected = false;
    const signer = new FakeSigner();

    const first = await runWithSigner(db, "tmkms", s, work, allSteps(), services, signer);
    expect(first.status).toBe("awaiting-user");
    expect(first.failedStep).toBe("await-signer");
    expect(first.reason).toContain("tmkms");
    expect(first.reason).toContain("26659");

    // user connects the signer, resumes
    services.ssh.signerConnected = true;
    const second = await runWithSigner(db, "tmkms", s, work, allSteps(), services, signer);
    expect(second.status).toBe("completed");
    db.close();
  }, 120_000);

  it("DNS gate pauses headscale deploy until the domain answers", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("dns", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    services.rpc.httpOkResult = false;
    const signer = new FakeSigner();

    const first = await runWithSigner(db, "dns", s, work, allSteps(), services, signer);
    expect(first.status).toBe("awaiting-user");
    expect(first.reason).toContain("DNS");

    services.rpc.httpOkResult = true;
    const second = await runWithSigner(db, "dns", s, work, allSteps(), services, signer);
    expect(second.status).toBe("completed");
    db.close();
  }, 120_000);
});
