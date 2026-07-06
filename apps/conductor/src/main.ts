import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { ConductorDb } from "./db.js";
import { buildServer } from "./server.js";
import { allSteps } from "./index.js";
import { productionServices } from "./adapters.js";

/**
 * Conductor entrypoint. Env:
 *   DATA_DIR       state + launch workspaces (default ./data)
 *   PORT           HTTP port (default 8080)
 *   AKASH_LCD      chain REST endpoint
 *   CONSOLE_API    Console public API for provider metadata
 */
const dataDir = process.env.DATA_DIR ?? path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new ConductorDb(path.join(dataDir, "state.db"));
const services = productionServices({
  lcd: process.env.AKASH_LCD ?? "https://rest.cosmos.directory/akash",
  consoleApi: process.env.CONSOLE_API ?? "https://console-api.akash.network",
});

const app = buildServer({ db, services, workRoot: dataDir, steps: allSteps() });

// Serve the statically-exported web UI when present (single-container mode,
// §2). In dev, run `npm run dev` instead — next dev proxies /api here.
const webDist =
  process.env.WEB_DIST ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/out");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  app.register(fastifyStatic, { root: webDist });
  console.log(`serving web UI from ${webDist}`);
}

const port = Number(process.env.PORT ?? 8080);

app.listen({ port, host: "0.0.0.0" }).then((address) => {
  console.log(`conductor listening on ${address}`);
});
