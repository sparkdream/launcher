import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateSpec, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import { launchDirs, runLaunch, type StepDef } from "./engine.js";
import { AuthService } from "./auth.js";
import { buildTmkmsSetup } from "./tmkms.js";
import { FleetService } from "./fleet.js";
import { buildOpSteps } from "./fleet-ops.js";
import { estimateLaunchCost } from "./estimate.js";
import { feeConfig } from "./fee.js";
import type { Services } from "./services.js";

export interface ServerDeps {
  db: ConductorDb;
  services: Services;
  workRoot: string;
  steps: StepDef[];
  /** Health monitor cadence; 0 disables the background loop (tests tick manually). */
  monitorIntervalMs?: number;
  /**
   * Wallet-session auth (M6, §2): when set, every /api route (except
   * /api/auth/*) requires a bearer token, and the session's address is the
   * owner scope. Unset = local mode (owner via request parameter).
   */
  auth?: { allowlist: string[] };
  /** Launcher-on-Akash flag (§2): adds the mainnet warning at create. */
  onAkash?: boolean;
}

/**
 * Backend API (§8). Owner scoping: the owner address accompanies launch
 * creation and is stored server-side; wallet-session auth (signArbitrary +
 * allowlist) lands with M4/M6 — routes are factored so it drops in as a
 * fastify preHandler.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify();
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  const running = new Set<string>();
  const fleet = new FleetService(deps.db, deps.services, deps.workRoot);
  const auth = deps.auth ? new AuthService(deps.auth.allowlist) : undefined;

  // §2 scoping rule: with auth on, owner comes from the session; locally,
  // from the request (single connected wallet)
  const sessionOwner = (req: { headers: Record<string, unknown> }): string | undefined => {
    const header = String(req.headers.authorization ?? "");
    return auth?.ownerFor(header.replace(/^Bearer /, "") || undefined);
  };

  app.get("/api/auth/mode", async () => ({ required: Boolean(auth) }));

  if (auth) {
    app.post("/api/auth/nonce", async (req) => {
      const { address } = req.body as { address: string };
      return { nonce: auth.issueNonce(address) };
    });
    app.post("/api/auth/verify", async (req, reply) => {
      const { address, signature } = req.body as { address: string; signature: any };
      try {
        return { token: await auth.verify(address, signature) };
      } catch (e) {
        return reply.status(401).send({ error: String(e) });
      }
    });
    app.addHook("preHandler", async (req, reply) => {
      if (!req.url.startsWith("/api") || req.url.startsWith("/api/auth/")) return;
      const owner = sessionOwner(req as any);
      if (!owner) return reply.status(401).send({ error: "wallet session required" });
      (req as any).owner = owner;
    });
  }

  const requestOwner = (req: any, fallback?: string): string | undefined =>
    (req.owner as string | undefined) ?? fallback;

  // §2 scoping rule: the preHandler only proves a valid session exists —
  // every launch-scoped route must also verify the session owns the launch
  const denyForeign = (req: any, reply: any, launch: { owner: string }): boolean => {
    if (auth && launch.owner !== requestOwner(req)) {
      reply.status(403).send({ error: "not your launch" });
      return true;
    }
    return false;
  };

  // WS /api/fleet/events (§8): health/runway deltas pushed from the monitor
  const sockets = new Set<{ send(data: string): void }>();
  app.register(websocket);
  app.register(async (scope) => {
    scope.get("/api/fleet/events", { websocket: true }, (socket) => {
      sockets.add(socket);
      (socket as any).on("close", () => sockets.delete(socket));
    });
  });
  const broadcast = (event: unknown) => {
    const data = JSON.stringify(event);
    for (const s of sockets) {
      try {
        s.send(data);
      } catch {
        sockets.delete(s);
      }
    }
  };

  // §5 "Fleet health monitor": background cadence, cache served by GET /api/fleet
  const interval = deps.monitorIntervalMs ?? 45_000;
  if (interval > 0) {
    const timer = setInterval(async () => {
      // launches are independent — sweep them concurrently so one hung
      // provider can't delay every other fleet's health refresh
      await Promise.all(
        deps.db.listCompletedLaunches().map(async (launch) => {
          await fleet.tick(launch.id).catch(() => {});
          await fleet.settleFleetTxs(launch.id).catch(() => {});
          broadcast({ type: "health", launchId: launch.id, health: deps.db.listComponentHealth(launch.id) });
        }),
      );
    }, interval);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

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
    // fleet ops (relaunch/upgrade) compose onto the launch's step list —
    // completed launch steps checkpoint-skip, then op steps run
    const steps = [...deps.steps, ...buildOpSteps(deps.db, id)];
    void runLaunch(deps.db, id, spec, deps.workRoot, steps, deps.services)
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

  // service fee schedule — lets the UI show exact day-2 fee amounts and
  // honor env overrides (the fee is always visible in the Keplr prompt too)
  app.get("/api/fee", async () => feeConfig());

  // pre-launch running-cost estimate for a spec — read-only market data,
  // callable before any wallet is connected
  app.post("/api/estimate", async (req, reply) => {
    let spec: LaunchSpec;
    try {
      spec = withDefaults((req.body as { spec: unknown }).spec);
    } catch (e) {
      return reply.status(400).send({ error: "schema", detail: String(e) });
    }
    return estimateLaunchCost(spec);
  });

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
    const warnings = [...result.warnings];
    if (deps.onAkash && spec.network.type === "mainnet") {
      // §2 security model: mainnet secrets do not belong on provider disk
      warnings.push({
        path: "network.type",
        message:
          "this launcher runs ON Akash: launch-time secrets live on an untrusted provider — run a local launcher for mainnet (and use tmkms + external operators)",
      });
    }
    const id = randomUUID();
    deps.db.createLaunch(id, JSON.stringify(spec), requestOwner(req, body.owner) ?? "");
    return reply.status(201).send({ id, warnings });
  });

  app.get("/api/launches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
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
    if (denyForeign(req, reply, launch)) return;
    if (launch.status === "completed") return { status: "completed" };
    if (launch.status === "aborted") {
      return reply
        .status(409)
        .send({ error: "launch aborted — its fleet was shut down; start a new launch" });
    }
    return { status: drive(id, JSON.parse(launch.spec_json)) };
  }

  // permanently delete a shut-down launch (records + work dir with secrets);
  // "export fleet bundle" beforehand is the archival path
  app.delete("/api/launches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    if (running.has(id)) return reply.status(409).send({ error: "launch is currently driving — try again shortly" });
    try {
      await fleet.deleteLaunch(launch);
      return { status: "deleted" };
    } catch (e) {
      return reply.status(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.post("/api/launches/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    deps.db.setLaunchStatus(id, "aborted");
    // teardown plan (close deployments) is enqueued by the fleet layer (M5)
    return { status: "aborted" };
  });

  // --- Keplr signing loop (§8) ---

  app.get("/api/launches/:id/pending-tx", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    const pending = deps.db.nextPendingTx(id);
    if (!pending) return reply.status(204).send();
    return { step: pending.step, msgs: JSON.parse(pending.msgs_json) };
  });

  app.post("/api/launches/:id/tx-result", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { txHash } = req.body as { txHash: string };
    // LCDs answer 5xx (not 404) for malformed hashes — reject here so the
    // signing loop never polls tx status with garbage
    if (!/^[0-9A-Fa-f]{64}$/.test(txHash ?? "")) {
      return reply.status(400).send({ error: "txHash must be 64 hex chars" });
    }
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    const pending = deps.db.nextPendingTx(id);
    if (!pending) return reply.status(409).send({ error: "no pending tx" });
    deps.db.setPendingTxSigned(id, pending.step, txHash);
    if (pending.step.startsWith("fleet:")) {
      // fleet actions settle outside the launch step engine
      await fleet.settleFleetTxs(id);
      return { status: "settled" };
    }
    // resume in the background: requireTx verifies inclusion on-chain
    return { status: drive(id, JSON.parse(launch.spec_json)) };
  });

  // --- fleet (M5, §8) — owner from query param until M6 session auth ---

  app.get("/api/fleet", async (req, reply) => {
    const owner = requestOwner(req, (req.query as { owner?: string }).owner);
    if (!owner) return reply.status(400).send({ error: "owner required" });
    return fleet.fleetForOwner(owner);
  });

  app.post("/api/fleet/:launchId/:dseq/actions", async (req, reply) => {
    const { launchId, dseq } = req.params as { launchId: string; dseq: string };
    const body = req.body as {
      action: "close" | "restart" | "relaunch" | "upgrade" | "halt-upgrade" | "topup";
      confirm?: boolean;
      image?: string;
      components?: string[];
      amount?: string;
      haltHeight?: number;
    };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    // SSH-mutating actions carry no signature — session must own the fleet (§2)
    if (denyForeign(req, reply, launch)) return;
    fleet.materialize(launchId);
    const component = deps.db.getFleetComponentByDseq(launchId, dseq);
    if (!component) return reply.status(404).send({ error: "component not found" });
    const spec = JSON.parse(launch.spec_json) as LaunchSpec;

    switch (body.action) {
      case "close": {
        const warnings = fleet.closeWarnings(launch, component);
        if (warnings.length > 0 && !body.confirm) {
          // pre-action guard (§5): the UI re-posts with confirm after the dialog
          return reply.status(409).send({ warnings });
        }
        const { step } = fleet.requestClose(launch, component);
        return { status: "awaiting-signature", step };
      }
      case "restart": {
        await fleet.restart(launch, component);
        return { status: "restarted" };
      }
      case "relaunch": {
        const warnings = fleet.closeWarnings(launch, component);
        if (warnings.length > 0 && !body.confirm) return reply.status(409).send({ warnings });
        const opId = fleet.requestRelaunch(launch, component);
        drive(launchId, spec);
        return { status: "relaunch-started", opId };
      }
      case "upgrade": {
        if (!body.image) return reply.status(400).send({ error: "image required" });
        // rolling scope: given components or the whole node fleet (§5).
        // Defaulting to nodes only — the image is a sparkdreamd tag;
        // explorer/frontend upgrades name their component explicitly.
        const components =
          body.components ??
          deps.db
            .listFleetComponents(launchId)
            .filter((c) => c.state === "active" && /^(val|sentry)-/.test(c.key))
            .map((c) => c.key);
        const opId = fleet.requestUpgrade(launch, components, body.image);
        drive(launchId, spec);
        return { status: "upgrade-started", opId, components };
      }
      case "halt-upgrade": {
        if (!body.image || !body.haltHeight) {
          return reply.status(400).send({ error: "image and haltHeight required" });
        }
        const opId = fleet.requestHaltUpgrade(launch, body.image, body.haltHeight);
        drive(launchId, spec);
        return { status: "halt-upgrade-started", opId };
      }
      case "topup": {
        if (!body.amount) return reply.status(400).send({ error: "amount required" });
        const { step } = await fleet.requestTopUp(launch, component, body.amount);
        return { status: "awaiting-signature", step };
      }
      default:
        return reply.status(400).send({ error: "unknown action" });
    }
  });

  app.get("/api/fleet/:launchId/:dseq/logs", async (req, reply) => {
    const { launchId, dseq } = req.params as { launchId: string; dseq: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    const component = deps.db.getFleetComponentByDseq(launchId, dseq);
    if (!component) return reply.status(404).send({ error: "component not found" });
    const text = await fleet.logs(launch, component, Number((req.query as any).tail ?? 100));
    return reply.type("text/plain").send(text);
  });

  // the rendered SDL a component was deployed with (paste into Console)
  app.get("/api/fleet/:launchId/:dseq/sdl", async (req, reply) => {
    const { launchId, dseq } = req.params as { launchId: string; dseq: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    const component = deps.db.getFleetComponentByDseq(launchId, dseq);
    if (!component) return reply.status(404).send({ error: "component not found" });
    return reply.type("text/yaml").send(fleet.componentSdl(launch, component));
  });

  // live block height of a node (polled frequently for a real-time indicator)
  app.get("/api/fleet/:launchId/:dseq/height", async (req, reply) => {
    const { launchId, dseq } = req.params as { launchId: string; dseq: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    const component = deps.db.getFleetComponentByDseq(launchId, dseq);
    if (!component) return reply.status(404).send({ error: "component not found" });
    const h = await fleet.componentHeight(launch, component).catch(() => null);
    if (!h) return reply.status(503).send({ error: "rpc unreachable" });
    return h;
  });

  // the chain's genesis.json (identical for every node)
  app.get("/api/launches/:id/genesis", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    const file = path.join(launchDirs(deps.workRoot, id).node("val-0"), "config", "genesis.json");
    if (!fs.existsSync(file)) return reply.status(404).send({ error: "genesis not built yet" });
    return reply.type("application/json").send(fs.readFileSync(file, "utf8"));
  });

  // abandon a stuck op (e.g. relaunch on a broken provider)
  app.post("/api/fleet/:launchId/ops/:opId/abort", async (req, reply) => {
    const { launchId, opId } = req.params as { launchId: string; opId: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    try {
      const result = await fleet.requestAbortOp(launch, Number(opId));
      return { status: "aborted", ...result };
    } catch (e) {
      return reply.status(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // wallet-global provider avoid/prefer lists (relaunch of ANY of the
  // owner's launches consults them). Scoped by the launch's owner, reached
  // via the fleet route the UI already uses.
  app.get("/api/fleet/:launchId/provider-prefs", async (req, reply) => {
    const { launchId } = req.params as { launchId: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    return fleet.providerPrefs(launch.owner);
  });

  app.post("/api/fleet/:launchId/provider-prefs", async (req, reply) => {
    const { launchId } = req.params as { launchId: string };
    const { provider, kind, name } = req.body as {
      provider: string;
      kind: "avoid" | "prefer" | "none";
      name?: string;
    };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    if (!provider || !["avoid", "prefer", "none"].includes(kind)) {
      return reply.status(400).send({ error: "provider and kind (avoid|prefer|none) required" });
    }
    fleet.setProviderPref(launch.owner, provider, kind, name);
    return fleet.providerPrefs(launch.owner);
  });

  // change component domains / public endpoints after launch (retarget op):
  // updates the stored spec, then MsgUpdateDeployment + manifests re-point
  // the accept-domain ingress and the frontend's endpoint env
  app.post("/api/fleet/:launchId/domains", async (req, reply) => {
    const { launchId } = req.params as { launchId: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    const body = (req.body ?? {}) as {
      explorer?: string;
      frontend?: string;
      api?: string;
      rpc?: string;
      explorerRoute?: string;
    };
    try {
      const opId = fleet.requestDomainUpdate(launch, body);
      // drive with the UPDATED spec — requestDomainUpdate just rewrote it
      drive(launchId, JSON.parse(deps.db.getLaunch(launchId)!.spec_json));
      return { status: "retarget-started", opId };
    } catch (e) {
      return reply.status(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // named accounts (generate-keys): addresses openly; the mnemonic reveal is
  // a separate per-account call so seeds never ride the list response
  app.get("/api/fleet/:launchId/accounts", async (req, reply) => {
    const { launchId } = req.params as { launchId: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    try {
      return { accounts: fleet.accounts(launch) };
    } catch (e) {
      return reply.status(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.get("/api/fleet/:launchId/accounts/:name/mnemonic", async (req, reply) => {
    const { launchId, name } = req.params as { launchId: string; name: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    try {
      return { mnemonic: fleet.mnemonic(launch, name) };
    } catch (e) {
      return reply.status(404).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // shut down the whole fleet: batched closes through the signing loop
  app.post("/api/fleet/:launchId/shutdown", async (req, reply) => {
    const { launchId } = req.params as { launchId: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    try {
      return await fleet.requestShutdown(launch);
    } catch (e) {
      return reply.status(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // fleet bundle export (§5): age-encrypted with the launch's recipient —
  // the user's stashed identity decrypts it
  app.get("/api/fleet/:launchId/bundle", async (req, reply) => {
    const { launchId } = req.params as { launchId: string };
    const launch = deps.db.getLaunch(launchId);
    if (!launch) return reply.status(404).send({ error: "launch not found" });
    if (denyForeign(req, reply, launch)) return;
    const file = await fleet.exportBundle(launch);
    return reply
      .type("application/octet-stream")
      .header("content-disposition", `attachment; filename="fleet-${launchId.slice(0, 8)}.tar.age"`)
      .send(fs.createReadStream(file));
  });

  // guided tmkms signer setup (M7, §5 step 19): everything the local
  // signer machine needs, per validator
  app.get("/api/launches/:id/tmkms", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    const spec = withDefaults(JSON.parse(launch.spec_json));
    if (spec.security.keyMode !== "tmkms") {
      return reply.status(400).send({ error: "launch is not in tmkms mode" });
    }
    const mesh = deps.db.stepOutput<{ ips: Record<string, string> }>(id, "await-mesh");
    const preauth = deps.db.stepOutput<{ home: string }>(id, "configure-headscale");
    const dirs = launchDirs(deps.workRoot, id);
    return buildTmkmsSetup({
      spec,
      chainId: `${spec.network.name}-${spec.network.chainIdSuffix}`,
      meshIps: mesh?.ips,
      homePreauthKey: preauth?.home,
      nodeDir: dirs.node,
    });
  });

  // bundle import: body is the DECRYPTED tarball (`age -d bundle.tar.age`)
  app.post(
    "/api/fleet/import",
    { bodyLimit: 64 * 1024 * 1024 },
    async (req, reply) => {
      const tmp = fs.mkdtempSync(`${deps.workRoot}/import-`);
      try {
        const tarPath = `${tmp}/bundle.tar.gz`;
        fs.writeFileSync(tarPath, req.body as Buffer);
        const { execFileSync } = await import("node:child_process");
        execFileSync("tar", ["xzf", tarPath, "-C", tmp]);
        const { launchId } = fleet.importBundle(tmp);
        return { launchId };
      } catch (e) {
        return reply.status(400).send({ error: String(e) });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  // --- gentx signing loop (§5 step 3b: external operators, NEW-chain
  //     offline signatures — verified in build-genesis, never broadcast) ---

  app.get("/api/launches/:id/pending-gentx", async (req, reply) => {
    const { id } = req.params as { id: string };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    const pending = deps.db.nextPendingGentx(id);
    if (!pending) return reply.status(204).send();
    return {
      valIndex: pending.val_index,
      address: pending.address,
      signDoc: JSON.parse(pending.sign_doc_json),
    };
  });

  app.post("/api/launches/:id/gentx-result", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { valIndex, response } = req.body as { valIndex: number; response: unknown };
    const launch = deps.db.getLaunch(id);
    if (!launch) return reply.status(404).send({ error: "not found" });
    if (denyForeign(req, reply, launch)) return;
    const pending = deps.db.getPendingGentx(id, valIndex);
    if (!pending || pending.status !== "pending") {
      return reply.status(409).send({ error: "no pending gentx for that validator" });
    }
    deps.db.setGentxSigned(id, valIndex, JSON.stringify(response));
    // build-genesis verifies the signature on resume; a bad one re-pauses
    return { status: drive(id, JSON.parse(launch.spec_json)) };
  });

  return app;
}
