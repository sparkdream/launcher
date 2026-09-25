import { chainId, type LaunchSpec } from "@sparkdream/launch-spec";
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
  return {
    frontend: {
      service: {
        image: component.image,
        expose: [{ port: 3000, as: 80, accept: [component.domain!], to: [{ global: true }] }],
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
  // the frontend is the one component whose deployed SDL holds nothing the
  // spec doesn't — no resolved tunnel targets or auth keys to preserve
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
