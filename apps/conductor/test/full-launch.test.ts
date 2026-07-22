import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runLaunch, runWithSigner } from "../src/engine.js";
import { BLOCKS_PER_MONTH } from "../src/fee.js";
import { FleetService } from "../src/fleet.js";
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

  it("honors spec provider exclusions: headscale dodges its list, nodes keep the provider", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      providers: {
        exclude: ["provider1"],
        components: { headscale: { exclude: ["provider2"] } },
      },
    });
    db.createLaunch("excl", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const result = await runWithSigner(db, "excl", s, work, allSteps(), services, signer);
    if (result.status !== "completed") {
      const step = db.listSteps("excl").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    // headscale is barred from provider1 (fleet-wide) and provider2 (its own
    // list); the cheapest remaining bid wins
    const headscale = db.stepOutput<any>("excl", "deploy-headscale")!;
    expect(headscale.provider).toBe("akash1provider3");

    const assignments = db.stepOutput<any>("excl", "collect-bids")!;
    const nodeProviders = Object.values(assignments.perNode).map((a: any) => a.provider);
    // fleet-wide exclusion holds for every node
    expect(nodeProviders).not.toContain("akash1provider1");
    // the motivating scenario: provider2 is off-limits to headscale only,
    // and a node still lands on it
    expect(nodeProviders).toContain("akash1provider2");
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

  it("send-manifests re-bids a component off an unreachable provider and avoids it", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("deadprov", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    // let collect-bids run, then kill the provider that won a node's lease —
    // the same shape as a provider whose DNS zone goes SERVFAIL mid-launch
    let killed: { hostUri: string; provider: string; dseq: string } | undefined;
    const originalDrive = async () => {
      for (;;) {
        const result = await runLaunch(db, "deadprov", s, work, allSteps(), services);
        if (result.status === "awaiting-signature") {
          const pending = db.nextPendingTx("deadprov")!;
          const txHash = await signer.sign(JSON.parse(pending.msgs_json));
          db.setPendingTxSigned("deadprov", pending.step, txHash);
          // as soon as bids are assigned, mark val-0's provider unreachable
          const a = db.stepOutput<any>("deadprov", "collect-bids");
          const p = db.stepOutput<any>("deadprov", "create-deployments");
          if (a && p && !killed) {
            killed = {
              hostUri: a.perNode["val-0"].hostUri,
              provider: a.perNode["val-0"].provider,
              dseq: String(p.perNode["val-0"].dseq), // the placement being abandoned
            };
            services.provider.unreachableProviders.add(killed.hostUri);
          }
          continue;
        }
        return result;
      }
    };
    const result = await originalDrive();
    if (result.status !== "completed") {
      const step = db.listSteps("deadprov").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }
    expect(killed).toBeTruthy();

    // val-0 moved off the dead provider, and its recorded placement follows
    const assignments = db.stepOutput<any>("deadprov", "collect-bids")!;
    const plan = db.stepOutput<any>("deadprov", "create-deployments")!;
    expect(assignments.perNode["val-0"].provider).not.toBe(killed!.provider);
    expect(assignments.perNode["val-0"].hostUri).not.toBe(killed!.hostUri);
    // the replacement carries a fresh dseq, and the abandoned one was closed
    // so its escrow comes back
    expect(plan.perNode["val-0"].dseq).not.toBe(killed!.dseq);
    const closes = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCloseDeployment"))
      .map((m) => String((m.value as any).id.dseq));
    expect(closes).toContain(killed!.dseq);

    // the dead provider is on the wallet's avoid list so nothing picks it again
    expect(db.providerPrefs("akash1owner").avoid).toContain(killed!.provider);

    // and the launch really finished: every node has a manifest at its
    // CURRENT provider, none at the dead one
    expect(
      services.provider.manifests.some((m) => m.hostUri === killed!.hostUri),
    ).toBe(false);
    db.close();
  }, 180_000);

  it("re-place rescues a node that dies AFTER send-manifests already passed", async () => {
    // The deadlock this exists for: send-manifests checkpoints `done`, then a
    // node's deployment is closed. await-mesh waits forever for a container
    // that no longer exists, and a relaunch op cannot run because op steps
    // come after launch steps. requestReplace re-opens the placement steps so
    // the launch itself re-bids the node.
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("replace", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();
    const fleet = new FleetService(db, services, work);

    const first = await runWithSigner(db, "replace", s, work, allSteps(), services, signer);
    expect(first.status).toBe("completed");
    expect(db.getStep("replace", "send-manifests")?.status).toBe("done");

    // the sentry's deployment dies after the fact; pretend the launch is
    // still in flight (as it is when this happens for real)
    fleet.materialize("replace");
    db.setLaunchStatus("replace", "paused");
    const sentry = db.listFleetComponents("replace").find((c) => c.key === "sentry-0")!;
    const deadDseq = sentry.dseq;
    services.provider.leaselessDseqs.add(deadDseq);
    (services.api as any).leaseStates.set(deadDseq, "closed");

    const launch = db.getLaunch("replace")!;
    const { closing } = await fleet.requestReplace(launch, sentry);
    expect(closing).toBe(false); // already closed on-chain — nothing to sign
    // the placement steps re-open so the launch can redo them
    expect(db.getStep("replace", "send-manifests")?.status).not.toBe("done");
    expect(db.getStep("replace", "upload-node-data")?.status).not.toBe("done");

    const second = await runWithSigner(db, "replace", s, work, allSteps(), services, signer);
    if (second.status !== "completed") {
      const step = db.listSteps("replace").find((x) => x.status !== "done");
      throw new Error(`ended ${second.status} at ${step?.name}: ${step?.error}`);
    }
    // sentry-0 was re-placed on a fresh deployment, others untouched
    const plan = db.stepOutput<any>("replace", "create-deployments")!;
    expect(plan.perNode["sentry-0"].dseq).not.toBe(deadDseq);
    db.close();
  }, 180_000);

  it("re-place AFTER persist-start: manifests track the rewritten SDLs, no 422 wedge", async () => {
    // Seen live on a testnet launch paused at verify-chain: the user
    // re-placed the stateless components, the close txs confirmed, and
    // send-manifests re-ran — but persist-start had already rewritten the
    // SDLs and pushed MsgUpdateDeployment, so every still-active node's
    // create-deployments-era manifest no longer matched its on-chain hash.
    // The provider 422'd the first active node ("manifest version validation
    // failed") and the step wedged before the re-place was even reached.
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: true, domain: "explorer.sparkdream.io" },
          frontend: { enabled: true, domain: "app.sparkdream.io" },
          hub: { enabled: false },
        },
        publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    db.createLaunch("persistreplace", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const api = services.api as any;
    const signer = new FakeSigner();
    const fleet = new FleetService(db, services, work);

    // drive like runWithSigner, but apply chain effects at each confirmed tx
    // the way the real chain would: create/update records the deployment hash
    // (what the provider validates the manifest against — the fake provider
    // 422s a mismatch), close flips the deployment to closed
    const applyTxEffects = (msgs: any[]) => {
      for (const m of msgs) {
        if (m.typeUrl.includes("MsgCreateDeployment") || m.typeUrl.includes("MsgUpdateDeployment")) {
          api.deploymentHashes.set(String(m.value.id.dseq), m.value.hash);
        }
        if (m.typeUrl.includes("MsgCloseDeployment")) {
          api.leaseStates.set(String(m.value.id.dseq), "closed");
        }
      }
    };
    const drive = async () => {
      for (;;) {
        const result = await runLaunch(db, "persistreplace", s, work, allSteps(), services);
        if (result.status !== "awaiting-signature") return result;
        const pending = db.nextPendingTx("persistreplace")!;
        const msgs = JSON.parse(pending.msgs_json);
        const txHash = await signer.sign(msgs);
        applyTxEffects(msgs);
        db.setPendingTxSigned("persistreplace", pending.step, txHash);
      }
    };
    const finish = (label: string, result: any) => {
      if (result.status !== "completed") {
        const step = db.listSteps("persistreplace").find((x) => x.status !== "done");
        throw new Error(`${label} ended ${result.status} at ${step?.name}: ${step?.error}`);
      }
    };

    finish("first run", await drive());
    // persist-start has now rewritten the node + explorer SDLs and updated
    // the on-chain hashes: the manifest snapshots from create-deployments
    // are stale for every still-active deployment

    fleet.materialize("persistreplace");
    db.setLaunchStatus("persistreplace", "paused");
    const explorer = db.listFleetComponents("persistreplace").find((c) => c.key === "explorer")!;
    const deadDseq = explorer.dseq;
    const launch = db.getLaunch("persistreplace")!;
    const { closing } = await fleet.requestReplace(launch, explorer);
    expect(closing).toBe(true); // still active on-chain: a close tx is signed

    // the UI signs the close first (fleet txs settle outside the step
    // engine); only then does the launch re-drive into send-manifests
    const close = db.nextPendingTx("persistreplace")!;
    expect(close.step).toBe(`fleet:close:${deadDseq}`);
    const closeMsgs = JSON.parse(close.msgs_json);
    const closeHash = await signer.sign(closeMsgs);
    applyTxEffects(closeMsgs);
    db.setPendingTxSigned("persistreplace", close.step, closeHash);

    // hash drift from OUTSIDE the launcher: an update signed elsewhere with
    // the same wallet leaves an on-chain hash matching no known manifest
    // (seen live on a validator). send-manifests must reconcile it with an
    // update tx, not 422 on the provider's version check.
    const val0 = db.listFleetComponents("persistreplace").find((c) => c.key === "val-0")!;
    const foreignHash = "aoJRU8KL/PXB3rkX4Nh+K+aMQ6o7tCcfiRqVhiaxUTg=";
    api.deploymentHashes.set(val0.dseq, foreignHash);
    const sigsBefore = signer.signed.length;

    finish("second run", await drive());

    // val-0's drift was reconciled on-chain before its manifest went out
    const reconcileTxs = signer.signed
      .slice(sigsBefore)
      .flat()
      .filter(
        (m) =>
          m.typeUrl.includes("MsgUpdateDeployment") &&
          String((m.value as any).id.dseq) === val0.dseq,
      );
    expect(reconcileTxs).toHaveLength(1);
    expect((reconcileTxs[0]!.value as any).hash).not.toBe(foreignHash);

    // explorer re-placed on a fresh deployment; every other component kept its
    // dseq (their re-sent manifests matched the persisted on-chain hashes)
    const plan = db.stepOutput<any>("persistreplace", "create-deployments")!;
    expect(plan.perNode["explorer"].dseq).not.toBe(deadDseq);
    for (const key of ["val-0", "sentry-0", "frontend"]) {
      expect(plan.perNode[key].dseq).toBe(
        db.listFleetComponents("persistreplace").find((c) => c.key === key)!.dseq,
      );
    }
    const closes = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCloseDeployment"))
      .map((m) => String((m.value as any).id.dseq));
    expect(closes).toContain(deadDseq);
    db.close();
  }, 180_000);

  it("re-deploys a component whose lease the provider closed, without blaming the provider", async () => {
    // A manifest timeout closes the lease while the launch is blocked
    // elsewhere. The provider is healthy (it hosts the rest of the fleet), so
    // the component must be re-placed WITHOUT the provider going on the avoid
    // list — blaming it would needlessly shrink the bid pool.
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("leasegone", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    let victim: { dseq: string; provider: string } | undefined;
    let result;
    for (;;) {
      result = await runLaunch(db, "leasegone", s, work, allSteps(), services);
      if (result.status !== "awaiting-signature") break;
      const pending = db.nextPendingTx("leasegone")!;
      const txHash = await signer.sign(JSON.parse(pending.msgs_json));
      db.setPendingTxSigned("leasegone", pending.step, txHash);
      const plan = db.stepOutput<any>("leasegone", "create-deployments");
      const a = db.stepOutput<any>("leasegone", "collect-bids");
      if (plan && a && !victim) {
        victim = { dseq: String(plan.perNode["sentry-0"].dseq), provider: a.perNode["sentry-0"].provider };
        services.provider.leaselessDseqs.add(victim.dseq);
      }
    }
    if (result.status !== "completed") {
      const step = db.listSteps("leasegone").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    // re-deployed under a fresh dseq, old one closed so escrow returns
    const plan = db.stepOutput<any>("leasegone", "create-deployments")!;
    expect(plan.perNode["sentry-0"].dseq).not.toBe(victim!.dseq);
    const closes = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCloseDeployment"))
      .map((m) => String((m.value as any).id.dseq));
    expect(closes).toContain(victim!.dseq);

    // and crucially the provider was NOT blamed
    expect(db.providerPrefs("akash1owner").avoid).not.toContain(victim!.provider);

    // anti-affinity still holds after a re-bid: the replacement must not land
    // on headscale's provider or another node's (§6)
    const a2 = db.stepOutput<any>("leasegone", "collect-bids")!;
    const hs = db.stepOutput<any>("leasegone", "deploy-headscale")!;
    expect(a2.perNode["sentry-0"].provider).not.toBe(hs.provider);
    expect(a2.perNode["sentry-0"].provider).not.toBe(a2.perNode["val-0"].provider);
    db.close();
  }, 180_000);

  it("re-places a closed deployment from chain state, without pushing a manifest at it", async () => {
    // Providers report a dead placement with whatever error they feel like
    // (404 no lease, 500 not found, 422 manifest version validation failed).
    // Chain state is authoritative, so a closed deployment must be re-placed
    // BEFORE any manifest is attempted.
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("closedep", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const first = await runWithSigner(db, "closedep", s, work, allSteps(), services, signer);
    expect(first.status).toBe("completed");

    const plan = db.stepOutput<any>("closedep", "create-deployments")!;
    const closedDseq = String(plan.perNode["sentry-0"].dseq);
    (services.api as any).leaseStates.set(closedDseq, "closed");
    const manifestsBefore = services.provider.manifests.length;
    db.resetStep("closedep", "send-manifests");

    const second = await runWithSigner(db, "closedep", s, work, allSteps(), services, signer);
    if (second.status !== "completed") {
      const step = db.listSteps("closedep").find((x) => x.status !== "done");
      throw new Error(`ended ${second.status} at ${step?.name}: ${step?.error}`);
    }
    // re-placed onto a fresh deployment…
    const plan2 = db.stepOutput<any>("closedep", "create-deployments")!;
    expect(plan2.perNode["sentry-0"].dseq).not.toBe(closedDseq);
    // …and no manifest was ever pushed at the closed one
    const sentToClosed = services.provider.manifests
      .slice(manifestsBefore)
      .filter((m) => m.dseq === closedDseq);
    expect(sentToClosed).toHaveLength(0);
    db.close();
  }, 180_000);

  it("recovers when the replacement deployment itself is not on-chain", async () => {
    // The provider answers "Deployment not found: key not found" — the
    // replacement placement is a ghost (closed, or a deployment tx that never
    // took). Retrying it forever is useless; it must start a fresh placement,
    // and it must NOT try to close a deployment the chain never had (that tx
    // would fail on-chain and wedge the signing queue).
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("ghost", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const first = await runWithSigner(db, "ghost", s, work, allSteps(), services, signer);
    expect(first.status).toBe("completed");

    // sentry-0's deployment vanishes from the chain, and the provider says so
    const plan = db.stepOutput<any>("ghost", "create-deployments")!;
    const ghostDseq = String(plan.perNode["sentry-0"].dseq);
    (services.provider as any).deploymentNotFoundDseqs = new Set([ghostDseq]);
    (services.api as any).missingDseqs.add(ghostDseq);
    db.resetStep("ghost", "send-manifests");

    const second = await runWithSigner(db, "ghost", s, work, allSteps(), services, signer);
    if (second.status !== "completed") {
      const step = db.listSteps("ghost").find((x) => x.status !== "done");
      throw new Error(`ended ${second.status} at ${step?.name}: ${step?.error}`);
    }
    // re-placed onto a real deployment…
    const plan2 = db.stepOutput<any>("ghost", "create-deployments")!;
    expect(plan2.perNode["sentry-0"].dseq).not.toBe(ghostDseq);
    // …and no close was ever signed for the deployment that never existed
    const closes = signer.signed
      .flat()
      .filter((m) => m.typeUrl.includes("MsgCloseDeployment"))
      .map((m) => String((m.value as any).id.dseq));
    expect(closes).not.toContain(ghostDseq);
    db.close();
  }, 180_000);

  it("re-bid survives a pause between the replacement lease and the manifest send", async () => {
    // Regression: leasing closes every other bid on the order, so a re-entry
    // that re-polls bids sees none open and wrongly reports "no acceptable
    // replacement bid was found ([])". The signed lease IS the choice.
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("rebidpause", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    let killed: string | undefined;
    let pausedAfterLease = false;
    let result;
    for (;;) {
      result = await runLaunch(db, "rebidpause", s, work, allSteps(), services);
      if (result.status !== "awaiting-signature") break;
      const pending = db.nextPendingTx("rebidpause")!;
      const txHash = await signer.sign(JSON.parse(pending.msgs_json));
      db.setPendingTxSigned("rebidpause", pending.step, txHash);
      const a = db.stepOutput<any>("rebidpause", "collect-bids");
      if (a && !killed) {
        killed = a.perNode["val-0"].hostUri;
        services.provider.unreachableProviders.add(killed!);
      }
      // stop driving for one turn right after the replacement lease is
      // signed — the exact point the real launch was interrupted
      if (pending.step.startsWith("send-manifests:release:") && !pausedAfterLease) {
        pausedAfterLease = true;
        // Akash prunes an order's bids once it closes, so on re-entry the
        // leased bid is simply GONE from the bid list. The lease is what
        // matters; a missing bid must not be treated as fatal.
        const bidId = JSON.parse(pending.msgs_json)[0].value.bidId;
        (services.api as any).prunedBidDseqs.add(String(bidId.dseq));
        await runLaunch(db, "rebidpause", s, work, allSteps(), services);
      }
    }
    expect(pausedAfterLease).toBe(true);
    if (result.status !== "completed") {
      const step = db.listSteps("rebidpause").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }
    // it must NOT have bailed out with the empty-bid message
    const sm = db.listSteps("rebidpause").find((x) => x.name === "send-manifests");
    expect(sm?.error ?? "").not.toContain("no acceptable replacement bid");
    const assignments = db.stepOutput<any>("rebidpause", "collect-bids")!;
    expect(assignments.perNode["val-0"].hostUri).not.toBe(killed);
    db.close();
  }, 180_000);

  it("await-mesh works around an IPv6 black hole: pins headscale IPv4, re-ups, completes", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("v6bh", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    // every node's control connection black-holes over IPv6 until remediated
    services.ssh.ipv6BlackHole = true;
    const signer = new FakeSigner();

    const result = await runWithSigner(db, "v6bh", s, work, allSteps(), services, signer);
    if (result.status !== "completed") {
      const step = db.listSteps("v6bh").find((x) => x.status !== "done");
      throw new Error(`ended ${result.status} at ${step?.name}: ${step?.error}`);
    }

    // remediation pinned the headscale domain to IPv4 in /etc/hosts and
    // re-ran tailscale up on every node
    const pins = services.ssh.execLog.filter(
      (e) => e.command.includes("/etc/hosts") && e.command.includes("headscale.sparkdream.io"),
    );
    expect(pins.length).toBe(4); // 2 validators + 2 sentries
    const reups = services.ssh.execLog.filter(
      (e) => e.command.includes("tailscale") && e.command.includes(" up ") && e.command.includes("--reset"),
    );
    expect(reups.length).toBe(4);

    // and every node still ended up with a tailnet IP recorded
    const mesh = db.stepOutput<{ ips: Record<string, string> }>("v6bh", "await-mesh")!;
    expect(Object.keys(mesh.ips).sort()).toEqual(["sentry-0", "sentry-1", "val-0", "val-1"]);
    db.close();
  }, 120_000);

  it("await-mesh bails out at once when a node's deployment is closed", async () => {
    // Polling a node whose container is gone burns the whole budget AND holds
    // the launch driver, so a relaunch requested meanwhile cannot start
    // (drive() no-ops while a run is in flight). It must fail fast instead.
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
    db.createLaunch("deadnode", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const first = await runWithSigner(db, "deadnode", s, work, allSteps(), services, signer);
    expect(first.status).toBe("completed");

    // sentry-0's deployment dies: its container stops answering SSH and the
    // deployment reads closed on-chain. val-0 stays healthy.
    const plan = db.stepOutput<any>("deadnode", "create-deployments")!;
    const dseq = String(plan.perNode["sentry-0"].dseq);
    (services.api as any).leaseStates.set(dseq, "closed");
    const ep = db.stepOutput<any>("deadnode", "send-manifests")!.perNode["sentry-0"];
    services.ssh.failHosts.add(`${ep.host}:${ep.port}`);
    db.resetStep("deadnode", "await-mesh");

    const second = await runWithSigner(db, "deadnode", s, work, allSteps(), services, signer);
    expect(second.status).toBe("awaiting-user");
    expect(second.failedStep).toBe("await-mesh");
    expect(second.reason).toContain("is closed");
    expect(second.reason).toContain("relaunch");
    db.close();
  }, 180_000);

  it("await-mesh blames headscale, not the node, when nobody can reach it", async () => {
    // The failure that cost hours: headscale's public endpoint went dark, so
    // no node could register — and the launcher blamed the one node that
    // happened to be joining, sending it across three providers. If the
    // LAUNCHER cannot reach headscale either, the node is not at fault.
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
    db.createLaunch("hsdown", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    const signer = new FakeSigner();

    const first = await runWithSigner(db, "hsdown", s, work, allSteps(), services, signer);
    expect(first.status).toBe("completed");

    // headscale's public endpoint then goes dark (as it did in reality, long
    // after deploy-headscale's DNS gate had passed)
    services.ssh.ipv6BlackHole = true; // no node reports a tailnet IP
    services.ssh.rejoinClearsBlackHole = false;
    services.ssh.unreachableHeadscale = true; // nor can they reach it
    services.rpc.darkUrls.add("headscale.sparkdream.io"); // …and neither can we
    db.resetStep("hsdown", "await-mesh");

    const result = await runWithSigner(db, "hsdown", s, work, allSteps(), services, signer);
    expect(result.status).toBe("awaiting-user");
    expect(result.failedStep).toBe("await-mesh");
    expect(result.reason).toContain("not answering from anywhere");
    expect(result.reason).toContain("not a problem with");
    db.close();
  }, 180_000);

  it("await-mesh reports an unreachable provider instead of a blind timeout", async () => {
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
    db.createLaunch("unreach", JSON.stringify(s), "akash1owner");
    const services = fakeServices();
    // node never joins AND headscale is unreachable from it (egress filtered):
    // the IPv4 pin + re-up can't rescue a genuinely dead path
    services.ssh.ipv6BlackHole = true;
    services.ssh.rejoinClearsBlackHole = false;
    services.ssh.unreachableHeadscale = true;
    const signer = new FakeSigner();

    const result = await runWithSigner(db, "unreach", s, work, allSteps(), services, signer);
    expect(result.status).toBe("paused");
    expect(result.failedStep).toBe("await-mesh");
    const step = db.listSteps("unreach").find((x) => x.name === "await-mesh");
    // headscale answers for the launcher but not from this node → the
    // provider is named as the culprit, not headscale
    expect(step?.error).toContain("NOT from this node");
    expect(step?.error).toContain("Relaunch");
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
