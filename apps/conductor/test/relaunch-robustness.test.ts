import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps, consensusAddress, countConsensusVotes } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { fakeServices, FakeSigner, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-robust-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The live fleets' shape: one validator, one sentry, public API/RPC on sentry-0. */
function spec1x1(keyMode: "softsign" | "tmkms" = "softsign"): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
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

async function launched(spec: LaunchSpec): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  db.createLaunch("fl", JSON.stringify(spec), "akash1owner");
  expect((await runWithSigner(db, "fl", spec, work, allSteps(), services, signer)).status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  return { work, db, services, spec, fleet, signer };
}

async function driveOps(w: World) {
  const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer);
}

const row = (w: World, key: string) => w.db.listFleetComponents("fl").find((c) => c.key === key)!;

/** Relaunch `key` off a provider that is gone: lease closed, SSH dead. */
async function relaunchOffDeadProvider(w: World, key: string) {
  const before = row(w, key);
  await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
  w.services.api.leaseStates.set(before.dseq, "closed");
  w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
  return before;
}

/** The chain stops at `height`: every RPC reads it, as on a halted single-validator chain. */
function haltChainAt(w: World, height: number): void {
  w.services.rpc.status = async () => ({ latestBlockHeight: height, catchingUp: false });
}

function consensusState(prevotes: string, precommits: string): string {
  return JSON.stringify({
    result: {
      round_state: {
        "height/round/step": "501/0/6",
        height_vote_set: [
          { round: 0, prevotes_bit_array: prevotes, precommits_bit_array: precommits },
          { round: 1, prevotes_bit_array: "BA{1:_} 0/100 = 0.00", precommits_bit_array: "BA{1:_} 0/100 = 0.00" },
        ],
      },
    },
  });
}

/** A CometBFT vote string as /consensus_state lists it (address = first 6 bytes, hex). */
const vote = (index: number, address: string, type = "SIGNED_MSG_TYPE_PREVOTE(Prevote)") =>
  `Vote{${index}:${address.slice(0, 12)} 501/00/${type} 8B01023386C3 9A5D6E0F1B2C 000000000000 @ 2026-10-03T12:00:00.000Z}`;

/** Round 0 of a stuck height, with the votes the sentry holds as strings. */
function consensusStateWithVotes(prevotes: string[], precommits: string[]): string {
  const bits = (v: string[]) => `BA{${v.length}:${v.map((x) => (x === "nil-Vote" ? "_" : "x")).join("")}} 0/100 = 0.00`;
  return JSON.stringify({
    result: {
      round_state: {
        "height/round/step": "501/0/6",
        height_vote_set: [
          { round: 0, prevotes, prevotes_bit_array: bits(prevotes), precommits, precommits_bit_array: bits(precommits) },
        ],
      },
    },
  });
}

const OTHER = "AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12";

describe("counting the votes a halted height holds", () => {
  it("counts the x bits across rounds", () => {
    expect(countConsensusVotes(consensusState("BA{1:_} 0/100 = 0.00", "BA{1:_} 0/100 = 0.00"))).toBe(0);
    expect(countConsensusVotes(consensusState("BA{3:x_x} 66/100 = 0.66", "BA{3:__x} 33/100 = 0.33"))).toBe(3);
    expect(countConsensusVotes("{}")).toBeNull();
  });

  it("with an address, counts only that validator's votes", () => {
    const mine = "0F1E2D3C4B5A69788796A5B4C3D2E1F00F1E2D3C";
    const body = consensusStateWithVotes(
      [vote(0, OTHER), "nil-Vote", vote(2, mine)],
      [vote(0, OTHER, "SIGNED_MSG_TYPE_PRECOMMIT(Precommit)"), "nil-Vote", "nil-Vote"],
    );
    expect(countConsensusVotes(body, mine)).toBe(1);
    expect(countConsensusVotes(body, OTHER)).toBe(2);
    expect(countConsensusVotes(body, "FFFFFFFFFFFF0000000000000000000000000000")).toBe(0);
    // no vote strings in the answer: every vote counts, which only pauses
    expect(countConsensusVotes(consensusState("BA{2:xx} 100/100 = 1.00", "BA{2:__} 0/100 = 0.00"), mine)).toBe(2);
  });
});

