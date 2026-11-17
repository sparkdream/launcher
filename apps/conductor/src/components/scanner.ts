import { chainId, uploadBodySize, type LaunchSpec } from "@sparkdream/launch-spec";
import type { StepCtx } from "../engine.js";
import { SESSION_KEY_FILE, ensureSession } from "../sessions.js";
import { registerScanner } from "../steps/scanner.js";
import { SCANNER_OPERATOR, ensurePrecheckToken, ensureVerdictSeed, readScannerOperatorAddress } from "./scanner-secrets.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

/** contentscan's CS_GAS: one MsgSubmitCheckpoint. */
const SCAN_GAS = 200_000;

/** Where the worker serves its feed inside the container. */
const LISTEN_PORT = 8080;

/** The feed's public base URL: what the operator metadata publishes. */
export function scannerFeedUrl(spec: LaunchSpec): string {
  return `https://${spec.topology.components.scanner!.domain}/`;
}

const resources: SdlResources = {
  // decoding a fetched body or image happens in memory (contentscan keeps no
  // media at rest), capped at CS_MAX_FETCH_BYTES (16 MiB); the persistent
  // volume holds the feed, the state file, the verdict and session keys.
  // The image-safety model runs in the worker itself, on the CPU: about two
  // seconds of one core per view of an image, and a 40-megapixel picture
  // (CS_MAX_IMAGE_PIXELS) decodes to a few hundred MiB
  cpu: { units: 1 },
  memory: { size: "1536Mi" },
  storage: [{ size: "1Gi" }, { name: "state", size: "1Gi", attributes: { persistent: true, class: "beta3" } }],
};

/**
 * What the frontend's image uploads ask of the scanner: the pre-check token
 * the two share (the frontend stores a member's picture only after this
 * scanner has cleared its bytes, POST /precheck), the largest file it sends
 * there when the spec raises it, and the gateway ar:// images are read from. Undefined values are ones a deployed scanner must drop.
 * Rendered into a new deployment, and set in place on a running one
 * (chainEnv), which would otherwise only learn them from a relaunch onto an
 * empty volume.
 */
/** The frontend's image uploads, when the fleet has them. */
function uploadsOf(spec: LaunchSpec) {
  const frontend = spec.topology.components.frontend;
  return frontend.enabled ? frontend.imageUploads : undefined;
}

/**
 * The pre-check takes a file as the request's whole body, and the ingress
 * refuses anything over 1 MiB unless told otherwise.
 */
function setUploadBodySize(expose: any, spec: LaunchSpec): void {
  const uploads = uploadsOf(spec);
  if (uploads) expose.http_options = { ...expose.http_options, max_body_size: uploadBodySize(uploads) };
  else if (expose.http_options) {
    delete expose.http_options.max_body_size;
    if (Object.keys(expose.http_options).length === 0) delete expose.http_options;
  }
}

function uploadsEnv(spec: LaunchSpec, secretsDir: string | undefined): Record<string, string | undefined> {
  const uploads = uploadsOf(spec);
  if (uploads && !secretsDir) throw new Error("the scanner's pre-check token needs the launch's secrets directory");
  return {
    CS_PRECHECK_TOKEN: uploads ? ensurePrecheckToken(secretsDir!) : undefined,
    CS_PRECHECK_MAX_BYTES: uploads?.copyMaxBytes ? String(uploadBodySize(uploads)) : undefined,
    CS_ARWEAVE_GATEWAY: uploads?.arweave?.gateway,
  };
}

