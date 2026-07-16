import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { toEncodeObject } from "@sparkdream/akash-tx";
import { testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-ops-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec2x2(): LaunchSpec {
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
  });
}

function specWithComponents(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
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

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  spec: LaunchSpec;
  fleet: FleetService;
  signer: FakeSigner;
}

async function launched(s: LaunchSpec = spec2x2()): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  const result = await runWithSigner(db, "fl", s, work, allSteps(), services, signer);
  expect(result.status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  return { work, db, services, spec: s, fleet, signer };
}

async function driveOps(w: World) {
  const steps = [...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer);
}

describe("relaunch op", () => {
  it("relaunches a sentry: new provider/dseq, tunnels rebuilt, validator re-patched", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestRelaunch(launch, before);
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
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);

  it("relaunches a softsign validator behind the double-sign window", async () => {
    const w = await launched();
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestRelaunch(launch, before);
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
    // §5 double-sign safety: the start step polled the chain past the window
    // (fake rpc heights advance per call; the guard required >= baseline+20)
    const startExecs = w.services.ssh.execLog.filter((e) => e.command.includes("sparkdreamd start"));
    expect(startExecs.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("stateless component relaunch", () => {
  it("relaunches the explorer without rewiring or start guards", async () => {
    const w = await launched(specWithComponents());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestRelaunch(launch, before);
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
    w.fleet.requestRelaunch(launch, before);
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

  it("pauses with a DNS pointer when the relaunched component stays dark", async () => {
    const w = await launched(specWithComponents());
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestRelaunch(launch, before);
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

describe("chain reset op", () => {
  it("rebuilds genesis under a bumped chain-id with edited accounts, wipes and restarts", async () => {
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

    const result = await driveOps(w);
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

    // every node home carries the rebuilt genesis: new chain-id, new
    // account seeded as a member, spec override applied
    const keys = w.db.stepOutput<{ accounts: Record<string, string> }>("fl", "generate-keys")!;
    const newcomer = keys.accounts["acct-newcomer"]!;
    const founder = keys.accounts["acct-founder"]!;
    for (const key of ["val-0", "val-1", "sentry-0", "sentry-1"]) {
      const g = JSON.parse(
        fs.readFileSync(path.join(w.work, `launches/fl/nodes/${key}/config/genesis.json`), "utf8"),
      );
      expect(g.chain_id).toBe("sparkdream-2");
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
      e.command.includes('chain-id = "sparkdream-2"'),
    );
    expect(seds).toHaveLength(4);

    // relaunch bundles were re-packed with the new genesis
    const bundled = execFileSync("tar", [
      "xzf",
      path.join(w.work, "launches/fl/bundles/sentry-0.tgz"),
      "-O",
      "config/genesis.json",
    ]).toString();
    expect(JSON.parse(bundled).chain_id).toBe("sparkdream-2");
  }, 120_000);

  it("swaps the node image mid-reset when the reset rides an upgrade", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.27";
    const edited = JSON.parse(launch.spec_json);
    edited.images = { ...edited.images, sparkdreamd: image };
    w.fleet.requestChainReset(launch, edited);
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const sigsBefore = w.signer.signed.length;

    const result = await driveOps(w);
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

    const result = await driveOps(w);
    expect(result.status).toBe("completed");

    // resume tx carries the frontend + explorer updates alongside the two
    // node flips
    const txs = w.signer.signed.slice(sigsBefore);
    expect(txs.map((msgs) => msgs.length)).toEqual([2, 4]);
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl/frontend.yaml"), "utf8");
    expect(sdl).toContain("DISPLAY_DENOM=SPARZ");
    expect(sdl).toContain("CHAIN_ID=sparkdream-2");
    // the explorer's env is patched in place: new chain identity, but the
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

  it("rejects edits the deployed fleet embodies", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const edited = JSON.parse(launch.spec_json);
    edited.topology.sentries.count = 3;
    expect(() => w.fleet.requestChainReset(launch, edited)).toThrow(/sentries.count/);
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
