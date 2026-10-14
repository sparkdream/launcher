import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, validateSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { verdictPublicKey } from "../src/components/scanner-secrets.js";
import { ConductorDb } from "../src/db.js";
import { launchDirs, runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { buildOpSteps, buildPreLaunchOpSteps } from "../src/fleet-ops.js";
import { readSessions } from "../src/sessions.js";
import { fakeServices, FakeSigner } from "./fakes.js";
import { chainStub, withStub } from "./chain-stub.js";

/**
 * The content scanner: contentscan serving its verdict feed on its own
 * domain, registered as an x/service content-scanner operator by a
 * launcher-held key, checkpointing through a session key.
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-scanner-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const FEED = "scan.phoenix.example";
const founder = { name: "founder", generate: true, amount: "1000000000000", member: true, council: { founder: true } };

function spec(scanner: Record<string, unknown>): LaunchSpec {
  return testnetSpec({
    network: { name: "phoenix", type: "testnet", bech32Prefix: "sprkdrm" },
    accounts: { initial: [founder], validatorSelfDelegation: "1000000000000" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false }, scanner },
      publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" },
      headscale: { domain: "hs.example" },
    },
  });
}

describe("verdict key", () => {
  it("derives the ed25519 public key contentscan keygen would print (RFC 8032 test 1)", () => {
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64");
    expect(Buffer.from(verdictPublicKey(seed), "base64").toString("hex")).toBe(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
  });
});

describe("scanner spec", () => {
  it("needs a domain and the public api", () => {
    const base = spec({ enabled: true });
    const { errors } = validateSpec({ ...base, topology: { ...base.topology, publicEndpoints: undefined } });
    const paths = errors.map((i) => i.path);
    expect(paths).toContain("topology.components.scanner.domain");
    expect(paths).toContain("topology.publicEndpoints.api");
  });

  it("warns that media stays unchecked without a classifier", () => {
    const { errors, warnings } = validateSpec(spec({ enabled: true, domain: FEED }));
    expect(errors).toEqual([]);
    expect(warnings.map((i) => i.path)).toContain("topology.components.scanner.classifierUrl");
  });

  it("rejects a controller address of another chain", () => {
    const { errors } = validateSpec(spec({ enabled: true, domain: FEED, controller: "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a" }));
    expect(errors.map((i) => i.path)).toContain("topology.components.scanner.controller");
  });
});

describe("scanner at launch", () => {
  it("registers the operator under the Operations Committee and grants a checkpoint-only session", async () => {
    const chain = chainStub();
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec({ enabled: true, domain: FEED });
    // the operator's genesis funding, which the stub cannot see
    chain.edit((st) => (st.defaultBalances = { [s.token.baseDenom]: "2000000000" }));
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    const result = await withStub(chain, () => runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner()));
    expect(result.reason ?? "").toBe("");
    expect(result.status).toBe("completed");

    const dirs = launchDirs(work, "fl");
    const operator = fs.readFileSync(path.join(dirs.secrets, "scanner-operator.address"), "utf8").trim();
    expect(db.stepOutput<any>("fl", "generate-keys")!.accounts["scanner-operator"]).toBe(operator);

    // registered with its own key, the stub's min_bond, the committee's policy
    const registered = Object.values(chain.state().chains).flatMap((c: any) => Object.values(c.operators ?? {})) as any[];
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      address: operator,
      service_type: "content-scanner",
      controller: "sprkdrm1opspolicy",
      bond_amount: "1000000000",
      signer: "scanner-operator",
      status: "OPERATOR_STATUS_ACTIVE",
    });
    const metadata = JSON.parse(Buffer.from(registered[0].metadata, "base64").toString("utf8"));
    const seed = JSON.parse(fs.readFileSync(path.join(dirs.secrets, "scanner.json"), "utf8")).verdictSeed;
    expect(metadata).toEqual({ v: 1, verdict_key: verdictPublicKey(seed), feed_url: `https://${FEED}/`, ruleset_version: "v1" });

    // the session key may only checkpoint, and reaches the scanner service
    const session = readSessions(dirs.secrets).scanner!;
    expect(session.granter).toBe(operator);
    const grant = Object.values(chain.state().chains).flatMap((c: any) => Object.values(c.sessions ?? {})).find(
      (g: any) => g.grantee === session.grantee,
    ) as any;
    expect(grant).toMatchObject({ signer: "scanner-operator", allowed_msg_types: ["/sparkdream.service.v1.MsgSubmitCheckpoint"] });
    const dseq = db.stepOutput<any>("fl", "create-deployments")!.perNode.scanner.dseq;
    expect(services.provider.sessionKeys.get(`${dseq}/scanner`)).toBe(session.mnemonic);

    // the feed is served on the domain, with the key written outside it
    const sdl = yaml.load(fs.readFileSync(path.join(dirs.sdl, "scanner.yaml"), "utf8")) as any;
    const svc = sdl.services.scanner;
    expect(svc.expose).toEqual([{ port: 8080, as: 80, accept: [FEED], to: [{ global: true }] }]);
    expect(svc.env).toEqual(
      expect.arrayContaining([
        "CS_LCD=https://api.phoenix.example",
        `CS_GRANTER=${operator}`,
        `CS_VERDICT_SEED=${seed}`,
        "CS_VERDICT_KEY_FILE=/data/verdict.key",
        "CS_FEED_DIR=/data/feed",
        "CS_LISTEN=:8080",
        `CS_FEED_URL=https://${FEED}/`,
      ]),
    );
    expect(svc.args.at(-1)).toMatch(/exec contentscan$/);
    db.close();
  }, 180_000);
});

describe("scanner added to a running fleet", () => {
  it("asks a wallet to fund the new operator, then registers it and keeps its metadata current", async () => {
    const chain = chainStub();
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const s = spec({ enabled: false });
    db.createLaunch("fl", JSON.stringify(s), "akash1owner");
    expect((await withStub(chain, () => runWithSigner(db, "fl", s, work, allSteps(), services, new FakeSigner()))).status).toBe("completed");
    const fleet = new FleetService(db, services, work);
    fleet.materialize("fl");
    const runOps = () =>
      withStub(chain, () =>
        runWithSigner(db, "fl", s, work, [...buildPreLaunchOpSteps(db, "fl"), ...allSteps(), ...buildOpSteps(db, "fl")], services, new FakeSigner()),
      );

    // no genesis funds for an operator made after launch: a wallet sends them
    fleet.requestAddComponent(db.getLaunch("fl")!, "scanner", { domain: FEED, settings: { enabled: true } });
    const paused = await runOps();
    expect(paused.status).toBe("awaiting-user");
    const secrets = launchDirs(work, "fl").secrets;
    const operator = fs.readFileSync(path.join(secrets, "scanner-operator.address"), "utf8").trim();
    expect(paused.reason).toMatch(new RegExp(`fund the scanner operator ${operator} with \\d+`));
    const step = db.listSteps("fl").find((x) => x.status === "waiting")!;
    expect(JSON.parse(step.wallet_json!).msgs[0]).toMatchObject({ "@type": "/cosmos.bank.v1beta1.MsgSend", to_address: operator });

    chain.edit((st) => (st.balances = { ...st.balances, [operator]: { [s.token.baseDenom]: "2000000000" } }));
    expect((await runOps()).status).toBe("completed");
    const st = Object.values(chain.state().chains)[0] as any;
    const record = st.operators[`${operator}/content-scanner`];
    expect(record).toMatchObject({ signer: "scanner-operator", status: "OPERATOR_STATUS_ACTIVE" });
    expect(readSessions(secrets).scanner!.granter).toBe(operator);
    // made after launch, yet listed with the fleet's accounts, key revealable
    expect(fleet.accounts(db.getLaunch("fl")!)).toContainEqual({ name: "scanner-operator", address: operator, hasMnemonic: true });
    expect(fleet.mnemonic(db.getLaunch("fl")!, "scanner-operator").split(" ")).toHaveLength(24);

    // metadata that no longer matches (another feed URL) is put back by the
    // next configure, with the operator's own key
    const want = record.metadata;
    chain.edit((st: any) => {
      const c = Object.values(st.chains)[0] as any;
      c.operators[`${operator}/content-scanner`].metadata = Buffer.from(JSON.stringify({ v: 1, feed_url: "https://old.example/" })).toString("base64");
    });
    db.createFleetOp("fl", "reconfigure", { keys: ["scanner"] });
    expect((await runOps()).status).toBe("completed");
    const after = (Object.values(chain.state().chains)[0] as any).operators[`${operator}/content-scanner`];
    expect(after.metadata).toBe(want);
    db.close();
  }, 240_000);
});
