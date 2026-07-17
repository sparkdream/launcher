import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { testnetSpec, VENDORED_CHAIN_VERSION } from "@sparkdream/launch-spec";
import { run } from "../src/exec.js";
import {
  cacheEntry,
  entryComplete,
  listCache,
  pruneCache,
  writeMeta,
  type AssetMeta,
} from "../src/chain-assets/cache.js";
import {
  cloneAtCommit,
  extractDeployData,
  imageSemver,
  lsRemoteHead,
  lsRemoteTag,
  resolveDeployRef,
} from "../src/chain-assets/deploy-data.js";
import {
  bakedModeError,
  bakedSatisfies,
  chainAssetMode,
  chainAssetModeLocked,
  resolveChainAssets,
  setChainAssetMode,
} from "../src/chain-assets/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-assets-test-"));
const fixtureRepo = path.join(tmp, "chain-repo");

const savedEnv = { ...process.env };
afterEach(() => {
  process.env.SPARKDREAM_CHAIN_REPO = savedEnv.SPARKDREAM_CHAIN_REPO;
  process.env.CHAIN_ASSET_MODE = savedEnv.CHAIN_ASSET_MODE;
  if (savedEnv.SPARKDREAM_CHAIN_REPO === undefined) delete process.env.SPARKDREAM_CHAIN_REPO;
  if (savedEnv.CHAIN_ASSET_MODE === undefined) delete process.env.CHAIN_ASSET_MODE;
});

