import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chainId, testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import {
  adoptSigner,
  describeProcess,
  getBinding,
  parseTmkmsConfig,
  rejoinSignerMesh,
  renderUnit,
  resolveSshAlias,
  signerAddr,
  withValidatorAddr,
  type RemoteHost,
} from "../src/local-signer.js";
import { fakeServices, FakeSigner, FakeSignerHost, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-signer-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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

const DIR = "/home/op/tmkms";
const CONFIG = `${DIR}/tmkms-val-0.toml`;
const WIN_TS = "/mnt/c/Program Files/Tailscale/tailscale.exe";

function config(cid: string, ip: string): string {
  return [
    `[[chain]]`,
    `id = "${cid}"`,
    `key_format = { type = "cometbft", sign_extensions = true }`,
    `state_file = "state/${cid}-consensus.json"`,
    ``,
    `[[providers.softsign]]`,
    `chain_ids = ["${cid}"]`,
    `key_type = "consensus"`,
    `path = "secrets/val-0-consensus.key"`,
    ``,
    `# my own note, keep me`,
    `[[validator]]`,
    `chain_id = "${cid}"`,
    `addr = "${signerAddr(ip)}"`,
    `protocol_version = "v0.38"`,
    `reconnect = true`,
    ``,
  ].join("\n");
}

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  spec: LaunchSpec;
  fleet: FleetService;
  signer: FakeSigner;
  host: FakeSignerHost;
  cid: string;
}

/** A completed tmkms fleet whose signer runs, hand-started, on the launcher's machine. */
async function launched(): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const signer = new FakeSigner();
  const spec = tmkms1x1();
  db.createLaunch("fl", JSON.stringify(spec), "akash1owner");
  expect((await runWithSigner(db, "fl", spec, work, allSteps(), services, signer)).status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  const cid = chainId(withDefaults(spec));
  const ip = db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip!;
  const host = new FakeSignerHost();
  host.files.set(CONFIG, config(cid, ip));
  host.files.set(`${DIR}/state/${cid}-consensus.json`, '{"height":"812","round":"0","step":3}');
  host.procs.push({ pid: 4242, bin: `${DIR}/target/release/tmkms`, cwd: DIR, config: CONFIG, unit: null });
  host.clis = [
    { cli: "tailscale", running: false, ips: [], hostname: null },
    { cli: WIN_TS, running: true, ips: ["100.64.0.5"], hostname: "tmkms" },
  ];
  services.localSigner = host;
  return { work, db, services, spec, fleet, signer, host, cid };
}

/** The fake signer holds a session exactly when its config points at val-0's current address. */
function signerFollowsConfig(w: World): void {
  w.host.onRestart = () => {
    const ip = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip!;
    const addr = parseTmkmsConfig(w.host.files.get(CONFIG)!).validators[0]!.addr;
    w.services.ssh.signerConnected = addr === signerAddr(ip);
  };
}

async function driveOps(w: World) {
  const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
  return runWithSigner(w.db, "fl", w.spec, w.work, steps, w.services, w.signer);
}

describe("tmkms config edits", () => {
  it("replaces only the addr of the chain's [[validator]] block", () => {
    const text = config("sparkdream-1", "100.64.0.9");
    const next = withValidatorAddr(text, "sparkdream-1", "tcp://100.64.0.44:26659");
    expect(parseTmkmsConfig(next).validators).toEqual([
      { chainId: "sparkdream-1", addr: "tcp://100.64.0.44:26659" },
    ]);
    // everything else, comments included, is byte-for-byte the same
    expect(next.split("\n").filter((l) => !l.startsWith("addr"))).toEqual(
      text.split("\n").filter((l) => !l.startsWith("addr")),
    );
  });

  it("refuses a config that does not name the chain exactly once", () => {
    const text = config("sparkdream-1", "100.64.0.9");
    expect(() => withValidatorAddr(text, "other-1", "tcp://x:1")).toThrow(/0 \[\[validator\]\] blocks/);
    const twice = `${text}\n[[validator]]\nchain_id = "sparkdream-1"\naddr = "tcp://y:1"\n`;
    expect(() => withValidatorAddr(twice, "sparkdream-1", "tcp://x:1")).toThrow(/2 \[\[validator\]\] blocks/);
  });
});

