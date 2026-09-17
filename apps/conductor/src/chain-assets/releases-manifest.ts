import fs from "node:fs";
import path from "node:path";

/** The shape sync-releases writes into packages/launch-spec/src/releases.ts. */
interface ManifestRelease {
  version: string;
  commit: string;
  images: { image: string; digest?: string }[];
}

/**
 * image -> digest from a generated releases.ts as it stands on disk.
 *
 * sync-releases rebuilds that manifest from scratch on every run, so a digest
 * it cannot re-resolve is simply absent from the output. Docker Hub throttles
 * anonymous manifest pulls (429) and the resolve loop walks newest-first, so
 * the refusals land on the oldest releases in one contiguous run that reads
 * exactly like tag expiry — while the tags are still there. Carrying the
 * recorded digests forward is what stops a transient 429 from silently
 * un-pinning releases that were pinned before.
 *
 * Returns an empty map when the manifest is missing or unparseable: failing to
 * carry digests forward is a worse outcome than not syncing at all, but it is
 * not worth aborting a sync over, and the caller warns.
 */
export function readManifestDigests(
  manifestPath: string,
  warn: (msg: string) => void = console.warn,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(manifestPath)) return map;

  const src = fs.readFileSync(manifestPath, "utf8");
  // Anchor on the assignment, not the first "[" in the file — the
  // ChainRelease[] type annotations above it would otherwise win and the
  // slice would never parse.
  const marker = src.indexOf("CHAIN_RELEASES");
  const eq = marker === -1 ? -1 : src.indexOf("=", marker);
  const start = eq === -1 ? -1 : src.indexOf("[", eq);
  const end = src.lastIndexOf("]");
  if (start === -1 || end <= start) {
    warn(`warn: no CHAIN_RELEASES array in ${path.basename(manifestPath)}; not carrying digests forward`);
    return map;
  }

  try {
    for (const release of JSON.parse(src.slice(start, end + 1)) as ManifestRelease[]) {
      for (const entry of release.images ?? []) {
        if (entry.digest) map.set(entry.image, entry.digest);
      }
    }
  } catch {
    warn(`warn: could not parse ${path.basename(manifestPath)}; not carrying digests forward`);
    return new Map();
  }
  return map;
}
