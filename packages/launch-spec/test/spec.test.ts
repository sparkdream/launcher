import { describe, expect, it } from "vitest";
import {
  chainId,
  lcdRequired,
  resolveTopology,
  statelessComponents,
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

  it("validates external operator lists", () => {
    const base = {
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
    };
    const wrongCount = testnetSpec({
      topology: { ...base, validators: { count: 2, operators: ["spark1abc"] } },
    });
    expect(
      validateSpec(wrongCount).errors.some((e) => e.message.includes("1 operator addresses")),
    ).toBe(true);

    const wrongPrefix = testnetSpec({
      topology: { ...base, validators: { count: 1, operators: ["cosmos1abc"] } },
    });
    expect(
      validateSpec(wrongPrefix).errors.some((e) =>
        e.path.startsWith("topology.validators.operators["),
      ),
    ).toBe(true);

    const ok = testnetSpec({
      topology: { ...base, validators: { count: 1, operators: ["spark1abc"] } },
    });
    expect(validateSpec(ok).errors).toEqual([]);
  });

  it("warns on generated operators for mainnet", () => {
    const spec = testnetSpec({ network: { name: "sparkdream", type: "mainnet" } });
    const res = validateSpec(spec);
    expect(res.warnings.some((w) => w.path === "topology.validators.operators")).toBe(true);
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

describe("stateless components", () => {
  const componentsOn = (over: Record<string, unknown> = {}) => ({
    validators: { count: 1 },
    sentries: { count: 1 },
    components: {
      explorer: { enabled: true, domain: "explorer.sparkdream.io" },
      frontend: { enabled: true, domain: "app.sparkdream.io" },
      hub: { enabled: false },
    },
    publicEndpoints: { api: "api.sparkdream.io", rpc: "rpc.sparkdream.io" },
    headscale: { domain: "headscale.sparkdream.io" },
    ...over,
  });

  it("profile supplies explorer/frontend images; a full component spec validates", () => {
    const spec = testnetSpec({ topology: componentsOn() });
    expect(spec.images.explorer).toContain("sparkdream-explorer");
    expect(spec.images.frontend).toContain("sparkdream-ui");
    expect(validateSpec(spec).errors).toEqual([]);
    expect(statelessComponents(spec)).toEqual([
      { key: "explorer", domain: "explorer.sparkdream.io", image: spec.images.explorer, mesh: true },
      { key: "frontend", domain: "app.sparkdream.io", image: spec.images.frontend, mesh: false },
    ]);
    expect(lcdRequired(spec)).toBe(true);
  });

  it("rejects an enabled component without a domain", () => {
    const spec = testnetSpec({
      topology: componentsOn({
        components: {
          explorer: { enabled: true },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
      }),
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "topology.components.explorer.domain")).toBe(true);
  });

  it("frontend requires publicEndpoints api + rpc", () => {
    const spec = testnetSpec({ topology: componentsOn({ publicEndpoints: undefined }) });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "topology.publicEndpoints")).toBe(true);
  });

  it("components and public endpoints need at least one sentry", () => {
    const spec = testnetSpec({ topology: componentsOn({ sentries: { count: 0 } }) });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "topology.components.explorer.enabled")).toBe(true);
    expect(res.errors.some((e) => e.path === "topology.publicEndpoints")).toBe(true);
  });

  it("disabled components derive to nothing and need no LCD", () => {
    const spec = testnetSpec();
    expect(statelessComponents(spec)).toEqual([]);
    expect(lcdRequired(spec)).toBe(false);
  });
});
