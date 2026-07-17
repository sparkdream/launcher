import { CHAIN_RELEASES, type ChainRelease } from "./releases.js";

/**
 * Manifest lookups (§13): the generated release list answers "is this a
 * known chain release?" with zero network. A miss means UNKNOWN (typo, or a
 * release newer than this launcher build) — callers escalate, never treat
 * it as invalid.
 */

/** Exact image match against any release's published images. */
export function findChainRelease(
  image: string,
): { release: ChainRelease; digest?: string } | null {
  for (const release of CHAIN_RELEASES) {
    const entry = release.images.find((i) => i.image === image);
    if (entry) {
      return { release, ...(entry.digest ? { digest: entry.digest } : {}) };
    }
  }
  return null;
}

/** Known versions, newest first — for error messages and the UI list. */
export function knownChainVersions(): string[] {
  return CHAIN_RELEASES.map((r) => r.version);
}
