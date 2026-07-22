import { describe, expect, it } from "vitest";
import { parseNetcheck, parseSignerPeers, relayLatencyMs } from "../src/tmkms.js";

// `tailscale status --json` on the validator: the tmkms box relays through
// the fleet's embedded DERP (region code "sparkdream"), other peers are not
// signer machines and must be ignored.
const STATUS_JSON = JSON.stringify({
  Self: { HostName: "val-0" },
  Peer: {
    "nodekey:aaa": {
      HostName: "sentry-0",
      DNSName: "sentry-0.sparkdream.mesh.",
      TailscaleIPs: ["100.64.0.3"],
      Online: true,
      Active: true,
      Relay: "sparkdream",
      TxBytes: 100,
      RxBytes: 200,
    },
    "nodekey:bbb": {
      HostName: "tmkms-sparkdream-test",
      DNSName: "tmkms-sparkdream-test.sparkdream.mesh.",
      TailscaleIPs: ["100.64.0.5", "fd7a:115c:a1e0::5"],
      Online: true,
      Active: true,
      Relay: "sparkdream",
      CurAddr: "",
      TxBytes: 9348420,
      RxBytes: 9341244,
      LastHandshake: "2026-07-22T16:38:00Z",
    },
    "nodekey:ccc": {
      HostName: "operators-laptop",
      DNSName: "operators-laptop.sparkdream.mesh.",
      TailscaleIPs: ["100.64.0.9"],
      Online: false,
      Active: false,
      CurAddr: "203.0.113.9:41641",
      TxBytes: 5,
      RxBytes: 6,
    },
  },
});

// `tailscale netcheck` text on the tmkms box (real 2026-07-22 output, trimmed).
const NETCHECK_TEXT = `
Report:
        * Time: 2026-07-22T16:38:49.197500466Z
        * UDP: false
        * IPv4: (no addr found)
        * IPv6: no, but OS has support
        * MappingVariesByDestIP:
        * PortMapping: UPnP, NAT-PMP, PCP
        * CaptivePortal: false
        * Nearest DERP: SparkDream DERP
        * DERP latency:
                - sparkdream: 71.9ms  (SparkDream DERP)
`;

describe("parseSignerPeers", () => {
  it("finds the tmkms peer with its relay session, ignores fleet nodes", () => {
    const peers = parseSignerPeers(STATUS_JSON, "sparkdream-test");
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      name: "tmkms-sparkdream-test",
      ip: "100.64.0.5",
      online: true,
      active: true,
      relay: "sparkdream",
      txBytes: 9348420,
      rxBytes: 9341244,
      lastHandshake: "2026-07-22T16:38:00Z",
    });
  });

  it("matches on DNSName when HostName is missing, and sorts the exact network match first", () => {
    const doc = {
      Peer: {
        "nodekey:x1": { DNSName: "tmkms-other.sparkdream.mesh.", Online: true, TxBytes: 1 },
        "nodekey:x2": { DNSName: "tmkms-sparkdream-test.sparkdream.mesh.", Online: true, TxBytes: 2 },
      },
    };
    const peers = parseSignerPeers(JSON.stringify(doc), "sparkdream-test");
    expect(peers.map((p) => p.name)).toEqual(["tmkms-sparkdream-test", "tmkms-other"]);
  });

  it("returns [] on empty or unparseable output (probe failed)", () => {
    expect(parseSignerPeers("", "sparkdream-test")).toEqual([]);
    expect(parseSignerPeers("not json", "sparkdream-test")).toEqual([]);
    expect(parseSignerPeers("{}", "sparkdream-test")).toEqual([]);
  });

  it("treats a peer without Relay as direct (relay null)", () => {
    const doc = { Peer: { k: { HostName: "tmkms-sparkdream-test", CurAddr: "1.2.3.4:41641" } } };
    expect(parseSignerPeers(JSON.stringify(doc), "sparkdream-test")[0]?.relay).toBeNull();
  });
});

describe("parseNetcheck", () => {
  it("parses nearest DERP and per-region latency", () => {
    const info = parseNetcheck(NETCHECK_TEXT);
    expect(info.nearest).toBe("SparkDream DERP");
    expect(info.regions).toEqual([{ code: "sparkdream", name: "SparkDream DERP", ms: 71.9 }]);
  });

  it("parses multiple regions and nameless entries", () => {
    const text = `
        * Nearest DERP: fra
        * DERP latency:
                - fra: 12.3ms  (Frankfurt)
                - sparkdream: 71.9ms  (SparkDream DERP)
                - xyz: 200.1ms
`;
    const info = parseNetcheck(text);
    expect(info.regions).toEqual([
      { code: "fra", name: "Frankfurt", ms: 12.3 },
      { code: "sparkdream", name: "SparkDream DERP", ms: 71.9 },
      { code: "xyz", name: null, ms: 200.1 },
    ]);
  });

  it("returns no regions on failure output", () => {
    expect(parseNetcheck("").regions).toEqual([]);
    expect(parseNetcheck("netcheck failed").regions).toEqual([]);
  });
});

describe("relayLatencyMs", () => {
  const info = parseNetcheck(NETCHECK_TEXT);
  it("resolves the session's relay region", () => {
    expect(relayLatencyMs(info, "sparkdream")).toBe(71.9);
    expect(relayLatencyMs(info, "SparkDream DERP")).toBe(71.9);
  });
  it("falls back to the first region when the session is direct or unknown", () => {
    expect(relayLatencyMs(info, null)).toBe(71.9);
    expect(relayLatencyMs(info, "no-such-region")).toBe(71.9);
  });
  it("is null without a measurement", () => {
    expect(relayLatencyMs(null, "sparkdream")).toBeNull();
    expect(relayLatencyMs({ nearest: null, regions: [] }, null)).toBeNull();
  });
});
