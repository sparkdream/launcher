import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { nodes } from "@sparkdream/launch-spec";
import type { StepCtx } from "../engine.js";

/**
 * Join mode (§5 "Join mode"): fetch-genesis and state-sync trust resolution.
 * The launch deploys a sovereign sentry/validator set onto an EXISTING
 * chain — genesis is downloaded and verified instead of built, and sentries
 * boot with [statesync] wired from the join block's RPCs.
 */

/** Recursively sort object keys so serialization differences wash out. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The same genesis exists in two serializations: the SDK's genesis.json
 * file (app_name/app_version metadata, `consensus.params`, `app_hash:
 * null`, numeric initial_height) and CometBFT's RPC GenesisDoc
 * (`consensus_params`, `app_hash: ""`, string initial_height, no app
 * metadata). Project both onto the CometBFT shape so either serialization
 * of one genesis hashes identically.
 */
function normalizeGenesis(genesis: Record<string, unknown>): Record<string, unknown> {
  const { app_name, app_version, consensus, ...doc } = genesis as Record<string, any>;
  void app_name;
  void app_version;
  if (consensus?.params !== undefined && doc.consensus_params === undefined) {
    doc.consensus_params = consensus.params;
  } else if (consensus !== undefined) {
    doc.consensus = consensus; // unrecognized shape: hash it rather than drop it
  }
  doc.app_hash = doc.app_hash ?? "";
  if (doc.initial_height !== undefined) doc.initial_height = String(doc.initial_height);
  return doc;
}

/**
 * sha256 over the canonical (normalized, key-sorted) JSON of a genesis
 * document. A raw SDK genesis.json, the same document served by a CometBFT
 * RPC's /genesis (which re-serializes it), and an RPC-wrapped copy all hash
 * identically, so the spec's pin verifies regardless of how the document
 * was served. This is what the join bundle publishes and what
 * fetch-genesis checks — distinct from build-genesis's file-byte sha256.
 */
export function canonicalGenesisSha256(genesis: unknown): string {
  const normalized = normalizeGenesis(genesis as Record<string, unknown>);
  return createHash("sha256").update(JSON.stringify(sortKeys(normalized))).digest("hex");
}

/**
 * A genesis document may arrive raw, or wrapped by a CometBFT RPC:
 * {"result": {"genesis": {...}}} (JSONRPC) or {"genesis": {...}}.
 * `wasRaw` reports which shape arrived, so callers that must preserve the
 * document's exact bytes know the body IS the document.
 */
export function unwrapGenesis(body: string): {
  genesis: Record<string, unknown>;
  wasRaw: boolean;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("genesis download is not JSON");
  }
  const genesis = parsed?.result?.genesis ?? parsed?.genesis ?? parsed;
  if (parsed?.error) {
    // CometBFT refuses /genesis for large documents ("use genesis_chunked");
    // hosting the raw file (S3, gist, the origin conductor) side-steps it
    throw new Error(
      `genesis endpoint returned an error: ${JSON.stringify(parsed.error)}; ` +
        "host the raw genesis.json instead (the origin's download genesis button produces it)",
    );
  }
  if (!genesis || typeof genesis !== "object" || typeof genesis.chain_id !== "string") {
    throw new Error("downloaded document does not look like a genesis (no chain_id)");
  }
  return { genesis, wasRaw: genesis === parsed };
}

/**
 * The join-mode branch of the build-genesis step: download, verify, and
 * distribute the EXISTING chain's genesis. Returns the same output shape as
 * buildGenesisFiles so downstream consumers (fleet summary, join bundle)
 * read it identically.
 */
