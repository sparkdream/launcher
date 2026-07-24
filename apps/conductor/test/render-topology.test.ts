import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodes, resolveTopology, testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { renderNodeConfigs } from "../src/render-configs.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-topo-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Render every node's config.toml and reconstruct the p2p graph CometBFT
 * would actually dial: sentry→validator entries point at the local socat
 * tunnel (127.0.0.1:16656+v), everything else at a tailnet placeholder.
 * This is the regression guard for the round-robin partition bug — fake
 * services can't see a disconnected gossip graph, but the rendered peer
 * strings can.
 */
function renderedPeerGraph(spec: LaunchSpec): Map<string, Set<string>> {
  const work = tmp();
  const topology = resolveTopology(spec);
  const nodeIds = Object.fromEntries(nodes(spec).map((n) => [n.key, `id-${n.key}`]));
  const idToKey = Object.fromEntries(nodes(spec).map((n) => [`id-${n.key}`, n.key]));
  const edges = new Map<string, Set<string>>(nodes(spec).map((n) => [n.key, new Set()]));
  for (const node of nodes(spec)) {
    const home = path.join(work, node.key);
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    renderNodeConfigs({
      spec,
      node,
      home,
      nodeIds,
      topology,
      tailnetIpPlaceholder: (key) => `{{TAILNET_IP:${key}}}`,
    });
    const config = fs.readFileSync(path.join(home, "config", "config.toml"), "utf8");
    const line = config.match(/^persistent_peers = "(.*)"$/m)?.[1] ?? "";
    for (const entry of line.split(",").filter(Boolean)) {
      const peerKey = idToKey[entry.split("@")[0]!];
      if (!peerKey) continue; // join-bundle peers are outside the fleet
      edges.get(node.key)!.add(peerKey);
      edges.get(peerKey)!.add(node.key); // TCP links gossip both ways
    }
  }
  return edges;
}

function isConnected(edges: Map<string, Set<string>>): boolean {
  const keys = [...edges.keys()];
  if (keys.length === 0) return true;
  const reached = new Set([keys[0]!]);
  const queue = [keys[0]!];
  while (queue.length > 0) {
    for (const next of edges.get(queue.shift()!)!) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached.size === keys.length;
}

describe("rendered p2p topology", () => {
  it("round-robin 2x2 renders one connected gossip graph", () => {
    const edges = renderedPeerGraph(testnetSpec());
    expect(isConnected(edges)).toBe(true);
    // validators stay behind sentries: no direct val↔val edge
    expect(edges.get("val-0")!.has("val-1")).toBe(false);
    // the sentry mesh is the bridge
    expect(edges.get("sentry-0")!.has("sentry-1")).toBe(true);
  });

  it("disjoint explicit mapping [[0],[1]] still renders connected", () => {
    const spec = testnetSpec({
      topology: { sentries: { count: 2, mapping: [[0], [1]] } },
    });
    expect(isConnected(renderedPeerGraph(spec))).toBe(true);
  });

  it("3 validators x 3 sentries round-robin renders connected", () => {
    const spec = testnetSpec({
      topology: { validators: { count: 3 }, sentries: { count: 3 } },
    });
    expect(isConnected(renderedPeerGraph(spec))).toBe(true);
  });

  it("many sentries fronting one validator all reach it", () => {
    const spec = testnetSpec({
      topology: { validators: { count: 1 }, sentries: { count: 3 } },
    });
    const edges = renderedPeerGraph(spec);
    expect(isConnected(edges)).toBe(true);
    for (const s of ["sentry-0", "sentry-1", "sentry-2"]) {
      expect(edges.get(s)!.has("val-0")).toBe(true);
    }
  });
});