describe("the unit file", () => {
  it("quotes paths so spaces, %, $ and quotes reach tmkms as written", () => {
    const text = renderUnit({ key: "val-0", chainId: "c-1", bin: '/opt/my tmkms/tmkms', workDir: "/opt/my tmkms", config: '/opt/100%/a$b"c.toml' });
    expect(text).toContain('ExecStart="/opt/my tmkms/tmkms" start -c "/opt/100%%/a$$b\\"c.toml"');
  });
});

describe("adopting the local signer", () => {
  it("refuses, leaving it running, a tmkms whose binary was replaced while it ran", async () => {
    const w = await launched();
    w.host.procs[0]!.bin = `${DIR}/target/release/tmkms (deleted)`;
    await expect(w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0")).rejects.toThrow(/not a usable path/);
    expect(w.host.killed).toEqual([]);
    expect(w.host.units.size).toBe(0);
  }, 120_000);

  it("stops its own unit when a wrapper brings the hand-started signer back beside it", async () => {
    const w = await launched();
    w.host.onRestart = () => {
      if (!w.host.procs.some((p) => p.pid === 4343)) {
        w.host.procs.push({ pid: 4343, bin: `${DIR}/target/release/tmkms`, cwd: DIR, config: CONFIG, unit: null });
      }
    };
    await expect(w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0")).rejects.toThrow(/pid 4343/);
    const signers = w.host.procs.filter((p) => p.config === CONFIG);
    expect(signers.map((p) => p.pid)).toEqual([4343]);
    expect(getBinding(w.db, "fl", "val-0")).toBeNull();
  }, 120_000);

  it("keeps the mesh auth key out of a failed rejoin's error", async () => {
    const w = await launched();
    const b = await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    w.host.meshUpFails = true;
    const deps = { db: w.db, host: w.host, launchId: "fl" };
    const err = await rejoinSignerMesh(deps, b, "https://headscale.example", "hskey-secret-123").catch((e: Error) => e);
    expect(String(err)).toContain("<authkey>");
    expect(String(err)).not.toContain("hskey-secret-123");
  }, 120_000);

  it("moves the hand-started tmkms under a launcher unit and records the Windows Tailscale CLI", async () => {
    const w = await launched();
    const b = await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    expect(w.host.killed).toEqual([4242]);
    const unit = w.host.units.get(b.unit)!;
    expect(unit.active).toBe(true);
    expect(unit.contents).toContain(`WorkingDirectory=${DIR}`);
    expect(unit.contents).toContain(`ExecStart="${DIR}/target/release/tmkms" start -c "${CONFIG}"`);
    expect(unit.contents).toContain("Restart=always");
    expect(b.meshCli).toBe(WIN_TS);
    expect(getBinding(w.db, "fl", "val-0")?.config).toBe(CONFIG);

    // adopting again touches nothing that runs
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    expect(w.host.killed).toEqual([4242]);
    expect(w.host.restarts).toHaveLength(1);
  }, 120_000);

  it("the fleet view says which validators' signers are managed, for the row's action", async () => {
    const w = await launched();
    const view = async () => (await w.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!;
    // the hand-started tmkms signs for val-0: offered
    expect((await view()).localSigner).toEqual({ managed: [], adoptable: ["val-0"], remote: false });
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    expect((await view()).localSigner).toEqual({ managed: ["val-0"], adoptable: [], remote: false });
    // released, its unit still runs it, and the row offers to manage it again
    w.fleet.releaseLocalSigner(w.db.getLaunch("fl")!, "val-0");
    expect((await view()).localSigner).toEqual({ managed: [], adoptable: ["val-0"], remote: false });
    // a signer for another chain (or none) on this machine: no action
    const w2 = await launched();
    w2.host.files.set(CONFIG, config("someone-else-1", "100.64.0.9"));
    expect((await w2.fleet.fleetForOwner("akash1owner")).fleets.find((f) => f.launchId === "fl")!.localSigner)
      .toEqual({ managed: [], adoptable: [], remote: false });
    // a launcher that cannot manage a signer offers no action at all
    delete w.services.localSigner;
    expect((await view()).localSigner).toBeUndefined();
  }, 120_000);

  it("refuses when no tmkms on this machine signs for the chain", async () => {
    const w = await launched();
    w.host.files.set(CONFIG, config("someone-else-1", "100.64.0.9"));
    await expect(w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0")).rejects.toThrow(/no tmkms process/);
    expect(w.host.killed).toEqual([]);
  }, 120_000);
});

describe("ops with a managed signer", () => {
  it("a validator relaunch repoints and restarts the signer instead of pausing", async () => {
    const w = await launched();
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    signerFollowsConfig(w);
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    w.services.ssh.signerConnected = false; // the old address is gone

    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    expect(after.tailnet_ip).not.toBe(before.tailnet_ip);
    const text = w.host.files.get(CONFIG)!;
    expect(parseTmkmsConfig(text).validators[0]!.addr).toBe(signerAddr(after.tailnet_ip!));
    expect(text).toContain("# my own note, keep me");
    expect(w.host.files.get(`${CONFIG}.bak`)).toContain(signerAddr(before.tailnet_ip!));
    // the watermark is never touched by a move
    expect(w.host.files.get(`${DIR}/state/${w.cid}-consensus.json`)).toContain('"812"');
    expect(getBinding(w.db, "fl", "val-0")?.lastAction?.what).toMatch(/repointed .* \(relaunch\)/);
  }, 120_000);

  it("pauses as before, saying why, when a hand-started signer runs the same config", async () => {
    const w = await launched();
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    // the operator started one by hand again beside the unit
    w.host.procs.push({ pid: 777, bin: "tmkms", cwd: DIR, config: CONFIG, unit: null });
    const restartsBefore = w.host.restarts.length;
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    w.services.ssh.signerConnected = false;

    const parked = await driveOps(w);
    expect(parked.status).toBe("awaiting-user");
    expect(parked.failedStep).toMatch(/:await-signer$/);
    expect(parked.reason).toContain("pid 777");
    expect(w.host.restarts.length).toBe(restartsBefore);
  }, 120_000);

  it("a chain reset clears the managed signer's watermark instead of pausing", async () => {
    const w = await launched();
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));

    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    const state = `${DIR}/state/${w.cid}-consensus.json`;
    expect(w.host.files.has(state)).toBe(false);
    const kept = [...w.host.files.keys()].filter((f) => f.startsWith(`${state}.reset-`));
    expect(kept).toHaveLength(1);
    expect(w.host.files.get(kept[0]!)).toContain('"812"');
  }, 120_000);

  it("a headscale re-key logs the machine back in through its CLI and repoints the signer", async () => {
    const w = await launched();
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    signerFollowsConfig(w);
    const launch = w.db.getLaunch("fl")!;
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "headscale")!;
    const opId = await w.fleet.requestRelaunch(launch, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.remapTailnetIps();
    w.services.ssh.signerConnected = false;

    const done = await driveOps(w);
    expect(done.status).toBe("completed");
    expect(w.db.listFleetOps("fl").find((o) => o.id === opId)!.status).toBe("done");
    expect(w.host.meshUps).toHaveLength(1);
    expect(w.host.meshUps[0]!.cli).toBe(WIN_TS);
    expect(w.host.meshUps[0]!.args).toContain("--login-server=https://headscale.sparkdream.io");
    expect(w.host.meshUps[0]!.args.some((a) => a.startsWith("--authkey=hskey-"))).toBe(true);
    const ip = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip!;
    expect(parseTmkmsConfig(w.host.files.get(CONFIG)!).validators[0]!.addr).toBe(signerAddr(ip));
  }, 240_000);
});

describe("signer watchdog", () => {
  it("repoints a stale addr at once, and restarts a signer with no session after three checks", async () => {
    const w = await launched();
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    const ip = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip!;

    // a config left pointing elsewhere is fixed on the first pass
    w.host.files.set(CONFIG, withValidatorAddr(w.host.files.get(CONFIG)!, w.cid, "tcp://100.64.9.9:26659"));
    const r0 = w.host.restarts.length;
    await w.fleet.signerWatchdog("fl");
    expect(parseTmkmsConfig(w.host.files.get(CONFIG)!).validators[0]!.addr).toBe(signerAddr(ip));
    expect(w.host.restarts.length).toBe(r0 + 1);

    // a connected signer is left alone
    w.services.ssh.signerConnected = true;
    await w.fleet.signerWatchdog("fl");
    expect(w.host.restarts.length).toBe(r0 + 1);
  }, 120_000);

  it("restarts after three sessionless checks, and stays out of the way of a running op", async () => {
    const w = await launched();
    await w.fleet.adoptLocalSigner(w.db.getLaunch("fl")!, "val-0");
    const r0 = w.host.restarts.length;
    w.services.ssh.signerConnected = false;
    await w.fleet.signerWatchdog("fl");
    await w.fleet.signerWatchdog("fl");
    expect(w.host.restarts.length).toBe(r0);
    await w.fleet.signerWatchdog("fl");
    expect(w.host.restarts.length).toBe(r0 + 1);
    expect(getBinding(w.db, "fl", "val-0")?.lastAction?.what).toContain("watchdog");

    // cooldown: no second restart right away
    for (let i = 0; i < 3; i++) await w.fleet.signerWatchdog("fl");
    expect(w.host.restarts.length).toBe(r0 + 1);

    // an op drives the signer itself
    const w2 = await launched();
    await w2.fleet.adoptLocalSigner(w2.db.getLaunch("fl")!, "val-0");
    const r2 = w2.host.restarts.length;
    w2.services.ssh.signerConnected = false;
    const sentry = w2.db.listFleetComponents("fl").find((c) => c.key === "sentry-0")!;
    await w2.fleet.requestRelaunch(w2.db.getLaunch("fl")!, sentry);
    for (let i = 0; i < 4; i++) await w2.fleet.signerWatchdog("fl");
    expect(w2.host.restarts.length).toBe(r2);
  }, 120_000);
});

describe("a signer on another machine (the testnet's Pi)", () => {
  const PI_DIR = "/home/pi/dev/sparkdream/prod/kms-sprkdrm-1";
  const PI_CONFIG = `${PI_DIR}/tmkms.toml`;
  /** The Pi's shape: one tmkms for two chains, a hardware key, absolute state files. */
  function piConfig(cid: string, ip: string): string {
    return [
      `[[chain]]`,
      `id = "${cid}"`,
      `state_file = "${PI_DIR}/state/${cid}-consensus.json"`,
      `[[chain]]`,
      `id = "sparkdreamdev-7"`,
      `state_file = "${PI_DIR}/state/sparkdream-dev-1-consensus.json"`,
      `[[providers.pkcs11]]`,
      `token_label = "Pico-HSM"`,
      `[[validator]]`,
      `chain_id = "${cid}"`,
      `addr = "${signerAddr(ip)}"`,
      `reconnect = true`,
      `[[validator]]`,
      `chain_id = "sparkdreamdev-7"`,
      `addr = "tcp://100.64.0.2:26659"`,
      ``,
    ].join("\n");
  }

  async function withPi() {
    const w = await launched();
    const pi = new FakeSignerHost();
    const ip = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip!;
    pi.files.set(PI_CONFIG, piConfig(w.cid, ip));
    pi.files.set(`${PI_DIR}/state/${w.cid}-consensus.json`, '{"height":"900"}');
    pi.files.set(`${PI_DIR}/state/sparkdream-dev-1-consensus.json`, '{"height":"77"}');
    // run by the operator's own system unit, through a wrapper script
    pi.units.set("tmkms.service", { contents: "ExecStart=/home/pi/dev/tmkms/tmkms.sh", active: true });
    pi.procs.push({ pid: 179123, bin: "/home/pi/dev/tmkms/tmkms/target/release/tmkms", cwd: PI_DIR, config: PI_CONFIG, unit: "tmkms.service", unitScope: "system" });
    pi.clis = [{ cli: "tailscale", running: true, ips: ["100.64.0.5"], hostname: "tmkms" }];
    const seen: RemoteHost[] = [];
    w.services.localSigner = undefined; // nothing signs on the launcher's own machine
    w.services.remoteSigner = (r) => {
      seen.push(r);
      return pi;
    };
    const sshDir = tmp();
    const cfg = path.join(sshDir, "config");
    fs.writeFileSync(cfg, 'Host other\n    HostName 10.0.0.1\nHost rasp\n    User pi\n    HostName 192.168.10.162\n    IdentityFile "C:\\Users\\Francois\\.ssh\\id_rasp"\n');
    return { w, pi, seen, cfg };
  }

  it("resolves an ssh_config alias, Windows key path included", async () => {
    const { cfg } = await withPi();
    expect(resolveSshAlias("rasp", [cfg])).toEqual({
      alias: "rasp",
      host: "192.168.10.162",
      port: 22,
      user: "pi",
      keyPath: "/mnt/c/Users/Francois/.ssh/id_rasp",
    });
    expect(resolveSshAlias("nope", [cfg])).toBeNull();
  }, 120_000);

  it("tells a system unit from a user unit by its cgroup", () => {
    const sys = describeProcess(1, "/bin/tmkms", "/d", ["tmkms", "start", "--config", "/d/t.toml"], "0::/system.slice/tmkms.service");
    expect(sys).toMatchObject({ unit: "tmkms.service", unitScope: "system", config: "/d/t.toml" });
    const user = describeProcess(2, "/bin/tmkms", "/d", ["tmkms", "start", "-c", "t.toml"], "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sparkdream-tmkms-x.service");
    expect(user).toMatchObject({ unit: "sparkdream-tmkms-x.service", unitScope: "user", config: "/d/t.toml" });
  });

  it("adopts the Pi's own service as it is, and a relaunch repoints only the testnet's block", async () => {
    const { w, pi, seen } = await withPi();
    // the alias resolves from the real ssh configs, so hand the request a resolved one
    const remote: RemoteHost = { alias: "rasp", host: "192.168.10.162", port: 22, user: "pi", keyPath: "/k" };
    const b = await adoptSigner(
      { db: w.db, host: undefined, remote: w.services.remoteSigner, launchId: "fl" },
      { key: "val-0", chainId: w.cid, tailnetIp: w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip, validatorCount: 1, remote },
    );
    expect(b).toMatchObject({ unit: "tmkms.service", scope: "system", remote, config: PI_CONFIG });
    expect(pi.killed).toEqual([]); // nothing installed, nothing stopped
    expect(seen[0]).toEqual(remote);

    pi.onRestart = () => {
      const ip = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip!;
      const v = parseTmkmsConfig(pi.files.get(PI_CONFIG)!).validators.find((x) => x.chainId === w.cid)!;
      w.services.ssh.signerConnected = v.addr === signerAddr(ip);
    };
    const before = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    await w.fleet.requestRelaunch(w.db.getLaunch("fl")!, before);
    w.services.api.leaseStates.set(before.dseq, "closed");
    w.services.ssh.failHosts.add(`${before.ssh_host}:${before.ssh_port}`);
    w.services.ssh.signerConnected = false;
    expect((await driveOps(w)).status).toBe("completed");

    const after = w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!;
    const view = parseTmkmsConfig(pi.files.get(PI_CONFIG)!);
    expect(view.validators).toEqual([
      { chainId: w.cid, addr: signerAddr(after.tailnet_ip!) },
      { chainId: "sparkdreamdev-7", addr: "tcp://100.64.0.2:26659" },
    ]);
    expect(pi.restarts).toContain("tmkms.service");
  }, 240_000);

  it("a chain reset moves aside only this chain's watermark", async () => {
    const { w, pi } = await withPi();
    const remote: RemoteHost = { alias: "rasp", host: "192.168.10.162", port: 22, user: "pi", keyPath: "/k" };
    await adoptSigner(
      { db: w.db, host: undefined, remote: w.services.remoteSigner, launchId: "fl" },
      { key: "val-0", chainId: w.cid, tailnetIp: w.db.listFleetComponents("fl").find((c) => c.key === "val-0")!.tailnet_ip, validatorCount: 1, remote },
    );
    const launch = w.db.getLaunch("fl")!;
    w.fleet.requestChainReset(launch, JSON.parse(launch.spec_json));
    w.spec = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    expect((await driveOps(w)).status).toBe("completed");
    expect(pi.files.has(`${PI_DIR}/state/${w.cid}-consensus.json`)).toBe(false);
    expect([...pi.files.keys()].some((f) => f.startsWith(`${PI_DIR}/state/${w.cid}-consensus.json.reset-`))).toBe(true);
    // the other chain's watermark is untouched
    expect(pi.files.get(`${PI_DIR}/state/sparkdream-dev-1-consensus.json`)).toBe('{"height":"77"}');
  }, 240_000);
});
