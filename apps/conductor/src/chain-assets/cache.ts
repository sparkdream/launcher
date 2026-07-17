import fs from "node:fs";
import path from "node:path";

/**
 * On-disk cache of per-version chain assets (§13), keyed by the full image
 * tag: <workRoot>/chain-assets/<sanitized-tag>/{sparkdreamd, vendor/, meta.json}.
 * Entries are self-describing (meta.json) and always safe to evict — step 0
 * re-fetches, so pruning can only cost a re-download.
 */

export interface AssetMeta {
  /** Full image reference the entry was resolved for. */
  image: string;
  /** Registry manifest digest the binary came from (audit; tags are mutable). */
  manifestDigest?: string;
  /** Chain-repo commit the deploy data came from. */
  commit?: string;
  /** True when seeded from a dirty working tree (dev flow). */
  dirty?: boolean;
  /** How the deploy data was resolved: manifest, git tag, spec pin, or seeder. */
  via: "release" | "tag" | "pin" | "seed";
  createdAt: string;
  lastUsedAt: string;
}

export function assetCacheRoot(workRoot: string): string {
  return path.join(workRoot, "chain-assets");
}

/** Image tag → filesystem-safe directory name ("ns/repo:tag" → "ns_repo_tag"). */
export function entryDirName(image: string): string {
  return image.replace(/[^A-Za-z0-9._-]/g, "_");
}

export interface CacheEntry {
  dir: string;
  bin: string;
  vendorDir: string;
  metaPath: string;
}

export function cacheEntry(workRoot: string, image: string): CacheEntry {
  const dir = path.join(assetCacheRoot(workRoot), entryDirName(image));
  return {
    dir,
    bin: path.join(dir, "sparkdreamd"),
    vendorDir: path.join(dir, "vendor"),
    metaPath: path.join(dir, "meta.json"),
  };
}

export function readMeta(entry: CacheEntry): AssetMeta | null {
  try {
    return JSON.parse(fs.readFileSync(entry.metaPath, "utf8")) as AssetMeta;
  } catch {
    return null;
  }
}

export function writeMeta(entry: CacheEntry, meta: AssetMeta): void {
  fs.mkdirSync(entry.dir, { recursive: true });
  const tmp = `${entry.metaPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, entry.metaPath);
}

/** A usable entry has the binary, the vendored templates, and its meta. */
export function entryComplete(entry: CacheEntry): boolean {
  return (
    fs.existsSync(entry.bin) &&
    fs.existsSync(path.join(entry.vendorDir, "template")) &&
    readMeta(entry) !== null
  );
}

export function touchEntry(entry: CacheEntry): void {
  const meta = readMeta(entry);
  if (meta) writeMeta(entry, { ...meta, lastUsedAt: new Date().toISOString() });
}

export interface CacheListing {
  image: string;
  meta: AssetMeta;
  complete: boolean;
}

export function listCache(workRoot: string): CacheListing[] {
  const root = assetCacheRoot(workRoot);
  if (!fs.existsSync(root)) return [];
  const out: CacheListing[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const entry: CacheEntry = {
      dir,
      bin: path.join(dir, "sparkdreamd"),
      vendorDir: path.join(dir, "vendor"),
      metaPath: path.join(dir, "meta.json"),
    };
    const meta = readMeta(entry);
    if (meta) out.push({ image: meta.image, meta, complete: entryComplete(entry) });
  }
  return out;
}

/**
 * Keep the `keep` most recently USED entries (recency of use, not version
 * order — §13) plus everything in `protectedImages` (images referenced by
 * launches in a non-terminal state). Incomplete entries are always evicted.
 */
export function pruneCache(workRoot: string, keep: number, protectedImages: Set<string>): string[] {
  const listings = listCache(workRoot).sort((a, b) =>
    b.meta.lastUsedAt.localeCompare(a.meta.lastUsedAt),
  );
  const evicted: string[] = [];
  let kept = 0;
  for (const l of listings) {
    if (protectedImages.has(l.image)) continue;
    if (l.complete && kept < keep) {
      kept++;
      continue;
    }
    fs.rmSync(path.join(assetCacheRoot(workRoot), entryDirName(l.image)), {
      recursive: true,
      force: true,
    });
    evicted.push(l.image);
  }
  return evicted;
}
