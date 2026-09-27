import fs from "node:fs";
import yaml from "js-yaml";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { writeSecretFile } from "../src/secrets.js";
import { durationMs, readSessions, renewAt, type SessionRecord } from "../src/sessions.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub, type ChainStub } from "./chain-stub.js";

/**
 * §5 session keys: the verifier and bridge daemons sign through x/session
 * grants the launcher makes, delivers, renews and revokes, so neither the
 * member's nor the operator's own key ever reaches a provider.
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-sessions-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DOMAIN = "mastodon.phoenix.example";
const vera = { name: "vera", generate: true, amount: "10000000000", member: { trustLevel: "established", dreamBalance: "1000000000" } };
const founder = { name: "founder", generate: true, amount: "1000000000000", member: true, council: { founder: true } };

function spec(components: Record<string, unknown>, type: "testnet" | "mainnet" = "testnet"): LaunchSpec {
  return testnetSpec({
    network: { name: "phoenix", type, bech32Prefix: "sprkdrm" },
    accounts: { initial: [founder, vera], validatorSelfDelegation: "1000000000000" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false }, ...components },
      publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" },
      headscale: { domain: "hs.example" },
    },
  });
}
const mastodon = { enabled: true, domain: DOMAIN, owner: { username: "admin", email: "admin@phoenix.example" }, bridge: { enabled: true } };
const verifier = { enabled: true, account: "vera" };

async function launched(components: Record<string, unknown>, chain: ChainStub) {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const s = spec(components);
  // the bridge operator's genesis funding, which the stub cannot see
  chain.edit((st) => (st.defaultBalances = { [s.token.baseDenom]: "2000000000" }));
  db.createLaunch("fl", JSON.stringify(s), "akash1owner");
  const result = await withStub(chain, () => runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner()));
  expect(result.reason ?? "").toBe("");
  expect(result.status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  const secrets = launchDirs(work, "fl").secrets;
  const runOps = () =>
    withStub(chain, () =>
      runWithSigner(db, "fl", s, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")], services, new FakeSigner()),
    );
  return { work, db, services, fleet, secrets, spec: s, runOps };
}

const grants = (chain: ChainStub) => Object.values(chain.state().chains).flatMap((c) => Object.values(c.sessions ?? {}));

function editRecord(secrets: string, role: string, patch: Partial<SessionRecord>): void {
  const all = readSessions(secrets);
  all[role] = { ...all[role]!, ...patch };
  writeSecretFile(path.join(secrets, "sessions.json"), JSON.stringify(all));
}

describe("session keys at launch", () => {
  it("grants each daemon a scoped, budgeted session from its own account and delivers the key", async () => {
    const chain = chainStub();
    const { db, services, secrets } = await launched({ mastodon, verifier }, chain);
    const sessions = readSessions(secrets);
    const accounts = db.stepOutput<any>("fl", "generate-keys")!.accounts;
    const rows = db.listFleetComponents("fl");

    expect(sessions.verifier!.granter).toBe(accounts["acct-vera"]);
    expect(sessions.bridge!.granter).toBe(fs.readFileSync(path.join(secrets, "bridge-operator.address"), "utf8").trim());
    const byGrantee = new Map(grants(chain).map((g) => [g.grantee, g]));
    expect(byGrantee.get(sessions.verifier!.grantee)).toMatchObject({
      signer: "acct-vera",
      allowed_msg_types: ["/sparkdream.federation.v1.MsgVerifyContent"],
    });
    expect(byGrantee.get(sessions.bridge!.grantee)).toMatchObject({
      signer: "bridge-operator",
      allowed_msg_types: ["/sparkdream.federation.v1.MsgSubmitFederatedContent"],
    });
    // the grantee's auth account is created with the grant: it must exist to sign
    const balances = chain.state().balances!;
    expect(Object.keys(balances[sessions.verifier!.grantee]!)).toHaveLength(1);

    // delivered into the right service of the right deployment
    const dseq = (key: string) => rows.find((c) => c.key === key)!.dseq;
    expect(services.provider.sessionKeys.get(`${dseq("verifier")}/verifier`)).toBe(sessions.verifier!.mnemonic);
    expect(services.provider.sessionKeys.get(`${dseq("mastodon")}/bridge`)).toBe(sessions.bridge!.mnemonic);

    // 90 days on a testnet (inside the chain's ceiling), renewed at 60
    const lifetime = Date.parse(sessions.verifier!.expiresAt) - Date.parse(sessions.verifier!.createdAt);
    expect(lifetime).toBeGreaterThan(89 * 86_400_000);
    expect(lifetime).toBeLessThanOrEqual(90 * 86_400_000);
    expect(renewAt(sessions.verifier!)).toBeCloseTo(Date.parse(sessions.verifier!.createdAt) + (2 * lifetime) / 3, -3);
    db.close();
  }, 180_000);

  it("keeps inside a chain whose ceiling is shorter than the spec asks", async () => {
    const chain = chainStub();
    chain.edit((st) => (st.sessionMaxExpiration = "168h0m0s"));
    const { db, secrets } = await launched({ mastodon, verifier }, chain);
    const r = readSessions(secrets).verifier!;
    expect(Date.parse(r.expiresAt) - Date.parse(r.createdAt)).toBeLessThanOrEqual(7 * 86_400_000);
    db.close();
  }, 180_000);

  it("writes the session ceiling into genesis: 90 days on a testnet", async () => {
    const chain = chainStub();
    const { work, db } = await launched({}, chain);
    const genesis = JSON.parse(fs.readFileSync(path.join(launchDirs(work, "fl").node("val-0"), "config", "genesis.json"), "utf8"));
    expect(genesis.app_state.session.params.max_expiration).toBe(`${90 * 86_400}s`);
    db.close();
  }, 180_000);
});

describe("session keys on a running fleet", () => {
  it("renews unattended with a third of the lifetime left, and revokes the key it replaces", async () => {
    const chain = chainStub();
    const { db, services, fleet, secrets, runOps } = await launched({ verifier, mastodon }, chain);
    expect(await fleet.sessionsDue("fl")).toBe(false);

    const old = readSessions(secrets).verifier!;
    // 61 of 90 days gone
    editRecord(secrets, "verifier", {
      createdAt: new Date(Date.now() - 61 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() + 29 * 86_400_000).toISOString(),
    });
    expect(await fleet.sessionsDue("fl")).toBe(true);
    expect(fleet.requestSessions(db.getLaunch("fl")!)).toBeGreaterThan(0);
    // the monitor never piles a second one on
    expect(fleet.requestSessions(db.getLaunch("fl")!)).toBeUndefined();
    const done = await runOps();
    expect(done.status).toBe("completed");

    const fresh = readSessions(secrets).verifier!;
    expect(fresh.grantee).not.toBe(old.grantee);
    expect(fresh.pendingRevoke).toEqual([]);
    const live = grants(chain).map((g) => g.grantee);
    expect(live).toContain(fresh.grantee);
    expect(live).not.toContain(old.grantee);
    const dseq = db.listFleetComponents("fl").find((c) => c.key === "verifier")!.dseq;
    expect(services.provider.sessionKeys.get(`${dseq}/verifier`)).toBe(fresh.mnemonic);
    // the bridge's key was not due: untouched
    expect(live).toContain(readSessions(secrets).bridge!.grantee);
    expect(await fleet.sessionsDue("fl")).toBe(false);
    db.close();
  }, 240_000);

  it("rotates a key the daemon took to another deployment, and one the chain lost", async () => {
    const chain = chainStub();
    const { db, fleet, secrets, runOps } = await launched({ verifier, mastodon }, chain);
    const before = readSessions(secrets);

    // the provider that ran the old deployment keeps a copy of its key
    editRecord(secrets, "verifier", { dseq: "999999" });
    // an outside revoke (or a chain reset) took the bridge's grant
    chain.edit((st) => {
      for (const c of Object.values(st.chains)) {
        for (const k of Object.keys(c.sessions ?? {})) if (k.endsWith(`/${before.bridge!.grantee}`)) delete c.sessions![k];
      }
    });
    expect(await fleet.sessionsDue("fl")).toBe(true);
    fleet.requestSessions(db.getLaunch("fl")!);
    expect((await runOps()).status).toBe("completed");

    const after = readSessions(secrets);
    expect(after.verifier!.grantee).not.toBe(before.verifier!.grantee);
    expect(after.bridge!.grantee).not.toBe(before.bridge!.grantee);
    const live = grants(chain).map((g) => g.grantee);
    expect(live).not.toContain(before.verifier!.grantee);
    expect(live.sort()).toEqual([after.verifier!.grantee, after.bridge!.grantee].sort());
    db.close();
  }, 240_000);

  it("rotates on request, and retires the grant of a daemon that is gone", async () => {
    const chain = chainStub();
    const { db, fleet, secrets, runOps } = await launched({ verifier, mastodon }, chain);
    const before = readSessions(secrets);

    expect(() => fleet.requestSessions(db.getLaunch("fl")!, ["verifier"])).not.toThrow();
    expect(() => fleet.requestSessions(db.getLaunch("fl")!, ["verifier"])).toThrow(/in progress/);
    expect((await runOps()).status).toBe("completed");
    const rotated = readSessions(secrets);
    expect(rotated.verifier!.grantee).not.toBe(before.verifier!.grantee);
    expect(rotated.bridge!.grantee).toBe(before.bridge!.grantee);

    // the verifier's deployment closes: its grant goes with it
    db.setComponentState("fl", "verifier", "closed");
    expect(await fleet.sessionsDue("fl")).toBe(true);
    fleet.requestSessions(db.getLaunch("fl")!);
    expect((await runOps()).status).toBe("completed");
    expect(readSessions(secrets).verifier).toBeUndefined();
    expect(grants(chain).map((g) => g.grantee)).toEqual([rotated.bridge!.grantee]);
    db.close();
  }, 240_000);
});

describe("session key funding", () => {
  it("asks a wallet to top up a granter with nothing spendable, then grants once funded", async () => {
    const chain = chainStub();
    const { db, secrets, spec: s, runOps, fleet } = await launched({ verifier, mastodon }, chain);
    const vAddr = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    // vera's DREAM is bonded and her SPARK spent: nothing left to create the key's account
    chain.edit((st) => (st.balances = { [vAddr]: { [s.token.baseDenom]: "0" } }));
    fleet.requestSessions(db.getLaunch("fl")!, ["verifier"]);
    const paused = await runOps();
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(new RegExp(`fund the verifier account ${vAddr} with \\d+`));
    const step = db.listSteps("fl").find((x) => x.status === "waiting")!;
    const wallet = JSON.parse(step.wallet_json!);
    expect(wallet.msgs[0]).toMatchObject({ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: "<signer>", to_address: vAddr });
    expect(wallet.encoded[0].typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");

    // someone funds it: the rotation goes through
    const before = readSessions(secrets).verifier!.grantee;
    chain.edit((st) => (st.balances = { [vAddr]: { [s.token.baseDenom]: "1000000000" } }));
    expect((await runOps()).status).toBe("completed");
    expect(readSessions(secrets).verifier!.grantee).not.toBe(before);
    db.close();
  }, 240_000);
});

describe("durationMs", () => {
  it("reads the CLI's Go durations and genesis's seconds", () => {
    expect(durationMs("168h0m0s")).toBe(7 * 86_400_000);
    expect(durationMs("2160h0m0s")).toBe(90 * 86_400_000);
    expect(durationMs("604800s")).toBe(7 * 86_400_000);
    expect(() => durationMs("soon")).toThrow();
  });
});

describe("a verifier acting as a wallet member", () => {
  /** A launch whose verifier is `wallet`, a member the launcher holds no key for. */
  async function walletLaunch(chain: ChainStub, trust = "TRUST_LEVEL_ESTABLISHED") {
    const [acct] = await (await Secp256k1HdWallet.generate(12, { prefix: "sprkdrm" })).getAccounts();
    const member = acct!.address;
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec({ mastodon, verifier: { enabled: true, wallet: member } });
    chain.edit((st) => {
      st.defaultBalances = { [s.token.baseDenom]: "2000000000" };
      st.members = { [member]: { trust_level: trust, dream_balance: "1000000000", staked_dream: "0" } };
    });
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    const run = (steps = allSteps()) => withStub(chain, () => runWithSigner(db, "fl", s, work, steps, services, new FakeSigner()));
    const waiting = () => {
      const step = db.listSteps("fl").find((x) => x.status === "waiting");
      return step?.wallet_json ? JSON.parse(step.wallet_json) : undefined;
    };
    /** What the pause card does: the member's wallet signs and broadcasts. */
    const sign = (asWho = member) => {
      const req = waiting();
      expect(req.signer).toBe(member);
      const node = chain.state().log.at(-1)!.node;
      const doc = path.join(tmp(), "tx.json");
      fs.writeFileSync(doc, JSON.stringify({ body: { messages: req.msgs }, __from: asWho }));
      execFileSync(chain.bin, ["tx", "broadcast", doc, "--node", node]);
    };
    const secrets = launchDirs(work, "fl").secrets;
    return { db, services, work, secrets, member, spec: s, run, waiting, sign };
  }

  it("bonds and grants through the member's own wallet, then delivers the key that wallet granted", async () => {
    const chain = chainStub();
    const { db, services, work, secrets, member, run, waiting, sign } = await walletLaunch(chain);

    // 1. the bond: the member's own MsgBondRole, for that address only
    expect((await run()).status).toBe("awaiting-user");
    expect(waiting().msgs).toEqual([
      { "@type": "/sparkdream.rep.v1.MsgBondRole", creator: member, role_type: "ROLE_TYPE_FEDERATION_VERIFIER", amount: "500000000" },
    ]);
    sign();

    // 2. the session grant, recorded as pending before anything is signed
    expect((await run()).status).toBe("awaiting-user");
    const pending = readSessions(secrets).verifier!;
    expect(pending).toMatchObject({ granter: member, pending: true });
    expect(waiting().msgs.map((m: any) => m["@type"].split(".").pop())).toEqual(["MsgSend", "MsgCreateSession"]);
    expect(waiting().msgs[1]).toMatchObject({ granter: member, grantee: pending.grantee });

    // an unsigned resume asks again for the same key, not a new one
    expect((await run()).status).toBe("awaiting-user");
    expect(readSessions(secrets).verifier!.grantee).toBe(pending.grantee);

    // 3. signed: that key is the one delivered, and the launch finishes
    sign();
    expect((await run()).status).toBe("completed");
    const granted = readSessions(secrets).verifier!;
    expect(granted).toMatchObject({ grantee: pending.grantee, pending: false });
    new FleetService(db, services, work).materialize("fl");
    const dseq = db.listFleetComponents("fl").find((c) => c.key === "verifier")!.dseq;
    expect(services.provider.sessionKeys.get(`${dseq}/verifier`)).toBe(granted.mnemonic);
    // the launcher never signed as the member
    expect(chain.state().log.filter((l) => l.types.some((t) => /MsgBondRole|MsgCreateSession/.test(t)) && l.from === member)).toHaveLength(2);
    db.close();
  }, 240_000);

  it("rotates by asking the wallet for the new grant and the old key's revoke in one signature", async () => {
    const chain = chainStub();
    const { db, work, secrets, member, spec: s, run, sign } = await walletLaunch(chain);
    for (let i = 0; i < 3 && (await run()).status === "awaiting-user"; i++) sign();
    const first = readSessions(secrets).verifier!.grantee;

    const fleet = new FleetService(db, fakeServices(), work);
    fleet.materialize("fl");
    fleet.requestSessions(db.getLaunch("fl")!, ["verifier"]);
    const ops = () => run([...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")]);
    expect((await ops()).status).toBe("awaiting-user");
    const next = readSessions(secrets).verifier!;
    expect(next.grantee).not.toBe(first);
    const req = JSON.parse(db.listSteps("fl").find((x) => x.status === "waiting")!.wallet_json!);
    expect(req.msgs.map((m: any) => m["@type"].split(".").pop())).toEqual(["MsgSend", "MsgCreateSession", "MsgRevokeSession"]);
    expect(req.msgs[2]).toMatchObject({ granter: member, grantee: first });

    sign();
    expect((await ops()).status).toBe("completed");
    // the member's grants: only the new one is left (the bridge's is its own)
    expect(grants(chain).filter((g) => g.granter === member).map((g) => g.grantee)).toEqual([next.grantee]);
    expect(readSessions(secrets).verifier).toMatchObject({ grantee: next.grantee, pending: false, pendingRevoke: [] });
    expect(s.topology.components.verifier!.wallet).toBe(member);
    db.close();
  }, 300_000);

  it("explains a member below ESTABLISHED instead of asking the wallet for a bond the chain refuses", async () => {
    const chain = chainStub();
    const { db, run, waiting } = await walletLaunch(chain, "TRUST_LEVEL_PROVISIONAL");
    const paused = await run();
    expect(paused.status).toBe("awaiting-user");
    expect(paused.reason).toMatch(/is provisional on .*must be ESTABLISHED or above/);
    expect(waiting()).toBeUndefined();
    db.close();
  }, 180_000);
});

