import { headscaleDomain } from "@sparkdream/launch-spec";
import { relayerTunnels } from "../relayer.js";
import { linkFederationPeers, linkRelayer } from "../steps/relayer-link.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

const resources: SdlResources = {
  cpu: { units: 0.5 },
  memory: { size: "1Gi" },
  storage: [
    { size: "1Gi" },
    // Hermes' key store, config and channels.json, plus the tailnet identity
    { name: "data", size: "1Gi", attributes: { persistent: true, class: "beta3" } },
  ],
};

/**
 * Hermes (the chain repo's Dockerfile-hermes). No public port but SSH: the
 * launcher uploads the config and path manifest over it and runs
 * relayer-bringup; the image's relayer-run then execs `hermes start` and
 * keeps doing so across restarts. Each Spark Dream chain it relays is
 * reached through a mesh tunnel to that fleet's sentry-0 (gRPC + RPC on
 * localhost); endpoint counterparties are dialed directly.
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  const target = (peer: string) =>
    (peer.includes("@") ? input.peerTailnetIp?.(peer) : undefined) ?? input.placeholder.tailnetIp(peer);
  return {
    relayer: {
      service: {
        image: component.image,
        expose: [{ port: 2222, as: 2222, proto: "tcp", to: [{ global: true }] }],
        env: [
          `SSH_PUBLIC_KEY=${input.sshPublicKey}`,
          `HEADSCALE_URL=https://${headscaleDomain(spec)}`,
          `TS_AUTHKEY=${input.placeholder.tsAuthkey(component.key)}`,
          `TS_HOSTNAME=${component.key}`,
          "TS_STATE_DIR=/data/tailscale",
          ...relayerTunnels(spec).map((t, i) => `TS_TUNNEL_${i + 1}=${t.local}:${target(t.peer)}:${t.remote}`),
        ],
        params: { storage: { data: { mount: "/data", readOnly: false } } },
      },
      resources,
    },
  };
}

export const relayer: ComponentDescriptor = {
  key: "relayer",
  render,
  resources: () => [resources],
  imageServices: ["relayer"],
  shellService: "relayer",
  tunnels: relayerTunnels,
  // its chain identities live in the Hermes config the link step uploads
  envRefresh: "none",
  // hermes is PID-supervised by relayer-run only once linked: before that the
  // container idles on purpose, after it a missing hermes is a real fault
  probe: {
    command: "pgrep -x hermes >/dev/null && echo relaying || (test -f /data/relayer/ready && echo down || echo unlinked)",
    verdict(stdout) {
      const state = stdout.trim().split("\n").pop() ?? "";
      if (state === "relaying") return { healthy: true, detail: "hermes relaying" };
      if (state === "unlinked") return { healthy: true, detail: "not linked yet (relink)" };
      return { healthy: false, detail: "linked but hermes is not running" };
    },
  },
  // a fresh volume has no config, keys or ready marker: link it again
  // (bringup reuses the channels already open, so this is cheap)
  configureSteps: (name, spec) => [
    { name: name("link-relayer"), run: (ctx) => linkRelayer(ctx, name("link-relayer"), spec) },
    // federation paths only: already-active peers are a few queries
    { name: name("link-peers"), run: (ctx) => linkFederationPeers(ctx, name("link-peers"), spec) },
  ],
};
