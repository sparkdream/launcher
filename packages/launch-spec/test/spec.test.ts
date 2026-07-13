import { describe, expect, it } from "vitest";
import {
  chainId,
  checkSpec,
  lcdRequired,
  resolveTopology,
  statelessComponents,
  tunnelPort,
  validateSpec,
  withDefaults,
} from "../src/index.js";
import { testnetSpec, testnetSpecInput } from "../src/fixtures.js";

// valid bech32 (20-byte payload) test addresses
const SPARK_A = "spark1qyqszqgpqyqszqgpqyqszqgpqyqszqgpy8v2rs";
const SPARK_B = "spark1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz4r20gx";
const COSMOS_A = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
const AKASH_A = "akash1qyqszqgpqyqszqgpqyqszqgpqyqszqgplgve5x";

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

  it("enforces the chain's identity denom shapes", () => {
    // "usparkz" has six letters after the u — the chain caps it at five
    const badBond = testnetSpec({ token: { baseDenom: "usparkz.sparkdreamdev", displayDenom: "SPARKZ" } });
    expect(validateSpec(badBond).errors.some((e) => e.path === "token.baseDenom")).toBe(true);
    // the dream denom prefix is hardcoded "udream." by x/identity
    const badDream = testnetSpec({
      token: {
        baseDenom: "uspark.sparkdreamdev",
        displayDenom: "SPARK",
        dreamDenom: "udreamz.sparkdreamdev",
      },
    });
    expect(validateSpec(badDream).errors.some((e) => e.path === "token.dreamDenom")).toBe(true);
    // display symbols are 3-8 chars on-chain (schema alone allows more)
    const badSymbol = testnetSpec({
      token: { baseDenom: "uspark.sparkdreamdev", displayDenom: "SPARKLETONS" },
    });
    expect(validateSpec(badSymbol).errors.some((e) => e.path === "token.displayDenom")).toBe(true);
    // valid alternative naming passes: suffix varies, prefix rules hold
    const ok = testnetSpec({
      token: { baseDenom: "uspkz.sparkdreamdev", displayDenom: "SPARKZ", dreamDisplayDenom: "DREAMZ" },
    });
    expect(validateSpec(ok).errors).toEqual([]);
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
      topology: { ...base, validators: { count: 2, operators: [SPARK_A] } },
    });
    expect(
      validateSpec(wrongCount).errors.some((e) => e.message.includes("1 operator addresses")),
    ).toBe(true);

    const wrongPrefix = testnetSpec({
      topology: { ...base, validators: { count: 1, operators: [COSMOS_A] } },
    });
    expect(
      validateSpec(wrongPrefix).errors.some((e) =>
        e.path.startsWith("topology.validators.operators["),
      ),
    ).toBe(true);

    const badChecksum = testnetSpec({
      topology: { ...base, validators: { count: 1, operators: ["spark1abc"] } },
    });
    expect(
      validateSpec(badChecksum).errors.some(
        (e) => e.path === "topology.validators.operators[0]" && e.message.includes("bech32"),
      ),
    ).toBe(true);

    const ok = testnetSpec({
      topology: { ...base, validators: { count: 1, operators: [SPARK_A] } },
    });
    expect(validateSpec(ok).errors).toEqual([]);
  });

  it("rejects an operator whose genesis allocation is below the self-delegation", () => {
    const spec = testnetSpec({
      accounts: {
        initial: [{ name: "op", address: SPARK_A, amount: "5" }],
        validatorSelfDelegation: "1000000000000",
      },
      topology: {
        validators: { count: 1, operators: [SPARK_A] },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const res = validateSpec(spec);
    expect(
      res.errors.some(
        (e) =>
          e.path === "topology.validators.operators[0]" &&
          e.message.includes("validatorSelfDelegation"),
      ),
    ).toBe(true);
  });

  it("warns on generated operators for mainnet", () => {
    const spec = testnetSpec({ network: { name: "sparkdream", type: "mainnet" } });
    const res = validateSpec(spec);
    expect(res.warnings.some((w) => w.path === "topology.validators.operators")).toBe(true);
  });

  it("rejects addresses with the wrong bech32 prefix or a bad checksum", () => {
    for (const address of [COSMOS_A, "spark1abcdef", "notanaddress"]) {
      const spec = testnetSpec({
        accounts: {
          initial: [{ name: "treasury", address, amount: "1000" }],
          validatorSelfDelegation: "1000000000000",
        },
      });
      const res = validateSpec(spec);
      expect(res.errors.some((e) => e.path.startsWith("accounts.initial[0]"))).toBe(true);
    }
    const ok = testnetSpec({
      accounts: {
        initial: [{ name: "treasury", address: SPARK_A, amount: "1000" }],
        validatorSelfDelegation: "1000000000000",
      },
    });
    expect(validateSpec(ok).errors).toEqual([]);
  });

  it("rejects duplicate account names and addresses", () => {
    const spec = testnetSpec({
      accounts: {
        initial: [
          { name: "treasury", address: SPARK_A, amount: "1000" },
          { name: "treasury", address: SPARK_B, amount: "1000" },
          { name: "other", address: SPARK_A, amount: "1000" },
        ],
        validatorSelfDelegation: "1000000000000",
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "accounts.initial[1].name")).toBe(true);
    expect(res.errors.some((e) => e.path === "accounts.initial[2].address")).toBe(true);
  });

  it("flags round-robin leaving validators without sentries", () => {
    const spec = testnetSpec({
      topology: {
        validators: { count: 3 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    expect(validateSpec(spec).warnings.some((w) => w.path === "topology.sentries.count")).toBe(true);
    const asMainnet = testnetSpec({
      network: { name: "sparkdream", type: "mainnet" },
      topology: {
        validators: { count: 3 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    expect(validateSpec(asMainnet).errors.some((e) => e.path === "topology.sentries.count")).toBe(true);
  });

  it("rejects a domain reused across services", () => {
    const spec = testnetSpec({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: true, domain: "chain.sparkdream.io" },
          frontend: { enabled: false },
          hub: { enabled: false },
        },
        publicEndpoints: { api: "chain.sparkdream.io", rpc: "rpc.sparkdream.io" },
        headscale: { domain: "headscale.sparkdream.io" },
      },
    });
    const res = validateSpec(spec);
    expect(
      res.errors.some(
        (e) => e.path === "topology.publicEndpoints.api" && e.message.includes("already used"),
      ),
    ).toBe(true);
  });

  it("rejects inconsistent mint and commission parameters", () => {
    const spec = testnetSpec({
      chainParams: {
        mint: { inflationMin: 0.2, inflationMax: 0.1 },
        validatorDefaults: {
          commissionRate: 0.5,
          commissionMaxRate: 0.2,
          commissionMaxChangeRate: 0.3,
        },
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "chainParams.mint.inflationMin")).toBe(true);
    expect(res.errors.some((e) => e.path === "chainParams.validatorDefaults.commissionRate")).toBe(true);
    expect(
      res.errors.some((e) => e.path === "chainParams.validatorDefaults.commissionMaxChangeRate"),
    ).toBe(true);
  });

  it("rejects non-akash provider preference entries and malformed ssh keys", () => {
    const spec = testnetSpec();
    spec.providers.policy.preference = [AKASH_A, SPARK_A, "garbage"];
    spec.security.sshPublicKey = "definitely not a key";
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "providers.policy.preference[1]")).toBe(true);
    expect(res.errors.some((e) => e.path === "providers.policy.preference[2]")).toBe(true);
    expect(res.errors.some((e) => e.path === "providers.policy.preference[0]")).toBe(false);
    expect(res.errors.some((e) => e.path === "security.sshPublicKey")).toBe(true);
    spec.security.sshPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF00 kob@laptop";
    spec.providers.policy.preference = [AKASH_A];
    expect(validateSpec(spec).errors).toEqual([]);
  });
});

describe("checkSpec", () => {
  it("returns the parsed spec plus cross-field results", () => {
    const res = checkSpec(testnetSpecInput());
    expect(res.spec).not.toBeNull();
    expect(res.ok).toBe(true);
  });

  it("collects every schema issue, not just the first", () => {
    const res = checkSpec(
      testnetSpecInput({
        network: { name: "BAD NAME", bech32Prefix: "NOPE" },
      }),
    );
    expect(res.spec).toBeNull();
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(2);
    expect(res.errors.some((e) => e.path === "network.name")).toBe(true);
    expect(res.errors.some((e) => e.path === "network.bech32Prefix")).toBe(true);
  });

  it("formats array paths with brackets", () => {
    const res = checkSpec(
      testnetSpecInput({
        accounts: {
          initial: [{ name: "x", generate: true, amount: "not-a-number" }],
          validatorSelfDelegation: "1",
        },
      }),
    );
    expect(res.errors.some((e) => e.path === "accounts.initial[0].amount")).toBe(true);
  });

  it("never throws on garbage", () => {
    expect(checkSpec(null).ok).toBe(false);
    expect(checkSpec("nonsense").ok).toBe(false);
    expect(checkSpec(42).ok).toBe(false);
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
