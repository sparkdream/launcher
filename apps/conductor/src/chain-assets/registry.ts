import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

/**
 * Extract a single file from a Docker Hub image without a Docker daemon
 * (§13 step 0): token → manifest (index resolved to linux/amd64) → scan
 * layers topmost-first for the path. The extracted binary is bit-identical
 * to what the fleet nodes boot — the whole point of registry extraction
 * over building from source.
 */

const REGISTRY = "https://registry-1.docker.io";
const AUTH = "https://auth.docker.io";

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

export interface ImageRef {
  /** e.g. "sparkdreamnft/sparkdreamd-testnet-ssh" */
  repository: string;
  /** e.g. "v1.0.26" */
  tag: string;
}

export function parseImageRef(image: string): ImageRef {
  const m = /^([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9._-]+)$/.exec(image);
  if (!m) throw new Error(`unsupported image reference: ${image}`);
  let repository = m[1]!;
  // Docker Hub library images ("node:22") — not expected here, but normalize
  if (!repository.includes("/")) repository = `library/${repository}`;
  return { repository, tag: m[2]! };
}

async function hubToken(repository: string): Promise<string> {
  const url = `${AUTH}/token?service=registry.docker.io&scope=repository:${repository}:pull`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry auth failed (${res.status}) for ${repository}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`registry auth returned no token for ${repository}`);
  return body.token;
}

interface ManifestLayer {
  digest: string;
  mediaType: string;
}

interface ResolvedManifest {
  /** Digest of the tag's top-level manifest (list or single) — the audit pin. */
  digest: string;
  layers: ManifestLayer[];
}

async function fetchJson(url: string, token: string): Promise<{ digest: string; body: any }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
  });
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status}): ${url}`);
  return { digest: res.headers.get("docker-content-digest") ?? "", body: await res.json() };
}

/** Resolve a tag to its manifest digest and linux/amd64 layer list. */
export async function resolveManifest(ref: ImageRef, token?: string): Promise<ResolvedManifest> {
  const t = token ?? (await hubToken(ref.repository));
  const top = await fetchJson(`${REGISTRY}/v2/${ref.repository}/manifests/${ref.tag}`, t);
  let manifest = top.body;
  if (Array.isArray(manifest.manifests)) {
    // index / manifest list — pick linux/amd64 (ignoring attestation entries)
    const entry = manifest.manifests.find(
      (m: any) =>
        m.platform?.os === "linux" &&
        m.platform?.architecture === "amd64" &&
        m.annotations?.["vnd.docker.reference.type"] === undefined,
    );
    if (!entry) throw new Error(`no linux/amd64 manifest for ${ref.repository}:${ref.tag}`);
    manifest = (await fetchJson(`${REGISTRY}/v2/${ref.repository}/manifests/${entry.digest}`, t))
      .body;
  }
  if (!Array.isArray(manifest.layers)) {
    throw new Error(`unexpected manifest shape for ${ref.repository}:${ref.tag}`);
  }
  return {
    digest: top.digest,
    layers: manifest.layers.map((l: any) => ({ digest: l.digest, mediaType: l.mediaType })),
  };
}

/**
 * Scan one gzipped layer for `filePath` (exact path, no leading slash);
 * returns true and writes to `dest` when found.
 */
async function extractFromLayer(
  ref: ImageRef,
  token: string,
  layer: ManifestLayer,
  filePath: string,
  dest: string,
): Promise<boolean> {
  const res = await fetch(`${REGISTRY}/v2/${ref.repository}/blobs/${layer.digest}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.body) throw new Error(`blob fetch failed (${res.status}): ${layer.digest}`);

  const extract = tar.extract();
  let found = false;

  const scan = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const name = header.name.replace(/^\.\//, "");
      if (!found && name === filePath && header.type === "file") {
        found = true;
        const out = fs.createWriteStream(dest, { mode: 0o755 });
        stream.pipe(out);
        out.on("finish", () => {
          // stop pulling the rest of the layer
          extract.destroy();
          resolve();
        });
        out.on("error", reject);
      } else {
        stream.resume();
        stream.on("end", next);
      }
    });
    extract.on("finish", () => resolve());
    extract.on("error", (e) => (found ? resolve() : reject(e)));
  });

  try {
    await Promise.all([
      pipeline(Readable.fromWeb(res.body as any), zlib.createGunzip(), extract).catch((e) => {
        // destroying the extract stream after a hit aborts the pipeline — fine
        if (!found) throw e;
      }),
      scan,
    ]);
  } finally {
    if (!found) fs.rmSync(dest, { force: true });
  }
  return found;
}

/**
 * Extract `filePath` (e.g. "usr/local/bin/sparkdreamd") from an image into
 * `dest`. Returns the manifest digest for the audit record. Downloads to
 * `dest.partial` and renames — never leaves a truncated file at `dest`.
 */
export async function extractFileFromImage(
  image: string,
  filePath: string,
  dest: string,
): Promise<{ manifestDigest: string }> {
  const ref = parseImageRef(image);
  const token = await hubToken(ref.repository);
  const manifest = await resolveManifest(ref, token);
  const partial = `${dest}.partial`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // topmost layer wins in an overlay filesystem — scan back to front
  for (const layer of [...manifest.layers].reverse()) {
    if (await extractFromLayer(ref, token, layer, filePath, partial)) {
      fs.renameSync(partial, dest);
      return { manifestDigest: manifest.digest };
    }
  }
  throw new Error(`${filePath} not found in any layer of ${image}`);
}
