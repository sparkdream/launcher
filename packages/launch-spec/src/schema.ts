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
 * The far end of a relay path: another fleet on this launcher (resolved at
 * launch creation to its chain id, prefix, gas denom and sentry-0, and
 * reached over the shared mesh), or any chain named by its endpoints.
 */
const relayerFleetCounterparty = z
  .object({
    /** Launch id or unique network name of a fleet on this launcher. It must
     *  share this fleet's mesh (one of the two reuses the other's headscale),
     *  since its sentry's gRPC is only reachable over the tailnet. */
    fleet: z.string().min(1),
  })
  .strict();

const relayerEndpointCounterparty = z
  .object({
    chainId: z.string().min(1),
    /** CometBFT RPC; the websocket event source is <rpc>/websocket unless `ws` says otherwise. */
    rpc: z.string().url(),
    /** gRPC, publicly reachable (e.g. http://grpc.example.org:9090). */
    grpc: z.string().url(),
    ws: z.string().url().optional(),
    /** LCD, optional: lets the launcher check the relayer key's balance. */
    lcd: z.string().url().optional(),
    bech32Prefix: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
    gasDenom: z.string().min(1),
    /** Price per gas unit, at least the chain's minimum-gas-prices. With
     *  dynamicGasPrice it is the fallback when the fee query fails. */
    gasPrice: z.number().positive(),
    /** Follow the chain's fee market instead of the fixed gasPrice: Hermes
     *  queries the base fee (Osmosis txfees for osmosis-* and osmo-test-*
     *  ids, Skip's x/feemarket otherwise), multiplies it, and never pays
     *  above `max`. For chains with neither module it only ever falls back. */
    dynamicGasPrice: z
      .object({
        multiplier: z.number().min(1).default(1.1),
        max: z.number().positive(),
      })
      .strict()
      .optional(),
    /** Gas limit over the simulated gas. Unset, 2.5, as on Spark Dream
     *  chains: simulation underestimates client creation's store writes
     *  (about 1.56x once). Fees are charged on the limit, not on use. */
    gasMultiplier: z.number().min(1).max(10).optional(),
    /** How Hermes learns of IBC events: push subscribes to the websocket
     *  (default); pull polls /block_results, for an RPC that serves no
     *  websocket or a chain whose events the websocket misses. */
    eventSource: z.enum(["push", "pull"]).optional(),
    /** BIP44 path for the relayer key on this chain (coin type 118 by default). */
    hdPath: z.string().regex(/^m(\/[0-9]+'?)+$/).default("m/44'/118'/0'/0/0"),
    /** Light-client trusting period, below the chain's unbonding time. Unset,
     *  Hermes derives 2/3 of the unbonding time from the chain itself. */
    trustingPeriod: z.string().regex(/^[0-9]+(s|m|h|days)$/).optional(),
    /** Most the relayer key should hold here, in gasDenom: the launcher
     *  never asks for more and flags a balance above it. The key sits on the
     *  relayer's provider, so whatever it holds is at that provider's mercy. */
    maxBalance: z.string().regex(/^[1-9][0-9]*$/).optional(),
  })
  .strict();

const relayerPath = z.object({
  /** Stable name for the path: shown in the fleet panel, keys the channel ids. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/),
  /**
   * transfer — ICS-20 token transfers (port transfer, version ics20-1).
   * federation — x/federation content packets (port federation, version
   * federation-1); the counterparty must be a Spark Dream chain, and content
   * flows only once both chains have registered and activated each other
   * as peers.
   */
  kind: z.enum(["transfer", "federation"]),
  counterparty: z.union([relayerFleetCounterparty, relayerEndpointCounterparty]),
});

/**
 * One Hermes process relaying every path. Joins the mesh and reaches this
 * fleet's sentry-0 (gRPC + RPC) and each fleet counterparty's over it.
 */
const relayerComponent = z.object({
  enabled: z.boolean(),
  paths: z.array(relayerPath).default([]),
  /** Genesis balance for the relayer's key on this chain, in the base denom
   *  (it pays gas for every packet this side submits). Ignored in join mode.
   *  Keep it small: the key lives on the relayer's provider. */
  genesisBalance: z.string().regex(/^[0-9]+$/).default("25000000"),
  /** Most the relayer key should hold on any Spark Dream chain it relays
   *  for, in that chain's base denom. genesisBalance may not exceed it, the
   *  launcher's funding prompts never ask for more, and a balance above it
   *  is flagged. Endpoint counterparties set their own maxBalance. */
  maxBalance: z.string().regex(/^[1-9][0-9]*$/).default("100000000"),
});

/**
 * The x/session key a daemon signs with, in place of its account's own key
 * (which never leaves the launcher). The launcher grants it, delivers it to
 * the daemon, renews it with a third of its lifetime left, rotates it
 * whenever the daemon moves to another deployment, and revokes the old one.
 */
const sessionKey = z
  .object({
    /** Grant lifetime in days, capped by the chain's session max_expiration.
     *  Defaults to 30 on mainnet and 90 elsewhere. */
    days: z.number().int().min(1).max(365).optional(),
    /** Fee budget of each grant, in the chain's base denom: the account pays
     *  the daemon's fees out of it, and no more. Capped by the chain's
     *  session max_spend_limit_amount. */
    spendLimit: z.string().regex(/^[1-9][0-9]*$/).default("25000000"),
  })
  .strict();

/**
 * Which authors a bridged peer admits (the peer policy's author curation;
 * both gates must pass, and authors still opt in by following the bridge
 * account). `allow` lists admitted authors ("@user@<domain>") or ["*"] for
 * any; `collectionId` names an x/collect collection whose link items must
 * also list the author, typically owned by the Operations Committee with
 * members as editors so they curate without a proposal per author.
 *
 * Set, the spec owns these two policy fields: they are rewritten on the
 * chain whenever the bridge step runs and the stored policy differs. Unset,
 * the fields are the community's (the frontend's peer policy form), never
 * touched again by the launcher.
 */
const bridgeAuthors = z
  .object({
    allow: z.array(z.string().min(1)).max(256).default(["*"]),
    collectionId: z.number().int().min(0).optional(),
  })
  .strict();

/** A Mastodon account name (the bridge's own account on the instance). */
const mastodonUsername = z.string().regex(/^[a-z0-9_]{1,30}$/i);

/**
 * What a bridge (the Mastodon component's sidecar, or a standalone `bridge`
 * component) links: its operator, session key, account and peers.
 */
const bridgeLink = z.object({
  enabled: z.boolean(),
  /** Genesis balance for the bridge operator, in the base denom: the
   *  operator bond (x/service min_bond, 1000 SPARK by default) plus gas. */
  genesisBalance: z.string().regex(/^[0-9]+$/).default("1100000000"),
  /** sdapbridge signs through this session key; the operator's own key
   *  (it controls the bond) stays with the launcher. */
  session: sessionKey.default({}),
  /** The bridge's account on the Mastodon instance: authors follow it to
   *  opt in. Defaults by the network it anchors to: "bridge" on mainnet,
   *  "bridgetest" on a testnet, "bridgedev" on a devnet, so one instance
   *  can carry a bridge per network. */
  account: mastodonUsername.optional(),
  /** Authors of the instance's own peer; unset, a new peer starts at ["*"]. */
  authors: bridgeAuthors.optional(),
  /**
   * Other Mastodon servers bridged as peers of their own, beside the
   * instance: authors there are followed by the bridge account like local
   * ones, and their posts are anchored under the server's own peer id. Each
   * is registered and activated as an ActivityPub peer and bound to the same
   * operator (sharing its bond), and added to the bridge's and the
   * verifier's peer lists.
   *
   * The alternative is one peer for many servers: list them in the
   * instance's peer policy content_hosts (the frontend's policy form), with
   * no launcher setting at all.
   *
   * A server's peer starts closed (allowed_identities empty) unless its
   * `authors` is given, which then owns those fields as above.
   */
  peers: z
    .array(z.object({ id: domain, authors: bridgeAuthors.optional() }).strict())
    .max(16)
    .optional(),
});

/**
 * A Mastodon instance (the chain repo's Dockerfile-mastodon: web + sidekiq,
 * upstream streaming, postgres, redis in one deployment). Its domain is the
 * instance's identity for good -- ActivityPub ids embed it -- so it cannot be
 * retargeted later.
 */
const mastodonComponent = z.object({
  enabled: z.boolean(),
  /** LOCAL_DOMAIN: https://<domain> is the instance, @user@<domain> its accounts. */
  domain: domain.optional(),
  /** The streaming API's own ingress; defaults to streaming.<domain>. */
  streamingDomain: domain.optional(),
  /** The Owner account the launcher creates; its password is shown once in
   *  the fleet's accounts panel. */
  owner: z
    .object({
      username: z.string().regex(/^[a-z0-9_]{1,30}$/i).default("admin"),
      email: z.string().email(),
    })
    .optional(),
  /**
   * Who may sign up: anyone, anyone with the owner's approval, or nobody.
   * Defaults to nobody: the instance exists to host the bridge account, and
   * authors reach it by following that account from their own servers, so
   * nothing needs local sign-ups (or the mail they depend on).
   */
  registrations: z.enum(["open", "approved", "none"]).default("none"),
  /**
   * Resources: "small" (~2 CPU, ~3.6 GB RAM, 10 GiB media; a new community)
   * or "standard" (~4 CPU, ~8 GB, 20 GiB media). A deployment's resources
   * are fixed on Akash, so changing it means a fresh instance: size up
   * before the community depends on it.
   */
  size: z.enum(["small", "standard"]).default("small"),
  /**
   * Outgoing mail (sign-up confirmations, password resets, notifications),
   * through any SMTP relay. Without it mail is written to disk and never
   * sent, so people who sign up cannot confirm their address; only needed
   * when registrations is not "none". The password is kept
   * in the launcher's secret store, never in the spec.
   */
  smtp: z
    .object({
      server: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(587),
      login: z.string().min(1).optional(),
      /** Accepted when adding the component; moved to the secret store. */
      password: z.string().min(1).optional(),
      /** Instead of a password: the launch id of another fleet of this
       *  wallet whose stored SMTP password to copy (the services spec
       *  builder writes it, so the secret never passes through the editor). */
      passwordFromFleet: z.string().min(1).optional(),
      /** The sender, e.g. "Mastodon <notifications@example.com>". */
      fromAddress: z.string().min(3),
      /** starttls (587), tls (implicit, 465) or none. */
      security: z.enum(["starttls", "tls", "none"]).default("starttls"),
      authMethod: z.enum(["plain", "login", "cram_md5", "none"]).default("plain"),
    })
    .strict()
    .optional(),
  /**
   * Wallet sign-in: members of the chains linked to this instance sign in
   * with Keplr through the sdaplogin sidecar (sdap image), an OpenID Connect
   * provider at `domain` (default: the instance's domain with its first label
   * suffixed, mstdn.example.io → mstdn-login.example.io, so it sits at the
   * same depth and a proxy's edge certificate covers both). A chain is linked when the
   * instance runs in its fleet, or when its fleet's standalone bridge
   * targets the instance. A member's handle is their primary x/name; there
   * is no email to confirm and no password, and the instance's hourly sweep
   * disables the login of anyone who is no longer an active member. The
   * provider creates accounts even with registrations "none", so sign-ups
   * can stay closed.
   */
  walletLogin: z
    .object({
      enabled: z.boolean().default(false),
      domain: domain.optional(),
      /** The lowest x/rep trust level that may sign in. */
      minTrustLevel: z.enum(["new", "provisional", "established", "trusted", "core"]).default("new"),
    })
    .strict()
    .optional(),
  /**
   * The ActivityPub live link (sdapbridge beside the instance): registers the
   * instance as an x/federation ActivityPub peer, bonds a bridge operator for
   * it, and anchors posts of authors who opt in by following the bridge
   * account. Needs topology.publicEndpoints.api (the bridge broadcasts
   * through the LCD). Anchored posts only verify once an independent
   * verifier (sdapverify, on another host and account) runs against the
   * chain. Another fleet's chain can bridge the same instance with a
   * standalone `bridge` component of its own.
   */
  bridge: bridgeLink.optional(),
});

/**
 * A standalone ActivityPub bridge (sdapbridge on its own deployment): links
 * a Mastodon instance another fleet on this launcher runs to THIS fleet's
 * chain, for when one instance serves several networks. Its account and
 * token are made on that instance through the other fleet's deployment; its
 * peer, operator bond and session key are this chain's. A fleet runs either
 * this or its own Mastodon's bridge sidecar, not both.
 */
const bridgeComponent = bridgeLink.extend({
  /** The fleet running the Mastodon instance (launch id or network name,
   *  same wallet). `domain` is filled in when the reference is resolved. */
  target: z.object({ fleet: z.string().min(1), domain: domain.optional() }).strict(),
});

/**
 * An ActivityPub content verifier (sdapverify): re-fetches every post a
 * bridge anchors on the target chain and confirms or disputes its hash. Its
 * worth is its independence from the bridge, so it runs as its own
 * deployment, never on the provider hosting the target's Mastodon, and signs
 * as a member of the target chain who is not the bridge operator.
 */
const verifierComponent = z.object({
  enabled: z.boolean(),
  /** The chain to verify: another fleet on this launcher (launch id or
   *  network name); this fleet when omitted. Its publicEndpoints.api is
   *  where the verifier reads and broadcasts. */
  target: z.object({ fleet: z.string().min(1) }).strict().optional(),
  /** Who verifies: exactly one of `account` or `wallet`, a member of the
   *  target chain at ESTABLISHED or above (x/rep requires it for the
   *  federation-verifier role), never the bridge operator.
   *
   *  account  an accounts.initial name the launcher generated: it bonds and
   *           grants the daemon's session key with that key itself.
   *  wallet   the address of a member whose key stays in your wallet: the
   *           launcher pauses for your signature to bond and to grant (and,
   *           when it renews, re-grant) the session key. */
  account: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  wallet: z.string().regex(/^[a-z]+1[02-9ac-hj-np-z]{38,58}$/).optional(),
  /** ActivityPub peers to verify; defaults to the target's Mastodon domain. */
  peers: z.array(domain).optional(),
  /** DREAM bonded as the federation-verifier role, in micro-DREAM. */
  bond: z.string().regex(/^[0-9]+$/).default("500000000"),
  /** Called when an anchored post does not match what the instance serves. */
  alarmWebhook: z.string().url().optional(),
  /** sdapverify signs through this session key; the member's own key (it
   *  controls the DREAM bond) stays with the launcher or your wallet. */
  session: sessionKey.default({}),
});

/**
 * Per component group provider rules (§6). `exclude` entries are either an
 * akash1... provider owner address (exact match) or a case-insensitive
 * substring of the provider's hostname (parsed from its hostUri). Matching is
 * client-side only, in the conductor's policy engine; SDL placement
 * requirements stay empty. `manualBid` overrides providers.policy.manualBid
 * for this group in either direction.
 */
const componentProviderRules = z
  .object({
    exclude: z.array(z.string().min(1)).default([]),
    manualBid: z.boolean().optional(),
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

  /**
   * What the fleet is. "chain" (the default): a Spark Dream network, its
   * nodes, mesh and the components around it. "services": no chain at all,
   * only long-lived components several chains share (a Mastodon instance
   * that each chain's standalone bridge links to), so their life is not tied
   * to any one network's resets and shutdown. A services fleet deploys no
   * nodes and no headscale; network.name names the fleet, and the chain
   * fields keep their defaults unused.
   */
  kind: z.enum(["chain", "services"]).default("chain"),

  /**
   * Other wallets on this launcher allowed to use this services fleet: their
   * chain fleets may link a standalone bridge to its Mastodon (and copy its
   * stored SMTP password into a fleet of their own). The fleet's own wallet
   * always may. For one person's several wallets (a devnet one and a
   * testnet one sharing one instance); the list is the owner's explicit
   * opt-in, since a linking fleet's bridge setup reaches into this fleet's
   * deployment with this fleet's certificate.
   */
  sharing: z
    .object({ wallets: z.array(z.string().regex(/^akash1[02-9ac-hj-np-z]{38,58}$/, "an akash1... address")).max(32) })
    .strict()
    .optional(),

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
      relayer: relayerComponent.optional(),
      mastodon: mastodonComponent.optional(),
      verifier: verifierComponent.optional(),
      bridge: bridgeComponent.optional(),
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
      antiAffinity: z.enum(["strict", "preferSpread", "off"]),
      /**
       * Never place automatically: every deployment parks with its bids
       * listed and waits for the operator to name the one to lease (§6.6).
       * Per component groups override this under providers.components.
       */
      manualBid: z.boolean().default(false),
    }),
    /** Fleet-wide: providers on this list may host NO component. */
    exclude: z.array(z.string().min(1)).default([]),
    /** Per component group: exclusions merged over the fleet-wide list,
     *  and a manualBid override of the fleet-wide setting. */
    components: z
      .object({
        headscale: componentProviderRules.optional(),
        validators: componentProviderRules.optional(),
        sentries: componentProviderRules.optional(),
        explorer: componentProviderRules.optional(),
        frontend: componentProviderRules.optional(),
        hub: componentProviderRules.optional(),
        relayer: componentProviderRules.optional(),
        mastodon: componentProviderRules.optional(),
        verifier: componentProviderRules.optional(),
        bridge: componentProviderRules.optional(),
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
      /** x/session: maxExpirationDays is the longest a session key grant may
       *  run (the daemons' keys are renewed within it). Defaults to 30 on
       *  mainnet and 90 elsewhere; the code default is 7. */
      session: z.object({ maxExpirationDays: z.number().int().min(1).max(365) }).partial().optional(),
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
    relayer: z.string().optional(),
    /** Web + sidekiq (the derived image); streaming runs mastodonStreaming. */
    mastodon: z.string().optional(),
    mastodonStreaming: z.string().optional(),
    /** sdapbridge (the mastodon component's bridge). */
    sdap: z.string().optional(),
    /** sdapverify (the verifier component): the same sdap image by default. */
    verifier: z.string().optional(),
    /** sdapbridge (the standalone bridge component): the sdap image by default. */
    bridge: z.string().optional(),
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
export type RelayerPath = z.infer<typeof relayerPath>;
export type RelayerEndpointCounterparty = z.infer<typeof relayerEndpointCounterparty>;
export type LaunchSpecInput = z.input<typeof launchSpecSchema>;
