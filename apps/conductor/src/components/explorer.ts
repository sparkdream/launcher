import { deriveDreamDenom, headscaleDomain, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ComponentDescriptor, RenderInput, SdlResources, Tunnel } from "./types.js";

/**
 * Chain-identity env for the explorer (ping-pub) image. Images from
 * v1.0.6 render their runtime chain config from these (same contract as
 * the frontend); older images ignore them and serve their baked config.
 * CHAIN_NAME doubles as the ping-pub route path, so it must agree with the
 * frontend's EXPLORER_URL — both derive it as route ?? network.name.
 */
export function explorerChainEnv(spec: LaunchSpec): Record<string, string> {
  const explorer = spec.topology.components.explorer;
  const dreamDenom = deriveDreamDenom(spec.token);
  return {
    CHAIN_NAME: explorer.route ?? spec.network.name,
    CHAIN_DENOM: spec.token.baseDenom,
    DISPLAY_DENOM: spec.token.displayDenom,
    ...(dreamDenom ? { DREAM_DENOM: dreamDenom } : {}),
    DREAM_DISPLAY_DENOM: spec.token.dreamDisplayDenom,
    COIN_DECIMALS: String(spec.token.exponent),
    BECH32_PREFIX: spec.network.bech32Prefix,
  };
}

const resources: SdlResources = {
  cpu: { units: 0.5 },
  memory: { size: "512Mi" },
  storage: [
    { size: "512Mi" },
    { name: "data", size: "1Gi", attributes: { persistent: true, class: "beta3" } },
  ],
};

/**
 * The explorer's mesh tunnels: sentry-0's LCD on local 11317 and its RPC on
 * 26657. Fleet ops re-aim these at the sentry's current tailnet IP, so the
 * SDL below is built from them rather than from repeated literals.
 */
const tunnels: Tunnel[] = [
  { local: 11317, remote: 1317, peer: "sentry-0" },
  { local: 26657, remote: 26657, peer: "sentry-0" },
];

/**
 * ping-pub image; joins the tailnet and socat-tunnels to sentry-0's LCD
 * (11317→1317) and RPC (26657); nginx serves the UI plus same-origin /api
 * and /rpc proxies, so no CORS and no public LCD needed. The tunnel target
 * is a {{TAILNET_IP:sentry-0}} placeholder until persist-start bakes the
 * real IP into the env (§5 step 20b).
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  return {
    explorer: {
      service: {
        image: component.image,
        expose: [
          // nginx: explorer UI + same-origin /api (LCD) and /rpc proxies
          { port: 80, as: 80, accept: [component.domain!], proto: "tcp", to: [{ global: true }] },
          // sshd for management
          { port: 2222, as: 2222, proto: "tcp", to: [{ global: true }] },
        ],
        env: [
          `SSH_PUBLIC_KEY=${input.sshPublicKey}`,
          `HEADSCALE_URL=https://${headscaleDomain(spec)}`,
          `TS_AUTHKEY=${input.placeholder.tsAuthkey(component.key)}`,
          `TS_HOSTNAME=${component.key}`,
          // on the persistent volume so the tailnet identity survives restarts
          "TS_STATE_DIR=/data/tailscale",
          ...tunnels.map(
            (t, i) => `TS_TUNNEL_${i + 1}=${t.local}:${input.placeholder.tailnetIp(t.peer)}:${t.remote}`,
          ),
          // entrypoint seds these over the baked chain config; relative paths
          // hit the nginx proxies above
          "NODE_API_ENDPOINT=/api",
          "NODE_RPC_ENDPOINT=/rpc",
          ...Object.entries(explorerChainEnv(spec)).map(([k, v]) => `${k}=${v}`),
        ],
        params: { storage: { data: { mount: "/data", readOnly: false } } },
      },
      resources,
    },
  };
}

export const explorer: ComponentDescriptor = {
  key: "explorer",
  render,
  resources: () => [resources],
  imageServices: ["explorer"],
  shellService: "explorer",
  tunnels: () => tunnels,
  envRefresh: "patch",
  chainEnv: explorerChainEnv,
};
