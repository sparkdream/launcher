import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readManifestDigests } from "../src/chain-assets/releases-manifest.js";

/**
 * Digest carry-over for sync-releases. The manifest is regenerated from
 * scratch each run, so this reader is the only thing standing between a
 * throttled Docker Hub and a commit that silently un-pins every release the
 * registry declined to answer for.
 */

const realManifest = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/launch-spec/src/releases.ts",
);

function tmpManifest(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relman-"));
  const p = path.join(dir, "releases.ts");
  fs.writeFileSync(p, contents);
  return p;
}

const wrap = (json: string) => `// Generated — do not edit by hand.
export interface ChainReleaseImage {
  image: string;
  digest?: string;
}
export interface ChainRelease {
  version: string;
  commit: string;
  images: ChainReleaseImage[];
}

export const CHAIN_RELEASES: ChainRelease[] = ${json};
`;

describe("readManifestDigests", () => {
  it("reads every pinned digest out of the committed manifest", () => {
    const digests = readManifestDigests(realManifest);
    expect(digests.size).toBeGreaterThan(50);
    for (const [image, digest] of digests) {
      // The trailing letter is real: hotfix releases like v1.0.1e ship a tag
      // that is not plain semver, and the manifest records them as shipped.
      expect(image).toMatch(/^sparkdreamnft\/sparkdreamd-(devnet|testnet|mainnet)-ssh:v\d+\.\d+\.\d+[a-z]?$/);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("anchors on the assignment, not the first bracket in the file", () => {
    // ChainRelease[] appears above the array; a naive indexOf("[") slices
    // from there and never parses.
    const p = tmpManifest(
      wrap(JSON.stringify([
        { version: "v1.0.1", commit: "abc", images: [{ image: "img:v1.0.1", digest: "sha256:aa" }] },
      ])),
    );
    expect(readManifestDigests(p).get("img:v1.0.1")).toBe("sha256:aa");
  });

  it("skips images that carry no digest", () => {
    const p = tmpManifest(
      wrap(JSON.stringify([
        {
          version: "v1.0.1",
          commit: "abc",
          images: [{ image: "pinned:v1", digest: "sha256:aa" }, { image: "unpinned:v1" }],
        },
      ])),
    );
    const digests = readManifestDigests(p);
    expect(digests.get("pinned:v1")).toBe("sha256:aa");
    expect(digests.has("unpinned:v1")).toBe(false);
  });

  it("returns empty and warns rather than throwing on an unparseable manifest", () => {
    const warnings: string[] = [];
    const p = tmpManifest(wrap("[ { not json"));
    expect(readManifestDigests(p, (m) => warnings.push(m)).size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it("returns empty and warns when the array is absent entirely", () => {
    const warnings: string[] = [];
    const p = tmpManifest("export const NOTHING = 1;\n");
    expect(readManifestDigests(p, (m) => warnings.push(m)).size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it("returns empty without warning when there is no manifest yet", () => {
    const warnings: string[] = [];
    const missing = path.join(os.tmpdir(), "relman-does-not-exist", "releases.ts");
    expect(readManifestDigests(missing, (m) => warnings.push(m)).size).toBe(0);
    expect(warnings).toHaveLength(0);
  });
});
