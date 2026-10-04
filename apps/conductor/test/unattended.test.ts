import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TypeUrl, UNATTENDED_MSG_TYPES, type Msg } from "@sparkdream/akash-tx";
import { testnetSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runLaunch, runWithSigner } from "../src/engine.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { allSteps } from "../src/index.js";
import { setAlertSettings } from "../src/incidents.js";
import { opsKey, setUnattendedSettings, unattendedBlocker, unattendedSettings } from "../src/unattended.js";
import { fakeServices, FakeSigner, FakeUnattendedChain, type FakeWorld } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-unattended-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const OWNER = "akash1owner";

function spec(): LaunchSpec {
  return testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    security: { keyMode: "tmkms" },
    providers: { policy: { antiAffinity: "strict" } },
    topology: {
      validators: { count: 1 },
      sentries: { count: 2 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

describe("what may be signed unattended", () => {
  const settings = { enabled: true, dailyCap: { denom: "uact", amount: "10000000" } };
  const grants = UNATTENDED_MSG_TYPES.map((msgType) => ({ msgType, expiration: new Date(Date.now() + 86_400_000).toISOString() }));
  const create = (amount: string): Msg => ({
    typeUrl: TypeUrl.CreateDeployment,
    value: { id: { owner: OWNER, dseq: "1" }, deposit: { amount: { denom: "uact", amount }, sources: [] } },
  });
  const ok = (msgs: Msg[], extra: Partial<Parameters<typeof unattendedBlocker>[0]> = {}) =>
    unattendedBlocker({ owner: OWNER, msgs, settings, grants, spent: 0n, ...extra });

  it("deployment and lease msgs of the owner, within the cap", () => {
    expect(ok([create("5000000")])).toBeNull();
    expect(ok([{ typeUrl: TypeUrl.CreateLease, value: { bidId: { owner: OWNER, dseq: "1" } } }])).toBeNull();
  });
  it("never a bank send, nor an escrow deposit", () => {
    expect(ok([{ typeUrl: TypeUrl.Send, value: {} }])).toMatch(/never signed unattended/);
    expect(ok([{ typeUrl: TypeUrl.AccountDeposit, value: {} }])).toMatch(/never signed unattended/);
  });
  it("not past the daily cap, nor for another owner, nor off or expired", () => {
    expect(ok([create("6000000")], { spent: 5_000_000n })).toMatch(/daily cap/);
    expect(ok([{ typeUrl: TypeUrl.CloseDeployment, value: { id: { owner: "akash1other", dseq: "1" } } }])).toMatch(/another owner/);
    expect(ok([create("1")], { settings: { ...settings, enabled: false } })).toMatch(/is off/);
    expect(ok([create("1")], { grants: grants.map((g) => ({ ...g, expiration: "2020-01-01T00:00:00Z" })) })).toMatch(/expired/);
    expect(ok([create("1")], { grants: [] })).toMatch(/no grant/);
  });
});

interface World {
  work: string;
  db: ConductorDb;
  services: FakeWorld;
  fleet: FleetService;
  chain: FakeUnattendedChain;
  alerts: string[];
}

async function launched(): Promise<World> {
  const work = tmp();
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const chain = new FakeUnattendedChain();
  services.unattended = chain;
  db.createLaunch("fl", JSON.stringify(spec()), OWNER);
  expect((await runWithSigner(db, "fl", spec(), work, allSteps(), services, new FakeSigner())).status).toBe("completed");
  const fleet = new FleetService(db, services, work);
  fleet.materialize("fl");
  const alerts: string[] = [];
  fleet.alertFetch = (async (_url: string, init: RequestInit) => {
    alerts.push(String((init.headers as Record<string, string>).Title));
    return new Response("ok");
  }) as typeof fetch;
  setAlertSettings(db, { ntfy: { server: "https://ntfy.sh", topic: "t" } });
  return { work, db, services, fleet, chain, alerts };
}

/** The server's loop, minus Keplr: drive, and on a signature let the grant sign it. */
async function driveUnattended(w: World) {
  for (let i = 0; i < 20; i++) {
    const s = withDefaults(JSON.parse(w.db.getLaunch("fl")!.spec_json));
    const steps = [...buildPreLaunchOpSteps(w.db, "fl"), ...allSteps(), ...buildOpSteps(w.db, "fl")];
    const res = await runLaunch(w.db, "fl", s, w.work, steps, w.services, () => {});
    if (res.status !== "awaiting-signature") return res;
    if (!(await w.fleet.signUnattended("fl"))) return res;
  }
  throw new Error("did not settle");
}

async function sentryDies(w: World) {
  const sentry = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-1")!;
  w.services.api.leaseStates.set(sentry.dseq, "closed");
  for (let i = 0; i < 2; i++) {
    await w.fleet.tick("fl");
    await w.fleet.trackIncidents("fl");
  }
  return sentry;
}

describe("automatic recovery", () => {
  it("relaunches a sentry whose lease the provider closed, signing with the wallet's grant", async () => {
    const w = await launched();
    const { address } = await opsKey(w.work, OWNER);
    w.chain.grantAll(OWNER, address, UNATTENDED_MSG_TYPES);
    setUnattendedSettings(w.db, OWNER, { enabled: true });
    w.fleet.setAutoRecoverPolicy(w.db.getLaunch("fl")!, { enabled: true });

    const before = await sentryDies(w);
    expect(w.fleet.autoStarted.has("fl")).toBe(true);
    const op = w.db.listFleetOps("fl", "active")[0]!;
    expect(op.kind).toBe("relaunch");
    expect(JSON.parse(op.params_json)).toMatchObject({ key: "sentry-1", auto: true });

    const done = await driveUnattended(w);
    expect(done.status).toBe("completed");
    const after = w.db.listFleetComponents("fl").find((c) => c.key === "sentry-1")!;
    expect(after.dseq).not.toBe(before.dseq);
    // every tx went through MsgExec, for the owner, with granted types only
    const types = w.chain.execs.flatMap((e) => e.msgs.map((m) => m.typeUrl));
    // the provider closed the old lease itself, so nothing needed closing
    expect(types).toEqual([TypeUrl.CreateDeployment, TypeUrl.CreateLease, TypeUrl.UpdateDeployment]);
    expect(types.every((t) => (UNATTENDED_MSG_TYPES as readonly string[]).includes(t))).toBe(true);
    expect(w.chain.execs.every((e) => e.granter === OWNER)).toBe(true);
    expect(w.alerts).toContain("sparkdream: recovering sentry-1 automatically");
  }, 240_000);

  it("waits for Keplr, and says so, when the wallet has not granted", async () => {
    const w = await launched();
    setUnattendedSettings(w.db, OWNER, { enabled: true });
    w.fleet.setAutoRecoverPolicy(w.db.getLaunch("fl")!, { enabled: true });
    await sentryDies(w);
    const res = await driveUnattended(w);
    expect(res.status).toBe("awaiting-signature");
    expect(w.chain.execs).toHaveLength(0);
    expect(w.alerts).toContain("sparkdream: automatic recovery waits for your signature");
  }, 240_000);

  it("does nothing on its own while the fleet's policy is off (the default)", async () => {
    const w = await launched();
    await sentryDies(w);
    expect(w.db.listFleetOps("fl", "active")).toHaveLength(0);
    expect(w.fleet.autoRecoverPolicy("fl").enabled).toBe(false);
    expect(unattendedSettings(w.db, OWNER).enabled).toBe(false);
  }, 240_000);

  it("gives up after two attempts in a day", async () => {
    const w = await launched();
    w.fleet.setAutoRecoverPolicy(w.db.getLaunch("fl")!, { enabled: true });
    for (let i = 0; i < 2; i++) {
      const id = w.db.createFleetOp("fl", "relaunch", { key: "sentry-1", auto: true });
      w.db.setFleetOpStatus(id, "aborted");
    }
    await sentryDies(w);
    expect(w.db.listFleetOps("fl", "active")).toHaveLength(0);
    expect(w.alerts).toContain("sparkdream: sentry-1 still down, giving up on automatic recovery");
  }, 240_000);

  it("counts automatic restarts toward the daily attempts", async () => {
    const w = await launched();
    w.fleet.setAutoRecoverPolicy(w.db.getLaunch("fl")!, { enabled: true });
    // two restarts today (a restart is no op, so only this record knows)
    const now = new Date().toISOString();
    w.db.setSetting("auto-restarts:fl:sentry-1", JSON.stringify([now, now]));
    await sentryDies(w);
    expect(w.db.listFleetOps("fl", "active")).toHaveLength(0);
    expect(w.alerts).toContain("sparkdream: sentry-1 still down, giving up on automatic recovery");
  }, 240_000);

  it("an outage that starts during another op is recovered once that op is done", async () => {
    const w = await launched();
    w.fleet.setAutoRecoverPolicy(w.db.getLaunch("fl")!, { enabled: true });
    const busy = w.db.createFleetOp("fl", "data-backup", { source: "sentry-0" });
    await sentryDies(w);
    expect(w.db.listFleetOps("fl", "active").map((o) => o.kind)).toEqual(["data-backup"]);

    w.db.setFleetOpStatus(busy, "done");
    await w.fleet.trackIncidents("fl");
    const op = w.db.listFleetOps("fl", "active")[0];
    expect(op?.kind).toBe("relaunch");
    expect(JSON.parse(op!.params_json)).toMatchObject({ key: "sentry-1", auto: true });
  }, 240_000);
});

describe("granting", () => {
  it("refuses an owner that is not an address shape (it names the key file)", async () => {
    const work = tmp();
    await expect(opsKey(work, "../../../tmp/x")).rejects.toThrow(/not an Akash address/);
    await expect(opsKey(work, "akash1abc/../x")).rejects.toThrow(/not an Akash address/);
    expect(fs.existsSync(path.join(work, "secrets"))).toBe(false);
  });

  it("builds the grant for the launcher's key: four msg types and an Exec-only fee allowance", async () => {
    const w = await launched();
    const { address } = await opsKey(w.work, OWNER);
    const msgs = await w.fleet.unattendedMsgs(OWNER, "grant", 30);
    expect(msgs.filter((m) => m.typeUrl === TypeUrl.Grant).map((m) => (m.value as any).msg_type_url)).toEqual([
      ...UNATTENDED_MSG_TYPES,
    ]);
    const allowance = msgs.find((m) => m.typeUrl === TypeUrl.GrantAllowance)!.value as any;
    expect(allowance.grantee).toBe(address);
    expect(allowance.allowed_messages).toEqual([TypeUrl.Exec]);
    // the same key every time, kept in the launcher's secrets
    expect((await opsKey(w.work, OWNER)).address).toBe(address);
    expect(fs.existsSync(path.join(w.work, "secrets", `unattended-${OWNER}.mnemonic`))).toBe(true);
    // fresh: nothing to replace
    expect(msgs.some((m) => m.typeUrl === TypeUrl.RevokeAllowance)).toBe(false);
  }, 120_000);

  it("a renewal replaces the live fee allowance, and a revoke names only what the chain holds", async () => {
    const w = await launched();
    const { address } = await opsKey(w.work, OWNER);
    const chain = w.chain;
    chain.grantAll(OWNER, address, UNATTENDED_MSG_TYPES.slice(0, 2));
    chain.allowances.set(`${OWNER}/${address}`, { spendLimit: [{ denom: "uact", amount: "5000000" }], expiration: null });

    const renew = await w.fleet.unattendedMsgs(OWNER, "grant", 30);
    expect(renew[0]!.typeUrl).toBe(TypeUrl.RevokeAllowance);
    expect(renew.filter((m) => m.typeUrl === TypeUrl.GrantAllowance)).toHaveLength(1);

    const revoke = await w.fleet.unattendedMsgs(OWNER, "revoke");
    expect(revoke.filter((m) => m.typeUrl === TypeUrl.Revoke).map((m) => (m.value as any).msg_type_url)).toEqual(
      UNATTENDED_MSG_TYPES.slice(0, 2),
    );
    expect(revoke.some((m) => m.typeUrl === TypeUrl.RevokeAllowance)).toBe(true);

    chain.grantsByPair.clear();
    chain.allowances.clear();
    await expect(w.fleet.unattendedMsgs(OWNER, "revoke")).rejects.toThrow(/nothing to revoke/);
  }, 120_000);
});
