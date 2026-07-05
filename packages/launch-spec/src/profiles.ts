import type { NetworkType } from "./schema.js";

/**
 * Per-network-type defaults, deep-merged UNDER user input by withDefaults().
 * Values mirror deploy/config/network/<type>/chain.env and the design §4
 * sample where the chain repo has no opinion.
 */
export interface Profile {
  token: { exponent: number; minGasPrice: string };
  providers: {
    policy: {
      auditedOnly: boolean;
      minUptime7d: number;
      maxPriceMultiplier: number;
      antiAffinity: "strict" | "preferSpread";
    };
    escrow: { targetRunwayDays: number };
  };
  chainParams: Record<string, Record<string, unknown>>;
  images: { sparkdreamd: string; headscale: string };
  security: { keyMode: "softsign" | "tmkms" };
  infra: {
    akashNetwork: "mainnet" | "sandbox";
    resources: {
      validator: RoleResources;
      sentry: RoleResources;
    };
    sentrySettings: {
      pruning: "default" | "nothing" | "everything" | "custom";
      snapshotInterval: number;
      snapshotKeepRecent: number;
      stateSync: boolean;
    };
  };
}

interface RoleResources {
  cpu: number;
  memory: string;
  storage: { root: string; data: string; persistent: boolean; class: "beta1" | "beta2" | "beta3" };
}

const SPARKDREAMD_VERSION = "v1.0.24";
const HEADSCALE_IMAGE = "sparkdreamnft/headscale:v0.28.0";

const nodeResources = {
  validator: {
    cpu: 1,
    memory: "8Gi",
    storage: { root: "5Gi", data: "50Gi", persistent: true, class: "beta3" as const },
  },
  sentry: {
    cpu: 2,
    memory: "8Gi",
    storage: { root: "5Gi", data: "8Gi", persistent: true, class: "beta3" as const },
  },
};

const commonChainParams = {
  consensus: { timeoutCommit: "3s" },
  staking: { maxValidators: 100 },
  mint: { inflationMin: 0.07, inflationMax: 0.2, goalBonded: 0.67 },
  distribution: { communityTax: 0.02 },
  slashing: {
    signedBlocksWindow: 10000,
    minSignedPerWindow: 0.5,
    downtimeJailDuration: "600s",
    slashFractionDowntime: 0.0001,
    slashFractionDoubleSign: 0.05,
  },
  validatorDefaults: {
    commissionRate: 0.05,
    commissionMaxRate: 0.2,
    commissionMaxChangeRate: 0.01,
  },
};

export const profiles: Record<NetworkType, Profile> = {
  devnet: {
    token: { exponent: 6, minGasPrice: "0" },
    providers: {
      policy: {
        auditedOnly: false,
        minUptime7d: 0.9,
        maxPriceMultiplier: 3.0,
        antiAffinity: "preferSpread",
      },
      escrow: { targetRunwayDays: 7 },
    },
    chainParams: {
      ...commonChainParams,
      consensus: { timeoutCommit: "1s" },
      staking: { ...commonChainParams.staking, unbondingTime: "3600s" },
      gov: { votingPeriod: "300s", minDeposit: "10000000" },
    },
    images: {
      sparkdreamd: `sparkdreamnft/sparkdreamd-devnet-ssh:${SPARKDREAMD_VERSION}`,
      headscale: HEADSCALE_IMAGE,
    },
    security: { keyMode: "softsign" },
    infra: {
      akashNetwork: "sandbox",
      resources: nodeResources,
      sentrySettings: {
        pruning: "default",
        snapshotInterval: 1000,
        snapshotKeepRecent: 2,
        stateSync: false,
      },
    },
  },

  testnet: {
    token: { exponent: 6, minGasPrice: "25000" },
    providers: {
      policy: {
        auditedOnly: true,
        minUptime7d: 0.99,
        maxPriceMultiplier: 2.0,
        antiAffinity: "strict",
      },
      escrow: { targetRunwayDays: 30 },
    },
    chainParams: {
      ...commonChainParams,
      staking: { ...commonChainParams.staking, unbondingTime: "1814400s" },
      gov: { votingPeriod: "172800s", minDeposit: "10000000000" },
    },
    images: {
      sparkdreamd: `sparkdreamnft/sparkdreamd-testnet-ssh:${SPARKDREAMD_VERSION}`,
      headscale: HEADSCALE_IMAGE,
    },
    security: { keyMode: "softsign" },
    infra: {
      akashNetwork: "mainnet",
      resources: nodeResources,
      sentrySettings: {
        pruning: "default",
        snapshotInterval: 1000,
        snapshotKeepRecent: 2,
        stateSync: false,
      },
    },
  },

  mainnet: {
    token: { exponent: 6, minGasPrice: "25000" },
    providers: {
      policy: {
        auditedOnly: true,
        minUptime7d: 0.99,
        maxPriceMultiplier: 2.0,
        antiAffinity: "strict",
      },
      escrow: { targetRunwayDays: 30 },
    },
    chainParams: {
      ...commonChainParams,
      staking: { ...commonChainParams.staking, unbondingTime: "1814400s" },
      gov: { votingPeriod: "172800s", minDeposit: "10000000000" },
    },
    images: {
      sparkdreamd: `sparkdreamnft/sparkdreamd-mainnet-ssh:${SPARKDREAMD_VERSION}`,
      headscale: HEADSCALE_IMAGE,
    },
    security: { keyMode: "tmkms" },
    infra: {
      akashNetwork: "mainnet",
      resources: nodeResources,
      sentrySettings: {
        pruning: "default",
        snapshotInterval: 1000,
        snapshotKeepRecent: 2,
        stateSync: false,
      },
    },
  },
};