export async function fetchJoinGenesis(
  ctx: StepCtx,
): Promise<{ chainId: string; genesisSha256: string; gentxCount: number }> {
  const join = ctx.spec.join!;
  ctx.log(`fetching genesis from ${join.genesisUrl}`);
  const body = await ctx.services.rpc.getText(join.genesisUrl);
  const { genesis, wasRaw } = unwrapGenesis(body);

  const sha = canonicalGenesisSha256(genesis);
  if (join.genesisSha256 && sha !== join.genesisSha256) {
    throw new Error(
      `genesis integrity check failed: canonical sha256 ${sha} does not match the ` +
        `spec's pin ${join.genesisSha256}; do not start nodes on this document`,
    );
  }
  if (!join.genesisSha256) ctx.log(`genesis sha256 (unpinned): ${sha}`);

  if (genesis.chain_id !== join.chainId) {
    throw new Error(
      `genesis chain_id "${genesis.chain_id}" does not match join.chainId "${join.chainId}"`,
    );
  }
  const bondDenom =
    (genesis as any).app_state?.staking?.params?.bond_denom ?? undefined;
  const specBond = ctx.spec.token.bondDenom ?? ctx.spec.token.baseDenom;
  if (bondDenom && bondDenom !== specBond) {
    throw new Error(
      `the chain's bond denom is ${bondDenom} but the spec's token block says ${specBond}; ` +
        "copy the token values from the join bundle",
    );
  }

  // distribute to every node home (raw body when it IS the document, so
  // bytes stay faithful; the unwrapped re-serialization otherwise)
  const content = wasRaw ? body : JSON.stringify(genesis, null, 2);
  for (const node of nodes(ctx.spec)) {
    const dir = path.join(ctx.dirs.node(node.key), "config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "genesis.json"), content);
  }

  return { chainId: join.chainId, genesisSha256: sha, gentxCount: 0 };
}

export interface StateSyncTrust {
  rpcServers: string[];
  trustHeight: number;
  trustHash: string;
}

/** JSONRPC block response → block hash, tolerant of the /result wrapper. */
function blockHash(body: string): string {
  const parsed: any = JSON.parse(body);
  const hash = parsed?.result?.block_id?.hash ?? parsed?.block_id?.hash;
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("block response carries no block_id.hash");
  }
  return hash;
}

/**
 * Resolve the state-sync light-client trust anchor at render time: latest
 * height minus an offset (inside the snapshot retention window), with the
 * hash cross-checked against a second RPC so one lying endpoint cannot
 * point the sync at a forged chain (§5 "Trust model").
 */
export async function resolveStateSyncTrust(ctx: StepCtx): Promise<StateSyncTrust> {
  // distinct endpoints only: cross-checking the same RPC against itself
  // verifies nothing (validate-spec rejects duplicates up front; this guard
  // covers specs that predate that check)
  const rpcs = [...new Set(ctx.spec.join!.stateSyncRpcs.map((r) => r.replace(/\/+$/, "")))];
  if (rpcs.length < 2) {
    throw new Error(
      "state-sync trust needs two DISTINCT RPC endpoints and the spec's join.stateSyncRpcs " +
        "deduplicate to one; add a second RPC served by a different node",
    );
  }

  // any live RPC can supply the height; the hash below is what gets cross-checked
  let latestHeight: number | undefined;
  const statusProblems: string[] = [];
  for (const rpc of rpcs) {
    try {
      latestHeight = (await ctx.services.rpc.status(rpc)).latestBlockHeight;
      break;
    } catch (e) {
      statusProblems.push(`${rpc}: ${String(e).slice(0, 120)}`);
    }
  }
  if (latestHeight === undefined) {
    throw new Error(`no state-sync RPC answered /status: ${statusProblems.join("; ")}`);
  }
  const trustHeight = Math.max(1, latestHeight - 1000);

  const hashes: string[] = [];
  const problems: string[] = [];
  for (const rpc of rpcs) {
    if (hashes.length >= 2) break;
    try {
      hashes.push(blockHash(await ctx.services.rpc.getText(`${rpc}/block?height=${trustHeight}`)));
    } catch (e) {
      problems.push(`${rpc}: ${String(e).slice(0, 120)}`);
    }
  }
  if (hashes.length < 2) {
    throw new Error(
      `could not fetch the trust hash at height ${trustHeight} from two RPCs ` +
        `(cross-check requires two): ${problems.join("; ")}`,
    );
  }
  if (hashes[0] !== hashes[1]) {
    throw new Error(
      `trust hash mismatch at height ${trustHeight}: ${rpcs[0]} says ${hashes[0]}, ` +
        `another RPC says ${hashes[1]}; one of the join RPCs is lying or forked, do not sync`,
    );
  }
  return { rpcServers: rpcs, trustHeight, trustHash: hashes[0]! };
}
