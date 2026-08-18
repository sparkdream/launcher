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

  it("refuses a msg carrying raw bytes instead of a base64 string", async () => {
    // A Uint8Array survives JSON.stringify as {"0":5,...}, which the browser's
    // atob decode coerces to "[object Object]" and rejects with a bare DOM
    // InvalidCharacterError at Keplr signing time — no field, no step named.
    // The headscale-relaunch rekey step shipped exactly this. Fail at enqueue.
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const spec = testnetSpec();
    db.createLaunch("l-bytes", JSON.stringify(spec));

    const hash = new Uint8Array([5, 179, 171, 242]);
    const steps: StepDef[] = [
      {
        name: "raw-bytes",
        run: async (ctx) => ({
          txHash: await ctx.requireTx("raw-bytes", [
            { typeUrl: "/akash.deployment.v1beta4.MsgUpdateDeployment", value: { id: { owner: "a", dseq: "1" }, hash } },
          ]),
        }),
      },
    ];

    const res = await runLaunch(db, "l-bytes", spec, work, steps, fakeServices());
    expect(res.status).toBe("paused");
    const step = db.getStep("l-bytes", "raw-bytes");
    expect(step?.error).toMatch(/raw bytes/);
    expect(step?.error).toContain("hash");
    // nothing was queued for the wallet to sign
    expect(db.getPendingTx("l-bytes", "raw-bytes")).toBeFalsy();

    // the corrected form passes the same guard
    const ok: StepDef[] = [
      {
        name: "raw-bytes",
        run: async (ctx) => ({
          txHash: await ctx.requireTx("raw-bytes", [
            {
              typeUrl: "/akash.deployment.v1beta4.MsgUpdateDeployment",
              value: { id: { owner: "a", dseq: "1" }, hash: Buffer.from(hash).toString("base64") },
            },
          ]),
        }),
      },
    ];
    const retry = await runLaunch(db, "l-bytes", spec, work, ok, fakeServices());
    expect(retry.status).toBe("awaiting-signature");
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

describe("orphaned step cleanup", () => {
  it("clears a step left 'running' by a dead driver so the UI stops spinning", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const spec = testnetSpec();
    db.createLaunch("orphan", JSON.stringify(spec), "akash1owner");

    // a previous driver died mid-"late" (restart/crash) while an EARLIER step
    // had already failed — the state the UI renders as a spinning step that
    // hides the real blocker
    db.stepStarted("orphan", "early");
    db.stepFailed("orphan", "early", "boom");
    db.stepStarted("orphan", "late"); // never finished
    expect(db.getStep("orphan", "late")?.status).toBe("running");

    const steps: StepDef[] = [
      { name: "early", async run() { return { ok: true }; } },
      { name: "late", async run() { return { ok: true }; } },
    ];
    const result = await runLaunch(db, "orphan", spec, work, steps, fakeServices());

    expect(result.status).toBe("completed");
    // the orphan was cleared and then genuinely re-run, not left 'running'
    expect(db.getStep("orphan", "late")?.status).toBe("done");
    db.close();
  });
});
