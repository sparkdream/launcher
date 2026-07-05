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
});
