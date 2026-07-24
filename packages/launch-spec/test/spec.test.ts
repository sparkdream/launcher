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
  type LaunchSpec,
} from "../src/index.js";
import { joinSpec, joinSpecInput, testnetSpec, testnetSpecInput } from "../src/fixtures.js";

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
    // the dream denom follows the same shape rule: "udreamz" is six letters
    const badDream = testnetSpec({
      token: {
        baseDenom: "uspark.sparkdreamdev",
        displayDenom: "SPARK",
        dreamDenom: "udreamz.sparkdreamdev",
      },
    });
    expect(validateSpec(badDream).errors.some((e) => e.path === "token.dreamDenom")).toBe(true);
    // the "udream" prefix itself is a convention, not a rule: a custom
    // dream token name passes as long as it keeps the bond denom shape
    const renamedDream = testnetSpec({
      token: {
        baseDenom: "uspark.sparkdreamdev",
        displayDenom: "SPARK",
        dreamDenom: "uwish.sparkdreamdev",
        dreamDisplayDenom: "WISH",
      },
    });
    expect(validateSpec(renamedDream).errors).toEqual([]);
    // x/identity rejects bond/dream collisions at genesis; validate catches them first
    const collidingDenom = testnetSpec({
      token: {
        baseDenom: "uspark.sparkdreamdev",
        displayDenom: "SPARK",
        dreamDenom: "uspark.sparkdreamdev",
      },
    });
    expect(validateSpec(collidingDenom).errors.some((e) => e.path === "token.dreamDenom")).toBe(true);
    const collidingSymbol = testnetSpec({
      token: {
        baseDenom: "uspark.sparkdreamdev",
        displayDenom: "SPARK",
        dreamDisplayDenom: "SPARK",
      },
    });
    expect(validateSpec(collidingSymbol).errors.some((e) => e.path === "token.dreamDisplayDenom")).toBe(true);
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

  it("network names allow inner hyphens, reject edge/consecutive ones", () => {
    const named = (name: string) => checkSpec(testnetSpecInput({ network: { name, type: "testnet", bech32Prefix: "spark" } }));
    expect(named("sparkdream-test").errors.some((e) => e.path === "network.name")).toBe(false);
    expect(chainId(named("sparkdream-test").spec!)).toBe("sparkdream-test-1");
    for (const bad of ["-sparkdream", "sparkdream-", "spark--dream", "Spark-Test"]) {
      expect(named(bad).errors.some((e) => e.path === "network.name")).toBe(true);
    }
  });

  it("validator monikers must match count; member usernames must be unique", () => {
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
      topology: { ...base, validators: { count: 2, monikers: ["🦢 Svanmøy-01 // ⚡"] } },
    });
    expect(validateSpec(wrongCount).errors.some((e) => e.path === "topology.validators.monikers")).toBe(true);
    // non-ASCII monikers warn (config.toml is sanitized at render; the
    // on-chain description keeps the original)
    const nonAscii = testnetSpec({
      topology: { ...base, validators: { count: 1, monikers: ["🦢 Svanmøy-01 // ⚡"] } },
    });
    const nonAsciiRes = validateSpec(nonAscii);
    expect(nonAsciiRes.errors.some((e) => e.path.startsWith("topology.validators.monikers"))).toBe(
      false,
    );
    expect(
      nonAsciiRes.warnings.some((w) => w.path === "topology.validators.monikers[0]"),
    ).toBe(true);
    const ok = testnetSpec({
      topology: { ...base, validators: { count: 1, monikers: ["Svanmoy-01"] } },
    });
    expect(validateSpec(ok).errors.some((e) => e.path.startsWith("topology.validators.monikers"))).toBe(false);

    const dupes = testnetSpec({
      accounts: {
        initial: [
          { name: "a", generate: true, amount: "10", member: { username: "valya" } },
          { name: "b", generate: true, amount: "10", member: { username: "valya" } },
        ],
        validatorSelfDelegation: "1000000000000",
      },
    });
    expect(validateSpec(dupes).errors.some((e) => e.message.includes("duplicate member usernames"))).toBe(true);
  });

  it("pre-existing consensus pubkeys: tmkms-only, one per validator, no duplicates", () => {
    // from the manual testnet's gentx (a real 32-byte ed25519 pubkey)
    const KEY0 = "OElT4VJpHCEW//d/q5FjCQ7i8EZURn49PSeB7MHp8ds=";
    const KEY1 = Buffer.alloc(32, 1).toString("base64");
    const topo = (validators: Record<string, unknown>) => ({
      validators,
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
    });
    const pinnedErr = (s: LaunchSpec) =>
      validateSpec(s).errors.filter((e) => e.path.startsWith("topology.validators.consensusPubkeys"));

    // tmkms + one key per validator: accepted (join mode too — the pin
    // parameterizes your own validator, it does not shape genesis)
    const ok = testnetSpec({
      security: { keyMode: "tmkms" },
      topology: topo({ count: 2, consensusPubkeys: [KEY0, KEY1] }),
    });
    expect(pinnedErr(ok)).toEqual([]);
    const joined = joinSpec({
      security: { keyMode: "tmkms" },
      topology: topo({ count: 1, consensusPubkeys: [KEY0] }),
    });
    expect(pinnedErr(joined)).toEqual([]);

    // softsign: the pinned key's private half never reaches the node
    const soft = testnetSpec({ topology: topo({ count: 1, consensusPubkeys: [KEY0] }) });
    expect(
      pinnedErr(soft).some((e) => e.path === "topology.validators.consensusPubkeys"),
    ).toBe(true);

    // one key per validator, like monikers
    const short = testnetSpec({
      security: { keyMode: "tmkms" },
      topology: topo({ count: 2, consensusPubkeys: [KEY0] }),
    });
    expect(
      pinnedErr(short).some(
        (e) => e.path === "topology.validators.consensusPubkeys" && e.message.includes("1 pubkeys for 2 validators"),
      ),
    ).toBe(true);

    // two validators on one consensus key double-sign
    const dupe = testnetSpec({
      security: { keyMode: "tmkms" },
      topology: topo({ count: 2, consensusPubkeys: [KEY0, KEY0] }),
    });
    expect(pinnedErr(dupe).some((e) => e.path === "topology.validators.consensusPubkeys[1]")).toBe(true);

    // malformed keys fail the schema itself
    const bad = checkSpec(
      testnetSpecInput({
        security: { keyMode: "tmkms" },
        topology: topo({ count: 1, consensusPubkeys: ["not-a-key"] }),
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.path === "topology.validators.consensusPubkeys[0]")).toBe(true);
  });

  it("communityPool is a genesis-shaping field: fine on new chains, rejected in join mode", () => {
    const fresh = testnetSpec({ accounts: { initial: [], validatorSelfDelegation: "1", communityPool: "95000000000000" } });
    expect(validateSpec(fresh).errors.some((e) => e.path === "accounts.communityPool")).toBe(false);
    const joined = joinSpec({ accounts: { initial: [], validatorSelfDelegation: "1", communityPool: "95000000000000" } });
    expect(validateSpec(joined).errors.some((e) => e.path === "accounts.communityPool")).toBe(true);
  });

  it("shared mesh (reuseFleet): domain becomes optional, backup forbidden", () => {
    const topo = (headscale: Record<string, unknown>) => ({
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale,
    });
    // reuseFleet alone is a valid mesh choice
    expect(validateSpec(testnetSpec({ topology: topo({ reuseFleet: "abc-123" }) })).ok).toBe(true);
    // neither domain nor reuseFleet is not
    const neither = validateSpec(testnetSpec({ topology: topo({}) }));
    expect(neither.errors.some((e) => e.path === "topology.headscale")).toBe(true);
    // the owning fleet backs up the shared mesh, not this one
    const withBackup = validateSpec(
      testnetSpec({
        topology: topo({
          reuseFleet: "abc-123",
          backup: {
            s3: {
              endpoint: "https://s3.example.com",
              bucket: "b",
              accessKeyId: "k",
              secretRef: "env:S3_SECRET",
            },
          },
        }),
      }),
    );
    expect(withBackup.errors.some((e) => e.path === "topology.headscale.backup")).toBe(true);
    // mainnet's backup requirement moves to the owning fleet too
    const mainnet = testnetSpec({ network: { name: "sparkdream", type: "mainnet" } });
    mainnet.topology.headscale = { reuseFleet: "abc-123" };
    expect(
      validateSpec(mainnet).errors.some((e) => e.path === "topology.headscale.backup"),
    ).toBe(false);
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

  it("requires exactly one founder among council accounts", () => {
    const councilSpec = (councils: [boolean | object, boolean | object]) =>
      testnetSpec({
        accounts: {
          initial: [
            { name: "alice", generate: true, amount: "1000", council: councils[0] },
            { name: "bob", generate: true, amount: "1000", council: councils[1] },
          ],
          validatorSelfDelegation: "1000000000000",
        },
      });

    const noFounder = validateSpec(councilSpec([true, true]));
    expect(noFounder.errors.some((e) => e.message.includes("exactly one founder"))).toBe(true);

    const twoFounders = validateSpec(councilSpec([{ founder: true }, { founder: true }]));
    expect(
      twoFounders.errors.some((e) => e.path === "accounts.initial[1].council.founder"),
    ).toBe(true);

    const ok = validateSpec(councilSpec([{ founder: true }, true]));
    expect(ok.errors).toEqual([]);
    // 2 council accounts < the Commons Council minimum of 3
    expect(ok.warnings.some((w) => w.message.includes("minimum membership of 3"))).toBe(true);
  });

  it("rejects handles claimed by two council accounts", () => {
    const spec = testnetSpec({
      accounts: {
        initial: [
          { name: "alice", generate: true, amount: "1000", council: { founder: true, handles: ["dreamer"] } },
          { name: "bob", generate: true, amount: "1000", council: { handles: ["dreamer"] } },
        ],
        validatorSelfDelegation: "1000000000000",
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "accounts.initial[1].council.handles")).toBe(true);
  });

  it("errors when governance can never bootstrap: no council flags, all accounts generated", () => {
    const spec = testnetSpec({
      accounts: {
        initial: [{ name: "treasury", generate: true, amount: "1000" }],
        validatorSelfDelegation: "1000000000000",
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.message.includes("no governance councils"))).toBe(true);

    // explicit addresses might match the image's compiled-in founders, so
    // that case only warns
    const explicit = testnetSpec({
      accounts: {
        initial: [{ name: "alice", address: SPARK_A, amount: "1000" }],
        validatorSelfDelegation: "1000000000000",
      },
    });
    const relaxed = validateSpec(explicit);
    expect(relaxed.errors).toEqual([]);
    expect(relaxed.warnings.some((w) => w.path === "accounts.initial")).toBe(true);
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

describe("join mode (§5 Join mode)", () => {
  const PEER = `${"ab".repeat(20)}@p2p.example.com:31234`;

  it("a well-formed join spec validates clean", () => {
    const res = checkSpec(joinSpecInput());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("chainId comes from the join block, not name-suffix", () => {
    expect(chainId(joinSpec())).toBe("sparkdream-1");
    expect(chainId(joinSpec({ join: { chainId: "other-7" } }))).toBe("other-7");
  });

  it("rejects genesis accounts — the chain already exists", () => {
    const spec = joinSpec({
      accounts: {
        initial: [{ name: "treasury", generate: true, amount: "1000" }],
        validatorSelfDelegation: "1000000000000",
      },
    });
    const res = validateSpec(spec);
    expect(res.errors.some((e) => e.path === "accounts.initial")).toBe(true);
  });

  it("rejects chain-level params but keeps consensus + validatorDefaults", () => {
    const bad = validateSpec(joinSpec({ chainParams: { gov: { votingPeriod: "600s" } } }));
    expect(bad.errors.some((e) => e.path === "chainParams.gov")).toBe(true);
    const good = validateSpec(
      joinSpec({
        chainParams: {
          consensus: { timeoutCommit: "3s" },
          validatorDefaults: { commissionRate: 0.05 },
        },
      }),
    );
    expect(good.errors).toEqual([]);
  });

  it("genesisSha256 pin: warning normally, error on mainnet", () => {
    const unpinned = joinSpecInput({ join: { genesisSha256: undefined } });
    const testnetRes = checkSpec(unpinned);
    expect(testnetRes.warnings.some((w) => w.path === "join.genesisSha256")).toBe(true);
    expect(testnetRes.errors.some((e) => e.path === "join.genesisSha256")).toBe(false);
    const mainnetRes = checkSpec(
      joinSpecInput({
        network: { name: "sparkdream", type: "mainnet", bech32Prefix: "spark" },
        join: { genesisSha256: undefined },
      }),
    );
    expect(mainnetRes.errors.some((e) => e.path === "join.genesisSha256")).toBe(true);
  });

  it("needs at least one sentry", () => {
    const res = checkSpec(
      joinSpecInput({
        topology: {
          validators: { count: 1 },
          sentries: { count: 0 },
          components: { explorer: { enabled: false }, frontend: { enabled: false }, hub: { enabled: false } },
          headscale: { domain: "headscale.sparkdream.io" },
        },
      }),
    );
    expect(res.errors.some((e) => e.path === "topology.sentries.count")).toBe(true);
  });

  it("skips the founding-council requirement — governance already exists", () => {
    // an empty accounts.initial without a council flag is an error at
    // genesis launch but the normal state of a join spec
    const res = checkSpec(joinSpecInput());
    expect(res.errors.some((e) => e.path === "accounts.initial")).toBe(false);
  });

  it("schema rejects malformed peers and needs two state-sync RPCs", () => {
    const badPeer = checkSpec(joinSpecInput({ join: { peers: ["not-a-peer"] } }));
    expect(badPeer.spec).toBeNull();
    const oneRpc = checkSpec(joinSpecInput({ join: { stateSyncRpcs: ["https://rpc.example.com"] } }));
    expect(oneRpc.spec).toBeNull();
    const ok = checkSpec(joinSpecInput({ join: { peers: [PEER] } }));
    expect(ok.ok).toBe(true);
  });

  it("rejects duplicate state-sync RPCs: the cross-check needs distinct endpoints", () => {
    const dup = checkSpec(
      joinSpecInput({
        join: { stateSyncRpcs: ["https://rpc.example.com", "https://rpc.example.com/"] },
      }),
    );
    expect(dup.errors.some((e) => e.path === "join.stateSyncRpcs[1]")).toBe(true);
  });
});

describe("image version floor (reference-genesis compatibility)", () => {
  it("rejects sparkdreamd images older than the vendored reference genesis needs", () => {
    const res = checkSpec(
      testnetSpecInput({
        images: { sparkdreamd: "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24" },
      }),
    );
    expect(res.errors.some((e) => e.path === "images.sparkdreamd")).toBe(true);
  });

  it("accepts the profile default and non-matching image names", () => {
    expect(checkSpec(testnetSpecInput()).ok).toBe(true); // profile pins >= floor
    const custom = checkSpec(
      testnetSpecInput({ images: { sparkdreamd: "myorg/custom-sparkdreamd:latest" } }),
    );
    expect(custom.errors.some((e) => e.path === "images.sparkdreamd")).toBe(false);
  });

  it("exempts join mode (the live chain's genesis governs, not the vendored one)", () => {
    const res = checkSpec(
      joinSpecInput({
        images: { sparkdreamd: "sparkdreamnft/sparkdreamd-testnet-ssh:v1.0.24" },
      }),
    );
    expect(res.errors.some((e) => e.path === "images.sparkdreamd")).toBe(false);
  });
});

describe("images.chainRepoCommit (§13 deploy-data pin)", () => {
  it("accepts a hex commit hash, short or full", () => {
    expect(
      checkSpec(testnetSpecInput({ images: { chainRepoCommit: "c8e0014" } })).ok,
    ).toBe(true);
    expect(
      checkSpec(
        testnetSpecInput({
          images: { chainRepoCommit: "c8e001433d833339b3ea6378d57930eede7777ab" },
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects non-hex refs (branch names, tags)", () => {
    const res = checkSpec(testnetSpecInput({ images: { chainRepoCommit: "main" } }));
    expect(res.errors.some((e) => e.path === "images.chainRepoCommit")).toBe(true);
  });

  it("is optional", () => {
    expect(checkSpec(testnetSpecInput()).ok).toBe(true);
  });
});

describe("provider exclusions", () => {
  it("defaults to empty fleet-wide and per-component lists", () => {
    const spec = testnetSpec();
    expect(spec.providers.exclude).toEqual([]);
    expect(spec.providers.components).toEqual({});
    expect(validateSpec(spec).ok).toBe(true);
  });

  it("accepts a full exclusions block", () => {
    const spec = testnetSpec({
      providers: {
        exclude: ["someprovider"],
        components: {
          headscale: { exclude: [AKASH_A] },
          sentries: { exclude: ["frag"] },
        },
      },
    });
    expect(spec.providers.exclude).toEqual(["someprovider"]);
    expect(spec.providers.components.headscale?.exclude).toEqual([AKASH_A]);
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it("rejects malformed akash addresses at the entry's path", () => {
    const res = validateSpec(testnetSpec({ providers: { exclude: ["akash1bad"] } }));
    expect(res.errors.some((e) => e.path === "providers.exclude[0]")).toBe(true);

    const nested = validateSpec(
      testnetSpec({
        providers: { components: { sentries: { exclude: ["fine-fragment", "akash1xyz"] } } },
      }),
    );
    expect(nested.errors.some((e) => e.path === "providers.components.sentries.exclude[1]")).toBe(
      true,
    );
    expect(nested.errors.some((e) => e.path === "providers.components.sentries.exclude[0]")).toBe(
      false,
    );
  });

  it("rejects bech32 addresses with a non-akash prefix", () => {
    const res = validateSpec(testnetSpec({ providers: { exclude: [COSMOS_A] } }));
    expect(res.errors.some((e) => e.path === "providers.exclude[0]")).toBe(true);
  });

  it("rejects URL-shaped and whitespace fragments", () => {
    for (const entry of ["https://provider.example.com", "has space", "a/b"]) {
      const res = validateSpec(testnetSpec({ providers: { exclude: [entry] } }));
      expect(res.errors.some((e) => e.path === "providers.exclude[0]")).toBe(true);
    }
  });

  it("warns on very short fragments but still passes", () => {
    const res = validateSpec(testnetSpec({ providers: { exclude: ["au"] } }));
    expect(res.warnings.some((w) => w.path === "providers.exclude[0]")).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("rejects unknown component keys and misspelled inner keys", () => {
    const typo = checkSpec(
      testnetSpecInput({ providers: { components: { validator: { exclude: [] } } } }),
    );
    expect(typo.spec).toBeNull();
    expect(typo.errors.some((e) => e.path === "providers.components")).toBe(true);

    const inner = checkSpec(
      testnetSpecInput({ providers: { components: { headscale: { exclud: [] } } } }),
    );
    expect(inner.spec).toBeNull();
    expect(inner.errors.length).toBeGreaterThan(0);
  });

  it("rejects empty entries", () => {
    const res = checkSpec(testnetSpecInput({ providers: { exclude: [""] } }));
    expect(res.spec).toBeNull();
    expect(res.errors.some((e) => e.path === "providers.exclude[0]")).toBe(true);
  });
});

describe("unknown spec keys", () => {
  it("a healthy spec produces no unknown-key warnings", () => {
    const res = checkSpec(testnetSpecInput());
    expect(res.warnings.filter((w) => w.message.includes("unrecognized key"))).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("warns on a misspelled top-level key and still validates", () => {
    const res = checkSpec(testnetSpecInput({ provideers: { exclude: ["x"] } }));
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.path === "provideers")).toBe(true);
  });

  it("warns on a misplaced exclusion (nested under providers.policy)", () => {
    const res = checkSpec(
      testnetSpecInput({ providers: { policy: { exclude: ["someprovider"] } } }),
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.path === "providers.policy.exclude")).toBe(true);
    // and the parse stripped it: the policy engine would never see it
    expect(res.spec!.providers.exclude).toEqual([]);
  });

  it("warns on blocks misplaced under topology", () => {
    const res = checkSpec(
      testnetSpecInput({
        topology: { providers: { components: { headscale: { exclude: ["x"] } } } },
      }),
    );
    expect(res.warnings.some((w) => w.path === "topology.providers")).toBe(true);
  });

  it("warns on unknown keys inside array items with an indexed path", () => {
    const input = testnetSpecInput() as { accounts: { initial: Record<string, unknown>[] } };
    input.accounts.initial[0]!.bogus = 1;
    const res = checkSpec(input);
    expect(res.warnings.some((w) => w.path === "accounts.initial[0].bogus")).toBe(true);
  });

  it("strict schema violations stay errors, without duplicate warnings", () => {
    const res = checkSpec(
      testnetSpecInput({ providers: { components: { validator: { exclude: [] } } } }),
    );
    expect(res.spec).toBeNull();
    expect(res.errors.some((e) => e.path === "providers.components")).toBe(true);
    expect(res.warnings).toEqual([]);
  });
});

describe("topology connectivity", () => {
  const topoErrors = (spec: LaunchSpec) =>
    validateSpec(spec).errors.filter((e) => e.path === "topology");

  it("round-robin 2x2 is connected (the sentry mesh bridges the pairs)", () => {
    expect(topoErrors(testnetSpec())).toEqual([]);
  });

  it("rejects multiple validators with no sentries: no peer path at all", () => {
    const spec = testnetSpec({ topology: { sentries: { count: 0 } } });
    const errs = topoErrors(spec);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("disconnected");
    expect(errs[0]!.message).toContain("val-1");
  });

  it("a single validator with no sentries is fine (it runs alone)", () => {
    const spec = testnetSpec({
      topology: { validators: { count: 1 }, sentries: { count: 0 } },
    });
    expect(topoErrors(spec)).toEqual([]);
  });

  it("round-robin with fewer sentries than validators strands the tail", () => {
    const spec = testnetSpec({
      topology: { validators: { count: 3 }, sentries: { count: 2 } },
    });
    const errs = topoErrors(spec);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("val-2");
    expect(errs[0]!.message).not.toContain("val-1");
  });

  it("disjoint explicit mappings are connected via the sentry mesh", () => {
    const spec = testnetSpec({
      topology: { sentries: { count: 2, mapping: [[0], [1]] } },
    });
    expect(topoErrors(spec)).toEqual([]);
  });

  it("explicit mapping leaving a validator uncovered is disconnected", () => {
    const spec = testnetSpec({
      topology: { sentries: { count: 1, mapping: [[0]] } },
    });
    const errs = topoErrors(spec);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("val-1");
    // the coverage check fires too, on its own path
    expect(
      validateSpec(spec).errors.some((e) => e.path === "topology.sentries.mapping"),
    ).toBe(true);
  });

  it("join mode: every validator needs its own sentry (public peers only reach sentries)", () => {
    const uncovered = joinSpec({
      topology: { validators: { count: 2 }, sentries: { count: 1, mapping: [[0]] } },
    });
    const errs = topoErrors(uncovered);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toContain("validator 1");
    const covered = joinSpec({
      topology: { validators: { count: 2 }, sentries: { count: 1, mapping: [[0, 1]] } },
    });
    expect(topoErrors(covered)).toEqual([]);
  });
});
