import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { runLaunch, type StepDef } from "../src/engine.js";
import { fakeServices } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-engine-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("runLaunch checkpointing", () => {
  it("pauses on failure and resumes past completed steps", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const spec = testnetSpec();
    db.createLaunch("l1", JSON.stringify(spec));

    const ran: string[] = [];
    let failOnce = true;
    const steps: StepDef[] = [
      { name: "a", run: async () => (ran.push("a"), { fromA: 1 }) },
      {
        name: "b",
        run: async () => {
          ran.push("b");
          if (failOnce) {
            failOnce = false;
            throw new Error("transient");
          }
          return { fromB: 2 };
        },
      },
      {
        name: "c",
        run: async (ctx) => {
          ran.push("c");
          return { sawA: ctx.output<{ fromA: number }>("a")?.fromA };
        },
      },
    ];

    const services = fakeServices();
    const first = await runLaunch(db, "l1", spec, work, steps, services);
    expect(first).toEqual({ status: "paused", failedStep: "b" });
    expect(db.getLaunch("l1")?.status).toBe("paused");
    expect(db.getStep("l1", "a")?.status).toBe("done");
    expect(db.getStep("l1", "b")?.status).toBe("error");
    expect(db.getStep("l1", "b")?.error).toContain("transient");

    const second = await runLaunch(db, "l1", spec, work, steps, services);
    expect(second.status).toBe("completed");
    expect(ran).toEqual(["a", "b", "b", "c"]); // a not re-run, b retried, c ran once
    expect(db.stepOutput<{ sawA: number }>("l1", "c")?.sawA).toBe(1);
    db.close();
  });

  it("refreshes unsigned pending-tx msgs when a step re-run produces different ones", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const spec = testnetSpec();
    db.createLaunch("l2", JSON.stringify(spec));

    // simulates a conductor fix between runs: same step, corrected msg
    let payload = "stale-pubkey";
    const steps: StepDef[] = [
      {
        name: "needs-sig",
        run: async (ctx) => ({
          txHash: await ctx.requireTx("needs-sig", [
            { typeUrl: "/test.Msg", value: { payload } },
          ]),
        }),
      },
    ];

    const services = fakeServices();
    const first = await runLaunch(db, "l2", spec, work, steps, services);
    expect(first.status).toBe("awaiting-signature");
    expect(db.getPendingTx("l2", "needs-sig")?.msgs_json).toContain("stale-pubkey");

    payload = "fixed-pubkey";
    const second = await runLaunch(db, "l2", spec, work, steps, services);
    expect(second.status).toBe("awaiting-signature");
    // still unsigned, so the stored msgs follow the fixed code
    expect(db.getPendingTx("l2", "needs-sig")?.msgs_json).toContain("fixed-pubkey");
    db.close();
  });

  it("refreshes an unsigned pending gentx sign doc when the caller rebuilds it", async () => {
    // promote-validator sign docs embed the live account sequence: after a
    // stale-sequence broadcast failure the caller resets the row and builds
    // a fresh doc — the wallet must be served the fresh one, or it re-signs
    // the stale sequence forever
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const spec = testnetSpec();
    db.createLaunch("l3", JSON.stringify(spec));

    let sequence = 4;
    const steps: StepDef[] = [
      {
        name: "promote",
        run: async (ctx) => ({
          response: ctx.requireGentx(0, "spark1operator", JSON.stringify({ sequence })),
        }),
      },
    ];

    const services = fakeServices();
    const first = await runLaunch(db, "l3", spec, work, steps, services);
    expect(first.status).toBe("awaiting-gentx");
    expect(db.getPendingGentx("l3", 0)?.sign_doc_json).toContain('"sequence":4');

    sequence = 5; // the operator transacted; the rebuilt doc has new coordinates
    const second = await runLaunch(db, "l3", spec, work, steps, services);
    expect(second.status).toBe("awaiting-gentx");
    expect(db.getPendingGentx("l3", 0)?.sign_doc_json).toContain('"sequence":5');
    expect(db.getPendingGentx("l3", 0)?.status).toBe("pending");
    db.close();
  });
});
