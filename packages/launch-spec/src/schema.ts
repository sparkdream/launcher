import { z } from "zod";

/** Integer amounts are decimal strings — chain amounts overflow JS numbers. */
const amount = z.string().regex(/^[1-9][0-9]*$/, "amount must be a positive integer string");

const denom = z
  .string()
  .regex(/^[a-z][a-z0-9/._-]{2,127}$/, "invalid denom");

const domain = z
  .string()
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "invalid domain");

export const networkType = z.enum(["devnet", "testnet", "mainnet"]);
export type NetworkType = z.infer<typeof networkType>;

const trustLevel = z.enum(["new", "provisional", "established", "trusted", "core"]);

const memberOptions = z.object({
  /** Defaults to core. */
  trustLevel: trustLevel.optional(),
  /**
   * Starting dream balance in the dream base denom. Defaults to the
   * reference network's seed for a member of the same trust level.
   */
  dreamBalance: amount.optional(),
});

const councilOptions = z.object({
  /**
   * Marks this account as the founder: it anchors the Technical and
   * Ecosystem councils and their committees. Exactly one council account
   * must set it (validateSpec enforces this).
   */
  founder: z.boolean().optional(),
  /** Seeded as the x/name display name. Defaults to the capitalized account name. */
  displayName: z.string().min(1).max(64).optional(),
  /**
   * x/name handles claimed for this account at genesis (first becomes
   * primary), so a squatter cannot snipe a founder's identity in the open
   * registration window. Defaults to none — handles can be claimed on-chain
   * later. Names on the chain's blocked list ("gov", "treasury", ...) fail
   * the claim with only a chain-log warning, so avoid reserved-sounding ones.
   */
  handles: z.array(z.string().regex(/^[a-z0-9_]([a-z0-9_-]{1,28}[a-z0-9_])?$/)).optional(),
});

const initialAccount = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    address: z.string().optional(),
    generate: z.boolean().optional(),
    amount,
    /**
     * Seed this account as an active genesis member (x/rep member_map plus a
     * blank x/season profile). `true` seeds a core founding member shaped
     * like the reference network's; the object form picks the trust level
     * and dream balance. Leave unset for non-person accounts (treasury,
     * operators).
     */
    member: z.union([z.boolean(), memberOptions]).optional(),
    /**
     * Seat this account on the founding governance councils. Council
     * accounts are written to x/commons genesis founding_members, which
     * overrides the chain image's compiled-in founders (GenesisNames) so
     * governance bootstraps around the spec's own accounts. Without any
     * council accounts the image's compiled-in founder addresses must exist
     * in accounts.initial, or the chain starts with no councils at all.
     * Requires a sparkdreamd image built after founding_members support.
     */
    council: z.union([z.boolean(), councilOptions]).optional(),
  })
  .refine((a) => Boolean(a.address) !== Boolean(a.generate), {
    message: "exactly one of address or generate must be set",
  });

const s3Backup = z.object({
  endpoint: z.string().url(),
  bucket: z.string().min(1),
  region: z.string().default("auto"),
  accessKeyId: z.string().min(1),
  /** Indirection only — never the secret itself. e.g. "env:HEADSCALE_S3_SECRET" */
  secretRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
});

const componentToggle = z.object({
  enabled: z.boolean(),
  domain: domain.optional(),
});

const roleStorage = z.object({
  root: z.string().regex(/^[0-9]+[MGT]i$/),
  data: z.string().regex(/^[0-9]+[MGT]i$/),
  persistent: z.boolean(),
  class: z.enum(["beta1", "beta2", "beta3"]).default("beta3"),
});

const roleResources = z.object({
  cpu: z.number().positive(),
  memory: z.string().regex(/^[0-9]+[MGT]i$/),
  storage: roleStorage,
});

const durationSeconds = z.string().regex(/^[0-9]+s$/, "duration like '3s'");
const rate = z.number().min(0).max(1);

