import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps } from "../src/fleet-ops.js";
import { allSteps, buildServer } from "../src/index.js";
import { adr36SignDoc } from "../src/auth.js";
import {
  isEncryptedFile,
  readSecretFile,
  writeSecretFile,
} from "../src/secrets.js";
import { fakeServices, FakeSigner } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-m6-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.LAUNCHER_SECRET;
});

function spec(overrides: Record<string, unknown> = {}): LaunchSpec {
  return testnetSpec({
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
    ...overrides,
  });
}

describe("secret encryption at rest (M6)", () => {
  it("round-trips with LAUNCHER_SECRET and errors without it", () => {
    const dir = tmp();
    const file = path.join(dir, "k.pem");
    process.env.LAUNCHER_SECRET = "correct horse battery staple";
    writeSecretFile(file, "top-secret-key");
    expect(isEncryptedFile(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).not.toContain("top-secret-key");
    expect(readSecretFile(file)).toBe("top-secret-key");

    delete process.env.LAUNCHER_SECRET;
    expect(() => readSecretFile(file)).toThrow(/LAUNCHER_SECRET/);
  });

  it("writes plaintext (readable) when no secret is set", () => {
    const dir = tmp();
    const file = path.join(dir, "k.pem");
    writeSecretFile(file, "plain");
    expect(isEncryptedFile(file)).toBe(false);
    expect(readSecretFile(file)).toBe("plain");
  });

  it("a full launch stores encrypted secrets and still reads them back", async () => {
    process.env.LAUNCHER_SECRET = "launch-secret";
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec();
    db.createLaunch("enc", JSON.stringify(s), "akash1owner");
    const result = await runWithSigner(db, "enc", s, work, allSteps(), fakeServices(), new FakeSigner());
    expect(result.status).toBe("completed");
    // the SSH private key on disk is ciphertext...
    const sshKey = path.join(work, "launches/enc/secrets/ssh_ed25519.pem");
    expect(isEncryptedFile(sshKey)).toBe(true);
    // ...but the fleet can still restart (reads it back through the secret layer)
    const fleet = new FleetService(db, fakeServices(), work);
    fleet.materialize("enc");
    const val = db.listFleetComponents("enc").find((c) => c.key === "val-0")!;
    await expect(fleet.restart(db.getLaunch("enc")!, val)).resolves.toBeUndefined();
    db.close();
  }, 120_000);
});

describe("wallet-session auth (M6, §2)", () => {
  async function server(allowlist: string[]) {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({
      db,
      services: fakeServices(),
      workRoot: work,
      steps: allSteps(),
      monitorIntervalMs: 0,
      auth: { allowlist },
    });
    return { app, db };
  }

  it("rejects unauthenticated requests and accepts a valid signature", async () => {
    const wallet = await Secp256k1HdWallet.fromMnemonic(
      "surround miss nominee dream gap cross assault thank captain prosper drop duty group candy wealth weather scale put",
      { prefix: "akash" },
    );
    const [account] = await wallet.getAccounts();
    const address = account!.address;
    const { app } = await server([address]);

    // no token → 401
    expect((await app.inject({ method: "GET", url: "/api/fleet" })).statusCode).toBe(401);

    // nonce → signArbitrary → verify → token
    const nonce = (
      await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { address } })
    ).json() as { nonce: string };
    const { signature } = await wallet.signAmino(address, adr36SignDoc(address, nonce.nonce));
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { address, signature },
    });
    expect(verified.statusCode).toBe(200);
    const token = (verified.json() as { token: string }).token;

    const fleet = await app.inject({
      method: "GET",
      url: "/api/fleet",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fleet.statusCode).toBe(200);
  }, 60_000);

  it("rejects an address not on the allowlist", async () => {
    const wallet = await Secp256k1HdWallet.fromMnemonic(
      "special sign fit simple patrol salute grocery chicken wheat radar tonight ceiling",
      { prefix: "akash" },
    );
    const [account] = await wallet.getAccounts();
    const address = account!.address;
    const { app } = await server(["akash1someoneelse000000000000000000000000000"]);
    const nonce = (
      await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { address } })
    ).json() as { nonce: string };
    const { signature } = await wallet.signAmino(address, adr36SignDoc(address, nonce.nonce));
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { address, signature },
    });
    expect(verified.statusCode).toBe(401);
    expect((verified.json() as any).error).toContain("OPERATOR_ADDRESSES");
  }, 60_000);
});

