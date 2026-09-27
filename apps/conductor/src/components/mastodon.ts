import { chainId, mastodonStreamingDomain, type LaunchSpec } from "@sparkdream/launch-spec";
import { SESSION_KEY_FILE, ensureSession } from "../sessions.js";
import { configureMastodon, linkMastodonBridge } from "../steps/mastodon.js";
import {
  BRIDGE_OPERATOR,
  BRIDGE_TOKEN_PENDING,
  ensureMastodonSecrets,
  readBridgeOperatorAddress,
} from "./mastodon-secrets.js";
import type { StepCtx } from "../engine.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

const POSTGRES_IMAGE = "postgres:14-alpine";
const REDIS_IMAGE = "redis:7-alpine";
/** Gas the bridge asks for per anchoring tx (sdapbridge's SDA_GAS default). */
const BRIDGE_GAS = 300_000;

const persistent = (name: string, size: string) => ({ name, size, attributes: { persistent: true, class: "beta3" } });

/**
 * Per service, by mastodon.size. "small" suits a new community: one puma
 * worker (MASTODON_TUNING) and room to grow into; "standard" is the roomier
 * original. Fixed per deployment: Akash cannot resize a running lease.
 */
const SIZES: Record<"small" | "standard", Record<string, SdlResources>> = {
  small: {
    // puma (one worker) + sidekiq; the image alone is ~1.5 GB
    mastodon: { cpu: { units: 1 }, memory: { size: "2Gi" }, storage: [{ size: "4Gi" }, persistent("media", "10Gi")] },
    streaming: { cpu: { units: 0.25 }, memory: { size: "256Mi" }, storage: [{ size: "1Gi" }] },
    db: { cpu: { units: 0.5 }, memory: { size: "1Gi" }, storage: [{ size: "1Gi" }, persistent("pgdata", "5Gi")] },
    redis: { cpu: { units: 0.25 }, memory: { size: "256Mi" }, storage: [{ size: "512Mi" }, persistent("redisdata", "1Gi")] },
    bridge: { cpu: { units: 0.1 }, memory: { size: "128Mi" }, storage: [{ size: "512Mi" }, persistent("state", "1Gi")] },
  },
  standard: {
    mastodon: { cpu: { units: 2 }, memory: { size: "4Gi" }, storage: [{ size: "10Gi" }, persistent("media", "20Gi")] },
    streaming: { cpu: { units: 0.5 }, memory: { size: "512Mi" }, storage: [{ size: "2Gi" }] },
    db: { cpu: { units: 1 }, memory: { size: "2Gi" }, storage: [{ size: "1Gi" }, persistent("pgdata", "10Gi")] },
    redis: { cpu: { units: 0.5 }, memory: { size: "1Gi" }, storage: [{ size: "512Mi" }, persistent("redisdata", "1Gi")] },
    bridge: { cpu: { units: 0.25 }, memory: { size: "256Mi" }, storage: [{ size: "512Mi" }, persistent("state", "1Gi")] },
  },
};

/** Worker settings that fit web + sidekiq into the small size's 2 GiB. */
const MASTODON_TUNING: Record<"small" | "standard", string[]> = {
  small: ["WEB_CONCURRENCY=1", "MAX_THREADS=5", "MALLOC_ARENA_MAX=2"],
  standard: [],
};

/** Every peer the bridge anchors for: this instance's own domain, then the
 *  other servers bridged as peers of their own (bridge.peers). */
export function bridgePeerIds(spec: LaunchSpec): string[] {
  const m = spec.topology.components.mastodon;
  if (!m?.domain) return [];
  return [m.domain, ...(m.bridge?.peers ?? []).map((p) => p.id)];
}

function sizeOf(spec: LaunchSpec): "small" | "standard" {
  return spec.topology.components.mastodon?.size ?? "small";
}

