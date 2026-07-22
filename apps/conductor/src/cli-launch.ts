import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { unknownKeyIssues, validateSpec, withDefaults } from "@sparkdream/launch-spec";
import { ConductorDb } from "./db.js";
import { runWithSigner } from "./engine.js";
import { allSteps } from "./index.js";
import { productionServices } from "./adapters.js";
import { CliSigner } from "./signer.js";
import { resolveSharedHeadscale } from "./headscale-reuse.js";

/**
 * M2 headless launch driver (§11): run a full launch from a spec file with
 * a CLI signer — no UI, devnet/testnet only. Mainnet goes through Keplr.
 *
 *   SIGNER_MNEMONIC=... node dist/cli-launch.js launch.yaml
 *
 * Env: SIGNER_MNEMONIC (required), AKASH_RPC (tx broadcast), AKASH_LCD,
 * CONSOLE_API, GAS_PRICE (default 0.025uact), BECH32_PREFIX (default akash),
 * DATA_DIR (default ./data), LAUNCH_ID (resume an existing launch).
 */
async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("usage: cli-launch <launch.yaml>");
    process.exit(2);
  }
  const mnemonic = process.env.SIGNER_MNEMONIC;
  if (!mnemonic) {
    console.error("SIGNER_MNEMONIC is required (CLI signing is for devnet/testnet)");
    process.exit(2);
  }

  const rawSpec = yaml.load(fs.readFileSync(specPath, "utf8"));
  // unknown keys are stripped by the schema parse; surface them before that
  for (const w of unknownKeyIssues(rawSpec)) console.warn(`warning: ${w.path}: ${w.message}`);
  const spec = withDefaults(rawSpec);
  const validation = validateSpec(spec);
  for (const w of validation.warnings) console.warn(`warning: ${w.path}: ${w.message}`);
  if (!validation.ok) {
    for (const e of validation.errors) console.error(`error: ${e.path}: ${e.message}`);
    process.exit(1);
  }

  const signer = new CliSigner({
    mnemonic,
    rpcEndpoint: process.env.AKASH_RPC ?? "https://rpc.cosmos.directory/akash",
    gasPrice: process.env.GAS_PRICE ?? "0.025uact",
    ...(process.env.BECH32_PREFIX ? { bech32Prefix: process.env.BECH32_PREFIX } : {}),
  });
  const owner = await signer.ownerAddress();
  console.log(`signing as ${owner}`);

  const dataDir = process.env.DATA_DIR ?? path.resolve("data");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new ConductorDb(path.join(dataDir, "state.db"));
  const services = productionServices({
    lcd: process.env.AKASH_LCD ?? "https://rest.cosmos.directory/akash",
    consoleApi: process.env.CONSOLE_API ?? "https://console-api.akash.network",
  });

  // shared mesh: resolve reuseFleet against this instance's fleets so the
  // stored spec carries the owning launch id + domain (same as the server)
  if (spec.topology.headscale.reuseFleet) {
    const shared = resolveSharedHeadscale(db, spec, owner)!;
    spec.topology.headscale.reuseFleet = shared.launchId;
    spec.topology.headscale.domain = shared.domain;
    console.log(`sharing fleet "${shared.name}" mesh at https://${shared.domain}`);
  }

  let launchId = process.env.LAUNCH_ID;
  if (!launchId) {
    launchId = randomUUID();
    db.createLaunch(launchId, JSON.stringify(spec), owner);
    console.log(`launch ${launchId} created (set LAUNCH_ID=${launchId} to resume)`);
  }

  const result = await runWithSigner(
    db,
    launchId,
    spec,
    dataDir,
    allSteps(),
    services,
    signer,
    (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  );
  console.log(`launch ${launchId}: ${result.status}${result.failedStep ? ` at ${result.failedStep}` : ""}`);
  if (result.reason) console.log(result.reason);
  db.close();
  process.exit(result.status === "completed" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
