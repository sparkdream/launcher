/**
 * seed-chain-assets (§13): build a complete chain-asset cache entry for an
 * image without a running launcher — the offline/pre-seeding path, and the
 * dev path for dirty working trees.
 *
 *   pnpm seed-chain-assets <image> [options]
 *
 * Options:
 *   --chain-repo <path|url>  deploy-data source (default: SPARKDREAM_CHAIN_REPO
 *                            or ~/cosmos/sparkdream/sparkdream). A local path
 *                            with no --ref seeds from the working tree AS-IS
 *                            (dirty allowed — the dev flow).
 *   --ref <commit|tag>       clone the repo at this ref instead of the
 *                            working tree / auto-resolved tag
 *   --binary <path>          use a local sparkdreamd binary instead of
 *                            registry extraction (airgapped)
 *   --data-dir <dir>         launcher data dir (default: DATA_DIR or ./data)
 *   --out <dir>              write a portable chain-assets/ tree here instead
 *                            of into the data dir (copy onto the target
 *                            launcher's volume)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../exec.js";
import { assetCacheRoot, entryDirName, writeMeta, type AssetMeta, type CacheEntry } from "./cache.js";
import { extractFileFromImage } from "./registry.js";
import {
  chainRepoSource,
  cloneAtCommit,
  extractDeployData,
  imageSemver,
  lsRemoteTag,
} from "./deploy-data.js";
import { BINARY_PATH_IN_IMAGE } from "./index.js";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) fail(`${a} needs a value`);
      flags[a.slice(2)] = value;
    } else positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const image = positional[0] ?? fail("usage: seed-chain-assets <image> [--chain-repo ...] [--ref ...] [--binary ...] [--out ...]");

const dataDir = flags["data-dir"] ?? process.env.DATA_DIR ?? path.resolve("data");
const root = flags.out ?? assetCacheRoot(dataDir);
const dir = path.join(root, entryDirName(image));
const entry: CacheEntry = {
  dir,
  bin: path.join(dir, "sparkdreamd"),
  vendorDir: path.join(dir, "vendor"),
  metaPath: path.join(dir, "meta.json"),
};
fs.mkdirSync(entry.dir, { recursive: true });

const source = flags["chain-repo"] ?? chainRepoSource();
const isLocalRepo = fs.existsSync(path.join(source, ".git"));

// --- binary ---
let manifestDigest: string | undefined;
if (flags.binary) {
  fs.copyFileSync(flags.binary, entry.bin);
  fs.chmodSync(entry.bin, 0o755);
  console.log(`binary: copied ${flags.binary}`);
} else {
  console.log(`binary: extracting from ${image} (registry)...`);
  manifestDigest = (await extractFileFromImage(image, BINARY_PATH_IN_IMAGE, entry.bin))
    .manifestDigest;
  console.log(`binary: done (${manifestDigest})`);
}

// --- deploy data ---
let commit = "unknown";
let dirty = false;
if (flags.ref) {
  const ref = /^[0-9a-f]{7,40}$/.test(flags.ref)
    ? flags.ref
    : ((await lsRemoteTag(source, flags.ref)) ?? fail(`ref ${flags.ref} not found in ${source}`));
  const checkout = await cloneAtCommit(source, ref, os.tmpdir());
  try {
    extractDeployData(checkout, entry.vendorDir);
    commit = (await run("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
  console.log(`deploy data: ${source} at ${commit.slice(0, 12)}`);
} else if (isLocalRepo) {
  // dev flow: the working tree as-is, dirty state recorded for the audit trail
  extractDeployData(source, entry.vendorDir);
  commit = (await run("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  dirty = (await run("git", ["-C", source, "status", "--porcelain"])).stdout.trim().length > 0;
  console.log(`deploy data: working tree ${source} (${commit.slice(0, 12)}${dirty ? ", dirty" : ""})`);
} else {
  const version = imageSemver(image);
  const tagCommit = version ? await lsRemoteTag(source, version) : null;
  if (!tagCommit) {
    fail(`no ${version ?? "matching"} tag in ${source} — pass --ref <commit|tag> or a local --chain-repo`);
  }
  const checkout = await cloneAtCommit(source, tagCommit, os.tmpdir());
  try {
    extractDeployData(checkout, entry.vendorDir);
    commit = tagCommit;
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
  console.log(`deploy data: ${source} at tag ${version} (${commit.slice(0, 12)})`);
}

const now = new Date().toISOString();
const meta: AssetMeta = {
  image,
  ...(manifestDigest ? { manifestDigest } : {}),
  commit,
  ...(dirty ? { dirty } : {}),
  via: "seed",
  createdAt: now,
  lastUsedAt: now,
};
writeMeta(entry, meta);
console.log(`seeded ${entry.dir}`);
if (flags.out) {
  console.log(`copy onto the launcher with: cp -r ${root}/. <DATA_DIR>/chain-assets/`);
}