export const launchSpecSchema = z.object({
  version: z.literal(1),

  network: z.object({
    name: z.string().regex(/^[a-z][a-z0-9]{2,31}$/),
    type: networkType,
    chainIdSuffix: z.number().int().min(1).default(1),
    bech32Prefix: z.string().regex(/^[a-z]{2,16}$/),
    /** Human-readable name shown by the frontend (CHAIN_NAME). Defaults to name. */
    displayName: z.string().min(1).max(64).optional(),
  }),

  token: z.object({
    baseDenom: denom,
    displayDenom: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/),
    exponent: z.number().int().min(0).max(18).default(6),
    /** In baseDenom per gas unit. */
    minGasPrice: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
    /** Defaults to baseDenom. */
    bondDenom: denom.optional(),
    /**
     * The chain's internal coordination token. The chain's identity module
     * hardcodes the prefix — this must be "udream.<suffix>" — so it defaults
     * to "udream." + the bond denom's suffix (validateSpec enforces both).
     */
    dreamDenom: denom.optional(),
    /** Display name for the dream token, like displayDenom for the bond token. */
    dreamDisplayDenom: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{1,11}$/)
      .default("DREAM"),
  }),

  accounts: z.object({
    initial: z.array(initialAccount).default([]),
    validatorSelfDelegation: amount,
  }),

  topology: z.object({
    validators: z.object({
      count: z.number().int().min(1).max(50),
      /**
       * Operator key custody (§3): "generated" → conductor keyring signs the
       * gentxs; a list of addresses → one browser-signed gentx per validator
       * (hardware-wallet capable), keys never leave the user's wallet.
       */
      operators: z.union([z.literal("generated"), z.array(z.string())]).default("generated"),
    }),
    sentries: z.object({
      count: z.number().int().min(0).max(100),
      /** round-robin, or per-sentry list of validator indices it fronts. */
      mapping: z
        .union([z.literal("round-robin"), z.array(z.array(z.number().int().min(0)))])
        .default("round-robin"),
    }),
    components: z.object({
      explorer: componentToggle.extend({
        /**
         * ping-pub route path under the explorer domain (the chain name in
         * the image's baked config). Defaults to network.name — override
         * when the image was built for a differently-named chain, e.g. a
         * devnet ("sparkdreamdev") running the stock "sparkdream" explorer.
         */
        route: z
          .string()
          .regex(/^[a-z0-9-]+$/i)
          .optional(),
      }),
      frontend: componentToggle,
      hub: componentToggle,
    }),
    /**
     * Public chain endpoints, served by sentry-0 via accept-domain ingress
     * (the pattern proven on the manual testnet): api → LCD 1317 (flips the
     * sentry's app.toml [api] block on), rpc → CometBFT 26657. Required for
     * the frontend, which reads LCD_ENDPOINT/RPC_ENDPOINT at runtime.
     */
    publicEndpoints: z
      .object({
        api: domain.optional(),
        rpc: domain.optional(),
      })
      .optional(),
    headscale: z.object({
      domain,
      backup: z.object({ s3: s3Backup }).optional(),
    }),
  }),

  providers: z.object({
    policy: z.object({
      auditedOnly: z.boolean(),
      minUptime7d: rate,
      maxPriceMultiplier: z.number().min(1),
      preference: z.array(z.string()).default([]),
      antiAffinity: z.enum(["strict", "preferSpread"]),
    }),
    escrow: z.object({
      targetRunwayDays: z.number().int().min(1),
    }),
  }),

  chainParams: z
    .object({
      consensus: z.object({ timeoutCommit: durationSeconds }).partial().optional(),
      staking: z
        .object({ unbondingTime: durationSeconds, maxValidators: z.number().int().min(1) })
        .partial()
        .optional(),
      gov: z
        .object({ votingPeriod: durationSeconds, minDeposit: amount })
        .partial()
        .optional(),
      mint: z
        .object({ inflationMin: rate, inflationMax: rate, goalBonded: rate })
        .partial()
        .optional(),
      distribution: z.object({ communityTax: rate }).partial().optional(),
      slashing: z
        .object({
          signedBlocksWindow: z.number().int().min(1),
          minSignedPerWindow: rate,
          downtimeJailDuration: durationSeconds,
          slashFractionDowntime: rate,
          slashFractionDoubleSign: rate,
        })
        .partial()
        .optional(),
      validatorDefaults: z
        .object({
          commissionRate: rate,
          commissionMaxRate: rate,
          commissionMaxChangeRate: rate,
        })
        .partial()
        .optional(),
    })
    .default({}),

  images: z.object({
    sparkdreamd: z.string().min(1),
    headscale: z.string().min(1),
    explorer: z.string().optional(),
    frontend: z.string().optional(),
    hub: z.string().optional(),
  }),

  security: z.object({
    keyMode: z.enum(["softsign", "tmkms"]),
    /** null → launcher generates an ephemeral keypair. */
    sshPublicKey: z.string().nullable().default(null),
  }),

  infra: z.object({
    akashNetwork: z.enum(["mainnet", "sandbox"]),
    rpcEndpoint: z.string().url().nullable().default(null),
    cloudflare: z
      .object({
        apiTokenRef: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
        zone: domain,
      })
      .optional(),
    resources: z.object({
      validator: roleResources,
      sentry: roleResources,
    }),
    sentrySettings: z.object({
      pruning: z.enum(["default", "nothing", "everything", "custom"]),
      snapshotInterval: z.number().int().min(0),
      snapshotKeepRecent: z.number().int().min(1).default(2),
      stateSync: z.boolean(),
    }),
  }),
});

export type LaunchSpec = z.infer<typeof launchSpecSchema>;
export type LaunchSpecInput = z.input<typeof launchSpecSchema>;
