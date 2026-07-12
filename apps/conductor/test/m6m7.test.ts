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
    expect(setup.validators[0].tailnetIp).toMatch(/^100\./);
    expect(setup.validators[0].consensusKey).toBeTruthy(); // key stays launcher-side (§3)
    db.close();
  }, 120_000);
});
