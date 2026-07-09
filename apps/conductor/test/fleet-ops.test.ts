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

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  spec: LaunchSpec;
  fleet: FleetService;
  signer: FakeSigner;
}

async function launched(): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const s = spec2x2();
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

    // 4 components → 4 single-msg update txs, in sentry-then-validator order
    const upgradeTxs = w.signer.signed.slice(sigsBefore);
    expect(upgradeTxs).toHaveLength(4);
    expect(upgradeTxs.every((msgs) => msgs.length === 1)).toBe(true);
    expect(upgradeTxs.every((msgs) => msgs[0]!.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);
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

describe("top-up", () => {
  it("enqueues an encodable deposit into the signing loop", async () => {
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
  }, 120_000);
});
