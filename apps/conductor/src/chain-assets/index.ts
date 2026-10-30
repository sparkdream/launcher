import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import {
  findChainRelease,
  knownChainVersions,
  VENDORED_CHAIN_VERSION,
} from "@sparkdream/launch-spec";
import { vendorDir } from "../vendor.js";
import { cacheEntry, entryComplete, touchEntry, writeMeta, type AssetMeta } from "./cache.js";
import { extractFileFromImage } from "./registry.js";
import {
  chainRepoSource,
  cloneAtCommit,
  extractDeployData,
  imageSemver,
  resolveDeployRef,
} from "./deploy-data.js";

export { listCache, pruneCache, cacheEntry, entryComplete, writeMeta } from "./cache.js";
export type { AssetMeta, CacheListing } from "./cache.js";
export { chainRepoSource, imageSemver, lsRemoteHead, lsRemoteTag } from "./deploy-data.js";
export { extractFileFromImage } from "./registry.js";

export { runWithAssets, currentAssets, type ChainAssets } from "./context.js";
import type { ChainAssets } from "./context.js";

export type ChainAssetMode = "baked" | "fetch";

const MODE_SETTING_KEY = "chain_asset_mode";

interface SettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

function parseMode(raw: string, source: string): ChainAssetMode {
  if (raw !== "baked" && raw !== "fetch") {
    throw new Error(`${source} must be "baked" or "fetch", got "${raw}"`);
  }
  return raw;
}

/**
 * §13 mode: the CHAIN_ASSET_MODE env is authoritative when set (the
 * operator lock — an airgapped launcher's offline guarantee must not be one
 * browser click away); otherwise the UI-set persisted setting; otherwise
 * baked (offline).
 */
export function chainAssetMode(db?: SettingsStore): ChainAssetMode {
  const env = process.env.CHAIN_ASSET_MODE;
  if (env) return parseMode(env, "CHAIN_ASSET_MODE");
  const stored = db?.getSetting(MODE_SETTING_KEY);
  if (stored) return parseMode(stored, `setting ${MODE_SETTING_KEY}`);
  return "baked";
}

/** True when the env pins the mode — the UI toggle renders locked. */
export function chainAssetModeLocked(): boolean {
  return Boolean(process.env.CHAIN_ASSET_MODE);
}

/** UI toggle write path (POST /api/chain-assets/mode). Throws when locked. */
export function setChainAssetMode(db: SettingsStore, mode: string): ChainAssetMode {
  if (chainAssetModeLocked()) {
    throw new Error("chain-asset mode is locked by the CHAIN_ASSET_MODE environment variable");
  }
  const parsed = parseMode(mode, "mode");
  db.setSetting(MODE_SETTING_KEY, parsed);
  return parsed;
}

/** The network a chain image is built for, from its name (sparkdreamd-<network>-ssh). */
export function imageNetwork(image: string): string | undefined {
  return /sparkdreamd-(devnet|testnet|mainnet)\b/.exec(image)?.[1];
}

/**
 * The baked binary for a network: SPARKDREAMD_BIN (an override for every
 * network: tests, local dev), else SPARKDREAMD_BIN_<NETWORK>, else PATH.
 */
function bakedBin(network?: string): string {
  return process.env.SPARKDREAMD_BIN || (network && process.env[`SPARKDREAMD_BIN_${network.toUpperCase()}`]) || "sparkdreamd";
}

const builds = new Map<string, string[] | null>();

/**
 * The build tags a binary reports (`version --long`), or null when it does
 * not say (a stand-in script, or a build without the tag stamped in).
 */