/**
 * contentscan (the sdap image), following this chain through its public
 * api and serving its signed verdict feed on the scanner's domain
 * (CS_LISTEN). Images are classified by the model the image ships
 * (CS_IMAGE_MODEL, set in the image) unless the spec names a model server.
 * args, not command: the image's entrypoint readies /data and
 * drops to its unprivileged user, then the shell writes the verdict key out
 * of the env (contentscan reads it from a file, outside the served feed
 * directory). It checkpoints through the session key the launcher writes to
 * /data (sessions.ts); until the key arrives and the operator is registered
 * its checkpoints fail and are retried, while the feed fills regardless.
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  const s = spec.topology.components.scanner!;
  const api = spec.topology.publicEndpoints?.api;
  if (!api) throw new Error("the scanner needs topology.publicEndpoints.api — validate-spec should have caught this");
  if (!input.secretsDir) throw new Error("the scanner's SDL needs the launch's secrets directory");
  const operator = readScannerOperatorAddress(input.secretsDir);
  if (!operator) throw new Error(`the ${SCANNER_OPERATOR} key does not exist yet — it is created before the SDL is rendered`);
  const env = [
    `CS_LCD=https://${api}`,
    `CS_CHAIN_ID=${chainId(spec)}`,
    `CS_PREFIX=${spec.network.bech32Prefix}`,
    `CS_DENOM=${spec.token.baseDenom}`,
    `CS_GAS=${SCAN_GAS}`,
    `CS_FEE=${Math.max(1, Math.ceil(Number(spec.token.minGasPrice) * SCAN_GAS))}`,
    `CS_SESSION_KEY_FILE=${SESSION_KEY_FILE}`,
    `CS_GRANTER=${operator}`,
    `CS_VERDICT_SEED=${ensureVerdictSeed(input.secretsDir)}`,
    "CS_VERDICT_KEY_FILE=/data/verdict.key",
    "CS_FEED_DIR=/data/feed",
    "CS_STATE_FILE=/data/contentscan-state.json",
    `CS_LISTEN=:${LISTEN_PORT}`,
    `CS_FEED_URL=${scannerFeedUrl(spec)}`,
    `CS_RULESET_VERSION=${s.rulesetVersion}`,
    ...(s.classifierUrl ? [`CS_CLASSIFIER_URL=${s.classifierUrl}`] : []),
    ...Object.entries(uploadsEnv(spec, input.secretsDir)).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`])),
  ];
  const expose = { port: LISTEN_PORT, as: 80, accept: [component.domain!], to: [{ global: true }] };
  setUploadBodySize(expose, spec);
  return {
    scanner: {
      service: {
        image: component.image,
        args: [
          "sh", "-c",
          'umask 077; printf "%s\\n" "$CS_VERDICT_SEED" > "$CS_VERDICT_KEY_FILE"; unset CS_VERDICT_SEED; ' +
            "exec contentscan",
        ],
        env,
        expose: [expose],
        params: { storage: { state: { mount: "/data", readOnly: false } } },
      },
      resources,
    },
  };
}

export const scanner: ComponentDescriptor = {
  key: "scanner",
  render,
  resources: () => [resources],
  imageServices: ["scanner"],
  shellService: "scanner",
  tunnels: () => [],
  // an upgrade sets what the frontend's image uploads need on the running
  // deployment, keeping its volume
  envRefresh: "patch",
  chainEnv: uploadsEnv,
  // the env is set in place, so the ingress's body size is too
  upgradeDoc: (doc, spec) => {
    for (const e of doc.services?.scanner?.expose ?? []) if (e.port === LISTEN_PORT) setUploadBodySize(e, spec);
  },
  // the manifest is the feed's root document: served means the feed is up
  ingress: (spec) => {
    const domain = spec.topology.components.scanner!.domain!;
    return [{ domain, healthUrl: `https://${domain}/manifest.json` }];
  },
  configureSteps: (name, spec) => [
    { name: name("register-scanner"), run: (ctx: StepCtx) => registerScanner(ctx, name("register-scanner"), spec) },
    { name: name("session-scanner"), run: (ctx: StepCtx) => ensureSession(ctx, spec, "scanner") },
  ],
  retargetEnv: (spec) => ({ CS_FEED_URL: scannerFeedUrl(spec) }),
};
