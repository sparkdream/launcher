import { chainId, uploadBodySize, type LaunchSpec } from "@sparkdream/launch-spec";
import { resolveS3Secret } from "../steps/phase-bcd.js";
import { ensurePrecheckToken } from "./scanner-secrets.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

const resources: SdlResources = {
  cpu: { units: 0.5 },
  memory: { size: "512Mi" },
  storage: [{ size: "1Gi" }],
};

/** The explorer link the UI shows: ping-pub routes are /<chain-name-in-baked-
 *  config>; network.name matches when the image was built for this chain —
 *  explorer.route overrides it (e.g. a devnet running the stock chain's
 *  explorer image). Undefined when there is no explorer. */
function explorerUrl(spec: LaunchSpec): string | undefined {
  const explorer = spec.topology.components.explorer;
  return explorer.enabled && explorer.domain
    ? `https://${explorer.domain}/${explorer.route ?? spec.network.name}`
    : undefined;
}

/**
 * Why the frontend's image-upload storage secret cannot be read right now,
 * or undefined when it can (or the frontend stores no uploads). Every render
 * of the frontend needs it, so an op that re-renders partway through (a
 * chain reset resumes the chain in the same step) asks this before it starts.
 */
export function imageUploadsSecretProblem(spec: LaunchSpec, secretsDir: string | undefined): string | undefined {
  const frontend = spec.topology.components.frontend;
  const uploads = frontend.enabled ? frontend.imageUploads : undefined;
  if (!uploads || resolveS3Secret({ s3: uploads }, secretsDir)) return undefined;
  return (
    `image uploads: ${uploads.secretRef} is not set ` +
    (uploads.secretRef.startsWith("env:") ? "in the environment" : "in the launch's secrets")
  );
}

/**
 * sparkdream-ui Next.js server, env-configured at runtime; it needs the
 * public api/rpc domains (spec.topology.publicEndpoints).
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  const pub = spec.topology.publicEndpoints;
  if (!pub?.api || !pub?.rpc) {
    throw new Error("frontend needs topology.publicEndpoints.api and .rpc — validate-spec should have caught this");
  }
  const env = [
    // runtime config — read by /api/config and the UI's LCD proxy at request
    // time, so endpoint changes only need a deployment update, not a rebuild
    `CHAIN_ID=${chainId(spec)}`,
    `CHAIN_NAME=${spec.network.displayName ?? spec.network.name}`,
    `LCD_ENDPOINT=https://${pub.api}`,
    `RPC_ENDPOINT=https://${pub.rpc}`,
    `CHAIN_DENOM=${spec.token.baseDenom}`,
    `DISPLAY_DENOM=${spec.token.displayDenom}`,
    // The frontend names the dream token in its own copy (stake/bond/budget
    // amounts, param labels), so it needs the ticker the same way the explorer
    // does. Without it the UI falls back to a hardcoded "DREAM" and disagrees
    // with the explorer beside it on any chain that renamed the token.
    `DREAM_DISPLAY_DENOM=${spec.token.dreamDisplayDenom}`,
    `BECH32_PREFIX=${spec.network.bech32Prefix}`,
  ];
  const explorer = explorerUrl(spec);
  if (explorer) env.push(`EXPLORER_URL=${explorer}`);
  // where each chain this one relays with answers, for the federation form
  // (a peer's chain identity is read from its API; the chain records none)
  if (input.peerChains && Object.keys(input.peerChains).length > 0) {
    env.push(`PEER_CHAINS=${JSON.stringify(input.peerChains)}`);
  }
  // the anonymous-action prover (x/shield): which chain release's files to
  // load and the sha256 each must have; unset, the UI follows the node's
  // version and trusts that release's own manifest
  const prover = spec.topology.components.frontend.prover;
  if (prover?.assetsUrl) env.push(`ZK_ASSETS_URL=${prover.assetsUrl}`);
  if (prover?.version) env.push(`ZK_VERSION=${prover.version}`);
  if (prover?.digests) env.push(`ZK_DIGESTS=${JSON.stringify(prover.digests)}`);
  // member image uploads: the bucket they are stored in, and the scanner
  // pre-check every image must pass first (validate-spec requires the scanner)
  const uploads = spec.topology.components.frontend.imageUploads;
  if (uploads) {
    const scannerDomain = spec.topology.components.scanner?.domain;
    if (!scannerDomain) throw new Error("image uploads need the scanner's domain — validate-spec should have caught this");
    if (!input.secretsDir) throw new Error("the frontend's image uploads need the launch's secrets directory");
    const secret = resolveS3Secret({ s3: uploads }, input.secretsDir);
    if (!secret) throw new Error(imageUploadsSecretProblem(spec, input.secretsDir));
    env.push(
      `IMAGE_S3_ENDPOINT=${uploads.endpoint}`,
      `IMAGE_S3_REGION=${uploads.region}`,
      `IMAGE_S3_BUCKET=${uploads.bucket}`,
      `IMAGE_S3_ACCESS_KEY=${uploads.accessKeyId}`,
      `IMAGE_S3_SECRET_KEY=${secret}`,
      `IMAGE_PUBLIC_BASE=${uploads.publicBase.replace(/\/+$/, "")}`,
      `IMAGE_PRECHECK_URL=https://${scannerDomain}/precheck`,
      `IMAGE_PRECHECK_TOKEN=${ensurePrecheckToken(input.secretsDir)}`,
    );
    if (uploads.maxBytes) env.push(`IMAGE_UPLOAD_MAX_BYTES=${uploads.maxBytes}`);
    if (uploads.copyMaxBytes) env.push(`IMAGE_COPY_MAX_BYTES=${uploads.copyMaxBytes}`);
    // permanent copies are requested on chain (x/storage) and made by a
    // storage operator: the frontend takes only an off switch and the
    // gateway copies are read from
    const ar = uploads.arweave;
    if (ar?.disabled) env.push("ARWEAVE_UPLOADS_DISABLED=true");
    if (ar?.gateway) env.push(`ARWEAVE_GATEWAY=${ar.gateway}`);
  }
  return {
    frontend: {
      service: {
        image: component.image,
        expose: [
          {
            port: 3000,
            as: 80,
            accept: [component.domain!],
            to: [{ global: true }],
            // an upload is the request's whole body, and the ingress refuses
            // anything over 1 MiB unless told otherwise
            ...(uploads ? { http_options: { max_body_size: uploadBodySize(uploads) } } : {}),
          },
        ],
        env,
      },
      resources,
    },
  };
}

export const frontend: ComponentDescriptor = {
  key: "frontend",
  render,
  resources: () => [resources],
  imageServices: ["frontend"],
  shellService: "frontend",
  // never joins the mesh
  tunnels: () => [],
  // everything in the frontend's deployed SDL comes from the spec or the
  // launch's secrets (the image-upload storage key and pre-check token), and
  // it has no resolved tunnel targets to preserve: render it again
  envRefresh: "rerender",
  retargetEnv(spec) {
    const pub = spec.topology.publicEndpoints;
    return {
      ...(pub?.api ? { LCD_ENDPOINT: `https://${pub.api}` } : {}),
      ...(pub?.rpc ? { RPC_ENDPOINT: `https://${pub.rpc}` } : {}),
      EXPLORER_URL: explorerUrl(spec),
    };
  },
};
