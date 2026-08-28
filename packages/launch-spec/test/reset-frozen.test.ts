import { describe, expect, it } from "vitest";
import { applyFrozenReset, frozenResetViolations, testnetSpec } from "../src/index.js";

/** A reset rebuilds genesis on the deployments it already has. */
describe("chain-reset frozen fields", () => {
  it("sees no violation in genesis-shaping edits", () => {
    const current = testnetSpec();
    const proposed = structuredClone(current);
    proposed.token.displayDenom = "SPARZ";
    proposed.accounts.initial[0]!.amount = "999";
    proposed.chainParams.staking = { maxValidators: 50 };
    proposed.images.sparkdreamd = "sparkdreamnft/sparkdreamd:v2.0.0";
    expect(frozenResetViolations(current, proposed)).toEqual([]);
  });

  it("holds the chain-id still: a reset restarts the same chain", () => {
    const current = testnetSpec();
    const proposed = structuredClone(current);
    proposed.network.chainIdSuffix = current.network.chainIdSuffix + 1;
    expect(frozenResetViolations(current, proposed)).toEqual(["network.chainIdSuffix"]);
    applyFrozenReset(current, proposed);
    expect(proposed.network.chainIdSuffix).toBe(current.network.chainIdSuffix);
  });

  it("reports every violation at once, not just the first", () => {
    const current = testnetSpec();
    const proposed = structuredClone(current);
    proposed.network.type = "devnet";
    proposed.network.chainIdSuffix = 9;
    proposed.topology.sentries.count = 3;
    proposed.infra.akashNetwork = "sandbox";
    proposed.images.headscale = "headscale:v0.99.0";
    expect(frozenResetViolations(current, proposed)).toEqual([
      "network.type",
      "network.chainIdSuffix",
      "topology.sentries.count",
      "infra",
      "images.headscale",
    ]);
  });

  it("projects the deployment's fields onto an edited spec, keeping the edits", () => {
    const current = testnetSpec();
    const proposed = structuredClone(current);
    proposed.network.type = "devnet"; // frozen: the deployment wins
    proposed.infra.akashNetwork = "sandbox"; // frozen
    proposed.token.displayDenom = "SPARZ"; // free: the edit survives
    proposed.images.sparkdreamd = "sparkdreamnft/sparkdreamd:v2.0.0"; // free

    applyFrozenReset(current, proposed);

    expect(frozenResetViolations(current, proposed)).toEqual([]);
    expect(proposed.network.type).toBe(current.network.type);
    expect(proposed.infra.akashNetwork).toBe(current.infra.akashNetwork);
    expect(proposed.token.displayDenom).toBe("SPARZ");
    expect(proposed.images.sparkdreamd).toBe("sparkdreamnft/sparkdreamd:v2.0.0");
  });

  it("restores a frozen field the edit dropped entirely", () => {
    const current = testnetSpec();
    const proposed = structuredClone(current) as Record<string, unknown>;
    delete (proposed.topology as Record<string, unknown>).components;
    applyFrozenReset(current, proposed as never);
    expect((proposed.topology as { components: unknown }).components).toEqual(
      current.topology.components,
    );
  });
});
