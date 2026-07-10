import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toEncodeObject } from "@sparkdream/akash-tx";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
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
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.25";
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
    expect((feeMsg.value as any).amount).toEqual([{ denom: "uact", amount: "2000000" }]);
    // manifests re-PUT per component
    expect(w.services.provider.manifests.length - manifestsBefore).toBe(4);
    // SDLs carry the new image; components record it
    for (const c of w.db.listFleetComponents("fl").filter((x) => x.key !== "headscale")) {
      expect(c.image).toBe(image);
      const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", `${c.key}.yaml`), "utf8");
      expect(sdl).toContain(`image: ${image}`);
    }
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
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
    // upgrade service fee: flat 2 ACT batched into this op's (first) update tx
    const feeMsg = upgradeTxs[0]!.at(-1)!;
    expect(feeMsg.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect((feeMsg.value as any).to_address).toBe(
      "akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w",
    );
    expect((feeMsg.value as any).amount).toEqual([{ denom: "uact", amount: "2000000" }]);
    const explorer = w.db.listFleetComponents("fl").find((c) => c.key === "explorer")!;
    expect(explorer.image).toBe(image);
    const sdl = fs.readFileSync(path.join(w.work, "launches/fl/sdl", "explorer.yaml"), "utf8");
    expect(sdl).toContain(`image: ${image}`);
    // verified over HTTP, not pgrep-over-SSH
    expect(w.services.ssh.execLog.length).toBe(sshBefore);
    expect(w.db.listFleetOps("fl")[0]!.status).toBe("done");
  }, 120_000);
});

describe("top-up", () => {
  it("enqueues an encodable deposit plus the 0.5% fee into the signing loop", async () => {
    const w = await launched();
    const launch = w.db.getLaunch("fl")!;
    const component = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const { step } = w.fleet.requestTopUp(launch, component, "2500000");
    const pending = w.db.getPendingTx("fl", step)!;
    const msgs = JSON.parse(pending.msgs_json);
    expect(msgs[0].typeUrl).toBe("/akash.escrow.v1.MsgAccountDeposit");
    // the browser/CLI signer can actually encode it
    const encodeObject = toEncodeObject(msgs[0]);
    expect(encodeObject.value.deposit.amount).toEqual({ denom: "uact", amount: "2500000" });
    // top-up fee: 0.5% of 2,500,000 = 12,500, sent with the deposit
    expect(msgs[1].typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect(msgs[1].value.to_address).toBe("akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w");
    expect(msgs[1].value.amount).toEqual([{ denom: "uact", amount: "12500" }]);
  }, 120_000);
});
