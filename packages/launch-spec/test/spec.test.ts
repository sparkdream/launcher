import { describe, expect, it } from "vitest";
import {
  chainId,
  resolveTopology,
  tunnelPort,
  validateSpec,
  withDefaults,
} from "../src/index.js";
import { testnetSpec, testnetSpecInput } from "../src/fixtures.js";

describe("withDefaults", () => {
  it("fills a minimal wizard output from the testnet profile", () => {
    const spec = testnetSpec();
    expect(spec.providers.policy.auditedOnly).toBe(true);
    expect(spec.providers.policy.antiAffinity).toBe("strict");
    expect(spec.security.keyMode).toBe("softsign");
    expect(spec.images.sparkdreamd).toContain("-testnet-ssh:");
    expect(spec.infra.resources.validator.storage.persistent).toBe(true);
    expect(spec.token.minGasPrice).toBe("25000");
    expect(spec.infra.sentrySettings.stateSync).toBe(false);
  });

  it("user input wins over profile defaults", () => {
    const spec = testnetSpec({
      providers: {
        policy: {
          auditedOnly: false,
          minUptime7d: 0.5,
          maxPriceMultiplier: 5,
          antiAffinity: "preferSpread",
        },
        escrow: { targetRunwayDays: 3 },
      },
    });
    expect(spec.providers.policy.auditedOnly).toBe(false);
    expect(spec.providers.escrow.targetRunwayDays).toBe(3);
  });

  it("mainnet profile defaults to tmkms", () => {
    const spec = testnetSpec({ network: { name: "sparkdream", type: "mainnet" } });
    expect(spec.security.keyMode).toBe("tmkms");
  });

  it("rejects garbage", () => {
    expect(() => withDefaults({ version: 2 })).toThrow();
    expect(() =>
      withDefaults(testnetSpecInput({ token: { baseDenom: "USPARK!", displayDenom: "SPARK" } })),
    ).toThrow();
  });
});

describe("validateSpec", () => {
  it("passes a healthy testnet spec", () => {
    const res = validateSpec(testnetSpec());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("requires persistent storage for nodes", () => {
    const spec = testnetSpec();
    spec.infra.resources.sentry.storage.persistent = false;
    const res = validateSpec(spec);
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.path).toBe("infra.resources.sentry.storage.persistent");
  });

  it("mainnet requires headscale backup and warns on softsign", () => {
    const spec = testnetSpec({ network: { name: "sparkdream", type: "mainnet" } });
    spec.security.keyMode = "softsign";
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "topology.headscale.backup")).toBe(true);
    expect(res.warnings.some((w) => w.path === "security.keyMode")).toBe(true);
  });

  it("rejects bad explicit mappings", () => {
    const spec = testnetSpec({
      topology: {
        validators: { count: 2 },
        sentries: { count: 2, mapping: [[0], [0]] }, // validator 1 uncovered
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.message.includes("validator 1 has no sentry"))).toBe(true);
  });

  it("rejects addresses with the wrong bech32 prefix", () => {
    const spec = testnetSpec({
      accounts: {
        initial: [{ name: "treasury", address: "cosmos1abcdef", amount: "1000" }],
        validatorSelfDelegation: "1000000000000",
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path.startsWith("accounts.initial[0]"))).toBe(true);
  });
});

describe("derive", () => {
  it("chainId = name-suffix", () => {
    expect(chainId(testnetSpec())).toBe("sparkdream-1");
  });

  it("round-robin topology 2x2: sentry s fronts validator s%V", () => {
    const topo = resolveTopology(testnetSpec());
    expect(topo.sentryValidators).toEqual([[0], [1]]);
    expect(topo.validatorSentries).toEqual([[0], [1]]);
  });

  it("round-robin 1 validator, 2 sentries: both front validator 0", () => {
    const spec = testnetSpec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 2 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const topo = resolveTopology(spec);
    expect(topo.sentryValidators).toEqual([[0], [0]]);
    expect(topo.validatorSentries).toEqual([[0, 1]]);
  });

  it("tunnel ports are 16656+v", () => {
    expect(tunnelPort(0)).toBe(16656);
    expect(tunnelPort(3)).toBe(16659);
  });
});