/** A minimal chain-repo lookalike: deploy/config + mesh, one tag. */
beforeAll(async () => {
  const cfg = path.join(fixtureRepo, "deploy", "config");
  fs.mkdirSync(path.join(cfg, "template"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "template", "config.toml.validator"), "moniker = 'x'\n");
  fs.mkdirSync(path.join(cfg, "network", "testnet"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "network", "testnet", "chain.env"), "CHAIN_ID=t\n");
  fs.writeFileSync(path.join(cfg, "network", "testnet", "genesis.json"), "{}\n");
  fs.writeFileSync(path.join(cfg, "network", "testnet", "validator.sdl.yaml"), "version: '2.0'\n");
  fs.writeFileSync(path.join(cfg, "network", "testnet", "NOT_VENDORED.txt"), "no\n");
  fs.mkdirSync(path.join(fixtureRepo, "deploy", "mesh"), { recursive: true });
  fs.writeFileSync(path.join(fixtureRepo, "deploy", "mesh", "up.sh"), "#!/bin/sh\n");
  const git = (...args: string[]) =>
    run("git", ["-C", fixtureRepo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  await run("git", ["init", "-q", fixtureRepo]);
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");
  await git("tag", "v9.9.9");
});

describe("imageSemver", () => {
  it("parses release tags and rejects dev tags", () => {
    expect(imageSemver("sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.26")).toBe("v1.0.26");
    expect(imageSemver("sparkdreamnft/sparkdreamd-devnet-ssh:dev-abc123")).toBeNull();
    expect(imageSemver("somewhere/else:v1.0.26")).toBeNull();
  });
});

describe("deploy-data extraction", () => {
  it("copies exactly the sync-vendor include list", () => {
    const dest = path.join(tmp, "vendor-out");
    extractDeployData(fixtureRepo, dest);
    expect(fs.existsSync(path.join(dest, "template", "config.toml.validator"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "network", "testnet", "chain.env"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "network", "testnet", "genesis.json"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "network", "testnet", "validator.sdl.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "mesh", "up.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "network", "testnet", "NOT_VENDORED.txt"))).toBe(false);
  });
});

describe("ref resolution ladder (§13)", () => {
  it("resolves a manifest release before consulting git at all", async () => {
    process.env.SPARKDREAM_CHAIN_REPO = "/nonexistent"; // manifest must win without git
    const ref = await resolveDeployRef("sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24", undefined);
    expect(ref.via).toBe("release");
    expect(ref.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("resolves a matching git tag automatically", async () => {
    process.env.SPARKDREAM_CHAIN_REPO = fixtureRepo;
    const ref = await resolveDeployRef("sparkdreamnft/sparkdreamd-testnet-ssh:v9.9.9", undefined);
    expect(ref.via).toBe("tag");
    expect(ref.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ref.commit).toBe(await lsRemoteTag(fixtureRepo, "v9.9.9"));
  });

  it("falls back to the spec pin when no tag matches", async () => {
    process.env.SPARKDREAM_CHAIN_REPO = fixtureRepo;
    const head = (await lsRemoteHead(fixtureRepo))!;
    const ref = await resolveDeployRef("sparkdreamnft/sparkdreamd-testnet-ssh:v8.8.8", head);
    expect(ref).toEqual({ commit: head, via: "pin" });
  });

  it("names both remediations when neither tag nor pin resolves", async () => {
    process.env.SPARKDREAM_CHAIN_REPO = fixtureRepo;
    await expect(
      resolveDeployRef("sparkdreamnft/sparkdreamd-testnet-ssh:v8.8.8", undefined),
    ).rejects.toThrow(/chainRepoCommit.*seed-chain-assets|seed-chain-assets/s);
  });

  it("clones a single commit and fails clearly on a vanished pin", async () => {
    const head = (await lsRemoteHead(fixtureRepo))!;
    const checkout = await cloneAtCommit(fixtureRepo, head, tmp);
    expect(fs.existsSync(path.join(checkout, "deploy", "config", "template"))).toBe(true);
    fs.rmSync(checkout, { recursive: true, force: true });
    await expect(
      cloneAtCommit(fixtureRepo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", tmp),
    ).rejects.toThrow(/images\.chainRepoCommit/);
  });
});

function fakeEntry(workRoot: string, image: string, lastUsedAt: string): void {
  const entry = cacheEntry(workRoot, image);
  fs.mkdirSync(path.join(entry.vendorDir, "template"), { recursive: true });
  fs.writeFileSync(entry.bin, "#!/bin/sh\n");
  const meta: AssetMeta = {
    image,
    commit: "abc",
    via: "seed",
    createdAt: lastUsedAt,
    lastUsedAt,
  };
  writeMeta(entry, meta);
}

describe("cache pruning (§13)", () => {
  it("keeps the most recently used + protected entries, drops the rest", () => {
    const root = fs.mkdtempSync(path.join(tmp, "prune-"));
    fakeEntry(root, "ns/img:v1", "2026-01-01T00:00:00Z"); // oldest, protected
    fakeEntry(root, "ns/img:v2", "2026-01-02T00:00:00Z"); // evicted
    fakeEntry(root, "ns/img:v3", "2026-01-03T00:00:00Z"); // kept (MRU)
    fakeEntry(root, "ns/img:v4", "2026-01-04T00:00:00Z"); // kept (MRU)
    const evicted = pruneCache(root, 2, new Set(["ns/img:v1"]));
    expect(evicted).toEqual(["ns/img:v2"]);
    const left = listCache(root)
      .map((l) => l.image)
      .sort();
    expect(left).toEqual(["ns/img:v1", "ns/img:v3", "ns/img:v4"]);
  });

  it("always evicts incomplete entries", () => {
    const root = fs.mkdtempSync(path.join(tmp, "prune-"));
    fakeEntry(root, "ns/img:good", "2026-01-01T00:00:00Z");
    fakeEntry(root, "ns/img:bad", "2026-01-02T00:00:00Z");
    fs.rmSync(cacheEntry(root, "ns/img:bad").bin); // binary missing → incomplete
    const evicted = pruneCache(root, 5, new Set());
    expect(evicted).toEqual(["ns/img:bad"]);
  });
});

describe("asset resolution", () => {
  const spec = (image: string) => {
    const s = testnetSpec();
    s.images.sparkdreamd = image;
    return s;
  };

  it("baked build satisfies the vendored version", () => {
    const image = `sparkdreamnft/sparkdreamd-testnet-ssh:${VENDORED_CHAIN_VERSION}`;
    expect(bakedSatisfies(image)).toBe(true);
    const assets = resolveChainAssets(spec(image), tmp);
    expect(assets?.source).toBe("baked");
  });

  it("falls back to a complete cache entry and touches its recency", () => {
    const root = fs.mkdtempSync(path.join(tmp, "resolve-"));
    const image = "sparkdreamnft/sparkdreamd-testnet-ssh:v9.9.9";
    fakeEntry(root, image, "2026-01-01T00:00:00Z");
    const assets = resolveChainAssets(spec(image), root);
    expect(assets?.source).toBe("cache");
    expect(assets?.bin).toBe(cacheEntry(root, image).bin);
    const meta = listCache(root)[0]!.meta;
    expect(meta.lastUsedAt > "2026-01-01T00:00:00Z").toBe(true);
  });

  it("returns null for an unknown version (step 0 must fetch or fail)", () => {
    const root = fs.mkdtempSync(path.join(tmp, "resolve-"));
    expect(resolveChainAssets(spec("sparkdreamnft/sparkdreamd-testnet-ssh:v8.8.8"), root)).toBeNull();
  });

  it("offline error for an UNKNOWN version escalates with the known list", () => {
    const message = bakedModeError("ns/img:v0").message;
    expect(message).toContain("unknown to this launcher build");
    expect(message).toContain("sync-releases");
    expect(message).toContain("seed-chain-assets");
    expect(message).toContain("CHAIN_ASSET_MODE=fetch");
  });

  it("offline error for a KNOWN release points at seed/rebuild/online", () => {
    // v1.0.24 is in the generated release manifest but not baked
    const message = bakedModeError("sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24").message;
    expect(message).toContain("known release");
    expect(message).toContain("seed-chain-assets");
    expect(message).toContain("Building for a specific chain version");
    expect(message).toContain("CHAIN_ASSET_MODE=fetch");
  });

  it("mode env defaults to baked and rejects junk", () => {
    delete process.env.CHAIN_ASSET_MODE;
    expect(chainAssetMode()).toBe("baked");
    process.env.CHAIN_ASSET_MODE = "fetch";
    expect(chainAssetMode()).toBe("fetch");
    process.env.CHAIN_ASSET_MODE = "auto";
    expect(() => chainAssetMode()).toThrow(/CHAIN_ASSET_MODE/);
  });

  it("UI toggle persists via settings; the env is authoritative and locks it", () => {
    delete process.env.CHAIN_ASSET_MODE;
    const store = new Map<string, string>();
    const db = {
      getSetting: (k: string) => store.get(k) ?? null,
      setSetting: (k: string, v: string) => void store.set(k, v),
    };
    expect(chainAssetMode(db)).toBe("baked");
    expect(chainAssetModeLocked()).toBe(false);
    expect(setChainAssetMode(db, "fetch")).toBe("fetch");
    expect(chainAssetMode(db)).toBe("fetch");
    expect(() => setChainAssetMode(db, "sideways")).toThrow(/mode/);
    process.env.CHAIN_ASSET_MODE = "baked";
    expect(chainAssetMode(db)).toBe("baked"); // env wins over the setting
    expect(chainAssetModeLocked()).toBe(true);
    expect(() => setChainAssetMode(db, "fetch")).toThrow(/locked/);
  });
});