describe("a chain reset with a bridge and a verifier", () => {
  it("re-links both on their deployments, keeps the bridge operator's key and re-points the verifier at its new member", async () => {
    const chain = chainStub();
    const { db, work, secrets, spec: s, runOps, fleet, services } = await launched({ mastodon, verifier }, chain);
    const operator = fs.readFileSync(path.join(secrets, "bridge-operator.address"), "utf8").trim();
    const oldVera = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    const dseqs = () => Object.fromEntries(db.listFleetComponents("fl").map((c) => [c.key, c.dseq]));
    const before = dseqs();

    fleet.requestChainReset(db.getLaunch("fl")!, JSON.parse(db.getLaunch("fl")!.spec_json));
    expect(db.listFleetOps("fl", "active").map((o) => o.kind)).toEqual(["reset-chain", "reconfigure", "sessions"]);
    expect(JSON.parse(db.listFleetOps("fl", "active")[1]!.params_json)).toEqual({ keys: ["mastodon", "verifier"] });

    // parked between the wipe and the restart: the new chain has none of the old state
    expect((await runOps()).status).toBe("awaiting-user");
    chain.edit((st) => {
      st.chains = {};
      st.balances = {};
    });
    const done = await runOps();
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");

    // the same deployments: nothing was relaunched
    expect(dseqs()).toEqual(before);
    // the operator kept its key, so the running bridge's granter still holds
    expect(fs.readFileSync(path.join(secrets, "bridge-operator.address"), "utf8").trim()).toBe(operator);
    expect(db.stepOutput<any>("fl", "generate-keys")!.accounts["bridge-operator"]).toBe(operator);
    const st = chain.state();
    const node = Object.values(st.chains).find((c) => c.peers?.[DOMAIN])!;
    expect(node.peers[DOMAIN]).toMatchObject({ status: "PEER_STATUS_ACTIVE" });
    expect(Object.keys(node.bindings ?? {})).toEqual([`${operator}/${DOMAIN}`]);

    // vera was re-keyed with the rest: bonded again as her new self, and the
    // verifier's env names her new address
    const vera = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    expect(vera).not.toBe(oldVera);
    expect(node.roles?.[`federation-verifier/${vera}`]).toMatchObject({ signer: "acct-vera" });
    const sdl = fs.readFileSync(path.join(work, "launches", "fl", "sdl", "verifier.yaml"), "utf8");
    expect(sdl).toContain(`SDA_GRANTER=${vera}`);
    expect(sdl).not.toContain(oldVera);
    // and both daemons hold fresh grants from their accounts
    const sessions = readSessions(secrets);
    expect(sessions.bridge!.granter).toBe(operator);
    expect(sessions.verifier!.granter).toBe(vera);
    expect(grants(chain).map((g) => g.grantee).sort()).toEqual([sessions.bridge!.grantee, sessions.verifier!.grantee].sort());
    expect(services.provider.sessionKeys.get(`${before.verifier}/verifier`)).toBe(sessions.verifier!.mnemonic);
    expect(s.topology.components.mastodon!.bridge!.enabled).toBe(true);
    db.close();
  }, 300_000);
});