function binaryBuild(bin: string): string[] | null {
  let cached = builds.get(bin);
  if (cached === undefined) {
    try {
      const out = execFileSync(bin, ["version", "--long"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      const tags = /^build_tags:[ \t]*(\S*)/m.exec(out)?.[1];
      cached = tags ? tags.split(",") : null;
    } catch {
      cached = null;
    }
    builds.set(bin, cached);
  }
  return cached;
}

/**
 * True when the baked launcher build serves this image: the same version
 * and, for a network image, that network's build. Since v1.0.56 the chain's
 * parameter floors are build-tagged, so one network's binary refuses another
 * network's reference genesis (the testnet build rejects the devnet's 12h
 * attestation_ttl; the test build rejects every network's). A binary that
 * does not report its build is taken on its version alone.
 */
export function bakedSatisfies(image: string): boolean {
  if (imageSemver(image) !== VENDORED_CHAIN_VERSION) return false;
  const network = imageNetwork(image);
  if (!network) return true;
  const build = binaryBuild(bakedBin(network));
  return !build || build.includes(network);
}

/**
 * Resolve the assets for a spec WITHOUT fetching: baked build first, then a
 * complete cache entry (touching its recency). Null → step 0 must fetch (or
 * fail with remediation in baked mode).
 */
export function resolveChainAssets(spec: LaunchSpec, workRoot: string): ChainAssets | null {
  const image = spec.images.sparkdreamd;
  if (bakedSatisfies(image)) {
    return { bin: bakedBin(imageNetwork(image)), vendorDir: vendorDir(), source: "baked" };
  }
  const entry = cacheEntry(workRoot, image);
  if (entryComplete(entry)) {
    touchEntry(entry);
    return { bin: entry.bin, vendorDir: entry.vendorDir, source: "cache" };
  }
  return null;
}

export const BINARY_PATH_IN_IMAGE = "usr/local/bin/sparkdreamd";

/**
 * Fetch-mode materialization: registry-extract the binary and clone+extract
 * the deploy data into the cache entry for this image. Idempotent per part —
 * a resume after a partial failure only fetches what's missing.
 */
export async function fetchChainAssets(
  spec: LaunchSpec,
  workRoot: string,
  log: (m: string) => void,
): Promise<ChainAssets> {
  const image = spec.images.sparkdreamd;
  const entry = cacheEntry(workRoot, image);
  fs.mkdirSync(entry.dir, { recursive: true });

  const ref = await resolveDeployRef(image, spec.images.chainRepoCommit);

  let manifestDigest: string | undefined;
  if (!fs.existsSync(entry.bin)) {
    log(`fetching sparkdreamd from ${image} (registry extraction)`);
    manifestDigest = (await extractFileFromImage(image, BINARY_PATH_IN_IMAGE, entry.bin))
      .manifestDigest;
    // §13 digest pinning: the release manifest recorded this image's digest
    // at sync time — a mismatch means the tag MOVED since. Hard error, and
    // don't keep the unverified binary.
    const pinned = findChainRelease(image)?.digest;
    if (pinned && manifestDigest && pinned !== manifestDigest) {
      fs.rmSync(entry.bin, { force: true });
      throw new Error(
        `${image}: registry digest ${manifestDigest} does not match the release ` +
          `manifest's ${pinned} — the image tag has moved since the manifest was ` +
          "synced. Re-run pnpm sync-releases if the re-push is expected, and " +
          "treat an unexpected mismatch as a supply-chain red flag.",
      );
    }
  }

  if (!fs.existsSync(`${entry.vendorDir}/template`)) {
    const source = chainRepoSource();
    log(`fetching deploy data from ${source} at ${ref.commit.slice(0, 12)} (via ${ref.via})`);
    const checkout = await cloneAtCommit(source, ref.commit, os.tmpdir());
    try {
      extractDeployData(checkout, entry.vendorDir);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  }

  const now = new Date().toISOString();
  const meta: AssetMeta = {
    image,
    ...(manifestDigest ? { manifestDigest } : {}),
    commit: ref.commit,
    via: ref.via,
    createdAt: now,
    lastUsedAt: now,
  };
  writeMeta(entry, meta);
  return { bin: entry.bin, vendorDir: entry.vendorDir, source: "cache" };
}

/**
 * §13 offline-mode failure messages. Two distinct cases, both escalations
 * to the user, both naming every escape hatch:
 * - a KNOWN release that just isn't local (seed, rebuild, or go online);
 * - an UNKNOWN version — a typo, or a release newer than this launcher
 *   build's manifest (sync-releases + rebuild, seed, pin, or go online).
 */
export function bakedModeError(image: string): Error {
  const network = imageNetwork(image);
  if (network && imageSemver(image) === VENDORED_CHAIN_VERSION) {
    const bin = bakedBin(network);
    const build = binaryBuild(bin)?.join(",") ?? "another";
    return new Error(
      `${image} needs the ${network} build of sparkdreamd ${VENDORED_CHAIN_VERSION}, and the ` +
        `launcher's binary for it (${bin}) is the ${build} build, whose parameter floors ` +
        `refuse the ${network} genesis. Point SPARKDREAMD_BIN_${network.toUpperCase()} at a ` +
        `${network} build (chain repo: go build -tags ${network}), seed the cache ` +
        "(pnpm seed-chain-assets), or switch to online mode (CHAIN_ASSET_MODE=fetch), which " +
        "takes the binary from the image.",
    );
  }
  const known = findChainRelease(image);
  if (known) {
    return new Error(
      `${image} is a known release (${known.release.version}) but is not available ` +
        `offline: this build bakes ${VENDORED_CHAIN_VERSION} and the asset cache has ` +
        "no entry for it. Seed the cache (pnpm seed-chain-assets), rebuild the " +
        'launcher for that version (README: "Building for a specific chain ' +
        'version"), or switch to online mode (CHAIN_ASSET_MODE=fetch).',
    );
  }
  const versions = knownChainVersions();
  const sample = versions.slice(0, 5).join(", ") + (versions.length > 5 ? ", …" : "");
  return new Error(
    `${image} is unknown to this launcher build — a typo, or a release newer than ` +
      `its manifest (known: ${sample}). Re-sync the manifest and rebuild ` +
      "(pnpm sync-releases), seed the cache (pnpm seed-chain-assets), or switch " +
      "to online mode (CHAIN_ASSET_MODE=fetch).",
  );
}
