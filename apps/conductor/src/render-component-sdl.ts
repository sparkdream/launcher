import fs from "node:fs";
import yaml from "js-yaml";
import { chainId, type ComponentKey, type ComponentRef, type LaunchSpec } from "@sparkdream/launch-spec";
import { PRICING_DENOM } from "./render-sdl.js";

/** SDL compute resources per component — also feeds the cost estimator. */
export function componentResources(key: ComponentKey) {
  return key === "explorer"
    ? {
        cpu: { units: 0.5 },
        memory: { size: "512Mi" },
        storage: [
          { size: "512Mi" },
          { name: "data", size: "1Gi", attributes: { persistent: true, class: "beta3" } },
        ],
      }
    : {
        cpu: { units: 0.5 },
        memory: { size: "512Mi" },
        storage: [{ size: "1Gi" }],
      };
}

export interface RenderComponentSdlInput {
  spec: LaunchSpec;
  component: ComponentRef;
  sshPublicKey: string;
  outPath: string;
  placeholder: {
    tailnetIp: (nodeKey: string) => string;
    tsAuthkey: (nodeKey: string) => string;
  };
}

/**
 * SDLs for the stateless components. Unlike the node/headscale SDLs these
 * are launcher-authored, not vendored — their upstream shapes (the manual
 * testnet's explorer SDL and sparkdream-ui's deploy.sdl.yml) are baked in
 * here with every value taken from the spec.
 *
 * - explorer: ping-pub image; joins the tailnet and socat-tunnels to
 *   sentry-0's LCD (11317→1317) and RPC (26657); nginx serves the UI plus
 *   same-origin /api and /rpc proxies, so no CORS and no public LCD needed.
 *   The tunnel target is a {{TAILNET_IP:sentry-0}} placeholder until
 *   persist-start bakes the real IP into the env (§5 step 20b).
 * - frontend: sparkdream-ui Next.js server, env-configured at runtime; it
 *   needs the public api/rpc domains (spec.topology.publicEndpoints).
 */
export function renderComponentSdl(input: RenderComponentSdlInput): void {
  const { spec, component } = input;
  const doc =
    component.key === "explorer" ? explorerSdl(input) : frontendSdl(input);

  const pricing = { denom: PRICING_DENOM[spec.infra.akashNetwork], amount: 1000 };
  const sdl = {
    version: "2.0",
    services: { [component.key]: doc.service },
    profiles: {
      compute: { [component.key]: { resources: doc.resources } },
      placement: { dcloud: { pricing: { [component.key]: pricing } } },
    },
    deployment: { [component.key]: { dcloud: { profile: component.key, count: 1 } } },
  };
  fs.writeFileSync(input.outPath, yaml.dump(sdl, { lineWidth: 120 }));
}

function explorerSdl(input: RenderComponentSdlInput) {
  const { spec, component } = input;
  return {
    service: {
      image: component.image,
      expose: [
        // nginx: explorer UI + same-origin /api (LCD) and /rpc proxies
        { port: 80, as: 80, accept: [component.domain], proto: "tcp", to: [{ global: true }] },
        // sshd for management
        { port: 2222, as: 2222, proto: "tcp", to: [{ global: true }] },
      ],
      env: [
        `SSH_PUBLIC_KEY=${input.sshPublicKey}`,
        `HEADSCALE_URL=https://${spec.topology.headscale.domain}`,
        `TS_AUTHKEY=${input.placeholder.tsAuthkey(component.key)}`,
        `TS_HOSTNAME=${component.key}`,
        // on the persistent volume so the tailnet identity survives restarts
        "TS_STATE_DIR=/data/tailscale",
        `TS_TUNNEL_1=11317:${input.placeholder.tailnetIp("sentry-0")}:1317`,
        `TS_TUNNEL_2=26657:${input.placeholder.tailnetIp("sentry-0")}:26657`,
        // entrypoint seds these over the baked chain config; relative paths
        // hit the nginx proxies above
        "NODE_API_ENDPOINT=/api",
        "NODE_RPC_ENDPOINT=/rpc",
      ],
      params: { storage: { data: { mount: "/data", readOnly: false } } },
    },
    resources: componentResources("explorer"),
  };
}

function frontendSdl(input: RenderComponentSdlInput) {
  const { spec, component } = input;
  const pub = spec.topology.publicEndpoints;
  if (!pub?.api || !pub?.rpc) {
    throw new Error("frontend needs topology.publicEndpoints.api and .rpc — validate-spec should have caught this");
  }
  const explorer = spec.topology.components.explorer;
  const env = [
    // runtime config — read by /api/config and the UI's LCD proxy at request
    // time, so endpoint changes only need a deployment update, not a rebuild
    `CHAIN_ID=${chainId(spec)}`,
    `CHAIN_NAME=${spec.network.displayName ?? spec.network.name}`,
    `LCD_ENDPOINT=https://${pub.api}`,
    `RPC_ENDPOINT=https://${pub.rpc}`,
    `CHAIN_DENOM=${spec.token.baseDenom}`,
    `DISPLAY_DENOM=${spec.token.displayDenom}`,
    `BECH32_PREFIX=${spec.network.bech32Prefix}`,
  ];
  if (explorer.enabled && explorer.domain) {
    // ping-pub routes are /<chain-name-in-baked-config>; the explorer image
    // is built for this chain, so network.name matches
    env.push(`EXPLORER_URL=https://${explorer.domain}/${spec.network.name}`);
  }
  return {
    service: {
      image: component.image,
      expose: [{ port: 3000, as: 80, accept: [component.domain], to: [{ global: true }] }],
      env,
    },
    resources: componentResources("frontend"),
  };
}
