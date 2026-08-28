import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { testnetSpec, type LaunchSpec } from "@sparkdream/launch-spec";
import { resetSource } from "../lib/reset-spec";

/**
 * The spec editor is a free-standing draft, so the reset button's job is to
 * decide when it is talking about the fleet being reset at all.
 */
describe("chain-reset spec source", () => {
  const live = (): LaunchSpec => testnetSpec();
  const asYaml = (spec: unknown) => yaml.dump(spec);

  it("uses the fleet's own spec when the editor holds a draft for another chain", () => {
    // the reported case: a devnet fleet, a testnet draft left in the editor
    const fleet = testnetSpec({ network: { type: "devnet" } });
    const { spec, fromEditor } = resetSource(asYaml(live()), fleet);
    expect(fromEditor).toBe(false);
    expect(spec.network.type).toBe("devnet");
    expect(spec).toEqual(fleet);
  });

  it("uses the fleet's own spec when the editor holds the built-in example", () => {
    const example = asYaml(testnetSpec({ network: { name: "sparkdreamdev" } }));
    const { spec, fromEditor } = resetSource(example, live());
    expect(fromEditor).toBe(false);
    expect(spec.network.name).toBe(live().network.name);
  });

  it("carries genesis-shaping edits when the draft is about this fleet", () => {
    const draft = live();
    draft.token.displayDenom = "SPARZ";
    draft.chainParams.staking = { maxValidators: 42 };
    draft.images.sparkdreamd = "sparkdreamnft/sparkdreamd:v2.0.0";
    const { spec, fromEditor } = resetSource(asYaml(draft), live());
    expect(fromEditor).toBe(true);
    expect(spec.token.displayDenom).toBe("SPARZ");
    expect(spec.chainParams.staking?.maxValidators).toBe(42);
    expect(spec.images.sparkdreamd).toBe("sparkdreamnft/sparkdreamd:v2.0.0");
  });

  it("takes the deployment's word on frozen fields even in a matching draft", () => {
    const draft = live();
    draft.topology.sentries.count = 3;
    draft.infra.akashNetwork = "sandbox";
    draft.images.headscale = "headscale:v0.99.0";
    draft.token.displayDenom = "SPARZ"; // one real edit, so the draft is used
    const fleet = live();
    const { spec, fromEditor } = resetSource(asYaml(draft), fleet);
    expect(fromEditor).toBe(true);
    expect(spec.token.displayDenom).toBe("SPARZ");
    expect(spec.topology.sentries.count).toBe(fleet.topology.sentries.count);
    expect(spec.infra.akashNetwork).toBe(fleet.infra.akashNetwork);
    expect(spec.images.headscale).toBe(fleet.images.headscale);
  });

  it("reports no editor source for an unedited copy of the fleet's spec", () => {
    const { fromEditor } = resetSource(asYaml(live()), live());
    expect(fromEditor).toBe(false);
  });

  it("falls back to the fleet's spec on an unparseable or invalid draft", () => {
    for (const text of ["{{ not yaml", "version: 1\nnetwork: {}\n", ""]) {
      const { spec, fromEditor } = resetSource(text, live());
      expect(fromEditor).toBe(false);
      expect(spec).toEqual(live());
    }
  });

  it("does not mutate the fleet's spec when no draft applies", () => {
    const fleet = live();
    const { spec } = resetSource("{{ not yaml", fleet);
    spec.images.sparkdreamd = "sparkdreamnft/sparkdreamd:v2.0.0";
    expect(fleet.images.sparkdreamd).not.toBe("sparkdreamnft/sparkdreamd:v2.0.0");
  });
});
