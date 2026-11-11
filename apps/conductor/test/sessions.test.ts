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
import { battleWeb3Options } from "../src/battle-options.js";
import { resolveBattleTarget } from "../src/battle.js";
import { BATTLE_CLASSES, battleClassList } from "../src/steps/battle.js";
import { writeSecretFile } from "../src/secrets.js";
import { durationMs, grantHolds, grantLink, keyFunding, readSessions, renewAt, type SessionRecord } from "../src/sessions.js";
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

/** The game's /chain-status as battle-royale v1.0.4 serves it (BRMAP dropped). */
const GAME_CLASSES = BATTLE_CLASSES.filter((c) => c.symbol !== "BRMAP");
function serveGame(services: ReturnType<typeof fakeServices>): void {
  services.rpc.texts.set("battle.phoenix.example/chain-status", JSON.stringify({ enabled: false, classes: GAME_CLASSES }));
}

async function launched(components: Record<string, unknown>, chain: ChainStub, chainParams?: Partial<LaunchSpec["chainParams"]>) {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  serveGame(services);
  const s = spec(components);
  if (chainParams) s.chainParams = { ...s.chainParams, ...chainParams };
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

const s0 = (db: ConductorDb): LaunchSpec => JSON.parse(db.getLaunch("fl")!.spec_json);
const grants = (chain: ChainStub) => Object.values(chain.state().chains).flatMap((c) => Object.values(c.sessions ?? {}));

function editRecord(secrets: string, role: string, patch: Partial<SessionRecord>): void {
  const all = readSessions(secrets);
  all[role] = { ...all[role]!, ...patch };
  writeSecretFile(path.join(secrets, "sessions.json"), JSON.stringify(all));
}

describe("the battle game's session key", () => {
  const battle = { enabled: true, domain: "battle.phoenix.example" };

  it("with a launcher-generated account: creates the game's classes with its key, then grants mints and updates only", async () => {
    const chain = chainStub();
    const { db, services, secrets } = await launched({ battle: { ...battle, web3: { account: "vera" } } }, chain);
    const accounts = db.stepOutput<any>("fl", "generate-keys")!.accounts;
    const vera = accounts["acct-vera"];
    const classes = Object.values(chain.state().chains).flatMap((c) => c.classes ?? []);
    expect(classes.map((c) => c.symbol)).toEqual(["BRCAREER", "BRBADGE", "BRMATCH"]);
    expect(classes.every((c) => c.owner === vera && c.signer === "acct-vera")).toBe(true);
    const session = readSessions(secrets).battle!;
    expect(session.granter).toBe(vera);
    const grant = grants(chain).find((g) => g.grantee === session.grantee)!;
    expect(grant).toMatchObject({
      signer: "acct-vera",
      allowed_msg_types: ["/sparkdream.artifact.v1.MsgMint", "/sparkdream.artifact.v1.MsgUpdateToken"],
    });
    const dseq = db.listFleetComponents("fl").find((c) => c.key === "battle")!.dseq;
    expect(services.provider.sessionKeys.get(`${dseq}/battle`)).toBe(session.mnemonic);
    // delivered where the game reads it, handed to the game's user
    const delivery = services.provider.shellLog.find((l) => l.dseq === dseq && l.script.includes("session-key"))!;
    expect(delivery.script).toContain("/app/data/session-key");
    expect(delivery.script).toContain("chown node");
    db.close();
  }, 180_000);

  it("with a wallet member: pauses for the class creation, then for the grant, and never signs as the member", async () => {
    const chain = chainStub();
    const [acct] = await (await Secp256k1HdWallet.generate(12, { prefix: "sprkdrm" })).getAccounts();
    const member = acct!.address;
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    serveGame(services);
    const s = spec({ battle: { ...battle, web3: { wallet: member } } });
    chain.edit((st) => {
      st.defaultBalances = { [s.token.baseDenom]: "2000000000" };
      st.members = { [member]: { trust_level: "TRUST_LEVEL_PROVISIONAL", dream_balance: "0", staked_dream: "0" } };
    });
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    const run = () => withStub(chain, () => runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner()));
    const waiting = () => {
      const step = db.listSteps("fl").find((x) => x.status === "waiting");
      return step?.wallet_json ? JSON.parse(step.wallet_json) : undefined;
    };
    const sign = () => {
      const req = waiting();
      expect(req.signer).toBe(member);
      // the class creation pauses before anything is broadcast: the one chain the step queried
      const node = chain.state().log.at(-1)?.node ?? Object.keys(chain.state().chains)[0]!;
      const doc = path.join(tmp(), "tx.json");
      fs.writeFileSync(doc, JSON.stringify({ body: { messages: req.msgs }, __from: member }));
      execFileSync(chain.bin, ["tx", "broadcast", doc, "--node", node]);
    };

    // 1. the classes the game lists: a MsgCreateClass each for the member to sign (CLI commands included)
    expect((await run()).status).toBe("awaiting-user");
    const classReq = waiting();
    expect(classReq.msgs.map((m: any) => [m["@type"].split(".").pop(), m.symbol, m.creator])).toEqual([
      ["MsgCreateClass", "BRCAREER", member],
      ["MsgCreateClass", "BRBADGE", member],
      ["MsgCreateClass", "BRMATCH", member],
    ]);
    expect(classReq.cli).toContain("sparkdreamd tx sign");
    sign();

    // 2. the session grant, scoped to the game's two message types
    expect((await run()).status).toBe("awaiting-user");
    const pending = readSessions(launchDirs(work, "fl").secrets).battle!;
    expect(pending).toMatchObject({ granter: member, pending: true });
    expect(waiting().msgs.map((m: any) => m["@type"].split(".").pop())).toEqual(["MsgSend", "MsgCreateSession"]);
    expect(waiting().msgs[1]).toMatchObject({
      granter: member,
      grantee: pending.grantee,
      allowed_msg_types: ["/sparkdream.artifact.v1.MsgMint", "/sparkdream.artifact.v1.MsgUpdateToken"],
    });
    sign();

    // 3. signed: delivered, and the launch finishes; the classes exist once and are not asked for again
    expect((await run()).status).toBe("completed");
    const classes = Object.values(chain.state().chains).flatMap((c) => c.classes ?? []);
    expect(classes).toHaveLength(GAME_CLASSES.length);
    new FleetService(db, services, work).materialize("fl");
    const dseq = db.listFleetComponents("fl").find((c) => c.key === "battle")!.dseq;
    expect(services.provider.sessionKeys.get(`${dseq}/battle`)).toBe(readSessions(launchDirs(work, "fl").secrets).battle!.mnemonic);
    expect(chain.state().log.filter((l) => l.from === member)).toHaveLength(2);
    db.close();
  }, 240_000);
});