describe("coordinated halt-height upgrade (M7)", () => {
  it("halts, swaps every image in one tx, and resumes", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({ topology: { validators: { count: 2 }, sentries: { count: 1 } } });
    // rebuild with a valid 2x1 topology
    const s2 = testnetSpec({
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
    void s;
    const services = fakeServices();
    const signer = new FakeSigner();
    db.createLaunch("hu", JSON.stringify(s2), "akash1owner");
    expect((await runWithSigner(db, "hu", s2, work, allSteps(), services, signer)).status).toBe(
      "completed",
    );

    const fleet = new FleetService(db, services, work);
    fleet.materialize("hu");
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v2.0.0";
    // fake sentry heights climb per status() call, so halt (>=H) and resume
    // (>H) are reached naturally
    fleet.requestHaltUpgrade(db.getLaunch("hu")!, image, 5);

    const sigsBefore = signer.signed.length;
    const steps = [...allSteps(), ...buildOpSteps(db, "hu")];
    const result = await runWithSigner(db, "hu", s2, work, steps, services, signer);
    expect(result.status).toBe("completed");

    // one batched tx: 4 node MsgUpdateDeployment + the flat upgrade fee
    const upgradeTxs = signer.signed.slice(sigsBefore);
    expect(upgradeTxs).toHaveLength(1);
    expect(upgradeTxs[0]!).toHaveLength(5);
    expect(upgradeTxs[0]!.slice(0, 4).every((m) => m.typeUrl.includes("MsgUpdateDeployment"))).toBe(true);
    const feeMsg = upgradeTxs[0]!.at(-1)!;
    expect(feeMsg.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    // 0.5 ACT at the fake $0.50 oracle price → 1 AKT (uact sends are disabled)
    expect((feeMsg.value as any).amount).toEqual([{ denom: "uakt", amount: "1000000" }]);
    // halt-height was set then cleared on every node
    const setHalt = services.ssh.execLog.filter((e) => e.command.includes("halt-height = 5"));
    const clearHalt = services.ssh.execLog.filter((e) => e.command.includes("halt-height = 0"));
    expect(setHalt.length).toBe(4);
    expect(clearHalt.length).toBe(4);
    expect(db.listFleetOps("hu")[0]!.status).toBe("done");
    db.close();
  }, 120_000);
});

describe("guided tmkms setup endpoint (M7)", () => {
  it("returns per-validator config with the consensus key and mesh IP", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({ security: { keyMode: "tmkms" } });
    const app = buildServer({
      db,
      services: fakeServices(),
      workRoot: work,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    db.createLaunch("tk", JSON.stringify(s), "akash1owner");
    // tmkms launch pauses at await-signer; drive until then
    const services = fakeServices();
    services.ssh.signerConnected = false;
    await runWithSigner(db, "tk", s, work, allSteps(), services, new FakeSigner());

    const res = await app.inject({ method: "GET", url: "/api/launches/tk/tmkms" });
    expect(res.statusCode).toBe(200);
    const setup = res.json() as any;
    expect(setup.chainId).toBe("sparkdream-1");
    expect(setup.validators).toHaveLength(1);
    expect(setup.validators[0].tmkmsToml).toContain("sparkdream-1");
    expect(setup.validators[0].tmkmsToml).toContain(":26659");
    // CometBFT v0.38 privval protocol with sign extensions (SDK 0.50 chains)
    expect(setup.validators[0].tmkmsToml).toContain('protocol_version = "v0.38"');
    expect(setup.validators[0].tmkmsToml).toContain("sign_extensions = true");
    expect(setup.validators[0].tailnetIp).toMatch(/^100\./);
    expect(setup.validators[0].consensusKey).toBeTruthy(); // key stays launcher-side (§3)
    expect(setup.validators[0].commands.join("\n")).toContain("--hostname tmkms-sparkdream");
    expect(setup.validators[0].commands.join("\n")).toContain("mkdir -p state secrets");
    db.close();
  }, 120_000);

  it("reports live signer status: mesh join and per-validator connection", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = spec({ security: { keyMode: "tmkms" } });
    // one fake world shared by the launch and the server: the status
    // endpoint's probes must see the same state the launch was driven with
    const services = fakeServices();
    const app = buildServer({
      db,
      services,
      workRoot: work,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    db.createLaunch("tk", JSON.stringify(s), "akash1owner");
    services.ssh.signerConnected = false;
    await runWithSigner(db, "tk", s, work, allSteps(), services, new FakeSigner());

    const before = await app.inject({ method: "GET", url: "/api/launches/tk/tmkms/status" });
    expect(before.statusCode).toBe(200);
    const s0 = before.json() as any;
    expect(s0.externalNodes).toEqual([]);
    expect(s0.validators).toHaveLength(1);
    expect(s0.validators[0].key).toBe("val-0");
    expect(s0.validators[0].tailnetIp).toMatch(/^100\./);
    expect(s0.validators[0].signerConnected).toBe(false);

    // the operator's laptop joins the mesh; tmkms connects to val-0
    services.provider.externalMeshNodes = [
      { name: "tmkms-sparkdream", ipAddresses: ["100.64.0.99"], online: true },
    ];
    services.ssh.signerConnected = true;

    const after = await app.inject({ method: "GET", url: "/api/launches/tk/tmkms/status" });
    const s1 = after.json() as any;
    expect(s1.externalNodes).toEqual([
      { name: "tmkms-sparkdream", ip: "100.64.0.99", online: true },
    ]);
    expect(s1.validators[0].signerConnected).toBe(true);
    db.close();
  }, 120_000);

  // a hardware signer already holds its consensus key: the spec pins the
  // pubkey, nothing is exported, and the panel checks the connected device
  // holds the pinned key instead of just "a signer is there"
  const PINNED = "OElT4VJpHCEW//d/q5FjCQ7i8EZURn49PSeB7MHp8ds=";
  const pinnedSpec = () =>
    spec({
      security: { keyMode: "tmkms" },
      topology: {
        validators: { count: 1, consensusPubkeys: [PINNED] },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });

  it("hardware signer (spec-pinned key): provider skeleton, no key export, live key match", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = pinnedSpec();
    const services = fakeServices();
    services.ssh.signerConnected = false;
    const app = buildServer({
      db,
      services,
      workRoot: work,
      steps: allSteps(),
      monitorIntervalMs: 0,
    });
    db.createLaunch("hw", JSON.stringify(s), "akash1owner");
    await runWithSigner(db, "hw", s, work, allSteps(), services, new FakeSigner());

    const res = await app.inject({ method: "GET", url: "/api/launches/hw/tmkms" });
    expect(res.statusCode).toBe(200);
    const setup = res.json() as any;
    const v0 = setup.validators[0];
    // the init-generated placeholder must not be offered: importing it would
    // sign with a key the chain never heard of
    expect(v0.consensusKey).toBeNull();
    expect(v0.expectedPubkey).toBe(PINNED);
    expect(v0.tmkmsToml).not.toContain("[[providers.softsign]]");
    expect(v0.tmkmsToml).toContain(PINNED);
    expect(v0.tmkmsToml).toContain("[[validator]]");
    const cmds = v0.commands.join("\n");
    expect(cmds).not.toContain("softsign import");
    expect(cmds).toContain(PINNED);
    expect(cmds).toContain("tmkms start -c tmkms-val-0.toml");

    // status: unknown until the signer connects (validator_info only exists
    // once a signer holds the session)
    let status = (await app.inject({ method: "GET", url: "/api/launches/hw/tmkms/status" })).json() as any;
    expect(status.validators[0].expectedPubkey).toBe(PINNED);
    expect(status.validators[0].pubkeyMatches).toBeNull();

    // connected with the WRONG key: a positive mismatch, not just "connected"
    services.ssh.signerConnected = true;
    services.ssh.statusConsensusPubkey = Buffer.alloc(32, 9).toString("base64");
    status = (await app.inject({ method: "GET", url: "/api/launches/hw/tmkms/status" })).json() as any;
    expect(status.validators[0].signerConnected).toBe(true);
    expect(status.validators[0].pubkeyMatches).toBe(false);

    // connected with the pinned key
    services.ssh.statusConsensusPubkey = PINNED;
    status = (await app.inject({ method: "GET", url: "/api/launches/hw/tmkms/status" })).json() as any;
    expect(status.validators[0].pubkeyMatches).toBe(true);
    db.close();
  }, 120_000);

  it("await-signer pauses on a confirmed key mismatch, passes once the signer holds the pin", async () => {
    const OTHER = Buffer.alloc(32, 9).toString("base64");
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const s = pinnedSpec();
    const services = fakeServices();
    services.ssh.signerConnected = true;
    services.ssh.statusConsensusPubkey = OTHER;
    db.createLaunch("gate", JSON.stringify(s), "akash1owner");

    const paused = await runWithSigner(db, "gate", s, work, allSteps(), services, new FakeSigner());
    expect(paused.status).toBe("awaiting-user");
    expect(paused.failedStep).toBe("await-signer");
    expect(paused.reason).toContain(PINNED);
    expect(paused.reason).toContain(OTHER);

    // the operator points the signer at the pinned key; resume completes
    services.ssh.statusConsensusPubkey = PINNED;
    const done = await runWithSigner(db, "gate", s, work, allSteps(), services, new FakeSigner());
    expect(done.status).toBe("completed");
    db.close();
  }, 120_000);
});

describe("multi-validator tmkms setup", () => {
  it("gives each validator its own state file and mesh hostname", async () => {
    const { buildTmkmsSetup } = await import("../src/tmkms.js");
    const s = spec({
      security: { keyMode: "tmkms" },
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
    const setup = buildTmkmsSetup({
      spec: s,
      chainId: "sparkdream-1",
      meshIps: { "val-0": "100.64.0.1", "val-1": "100.64.0.2" },
      nodeDir: () => "/nonexistent",
    });
    expect(setup.validators).toHaveLength(2);
    // each validator runs its own tmkms process; a shared double-sign
    // watermark file makes the signers refuse each other's heights
    const stateFiles = setup.validators.map(
      (v) => v.tmkmsToml.match(/^state_file = "(.+)"$/m)?.[1],
    );
    expect(stateFiles[0]).toBe("state/sparkdream-1-val-0-consensus.json");
    expect(stateFiles[1]).toBe("state/sparkdream-1-val-1-consensus.json");
    // distinct signer machines must not collide on one mesh hostname
    expect(setup.validators[0]!.commands.join("\n")).toContain(
      "--hostname tmkms-sparkdream-val-0",
    );
    expect(setup.validators[1]!.commands.join("\n")).toContain(
      "--hostname tmkms-sparkdream-val-1",
    );
    // single-validator fleets keep the legacy hostname and state path (no
    // churn for signers already running against a live launch)
    const single = buildTmkmsSetup({
      spec: spec({ security: { keyMode: "tmkms" } }),
      chainId: "sparkdream-1",
      meshIps: { "val-0": "100.64.0.1" },
      nodeDir: () => "/nonexistent",
    });
    expect(single.validators[0]!.commands.join("\n")).toContain(
      "--hostname tmkms-sparkdream\n",
    );
    expect(single.validators[0]!.tmkmsToml).toContain(
      'state_file = "state/sparkdream-1-consensus.json"',
    );
  });
});
