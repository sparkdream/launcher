import { describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import type { FleetComponentRow } from "../src/db.js";
import {
  disableNodeCmd,
  meshSocketFromSdl,
  parseMeshNodes,
  pinnedOpKeys,
  planStrays,
  sweepMeshStrays,
  type MeshKey,
  type MeshNode,
} from "../src/mesh-strays.js";

const USER = "sparkdream-dev";

function node(id: number, name: string, ip: string, preAuthKeyId: number, extra: Partial<MeshNode> = {}): MeshNode {
  return { id, name, givenName: name, ip, online: false, user: USER, preAuthKeyId, ...extra };
}
const key = (id: number, k = `hskey-${id}`): MeshKey => ({ id, key: k, expiresAt: 0 });

// the 2026-10-08 devnet mesh, trimmed: live fleet nodes, external machines,
// replaced components' leftovers, and the zombie sentry-1 that halted the
// reset chain
const mesh: MeshNode[] = [
  node(5, "tmkms", "100.64.0.5", 6, { online: true }),
  node(6, "kobot", "100.64.0.6", 8, { online: true }),
  node(2, "val-0", "100.64.0.2", 1),
  node(14, "val-0", "100.64.0.13", 1, { givenName: "val-0-ks8kymdp" }),
  node(22, "val-0", "100.64.0.21", 15, { givenName: "val-0-jr1fjted" }),
  node(18, "sentry-0", "100.64.0.17", 11, { givenName: "sentry-0-vmmmpomb" }),
  node(24, "sentry-0", "100.64.0.23", 18, { givenName: "sentry-0-lycatkqy", online: true }),
  node(23, "sentry-1", "100.64.0.22", 16, { online: true }),
  node(26, "sentry-1", "100.64.0.25", 20, { givenName: "sentry-1-obaavvf8", online: true }),
  node(20, "explorer", "100.64.0.19", 14, { givenName: "explorer-tyjt8m3c" }),
  node(21, "explorer", "100.64.0.20", 14, { givenName: "explorer-njzzvw5l", online: true }),
  node(19, "relayer", "100.64.0.18", 13),
  node(27, "relayer", "100.64.0.26", 21, { givenName: "relayer-jyy5jndf", online: true }),
  // another fleet sharing the server: its own user, never ours to touch
  node(40, "val-0", "100.64.0.40", 30, { user: "sparkdream-test" }),
];
const keys = [1, 6, 8, 11, 13, 14, 15, 16, 18, 20, 21, 30].map((i) => key(i));
const fleetKeys = new Set(["val-0", "sentry-0", "sentry-1", "explorer", "relayer"]);
const live = {
  "val-0": "100.64.0.21",
  "sentry-0": "100.64.0.23",
  "sentry-1": "100.64.0.25",
  explorer: "100.64.0.20",
  relayer: "100.64.0.26",
};

describe("planStrays", () => {
  it("evicts every namesake not at its component's live address, and nothing else", () => {
    const plan = planStrays({ nodes: mesh, keys, user: USER, fleetKeys, live, unreadable: new Set() });
    expect(plan.strays.map((n) => n.id).sort((a, b) => a - b)).toEqual([2, 14, 18, 19, 20, 23]);
    expect(plan.unsure).toEqual([]);
  });

  it("expires only keys no surviving node joined with", () => {
    const plan = planStrays({ nodes: mesh, keys, user: USER, fleetKeys, live, unreadable: new Set() });
    // 14 is shared by a leftover explorer and the live one: kept
    expect(plan.expire.map((k) => k.id).sort((a, b) => a - b)).toEqual([1, 11, 13, 16]);
  });

  it("leaves a component's namesakes alone when its live address is unknown", () => {
    const plan = planStrays({
      nodes: mesh,
      keys,
      user: USER,
      fleetKeys,
      live: { ...live, "sentry-1": undefined as unknown as string },
      unreadable: new Set(["sentry-1"]),
    });
    expect(plan.strays.some((n) => n.name === "sentry-1")).toBe(false);
    expect(plan.unsure).toEqual(["sentry-1"]);
  });

  it("distrusts a live address no node on the mesh holds", () => {
    const plan = planStrays({
      nodes: mesh,
      keys,
      user: USER,
      fleetKeys,
      live: { ...live, relayer: "100.64.0.99" },
      unreadable: new Set(),
    });
    expect(plan.strays.some((n) => n.name === "relayer")).toBe(false);
    expect(plan.unsure).toEqual(["relayer"]);
  });

  it("never expires a key an op in progress pinned", () => {
    const plan = planStrays({
      nodes: mesh,
      keys,
      user: USER,
      fleetKeys,
      live,
      unreadable: new Set(),
      protectedKeys: new Set(["hskey-16"]),
    });
    expect(plan.expire.map((k) => k.id)).not.toContain(16);
  });

  it("skips keys already expired", () => {
    const plan = planStrays({
      nodes: mesh,
      keys: keys.map((k) => (k.id === 13 ? { ...k, expiresAt: 100 } : k)),
      user: USER,
      fleetKeys,
      live,
      unreadable: new Set(),
      now: 1000,
    });
    expect(plan.expire.map((k) => k.id)).not.toContain(13);
  });
});

describe("sweepMeshStrays", () => {
  const base = testnetSpec();
  const spec = { ...base, network: { ...base.network, name: USER } };
  const row = (k: string, ip: string | null): FleetComponentRow =>
    ({ key: k, state: "active", tailnet_ip: ip, ssh_host: "h", ssh_port: 1 }) as unknown as FleetComponentRow;

  it("deletes strays and expires their keys through headscale", async () => {
    const listNodes = JSON.stringify([
      { id: 22, name: "val-0", given_name: "val-0-a", ip_addresses: ["100.64.0.21", "fd7a::15"], online: true, user: { name: USER }, pre_auth_key: { id: 15 } },
      { id: 24, name: "sentry-0", ip_addresses: ["100.64.0.23"], online: true, user: { name: USER }, pre_auth_key: { id: 18 } },
      { id: 23, name: "sentry-0", given_name: "sentry-0-old", ip_addresses: ["100.64.0.22"], online: true, user: { name: USER }, pre_auth_key: { id: 16 } },
      { id: 5, name: "tmkms", ip_addresses: ["100.64.0.5"], online: true, user: { name: USER }, pre_auth_key: { id: 6 } },
    ]);
    const listKeys = JSON.stringify([15, 16, 18, 6].map((id) => ({ id, key: `k${id}`, expiration: { seconds: 0 } })));
    const ran: string[] = [];
    const res = await sweepMeshStrays(spec, [row("val-0", "100.64.0.21"), row("sentry-0", "100.64.0.23")], {
      headscale: async (script) => {
        ran.push(script);
        if (script.startsWith("headscale nodes list")) return listNodes;
        if (script.startsWith("headscale preauthkeys list")) return listKeys;
        return "";
      },
      liveIp: async (r) => r.tailnet_ip,
      log: () => {},
    });
    expect(res.evicted.map((n) => n.givenName)).toEqual(["sentry-0-old"]);
    expect(res.expiredKeys).toEqual([16]);
    expect(ran).toContain("headscale nodes delete --identifier 23 --force");
    expect(ran).toContain("headscale preauthkeys expire --id 16 --force");
    expect(ran.some((s) => s.includes("--identifier 5 "))).toBe(false);
  });

  it("treats an unreadable component as unsure rather than unplaced", async () => {
    const listNodes = JSON.stringify([
      { id: 24, name: "sentry-0", ip_addresses: ["100.64.0.23"], online: true, user: { name: USER }, pre_auth_key: { id: 18 } },
    ]);
    const ran: string[] = [];
    const res = await sweepMeshStrays(spec, [row("sentry-0", "100.64.0.23")], {
      headscale: async (script) => {
        ran.push(script);
        return script.includes("nodes list") ? listNodes : "[]";
      },
      liveIp: async () => {
        throw new Error("ssh timeout");
      },
      log: () => {},
    });
    expect(res.evicted).toEqual([]);
    expect(res.unsure).toEqual(["sentry-0"]);
    expect(ran.some((s) => s.includes("delete"))).toBe(false);
  });
});

describe("helpers", () => {
  it("parses the IPv4 address out of headscale's list", () => {
    const [n] = parseMeshNodes(
      JSON.stringify([{ id: 1, name: "val-0", ip_addresses: ["fd7a::1", "100.64.0.1"], user: { name: USER } }]),
    );
    expect(n.ip).toBe("100.64.0.1");
    expect(n.preAuthKeyId).toBeUndefined();
  });

  it("finds the mesh socket from the SDL", () => {
    expect(meshSocketFromSdl("env:\n  - TS_STATE_DIR=/data/tailscale\n", "/root/.sparkdream")).toBe(
      "/data/tailscale/tailscaled.sock",
    );
    expect(meshSocketFromSdl(undefined, "/root/.sparkdream")).toBe("/root/.sparkdream/tailscale/tailscaled.sock");
  });

  it("collects the pins of active ops", () => {
    const pins: Record<number, string> = { 3: "k3\n" };
    expect([...pinnedOpKeys((id) => pins[id], [3, 4])]).toEqual(["k3"]);
  });

  it("disables by moving, never deleting", () => {
    const cmd = disableNodeCmd("/root/.sparkdream", "/root/.sparkdream/tailscale/tailscaled.sock");
    expect(cmd).toContain("mv /root/.sparkdream/$d");
    expect(cmd).not.toMatch(/\brm\b/);
    expect(cmd).toContain("logout");
  });
});