describe("a bridge anchoring for other servers as peers of their own", () => {
  it("registers and binds each server, closed by default, and keeps the bridge's and verifier's peer lists in step", async () => {
    const chain = chainStub();
    const withPeers = { ...mastodon, bridge: { enabled: true, peers: [{ id: "aurora.example" }] } };
    const { db, work, secrets, fleet, runOps } = await launched({ mastodon: withPeers, verifier }, chain);
    const operator = fs.readFileSync(path.join(secrets, "bridge-operator.address"), "utf8").trim();
    const node = () => Object.values(chain.state().chains).find((c) => c.peers?.[DOMAIN])!;
    const env = (file: string, service: string) =>
      (yaml.load(fs.readFileSync(path.join(work, "launches", "fl", "sdl", file), "utf8")) as any).services[service].env as string[];

    // the other server: an ACTIVE ActivityPub peer that admits nobody yet,
    // bound to the same operator on its existing bond
    expect(node().peers["aurora.example"]).toMatchObject({ type: "PEER_TYPE_ACTIVITYPUB", status: "PEER_STATUS_ACTIVE" });
    expect(node().policies["aurora.example"]).toMatchObject({ allowed_identities: [] });
    expect(node().policies[DOMAIN]).toMatchObject({ allowed_identities: ["*"] });
    expect(node().bindings![`${operator}/aurora.example`]).toMatchObject({ stake: "0", signer: "bridge-operator" });
    expect(env("mastodon.yaml", "bridge")).toContain(`SDA_PEER_IDS=${DOMAIN},aurora.example`);
    expect(env("verifier.yaml", "verifier")).toContain(`SDA_PEER_IDS=${DOMAIN},aurora.example`);

    // a server added on the running fleet: registered, bound, and both
    // daemons told, in place
    const before = db.listFleetComponents("fl").map((c) => c.dseq).sort();
    const ops = fleet.requestBridgePeers(db.getLaunch("fl")!, ["aurora.example", "zenith.example"]);
    expect(ops).toHaveLength(1);
    expect(JSON.parse(db.listFleetOps("fl").find((o) => o.id === ops[0]!.opId)!.params_json)).toEqual({ keys: ["mastodon", "verifier"] });
    const done = await runOps();
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");
    expect(db.listFleetComponents("fl").map((c) => c.dseq).sort()).toEqual(before);
    expect(node().peers["zenith.example"]).toMatchObject({ status: "PEER_STATUS_ACTIVE" });
    expect(Object.keys(node().bindings!).filter((k) => k.startsWith(operator)).sort()).toEqual(
      [`${operator}/${DOMAIN}`, `${operator}/aurora.example`, `${operator}/zenith.example`].sort(),
    );
    expect(env("mastodon.yaml", "bridge")).toContain(`SDA_PEER_IDS=${DOMAIN},aurora.example,zenith.example`);
    expect(env("verifier.yaml", "verifier")).toContain(`SDA_PEER_IDS=${DOMAIN},aurora.example,zenith.example`);
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).topology.components.mastodon.bridge.peers).toEqual([
      { id: "aurora.example" },
      { id: "zenith.example" },
    ]);

    // this instance itself is not an "other" server
    expect(() => fleet.requestBridgePeers(db.getLaunch("fl")!, [DOMAIN])).toThrow(/own peer/);
    db.close();
  }, 300_000);
});

