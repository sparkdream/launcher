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
  return launcherVendorDir();
}

/** The launcher's own vendor data (env override, else the baked copy),
 *  whatever chain version the running launch pins. */
export function launcherVendorDir(): string {
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

/**
 * A relayer script (chain repo deploy/docker/hermes) as last synced into the
 * launcher, or undefined when this vendor copy predates them. Taken from the
 * launcher's copy, not the launch's pinned chain version: the scripts drive
 * Hermes, not the chain, and the newest copy carries the newest fixes.
 */
export function relayerScriptPath(name: string): string | undefined {
  try {
    const file = path.join(launcherVendorDir(), "hermes", name);
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
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
