import fs from "node:fs";
import yaml from "js-yaml";
import {
  tunnelPort,
  type LaunchSpec,
  type NodeRef,
  type Topology,
} from "@sparkdream/launch-spec";
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
  setEnv(env, "HEADSCALE_URL", `https://${spec.topology.headscale.domain}`);
  setEnv(env, "TS_AUTHKEY", input.placeholder.tsAuthkey(node.key));
  setEnv(env, "TS_HOSTNAME", node.key);
  setEnv(env, "WAIT_FOR_CONFIG", "true");

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
    svc.env = env;
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
  const roleRes = spec.infra.resources[node.role];
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
