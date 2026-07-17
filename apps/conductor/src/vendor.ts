import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { currentAssets } from "./chain-assets/context.js";

/**
 * Locate the vendor deploy data: the running launch's assets context first
 * (per-launch version, §13), then the env override (tests, Docker), then
 * walk up from this file to the repo root (the baked vendor/).
 */
export function vendorDir(): string {
  const fromLaunch = currentAssets()?.vendorDir;
  if (fromLaunch) return fromLaunch;
  const fromEnv = process.env.SPARKDREAM_VENDOR_DIR;
  if (fromEnv) return fromEnv;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "vendor", "sparkdream-deploy");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("vendor/sparkdream-deploy not found — run scripts/sync-vendor.sh");
}

export function templatePath(name: string): string {
  return path.join(vendorDir(), "template", name);
}

export function networkSdlPath(networkType: string, role: "validator" | "sentry"): string {
  return path.join(vendorDir(), "network", networkType, `${role}.sdl.yaml`);
}

/** Reference genesis for the network type (chain repo deploy/config/network). */
export function referenceGenesisPath(networkType: string): string {
  return path.join(vendorDir(), "network", networkType, "genesis.json");
}
