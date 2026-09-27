import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, validateSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub } from "./chain-stub.js";
import { readSecretFile } from "../src/secrets.js";
import { readSessions } from "../src/sessions.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-verifier-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DOMAIN = "mastodon.phoenix.example";
const vera = { name: "vera", generate: true, amount: "10000000000", member: { trustLevel: "established", dreamBalance: "1000000000" } };
const founder = { name: "founder", generate: true, amount: "1000000000000", member: true, council: { founder: true } };

function spec(name: string, components: Record<string, unknown>, extra: Record<string, unknown> = {}): LaunchSpec {
  return testnetSpec({
    network: { name, type: "testnet", bech32Prefix: "sprkdrm" },
    accounts: { initial: [founder, vera], validatorSelfDelegation: "1000000000000" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false }, ...components },
      publicEndpoints: { api: `api.${name}.example`, rpc: `rpc.${name}.example` },
      ...extra,
    },
  });
}
const mastodon = { enabled: true, domain: DOMAIN, owner: { username: "admin", email: "admin@phoenix.example" } };

function ops(db: ConductorDb, id: string) {
  return [...buildPreLaunchOpSteps(db, id), ...allSteps(), ...buildOpSteps(db, id)];
}

describe("verifier spec", () => {
  it("needs a generated ESTABLISHED member of the chain, and peers to verify", () => {
    const ok = spec("phoenix", { mastodon, verifier: { enabled: true, account: "vera" } }, { headscale: { domain: "hs.example" } });
    expect(validateSpec(ok).errors).toEqual([]);
    expect(validateSpec(ok).warnings.some((w) => w.path === "topology.components.verifier")).toBe(true);
    const founderIsNotEstablished = spec("phoenix", { mastodon, verifier: { enabled: true, account: "founder" } }, { headscale: { domain: "hs.example" } });
    expect(validateSpec(founderIsNotEstablished).errors.map((e) => e.path)).toContain("topology.components.verifier.account");
    const nobody = spec("phoenix", { verifier: { enabled: true, account: "vera" } }, { headscale: { domain: "hs.example" } });
    expect(validateSpec(nobody).errors.map((e) => e.path)).toContain("topology.components.verifier.peers");
  });
});

describe("verifier on its own fleet", () => {
  it("added beside Mastodon: off its provider, runs sdapverify as vera, bonds with vera's key", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec("phoenix", { mastodon }, { headscale: { domain: "hs.example" } });
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    const launched = await runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner());
    expect(launched.status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    const mastodonProvider = db.listFleetComponents("fl").find((c) => c.key === "mastodon")!.provider;

    fleet.requestAddComponent(db.getLaunch("fl")!, "verifier", { settings: { account: "vera" } });
    const chain = chainStub();
    // genesis funds vera, which the stub cannot see: her session key's grant needs it spendable
    chain.edit((st) => (st.defaultBalances = { "uspark.sparkdreamtest": "10000000000" }));
    const done = await withStub(chain, () => runWithSigner(db, "fl", s, work, ops(db, "fl"), services, new FakeSigner()));
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");

    const row = db.listFleetComponents("fl").find((c) => c.key === "verifier")!;
    expect(row.state).toBe("active");
    expect(row.provider).not.toBe(mastodonProvider);

    const sdl = yaml.load(fs.readFileSync(path.join(work, "launches", "fl", "sdl", "verifier.yaml"), "utf8")) as any;
    const svc = sdl.services.verifier;
    // args only: the image's entrypoint readies /data, then drops privileges
    expect(svc.command).toBeUndefined();
    expect(svc.args).toEqual(["sdapverify"]);
    // it listens on nothing, but a provider refuses a manifest with no
    // global service: one plain TCP port, no ingress hostname
    expect(svc.expose).toEqual([{ port: 8080, as: 8080, proto: "tcp", to: [{ global: true }] }]);
    expect(svc.params.storage.state.mount).toBe("/data");
    const vAddr = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    const mnemonics = JSON.parse(readSecretFile(path.join(work, "launches", "fl", "secrets", "mnemonics.json")));
    expect(svc.env).toEqual(
      expect.arrayContaining([
        "SDA_SESSION_KEY_FILE=/data/session-key",
        `SDA_GRANTER=${vAddr}`,
        `SDA_PEER_IDS=${DOMAIN}`,
        "SDA_LCD=https://api.phoenix.example",
      ]),
    );
    // vera's own key holds her DREAM bond: it never reaches the provider
    expect(JSON.stringify(sdl)).not.toContain(mnemonics["acct-vera"]);

    // bonded as federation-verifier, signed by vera herself
    const st = Object.values(chain.state().chains)[0]!;
    expect(st.roles![`federation-verifier/${vAddr}`]).toMatchObject({ current_bond: "500000000", signer: "acct-vera" });

    // a session for the daemon: granted by vera, scoped to MsgVerifyContent,
    // its key delivered into the verifier's container
    const sessions = readSessions(path.join(work, "launches", "fl", "secrets"));
    const grant = st.sessions![`${vAddr}/${sessions.verifier!.grantee}`]!;
    expect(grant).toMatchObject({
      signer: "acct-vera",
      allowed_msg_types: ["/sparkdream.federation.v1.MsgVerifyContent"],
      spend_limit: { amount: "25000000" },
    });
    expect(services.provider.sessionKeys.get(`${row.dseq}/verifier`)).toBe(sessions.verifier!.mnemonic);
    db.close();
  }, 180_000);

  it("pauses with what is missing when the member lacks the DREAM", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec("phoenix", { mastodon }, { headscale: { domain: "hs.example" } });
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    expect((await runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner())).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    fleet.requestAddComponent(db.getLaunch("fl")!, "verifier", { settings: { account: "vera" } });
    const chain = chainStub();
    // genesis funds vera, which the stub cannot see: her session key's grant needs it spendable
    chain.edit((st) => (st.defaultBalances = { "uspark.sparkdreamtest": "10000000000" }));
    chain.edit((st) => (st.dreamShort = true));
    const paused = await withStub(chain, () => runWithSigner(db, "fl", s, work, ops(db, "fl"), services, new FakeSigner()));
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/vera .* needs 500000000 more micro-DREAM/);
    db.close();
  }, 180_000);
});

