import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VENDORED_CHAIN_VERSION } from "@sparkdream/launch-spec";

/**
 * Point each network's genesis binary at .chain-bins/<vendored version>/
 * (pnpm build-chain-bins) unless the environment already names one: since
 * v1.0.56 a network's reference genesis validates only under that network's
 * build. Runs in every test worker (setupFiles); globalSetup below warns once
 * when they are missing.
 */
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.chain-bins", VENDORED_CHAIN_VERSION);
const NETWORKS = ["devnet", "testnet", "mainnet"] as const;

for (const network of NETWORKS) {
  const name = `SPARKDREAMD_BIN_${network.toUpperCase()}`;
  const bin = path.join(dir, `sparkdreamd-${network}`);
  if (!process.env[name] && fs.existsSync(bin)) process.env[name] = bin;
}

export default function warnWhenMissing() {
  const missing = NETWORKS.filter(
    (n) => !process.env[`SPARKDREAMD_BIN_${n.toUpperCase()}`] && !fs.existsSync(path.join(dir, `sparkdreamd-${n}`)),
  );
  if (missing.length > 0) {
    console.warn(
      `\nno ${missing.join("/")} sparkdreamd ${VENDORED_CHAIN_VERSION} for the tests: launches of those networks ` +
        "will stop at genesis. Run `pnpm build-chain-bins` (or set SPARKDREAMD_BIN_<NETWORK>).\n",
    );
  }
}
