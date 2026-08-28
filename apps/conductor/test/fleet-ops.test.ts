import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { toEncodeObject, TypeUrl } from "@sparkdream/akash-tx";
import { testnetSpec, VENDORED_CHAIN_VERSION, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner, type GentxSigner, type StepDef } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import {
  buildOpSteps,
  buildPreLaunchOpSteps,
  pollSsh,
  retagImage,
  rewriteTailnetIps,
  withRedeployNonce,
} from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { fakeServices, FakeSigner, keplrSignAmino, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-ops-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The version one patch above the vendored one, which the profiles pin. */
function nextChainVersion(): string {
  const [major, minor, patch] = VENDORED_CHAIN_VERSION.replace(/^v/, "").split(".").map(Number);
  return `v${major}.${minor}.${patch! + 1}`;
}

// relaunch ops are asserted by where the component lands, so these specs turn
// anti-affinity on: no profile does by default
function spec2x2(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    providers: { policy: { antiAffinity: "strict" } },
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
  });
}

function specWithComponents(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    providers: { policy: { antiAffinity: "strict" } },
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
}

function tmkms1x1(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  spec: LaunchSpec;
  fleet: FleetService;
  signer: FakeSigner;
  gentxSigner?: GentxSigner;
}

async function launched(s: LaunchSpec = spec2x2(), gentxSigner?: GentxSigner): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  const result = await runWithSigner(db, "fl", s, work, allSteps(), services, signer, undefined, gentxSigner);
  expect(result.status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  return { work, db, services, spec: s, fleet, signer, gentxSigner };
}

async function driveOps(w: World) {
  const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer, undefined, w.gentxSigner);
}

describe("relaunch op", () => {
  it("relaunches a sentry: new provider/dseq, tunnels rebuilt, validator re-patched", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    // the old container stops answering once the provider tears it down
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(after.state).toBe("active");
    expect(after.dseq).not.toBe(before.dseq);
    expect(after.generation).toBe(1);
    expect(after.tailnet_ip).not.toBe(before.tailnet_ip);
    // §6 anti-affinity honored against the live fleet
    const others = w.db
      .listFleetComponents("fl")
      .filter((c) => c.key !== "sentry-0")
      .map((c) => c.provider);
    expect(others).not.toContain(after.provider);
    // §5: sentry relaunch re-patches its validator's persistent_peers (sed old→new IP)
    expect(
      w.services.ssh.execLog.some(
        (e) => e.command.includes("sed -i") && e.command.includes(before.tailnet_ip!),
      ),
    ).toBe(true);
    // sentry mesh: the fellow sentry's peer entry is repaired to the new IP...
    const sentry1 = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-1")!;
    expect(
      w.services.ssh.execLog.some(
        (e) =>
          e.target === `${sentry1.ssh_host}:${sentry1.ssh_port}` &&
          e.command.includes("sed -i") &&
          e.command.includes(before.tailnet_ip!),
      ),
    ).toBe(true);
    // ...and the relaunched sentry resolves its own re-uploaded placeholder
    // for the fellow sentry's current IP
    expect(
      w.services.ssh.execLog.some((e) =>
        e.command.includes(`{{TAILNET_IP:sentry-1}}|${sentry1.tailnet_ip}`),
      ),
    ).toBe(true);
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("takes the node's own RPC as proof of the restart when its shell goes quiet", async () => {
    // the live shape: the persist push re-creates the container, its
    // forwarded SSH port moves with it, and the wait that follows failed a
    // relaunch whose node had booted and was serving
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    // wherever the node ends up, the one question the wait asks over SSH
    // goes unanswered
    w.services.ssh.mutedCommands.push(/pgrep -x sparkdreamd/);

    expect((await driveOps(w)).status).toBe("completed");
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(after.state).toBe("active");
    expect(after.dseq).not.toBe(before.dseq);
  }, 120_000);

  it("a stacked relaunch on the same component supersedes the prior op (no deploy→lease→deploy loop)", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const launch = w.db.getLaunch("fl")!;
    // two clicks → two requestRelaunch calls. Without supersede both stay
    // active and buildOpSteps runs them together: each op's close step reads
    // the component row that the other's manifest step just rewrote to its own
    // new dseq, so each closes what the other deployed — a loop.
    await w.fleet.requestRelaunch(launch, before);
    await w.fleet.requestRelaunch(launch, before);
    const ops = w.db.listFleetOps("fl").filter((o) => o.kind === "relaunch");
    expect(ops.length).toBe(2);
    expect(ops.filter((o) => o.status === "active")).toHaveLength(1);
    expect(ops.some((o) => o.status === "aborted")).toBe(true);
    // the lone surviving op drives to completion cleanly
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    const result = await driveOps(w);
    expect(result.status).toBe("completed");
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(after.state).toBe("active");
    expect(after.dseq).not.toBe(before.dseq);
  }, 120_000);

  it("relaunch honors the spec's per-component provider exclusions", async () => {
    // 1x1 fleet: headscale/val-0/sentry-0 land on providers 1/2/3 (cheapest
    // bids). provider4 is the bid a sentry-0 relaunch would win without the
    // exclusion, so excluding it must push the relaunch to provider5.
    const s = testnetSpec({
      network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
      providers: {
        policy: { antiAffinity: "strict" },
        components: { sentries: { exclude: ["provider4"] } },
      },
    });
    const w = await launched(s);
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(before.provider).toBe("akash1provider3");
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(after.state).toBe("active");
    expect(after.provider).not.toBe(before.provider); // moved off the old provider
    expect(after.provider).not.toBe("akash1provider4"); // spec exclusion held
    expect(after.provider).toBe("akash1provider5");
  }, 120_000);

  it("manual bid selection parks with the bid list and leases the pick over the policy", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before, { manualBid: true });
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);

    // parks at the lease step instead of picking
    expect((await driveOps(w)).status).toBe("awaiting-user");
    const opId = w.db.listFleetOps("fl").find((o) => o.status === "active")!.id;
    const offers = JSON.parse(w.db.listFleetOps("fl").find((o) => o.id === opId)!.params_json)
      .offeredBids as { dseq: string; bids: Array<{ provider: string; rejected?: string }> };
    expect(offers.bids.length).toBeGreaterThan(1);
    // cheapest first, and the reasons the policy passed a bid over travel
    // to the picker (they are exactly what the operator is overriding)
    const prices = offers.bids.map((b) => Number((b as { price: string }).price));
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    // the fellow sentry's provider is rejected by anti-affinity — pick it
    // anyway: a hand-picked bid beats every filter
    const taken = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-1")!.provider;
    expect(offers.bids.find((b) => b.provider === taken)?.rejected).toMatch(/anti-affinity/);
    w.fleet.chooseBid(launch, opId, taken);

    expect((await driveOps(w)).status).toBe("completed");
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(after.state).toBe("active");
    expect(after.provider).toBe(taken);
  }, 120_000);

  it("pauses on a genuine zombie container, proceeds past a mute closed-lease gateway", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");

    // container really still answering → pause for the provider teardown
    w.services.ssh.zombieHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");

    // gateway now answers with empty success for the closed lease (observed
    // on jjozzietech) — execution proof fails, so the node counts as gone
    w.services.ssh.zombieHosts.delete(`${before.ssh_host}:${before.ssh_port}`);
    const result = await driveOps(w);
    expect(result.status).toBe("completed");
  }, 120_000);

  it("relaunches a softsign validator behind the double-sign window", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    expect(after.generation).toBe(1);
    // sentries' socat tunnels rewired to the new validator IP
    expect(
      w.services.ssh.execLog.some(
        (e) => e.command.includes("socat TCP-LISTEN:16656") && e.command.includes(after.tailnet_ip!),
      ),
    ).toBe(true);
    // single-boot rule: the relaunched node is never SSH-started — the
    // persist step's manifest push is its first and only boot (an
    // SSH-started node torn down by that push crash-looped live)
    const newId = `${after.ssh_host}:${after.ssh_port}`;
    expect(
      w.services.ssh.execLog.some(
        (e) => e.target === newId && e.command.includes("sparkdreamd start"),
      ),
    ).toBe(false);
    // and the deployment left wait mode, so the entrypoint owns the process
    expect(
      fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "val-0.yaml"), "utf8"),
    ).toContain("WAIT_FOR_CONFIG=false");
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);
});

describe("tmkms validator relaunch", () => {
  it("gates on the signer AFTER the node boots, with the new address", async () => {
    // The gate used to run before persist, probing the privval port on a
    // container that had not started sparkdreamd yet — unsatisfiable, so
    // resume failed forever however correctly the signer was repointed.
    const w = await launched(tmkms1x1());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    w.services.ssh.signerConnected = false; // signer still on the old address
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);

    const opId = w.db.listFleetOps("fl")[0]!.id;
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:await-signer`);

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    // the pause names the address the signer must now dial...
    expect(parked.reason).toContain(`tcp://${after.tailnet_ip}:26659`);
    expect(parked.reason).not.toContain(before.tailnet_ip!);
    // ...and it comes after the boot, so a repointed signer can actually
    // connect: the deployment left wait mode and the node is running
    expect(
      fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "val-0.yaml"), "utf8"),
    ).toContain("WAIT_FOR_CONFIG=false");
    expect(w.services.ssh.started.has(`${after.ssh_host}:${after.ssh_port}`)).toBe(true);

    // signer repointed and restarted → resume clears the gate
    w.services.ssh.signerConnected = true;
    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("publishes the new signer address to the tmkms checklist", async () => {
    // the checklist renders from the launch's await-mesh table, so a
    // relaunch that left it stale sent the operator to a dead endpoint
    const w = await launched(tmkms1x1());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const mesh = w.db.stepOutput<{ ips: Record<string, string> }>("fl", "await-mesh")!;
    expect(mesh.ips["val-0"]).toBe(after.tailnet_ip);
  }, 120_000);
});

