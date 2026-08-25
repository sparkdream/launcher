import { describe, expect, it } from "vitest";
import { cobraError } from "../src/exec.js";

/** The usage screen cobra prints on any failure, abridged in the middle. */
const usage = [
  "Usage:",
  "  sparkdreamd genesis gentx [key_name] [amount] [flags]",
  "",
  "Flags:",
  "      --chain-id string   The network chain ID",
  "  -h, --help              help for gentx",
  "",
  "Global Flags:",
  "      --home string       directory for config and data",
  "      --trace             print out full stack trace on errors",
  "",
].join("\n");

describe("cobra error extraction", () => {
  // the two orderings seen live (2026-08-25), both from `genesis gentx`
  it("finds the error printed below the usage screen", () => {
    expect(cobraError(`${usage}couldn't make client config: mkdir /nope: permission denied\n`)).toBe(
      "couldn't make client config: mkdir /nope: permission denied",
    );
  });

  it("finds the error printed above the usage screen", () => {
    const out = `failed to validate genesis state: jury size must exceed the seated-jury floor 3, got 3 [x/genutil/client/cli/gentx.go:96]\n${usage}`;
    expect(cobraError(out)).toBe(
      "failed to validate genesis state: jury size must exceed the seated-jury floor 3, got 3 [x/genutil/client/cli/gentx.go:96]",
    );
  });

  it("has nothing to report when the output is only usage", () => {
    expect(cobraError(usage)).toBeUndefined();
  });
});
