import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkSpec } from "@sparkdream/launch-spec";
import { prefillSpecFromGenesis } from "../src/genesis-prefill.js";

/**
 * "Prefill spec from genesis" against the vendored testnet reference
 * genesis — the real sparkdream-test-1 document, so this doubles as the
 * round-trip proof for the genesis-parity features (hyphenated name,
 * community pool, cosmetics, monikers, external operators).
 */

const genesisPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../vendor/sparkdream-deploy/network/testnet/genesis.json",
);

describe("prefillSpecFromGenesis", () => {
  const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf8"));

  it("maps the manual testnet genesis into a valid spec draft", () => {
    const { spec, notes } = prefillSpecFromGenesis(genesis);
    const s = spec as any;

    expect(s.network).toMatchObject({
      name: "sparkdream-test",
      type: "testnet",
      bech32Prefix: "sprkdrm",
      displayName: "SparkdreamTest",
    });
    expect(s.token).toMatchObject({
      baseDenom: "uspark.sparkdreamtest",
      displayDenom: "SPARK",
      exponent: 6,
      dreamDisplayDenom: "DREAM",
    });

    // 9 person accounts; the distribution module account became the pool
    expect(s.accounts.initial).toHaveLength(9);
    expect(s.accounts.communityPool).toBe("95000000000000");
    expect(s.accounts.validatorSelfDelegation).toBe("400000000000");

    const valya = s.accounts.initial.find((a: any) => a.member?.username === "valya");
    expect(valya).toMatchObject({
      name: "valya",
      address: "sprkdrm19wsctgkpk93wkquu7t8g07gnvwzwdupshys9mu",
      amount: "1250000000000",
      member: {
        trustLevel: "core",
        dreamBalance: "5000000000",
        displayName: "Valya",
        achievements: ["first_spark", "genesis_founder"],
      },
    });
    // members without a seeded username fall back to positional names
    expect(
      s.accounts.initial.filter((a: any) => /^account\d+$/.test(a.name)),
    ).toHaveLength(2);

    // the gentx becomes an external operator with its custom moniker
    expect(s.topology.validators.count).toBe(1);
    expect(s.topology.validators.operators).toEqual([
      "sprkdrm1yhjdr8kxsrer3kcqpdrc2zd0kggvsj4c3vazkd",
    ]);
    expect(s.topology.validators.monikers).toHaveLength(1);
    expect(s.topology.validators.monikers[0]).not.toBe("sparkdream-test-val-0");

    // spec-expressible module params carried over
    expect(s.chainParams.distribution.communityTax).toBe(0.15);
    expect(s.chainParams.slashing.signedBlocksWindow).toBe(100);
    expect(s.chainParams.staking.unbondingTime).toBe("1814400s");
    expect(s.chainParams.gov.minDeposit).toBe("50000000");
    expect(s.chainParams.mint).toMatchObject({ inflationMin: 0.02, inflationMax: 0.05 });
    expect(s.chainParams.validatorDefaults.commissionRate).toBe(0.1);

    // the draft validates as-is (placeholder headscale domain included)
    const check = checkSpec(spec);
    expect(check.errors).toEqual([]);

    // caveats are explicit
    expect(notes.some((n) => n.includes("guessed"))).toBe(true);
    expect(notes.some((n) => n.includes("infrastructure"))).toBe(true);
  });

  it("accepts an RPC /genesis wrapper and rejects non-genesis input", () => {
    const wrapped = prefillSpecFromGenesis({ result: { genesis } });
    expect((wrapped.spec as any).network.name).toBe("sparkdream-test");
    expect(() => prefillSpecFromGenesis({ hello: "world" })).toThrow(/app_state/);
  });
});
