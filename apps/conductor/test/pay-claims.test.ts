import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { claimBatch, claimableNow, type PayGrant } from "../src/pay-claims.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub } from "./chain-stub.js";

/**
 * Operator pay: a council's recurring payment to a launcher-held operator
 * (the scanner's) is claimed by the launcher, which alone holds the key.
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function grant(over: Partial<PayGrant["recurring_pull"]> = {}, g: Partial<PayGrant> = {}): PayGrant {
  return {
    id: "7",
    granter: "sprkdrm1opspolicy",
    grantee: "sprkdrm1operator",
    type: "GRANT_TYPE_RECURRING_PULL",
    status: "GRANT_STATUS_ACTIVE",
    expires_at: new Date((now() + 300 * DAY) * 1000).toISOString(),
    recurring_pull: {
      amount_per_period: { denom: "uspark", amount: "300000000" },
      period_seconds: String(30 * DAY),
      last_claim_advance: String(now() - 95 * DAY),
      max_per_epoch: "3000000000",
      ...over,
    },
    ...g,
  };
}

describe("claimable periods", () => {
  it("counts every missed period, but no further than the grant runs", () => {
    expect(claimableNow(grant(), now())).toBe(3);
    expect(claimableNow(grant({ last_claim_advance: String(now() - 10 * DAY) }), now())).toBe(0);
    const ending = grant({}, { expires_at: new Date((now() - 40 * DAY) * 1000).toISOString() });
    expect(claimableNow(ending, now())).toBe(1);
    expect(claimableNow(grant({}, { status: "GRANT_STATUS_REVOKED" }), now())).toBe(0);
  });

  it("batches within the per-day ceiling and the tx cap", () => {
    expect(claimBatch(grant({ max_per_epoch: "600000000" }), now())).toBe(2);
    const long = grant({ period_seconds: String(DAY), last_claim_advance: String(now() - 40 * DAY), max_per_epoch: "1000000000000" });
    expect(claimBatch(long, now())).toBe(10);
  });
});

describe("claims for a running fleet", () => {
  it("claims a due payment to the scanner operator with its key, and backs off a refused one", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-claims-"));
    tmpDirs.push(work);
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const chain = chainStub();
    const s: LaunchSpec = testnetSpec({
      network: { name: "phoenix", type: "testnet", bech32Prefix: "sprkdrm" },
      accounts: {
        initial: [{ name: "founder", generate: true, amount: "1000000000000", member: true, council: { founder: true } }],
        validatorSelfDelegation: "1000000000000",
      },
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
          scanner: { enabled: true, domain: "scan.phoenix.example" },
        },
        publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" },
        headscale: { domain: "hs.example" },
      },
    });
    chain.edit((st) => (st.defaultBalances = { [s.token.baseDenom]: "2000000000" }));
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    expect((await withStub(chain, () => runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner()))).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    const secrets = launchDirs(work, "fl").secrets;
    const operator = fs.readFileSync(path.join(secrets, "scanner-operator.address"), "utf8").trim();
    const runOps = () =>
      withStub(chain, () =>
        runWithSigner(db, "fl", s, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")], services, new FakeSigner()),
      );

    // the committee pays the operator monthly; two months have gone by
    const pay = { denom: s.token.baseDenom, amount: "300000000" };
    chain.edit((st: any) => {
      const c = Object.values(st.chains)[0] as any;
      c.grants = {
        "7": grant({ amount_per_period: pay, last_claim_advance: String(now() - 65 * DAY) }, { grantee: operator }),
        "8": { ...grant({ amount_per_period: pay }, { id: "8", grantee: operator }), refuse: "group term ended" },
      };
    });

    db.createFleetOp("fl", "claims", {});
    expect((await runOps()).status).toBe("completed");
    const c = Object.values(chain.state().chains)[0] as any;
    expect(c.grants["7"].recurring_pull.claims_made).toBe("2");
    expect(chain.state().log.filter((l: any) => l.types.includes("/sparkdream.session.v1.MsgClaimRecurringPull")).map((l: any) => l.from)).toEqual(
      expect.arrayContaining(["scanner-operator"]),
    );
    // the refused grant waits a day before it costs another fee
    const failures = JSON.parse(fs.readFileSync(path.join(secrets, "pay-claims.json"), "utf8"));
    expect(Object.keys(failures)).toEqual(["8"]);
    db.close();
  }, 240_000);
});
