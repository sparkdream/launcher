import { chainId, type LaunchSpec } from "@sparkdream/launch-spec";
import type { StepCtx } from "../engine.js";
import { SESSION_KEY_FILE, ensureSession } from "../sessions.js";
import { registerScanner } from "../steps/scanner.js";
import { SCANNER_OPERATOR, ensureVerdictSeed, readScannerOperatorAddress } from "./scanner-secrets.js";
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
  // volume holds the feed, the state file, the verdict and session keys
  cpu: { units: 0.5 },
  memory: { size: "512Mi" },
  storage: [{ size: "1Gi" }, { name: "state", size: "1Gi", attributes: { persistent: true, class: "beta3" } }],
};

/**
 * contentscan (the sdap image), following this chain through its public
 * api and serving its signed verdict feed on the scanner's domain
 * (CS_LISTEN). args, not command: the image's entrypoint readies /data and
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
  ];
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
        expose: [{ port: LISTEN_PORT, as: 80, accept: [component.domain!], to: [{ global: true }] }],
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
  envRefresh: "none",
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