describe("the battle game's class list", () => {
  const spec = { topology: { components: { battle: { enabled: true, domain: "battle.phoenix.example" } } } } as unknown as LaunchSpec;
  const rpc = (body: string | Error) => ({ getText: async () => { if (body instanceof Error) throw body; return body; } });
  const item = { symbol: "BRITEM", name: "Item", description: "An item", transferable: true };

  it("comes from the game's /chain-status, so a new class needs no launcher release", async () => {
    expect(await battleClassList(rpc(JSON.stringify({ enabled: false, classes: [...BATTLE_CLASSES, item] })), spec)).toEqual([...BATTLE_CLASSES, item]);
  });

  it("is the built-in list for a game older than v1.0.3, or an untagged one that lists none", async () => {
    const old = { ...spec, images: { battle: "sparkdreamnft/battle-royale:v1.0.2" } } as unknown as LaunchSpec;
    expect(await battleClassList(rpc(new Error("not asked")), old)).toBe(BATTLE_CLASSES);
    const dev = { ...spec, images: { battle: "sparkdreamnft/battle-royale:dev" } } as unknown as LaunchSpec;
    expect(await battleClassList(rpc(JSON.stringify({ enabled: false })), dev)).toBe(BATTLE_CLASSES);
  });

  it("waits for a game that should list them, and never stands the built-in list in for it", async () => {
    // 2026-10-17: read while the update restarted v1.0.4, the fallback asked for BRMAP, which v1.0.4 dropped
    const v104 = { ...spec, images: { battle: "sparkdreamnft/battle-royale:v1.0.4" } } as unknown as LaunchSpec;
    const three = BATTLE_CLASSES.filter((c) => c.symbol !== "BRMAP");
    let calls = 0;
    const restarting = { getText: async () => (++calls < 3 ? Promise.reject(new Error("502")) : JSON.stringify({ classes: three })) };
    const waits: number[] = [];
    expect(await battleClassList(restarting, v104, async (ms) => void waits.push(ms))).toEqual(three);
    expect(waits).toHaveLength(2);

    await expect(battleClassList(rpc(new Error("down")), v104, async () => {})).rejects.toThrow(/did not answer.*down/);
    await expect(battleClassList(rpc(new Error("down")), spec)).rejects.toThrow(/did not answer/);
    await expect(battleClassList(rpc(JSON.stringify({ enabled: false })), v104)).rejects.toThrow(/lists no classes/);
    await expect(battleClassList(rpc(JSON.stringify({ classes: [item, { symbol: "bad symbol!" }] })), spec)).rejects.toThrow(/cannot read/);
  });
});

