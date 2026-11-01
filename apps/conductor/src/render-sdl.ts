import fs from "node:fs";
import yaml from "js-yaml";
import {
  headscaleDomain,
  tunnelPort,
  nodeResources,
  type LaunchSpec,
  type NodeRef,
  type Topology,
} from "@sparkdream/launch-spec";
import { VAL_PEER_TUNNEL_PORT } from "./node-ops.js";
import { networkSdlPath } from "./vendor.js";

/** Akash pricing denom per target network (§12.7: repo SDLs price in uact). */
export const PRICING_DENOM: Record<LaunchSpec["infra"]["akashNetwork"], string> = {
  mainnet: "uact",
  sandbox: "uakt",
};

export interface RenderSdlInput {
  spec: LaunchSpec;
  node: NodeRef;
  topology: Topology;
  sshPublicKey: string;
  outPath: string;
  placeholder: {
    tailnetIp: (nodeKey: string) => string;
    tsAuthkey: (nodeKey: string) => string;
  };
}

function setEnv(env: string[], key: string, value: string): void {
  const line = `${key}=${value}`;
  const i = env.findIndex((e) => e.startsWith(`${key}=`));
  if (i >= 0) env[i] = line;
  else env.push(line);
}

/**
 * Environment every node runs with whatever its template says. Go 1.24+
 * opens listeners as MPTCP by default, and CVE-2026-98432 (IPv4 TCP
 * handshake use-after-free, unpatched on the providers' Ubuntu kernels as
 * of 2026-11-01) was shown as remote root against MPTCP listeners. A
 * sentry's P2P/RPC/LCD/gRPC ports reach sparkdreamd directly through
 * forwarded ports, so it listens on plain TCP. Only the provider's kernel
 * update fixes the bug itself.
 */
export const NODE_ENV: Record<string, string> = { GODEBUG: "multipathtcp=0" };

/**
 * Bring a deployed node SDL's env up to NODE_ENV, so an upgrade delivers
 * it to nodes rendered before it existed. Returns whether anything changed.
 */
export function applyNodeEnv(doc: any): boolean {
  const svc = doc.services?.sparkdreamd;
  if (!svc) return false;
  const env: string[] = svc.env ?? [];
  const before = env.join("\n");
  for (const [k, v] of Object.entries(NODE_ENV)) setEnv(env, k, v);
  svc.env = env;
  return env.join("\n") !== before;
}

/**
 * Render one node's SDL from the vendored per-network template (§5 step 6).
 * TS_AUTHKEY and tunnel target IPs stay placeholders until Phases C/E.
 */
export function renderNodeSdl(input: RenderSdlInput): void {
  const { spec, node, topology, outPath } = input;
  const doc = yaml.load(
    fs.readFileSync(networkSdlPath(spec.network.type, node.role), "utf8"),
  ) as any;

  const svc = doc.services?.sparkdreamd;
  if (!svc) throw new Error("vendored SDL has no services.sparkdreamd");

  svc.image = spec.images.sparkdreamd;
  const env: string[] = svc.env ?? [];
  setEnv(env, "SSH_PUBLIC_KEY", input.sshPublicKey);
  setEnv(env, "HEADSCALE_URL", `https://${headscaleDomain(spec)}`);
  setEnv(env, "TS_AUTHKEY", input.placeholder.tsAuthkey(node.key));
  setEnv(env, "TS_HOSTNAME", node.key);
  setEnv(env, "WAIT_FOR_CONFIG", "true");
  for (const [k, v] of Object.entries(NODE_ENV)) setEnv(env, k, v);

  if (node.role === "sentry") {
    // Template ships one example tunnel; emit one per fronted validator.
    svc.env = env.filter((e: string) => !e.startsWith("TS_TUNNEL_"));
    const fronted = topology.sentryValidators[node.index] ?? [];
    fronted.forEach((v, i) => {
      svc.env.push(
        `TS_TUNNEL_${i + 1}=${tunnelPort(v)}:${input.placeholder.tailnetIp(`val-${v}`)}:26656`,
      );
    });
  } else {
    // The validator dials its first sentry too, through a local proxy
    // (userspace tailscale cannot dial a tailnet IP from a normal socket).
    // With only the sentry dialing in, a link that drops while the
    // validator is down waits out the sentry's exponential redial backoff,
    // hours after the validator is back.
    svc.env = env.filter((e: string) => !e.startsWith("TS_TUNNEL_"));
    const s = topology.validatorSentries[node.index]?.[0];
    if (s !== undefined) {
      svc.env.push(
        `TS_TUNNEL_PEER=${VAL_PEER_TUNNEL_PORT}:${input.placeholder.tailnetIp(`sentry-${s}`)}:26656`,
      );
    }
  }

  // Public chain endpoints (§4 topology.publicEndpoints): sentry-0 serves
  // LCD/RPC on accept-domain ingress — the exact shape running on the
  // manual testnet (prod SDLs, verified live). The rpc accept rides the
  // EXISTING 26657 expose so `global: true` keeps allocating the random
  // forwarded port the health probes and verify-chain depend on.
  if (node.role === "sentry" && node.index === 0) {
    const pub = spec.topology.publicEndpoints;
    if (pub?.api) {
      svc.expose.push({
        port: 1317,
        as: 1317,
        accept: [pub.api],
        proto: "tcp",
        to: [{ global: true }],
      });
    }
    if (pub?.rpc) {
      const rpc = (svc.expose as any[]).find((e) => e.port === 26657);
      if (!rpc) throw new Error("vendored sentry SDL has no 26657 expose");
      rpc.accept = [pub.rpc];
    }
  }

  const resources = doc.profiles?.compute?.sparkdreamd?.resources;
  if (!resources) throw new Error("vendored SDL has no compute profile resources");
  const roleRes = nodeResources(spec, node.key);
  resources.cpu = { units: roleRes.cpu };
  resources.memory = { size: roleRes.memory };
  resources.storage = [
    { size: roleRes.storage.root },
    {
      name: "data",
      size: roleRes.storage.data,
      attributes: { persistent: roleRes.storage.persistent, class: roleRes.storage.class },
    },
  ];

  const pricing = doc.profiles?.placement?.dcloud?.pricing?.sparkdreamd;
  if (pricing) pricing.denom = PRICING_DENOM[spec.infra.akashNetwork];

  fs.writeFileSync(outPath, yaml.dump(doc, { lineWidth: 120 }));
}