describe("stateless component relaunch", () => {
  it("relaunches the explorer without rewiring or start guards", async () => {
    const w = await launched(specWithComponents());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    const startsBefore = w.services.ssh.started.size;

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    expect(after.state).toBe("active");
    expect(after.dseq).not.toBe(before.dseq);
    expect(after.provider).not.toBe(before.provider);
    // no chain-node work: nothing uploaded or started, no double-sign wait
    expect(w.services.ssh.started.size).toBe(startsBefore);
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("relaunches the frontend (no sshd, no preauth key)", async () => {
    const w = await launched(specWithComponents());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "frontend")!;
    expect(before.ssh_host).toBeNull(); // never had an SSH endpoint
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    const mintsBefore = w.services.provider.shellLog.filter((e) =>
      e.script.includes("preauthkeys create"),
    ).length;

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "frontend")!;
    expect(after.state).toBe("active");
    expect(after.dseq).not.toBe(before.dseq);
    expect(after.ssh_host).toBeNull();
    // no mesh membership → no preauth key was minted for the relaunch
    const mintsAfter = w.services.provider.shellLog.filter((e) =>
      e.script.includes("preauthkeys create"),
    ).length;
    expect(mintsAfter).toBe(mintsBefore);
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("follows the sentry's tailnet IP: repointed on the sentry's relaunch, re-aimed on its own", async () => {
    const w = await launched(specWithComponents());
    const explorerSdl = () =>
      fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "explorer.yaml"), "utf8");
    const sentryBefore = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(explorerSdl()).toContain(`TS_TUNNEL_1=11317:${sentryBefore.tailnet_ip}:1317`);

    // the sentry moves: its tailnet IP changes, and the explorer's env must
    // follow it (it was tunnelling to the old address)
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, sentryBefore);
    w.services.api.leaseStates.set(sentryBefore.dseq, "closed");
    w.services.ssh.failHosts.add(`${sentryBefore.ssh_host}:${sentryBefore.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");

    const sentryAfter = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(sentryAfter.tailnet_ip).not.toBe(sentryBefore.tailnet_ip);
    expect(explorerSdl()).toContain(`TS_TUNNEL_1=11317:${sentryAfter.tailnet_ip}:1317`);
    expect(explorerSdl()).toContain(`TS_TUNNEL_2=26657:${sentryAfter.tailnet_ip}:26657`);
    expect(explorerSdl()).not.toContain(sentryBefore.tailnet_ip!);

    // and a relaunch never redeploys a stale address: even with the env
    // wound back to a dead IP, the fresh deployment names the current one
    fs.writeFileSync(
      path.join(w.work, "launches", "fl", "sdl", "explorer.yaml"),
      explorerSdl().replaceAll(sentryAfter.tailnet_ip!, "100.64.0.99"),
    );
    const explorerBefore = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, explorerBefore);
    w.services.api.leaseStates.set(explorerBefore.dseq, "closed");
    w.services.ssh.failHosts.add(`${explorerBefore.ssh_host}:${explorerBefore.ssh_port}`);
    expect((await driveOps(w)).status).toBe("completed");

    expect(explorerSdl()).toContain(`TS_TUNNEL_1=11317:${sentryAfter.tailnet_ip}:1317`);
    expect(explorerSdl()).not.toContain("100.64.0.99");
    // the deployed manifest carries it too, not just the on-disk SDL
    expect(
      fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "explorer.manifest.json"), "utf8"),
    ).toContain(`11317:${sentryAfter.tailnet_ip}:1317`);
  }, 120_000);

  it("pauses with a DNS pointer when the relaunched component stays dark", async () => {
    const w = await launched(specWithComponents());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    const launch = w.db.getLaunch("fl")!;
    await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    w.services.rpc.darkUrls.add("explorer.sparkdream.io");

    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toContain("CNAME");
    expect(paused.reason).toContain("explorer.sparkdream.io");

    w.services.rpc.darkUrls.clear();
    const done = await driveOps(w);
    expect(done.status).toBe("completed");
  }, 120_000);
});

describe("rolling upgrade op", () => {
  it("upgrades sentries before validators, one MsgUpdateDeployment each", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.27";
    w.fleet.requestUpgrade(
      launch,
      w.db
        .listFleetComponents("fl")
        .filter((c) => c.key !== "headscale")
        .map((c) => c.key),
      image,
    );
    const sigsBefore = w.signer.signed.length;
    const manifestsBefore = w.services.provider.manifests.length;

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    // 4 components → 4 update txs, in sentry-then-validator order. The op's
    // flat fee rides the FIRST tx only, so it has 2 msgs, the rest 1.
    const upgradeTxs = w.signer.signed.slice(sigsBefore);
    expect(upgradeTxs).toHaveLength(4);
    expect(upgradeTxs.map((msgs) => msgs.length)).toEqual([2, 1, 1, 1]);
    expect(upgradeTxs.every((msgs) => msgs[0]!.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);
    const feeMsg = upgradeTxs[0]![1]!;
    expect(feeMsg.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    // 0.5 ACT at the fake $0.50 oracle price → 1 AKT (uact sends are disabled)
    expect((feeMsg.value as any).amount).toEqual([{ denom: "uakt", amount: "1000000" }]);
    // manifests re-PUT per component
    expect(w.services.provider.manifests.length - manifestsBefore).toBe(4);
    // SDLs carry the new image; components record it
    for (const c of w.db.listFleetComponents("fl").filter((x) => x.key !== "headscale")) {
      expect(c.image).toBe(image);
      const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", `${c.key}.yaml`), "utf8");
      expect(sdl).toContain(`image: ${image}`);
    }
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).images.sparkdreamd).toBe(image);
  }, 120_000);

  it("passes the sentry gate on RPC height progress even when SSH is dead", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    // sshd broken in the new image: the sentry refuses SSH connections,
    // but its RPC keeps answering with progressing heights (FakeRpc)
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    w.services.ssh.failHosts.add(`${sentry.ssh_host}:${sentry.ssh_port}`);
    w.fleet.requestUpgrade(launch, ["sentry-0"], "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28");

    const result = await driveOps(w);
    expect(result.status).toBe("completed");
    expect(w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!.image).toBe(
      "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28",
    );
  }, 120_000);

  it("gates a validator on its in-container RPC, not the SSH port the restart kills", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    // the upgrade restarts the container, so the provider reassigns the
    // forwarded SSH port and the old pgrep-over-SSH probe would hang on the
    // dead port. Model that by failing the validator's recorded SSH endpoint:
    // verify must still pass by reading the node's localhost RPC in-container.
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    w.services.ssh.failHosts.add(`${val.ssh_host}:${val.ssh_port}`);
    w.fleet.requestUpgrade(launch, ["val-0"], "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28");

    const result = await driveOps(w);
    expect(result.status).toBe("completed");
    expect(w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.image).toBe(
      "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28",
    );
  }, 120_000);

  it("fails a validator whose in-container height is stalled after upgrade", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    w.services.provider.stalledDseqs.add(val.dseq);
    const opId = w.fleet.requestUpgrade(
      launch,
      ["val-0"],
      "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28",
    );

    const result = await driveOps(w);
    expect(result.status).toBe("paused");
    expect(result.failedStep).toBe(`op${opId}:val-0:verify`);
    expect(w.db.getStep("fl", `op${opId}:val-0:verify`)!.error).toContain("height is stalled");
  }, 120_000);

  it("retried op skips components already updated on-chain; fee rides the next tx", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28";
    // first attempt lands sentry-0's update on-chain (then imagine an abort)
    w.fleet.requestUpgrade(launch, ["sentry-0"], image);
    const sigs0 = w.signer.signed.length;
    expect((await driveOps(w)).status).toBe("completed");
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const updMsg = w.signer.signed[sigs0]![0]!;
    w.services.api.deploymentHashes.set(sentry.dseq, (updMsg.value as any).hash);

    // retry over the whole node fleet with the same image: sentry-0's tx
    // would be rejected ("invalid: deployment hash") so it must be skipped,
    // and the flat fee rides the first tx that actually happens
    w.fleet.requestUpgrade(launch, ["sentry-0", "sentry-1", "val-0", "val-1"], image);
    const sigs1 = w.signer.signed.length;
    const manifestsBefore = w.services.provider.manifests.length;
    expect((await driveOps(w)).status).toBe("completed");

    const retryTxs = w.signer.signed.slice(sigs1);
    expect(retryTxs).toHaveLength(3); // sentry-1, val-0, val-1 — no sentry-0
    expect(retryTxs.map((msgs) => msgs.length)).toEqual([2, 1, 1]); // fee on sentry-1's
    expect(retryTxs[0]![1]!.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    // manifests still re-sent for all four, skipped component included
    expect(w.services.provider.manifests.length - manifestsBefore).toBe(4);
  }, 120_000);

  it("moves on when the provider already runs the target manifest (identical-PUT 422)", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28";
    // the target manifest already landed on sentry-0's provider on an earlier
    // run: on-chain version matches, and the provider refuses the identical
    // re-PUT with HTTP 422 "manifest version validation failed"
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    w.services.provider.manifestUnchangedDseqs.add(sentry.dseq);

    w.fleet.requestUpgrade(launch, ["sentry-0"], image);
    // the 422 must not wedge the rollout: the step reads it as "already
    // deployed" and records the image, moving on to verify
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!.image).toBe(image);
  }, 120_000);

  it("fails a sentry whose height stalls, reporting the last probe result", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    w.services.rpc.status = async () => ({ latestBlockHeight: 42, catchingUp: false });
    const opId = w.fleet.requestUpgrade(
      launch,
      ["sentry-0"],
      "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.28",
    );

    const result = await driveOps(w);
    expect(result.status).toBe("paused");
    expect(result.failedStep).toBe(`op${opId}:sentry-0:verify`);
    const step = w.db.getStep("fl", `op${opId}:sentry-0:verify`)!;
    expect(step.error).toContain("height is stalled at 42");
  }, 120_000);
});

describe("component upgrade", () => {
  it("swaps the explorer image with an HTTP health gate, no SSH probing", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const image = "sparkdreamnft/sparkdream-explorer:v1.0.6";
    w.fleet.requestUpgrade(launch, ["explorer"], image);
    const sigsBefore = w.signer.signed.length;
    const sshBefore = w.services.ssh.execLog.length;

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const upgradeTxs = w.signer.signed.slice(sigsBefore);
    expect(upgradeTxs).toHaveLength(1);
    expect(upgradeTxs[0]![0]!.typeUrl.includes("MsgUpdateDeployment")).toBe(true);
    // upgrade service fee: flat 0.5 ACT batched into this op's (first) update
    // tx, paid as 1 AKT at the fake $0.50 oracle price
    const feeMsg = upgradeTxs[0]!.at(-1)!;
    expect(feeMsg.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect((feeMsg.value as any).to_address).toBe(
      "akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w",
    );
    expect((feeMsg.value as any).amount).toEqual([{ denom: "uakt", amount: "1000000" }]);
    const explorer = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    expect(explorer.image).toBe(image);
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "explorer.yaml"), "utf8");
    expect(sdl).toContain(`image: ${image}`);
    // upgrading the explorer also (re)injects its chain-identity env, so the
    // env-aware image gets its config without needing a chain reset
    expect(sdl).toContain("CHAIN_DENOM=uspark.sparkdreamtest");
    expect(sdl).toContain("DISPLAY_DENOM=SPARK");
    // verified over HTTP, not pgrep-over-SSH
    expect(w.services.ssh.execLog.length).toBe(sshBefore);
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
    // the stored spec follows the swap — a later chain reset would otherwise
    // reject the (unchanged) editor spec as a frozen-image change
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).images.explorer).toBe(image);
  }, 120_000);
});

describe("domain retarget", () => {
  it("re-points the explorer domain: spec, SDL accept, frontend env, one update tx", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const sigsBefore = w.signer.signed.length;
    const manifestsBefore = w.services.provider.manifests.length;

    w.fleet.requestDomainUpdate(launch, { explorer: "explorer-devnet.sparkdream.io" });

    // the stored spec follows immediately (health checks read it)
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    expect(stored.topology.components.explorer.domain).toBe("explorer-devnet.sparkdream.io");

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    // one batched tx: explorer + frontend (EXPLORER_URL env) updates, no fee
    const retargetTxs = w.signer.signed.slice(sigsBefore);
    expect(retargetTxs).toHaveLength(1);
    expect(retargetTxs[0]!).toHaveLength(2);
    expect(retargetTxs[0]!.every((m) => m.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);
    expect(w.services.provider.manifests.length - manifestsBefore).toBe(2);

    // SDLs carry the new domain
    const explorerSdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "explorer.yaml"), "utf8");
    expect(explorerSdl).toContain("explorer-devnet.sparkdream.io");
    expect(explorerSdl).not.toContain("explorer.sparkdream.io\n");
    const frontendSdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "frontend.yaml"), "utf8");
    expect(frontendSdl).toContain("EXPLORER_URL=https://explorer-devnet.sparkdream.io/sparkdream");
    // the frontend's own accept domain is untouched
    expect(frontendSdl).toContain("app.sparkdream.io");

    expect(w.db.listFleetOps("fl").at(-1)!.status).toBe("done");
  }, 120_000);

  it("re-points public api/rpc: sentry-0 accepts + frontend endpoint env", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestDomainUpdate(launch, {
      api: "api-devnet.sparkdream.io",
      rpc: "rpc-devnet.sparkdream.io",
    });
    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    const sentrySdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "sentry-0.yaml"), "utf8");
    expect(sentrySdl).toContain("api-devnet.sparkdream.io");
    expect(sentrySdl).toContain("rpc-devnet.sparkdream.io");
    const frontendSdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "frontend.yaml"), "utf8");
    expect(frontendSdl).toContain("LCD_ENDPOINT=https://api-devnet.sparkdream.io");
    expect(frontendSdl).toContain("RPC_ENDPOINT=https://rpc-devnet.sparkdream.io");
  }, 120_000);

  it("re-points the explorer route: frontend-only env update", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const sigsBefore = w.signer.signed.length;

    // devnet chains run the stock chain's explorer image, whose ping-pub
    // route is the baked chain name, not network.name
    w.fleet.requestDomainUpdate(launch, { explorerRoute: "sparkdream-main" });
    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    // only the frontend deployment updates
    const txs = w.signer.signed.slice(sigsBefore);
    expect(txs).toHaveLength(1);
    expect(txs[0]!).toHaveLength(1);
    const frontendSdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "frontend.yaml"), "utf8");
    expect(frontendSdl).toContain("EXPLORER_URL=https://explorer.sparkdream.io/sparkdream-main");
    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    expect(stored.topology.components.explorer.route).toBe("sparkdream-main");
  }, 120_000);

  it("rejects adding a public api endpoint the launch never had", async () => {
    const w = await launched(); // spec2x2: no publicEndpoints
    const launch = w.db.getLaunch("fl")!;
    expect(() => w.fleet.requestDomainUpdate(launch, { api: "api.sparkdream.io" })).toThrow(
      /was not part of this launch/,
    );
  }, 120_000);
});

describe("accounts view", () => {
  it("lists generated accounts with addresses, reveals mnemonics per name", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const accounts = w.fleet.accounts(launch);
    expect(accounts.length).toBeGreaterThan(0);
    for (const a of accounts) expect(a.address).toMatch(/^sprkdrm1/);
    // the list carries no seeds, only the flag
    expect(accounts.some((a) => "mnemonic" in a)).toBe(false);
    const generated = accounts.filter((a) => a.hasMnemonic);
    expect(generated.length).toBeGreaterThan(0);
    const m = w.fleet.mnemonic(launch, generated[0]!.name);
    expect(m.trim().split(/\s+/).length).toBeGreaterThanOrEqual(12);
    expect(() => w.fleet.mnemonic(launch, "no-such-account")).toThrow(/no mnemonic/);
  }, 120_000);
});

describe("delete launch", () => {
  it("refuses while deployments are open, then purges records and secrets", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    await expect(w.fleet.deleteLaunch(launch)).rejects.toThrow(/still active/);

    // shut down on-chain, then delete
    for (const c of w.db.listFleetComponents("fl")) {
      w.services.api.leaseStates.set(c.dseq, "closed");
    }
    await w.fleet.deleteLaunch(launch);
    expect(w.db.getLaunch("fl")).toBeUndefined();
    expect(w.db.listFleetComponents("fl")).toHaveLength(0);
    expect(fs.existsSync(path.join(w.work, "launches/fl"))).toBe(false);
  }, 120_000);

  it("purges a stale record that never placed components", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec2x2();
    db.createLaunch("stale", JSON.stringify(s), "akash1owner");
    db.setLaunchStatus("stale", "aborted");
    // a failed attempt still leaves generated keys behind in the work dir
    const secrets = path.join(work, "launches/stale/secrets");
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, "mnemonics.json"), "{}");
    const fleet = new FleetService(db, services, work);
    await fleet.deleteLaunch(db.getLaunch("stale")!);
    expect(db.getLaunch("stale")).toBeUndefined();
    expect(fs.existsSync(path.join(work, "launches/stale"))).toBe(false);
  });
});

describe("top-up", () => {
  it("enqueues an encodable deposit plus the 0.5% fee into the signing loop", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const component = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const { step } = await w.fleet.requestTopUp(launch, component, "2500000");
    const pending = w.db.getPendingTx("fl", step)!;
    const msgs = JSON.parse(pending.msgs_json);
    expect(msgs[0].typeUrl).toBe("/akash.escrow.v1.MsgAccountDeposit");
    // the browser/CLI signer can actually encode it
    const encodeObject = toEncodeObject(msgs[0]);
    expect(encodeObject.value.deposit.amount).toEqual({ denom: "uact", amount: "2500000" });
    // top-up fee: 0.5% of 2,500,000 = 12,500 uact, sent with the deposit as
    // 25,000 uakt at the fake $0.50 oracle price (uact sends are disabled)
    expect(msgs[1].typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect(msgs[1].value.to_address).toBe("akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w");
    expect(msgs[1].value.amount).toEqual([{ denom: "uakt", amount: "25000" }]);
  }, 120_000);
});

describe("pollSsh", () => {
  const ctx = { services: { sleep: async () => {} } } as never;

  it("gives up on the clock, not just the attempt count", async () => {
    // the defect this exists for: a probe against an endpoint that accepts
    // TCP and then says nothing costs ~40s, so 36 attempts "5s apart" runs
    // for twenty-five minutes rather than three
    let attempts = 0;
    const ok = await pollSsh(
      ctx,
      async () => {
        attempts++;
        throw new Error("connect ECONNREFUSED");
      },
      { attempts: 36, deadlineMs: 0 },
    );
    expect(ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("spends all its attempts when the clock allows", async () => {
    let attempts = 0;
    const ok = await pollSsh(ctx, async () => (attempts++, false), { attempts: 7 });
    expect(ok).toBe(false);
    expect(attempts).toBe(7);
  });

  it("stops at the first satisfied probe", async () => {
    let attempts = 0;
    const ok = await pollSsh(ctx, async () => ++attempts === 3, { attempts: 36 });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });
});

describe("chain reset op", () => {
  /**
   * Drive a reset through op:signer — the pause the reset exists around now
   * that the chain-id is kept: it stops between the wipe and the restart so
   * every signer's watermark can be cleared while nothing is able to sign.
   * The gate announces once, so a second drive is the operator's "resume".
   */
  async function driveReset(w: World) {
    const parked = await driveOps(w);
    if (parked.status !== "awaiting-user") return parked;
    return driveOps(w);
  }

  it("rebuilds genesis under the SAME chain-id with edited accounts, wipes and restarts", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const treasuryBefore = w.db.stepOutput<{ accounts: Record<string, string> }>(
      "fl",
      "generate-keys",
    )!.accounts["acct-treasury"]!;

    // spec edits: a new member account joins, gov tuned down
    const edited = JSON.parse(launch.spec_json);
    edited.accounts.initial.push({
      name: "newcomer",
      generate: true,
      amount: "1000000000",
      member: true,
    });
    edited.chainParams = { ...edited.chainParams, gov: { votingPeriod: "600s" } };
    w.fleet.requestChainReset(launch, edited);
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const sigsBefore = w.signer.signed.length;

    const result = await driveReset(w);
    expect(result.status).toBe("completed");
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");

    // stop/start ride the wait-mode env flip: two batched deployment-update
    // txs (nodes exec sparkdreamd as PID 1 after persist-start, so pkill
    // alone would just self-heal), and no service fee — it's not an upgrade
    const txs = w.signer.signed.slice(sigsBefore);
    expect(txs).toHaveLength(2);
    expect(txs.map((msgs) => msgs.length)).toEqual([4, 4]);
    expect(
      txs.every((msgs) => msgs.every((m) => m.typeUrl.includes("MsgUpdateDeployment"))),
    ).toBe(true);
    // the fleet ends back in self-healing mode
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/val-0.yaml"), "utf8");
    expect(sdl).toContain("WAIT_FOR_CONFIG=false");
    expect(sdl).not.toContain("WAIT_FOR_CONFIG=true");

    // every node home carries the rebuilt genesis: same chain-id, new
    // account seeded as a member, spec override applied
    const keys = w.db.stepOutput<{ accounts: Record<string, string> }>("fl", "generate-keys")!;
    const newcomer = keys.accounts["acct-newcomer"]!;
    const founder = keys.accounts["acct-founder"]!;
    for (const key of ["val-0", "val-1", "sentry-0", "sentry-1"]) {
      const g = JSON.parse(
        fs.readFileSync(path.join(w.work, `launches/fl/nodes/${key}/config/genesis.json`), "utf8"),
      );
      expect(g.chain_id).toBe("sparkdream-1");
      expect(g.app_state.gov.params.voting_period).toBe("600s");
      expect(g.app_state.rep.member_map.map((m: any) => m.address)).toEqual([founder, newcomer]);
      expect(g.app_state.bank.balances.some((b: any) => b.address === newcomer)).toBe(true);
      expect(g.app_state.genutil.gen_txs).toHaveLength(2);
    }
    // the keyring was rebuilt: same names, fresh keys
    expect(keys.accounts["acct-treasury"]).toBeDefined();
    expect(keys.accounts["acct-treasury"]).not.toBe(treasuryBefore);
    const view = w.fleet.accounts(w.db.getLaunch("fl")!);
    expect(view.find((a) => a.name === "acct-newcomer")?.hasMnemonic).toBe(true);

    // node side: every node wiped, genesis chain-id fixed in client.toml
    const wipes = w.services.ssh.execLog.filter((e) => e.command.includes("unsafe-reset-all"));
    expect(wipes).toHaveLength(4);
    const seds = w.services.ssh.execLog.filter((e) =>
      e.command.includes('chain-id = "sparkdream-1"'),
    );
    expect(seds).toHaveLength(4);

    // relaunch bundles were re-packed with the new genesis
    const bundled = execFileSync("tar", [
      "xzf",
      path.join(w.work, "launches/fl/bundles/sentry-0.tgz"),
      "-O",
      "config/genesis.json",
    ]).toString();
    expect(JSON.parse(bundled).chain_id).toBe("sparkdream-1");
  }, 120_000);

  it("swaps the node image mid-reset when the reset rides an upgrade", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    // one patch PAST the vendored version: a reset re-validates the spec, and
    // an image older than the vendored reference genesis is refused there. A
    // pinned tag would go stale on the next sync-vendor, which is how this
    // test started failing once the vendor moved to v1.0.31.
    const image = `sparkdreamnft/sparkdreamd-testnet-ssh:${nextChainVersion()}`;
    const edited = JSON.parse(launch.spec_json);
    edited.images = { ...edited.images, sparkdreamd: image };
    w.fleet.requestChainReset(launch, edited);
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const sigsBefore = w.signer.signed.length;

    const result = await driveReset(w);
    expect(result.status).toBe("completed");

    // three signatures: halt flip (4 updates), image swap (4 updates + the
    // flat upgrade fee), resume flip (4 updates)
    const txs = w.signer.signed.slice(sigsBefore);
    expect(txs).toHaveLength(3);
    expect(txs.map((msgs) => msgs.length)).toEqual([4, 5, 4]);
    expect(txs[1]!.slice(0, 4).every((m) => m.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);
    expect(txs[1]![4]!.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    for (const c of w.db.listFleetComponents("fl").filter((x) => x.key !== "headscale")) {
      expect(c.image).toBe(image);
    }
    // container restarts kill the sentry-side tunnels — re-issued after wipe
    const wipeIdx = w.services.ssh.execLog.findIndex((e) =>
      e.command.includes("unsafe-reset-all"),
    );
    const socats = w.services.ssh.execLog
      .slice(wipeIdx)
      .filter((e) => e.command.includes("socat TCP-LISTEN"));
    expect(socats.length).toBeGreaterThanOrEqual(2);
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("re-renders the frontend's chain-identity env on the resume tx", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const edited = JSON.parse(launch.spec_json);
    edited.token.displayDenom = "SPARZ"; // the Keplr suggest-chain coinDenom
    w.fleet.requestChainReset(launch, edited);
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const sigsBefore = w.signer.signed.length;

    const result = await driveReset(w);
    expect(result.status).toBe("completed");

    // resume tx carries the frontend + explorer updates alongside the two
    // node flips
    const txs = w.signer.signed.slice(sigsBefore);
    expect(txs.map((msgs) => msgs.length)).toEqual([2, 4]);
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/frontend.yaml"), "utf8");
    expect(sdl).toContain("DISPLAY_DENOM=SPARZ");
    expect(sdl).toContain("CHAIN_ID=sparkdream-1");
    // the explorer's env is patched in place: new denom identity, but the
    // persist-start-resolved tunnel targets survive (no placeholders back)
    const explorerSdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/explorer.yaml"), "utf8");
    expect(explorerSdl).toContain("DISPLAY_DENOM=SPARZ");
    expect(explorerSdl).toContain("CHAIN_NAME=sparkdream");
    expect(explorerSdl).toContain("DREAM_DENOM=udream.sparkdreamtest");
    expect(explorerSdl).not.toContain("{{TAILNET_IP");
    expect(explorerSdl).not.toContain("{{TS_AUTHKEY");
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("inherits deployed images when the reset spec omits them", async () => {
    const w = await launched(specWithComponents());
    const launch0 = w.db.getLaunch("fl")!;
    w.fleet.requestUpgrade(launch0, ["explorer"], "sparkdreamnft/sparkdream-explorer:v1.0.7");
    expect((await driveOps(w)).status).toBe("completed");

    // editor-style spec: the user never pinned images, so the raw input
    // omits them — the resolved profile default (an older explorer tag)
    // must not read as an image change and reject the reset
    const launch = w.db.getLaunch("fl")!;
    const nodeImage = JSON.parse(launch.spec_json).images.sparkdreamd;
    const edited = JSON.parse(launch.spec_json);
    delete edited.images;
    const opId = w.fleet.requestChainReset(launch, edited);

    const stored = JSON.parse(w.db.getLaunch("fl")!.spec_json);
    expect(stored.images.explorer).toBe("sparkdreamnft/sparkdream-explorer:v1.0.7");
    expect(stored.images.sparkdreamd).toBe(nodeImage);
    // and no unintended node-image swap rides the reset
    const op = w.db.listFleetOps("fl").find((o) => o.id === opId)!;
    expect(JSON.parse(op.params_json).image).toBeUndefined();
  }, 120_000);

  it("stops between the wipe and the restart for signer state to be cleared", async () => {
    // the chain-id is kept, so the watermark is the only thing separating
    // the discarded chain from the new one: nothing may restart until the
    // operator has zeroed every signer that votes on this chain-id
    const w = await launched(tmkms1x1());
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const opId = w.db.listFleetOps("fl")[0]!.id;

    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:signer`);
    // it names the chain-id that did NOT move, and what to do about it
    expect(parked.reason).toContain("sparkdream-1");
    expect(parked.reason).toContain("tmkms state file");
    expect(parked.reason).toContain("double-sign");
    // the pause lands after the wipe (nothing left to sign for)...
    expect(
      w.services.ssh.execLog.some((e) => e.command.includes("unsafe-reset-all")),
    ).toBe(true);
    // ...and before any node is let out of wait mode
    expect(
      fs.readFileSync(path.join(w.work, "launches/fl/sdl/val-0.yaml"), "utf8"),
    ).toContain("WAIT_FOR_CONFIG=true");

    const done = await driveOps(w); // operator cleared the signer, resumed
    expect(done.status).toBe("completed");
    expect(
      fs.readFileSync(path.join(w.work, "launches/fl/sdl/val-0.yaml"), "utf8"),
    ).toContain("WAIT_FOR_CONFIG=false");
  }, 120_000);

  it("gates a softsign fleet too, for validators it does not own", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));

    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    // its own nodes were wiped with the data; the warning is about the rest
    expect(parked.reason).toContain("priv_validator_state.json is already zeroed");
    expect(parked.reason).toContain("outside this fleet");
  }, 120_000);

  it("refuses to move the chain-id, however the spec asks", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const edited = JSON.parse(launch.spec_json);
    edited.network.chainIdSuffix = 7;
    expect(() => w.fleet.requestChainReset(launch, edited)).toThrow(/chainIdSuffix/);
    // and an untouched spec resets in place, still as sparkdream-1
    const opId = w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).network.chainIdSuffix).toBe(1);
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.kind).toBe("reset-chain");
  }, 120_000);

  it("re-reads the SSH endpoints the restarts moved, instead of probing dead ports", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const nodeRows = () =>
      w.db.listFleetComponents("fl").filter((c) => /^(val|sentry)-/.test(c.key));
    const live = new Map(nodeRows().map((c) => [c.key, `${c.ssh_host}:${c.ssh_port}`]));

    // a wait-mode flip re-creates every container, and the provider hands a
    // re-created container a different external port for 2222 — so the rows
    // end up pointing at ports nothing listens on, which is worse than a
    // refused connection: they accept TCP and then go quiet
    const dead: string[] = [];
    for (const c of nodeRows()) {
      const port = c.ssh_port! + 9000;
      w.db.updateComponentRuntime("fl", c.key, { ssh_port: port });
      const id = `${c.ssh_host}:${port}`;
      w.services.ssh.failHosts.add(id);
      dead.push(id);
    }

    w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    expect((await driveReset(w)).status).toBe("completed");

    // the rows are back on the provider's actual mapping...
    expect(new Map(nodeRows().map((c) => [c.key, `${c.ssh_host}:${c.ssh_port}`]))).toEqual(live);
    // ...and the reset never burned a probe on a port known to be dead
    expect(w.services.ssh.execLog.some((e) => dead.includes(e.target))).toBe(false);
  }, 120_000);

  it("takes block production as proof the resume worked when SSH stays quiet", async () => {
    // the live shape: the chain came back and produced blocks for ten
    // minutes while op:start failed a fleet over two unanswering ports
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const opId = w.db.listFleetOps("fl")[0]!.id;

    await driveOps(w); // park at the signer gate, then go quiet over SSH
    for (const c of w.db.listFleetComponents("fl")) {
      if (/^(val|sentry)-/.test(c.key)) w.services.ssh.failHosts.add(`${c.ssh_host}:${c.ssh_port}`);
    }
    await driveOps(w);

    // op:start did not fail the reset: it asked the chain instead
    const start = w.db
      .listSteps("fl")
      .find((st) => st.name === `op${opId}:start`)!;
    expect(start.status).toBe("done");
    const out = JSON.parse(start.output_json!) as { resumed: string[]; silent?: string[] };
    expect(out.silent?.sort()).toEqual(["sentry-0", "sentry-1", "val-0", "val-1"]);
  }, 120_000);

  it("rejects edits the deployed fleet embodies, naming all of them at once", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const edited = JSON.parse(launch.spec_json);
    edited.topology.sentries.count = 3;
    expect(() => w.fleet.requestChainReset(launch, edited)).toThrow(/sentries\.count/);
    // a second violation behind the first is reported with it: fixing them
    // one rejection at a time is the slowest way to learn what a reset moves
    edited.network.type = edited.network.type === "devnet" ? "testnet" : "devnet";
    edited.infra.akashNetwork = "sandbox";
    try {
      w.fleet.requestChainReset(launch, edited);
      throw new Error("expected the reset to be rejected");
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("network.type");
      expect(msg).toContain("topology.sentries.count");
      expect(msg).toContain("infra");
    }
  }, 120_000);

  it("rejects denoms the chain's identity module would refuse, before touching anything", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const edited = JSON.parse(launch.spec_json);
    edited.token.baseDenom = "usparkz.sparkdreamtest"; // six letters after the u
    const execsBefore = w.services.ssh.execLog.length;
    expect(() => w.fleet.requestChainReset(launch, edited)).toThrow(/bond denom rule/);
    // nothing stored, no op created, no node touched
    expect(JSON.parse(w.db.getLaunch("fl")!.spec_json).token.baseDenom).toBe(
      "uspark.sparkdreamtest",
    );
    expect(w.db.listFleetOps("fl")).toHaveLength(0);
    expect(w.services.ssh.execLog.length).toBe(execsBefore);
  }, 120_000);
});

