import fs from "node:fs";
import path from "node:path";
import {
  chainId,
  tunnelPort,
  type LaunchSpec,
  type NodeRef,
  type Topology,
} from "@sparkdream/launch-spec";
import { templatePath } from "./vendor.js";

export interface RenderConfigsInput {
  spec: LaunchSpec;
  node: NodeRef;
  home: string;
  nodeIds: Record<string, string>;
  topology: Topology;
  /** Marker for tailnet IPs unknown until Phase E (§5 step 4). */
  tailnetIpPlaceholder: (nodeKey: string) => string;
}

/** envsubst for the template's ${VAR} references. Unknown vars throw. */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`template var ${name} not provided`);
    return v;
  });
}

/** Replace a whole `key = value` TOML line (first occurrence). */
function setTomlLine(content: string, key: string, rendered: string): string {
  const re = new RegExp(`^${key} = .*$`, "m");
  if (!re.test(content)) throw new Error(`expected "${key} = ..." line in template`);
  return content.replace(re, rendered);
}

/**
 * Render config.toml / app.toml / client.toml for one node from the
 * vendored role templates (§5 step 4). Peer wiring:
 *  - sentry → validator via local socat tunnel (127.0.0.1:16656+v)
 *  - validator → sentry at its tailnet IP (placeholder until Phase E)
 */
export function renderNodeConfigs(input: RenderConfigsInput): void {
  const { spec, node, home, nodeIds, topology } = input;
  const role = node.role;
  const configDir = path.join(home, "config");

  const vars: Record<string, string> = {
    CHAIN_ID: chainId(spec),
    MIN_GAS_PRICES: `${spec.token.minGasPrice}${spec.token.baseDenom}`,
    SNAPSHOT_INTERVAL: String(spec.infra.sentrySettings.snapshotInterval),
    SNAPSHOT_KEEP_RECENT: String(spec.infra.sentrySettings.snapshotKeepRecent),
    // Peer vars are replaced whole-line below (templates hold a single peer
    // slot; topologies can need several) — placeholders keep substitute() happy.
    VALIDATOR_NODE_ID: "",
    VALIDATOR_HOST: "",
    VALIDATOR_PORT: "",
    SENTRY_NODE_ID: "",
    SENTRY_HOST: "",
    SENTRY_PORT: "",
  };

  // --- config.toml ---
  let config = substitute(fs.readFileSync(templatePath(`config.toml.${role}`), "utf8"), vars);
  config = setTomlLine(config, "moniker", `moniker = "${node.moniker}"`);

  if (role === "sentry") {
    const fronted = topology.sentryValidators[node.index] ?? [];
    const peers = fronted
      .map((v) => `${nodeIds[`val-${v}`]}@127.0.0.1:${tunnelPort(v)}`)
      .join(",");
    const privateIds = fronted.map((v) => nodeIds[`val-${v}`]).join(",");
    config = setTomlLine(config, "persistent_peers", `persistent_peers = "${peers}"`);
    config = setTomlLine(config, "private_peer_ids", `private_peer_ids = "${privateIds}"`);
  } else {
    const sentries = topology.validatorSentries[node.index] ?? [];
    const peers = sentries
      .map(
        (s) =>
          `${nodeIds[`sentry-${s}`]}@${input.tailnetIpPlaceholder(`sentry-${s}`)}:26656`,
      )
      .join(",");
    config = setTomlLine(config, "persistent_peers", `persistent_peers = "${peers}"`);
  }

  const timeoutCommit = spec.chainParams.consensus?.timeoutCommit;
  if (timeoutCommit) {
    config = setTomlLine(config, "timeout_commit", `timeout_commit = "${timeoutCommit}"`);
  }
  fs.writeFileSync(path.join(configDir, "config.toml"), config);

  // --- app.toml ---
  let app = substitute(fs.readFileSync(templatePath(`app.toml.${role}`), "utf8"), vars);
  // "default" means keep the template's role default (sentry template prunes
  // "everything" deliberately); only explicit choices override.
  if (role === "sentry" && spec.infra.sentrySettings.pruning !== "default") {
    app = setTomlLine(app, "pruning", `pruning = "${spec.infra.sentrySettings.pruning}"`);
  }
  fs.writeFileSync(path.join(configDir, "app.toml"), app);

  // --- client.toml ---
  const client = substitute(fs.readFileSync(templatePath(`client.toml.${role}`), "utf8"), vars);
  fs.writeFileSync(path.join(configDir, "client.toml"), client);
}
