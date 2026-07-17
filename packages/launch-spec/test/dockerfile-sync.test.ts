import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { profiles } from "../src/index.js";
import { VENDORED_CHAIN_VERSION } from "../src/vendor-info.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// The launcher image bundles a sparkdreamd binary (Dockerfile SPARKDREAMD_IMAGE
// arg) and the chain repo's deploy data (vendor/, with the version recorded in
// the generated vendor-info.ts). Binary, vendored genesis, and profile image
// defaults must all agree on the chain version, or launches fail at InitChain.
describe("chain version sync", () => {
  it("Dockerfile SPARKDREAMD_IMAGE matches the testnet profile default", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    const m = /^ARG SPARKDREAMD_IMAGE=(\S+)$/m.exec(dockerfile);
    expect(m, "ARG SPARKDREAMD_IMAGE not found in Dockerfile").not.toBeNull();
    expect(m![1]).toBe(profiles.testnet.images.sparkdreamd);
  });

  it("vendor-info.ts matches the vendored reference SDL (rerun sync-vendor if not)", () => {
    const sdl = readFileSync(
      join(repoRoot, "vendor/sparkdream-deploy/network/testnet/validator.sdl.yaml"),
      "utf8",
    );
    const m = /image: *sparkdreamnft\/sparkdreamd-[a-z]+-ssh:(v\d+(?:\.\d+)*)/.exec(sdl);
    expect(m, "chain image not found in vendored testnet validator SDL").not.toBeNull();
    expect(VENDORED_CHAIN_VERSION).toBe(m![1]);
  });

  it("profile defaults carry the vendored chain version", () => {
    for (const network of ["devnet", "testnet", "mainnet"] as const) {
      expect(profiles[network].images.sparkdreamd).toContain(`:${VENDORED_CHAIN_VERSION}`);
    }
  });
});
