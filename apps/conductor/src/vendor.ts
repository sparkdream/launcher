import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Locate vendor/sparkdream-deploy: env override first (tests, Docker),
 * then walk up from this file to the repo root.
 */
export function vendorDir(): string {
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
