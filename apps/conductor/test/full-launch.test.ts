import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runLaunch, runWithSigner } from "../src/engine.js";
import { BLOCKS_PER_MONTH } from "../src/fee.js";
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

describe("stale-order recovery", () => {
  it("closes a headscale order whose bids expired and redeploys fresh", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    db.createLaunch("stale", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    (services.api as any).staleFirstOrder = true;
    const signer = new FakeSigner();

    const result = await runWithSigner(db, "stale", s, work, allSteps(), services, signer);
    if (result.status !== "completed") {
      const step = db.listSteps("stale").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    // one close tx was signed for the stale order, and headscale ended up
    // on a different (fresh) dseq
    const closes = signer.signed.flat().filter((m) => m.typeUrl.includes("MsgCloseDeployment"));
    expect(closes).toHaveLength(1);
    const headscale = db.stepOutput<any>("stale", "deploy-headscale")!;
    expect(String((closes[0]!.value as any).id.dseq)).not.toBe(headscale.dseq);
  }, 120_000);

  it("recovers create-leases when node bids expire while awaiting the signature", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    db.createLaunch("stalebids", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const api = services.api as any;
    const signer = new FakeSigner();

    // drive like runWithSigner, but the FIRST time the create-leases
    // signature comes up, expire every node bid instead of signing —
    // simulates a launch that sat paused past the bid TTL ("bid not open")
    let expired = false;
    let staleDseqs: string[] = [];
    let resumesAfterExpiry = 0;
    let result;
    for (;;) {
      result = await runLaunch(db, "stalebids", s, work, allSteps(), services);
      if (result.status === "awaiting-signature") {
        const pending = db.nextPendingTx("stalebids")!;
        if (!expired && pending.step === "create-leases") {
          expired = true;
          const plan = db.stepOutput<any>("stalebids", "create-deployments")!;
          staleDseqs = Object.values(plan.perNode).map((p: any) => String(p.dseq));
          for (const dseq of staleDseqs) api.expiredBidDseqs.add(dseq);
          continue; // re-drive: the step re-checks bid freshness first
        }
        const txHash = await signer.sign(JSON.parse(pending.msgs_json));
        db.setPendingTxSigned("stalebids", pending.step, txHash);
        continue;
      }
      if (result.status === "paused") {
        const step = db.listSteps("stalebids").find((x) => x.status === "error");
        if (step?.error?.includes("expired") && resumesAfterExpiry++ === 0) continue;
        throw new Error(`ended paused at ${step?.name}: ${step?.error}`);
      }
      break;
    }
    expect(result.status).toBe("completed");

    // the stale node deployments were closed in one batch (escrow refund)…
    const closes = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCloseDeployment"))
      .map((m) => String((m.value as any).id.dseq));
    expect(closes.sort()).toEqual([...staleDseqs].sort());

    // …and the leases landed on fresh dseqs from the redeployed batch
    const leased = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCreateLease"))
      .map((m) => String((m.value as any).bidId.dseq));
    for (const dseq of staleDseqs) expect(leased).not.toContain(dseq);
  }, 120_000);

  it("drops the recovery close when a shutdown already closed the deployments", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    db.createLaunch("raced", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const api = services.api as any;
    const signer = new FakeSigner();

    // bids expire at the lease prompt; then, instead of signing the
    // recovery's close tx, the deployments get closed out-of-band (the
    // user's fleet shutdown racing the recovery) — the close row must be
    // dropped, not offered as a tx the chain rejects ("Deployment closed")
    let expired = false;
    let closedOutOfBand = false;
    let staleDseqs: string[] = [];
    let resumesAfterExpiry = 0;
    let result;
    for (;;) {
      result = await runLaunch(db, "raced", s, work, allSteps(), services);
      if (result.status === "awaiting-signature") {
        const pending = db.nextPendingTx("raced")!;
        if (!expired && pending.step === "create-leases") {
          expired = true;
          const plan = db.stepOutput<any>("raced", "create-deployments")!;
          staleDseqs = Object.values(plan.perNode).map((p: any) => String(p.dseq));
          for (const dseq of staleDseqs) api.expiredBidDseqs.add(dseq);
          continue;
        }
        if (!closedOutOfBand && pending.step.startsWith("create-leases:close:")) {
          closedOutOfBand = true;
          for (const dseq of staleDseqs) api.leaseStates.set(dseq, "closed");
          continue; // don't sign — re-drive; recovery must retract the close
        }
        const txHash = await signer.sign(JSON.parse(pending.msgs_json));
        db.setPendingTxSigned("raced", pending.step, txHash);
        continue;
      }
      if (result.status === "paused") {
        const step = db.listSteps("raced").find((x) => x.status === "error");
        if (step?.error?.includes("expired") && resumesAfterExpiry++ === 0) continue;
        throw new Error(`ended paused at ${step?.name}: ${step?.error}`);
      }
      break;
    }
    expect(result.status).toBe("completed");

    // no close was ever signed for the already-closed deployments…
    const closes = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCloseDeployment"))
      .map((m) => String((m.value as any).id.dseq));
    expect(closes).toEqual([]);

    // …the orphaned close row is gone, and the leases are on fresh dseqs
    expect(db.nextPendingTx("raced")).toBeUndefined();
    const leased = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCreateLease"))
      .map((m) => String((m.value as any).bidId.dseq));
    for (const dseq of staleDseqs) expect(leased).not.toContain(dseq);
  }, 120_000);
});

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
    expect(signer.signed[4]!).toHaveLength(5); // 4 leases + launch fee in ONE tx
    expect(signer.signed[5]!.every((m) => m.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);

    // launch fee: 10% of the leased monthly rate, sent with the leases —
    // fake bids: headscale 100 + nodes 110/120/130/140 = 600 uact/block.
    // uact bank sends are disabled, so the fee goes out in uakt at the fake
    // oracle price ($0.50 → 2× the uact amount).
    const feeMsg = signer.signed[4]!.at(-1)!;
    expect(feeMsg.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect((feeMsg.value as any).to_address).toBe(
      "akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w",
    );
    expect((feeMsg.value as any).amount).toEqual([
      { denom: "uakt", amount: String(Math.ceil(600 * BLOCKS_PER_MONTH * 0.1) * 2) },
    ]);

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

  it("deploys explorer + frontend in the node batch, still 6 signatures", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      topology: {
        validators: { count: 2 },
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
    db.createLaunch("comp", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const result = await runWithSigner(db, "comp", s, work, allSteps(), services, signer);
    if (result.status !== "completed") {
      const step = db.listSteps("comp").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    // same 6 signatures as a node-only launch (§5 step 12): the components
    // ride the batched deployment/lease txs
    expect(signer.signed).toHaveLength(6);
    expect(signer.signed[3]!).toHaveLength(6); // 4 nodes + explorer + frontend in ONE tx
    expect(signer.signed[4]!).toHaveLength(7); // 6 leases + launch fee in ONE tx
    // persist-start updates nodes + explorer (tunnel IPs) but NOT the
    // frontend (env-final since Phase A; an update would only restart it)
    expect(signer.signed[5]!).toHaveLength(5);

    // manifests: headscale + 6 components + 5 persist-start re-PUTs
    expect(services.provider.manifests).toHaveLength(12);

    const dirs = launchDirs(work, "comp");
    const explorerSdl = fs.readFileSync(path.join(dirs.sdl, "explorer.yaml"), "utf8");
    expect(explorerSdl).not.toContain("{{TAILNET_IP");
    expect(explorerSdl).not.toContain("{{TS_AUTHKEY");
    const frontendSdl = fs.readFileSync(path.join(dirs.sdl, "frontend.yaml"), "utf8");
    expect(frontendSdl).toContain("LCD_ENDPOINT=https://api.sparkdream.io");

    // verify-chain proved the domains answer (fake rpc says HTTP 200)
    const verify = db.stepOutput<any>("comp", "verify-chain")!;
    expect(Object.keys(verify.http)).toEqual([
      "explorer",
      "frontend",
      "public-api",
      "public-rpc",
    ]);

    // components never get chain data or an SSH start — only the 4 nodes do
    expect(services.ssh.started.size).toBe(4);
    expect(db.nextPendingTx("comp")).toBeUndefined();
    db.close();
  }, 120_000);

  it("verify-chain pauses with DNS guidance when a component domain is dark", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: true, domain: "explorer.sparkdream.io" },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    db.createLaunch("compdns", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();
    // only the explorer's domain is dark — headscale's DNS gate still passes
    services.rpc.darkUrls.add("explorer.sparkdream.io");

    const first = await runWithSigner(db, "compdns", s, work, allSteps(), services, signer);
    expect(first.status).toBe("awaiting-user");
    expect(first.failedStep).toBe("verify-chain");
    expect(first.reason).toContain("explorer.sparkdream.io");
    expect(first.reason).toContain("CNAME");

    // user creates the DNS record, resumes
    services.rpc.darkUrls.clear();
    const second = await runWithSigner(db, "compdns", s, work, allSteps(), services, signer);
    expect(second.status).toBe("completed");
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
