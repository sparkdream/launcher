import type { LaunchSpec } from "./schema.js";
import { withDefaults } from "./validate.js";

/**
 * Minimal wizard output for a testnet launch — everything else comes from
 * the profile. Used by tests here and golden tests in the conductor.
 */
export function testnetSpecInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    network: { name: "sparkdream", type: "testnet", bech32Prefix: "spark", ...(overrides.network as object) },
    token: {
      baseDenom: "uspark.sparkdreamtest",
      displayDenom: "SPARK",
      ...(overrides.token as object),
    },
    accounts: {
      initial: [
        { name: "treasury", generate: true, amount: "500000000000000" },
        { name: "founder", generate: true, amount: "1000000000000", member: true, council: { founder: true } },
      ],
      validatorSelfDelegation: "1000000000000",
      ...(overrides.accounts as object),
    },
    topology: {
      validators: { count: 2 },
      sentries: { count: 2 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: false },
        hub: { enabled: false },
      },
      headscale: { domain: "headscale.sparkdream.io" },
      ...(overrides.topology as object),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([k]) => !["network", "token", "accounts", "topology"].includes(k),
      ),
    ),
  };
}

export function testnetSpec(overrides: Record<string, unknown> = {}): LaunchSpec {
  return withDefaults(testnetSpecInput(overrides));
}

/**
 * Join-mode variant (§5 "Join mode"): same fleet shape, but onto an
 * existing chain — no genesis accounts, a join block instead.
 */
export function joinSpecInput(overrides: Record<string, unknown> = {}): unknown {
  return testnetSpecInput({
    accounts: { initial: [], validatorSelfDelegation: "1000000000000" },
    join: {
      chainId: "sparkdream-1",
      genesisUrl: "https://rpc.sparkdream.io/genesis",
      genesisSha256: "a".repeat(64),
      peers: [`${"ab".repeat(20)}@p2p.example.com:31234`],
      stateSyncRpcs: ["https://rpc.sparkdream.io", "http://rpc2.example.com:26657"],
      ...(overrides.join as object),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => !["join", "accounts"].includes(k))),
    ...(overrides.accounts ? { accounts: overrides.accounts } : {}),
  });
}

export function joinSpec(overrides: Record<string, unknown> = {}): LaunchSpec {
  return withDefaults(joinSpecInput(overrides));
}
