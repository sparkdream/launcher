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
  /**
   * x/season profile username seeded at genesis. Defaults to empty
   * (claimed on-chain later). Season rules: 3-20 chars, lowercase.
   */
  username: z.string().regex(/^[a-z0-9_]{3,20}$/).optional(),
  /** x/season profile display name. Defaults to empty. */
  displayName: z.string().min(1).max(50).optional(),
  /**
   * Achievement ids seeded on the season profile (e.g. "genesis_founder").
   * Unknown ids are carried verbatim — the chain treats them as opaque.
   */
  achievements: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).optional(),
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

/**
 * Provider exclusions (§6): entries are either an akash1... provider owner
 * address (exact match) or a case-insensitive substring of the provider's
 * hostname (parsed from its hostUri). Matching is client-side only, in the
 * conductor's policy engine; SDL placement requirements stay empty.
 */
const providerExclusions = z
  .object({
    exclude: z.array(z.string().min(1)).default([]),
  })
  .strict();

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

const durationSeconds = z.string().regex(/^[0-9]+(\.[0-9]+)?s$/, "duration like '3s' or '2.5s'");
const rate = z.number().min(0).max(1);

/** CometBFT peer string: 40-hex node id @ host:port. */
const peerString = z
  .string()
  .regex(/^[0-9a-f]{40}@[a-z0-9.-]+:[0-9]{1,5}$/i, "peer must be <node_id>@<host>:<port>");

/**
 * Join mode (§5 "Join mode"): deploy a sovereign sentry/validator set onto
 * an EXISTING chain instead of creating one. The fields mirror the origin
 * fleet's published join bundle (GET /api/fleet/:id/join-bundle), so the
 * bundle values paste straight in. Presence of this block forbids every
 * genesis-shaping field (validateSpec enforces the complement).
 */
const joinBlock = z.object({
  /** The live chain's id — network.chainIdSuffix is ignored in join mode. */
  chainId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,49}$/),
  /**
   * Where fetch-genesis downloads the genesis document: a raw genesis.json
   * or a CometBFT RPC /genesis response (both are handled).
   */
  genesisUrl: z.string().url(),
  /**
   * sha256 over the canonical (recursively key-sorted) JSON of the genesis
   * document — serialization-independent, so a raw file and an RPC-wrapped
   * copy verify identically. Required on mainnet so the genesis host is
   * never trusted for integrity.
   */
  genesisSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "64 hex chars (lowercase sha256)")
    .optional(),
  /** Public sentry peers of the existing network. */
  peers: z.array(peerString).min(1),
  /** RPC endpoints for state-sync light-client verification (CometBFT needs two). */
  stateSyncRpcs: z.array(z.string().url()).min(2),
});

export const launchSpecSchema = z.object({
  version: z.literal(1),

  network: z.object({
    /** Lowercase alphanumeric with inner hyphens ("sparkdream-test" →
     *  chain id "sparkdream-test-1"). */
    name: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "lowercase alphanumeric, inner hyphens allowed"),
    type: networkType,
    chainIdSuffix: z.number().int().min(1).default(1),
    bech32Prefix: z.string().regex(/^[a-z]{2,16}$/),
    /** Human-readable name shown by the frontend (CHAIN_NAME). Defaults to name. */
    displayName: z.string().min(1).max(64).optional(),
  }),

  join: joinBlock.optional(),

  token: z.object({
    baseDenom: denom,
    displayDenom: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/),
    exponent: z.number().int().min(0).max(18).default(6),
    /** In baseDenom per gas unit. */
    minGasPrice: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
    /** Defaults to baseDenom. */
    bondDenom: denom.optional(),
    /**
     * The chain's internal coordination token. Same shape rule as the bond
     * denom, "u<2-5 letters>.<suffix>" (validateSpec enforces it); defaults
     * to "udream." + the bond denom's suffix.
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
    /**
     * Genesis community pool, in the bond denom. Seeds the distribution
     * module account (auth + bank balance + supply) and fee_pool
     * consistently — the launcher owns all four, so the reference
     * network's pool never carries over on its own. On SparkDream chains
     * the pool is split across the three root councils at chain start.
     */
    communityPool: amount.optional(),
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
      /**
       * Per-validator monikers (staking description, ≤70 bytes each — any
       * characters, emoji included). Defaults to "<name>-val-<index>".
       * When set, the list length must match count (validateSpec).
       */
      monikers: z.array(z.string().min(1).max(70)).optional(),
      /**
       * Pre-existing consensus pubkeys (base64 ed25519, one per validator in
       * val-0..N order) for signers that already hold their key — a hardware
       * HSM running tmkms. The launcher pins these in the gentx instead of
       * generating a key and exporting it for softsign import; no consensus
       * private key ever exists launcher-side. Requires keyMode tmkms and a
       * list matching count (validateSpec enforces both).
       */
      consensusPubkeys: z
        .array(z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "base64 ed25519 pubkey"))
        .optional(),
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
      /**
       * Public DNS name of this fleet's own headscale. Omit when reuseFleet
       * is set — the conductor fills it in from the owning fleet when the
       * launch is created (validateSpec requires one of the two).
       */
      domain: domain.optional(),
      /**
       * Share another fleet's mesh instead of deploying a headscale of this
       * fleet's own: the launch id (or unique network name) of a fleet on
       * the same launcher instance and wallet. The launch then creates its
       * own headscale user and preauth keys on that fleet's server and
       * deploys no headscale itself — so one tailscale login on a signer
       * machine reaches every fleet sharing the mesh. The owning fleet
       * cannot shut down while a fleet sharing its mesh is live.
       */
      reuseFleet: z.string().min(1).optional(),
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
    /** Fleet-wide: providers on this list may host NO component. */
    exclude: z.array(z.string().min(1)).default([]),
    /** Per component group, merged over the fleet-wide list. */
    components: z
      .object({
        headscale: providerExclusions.optional(),
        validators: providerExclusions.optional(),
        sentries: providerExclusions.optional(),
        explorer: providerExclusions.optional(),
        frontend: providerExclusions.optional(),
        hub: providerExclusions.optional(),
      })
      .strict()
      .default({}),
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
    /**
     * Chain-repo commit pinning the deploy data (reference genesis,
     * templates, SDLs) paired with the sparkdreamd image (§13). Only
     * consulted in fetch mode when the image's version has no matching git
     * tag; selects a commit within the operator-configured repo, never a
     * repo. Written by the launch panel's commit prompt, or set by hand.
     */
    chainRepoCommit: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, "expected a git commit hash (7-40 hex chars)")
      .optional(),
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