describe("upgrading a Mastodon deployment's side images", () => {
  it("swaps only the bridge for an sdap image, and records it as the spec's sdap image", async () => {
    const chain = chainStub();
    const { db, work, fleet, runOps } = await launched({ mastodon, verifier }, chain);
    const sdl = (file: string) => yaml.load(fs.readFileSync(path.join(work, "launches", "fl", "sdl", file), "utf8")) as any;
    const before = sdl("mastodon.yaml").services;
    const row = () => db.listFleetComponents("fl").find((c) => c.key === "mastodon")!;
    const rowImage = row().image;
    const verifierImage = sdl("verifier.yaml").services.verifier.image;

    fleet.requestUpgrade(db.getLaunch("fl")!, ["mastodon"], "sparkdreamnft/sdap:v9.9.9");
    const done = await runOps();
    expect(done.reason ?? "").toBe("");
    expect(done.status).toBe("completed");

    const after = sdl("mastodon.yaml").services;
    expect(after.bridge.image).toBe("sparkdreamnft/sdap:v9.9.9");
    expect(after.mastodon.image).toBe(before.mastodon.image);
    expect(after.streaming.image).toBe(before.streaming.image);
    expect(after.db.image).toBe(before.db.image);
    // the row still shows the web image; the verifier is its own deployment
    expect(row().image).toBe(rowImage);
    expect(sdl("verifier.yaml").services.verifier.image).toBe(verifierImage);
    const images = JSON.parse(db.getLaunch("fl")!.spec_json).images;
    expect(images.sdap).toBe("sparkdreamnft/sdap:v9.9.9");
    expect(images.mastodon).toBe(before.mastodon.image);

    // the web image itself still upgrades the main service
    fleet.requestUpgrade(db.getLaunch("fl")!, ["mastodon"], "sparkdreamnft/mastodon:v9.9.9");
    expect((await runOps()).status).toBe("completed");
    expect(sdl("mastodon.yaml").services.mastodon.image).toBe("sparkdreamnft/mastodon:v9.9.9");
    expect(sdl("mastodon.yaml").services.bridge.image).toBe("sparkdreamnft/sdap:v9.9.9");
    expect(row().image).toBe("sparkdreamnft/mastodon:v9.9.9");
    db.close();
  }, 300_000);
});