describe("unjail op", () => {
  /** CLI stub standing in for the chain: jailed until an unjail tx lands. */
  function stubSparkdreamd(): { bin: string; dir: string } {
    const dir = tmp();
    const bin = path.join(dir, "sparkdreamd");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
dir=$(dirname "$0")
case "$1 $2" in
  "query staking")
    if [ -f "$dir/unjailed" ]; then jailed=false; else jailed=true; fi
    echo "{\\"validator\\":{\\"jailed\\":$jailed,\\"status\\":\\"BOND_STATUS_BONDED\\"}}"
    ;;
  "tx slashing")
    echo "$@" >> "$dir/broadcasts"
    touch "$dir/unjailed"
    echo '{"txhash":"STUBHASH","code":0}'
    ;;
  "tx broadcast")
    echo "$@" >> "$dir/broadcasts"
    touch "$dir/unjailed"
    echo '{"txhash":"STUBHASH","code":0}'
    ;;
  "query auth")
    echo '{"account":{"account_number":"7","sequence":"3"}}'
    ;;
  "query tx")
    echo '{"code":0}'
    ;;
  *)
    echo '{}'
    ;;
esac
`,
    );
    fs.chmodSync(bin, 0o755);
    return { bin, dir };
  }

  it("gates on sync, broadcasts MsgUnjail from the operator key, verifies re-bonding", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const opId = w.fleet.requestUnjail(launch, val);

    const stub = stubSparkdreamd();
    const prev = process.env.SPARKDREAMD_BIN;
    process.env.SPARKDREAMD_BIN = stub.bin;
    try {
      const result = await driveOps(w);
      expect(result.status).toBe("completed");
    } finally {
      if (prev === undefined) delete process.env.SPARKDREAMD_BIN;
      else process.env.SPARKDREAMD_BIN = prev;
    }

    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.db.stepOutput<any>("fl", `op${opId}:unjail`)!.txhash).toBe("STUBHASH");
    expect(w.db.stepOutput<any>("fl", `op${opId}:verify`)!.unjailed).toBe(true);
    // the tx was signed by the conductor-held operator key, not the wallet
    const broadcast = fs.readFileSync(path.join(stub.dir, "broadcasts"), "utf8");
    expect(broadcast).toContain("--from op-val-0");
    expect(broadcast).toContain("--keyring-backend test");
  }, 120_000);

  it("no-ops cleanly when the validator is not jailed", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-1")!;
    const opId = w.fleet.requestUnjail(launch, val);

    const stub = stubSparkdreamd();
    fs.writeFileSync(path.join(stub.dir, "unjailed"), ""); // already unjailed
    const prev = process.env.SPARKDREAMD_BIN;
    process.env.SPARKDREAMD_BIN = stub.bin;
    try {
      const result = await driveOps(w);
      expect(result.status).toBe("completed");
    } finally {
      if (prev === undefined) delete process.env.SPARKDREAMD_BIN;
      else process.env.SPARKDREAMD_BIN = prev;
    }
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.db.stepOutput<any>("fl", `op${opId}:unjail`)!.alreadyUnjailed).toBe(true);
    expect(fs.existsSync(path.join(stub.dir, "broadcasts"))).toBe(false);
  }, 120_000);

  it("refuses non-validators and doubled-up ops", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    expect(() => w.fleet.requestUnjail(launch, sentry)).toThrow(/applies to validators/);

    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const opId = w.fleet.requestUnjail(launch, val);
    expect(() => w.fleet.requestUnjail(launch, val)).toThrow(new RegExp(`#${opId}`));
  }, 120_000);

  it("external operator: wallet signs MsgUnjail through the gentx loop, tx assembled and broadcast", async () => {
    // the "wallet" signs with cosmjs but answers in Keplr's response shape
    // (key-sorted signed doc — see keplrSignAmino in fakes)
    const wallet = await Secp256k1HdWallet.fromMnemonic(
      "surround miss nominee dream gap cross assault thank captain prosper drop duty group candy wealth weather scale put",
      { prefix: "sprkdrm" },
    );
    const [account] = await wallet.getAccounts();
    const address = account!.address;
    const gentxSigner: GentxSigner = {
      async signGentx(signDocJson: string): Promise<string> {
        return keplrSignAmino(wallet, address, signDocJson);
      },
    };
    const s = testnetSpec({
      network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
      topology: {
        validators: { count: 1, operators: [address] },
        sentries: { count: 1 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const w = await launched(s, gentxSigner);
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const opId = w.fleet.requestUnjail(launch, val);

    // the genesis gentx left a SIGNED create-validator row for valIndex 0 —
    // the op must serve the wallet a fresh unjail doc, not replay that one
    expect(w.db.getPendingGentx("fl", 0)?.status).toBe("signed");

    const stub = stubSparkdreamd();
    const prev = process.env.SPARKDREAMD_BIN;
    process.env.SPARKDREAMD_BIN = stub.bin;
    try {
      const result = await driveOps(w);
      expect(result.status).toBe("completed");
    } finally {
      if (prev === undefined) delete process.env.SPARKDREAMD_BIN;
      else process.env.SPARKDREAMD_BIN = prev;
    }

    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.db.stepOutput<any>("fl", `op${opId}:unjail`)!.txhash).toBe("STUBHASH");
    // the broadcast tx file carries a proto-JSON MsgUnjail signed amino-mode
    // by the operator's wallet, with the live account sequence from the stub
    const txFile = path.join(w.work, "launches", "fl", `op${opId}-unjail.signed.json`);
    const tx = JSON.parse(fs.readFileSync(txFile, "utf8"));
    expect(tx.body.messages[0]["@type"]).toBe("/cosmos.slashing.v1beta1.MsgUnjail");
    expect(tx.body.messages[0].validator_addr).toMatch(/^sprkdrmvaloper1/);
    expect(tx.auth_info.signer_infos[0].mode_info.single.mode).toBe("SIGN_MODE_LEGACY_AMINO_JSON");
    expect(tx.auth_info.signer_infos[0].sequence).toBe("3");
    expect(fs.readFileSync(path.join(stub.dir, "broadcasts"), "utf8")).toContain("tx broadcast");
    // and the signed doc the wallet saw was the unjail one (amino field "address")
    const row = w.db.getPendingGentx("fl", 0)!;
    const doc = JSON.parse(row.sign_doc_json);
    expect(doc.msgs[0].type).toBe("cosmos-sdk/MsgUnjail");
    expect(doc.msgs[0].value.address).toBe(tx.body.messages[0].validator_addr);
  }, 120_000);
});

describe("resume-signing op", () => {
  function tmkmsSpec(): LaunchSpec {
    return testnetSpec({
      network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
      security: { keyMode: "tmkms" },
      providers: { policy: { antiAffinity: "strict" } },
      topology: {
        validators: { count: 2 },
        sentries: { count: 2 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
  }

  /** CLI stub standing in for the chain: signing-info offset advances per
   *  query while the `signing` file exists; `jailed` file flips the staking
   *  answer (the post-stall downtime jail). */
  function stubSparkdreamd(opts: { jailed?: boolean } = {}): { bin: string; dir: string } {
    const dir = tmp();
    if (opts.jailed) fs.writeFileSync(path.join(dir, "jailed"), "");
    fs.writeFileSync(path.join(dir, "signing"), "");
    const bin = path.join(dir, "sparkdreamd");
    fs.writeFileSync(
      bin,
      `#!/bin/sh
dir=$(dirname "$0")
case "$1 $2" in
  "query staking")
    if [ -f "$dir/jailed" ]; then j=true; else j=false; fi
    echo "{\\"validator\\":{\\"jailed\\":$j,\\"status\\":\\"BOND_STATUS_BONDED\\"}}"
    ;;
  "query slashing")
    n=0; [ -f "$dir/offset" ] && n=$(cat "$dir/offset")
    if [ -f "$dir/signing" ]; then n=$((n+1)); fi
    echo "$n" > "$dir/offset"
    echo "{\\"val_signing_info\\":{\\"index_offset\\":\\"$n\\",\\"missed_blocks_counter\\":\\"0\\"}}"
    ;;
  *)
    echo '{}'
    ;;
esac
`,
    );
    fs.chmodSync(bin, 0o755);
    return { bin, dir };
  }

  async function withStub<T>(opts: { jailed?: boolean }, fn: () => Promise<T>): Promise<T> {
    const stub = stubSparkdreamd(opts);
    const prev = process.env.SPARKDREAMD_BIN;
    process.env.SPARKDREAMD_BIN = stub.bin;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.SPARKDREAMD_BIN;
      else process.env.SPARKDREAMD_BIN = prev;
    }
  }

  it("gates on the signer session, restarts in place, verifies signing", async () => {
    // the live shape: signer box down (session dropped) → user fixes it →
    // one click gates, bounces the process, and proves blocks get signed —
    // all without a manifest change (the out-of-band bounce this replaces
    // drifted the on-chain hash and 422'd every later manifest send)
    const w = await launched(tmkmsSpec());
    w.services.ssh.signerConnected = false;
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const sigsBefore = w.signer.signed.length;
    const opId = w.fleet.requestResumeSigning(launch, val);

    await withStub({}, async () => {
      const parked = await driveOps(w);
      expect(parked.status).toBe("awaiting-user");
      expect(parked.failedStep).toBe(`op${opId}:await-signer`);
      // no restart while the signer is down
      expect(
        w.services.ssh.execLog.some((e) => e.command.includes("pkill -x sparkdreamd")),
      ).toBe(false);

      // user brings the signer back, resumes
      w.services.ssh.signerConnected = true;
      const done = await driveOps(w);
      expect(done.status).toBe("completed");
    });

    // the process was bounced in place, and NOT through a deployment change:
    // the op signs no tx of any kind
    const valId = `${val.ssh_host}:${val.ssh_port}`;
    expect(w.services.ssh.started.has(valId)).toBe(true);
    expect(
      w.services.ssh.execLog.some(
        (e) => e.target === valId && e.command.includes("pkill -x sparkdreamd"),
      ),
    ).toBe(true);
    expect(w.signer.signed.length).toBe(sigsBefore);
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.db.stepOutput<any>("fl", `op${opId}:verify`)!.signing).toBe(true);
  }, 120_000);

  it("completes with unjail guidance when the stall downtime-jailed the validator", async () => {
    const w = await launched(tmkmsSpec());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const opId = w.fleet.requestResumeSigning(launch, val);

    const result = await withStub({ jailed: true }, () => driveOps(w));
    expect(result.status).toBe("completed");
    // a jailed validator cannot be resumed by a restart: the op says so and
    // finishes instead of failing (recovery is the unjail op's sync gate)
    expect(w.db.stepOutput<any>("fl", `op${opId}:verify`)!.jailed).toBe(true);
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
  }, 120_000);

  it("refuses non-validators, softsign fleets, and doubled-up ops", async () => {
    const w = await launched(tmkmsSpec());
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    expect(() => w.fleet.requestResumeSigning(launch, sentry)).toThrow(/validators/);
    w.fleet.requestResumeSigning(launch, val);
    expect(() => w.fleet.requestResumeSigning(launch, val)).toThrow(/already in progress/);

    const soft = await launched(); // spec2x2 is softsign
    const softVal = soft.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    expect(() => soft.fleet.requestResumeSigning(soft.db.getLaunch("fl")!, softVal)).toThrow(
      /softsign/,
    );
    w.db.close();
    soft.db.close();
  }, 240_000);
});

describe("headscale relaunch op", () => {
  function tmkmsSpec1(): LaunchSpec {
    return testnetSpec({
      network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
      security: { keyMode: "tmkms" },
      providers: { policy: { antiAffinity: "strict" } },
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
  }

  it("re-keys the mesh: new placement, fresh preauth keys pushed, trackers refreshed", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "headscale")!;
    const launchKeys = w.db.stepOutput<{ perNode: Record<string, string>; home: string }>(
      "fl",
      "configure-headscale",
    )!;
    const launchMesh = w.db.stepOutput<{ ips: Record<string, string> }>("fl", "await-mesh")!;

    const opId = await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    // the fresh mesh allocates fresh IPs, and validators still reference the old
    w.services.ssh.remapTailnetIps();
    w.services.ssh.configHasStaleIp = true;

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    // headscale moved to a new provider + dseq, avoiding the old one
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "headscale")!;
    expect(after.state).toBe("active");
    expect(after.dseq).not.toBe(before.dseq);
    expect(after.provider).not.toBe(before.provider);
    expect(after.generation).toBe(before.generation + 1);

    // fresh preauth keys minted on the new server; trackers refreshed
    const keys = w.db.stepOutput<{ perNode: Record<string, string>; home: string }>(
      "fl",
      "configure-headscale",
    )!;
    expect(keys.home).not.toBe(launchKeys.home);
    for (const k of ["val-0", "sentry-0", "explorer"]) {
      expect(keys.perNode[k]).toBeDefined();
      expect(keys.perNode[k]).not.toBe(launchKeys.perNode[k]);
      const sdl = fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", `${k}.yaml`), "utf8");
      expect(sdl).toContain(`TS_AUTHKEY=${keys.perNode[k]}`);
    }

    // deploy-headscale output points at the new lease
    const hs = w.db.stepOutput<{ dseq: string; hostUri: string }>("fl", "deploy-headscale")!;
    expect(hs.dseq).toBe(after.dseq);
    expect(hs.hostUri).toBe(after.host_uri);

    // fresh mesh IPs in rows + await-mesh output, env references rewritten
    const mesh = w.db.stepOutput<{ ips: Record<string, string> }>("fl", "await-mesh")!;
    for (const k of ["val-0", "sentry-0", "explorer"]) {
      expect(mesh.ips[k]).toBeDefined();
      expect(mesh.ips[k]).not.toBe(launchMesh.ips[k]);
      expect(w.db.listFleetComponents("fl").find((c) => c.key === k)!.tailnet_ip).toBe(mesh.ips[k]);
    }
    const explorerSdl = fs.readFileSync(
      path.join(w.work, "launches", "fl", "sdl", "explorer.yaml"),
      "utf8",
    );
    expect(explorerSdl).not.toContain(launchMesh.ips["sentry-0"]!);
    expect(explorerSdl).toContain(mesh.ips["sentry-0"]!);

    // validator config re-patched over SSH: one sed that maps old→token→new,
    // so a swapped pair cannot fold both peers onto one address. The match
    // pattern escapes its dots; the replacement is the literal new address.
    const escapedOldSentry = launchMesh.ips["sentry-0"]!.replace(/\./g, "\\.");
    expect(
      w.services.ssh.execLog.some(
        (e) =>
          e.command.includes("sed -i") &&
          e.command.includes(escapedOldSentry) &&
          e.command.includes(mesh.ips["sentry-0"]!),
      ),
    ).toBe(true);

    // frontend is not meshed: untouched by the re-key
    const frontendSdl = fs.readFileSync(
      path.join(w.work, "launches", "fl", "sdl", "frontend.yaml"),
      "utf8",
    );
    expect(frontendSdl).not.toContain("TS_AUTHKEY=");

    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    w.db.close();
  }, 240_000);

  it("tmkms fleets park at the signer gate with the new home key and validator addrs", async () => {
    const w = await launched(tmkmsSpec1());
    const launch = w.db.getLaunch("fl")!;
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "headscale")!;
    const opId = await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.remapTailnetIps();
    w.services.ssh.signerConnected = false;

    const paused = await driveOps(w);
    expect(paused.status).toBe("awaiting-user");
    const waiting = w.db.getStep("fl", `op${opId}:signer`)!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.error).toContain("re-join your tmkms signer machine");
    expect(waiting.error).toContain("--authkey=hskey-");
    expect(waiting.error).toContain(":26659");

    // signer returns: the op completes
    w.services.ssh.signerConnected = true;
    const result = await driveOps(w);
    expect(result.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    w.db.close();
  }, 240_000);
});

describe("repair op", () => {
  it("re-reads live addresses the launcher never saw, then re-aims env and peers at them", async () => {
    // The live shape: the fleet moved onto new tailnet addresses with the
    // launcher not watching (a mesh re-key, containers bounced by hand in
    // another console). Its records are stale, so every link it could repair
    // from them would be repaired to the WRONG address — the op has to ask
    // the boxes where they are before it fixes anything.
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const sentryId = `${sentry.ssh_host}:${sentry.ssh_port}`;
    const valId = `${val.ssh_host}:${val.ssh_port}`;
    const nodeIds = w.db.stepOutput<{ nodeIds: Record<string, string> }>("fl", "generate-keys")!
      .nodeIds;
    const before = Object.fromEntries(
      w.db.listFleetComponents("fl").map((c) => [c.key, c.tailnet_ip]),
    );
    // the validator's peers name the sentry's pre-re-key address; the sentry
    // reaches its validator through a loopback tunnel, as it always does
    w.services.ssh.configPeers.set(valId, `${nodeIds["sentry-0"]}@${before["sentry-0"]}:26656`);
    w.services.ssh.configPeers.set(
      sentryId,
      `${nodeIds["val-0"]}@127.0.0.1:27000,${nodeIds["sentry-0"]}@${before["sentry-0"]}:26656`,
    );
    w.services.ssh.remapTailnetIps(); // every box comes back on a new address
    const sigsBefore = w.signer.signed.length;

    w.fleet.requestRepair(launch, val);
    expect((await driveOps(w)).status).toBe("completed");

    // the launcher's own record is corrected from the live boxes first
    const after = Object.fromEntries(
      w.db.listFleetComponents("fl").map((c) => [c.key, c.tailnet_ip]),
    );
    expect(after["val-0"]).not.toBe(before["val-0"]);
    expect(after["sentry-0"]).not.toBe(before["sentry-0"]);
    // and with it the await-mesh table the tmkms panel and relaunches read
    const mesh = w.db.stepOutput<{ ips: Record<string, string> }>("fl", "await-mesh")!;
    expect(mesh.ips["val-0"]).toBe(after["val-0"]);

    // env: the sentry's tunnel to the validator, and the explorer's to the
    // sentry, both name the live addresses — not the ones on record before
    const sentrySdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "sentry-0.yaml"), "utf8");
    expect(sentrySdl).toContain(`${after["val-0"]}:26656`);
    const explorerSdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "explorer.yaml"), "utf8");
    expect(explorerSdl).toContain(after["sentry-0"]);
    // one batched update tx for the deployments that changed, no redeploy
    expect(w.signer.signed.length).toBe(sigsBefore + 1);

    // peers: the validator's stale entry is repaired in place...
    expect(w.services.ssh.configPeers.get(valId)).toBe(
      `${nodeIds["sentry-0"]}@${after["sentry-0"]}:26656`,
    );
    // ...and the sentry's loopback tunnel entry is left exactly alone —
    // rewriting 127.0.0.1 to a tailnet IP would undo the tunnel design
    expect(w.services.ssh.configPeers.get(sentryId)).toContain(`${nodeIds["val-0"]}@127.0.0.1:27000`);
    expect(w.services.ssh.configPeers.get(sentryId)).toContain(`${after["sentry-0"]}:26656`);
    w.db.close();
  }, 120_000);

  it("re-reads SSH endpoints from the providers before reaching for anything", async () => {
    // The Console Air case: containers recycled outside the launcher come
    // back on provider-assigned forwarded ports the launcher never saw. Its
    // recorded endpoints then answer nothing, every later pass reads the box
    // as unreachable, and repair could neither touch nor fix it — so the
    // endpoint mapping is re-read from lease status before anything else.
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const before = Object.fromEntries(
      w.db.listFleetComponents("fl").map((c) => [c.key, c.ssh_port]),
    );
    w.services.provider.remapForwardedPorts();

    w.fleet.requestRepair(launch, val);
    expect((await driveOps(w)).status).toBe("completed");

    const after = w.db.listFleetComponents("fl").filter((c) => c.ssh_port !== null);
    expect(after.length).toBeGreaterThan(0);
    for (const c of after) expect(c.ssh_port).not.toBe(before[c.key]);
    w.db.close();
  }, 120_000);

  it("runs while a launch step is failing — the state it exists to fix", async () => {
    // Seen live: a launch parked at verify-chain because the fleet was
    // dialling dead mesh addresses (no gossip, no blocks, nothing to
    // verify), the operator clicked repair, and the op sat with no step rows
    // at all — op steps compose AFTER the launch's, so the failing step it
    // was meant to cure blocked it forever. The spinner on screen was the
    // LAUNCH's step, which reads exactly like a repair that is working.
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    w.services.ssh.remapTailnetIps(); // the drift that stopped the chain
    const opId = w.fleet.requestRepair(launch, val);

    const stuck: StepDef = {
      name: "verify-chain-stuck",
      async run() {
        throw new Error("sentry-0: chain not verified after ~5 min — height not increasing");
      },
    };
    const steps = [
      ...buildPreLaunchOpSteps(w.db, "fl"),
      ...allSteps(),
      stuck,
      ...buildOpSteps(w.db, "fl"),
    ];
    const r = await runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer);
    expect(r.failedStep).toBe("verify-chain-stuck");
    // the repair ran regardless, ahead of the step it exists to unblock
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.db.getStep("fl", `op${opId}:peers`)!.status).toBe("done");
    w.db.close();
  }, 120_000);

  it("keeps the recorded address of a component that cannot say where it is", async () => {
    // an unreachable box is not evidence its address changed: erasing the
    // record would strand every link that still, correctly, names it
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const recorded = val.tailnet_ip;
    w.services.ssh.failHosts.add(`${val.ssh_host}:${val.ssh_port}`);

    w.fleet.requestRepair(launch, val);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip).toBe(recorded);
    w.db.close();
  }, 120_000);

  it("is a no-op when every address is already current", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const sigsBefore = w.signer.signed.length;

    w.fleet.requestRepair(launch, val);
    expect((await driveOps(w)).status).toBe("completed");
    // nothing stale: no update tx, and no component restarted for nothing
    expect(w.signer.signed.length).toBe(sigsBefore);
    expect(() => w.fleet.requestRepair(launch, val)).not.toThrow();
    w.db.close();
  }, 120_000);

  it("re-pushes a component whose deployment fell behind the launcher's manifest", async () => {
    // The live shape: an op moved the chain to a new manifest and was then
    // re-run into an EARLIER hash, so the tunnel target on disk is right while
    // the container still serves the old env. Nothing in the SDL needs
    // changing, so a repair that only reacted to text drift walked past it —
    // and the sentry sat peering with its own address, not syncing.
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const sigsBefore = w.signer.signed.length;

    // the chain reports a version this launcher never produced, while every
    // tunnel target on disk is already correct
    const stale = "c3RhbGUtdmVyc2lvbi1ub2JvZHktc2lnbmVkLW5vdz0=";
    w.services.api.deploymentHashes.set(sentry.dseq, stale);
    // a confirmed update moves the on-chain version, which is what lets the
    // provider's version check accept the PUT that follows it
    w.signer.onSigned = (msgs) => {
      for (const m of msgs) {
        if (m.typeUrl === TypeUrl.UpdateDeployment) {
          w.services.api.deploymentHashes.set(String((m.value as any).id.dseq), (m.value as any).hash);
        }
      }
    };

    w.fleet.requestRepair(launch, sentry);
    expect((await driveOps(w)).status).toBe("completed");

    // the manifest actually reached the provider — the point of the step.
    // It must survive the signature pause: the tx moves the chain, so on the
    // re-run the component reads as settled, and a push gated on "changed
    // this run" would skip the very component that needed it.
    expect(w.services.provider.manifests.some((x) => x.dseq === sentry.dseq)).toBe(true);

    // and moved the on-chain version onto the manifest it pushed
    const upd = w.signer.signed
      .slice(sigsBefore)
      .flat()
      .find(
        (m) => m.typeUrl === TypeUrl.UpdateDeployment && String((m.value as any).id.dseq) === sentry.dseq,
      );
    expect(upd).toBeDefined();
    expect((upd!.value as any).hash).not.toBe(stale);
    w.db.close();
  }, 120_000);
});

