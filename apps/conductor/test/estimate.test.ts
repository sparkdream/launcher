import { describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import { estimateLaunchCost, sizeToBytes } from "../src/estimate.js";

const componentsOn = {
  validators: { count: 2 },
  sentries: { count: 2 },
  components: {
    explorer: { enabled: true, domain: "explorer.sparkdream.io" },
    frontend: { enabled: true, domain: "app.sparkdream.io" },
    hub: { enabled: false },
  },
  publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
  headscale: { domain: "headscale.sparkdream.io" },
};

describe("launch cost estimate", () => {
  it("prices every deployment from the stock bid-script rates as a low–high range", () => {
    const est = estimateLaunchCost(testnetSpec({ topology: componentsOn }));
    // stock rates: $1.60/thread, $0.80/GB mem, $0.02/GB ephemeral,
    // beta3 $0.04/GB persistent; low = 0.5× (observed competitive bids).
    expect(est.perRole).toEqual([
      // 1cpu + 8Gi + 5Gi eph + 50Gi beta3 = 1.6 + 6.4 + 0.1 + 2.0
      { role: "validators", count: 2, unitLowUsd: 5.05, unitHighUsd: 10.1 },
      // 2cpu + 8Gi + 5Gi eph + 8Gi beta3 = 3.2 + 6.4 + 0.1 + 0.32
      { role: "sentries", count: 2, unitLowUsd: 5.01, unitHighUsd: 10.02 },
      // vendored SDL: 0.5cpu + 512Mi + 512Mi eph + 2×512Mi beta3
      { role: "headscale", count: 1, unitLowUsd: 0.63, unitHighUsd: 1.25 },
      // 0.5cpu + 512Mi + 512Mi eph + 1Gi beta3
      { role: "explorer", count: 1, unitLowUsd: 0.63, unitHighUsd: 1.25 },
      // 0.5cpu + 512Mi + 1Gi eph
      { role: "frontend", count: 1, unitLowUsd: 0.61, unitHighUsd: 1.22 },
    ]);
    expect(est.totalHighUsd).toBe(43.96);
    expect(est.totalLowUsd).toBe(21.98);
    // one-time launch fee: 10% of the monthly range
    expect(est.feeBps).toBe(1000);
    expect(est.feeLowUsd).toBe(2.2);
    expect(est.feeHighUsd).toBe(4.4);
  });

  it("LAUNCH_FEE_BPS=0 disables the fee", () => {
    process.env.LAUNCH_FEE_BPS = "0";
    try {
      const est = estimateLaunchCost(testnetSpec());
      expect(est.feeBps).toBe(0);
      expect(est.feeLowUsd).toBe(0);
      expect(est.feeHighUsd).toBe(0);
    } finally {
      delete process.env.LAUNCH_FEE_BPS;
    }
  });

  it("the observed mainnet fleet prices fall inside the range", () => {
    // first real launch (2026-07): val $5.51/mo, sentry $5.28, headscale $0.71
    const est = estimateLaunchCost(
      testnetSpec({
        topology: {
          validators: { count: 1 },
          sentries: { count: 1 },
          components: {
            explorer: { enabled: false },
            frontend: { enabled: false },
            hub: { enabled: false },
          },
          headscale: { domain: "headscale.sparkdream.io" },
        },
      }),
    );
    const val = est.perRole.find((r) => r.role === "validators")!;
    const sentry = est.perRole.find((r) => r.role === "sentries")!;
    const hs = est.perRole.find((r) => r.role === "headscale")!;
    expect(val.unitLowUsd).toBeLessThanOrEqual(5.51);
    expect(val.unitHighUsd).toBeGreaterThanOrEqual(5.51);
    expect(sentry.unitLowUsd).toBeLessThanOrEqual(5.28);
    expect(sentry.unitHighUsd).toBeGreaterThanOrEqual(5.28);
    expect(hs.unitLowUsd).toBeLessThanOrEqual(0.71);
    expect(hs.unitHighUsd).toBeGreaterThanOrEqual(0.71);
  });

  it("parses Mi/Gi/Ti sizes", () => {
    expect(sizeToBytes("512Mi")).toBe(512 * 2 ** 20);
    expect(sizeToBytes("8Gi")).toBe(8 * 2 ** 30);
    expect(() => sizeToBytes("8G")).toThrow(/unparseable/);
  });
});