describe("the battle game's onchain records on a running game", () => {
  const battle = { enabled: true, domain: "battle.phoenix.example" };

  it("are turned on in place: same deployment, web3 env, classes and session key", async () => {
    const chain = chainStub();
    const { db, services, fleet, secrets, work, runOps } = await launched({ battle }, chain);
    const row = () => db.listFleetComponents("fl").find((c) => c.key === "battle")!;
    const before = row();
    const sdl = () => yaml.load(fs.readFileSync(path.join(launchDirs(work, "fl").sdl, "battle.yaml"), "utf8")) as any;
    expect(sdl().services.battle.env).toBeUndefined();

    fleet.requestBattleWeb3(db.getLaunch("fl")!, before, { account: "vera" });
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).topology.components.battle.web3).toMatchObject({ account: "vera" });
    // one at a time
    expect(() => fleet.requestBattleWeb3(db.getLaunch("fl")!, row(), { account: "vera" })).toThrow(/still running/);
    const result = await runOps();
    expect(result.reason ?? "").toBe("");
    expect(result.status).toBe("completed");
    expect(db.listFleetOps("fl").find((o) => o.kind === "battle-web3")!.status).toBe("done");

    // the same lease, now carrying the chain env
    expect(row().dseq).toBe(before.dseq);
    expect(sdl().services.battle.env).toContain("CHAIN_ENABLED=1");
    const classes = Object.values(chain.state().chains).flatMap((c) => c.classes ?? []);
    expect(classes.map((c) => c.symbol)).toEqual(["BRCAREER", "BRBADGE", "BRMATCH"]);
    expect(services.provider.sessionKeys.get(`${before.dseq}/battle`)).toBe(readSessions(secrets).battle!.mnemonic);
    // the fleet card sees them on (and offers to turn them off)
    const card = async () => (await fleet.fleetForOwner("akash1owner")).fleets.find((x) => x.launchId === "fl")!;
    expect((await card()).battleWeb3).toEqual({ account: "vera" });

    // and off again: the env goes, the game stays
    fleet.requestBattleWeb3(db.getLaunch("fl")!, row(), null);
    expect((await runOps()).status).toBe("completed");
    expect(sdl().services.battle.env).toBeUndefined();
    expect(row().dseq).toBe(before.dseq);
    expect((await card()).battleWeb3).toBeUndefined();
    expect(() => fleet.requestBattleWeb3(db.getLaunch("fl")!, row(), null)).toThrow(/already off/);
    db.close();
  }, 240_000);

  it("never read a class query the CLI cannot print as owning none", async () => {
    // 2026-10-21: the CLI failed on every read, so each signature created all the classes again
    const chain = chainStub();
    const { db, services, fleet, runOps } = await launched({ battle }, chain);
    const row = () => db.listFleetComponents("fl").find((c) => c.key === "battle")!;
    const created = () => Object.values(chain.state().chains).flatMap((c) => c.classes ?? []).map((c) => c.symbol);
    chain.edit((st) => (st.classesUnprintable = true));

    // nothing to read it at: the step stops instead of creating
    fleet.requestBattleWeb3(db.getLaunch("fl")!, row(), { account: "vera" });
    const stopped = await runOps();
    const opId = db.listFleetOps("fl").find((o) => o.kind === "battle-web3")!.id;
    expect(stopped).toMatchObject({ status: "paused", failedStep: `op${opId}:battle-classes` });
    expect(db.getStep("fl", `op${opId}:battle-classes`)!.error).toMatch(/could not read the classes .* expiry\) nor at https:\/\/api\.phoenix\.example/);
    expect(created()).toEqual([]);

    // the chain's public API answers instead: what it lists is not created again
    const vera = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    const lcd = "https://api.phoenix.example";
    services.rpc.texts.set(`${lcd}/sparkdream/artifact/v1/classes_by_owner/${vera}`, JSON.stringify({ classes: [{ class: { symbol: "BRCAREER" } }] }));
    const resumed = await runOps();
    expect(resumed.reason ?? "").toBe("");
    expect(resumed.status).toBe("completed");
    expect(created()).toEqual(["BRBADGE", "BRMATCH"]);
    db.close();
  }, 240_000);

  it("are put back as they were when the op is aborted at the wallet's signature", async () => {
    const chain = chainStub();
    const { db, fleet, runOps, work } = await launched({ battle }, chain);
    const row = () => db.listFleetComponents("fl").find((c) => c.key === "battle")!;
    const sdl = () => yaml.load(fs.readFileSync(path.join(launchDirs(work, "fl").sdl, "battle.yaml"), "utf8")) as any;
    const vera = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];

    // a wallet member: class creation waits on its signature, after the update landed
    const opId = fleet.requestBattleWeb3(db.getLaunch("fl")!, row(), { wallet: vera });
    const paused = await runOps();
    expect(paused.status).toBe("awaiting-user");
    expect(db.getStep("fl", `op${opId}:update`)!.status).toBe("done");
    expect(db.getStep("fl", `op${opId}:battle-classes`)!.status).toBe("waiting");
    expect(sdl().services.battle.env).toContain("CHAIN_ENABLED=1");

    const r = await fleet.requestAbortOp(db.getLaunch("fl")!, opId);
    expect(r.warning).toMatch(/updates it back \(onchain records off\)/);
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).topology.components.battle.web3).toBeUndefined();
    const revert = db.listFleetOps("fl").find((o) => o.kind === "battle-web3" && o.id !== opId)!;
    expect(r.step).toBe(`op${revert.id}:update`);
    expect((await runOps()).status).toBe("completed");
    expect(db.listFleetOps("fl").find((o) => o.id === revert.id)!.status).toBe("done");
    expect(sdl().services.battle.env).toBeUndefined();
    db.close();
  }, 240_000);

  it("offers the dialog its chains, and checks the picked account on the picked chain", async () => {
    const chain = chainStub();
    const { db, services } = await launched({ battle }, chain);
    const launch = db.getLaunch("fl")!;
    const plain = await battleWeb3Options(db, services.rpc, launch);
    expect(plain.current).toMatchObject({ enabled: false, session: { spendLimit: "25000000" } });
    expect(plain.domain).toBe("battle.phoenix.example");
    expect(plain.targets).toEqual([
      expect.objectContaining({ id: "fl", name: "phoenix", self: true, unusable: null, accounts: ["founder", "vera"], exponent: 6 }),
    ]);
    expect(plain.check).toBeUndefined();

    const vera = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    const lcd = "https://api.phoenix.example";
    services.rpc.texts.set(`${lcd}/sparkdream/artifact/v1/params`, JSON.stringify({ params: { class_creation_fee: "10000000", token_deposit: "100000" } }));
    services.rpc.texts.set(`${lcd}/sparkdream/rep/v1/member/${vera}`, JSON.stringify({ member: { trust_level: "TRUST_LEVEL_PROVISIONAL" } }));
    services.rpc.texts.set(`${lcd}/cosmos/bank/v1beta1/balances/${vera}`, JSON.stringify({ balance: { amount: "50000000" } }));
    services.rpc.texts.set(`${lcd}/sparkdream/artifact/v1/classes_by_owner/${vera}`, JSON.stringify({ classes: [{ class: { symbol: "BRCAREER" } }] }));
    services.rpc.texts.set(`${lcd}/sparkdream/session/v1/params`, JSON.stringify({ params: { max_expiration: "7776000s", max_spend_limit_amount: "100000000" } }));
    const { check } = await battleWeb3Options(db, services.rpc, launch, { target: "fl", account: "vera" });
    expect(check).toEqual({
      address: vera,
      trustLevel: "provisional",
      canCreateClasses: true,
      balance: "50000000",
      classesReady: false,
      // two classes still to create
      classCost: "20000000",
      tokenDeposit: "100000",
      sessionMax: { days: 90, spendLimit: "100000000" },
    });
    // a chain that cannot be read is said, not thrown
    services.rpc.texts.clear();
    // nor is a game that does not list its classes
    expect((await battleWeb3Options(db, services.rpc, launch, { target: "fl", account: "vera" })).check!.error).toMatch(/did not answer/);
    serveGame(services);
    expect((await battleWeb3Options(db, services.rpc, launch, { target: "fl", account: "vera" })).check!.error).toMatch(/could not be read/);
    await expect(battleWeb3Options(db, services.rpc, launch, { target: "fl", account: "nobody" })).rejects.toThrow(/nobody/);
    db.close();
  }, 180_000);

  it("writes to another wallet's chain fleet once it is shared, with a member address from the wallet", async () => {
    const svcWallet = `akash1${"q".repeat(38)}`;
    const chain = chainStub();
    const { db, services, spec: chainSpec } = await launched({ battle }, chain);
    // a services fleet under another wallet, running the game
    const other = { ...chainSpec, network: { ...chainSpec.network, name: "elsewhere" } };
    db.createLaunch("svc", JSON.stringify(other), svcWallet);
    const vera = db.stepOutput<any>("fl", "generate-keys")!.accounts["acct-vera"];
    const withWeb3 = (web3: Record<string, unknown>): LaunchSpec =>
      ({ ...other, topology: { ...other.topology, components: { ...other.topology.components, battle: { ...battle, web3 } } } }) as LaunchSpec;

    // not shared: listed, but unusable, and refused
    const before = (await battleWeb3Options(db, services.rpc, db.getLaunch("svc")!)).targets;
    expect(before).toEqual([expect.objectContaining({ id: "fl", foreign: true, notShared: true, accounts: [] })]);
    expect(before[0]!.unusable).toMatch(/does not share/);
    await expect(battleWeb3Options(db, services.rpc, db.getLaunch("svc")!, { target: "fl", account: vera })).rejects.toThrow(/not a chain fleet/);
    expect(() => resolveBattleTarget(db, withWeb3({ wallet: vera, target: { fleet: "phoenix" } }), svcWallet, "phoenix", "svc")).toThrow(
      /does not share/,
    );

    // shared: a wallet member works, the owner's generated accounts stay with it
    db.setLaunchSpec("fl", JSON.stringify({ ...chainSpec, sharing: { wallets: [svcWallet] } }));
    const after = (await battleWeb3Options(db, services.rpc, db.getLaunch("svc")!)).targets;
    expect(after).toEqual([expect.objectContaining({ id: "fl", foreign: true, notShared: false, unusable: null, accounts: [] })]);
    await expect(battleWeb3Options(db, services.rpc, db.getLaunch("svc")!, { target: "fl", account: "vera" })).rejects.toThrow(/another wallet/);
    expect((await battleWeb3Options(db, services.rpc, db.getLaunch("svc")!, { target: "fl", account: vera })).check!.address).toBe(vera);
    expect(resolveBattleTarget(db, withWeb3({ wallet: vera, target: { fleet: "phoenix" } }), svcWallet, "phoenix", "svc")).toBe("fl");
    expect(() => resolveBattleTarget(db, withWeb3({ account: "vera", target: { fleet: "phoenix" } }), svcWallet, "phoenix", "svc")).toThrow(
      /generated accounts stay with it/,
    );
    db.close();
  }, 180_000);

  it("refuses what is not a running battle game, or an account the chain cannot use", async () => {
    const chain = chainStub();
    const { db, fleet } = await launched({ battle }, chain);
    const rows = db.listFleetComponents("fl");
    const sentry = rows.find((c) => c.key.startsWith("sentry-"))!;
    expect(() => fleet.requestBattleWeb3(db.getLaunch("fl")!, sentry, { account: "vera" })).toThrow(/only the battle game/);
    const game = rows.find((c) => c.key === "battle")!;
    expect(() => fleet.requestBattleWeb3(db.getLaunch("fl")!, game, { account: "nobody" })).toThrow(/nobody/);
    // nothing stored, nothing queued
    expect(JSON.parse(db.getLaunch("fl")!.spec_json).topology.components.battle.web3).toBeUndefined();
    expect(db.listFleetOps("fl").some((o) => o.kind === "battle-web3")).toBe(false);
    db.close();
  }, 180_000);
});

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
    // the grantee's auth account is created with the grant: it must exist to
    // sign, and holds the fee of its acceptance (SES-102)
    const balances = chain.state().balances!;
    expect(balances[sessions.verifier!.grantee]).toEqual({ [s0(db).token.baseDenom]: keyFunding(Number(s0(db).token.minGasPrice)).toString() });
    expect(keyFunding(Number(s0(db).token.minGasPrice))).toBeGreaterThan(1n);
    // each key accepted its own grant: none is left waiting for consent
    for (const role of ["verifier", "bridge"] as const) {
      expect(byGrantee.get(sessions[role]!.grantee)).toMatchObject({ accepted_by: "session-key" });
      expect(byGrantee.get(sessions[role]!.grantee)!.pending_id).toBeUndefined();
    }

    // delivered into the right service of the right deployment
    const dseq = (key: string) => rows.find((c) => c.key === key)!.dseq;
    expect(services.provider.sessionKeys.get(`${dseq("verifier")}/verifier`)).toBe(sessions.verifier!.mnemonic);
    expect(services.provider.sessionKeys.get(`${dseq("mastodon")}/bridge`)).toBe(sessions.bridge!.mnemonic);

    // 30 days (inside the chain's ceiling), renewed at 20
    const lifetime = Date.parse(sessions.verifier!.expiresAt) - Date.parse(sessions.verifier!.createdAt);
    expect(lifetime).toBeGreaterThan(29 * 86_400_000);
    expect(lifetime).toBeLessThanOrEqual(30 * 86_400_000);
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

  it("keeps the reference's session ceilings in genesis: 7 days broad, 30 narrow", async () => {
    const chain = chainStub();
    const { work, db } = await launched({}, chain);
    const genesis = JSON.parse(fs.readFileSync(path.join(launchDirs(work, "fl").node("val-0"), "config", "genesis.json"), "utf8"));
    expect(genesis.app_state.session.params.max_expiration).toBe(`${7 * 86_400}s`);
    expect(genesis.app_state.session.params.narrow_session_max_expiration).toBe(`${30 * 86_400}s`);
    db.close();
  }, 180_000);

  it("a spec's longer session ceiling raises the narrow one with it", async () => {
    const chain = chainStub();
    const { work, db } = await launched({}, chain, { session: { maxExpirationDays: 60 } });
    const genesis = JSON.parse(fs.readFileSync(path.join(launchDirs(work, "fl").node("val-0"), "config", "genesis.json"), "utf8"));
    expect(genesis.app_state.session.params.max_expiration).toBe(`${60 * 86_400}s`);
    expect(genesis.app_state.session.params.narrow_session_max_expiration).toBe(`${60 * 86_400}s`);
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

  it("forgets a retired daemon's session whose account the spec no longer names, instead of retrying on every pass", async () => {
    const chain = chainStub();
    const { db, fleet, secrets, runOps } = await launched({ verifier, mastodon }, chain);
    // the verifier is gone from the spec (as a game's web3 block is when its
    // onchain records are turned off), its record left behind
    const stored = s0(db);
    delete (stored.topology.components as Record<string, unknown>).verifier;
    db.setLaunchSpec("fl", JSON.stringify(stored));
    expect(await fleet.sessionsDue("fl")).toBe(true);
    fleet.requestSessions(db.getLaunch("fl")!);
    expect((await runOps()).status).toBe("completed");
    expect(readSessions(secrets).verifier).toBeUndefined();
    expect(readSessions(secrets).bridge).toBeDefined();
    expect(await fleet.sessionsDue("fl")).toBe(false);
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

describe("grantLink", () => {
  it("prefills the frontend's permissions page with the grant the wallet pause asks for", () => {
    const record = {
      grantee: "sprkdrm1grantee",
      expiresAt: "2026-10-24T12:00:00.123Z",
      spendLimit: "5000000",
      maxExecCount: 1000,
    } as SessionRecord;
    const url = new URL(grantLink("https://app.example.org/", "verifier", "sprkdrm1granter", record, ["sprkdrm1old"], 5001n));
    expect(`${url.origin}${url.pathname}`).toBe("https://app.example.org/permissions");
    const q = url.searchParams;
    expect(q.get("session_request")).toBe("verifier");
    expect(q.get("granter")).toBe("sprkdrm1granter");
    expect(q.get("grantee")).toBe("sprkdrm1grantee");
    expect(q.get("spend")).toBe("5000000");
    expect(q.get("expires")).toBe("2026-10-24T12:00:00Z");
    expect(q.get("execs")).toBe("1000");
    expect(q.get("fund")).toBe("5001");
    expect(q.getAll("type").length).toBeGreaterThan(0);
    expect(q.getAll("revoke")).toEqual(["sprkdrm1old"]);
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
    // the monitor watches for that grant, so one signed elsewhere resumes by itself
    expect(waiting().awaitsSession).toEqual({ granter: member, grantee: pending.grantee });

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
    // but accepted the grant as its key, as soon as it found it on chain
    expect(grants(chain).find((g) => g.grantee === granted.grantee)).toMatchObject({ accepted_by: "session-key" });
    db.close();
  }, 240_000);

  it("accepts a wallet's grant whose key was sent only one unit, funding the fee from a key the launcher holds", async () => {
    const chain = chainStub();
    const { db, secrets, spec: s, run, waiting, sign } = await walletLaunch(chain);
    expect((await run()).status).toBe("awaiting-user");
    sign(); // the bond
    expect((await run()).status).toBe("awaiting-user");
    const req = waiting();
    expect(req.msgs[0].amount).toEqual([{ denom: s.token.baseDenom, amount: keyFunding(Number(s.token.minGasPrice)).toString() }]);
    // signed as a frontend from before keys were funded for consent did: one unit
    req.msgs[0].amount = [{ denom: s.token.baseDenom, amount: "1" }];
    const node = chain.state().log.at(-1)!.node;
    const doc = path.join(tmp(), "tx.json");
    fs.writeFileSync(doc, JSON.stringify({ body: { messages: req.msgs }, __from: req.signer }));
    execFileSync(chain.bin, ["tx", "broadcast", doc, "--node", node]);
    const key = readSessions(secrets).verifier!.grantee;
    expect(grants(chain).find((g) => g.grantee === key)!.pending_id).toBeDefined();
    // the monitor's hourly check sees a pending grant as one to act on
    expect(await withStub(chain, () => grantHolds(node, readSessions(secrets).verifier!))).toBe(false);

    expect((await run()).status).toBe("completed");
    expect(grants(chain).find((g) => g.grantee === key)).toMatchObject({ accepted_by: "session-key" });
    const topUp = chain.state().log.find((l) => l.from === "acct-founder" && l.types.includes("/cosmos.bank.v1beta1.MsgSend"));
    expect(topUp).toBeDefined();
    expect(await withStub(chain, () => grantHolds(node, readSessions(secrets).verifier!))).toBe(true);
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

    // the web image itself still upgrades the main service, and brings a
    // deployment made before the upload body size was set up to it
    const sdlPath = path.join(work, "launches", "fl", "sdl", "mastodon.yaml");
    const old = sdl("mastodon.yaml");
    expect(old.services.mastodon.expose[0].http_options).toEqual({ max_body_size: 104857600 });
    delete old.services.mastodon.expose[0].http_options;
    fs.writeFileSync(sdlPath, yaml.dump(old));
    fleet.requestUpgrade(db.getLaunch("fl")!, ["mastodon"], "sparkdreamnft/mastodon:v9.9.9");
    expect((await runOps()).status).toBe("completed");
    expect(sdl("mastodon.yaml").services.mastodon.image).toBe("sparkdreamnft/mastodon:v9.9.9");
    expect(sdl("mastodon.yaml").services.mastodon.expose[0].http_options).toEqual({ max_body_size: 104857600 });
    const manifest = fs.readFileSync(path.join(work, "launches", "fl", "sdl", "mastodon.manifest.json"), "utf8");
    expect(manifest).toContain('"maxBodySize":104857600');
    expect(sdl("mastodon.yaml").services.bridge.image).toBe("sparkdreamnft/sdap:v9.9.9");
    expect(row().image).toBe("sparkdreamnft/mastodon:v9.9.9");
    db.close();
  }, 300_000);
});

describe("removing closed components", () => {
  it("drops the row and disables the component, and a rebuild does not bring it back", async () => {
    const chain = chainStub();
    const { db, fleet } = await launched({ mastodon, verifier }, chain);
    const launch = () => db.getLaunch("fl")!;
    const keys = () => db.listFleetComponents("fl").map((c) => c.key).sort();

    expect(() => fleet.removeComponent(launch(), "mastodon")).toThrow(/close mastodon first/);
    expect(() => fleet.removeComponent(launch(), "val-0")).toThrow(/not a service component/);
    db.setComponentState("fl", "mastodon", "closed");
    db.setComponentState("fl", "verifier", "closed");
    // the verifier checks the Mastodon's peer: it has to go first
    expect(() => fleet.removeComponent(launch(), "mastodon")).toThrow(/would not validate/);

    fleet.removeComponent(launch(), "verifier");
    fleet.removeComponent(launch(), "mastodon");
    expect(keys()).not.toContain("mastodon");
    expect(keys()).not.toContain("verifier");
    const comps = JSON.parse(launch().spec_json).topology.components;
    expect(comps.mastodon).toMatchObject({ enabled: false, domain: DOMAIN });
    expect(comps.verifier).toMatchObject({ enabled: false, account: "vera" });

    // both were deployed at launch: the launch outputs still list them
    fleet.materialize("fl");
    expect(keys()).not.toContain("mastodon");
    expect(keys()).not.toContain("verifier");
    expect(keys()).toEqual(expect.arrayContaining(["headscale", "sentry-0", "val-0"]));
    db.close();
  }, 180_000);
});

