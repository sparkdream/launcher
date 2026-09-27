import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { consensusAddress, FleetService } from "../src/fleet.js";
import { fakeServices, FakeSigner } from "./fakes.js";

/**
 * The fleet panel's block height for a validator: read inside the container
 * over lease-shell, and when the provider cannot do that (its API down), the
 * chain's latest commit through a sentry, with whether the validator signed.
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function fleet() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-height-"));
  tmpDirs.push(work);
  const db = new ConductorDb(path.join(work, "state.db"));
  const services = fakeServices();
  const spec = testnetSpec({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
  db.createLaunch("fl", JSON.stringify(spec), "akash1owner");
  const result = await runWithSigner(db, "fl", spec, work, allSteps(), services, new FakeSigner());
  expect(result.reason ?? "").toBe("");
  expect(result.status).toBe("completed");
  const svc = new FleetService(db, services, work);
  svc.materialize("fl");
  const launch = db.getLaunch("fl")!;
  const row = (key: string) => db.listFleetComponents("fl").find((c) => c.key === key)!;
  const address = consensusAddress(db.stepOutput<any>("fl", "generate-keys")!.consensusPubkeys["val-0"]);
  const commit = (height: number, signers: string[]) =>
    services.rpc.texts.set(
      "/commit",
      JSON.stringify({
        result: {
          signed_header: {
            header: { height: String(height) },
            commit: { signatures: signers.map((a) => ({ validator_address: a, block_id_flag: 2 })) },
          },
        },
      }),
    );
  return { db, services, svc, launch, row, address, commit };
}

describe("consensusAddress", () => {
  it("is the first 20 bytes of the pubkey's sha256, as CometBFT prints it", () => {
    // a devnet validator's key and the address its commits carry
    expect(consensusAddress("X9dyzQXpj+hlIplpOsUQ7UPSySscx2Sn5nVMDDAo3CM=")).toBe("189C94E5B3B71F216369435F199855AE7EDE8210");
  });
});

describe("validator block height", () => {
  it("reads the node itself while its provider answers", async () => {
    const { svc, launch, row, db } = await fleet();
    const h = await svc.componentHeight(launch, row("val-0"));
    expect(h).toMatchObject({ source: "node", catchingUp: false });
    expect(h!.height).toBeGreaterThan(0);
    db.close();
  }, 120_000);

  it("falls back to the chain's latest commit when the provider cannot reach in, and says whether it signed", async () => {
    const { svc, launch, row, services, address, commit, db } = await fleet();
    services.provider.apiDownDseqs.add(row("val-0").dseq);
    commit(32097, [address]);
    const h = await svc.componentHeight(launch, row("val-0"));
    expect(h).toMatchObject({ source: "chain", height: 32097, signed: true });
    expect(h!.providerError).toMatch(/provider reported a failure/);

    // a commit without its signature says so
    commit(32098, ["0000000000000000000000000000000000000000"]);
    expect(await svc.componentHeight(launch, row("val-0"))).toMatchObject({ height: 32098, signed: false });

    // polls within a minute go straight to the chain: no shell attempt each time
    const tries = () => services.provider.shellLog.filter((l) => l.dseq === row("val-0").dseq && l.script.includes("26657/status")).length;
    const before = tries();
    await Promise.all([1, 2, 3].map(() => svc.componentHeight(launch, row("val-0"))));
    expect(tries()).toBe(before);
    db.close();
  }, 120_000);
});