describe("softsign validator relaunch on a single-validator chain", () => {
  it("boots the node when the chain halted and nobody holds a vote at the stuck height", async () => {
    // closing the only validator halts the chain, so the 20-block window can
    // never clear: the node used to be left unbooted for good
    const w = await launched(spec1x1());
    await relaunchOffDeadProvider(w, "val-0");
    haltChainAt(w, 500);
    w.services.rpc.texts.set("/consensus_state", consensusState("BA{1:_} 0/100 = 0.00", "BA{1:_} 0/100 = 0.00"));

    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    expect(fs.readFileSync(path.join(w.work, "launches/fl/sdl/val-0.yaml"), "utf8")).toContain("WAIT_FOR_CONFIG=false");
  }, 120_000);

  it("parks before booting when the network still holds a vote the old node may have cast", async () => {
    const w = await launched(spec1x1());
    await relaunchOffDeadProvider(w, "val-0");
    haltChainAt(w, 500);
    w.services.rpc.texts.set("/consensus_state", consensusState("BA{1:x} 100/100 = 1.00", "BA{1:_} 0/100 = 0.00"));

    const opId = w.db.listFleetOps("fl")[0]!.id;
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:start`);
    expect(parked.reason).toContain("1 vote(s) for height 501");
    expect(parked.reason).toContain("double-sign");
    // never booted: still in wait mode
    expect(fs.readFileSync(path.join(w.work, "launches/fl/sdl/val-0.yaml"), "utf8")).toContain("WAIT_FOR_CONFIG=true");

    // the sentry dropped its vote set (restart): resume boots it
    w.services.rpc.texts.set("/consensus_state", consensusState("BA{1:_} 0/100 = 0.00", "BA{1:_} 0/100 = 0.00"));
    expect((await driveOps(w)).status).toBe("completed");
  }, 120_000);

  it("boots past other validators' votes on the stuck height, and parks on its own", async () => {
    const w = await launched(spec1x1());
    await relaunchOffDeadProvider(w, "val-0");
    haltChainAt(w, 500);
    // a multi-validator chain stalled without val-0: the others keep voting
    w.services.rpc.texts.set("/consensus_state", consensusStateWithVotes([vote(0, OTHER), "nil-Vote"], [vote(0, OTHER), "nil-Vote"]));
    expect((await driveOps(w)).status).toBe("completed");

    const w2 = await launched(spec1x1());
    await relaunchOffDeadProvider(w2, "val-0");
    haltChainAt(w2, 500);
    const mine = consensusAddress(
      w2.db.stepOutput<{ consensusPubkeys: Record<string, string> }>("fl", "generate-keys")!.consensusPubkeys["val-0"]!,
    );
    w2.services.rpc.texts.set("/consensus_state", consensusStateWithVotes([vote(0, OTHER), vote(1, mine)], ["nil-Vote", "nil-Vote"]));
    const parked = await driveOps(w2);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.reason).toContain("1 vote(s) for height 501");
  }, 240_000);

  it("never skips the window when the fleet's sentries exist but none is active", async () => {
    const w = await launched(spec1x1());
    await relaunchOffDeadProvider(w, "val-0");
    // the sentry is mid-relaunch of its own: no active row to measure from
    w.db.setComponentState("fl", "sentry-0", "relaunching");
    const opId = w.db.listFleetOps("fl")[0]!.id;
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:start`);
    expect(parked.reason).toContain("no active sentry's RPC answers");
    expect(fs.readFileSync(path.join(w.work, "launches/fl/sdl/val-0.yaml"), "utf8")).toContain("WAIT_FOR_CONFIG=true");

    w.db.setComponentState("fl", "sentry-0", "active");
    expect((await driveOps(w)).status).toBe("completed");
  }, 120_000);

  it("closes even when the sentry's RPC is down, and measures the window once it answers", async () => {
    const w = await launched(spec1x1());
    await relaunchOffDeadProvider(w, "val-0");
    const status = w.services.rpc.status.bind(w.services.rpc);
    let down = true;
    w.services.rpc.status = async (url: string) => {
      if (down) throw new Error("connect ECONNREFUSED");
      return status(url);
    };
    const opId = w.db.listFleetOps("fl")[0]!.id;
    // down through the close and the start step's own retries
    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:start`);
    expect(parked.reason).toContain("no active sentry's RPC answers");
    expect(w.db.getStep("fl", `op${opId}:close`)?.status).toBe("done");

    down = false;
    expect((await driveOps(w)).status).toBe("completed");
  }, 120_000);
});

describe("sentries take several mesh peers (all arrive from 127.0.0.1)", () => {
  it("repair turns on allow_duplicate_ip where it is off and restarts only those sentries", async () => {
    const w = await launched(spec1x1("tmkms"));
    const s0 = row(w, "sentry-0");
    const id = `${s0.ssh_host}:${s0.ssh_port}`;
    w.services.ssh.refusesDuplicateIp.add(id);
    w.fleet.requestRepair(w.db.getLaunch("fl")!, s0);
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.services.ssh.refusesDuplicateIp.has(id)).toBe(false);
    const op = w.db.listFleetOps("fl").find((o) => o.kind === "repair")!;
    expect(w.db.getStep("fl", `op${op.id}:mesh-peers`)?.output_json).toContain('"fixed":["sentry-0"]');
    // restarted: the node reads the setting at start
    expect(w.services.ssh.execLog.some((e) => e.target === id && /pkill -x sparkdreamd/.test(e.command))).toBe(true);

    // a second repair finds nothing to change and restarts nothing
    const before = w.services.ssh.execLog.length;
    w.fleet.requestRepair(w.db.getLaunch("fl")!, row(w, "sentry-0"));
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.services.ssh.execLog.slice(before).some((e) => /pkill -x sparkdreamd/.test(e.command))).toBe(false);
  }, 240_000);
});

describe("sentry relaunch", () => {
  it("finishes when its validator cannot be reached, leaving that link to the validator's own recovery", async () => {
    const w = await launched(spec1x1("tmkms"));
    const val = row(w, "val-0");
    await relaunchOffDeadProvider(w, "sentry-0");
    // the validator's provider is out too
    w.services.ssh.failHosts.add(`${val.ssh_host}:${val.ssh_port}`);
    const opId = w.db.listFleetOps("fl")[0]!.id;
    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.db.getStep("fl", `op${opId}:configure`)?.output_json).toBeTruthy();
  }, 120_000);

  it("pauses with the new CNAME target when the public API/RPC domains stay dark", async () => {
    const w = await launched(spec1x1("tmkms"));
    await relaunchOffDeadProvider(w, "sentry-0");
    w.services.rpc.darkUrls.add("api.sparkdream.io");
    w.services.rpc.darkUrls.add("rpc.sparkdream.io");
    const opId = w.db.listFleetOps("fl")[0]!.id;

    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toBe(`op${opId}:public-dns`);
    expect(parked.reason).toContain("api.sparkdream.io → CNAME");
    expect(parked.reason).toContain("rpc.sparkdream.io → CNAME");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("active");

    // DNS updated: resume finishes the op
    w.services.rpc.darkUrls.clear();
    expect((await driveOps(w)).status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
  }, 120_000);

  it("warns about the public domains before it starts", async () => {
    const w = await launched(spec1x1("tmkms"));
    const warnings = w.fleet.relaunchWarnings(w.db.getLaunch("fl")!, row(w, "sentry-0")).join(" ");
    expect(warnings).toContain("api.sparkdream.io and rpc.sparkdream.io");
  }, 120_000);
});
