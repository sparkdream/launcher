import { describe, expect, it } from "vitest";
import type { RelayerPathSpec, SisterFleet } from "../lib/api";
import {
  describeChanges,
  endpointProblems,
  pathStatus,
  sisterPaths,
  suggestPathId,
  validPathId,
} from "../lib/relayer-settings";

const sister = (over: Partial<SisterFleet> = {}): SisterFleet => ({
  launchId: "fleet-test",
  name: "sparkdream-test",
  displayName: "SparkdreamTest",
  chainId: "sparkdream-test-1",
  networkType: "testnet",
  route: "public",
  eligible: true,
  founderHeld: true,
  ...over,
});

const osmo: RelayerPathSpec = {
  id: "osmosis",
  kind: "transfer",
  counterparty: {
    chainId: "osmo-test-5",
    rpc: "https://rpc.osmotest5.osmosis.zone",
    grpc: "https://grpc.osmotest5.osmosis.zone:443",
    bech32Prefix: "osmo",
    gasDenom: "uosmo",
    gasPrice: 0.05,
  },
};

const ctx = {
  chainId: "sparkdream-dev-1",
  founderHeld: true,
  sisters: [sister()],
  presets: [{ counterparty: { chainId: "osmosis-1" }, paid: true, symbol: "OSMO" }],
};

describe("relayer settings helpers", () => {
  it("names paths within the spec's pattern, unique among those taken", () => {
    expect(suggestPathId("Osmosis testnet", [])).toBe("osmosis-testnet");
    expect(suggestPathId("osmosis", ["osmosis", "osmosis-2"])).toBe("osmosis-3");
    expect(suggestPathId("--", [])).toBe("path");
    expect(validPathId(suggestPathId("A very long chain name that keeps going and going", []))).toBe(true);
    expect(validPathId("Bad Name")).toBe(false);
  });

  it("builds a federation path to a sister fleet with its companion transfer path", () => {
    const paths = sisterPaths(sister(), { federation: true, alsoTransfer: true, taken: ["sparkdream-test"] });
    expect(paths).toEqual([
      { id: "sparkdream-test-2", kind: "federation", counterparty: { fleet: "fleet-test" } },
      { id: "sparkdream-test-transfer", kind: "transfer", counterparty: { fleet: "fleet-test" } },
    ]);
    expect(sisterPaths(sister(), { federation: false, alsoTransfer: true, taken: [] })).toEqual([
      { id: "sparkdream-test", kind: "transfer", counterparty: { fleet: "fleet-test" } },
    ]);
  });

  it("lists what an endpoint chain still needs", () => {
    expect(endpointProblems(osmo.counterparty as never)).toEqual([]);
    expect(endpointProblems({ rpc: "not a url", gasPrice: 0 })).toEqual([
      "chain id",
      "RPC URL",
      "gRPC URL",
      "address prefix",
      "gas denom",
      "gas price",
    ]);
  });

  it("says what applying does: federation peers, who signs, the public route, funding", () => {
    const fed = sisterPaths(sister(), { federation: true, alsoTransfer: true, taken: [] });
    const lines = describeChanges([osmo], [osmo, ...fed], ctx).map((l) => `${l.tone}: ${l.text}`);
    expect(lines).toContain("add: Opens a federation channel to sparkdream-test-1 (SparkdreamTest)");
    expect(lines).toContain("add: Opens a transfer channel to sparkdream-test-1 (SparkdreamTest)");
    expect(lines.some((l) => /committee proposal on sparkdream-dev-1 \(your founder vote\)/.test(l))).toBe(true);
    // the public route (and the relaunch it may need) is announced once,
    // though two paths use it
    expect(lines.filter((l) => /relaunch it/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /Relay fees between sister chains come back/.test(l))).toBe(true);
  });

  it("does not announce a public route the stored spec already uses", () => {
    const before: RelayerPathSpec[] = [
      { id: "sparkdream-test", kind: "transfer", counterparty: { fleet: "fleet-test", via: "public" } },
    ];
    const after = [...before, ...sisterPaths(sister(), { federation: true, alsoTransfer: false, taken: ["sparkdream-test"] })];
    const text = describeChanges(before, after, ctx).map((l) => l.text).join("\n");
    expect(text).not.toMatch(/relaunch it/);
  });

  it("flags drops, a paid chain waiting for funds, and a cap change", () => {
    const mainnet: RelayerPathSpec = {
      id: "osmosis-mainnet",
      kind: "transfer",
      counterparty: { ...(osmo.counterparty as object), chainId: "osmosis-1" } as never,
      openWhenFunded: true,
    };
    const lines = describeChanges([osmo], [mainnet], {
      ...ctx,
      cap: { before: "100000000", after: "50000000", symbol: "SPARK", decimals: 6 },
    }).map((l) => `${l.tone}: ${l.text}`);
    expect(lines).toContain("add: Opens a transfer channel to osmosis-1");
    expect(lines.some((l) => /Stays unopened until the relayer's key on osmosis-1 holds OSMO/.test(l))).toBe(true);
    expect(lines).toContain("drop: Stops relaying osmosis; its channels stay open on chain");
    expect(lines).toContain("change: Spark Dream key cap: 100 SPARK → 50 SPARK");
    expect(describeChanges([osmo], [osmo], ctx)).toEqual([]);
  });

  it("reports a path's channel pair and federation peers from the last link", () => {
    const fed: RelayerPathSpec = { id: "fed", kind: "federation", counterparty: { fleet: "fleet-test" } };
    const state = {
      chains: [],
      linkedAt: "",
      channels: [
        { id: "fed", port: "federation", version: "federation-1", a: { chain: "a", channel: "channel-2" }, b: { chain: "b", channel: "channel-5" } },
      ],
      peers: [
        { chainId: "a", peerId: "b", status: "PEER_STATUS_ACTIVE", ibcChannelId: "channel-2" },
        { chainId: "b", peerId: "a", status: "PEER_STATUS_PENDING", ibcChannelId: "channel-5" },
      ],
    };
    expect(pathStatus(fed, state)).toBe("channel-2 ↔ channel-5 · peers active / pending");
    expect(pathStatus(osmo, { ...state, waiting: [{ chainId: "osmo-test-5", paths: ["osmosis"], address: "", denom: "", amount: "" }] })).toBe(
      "waiting for funds",
    );
    expect(pathStatus(osmo, null)).toBe("not linked yet");
  });
});
