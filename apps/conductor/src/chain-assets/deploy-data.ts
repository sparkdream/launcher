import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findChainRelease } from "@sparkdream/launch-spec";
import { run } from "../exec.js";

/**
 * Deploy-data resolution (§13): which chain-repo commit pairs with the
 * spec's image, and the sync-vendor-style extraction of deploy/config into
 * a cache entry's vendor/ dir.
 */

/** Clone source: operator env config, never a spec field (§13). */
export function chainRepoSource(): string {
  return (
    process.env.SPARKDREAM_CHAIN_REPO ??
    path.join(os.homedir(), "cosmos", "sparkdream", "sparkdream")
  );
}

/** "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.26" → "v1.0.26" (null for dev tags). */
export function imageSemver(image: string): string | null {
  const m = /^sparkdreamnft\/sparkdreamd-[a-z]+-ssh:(v\d+\.\d+\.\d+)$/.exec(image);
  return m ? m[1]! : null;
}

export async function lsRemoteTag(source: string, tag: string): Promise<string | null> {
  const { stdout } = await run("git", ["ls-remote", source, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  // annotated tags list both the tag object and the peeled commit (^{}) — take the peeled one
  const lines = stdout.trim().split("\n").filter(Boolean);
  const peeled = lines.find((l) => l.includes("^{}"));
  const line = peeled ?? lines[0];
  return line ? line.split(/\s+/)[0]! : null;
}

export async function lsRemoteHead(source: string): Promise<string | null> {
  const { stdout } = await run("git", ["ls-remote", source, "HEAD"]);
  const line = stdout.trim().split("\n")[0];
  return line ? line.split(/\s+/)[0]! : null;
}

export interface DeployRef {
  commit: string;
  via: "release" | "tag" | "pin";
}

/**
 * §13 resolution ladder: release manifest → matching git tag → spec pin →
 * caller prompts. Throws with prompt guidance when nothing resolves.
 */
export async function resolveDeployRef(
  image: string,
  chainRepoCommit: string | undefined,
): Promise<DeployRef> {
  const known = findChainRelease(image);
  if (known) return { commit: known.release.commit, via: "release" };
  const source = chainRepoSource();
  const version = imageSemver(image);
  if (version) {
    const tagCommit = await lsRemoteTag(source, version).catch(() => null);
    if (tagCommit) return { commit: tagCommit, via: "tag" };
  }
  if (chainRepoCommit) return { commit: chainRepoCommit, via: "pin" };
  throw new Error(
    `no chain-repo ${version ? `tag ${version}` : "tag"} in ${source} and no ` +
      "images.chainRepoCommit pin in the spec — pick the commit to pair with " +
      `${image} in the launch panel (or set images.chainRepoCommit), or seed the ` +
      "cache with: pnpm seed-chain-assets",
  );
}

/** Fetch one commit into a fresh temp clone; returns the checkout dir. */
export async function cloneAtCommit(source: string, commit: string, tmpRoot: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "chain-repo-"));
  await run("git", ["init", "-q", dir]);
  try {
    // shallow single-commit fetch; servers without allowReachableSHA1InWant
    // (and pins that vanished from the repo) fail here with git's error
    await run("git", ["-C", dir, "fetch", "-q", "--depth", "1", source, commit]);
  } catch (cause) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `could not fetch commit ${commit} from ${source} — if this pin no longer ` +
        `exists in the repo, update images.chainRepoCommit\n${(cause as Error).message}`,
    );
  }
  await run("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"]);
  return dir;
}

const NETWORK_FILES = /^(chain\.env|genesis\.json|.*\.sdl\.yaml)$/;
const MESH_FILES = /\.(yaml|yml|sh)$/;

/**
 * The TS twin of scripts/sync-vendor.sh's rsync include list: copy
 * deploy/config/template, the per-network chain.env/genesis.json/SDLs, and
 * deploy/mesh scripts from a chain-repo checkout into destVendor.
 */
export function extractDeployData(repoDir: string, destVendor: string): void {
  const src = path.join(repoDir, "deploy", "config");
  if (!fs.existsSync(path.join(src, "template"))) {
    throw new Error(`${src}/template not found — not a chain repo checkout?`);
  }
  fs.rmSync(destVendor, { recursive: true, force: true });
  fs.cpSync(path.join(src, "template"), path.join(destVendor, "template"), { recursive: true });

  const networkRoot = path.join(src, "network");
  if (fs.existsSync(networkRoot)) {
    for (const network of fs.readdirSync(networkRoot)) {
      const from = path.join(networkRoot, network);
      if (!fs.statSync(from).isDirectory()) continue;
      for (const file of fs.readdirSync(from)) {
        if (!NETWORK_FILES.test(file)) continue;
        const to = path.join(destVendor, "network", network, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(from, file), to);
      }
    }
  }

  const mesh = path.join(repoDir, "deploy", "mesh");
  if (fs.existsSync(mesh)) {
    for (const file of fs.readdirSync(mesh)) {
      if (!MESH_FILES.test(file)) continue;
      const to = path.join(destVendor, "mesh", file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(mesh, file), to);
    }
  }
}
