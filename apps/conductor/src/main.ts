import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { ConductorDb } from "./db.js";
import { buildServer } from "./server.js";
import { allSteps } from "./index.js";
import { productionServices } from "./adapters.js";
import { SshSignerHost, SystemdSignerHost } from "./local-signer.js";
import { AkashUnattendedChain } from "./unattended.js";
import { CloudflareDns, cloudflareToken } from "./dns.js";

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

/**
 * AKASH_RPC        CometBFT RPC the launcher signs unattended-recovery txs
 *                  through (default https://rpc.akashnet.net:443)
 * AKASH_GAS_PRICE  their gas price (default 0.025uact, the web UI's)
 */
services.unattended = new AkashUnattendedChain({
  lcd: process.env.AKASH_LCD ?? "https://rest.cosmos.directory/akash",
  rpc: process.env.AKASH_RPC ?? "https://rpc.akashnet.net:443",
  gasPrice: process.env.AKASH_GAS_PRICE ?? "0.025uact",
});

// a tmkms signer on another machine (ssh_config alias, key auth), e.g. a Pi
services.remoteSigner = (remote) => new SshSignerHost(services.ssh, remote);

// DNS updates after a move, once a Cloudflare token is set (System panel)
services.dns = new CloudflareDns(() => cloudflareToken(dataDir));

/**
 * LOCAL_SIGNER  "off" → never manage a tmkms signer on this machine. On by
 * default for a launcher run directly on Linux (a container has no systemd
 * user manager and no view of host processes, so it is off there anyway).
 */
if (
  process.platform === "linux" &&
  process.env.LOCAL_SIGNER !== "off" &&
  process.env.LAUNCHER_ON_AKASH !== "true" &&
  fs.existsSync(`/run/user/${process.getuid?.() ?? 0}/systemd`)
) {
  services.localSigner = new SystemdSignerHost();
}

/**
 * Additional env (M6):
 *   LAUNCHER_SECRET     encrypt secret files at rest (Akash mode)
 *   OPERATOR_ADDRESSES  comma-separated allowlist → enables wallet-session auth
 *   LAUNCHER_ON_AKASH   "true" → mainnet warning at launch creation
 */
const allowlist = (process.env.OPERATOR_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

const app = buildServer({
  db,
  services,
  workRoot: dataDir,
  steps: allSteps(),
  ...(allowlist.length > 0 ? { auth: { allowlist } } : {}),
  onAkash: process.env.LAUNCHER_ON_AKASH === "true",
});
if (allowlist.length > 0) console.log(`wallet auth enabled for ${allowlist.length} operator(s)`);
if (!process.env.LAUNCHER_SECRET) console.log("LAUNCHER_SECRET not set — secrets stored in plaintext (fine locally)");

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
