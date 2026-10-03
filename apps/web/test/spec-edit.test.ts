import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { nodeSize, testnetSpec } from "@sparkdream/launch-spec";
import { bidModeOf, roleSizeOf, setBidMode, setRoleSize } from "../lib/spec-edit";

const JOIN_DRAFT = `# Join spec drafted from a join bundle.
# NOTE: review the peers below before launching.
network:
  name: sparkdream
  type: testnet
  bech32Prefix: sprkdrm
topology:
  validators: { count: 1 }
  sentries: { count: 1 } # one sentry is enough to start
  headscale: { domain: headscale.sparkdream.io }
providers:
  components:
    sentries:
      exclude: [jjozzietech]
`;

describe("launch settings edits", () => {
  it("sizes a role without losing the draft's comments", () => {
    const out = setRoleSize(JOIN_DRAFT, "sentry", "large")!;
    expect(out).toContain("# NOTE: review the peers below before launching.");
    expect(out).toContain("# one sentry is enough to start");
    const doc = yaml.load(out) as any;
    expect(doc.infra.roleSizes).toEqual({ sentry: "large" });
    expect(roleSizeOf(doc, "sentry")).toBe("large");
    expect(roleSizeOf(doc, "validator")).toBe("standard");
    // and the launch renders it that way
    expect(nodeSize(testnetSpec({ infra: doc.infra } as never), "sentry-0")).toBe("large");
  });

  it("a role size replaces the role's per-node sizes", () => {
    const text = `infra:\n  nodeSizes:\n    val-0: small\n    sentry-0: large\n`;
    const doc = yaml.load(setRoleSize(text, "validator", "large")!) as any;
    expect(doc.infra.nodeSizes).toEqual({ "sentry-0": "large" });
    expect(doc.infra.roleSizes).toEqual({ validator: "large" });
  });

  it("reads hand-written resources as their tier, or custom", () => {
    const standard = { cpu: 2, memory: "8Gi", storage: { root: "5Gi", data: "8Gi", persistent: true } };
    expect(roleSizeOf({ infra: { resources: { sentry: standard } } }, "sentry")).toBe("standard");
    expect(roleSizeOf({ infra: { resources: { sentry: { ...standard, cpu: 3 } } } }, "sentry")).toBe("custom");
  });

  it("switches who picks the bids, keeping exclusions and comments", () => {
    let text = setBidMode(JOIN_DRAFT, "nodes")!;
    let doc = yaml.load(text) as any;
    expect(bidModeOf(doc)).toBe("nodes");
    expect(doc.providers.components.sentries).toEqual({ exclude: ["jjozzietech"], manualBid: true });
    expect(doc.providers.components.validators).toEqual({ manualBid: true });
    expect(text).toContain("# NOTE");

    text = setBidMode(text, "every")!;
    doc = yaml.load(text) as any;
    expect(bidModeOf(doc)).toBe("every");
    expect(doc.providers.policy).toEqual({ manualBid: true });
    expect(doc.providers.components).toEqual({ sentries: { exclude: ["jjozzietech"] } });

    text = setBidMode(text, "auto")!;
    doc = yaml.load(text) as any;
    expect(bidModeOf(doc)).toBe("auto");
    // nothing left behind but what was there before
    expect(doc.providers).toEqual({ components: { sentries: { exclude: ["jjozzietech"] } } });
  });

  it("calls a hand-made mix custom", () => {
    expect(bidModeOf({ providers: { components: { sentries: { manualBid: true } } } })).toBe("custom");
    expect(bidModeOf({ providers: { components: { explorer: { manualBid: true } } } })).toBe("custom");
  });

  it("leaves broken YAML alone", () => {
    expect(setBidMode("network: [unclosed", "every")).toBeUndefined();
  });
});