describe("verifier in the launch", () => {
  it("placed in the same batch as Mastodon but never on its provider, bonded at the end of the launch", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec("phoenix", { mastodon, verifier: { enabled: true, account: "vera" } }, { headscale: { domain: "hs.example" } });
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    const chain = chainStub();
    // genesis funds vera, which the stub cannot see: her session key's grant needs it spendable
    chain.edit((st) => (st.defaultBalances = { "uspark.sparkdreamtest": "10000000000" }));
    const result = await withStub(chain, () => runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner()));
    expect(result.reason ?? "").toBe("");
    expect(result.status).toBe("completed");
    const assignments = db.stepOutput<any>("fl", "collect-bids")!.perNode;
    expect(assignments.verifier.provider).not.toBe(assignments.mastodon.provider);
    expect(db.stepOutput<any>("fl", "configure-verifier")).toMatchObject({ account: "vera", bonded: true });
    db.close();
  }, 180_000);
});

describe("verifier of another fleet", () => {
  it("watches the target's chain as the target's member, off the target's Mastodon provider", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const fleet = new FleetService(db, services, work);
    const a = spec("phoenix", { mastodon }, { headscale: { domain: "hs.example" } });
    db.createLaunch("fleet-a", JSON.stringify(a), "akash1owner");
    expect((await runWithSigner(db, "fleet-a", a, work, allSteps(), services, new FakeSigner())).status).toBe("completed");
    fleet.materialize("fleet-a");
    const b = spec("aurora", {}, { headscale: { domain: "hs2.example" } });
    db.createLaunch("fleet-b", JSON.stringify(b), "akash1owner");
    expect((await runWithSigner(db, "fleet-b", b, work, allSteps(), services, new FakeSigner())).status).toBe("completed");
    fleet.materialize("fleet-b");

    // the target's founder is not an ESTABLISHED member: refused, nothing stored
    expect(() =>
      fleet.requestAddComponent(db.getLaunch("fleet-b")!, "verifier", { settings: { account: "founder", target: { fleet: "phoenix" } } }),
    ).toThrow(/ESTABLISHED/);
    expect((JSON.parse(db.getLaunch("fleet-b")!.spec_json) as LaunchSpec).topology.components.verifier).toBeUndefined();

    // by network name: resolved to the launch id and checked
    fleet.requestAddComponent(db.getLaunch("fleet-b")!, "verifier", {
      settings: { account: "vera", target: { fleet: "phoenix" } },
    });
    const stored = JSON.parse(db.getLaunch("fleet-b")!.spec_json) as LaunchSpec;
    expect(stored.topology.components.verifier!.target).toEqual({ fleet: "fleet-a" });

    const chain = chainStub();
    // genesis funds vera, which the stub cannot see: her session key's grant needs it spendable
    chain.edit((st) => (st.defaultBalances = { "uspark.sparkdreamtest": "10000000000" }));
    const done = await withStub(chain, () => runWithSigner(db, "fleet-b", b, work, ops(db, "fleet-b"), services, new FakeSigner()));
    expect(done.reason ?? "").toBe("");
    const aMastodon = db.listFleetComponents("fleet-a").find((c) => c.key === "mastodon")!.provider;
    expect(db.listFleetComponents("fleet-b").find((c) => c.key === "verifier")!.provider).not.toBe(aMastodon);
    const sdl = yaml.load(fs.readFileSync(path.join(work, "launches", "fleet-b", "sdl", "verifier.yaml"), "utf8")) as any;
    expect(sdl.services.verifier.env).toContain("SDA_LCD=https://api.phoenix.example");
    // bonded on fleet A's chain, by fleet A's vera
    const aVera = db.stepOutput<any>("fleet-a", "generate-keys")!.accounts["acct-vera"];
    const bonded = Object.values(chain.state().chains).find((c) => c.roles?.[`federation-verifier/${aVera}`]);
    expect(bonded).toBeTruthy();
    db.close();
  }, 240_000);
});