/** Mastodon's outgoing-mail env: the SMTP relay, or mail written to disk. */
function mailEnv(spec: LaunchSpec, password: string | undefined): string[] {
  const smtp = spec.topology.components.mastodon?.smtp;
  // no relay: mail is written to disk and dropped rather than retried
  // forever; the launcher confirms the accounts it creates itself
  if (!smtp) return ["SMTP_DELIVERY_METHOD=file"];
  return [
    "SMTP_DELIVERY_METHOD=smtp",
    `SMTP_SERVER=${smtp.server}`,
    `SMTP_PORT=${smtp.port}`,
    ...(smtp.login ? [`SMTP_LOGIN=${smtp.login}`] : []),
    ...(password ? [`SMTP_PASSWORD=${password}`] : []),
    `SMTP_FROM_ADDRESS=${smtp.fromAddress}`,
    `SMTP_AUTH_METHOD=${smtp.authMethod}`,
    ...(smtp.security === "tls"
      ? ["SMTP_TLS=true", "SMTP_ENABLE_STARTTLS=never"]
      : smtp.security === "starttls"
        ? ["SMTP_ENABLE_STARTTLS=always"]
        : ["SMTP_ENABLE_STARTTLS=never"]),
  ];
}

function bridgeEnabled(spec: LaunchSpec): boolean {
  return Boolean(spec.topology.components.mastodon?.bridge?.enabled);
}

/** The bridge operator's address (the session's granter): its key is created
 *  in the master keyring before any render that needs it (generate-keys, or
 *  the add-component render step), which records the address. */
function bridgeOperator(input: RenderInput): string {
  const address =
    (input.secretsDir ? readBridgeOperatorAddress(input.secretsDir) : undefined) ??
    input.resolveFleet?.(input.launchId ?? "")?.accounts[BRIDGE_OPERATOR];
  if (!address) throw new Error(`the ${BRIDGE_OPERATOR} key does not exist yet — it is created before the SDL is rendered`);
  return address;
}

