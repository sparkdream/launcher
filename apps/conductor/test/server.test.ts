import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testnetSpecInput, withDefaults } from "@sparkdream/launch-spec";
import { ConductorDb } from "../src/db.js";
import { buildServer } from "../src/server.js";
import { allSteps } from "../src/index.js";
import { fakeServices } from "./fakes.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-server-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function specInput() {
  return testnetSpecInput({
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "sprkdrm" },
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
    },
  });
}

describe("API server (§8)", () => {
  it("rejects invalid specs with 400", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({ db, services: fakeServices(), workRoot: work, steps: allSteps() });
    const res = await app.inject({
      method: "POST",
      url: "/api/launches",
      payload: { spec: { version: 2 } },
    });
    expect(res.statusCode).toBe(400);
    db.close();
  });

  it("drives a full launch through the HTTP signing loop", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({ db, services: fakeServices(), workRoot: work, steps: allSteps() });

    const created = await app.inject({
      method: "POST",
      url: "/api/launches",
      payload: { spec: specInput(), owner: "akash1owner" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const started = (await app.inject({ method: "POST", url: `/api/launches/${id}/start` })).json() as any;
    expect(started.status).toBe("started");

    // The driver runs in the background — poll like the UI does: launch
    // status + pending-tx; sign whatever comes due.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let signatures = 0;
    let status = "";
    for (let i = 0; i < 2000 && status !== "completed"; i++) {
      status = ((await app.inject({ method: "GET", url: `/api/launches/${id}` })).json() as any).status;
      const pending = await app.inject({ method: "GET", url: `/api/launches/${id}/pending-tx` });
      if (pending.statusCode === 200) {
        const { step, msgs } = pending.json() as { step: string; msgs: unknown[] };
        expect(msgs.length).toBeGreaterThan(0);
        signatures++;
        await app.inject({
          method: "POST",
          url: `/api/launches/${id}/tx-result`,
          payload: { txHash: `${signatures}`.repeat(64).slice(0, 64) },
        });
      }
      await sleep(20);
    }

    expect(status).toBe("completed");
    expect(signatures).toBe(6); // §2: 5 + persist-start on testnet

    const view = (await app.inject({ method: "GET", url: `/api/launches/${id}` })).json() as any;
    expect(view.status).toBe("completed");
    expect(view.steps.every((s: any) => s.status === "done")).toBe(true);

    const noPending = await app.inject({ method: "GET", url: `/api/launches/${id}/pending-tx` });
    expect(noPending.statusCode).toBe(204);
    db.close();
  }, 120_000);

  it("launches a services fleet (no chain) through the same routes and signing loop", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({ db, workRoot: work, steps: allSteps(), services: fakeServices() });
    const created = await app.inject({
      method: "POST",
      url: "/api/launches",
      payload: {
        owner: "akash1owner",
        spec: testnetSpecInput({
          kind: "services",
          network: { name: "zenith-commons", type: "testnet", bech32Prefix: "sprkdrm" },
          topology: {
            validators: { count: 1 },
            sentries: { count: 1 },
            components: {
              explorer: { enabled: false },
              frontend: { enabled: false },
              hub: { enabled: false },
              mastodon: { enabled: true, domain: "social.zenith.example", owner: { username: "admin", email: "admin@zenith.example" } },
            },
            headscale: {},
          },
        } as any),
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    expect(((await app.inject({ method: "POST", url: `/api/launches/${id}/start` })).json() as any).status).toBe("started");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let status = "";
    let signatures = 0;
    for (let i = 0; i < 2000 && status !== "completed"; i++) {
      status = ((await app.inject({ method: "GET", url: `/api/launches/${id}` })).json() as any).status;
      const pending = await app.inject({ method: "GET", url: `/api/launches/${id}/pending-tx` });
      if (pending.statusCode === 200) {
        signatures++;
        await app.inject({ method: "POST", url: `/api/launches/${id}/tx-result`, payload: { txHash: `${signatures}`.repeat(64).slice(0, 64) } });
      }
      await sleep(20);
    }
    expect(status).toBe("completed");
    const steps = ((await app.inject({ method: "GET", url: `/api/launches/${id}` })).json() as any).steps.map((s: any) => s.name);
    expect(steps).toEqual(expect.arrayContaining(["create-deployments", "create-leases", "verify-services", "configure-mastodon"]));
    expect(steps).not.toContain("build-genesis");
    expect(steps).not.toContain("deploy-headscale");
    // one Mastodon deployment: certificate, deployment, lease
    expect(signatures).toBeLessThanOrEqual(3);
    db.close();
  }, 120_000);

  it("add-component route: 404 unknown launch, 400 without a key, 409 with the fleet's reason", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    const app = buildServer({ db, services: fakeServices(), workRoot: work, steps: allSteps() });
    const missing = await app.inject({ method: "POST", url: "/api/fleet/nope/components", payload: { key: "explorer" } });
    expect(missing.statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/api/launches",
      payload: { spec: specInput(), owner: "akash1owner" },
    });
    const { id } = created.json() as { id: string };
    const noKey = await app.inject({ method: "POST", url: `/api/fleet/${id}/components`, payload: {} });
    expect(noKey.statusCode).toBe(400);
    // created but never run: nothing to add to yet
    const early = await app.inject({
      method: "POST",
      url: `/api/fleet/${id}/components`,
      payload: { key: "explorer", domain: "explorer.sparkdream.io" },
    });
    expect(early.statusCode).toBe(409);
    expect((early.json() as { error: string }).error).toContain("has not finished");
    db.close();
  });

  it("resumes an orphaned running launch on boot", async () => {
    const work = tmp();
    const db = new ConductorDb(path.join(work, "state.db"));
    // a launch whose driver died mid-run: status "running", nobody driving —
    // without boot resume it would sit "running" forever with no Retry
    db.createLaunch("orphan", JSON.stringify(withDefaults(specInput())), "akash1owner");
    db.setLaunchStatus("orphan", "running");
    const app = buildServer({ db, services: fakeServices(), workRoot: work, steps: allSteps() });

    // boot resume drives it in the background until the first signing pause
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let status = "";
    for (let i = 0; i < 2000 && status !== "paused"; i++) {
      status = ((await app.inject({ method: "GET", url: "/api/launches/orphan" })).json() as any)
        .status;
      await sleep(20);
    }
    expect(status).toBe("paused");
    // parked at the normal signing loop, resumable like any launch
    const pending = await app.inject({ method: "GET", url: "/api/launches/orphan/pending-tx" });
    expect(pending.statusCode).toBe(200);
    db.close();
  }, 120_000);
});
