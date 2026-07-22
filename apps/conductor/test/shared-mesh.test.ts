import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runWithSigner } from "../src/engine.js";
import { allSteps } from "../src/index.js";
import { FleetService } from "../src/fleet.js";
import { dependentFleets, resolveSharedHeadscale } from "../src/headscale-reuse.js";
import { fakeServices, FakeSigner } from "./fakes.js";

/**
 * Shared mesh (topology.headscale.reuseFleet): a second fleet attaches to
 * the first fleet's headscale — no headscale deploy/lease of its own, no
 * borrowed component row, and the owning fleet cannot shut down while the
 * dependent lives.
 */

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-mesh-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function spec(name: string, headscale: Record<string, unknown>): LaunchSpec {
  return testnetSpec({
    network: { name, type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale,
    },
  });
}

describe("shared mesh across fleets", () => {
  it("second fleet attaches to the first fleet's headscale and the owner is shutdown-guarded", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const services = fakeServices();
    const signer = new FakeSigner();
    const fleet = new FleetService(db, services, work);

    // fleet A: owns the mesh
    const specA = spec("sparkdream", { domain: "headscale.sparkdream.io" });
    db.createLaunch("fleet-a", JSON.stringify(specA), "akash1owner");
    const resultA = await runWithSigner(db, "fleet-a", specA, work, allSteps(), services, signer);
    if (resultA.status !== "completed") {
      const step = db.listSteps("fleet-a").find((x) => x.status !== "done");
      throw new Error(`fleet A ended ${resultA.status} at ${step?.name}: ${step?.error}`);
    }
    const hsA = db.stepOutput<any>("fleet-a", "deploy-headscale")!;
    const signaturesForA = signer.signed.length;

    // fleet B: shares it — resolve like the server does at launch creation
    const specB = spec("sparkdreamtwo", { reuseFleet: "sparkdream" });
    const shared = resolveSharedHeadscale(db, specB, "akash1owner")!;
    expect(shared.launchId).toBe("fleet-a");
    expect(shared.dseq).toBe(hsA.dseq);
    specB.topology.headscale.reuseFleet = shared.launchId;
    specB.topology.headscale.domain = shared.domain;

    db.createLaunch("fleet-b", JSON.stringify(specB), "akash1owner");
    const resultB = await runWithSigner(db, "fleet-b", specB, work, allSteps(), services, signer);
    if (resultB.status !== "completed") {
      const step = db.listSteps("fleet-b").find((x) => x.status !== "done");
      throw new Error(`fleet B ended ${resultB.status} at ${step?.name}: ${step?.error}`);
    }

    // the deploy step attached instead of deploying: same lease, borrowed
    const hsB = db.stepOutput<any>("fleet-b", "deploy-headscale")!;
    expect(hsB.reused).toBe(true);
    expect(hsB.reusedFrom).toBe("fleet-a");
    expect(hsB.dseq).toBe(hsA.dseq);
    expect(hsB.price).toBe("0");

    // two fewer signatures than fleet A: no headscale deployment, no
    // headscale lease (cert, node deployments, node leases, persist-start)
    expect(signer.signed.length - signaturesForA).toBe(signaturesForA - 2);

    // no headscale deployment tx was signed for fleet B (its only
    // MsgCreateDeployment batch is the node batch)
    const bTxs = signer.signed.slice(signaturesForA);
    const deployBatches = bTxs.filter((tx) =>
      tx.some((m) => m.typeUrl.includes("MsgCreateDeployment")),
    );
    expect(deployBatches).toHaveLength(1);

    // fleet B has its own headscale user + preauth keys on the shared server
    expect(services.provider.shellLog.some((s) => s.script.includes("users create sparkdreamtwo"))).toBe(
      true,
    );

    // the borrowed headscale is not a fleet B component (nothing to close,
    // bill, or health-check there)
    fleet.materialize("fleet-b");
    const bComponents = db.listFleetComponents("fleet-b").map((c) => c.key);
    expect(bComponents).not.toContain("headscale");
    expect(bComponents).toContain("val-0");

    // owning fleet cannot shut down or close headscale while B lives
    expect(dependentFleets(db, "fleet-a").map((l) => l.id)).toEqual(["fleet-b"]);
    const launchA = db.getLaunch("fleet-a")!;
    await expect(fleet.requestShutdown(launchA)).rejects.toThrow(/sparkdreamtwo/);
    fleet.materialize("fleet-a");
    const hsRow = db.listFleetComponents("fleet-a").find((c) => c.key === "headscale")!;
    expect(() => fleet.requestClose(launchA, hsRow)).toThrow(/shut those fleets down first/);

    // B's own shutdown is unguarded, and closing it frees A
    const launchB = db.getLaunch("fleet-b")!;
    const shutdownB = await fleet.requestShutdown(launchB);
    expect(shutdownB.closing).not.toContain("headscale");
    for (const c of db.listFleetComponents("fleet-b")) {
      db.setComponentState("fleet-b", c.key, "closed");
    }
    expect(dependentFleets(db, "fleet-a")).toEqual([]);
    const shutdownA = await fleet.requestShutdown(launchA);
    expect(shutdownA.closing).toContain("headscale");

    db.close();
  }, 240_000);

  it("resolveSharedHeadscale refuses foreign owners, aborted fleets, and chained reuse", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));

    const specA = spec("sparkdream", { domain: "headscale.sparkdream.io" });
    db.createLaunch("fleet-a", JSON.stringify(specA), "akash1owner");
    const wants = spec("sparkdreamtwo", { reuseFleet: "fleet-a" });

    // fleet exists but has no headscale yet
    expect(() => resolveSharedHeadscale(db, wants, "akash1owner")).toThrow(/no headscale deployed/);
    db.stepStarted("fleet-a", "deploy-headscale");
    db.stepDone("fleet-a", "deploy-headscale", {
      dseq: "1000",
      provider: "akash1prov",
      hostUri: "https://p.example.com:8443",
      price: "100",
      gseq: 1,
      oseq: 1,
    });

    // wrong wallet
    expect(() => resolveSharedHeadscale(db, wants, "akash1intruder")).toThrow(/different wallet/);

    // happy path resolves by id or by unique network name
    expect(resolveSharedHeadscale(db, wants, "akash1owner")!.domain).toBe("headscale.sparkdream.io");
    const byName = spec("sparkdreamtwo", { reuseFleet: "sparkdream" });
    expect(resolveSharedHeadscale(db, byName, "akash1owner")!.launchId).toBe("fleet-a");

    // chained reuse is refused (point at the owner directly)
    const specB = spec("sparkdreamtwo", { reuseFleet: "fleet-a" });
    specB.topology.headscale.domain = "headscale.sparkdream.io";
    db.createLaunch("fleet-b", JSON.stringify(specB), "akash1owner");
    const wantsChain = spec("sparkdreamthree", { reuseFleet: "fleet-b" });
    expect(() => resolveSharedHeadscale(db, wantsChain, "akash1owner")).toThrow(/owning fleet/);

    // aborted fleets don't resolve
    db.setLaunchStatus("fleet-a", "aborted");
    expect(() => resolveSharedHeadscale(db, wants, "akash1owner")).toThrow(/shut down/);

    db.close();
  });
});