/**
 * Mastodon: web + sidekiq (the chain repo's Dockerfile-mastodon), upstream
 * streaming, postgres and redis in one deployment, so they share a provider
 * and reach each other by service name. postgres and redis are exposed only
 * to the two Mastodon services. With the bridge, sdapbridge rides along.
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  if (!input.secretsDir) throw new Error("mastodon needs the launch's secrets directory to render");
  const secrets = ensureMastodonSecrets(input.secretsDir);
  const streaming = mastodonStreamingDomain(spec)!;
  const env = [
    "RAILS_ENV=production",
    "NODE_ENV=production",
    `LOCAL_DOMAIN=${component.domain}`,
    "LOCAL_HTTPS=true",
    // TLS ends upstream (Cloudflare / the provider's ingress); see the
    // image's zz_sparkdream_proxy.rb
    "SPARKDREAM_ASSUME_SSL=true",
    // the bridge and verifier fetch AS2 unsigned
    "AUTHORIZED_FETCH=false",
    // no nginx in front: puma serves the compiled assets
    "RAILS_SERVE_STATIC_FILES=true",
    `STREAMING_API_BASE_URL=wss://${streaming}`,
    "DB_HOST=db",
    "DB_PORT=5432",
    "DB_USER=postgres",
    "DB_NAME=mastodon",
    `DB_PASS=${secrets.DB_PASS}`,
    "REDIS_HOST=redis",
    "REDIS_PORT=6379",
    `SECRET_KEY_BASE=${secrets.SECRET_KEY_BASE}`,
    `OTP_SECRET=${secrets.OTP_SECRET}`,
    `VAPID_PRIVATE_KEY=${secrets.VAPID_PRIVATE_KEY}`,
    `VAPID_PUBLIC_KEY=${secrets.VAPID_PUBLIC_KEY}`,
    `ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=${secrets.ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY}`,
    `ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=${secrets.ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT}`,
    `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=${secrets.ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY}`,
    ...mailEnv(spec, secrets.smtpPassword ?? spec.topology.components.mastodon?.smtp?.password),
  ];
  const RESOURCES = SIZES[sizeOf(spec)];
  const internal = (port: number) => ({ port, to: [{ service: "mastodon" }, { service: "streaming" }] });

  const services: Record<string, { service: Record<string, unknown>; resources: SdlResources }> = {
    mastodon: {
      service: {
        image: component.image,
        expose: [{ port: 3000, as: 80, accept: [component.domain!], to: [{ global: true }] }],
        env: [...env, ...MASTODON_TUNING[sizeOf(spec)]],
        params: { storage: { media: { mount: "/opt/mastodon/public/system", readOnly: false } } },
      },
      resources: RESOURCES.mastodon!,
    },
    streaming: {
      service: {
        image: spec.images.mastodonStreaming!,
        command: ["node", "./streaming/index.js"],
        expose: [{ port: 4000, as: 80, accept: [streaming], to: [{ global: true }] }],
        env,
      },
      resources: RESOURCES.streaming!,
    },
    db: {
      service: {
        image: POSTGRES_IMAGE,
        expose: [internal(5432)],
        env: [
          `POSTGRES_PASSWORD=${secrets.DB_PASS}`,
          // a subdirectory: the volume root holds lost+found, which initdb refuses
          "PGDATA=/var/lib/postgresql/data/pgdata",
        ],
        params: { storage: { pgdata: { mount: "/var/lib/postgresql/data", readOnly: false } } },
      },
      resources: RESOURCES.db!,
    },
    redis: {
      service: {
        image: REDIS_IMAGE,
        expose: [internal(6379)],
        params: { storage: { redisdata: { mount: "/data", readOnly: false } } },
      },
      resources: RESOURCES.redis!,
    },
  };

  if (bridgeEnabled(spec)) {
    const api = spec.topology.publicEndpoints?.api;
    if (!api) throw new Error("the mastodon bridge needs topology.publicEndpoints.api — validate-spec should have caught this");
    services.bridge = {
      service: {
        image: spec.images.sdap!,
        // idle until the launcher has created the bridge account's token and
        // bonded the operator (configure step), then the real daemon. args,
        // not command: the image's entrypoint readies /data and drops to its
        // unprivileged user. The daemon signs through the session key the
        // launcher writes to /data (sessions.ts); the operator's own key,
        // which controls the bond, never leaves the launcher.
        args: [
          "sh", "-c",
          `if [ "$MASTODON_TOKEN" = "${BRIDGE_TOKEN_PENDING}" ]; then ` +
            'echo "sdapbridge: waiting for the launcher to configure the bridge"; exec sleep 2147483647; fi; ' +
            "exec sdapbridge",
        ],
        env: [
          `MASTODON_URL=https://${component.domain}`,
          `MASTODON_TOKEN=${BRIDGE_TOKEN_PENDING}`,
          `SDA_SESSION_KEY_FILE=${SESSION_KEY_FILE}`,
          `SDA_GRANTER=${bridgeOperator(input)}`,
          `SDA_PEER_IDS=${bridgePeerIds(spec).join(",")}`,
          `SDA_LCD=https://${api}`,
          `SDA_CHAIN_ID=${chainId(spec)}`,
          `SDA_PREFIX=${spec.network.bech32Prefix}`,
          `SDA_DENOM=${spec.token.baseDenom}`,
          `SDA_GAS=${BRIDGE_GAS}`,
          `SDA_FEE=${Math.max(1, Math.ceil(Number(spec.token.minGasPrice) * BRIDGE_GAS))}`,
          "SDA_CONSENT=opt-in",
          "SDA_STATE=/data/sdapbridge-state.json",
        ],
        params: { storage: { state: { mount: "/data", readOnly: false } } },
      },
      resources: RESOURCES.bridge!,
    };
  }
  return services;
}

export const mastodon: ComponentDescriptor = {
  key: "mastodon",
  render,
  resources: (spec: LaunchSpec) => Object.values(SIZES[sizeOf(spec)]),
  // web+sidekiq only: streaming follows its own upstream image, and postgres
  // / redis / the bridge keep theirs
  imageServices: ["mastodon"],
  sideImages: { streaming: "mastodonStreaming", bridge: "sdap" },
  shellService: "mastodon",
  tunnels: () => [],
  envRefresh: "none",
  images: (spec) => [
    spec.images.mastodon!,
    spec.images.mastodonStreaming!,
    ...(bridgeEnabled(spec) ? [spec.images.sdap!] : []),
  ],
  ingress: (spec) => {
    const m = spec.topology.components.mastodon!;
    const streaming = mastodonStreamingDomain(spec)!;
    return [
      { domain: m.domain!, healthUrl: `https://${m.domain}/health` },
      { domain: streaming, healthUrl: `https://${streaming}/api/v1/streaming/health` },
    ];
  },
  configureSteps: (name, spec) => [
    { name: name("configure-mastodon"), run: (ctx) => configureMastodon(ctx, name("configure-mastodon"), spec) },
    ...(bridgeEnabled(spec)
      ? [
          { name: name("link-bridge"), run: (ctx: StepCtx) => linkMastodonBridge(ctx, name("link-bridge"), spec) },
          { name: name("session-bridge"), run: (ctx: StepCtx) => ensureSession(ctx, spec, "bridge") },
        ]
      : []),
  ],
};
