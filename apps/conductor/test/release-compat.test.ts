import { describe, expect, it } from "vitest";
import { incompatibleReleaseReason } from "../src/fleet-ops.js";

describe("incompatibleReleaseReason", () => {
  it("names a state format change (devnet 2026-09-30)", () => {
    const logs =
      "3:02PM INF starting ABCI with CometBFT\n" +
      "Error: error during handshake: error on replay: collections: encoding error: value " +
      "decode: proto: wrong wireType = 0 for field MaxTipsSentPerEpoch\n";
    const r = incompatibleReleaseReason(logs)!;
    expect(r).toContain("cannot read the chain's stored state");
    expect(r).toContain("MaxTipsSentPerEpoch");
  });

  it("names a replay that diverges", () => {
    const r = incompatibleReleaseReason(
      "Error: error during handshake: error on replay: wrong Block.Header.AppHash.  Expected 0A, got 0B\n",
    )!;
    expect(r).toContain("different results");
  });

  it("names upgrade-height mismatches either way", () => {
    expect(
      incompatibleReleaseReason('ERR BINARY UPDATED BEFORE TRIGGER! UPGRADE "v2" - in binary but not executed on chain'),
    ).toContain('expects the "v2" upgrade');
    expect(incompatibleReleaseReason('ERR UPGRADE "v2" NEEDED at height: 100: ')).toContain(
      'waiting for the "v2" upgrade',
    );
  });

  it("falls back to the raw handshake error, and ignores healthy logs", () => {
    expect(incompatibleReleaseReason("Error: error during handshake: something new\n")).toContain(
      "something new",
    );
    expect(incompatibleReleaseReason("INF committed state height=5\n")).toBeUndefined();
  });
});
