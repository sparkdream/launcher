import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { validateSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import { runLaunch, type StepDef } from "./engine.js";
import type { Services } from "./services.js";

export interface ServerDeps {
  db: ConductorDb;
  services: Services;
  workRoot: string;
  steps: StepDef[];
}

/**
 * Backend API (§8). Owner scoping: the owner address accompanies launch
 * creation and is stored server-side; wallet-session auth (signArbitrary +
 * allowlist) lands with M4/M6 — routes are factored so it drops in as a
 * fastify preHandler.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify();
  const running = new Set<string>();

  // Fire-and-forget: SSH phases run for minutes, HTTP must not block on
  // them. The UI polls GET /api/launches/:id + pending-tx. (WS events: M4.)
  // A drive requested while one is active re-runs when it finishes, so a
  // tx-result landing mid-run is never stranded.
  const rerun = new Set<string>();
  const drive = (id: string, spec: LaunchSpec): "started" | "already-running" => {
    if (running.has(id)) {
      rerun.add(id);
      return "already-running";
    }
    running.add(id);
    void runLaunch(deps.db, id, spec, deps.workRoot, deps.steps, deps.services)
      .catch((e) => {
        deps.db.setLaunchStatus(id, "paused");
        app.log.error(e, `launch ${id} driver crashed`);
      })
      .finally(() => {
        running.delete(id);
        if (rerun.delete(id)) drive(id, spec);
      });
    return "started";
  };

  app.post("/api/launches", async (req, reply) => {
    const body = req.body as { spec: unknown; owner?: string };
    let spec: LaunchSpec;
    try {
      spec = withDefaults(body.spec);
    } catch (e) {
      return reply.status(400).send({ error: "schema", detail: String(e) });
    }
    const result = validateSpec(spec);
    if (!result.ok) return reply.status(400).send({ error: "validation", issues: result.errors });
    const id = randomUUID();
    deps.db.createLaunch(id, JSON.stringify(spec), body.owner ?? "");
    return reply.status(201).send({ id, warnings: result.warnings });
  });

  app.get("/api/launches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    return {
      id,
      status: launch.status,
      spec: JSON.parse(launch.spec_json),
      steps: deps.db.listSteps(id).map((s) => ({
        name: s.name,
        status: s.status,
        error: s.error,
        started_at: s.started_at,
        finished_at: s.finished_at,
      })),
    };
  });

  app.post("/api/launches/:id/start", startOrResume);
  app.post("/api/launches/:id/resume", startOrResume);

  async function startOrResume(req: any, reply: any) {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (launch.status === "completed") return { status: "completed" };
    return { status: drive(id, JSON.parse(launch.spec_json)) };
  }

  app.post("/api/launches/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.db.getLaunch(id)) return reply.status(404).send({ error: "not found" });
    deps.db.setLaunchStatus(id, "aborted");
    // teardown plan (close deployments) is enqueued by the fleet layer (M5)
    return { status: "aborted" };
  });

  // --- Keplr signing loop (§8) ---

  app.get("/api/launches/:id/pending-tx", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.db.getLaunch(id)) return reply.status(404).send({ error: "not found" });
    const pending = deps.db.nextPendingTx(id);
    if (!pending) return reply.status(204).send();
    return { step: pending.step, msgs: JSON.parse(pending.msgs_json) };
  });

  app.post("/api/launches/:id/tx-result", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { txHash } = req.body as { txHash: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    const pending = deps.db.nextPendingTx(id);
    if (!pending) return reply.status(409).send({ error: "no pending tx" });
    deps.db.setPendingTxSigned(id, pending.step, txHash);
    // resume in the background: requireTx verifies inclusion on-chain
    return { status: drive(id, JSON.parse(launch.spec_json)) };
  });

  return app;
}