describe("restore-from-archive op", () => {
  it("unpacks an uploaded tarball, replays with the node stopped, restarts it", async () => {
    // the live shape: the operator uploads block archives with the fleet
    // view's upload button (they hold no SSH key), clicks restore, and the
    // launcher runs the hours-long replay detached — the output that kills
    // a console never crosses the wire
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const valId = `${val.ssh_host}:${val.ssh_port}`;
    const opId = w.fleet.requestRestoreArchive(launch, val);

    // nothing uploaded yet: the op parks asking for the archives instead of
    // replaying an empty directory
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:find-archive`);
    expect(w.services.ssh.execLog.some((e) => e.command.includes("pkill -x sparkdreamd"))).toBe(
      false,
    );

    w.services.ssh.archiveTarballs.add(valId); // operator uploads the archive
    const done = await driveOps(w);
    expect(done.status).toBe("completed");

    const log = w.services.ssh.execLog.filter((e) => e.target === valId).map((e) => e.command);
    const stopAt = log.findIndex((c) => c.includes("pkill -x sparkdreamd"));
    const replayAt = log.findIndex((c) => c.includes("replay-from-archive --home"));
    // the launch itself started the node earlier — the restart is the last one
    const startAt = log.findLastIndex((c) => c.includes("sparkdreamd start"));
    // the replay opens the node's databases: it only runs between the stop
    // and the restart
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(replayAt).toBeGreaterThan(stopAt);
    expect(startAt).toBeGreaterThan(replayAt);
    expect(log[replayAt]).toContain("--archive-dir /root/.sparkdream/archives");
    expect(log[replayAt]).toContain("--validate true");
    // detached, with the output parked in a file on the node
    expect(log[replayAt]).toContain("nohup");
    expect(log[replayAt]).toContain("/root/.sparkdream/replay-archive.log");
    expect(w.services.ssh.started.has(valId)).toBe(true);
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    w.db.close();
  }, 120_000);

  it("publishes how far the replay has got, and clears it once the node is back", async () => {
    // a replay runs for hours: the step log alone (one line per two minutes)
    // cannot say how far along it is, so the op carries a live position the
    // fleet view reads. The target height comes from the archive file names.
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const id = `${sentry.ssh_host}:${sentry.ssh_port}`;
    w.services.ssh.archiveFiles.set(id, 4); // blocks 1..4000
    w.services.ssh.replayExit = 1; // stop mid-flight so the position survives
    const opId = w.fleet.requestRestoreArchive(launch, sentry);

    expect((await driveOps(w)).status).toBe("paused");
    const op = () => w.db.listFleetOps("fl").find((o) => o.id === opId)!;
    const progress = JSON.parse(op().progress_json!);
    expect(progress.target).toBe(4000);
    expect(progress.current).toBe(2000);
    expect(progress.percent).toBe(50);
    // rate is measured between samples of THIS run, so a re-attach to a
    // replay already hours in does not read as impossibly fast
    expect(progress.rate).toBeGreaterThan(0);
    expect(progress.etaSeconds).toBeGreaterThan(0);
    expect(progress.label).toContain("sentry-0");

    // it finishes on a re-run: the position goes away with the op
    w.services.ssh.replayExit = 0;
    expect((await driveOps(w)).status).toBe("completed");
    expect(op().status).toBe("done");
    expect(op().progress_json).toBeNull();
    w.db.close();
  }, 120_000);

  it("fails with the replay's own output when it exits non-zero", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    w.services.ssh.archiveFiles.set(`${sentry.ssh_host}:${sentry.ssh_port}`, 4);
    w.services.ssh.replayExit = 1;
    const opId = w.fleet.requestRestoreArchive(launch, sentry);

    const failed = await driveOps(w);
    expect(failed.status).toBe("paused");
    expect(failed.failedStep).toBe(`op${opId}:replay`);
    // the node stays stopped: restarting it on a half-replayed database is
    // the operator's call (re-running restore resumes the replay)
    expect(w.services.ssh.started.has(`${sentry.ssh_host}:${sentry.ssh_port}`)).toBe(false);
    w.db.close();
  }, 120_000);

  it("warns before stopping a validator, and refuses non-nodes and doubled-up ops", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    // a validator is down for the whole replay — signing nothing, jailable
    expect(w.fleet.restoreArchiveWarnings(launch, val)[0]).toMatch(/downtime-jailed/);
    expect(w.fleet.restoreArchiveWarnings(launch, sentry)).toEqual([]);

    w.fleet.requestRestoreArchive(launch, val);
    expect(() => w.fleet.requestRestoreArchive(launch, val)).toThrow(/already in progress/);
    // a second node can restore at the same time
    expect(() => w.fleet.requestRestoreArchive(launch, sentry)).not.toThrow();
    w.db.close();
  }, 120_000);

  it("runs while a launch step is failing — the state it exists to fix", async () => {
    // Seen live: a launch parked at verify-chain ("height not increasing")
    // because the node had no block history, the operator clicked restore,
    // and the op sat with no steps at all — op steps compose AFTER the
    // launch's, so the failing step it was meant to cure blocked it forever.
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    w.services.ssh.archiveFiles.set(`${val.ssh_host}:${val.ssh_port}`, 2);
    const opId = w.fleet.requestRestoreArchive(launch, val);

    const stuck: StepDef = {
      name: "verify-chain-stuck",
      async run() {
        throw new Error("sentry-0: chain not verified after ~5 min — height not increasing");
      },
    };
    const steps = [
      ...buildPreLaunchOpSteps(w.db, "fl"),
      ...allSteps(),
      stuck,
      ...buildOpSteps(w.db, "fl"),
    ];
    const r = await runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer);
    expect(r.failedStep).toBe("verify-chain-stuck");
    // the restore finished regardless, and the node is back up on the
    // restored state — which is what lets the launch step pass on retry
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.services.ssh.started.has(`${val.ssh_host}:${val.ssh_port}`)).toBe(true);
    w.db.close();
  }, 120_000);
});

describe("halt-height upgrade", () => {
  it("completes though a halted node crash-loops: no RPC, SSH only in boot windows", async () => {
    // Live wedge (2026-07-27), in two acts. halt-wait first polled the
    // sentry's RPC for `height >= haltHeight`, a gate nothing can satisfy:
    // cosmos refuses the halt-height block inside FinalizeBlock so the
    // committed head stops at H-1, and the sentry carries the same
    // halt-height, so it stops serving RPC exactly when the condition comes
    // true. Probing over SSH instead then failed too — sparkdreamd is PID 1,
    // so a halted node is a crash loop and SSH answers only inside each boot
    // window ("lease shell: no active replicas for service"). Both times the
    // fleet was stranded halted, with halt-clear — the only thing that resets
    // the setting — parked behind the gate.
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.30";
    const opId = w.fleet.requestHaltUpgrade(launch, image, 10);

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    // the halt WAS observed, at the block below the halt height
    expect(w.db.stepOutput("fl", `op${opId}:halt-wait`)).toMatchObject({ haltedAt: 9 });
    // and the fleet came back out of it: setting cleared, images swapped
    expect(w.services.ssh.haltedNodes()).toEqual([]);
    expect(w.services.rpc.chainHalted).toBe(false);
    for (const c of w.db.listFleetComponents("fl").filter((x) => /^(val|sentry)-/.test(x.key))) {
      expect(c.image).toBe(image);
    }
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    w.db.close();
  }, 120_000);

  it("clear-halt-height releases a fleet an abandoned halt upgrade left stranded", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const nodes = w.db.listFleetComponents("fl").filter((c) => /^(val|sentry)-/.test(c.key));
    const target = (c: (typeof nodes)[number]) => ({ host: c.ssh_host!, port: c.ssh_port! });
    const boot = "nohup sparkdreamd start --home /root/.sparkdream";

    // the state an aborted op leaves behind: halt-height set on every node and
    // nobody left to clear it, so each restart halts again at a passed block
    for (const c of nodes) {
      await w.services.ssh.exec(
        target(c),
        "sed -i 's|^halt-height =.*|halt-height = 500|' /root/.sparkdream/config/app.toml",
      );
      await w.services.ssh.exec(target(c), boot);
    }
    expect(w.services.ssh.haltedNodes()).toHaveLength(nodes.length);
    expect(w.services.rpc.chainHalted).toBe(true);

    const { cleared } = await w.fleet.clearHaltHeight(launch);
    expect(cleared.sort()).toEqual(nodes.map((c) => c.key).sort());

    // a restart now actually brings the node up instead of re-halting
    for (const c of nodes) await w.services.ssh.exec(target(c), boot);
    expect(w.services.ssh.haltedNodes()).toEqual([]);
    expect(w.services.rpc.chainHalted).toBe(false);
    for (const c of nodes) {
      expect(w.services.ssh.started.has(`${c.ssh_host}:${c.ssh_port}`)).toBe(true);
    }
    w.db.close();
  }, 120_000);
});

describe("repair op: node versions", () => {
  it("corrects a version swapped in outside the launcher, in the row and the SDL", async () => {
    // Live (2026-07-27): a halt-height upgrade wedged, the operator finished
    // it by hand in the Akash console, and the launcher went on advertising
    // the version it last installed itself — the fleet card reads the row.
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const nodes = w.db.listFleetComponents("fl").filter((c) => /^(val|sentry)-/.test(c.key));
    const before = Object.fromEntries(nodes.map((c) => [c.key, c.image]));
    expect(before["val-0"]).toMatch(/:v\d+\.\d+\.\d+$/);
    for (const c of nodes) {
      w.services.ssh.nodeVersions.set(`${c.ssh_host}:${c.ssh_port}`, "1.0.30");
    }

    w.fleet.requestRepair(launch, nodes[0]!);
    expect((await driveOps(w)).status).toBe("completed");

    for (const c of w.db.listFleetComponents("fl").filter((x) => /^(val|sentry)-/.test(x.key))) {
      expect(c.image).toBe(before[c.key]!.replace(/:v.*$/, ":v1.0.30"));
      // the SDL is the launcher's model of the deployment: a stale one would
      // have the next upgrade derive its manifest from the wrong image
      const sdl = fs.readFileSync(path.join(w.work, `launches/fl/sdl/${c.key}.yaml`), "utf8");
      expect(sdl).toContain("image: " + c.image);
    }
    w.db.close();
  }, 120_000);

  it("keeps the recorded image when a node cannot be asked its version", async () => {
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const val = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    // nodeVersions unset: the node answers nothing. Silence is not evidence
    // that the recorded image is wrong, so it must survive the repair.
    w.fleet.requestRepair(launch, val);
    expect((await driveOps(w)).status).toBe("completed");

    expect(w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.image).toBe(val.image);
    w.db.close();
  }, 120_000);
});

describe("retagImage", () => {
  it("swaps a version tag, preserving the v prefix, and refuses to guess", () => {
    expect(retagImage("sparkdreamnft/sparkdreamd-devnet-ssh:v1.0.29", "1.0.30")).toBe(
      "sparkdreamnft/sparkdreamd-devnet-ssh:v1.0.30",
    );
    expect(retagImage("repo/img:1.0.29", "v1.0.30")).toBe("repo/img:1.0.30");
    // nothing that isn't already a version tag gets rewritten
    expect(retagImage("repo/img:latest", "1.0.30")).toBeUndefined();
    expect(retagImage("repo/img", "1.0.30")).toBeUndefined();
    expect(retagImage("repo/img@sha256:abc123", "1.0.30")).toBeUndefined();
    expect(retagImage(null, "1.0.30")).toBeUndefined();
  });
});

describe("withRedeployNonce", () => {
  const sdl = [
    "    env:",
    "      - >-",
    "        SSH_PUBLIC_KEY=ssh-ed25519 AAAA",
    "        launch-abc",
    "      - TS_HOSTNAME=sentry-0",
    "      - TS_TUNNEL_1=16656:100.64.0.2:26656",
    "    params:",
  ].join("\n");

  it("inserts the nonce beside an existing env entry, matching its indentation", () => {
    const out = withRedeployNonce(sdl, "1700000000");
    expect(out).toContain("      - LAUNCHER_REDEPLOY_NONCE=1700000000");
    // the folded SSH key block is left exactly as it was: other steps regex
    // over these lines, so the nonce must not reshape them
    expect(out).toContain("      - >-\n        SSH_PUBLIC_KEY=ssh-ed25519 AAAA\n        launch-abc");
    expect(out).toContain("      - TS_TUNNEL_1=16656:100.64.0.2:26656");
  });

  it("refreshes the nonce in place rather than stacking a second one", () => {
    const once = withRedeployNonce(sdl, "1700000000");
    const twice = withRedeployNonce(once, "1700000999");
    expect(twice).toContain("LAUNCHER_REDEPLOY_NONCE=1700000999");
    expect(twice).not.toContain("1700000000");
    expect(twice.match(/LAUNCHER_REDEPLOY_NONCE=/g)).toHaveLength(1);
  });

  it("refuses an SDL with no env entry to anchor to", () => {
    expect(() => withRedeployNonce("services:\n  x:\n    image: y\n", "1")).toThrow(/anchor/);
  });
});

describe("force redeploy op", () => {
  it("moves the manifest version and re-pushes, so the provider re-creates the container", async () => {
    // the state repair cannot reach: chain and launcher agree, while the
    // running container still serves env from before the update landed
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const sigsBefore = w.signer.signed.length;
    const pushesBefore = w.services.provider.manifests.length;

    w.fleet.requestForceRedeploy(launch, sentry);
    expect((await driveOps(w)).status).toBe("completed");

    const upd = w.signer.signed
      .slice(sigsBefore)
      .flat()
      .find(
        (m) => m.typeUrl === TypeUrl.UpdateDeployment && String((m.value as any).id.dseq) === sentry.dseq,
      );
    expect(upd).toBeDefined();
    expect(w.services.provider.manifests.slice(pushesBefore).some((x) => x.dseq === sentry.dseq)).toBe(true);
    // the nonce lands in the SDL the launcher keeps for that component
    const sdl = fs.readFileSync(path.join(w.work, "launches", "fl", "sdl", "sentry-0.yaml"), "utf8");
    expect(sdl).toMatch(/LAUNCHER_REDEPLOY_NONCE=\d+/);
    w.db.close();
  }, 120_000);

  it("fails loudly when the provider refuses the version it just signed", async () => {
    // the 422 message is the same one a provider sends for "already running
    // this", so it must not be swallowed for a component we just moved —
    // that would leave the chain on a manifest the provider never applied
    const w = await launched(specWithComponents());
    const launch = w.db.getLaunch("fl")!;
    const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    w.services.provider.manifestUnchangedDseqs.add(sentry.dseq);

    w.fleet.requestForceRedeploy(launch, sentry);
    const res = await driveOps(w);
    expect(res.status).not.toBe("completed");
    const step = w.db.listSteps("fl").find((s) => s.name.endsWith(":redeploy"));
    expect(step?.error).toMatch(/not serving it|rejected the manifest/);
    w.db.close();
  }, 120_000);
});

describe("rewriteTailnetIps", () => {
  it("rewrites a swapped pair without folding both peers onto one address", () => {
    // headscale reallocates from an empty db in registration order, so a
    // relaunch really can hand val-0 the address sentry-0 used to hold.
    // Substituting the pairs one after another would turn .1→.2 and then
    // every .2 (including the one just written) back into .1.
    const swap = new Map([
      ["100.64.0.1", "100.64.0.2"],
      ["100.64.0.2", "100.64.0.1"],
    ]);
    const sdl = "- TS_TUNNEL_1=16656:100.64.0.1:26656\n- TS_TUNNEL_2=11317:100.64.0.2:1317\n";
    expect(rewriteTailnetIps(sdl, swap)).toBe(
      "- TS_TUNNEL_1=16656:100.64.0.2:26656\n- TS_TUNNEL_2=11317:100.64.0.1:1317\n",
    );
  });

  it("matches whole addresses only, and leaves unmapped ones alone", () => {
    const map = new Map([["100.64.0.1", "100.64.0.7"]]);
    // 100.64.0.10 must not be rewritten as 100.64.0.7 plus a stray "0"
    expect(rewriteTailnetIps("a=100.64.0.10 b=100.64.0.1 c=100.64.0.3", map)).toBe(
      "a=100.64.0.10 b=100.64.0.7 c=100.64.0.3",
    );
    expect(rewriteTailnetIps("nothing here", map)).toBe("nothing here");
    expect(rewriteTailnetIps("a=100.64.0.1", new Map())).toBe("a=100.64.0.1");
  });
});
