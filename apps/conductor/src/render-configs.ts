import fs from "node:fs";
import path from "node:path";
import {
  chainId,
  lcdRequired,
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
  /**
   * Join mode (§5 "Join mode"): sentries additionally peer with the
   * network's public sentries; every node (sentries AND validators) boots
   * with [statesync] wired to the resolved trust anchor. Validators still
   * peer only with their own sentries over the pair's own mesh — which is
   * exactly why they must state-sync too: a state-synced sentry's
   * blockstore starts near chain head, so it can never serve a validator
   * trying to block-sync from height 0.
   */
  join?: {
    peers: string[];
    stateSync: { rpcServers: string[]; trustHeight: number; trustHash: string };
  };
}

/** envsubst for the template's ${VAR} references. Unknown vars throw. */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`template var ${name} not provided`);
    return v;
  });
}

/**
 * Replace a whole `key = value` TOML line (first occurrence). With a
 * section, the match is anchored inside that `[section]` block, so a
 * vendor-synced template growing an earlier line with the same key (TOML
 * reuses names like `enable` across sections) cannot redirect the edit.
 */
function setTomlLine(content: string, key: string, rendered: string, section?: string): string {
  const lineRe = new RegExp(`^${key} = .*$`, "m");
  let start = 0;
  let end = content.length;
  if (section) {
    const header = new RegExp(`^\\[${section}\\]$`, "m").exec(content);
    if (!header) throw new Error(`expected [${section}] section in template`);
    start = header.index + header[0].length;
    const next = /^\[[^\]]+\]$/m.exec(content.slice(start));
    if (next) end = start + next.index;
  }
  const scope = content.slice(start, end);
  if (!lineRe.test(scope)) {
    throw new Error(
      `expected "${key} = ..." line in template${section ? ` section [${section}]` : ""}`,
    );
  }
  return content.slice(0, start) + scope.replace(lineRe, rendered) + content.slice(end);
}

/** Replace an exact string, asserting it appears exactly once. */
function replaceOnce(content: string, from: string, to: string): string {
  const first = content.indexOf(from);
  if (first < 0 || content.includes(from, first + from.length)) {
    throw new Error(`expected exactly one "${from}" in template`);
  }
  return content.replace(from, to);
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
      .concat(input.join?.peers ?? [])
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

  if (input.join) {
    // every node syncs from the live chain instead of replaying from
    // genesis. start-chain re-resolves the anchor right before boot (a
    // launch can pause on signatures for days) — these are the initial values.
    const ss = input.join.stateSync;
    config = setTomlLine(config, "enable", "enable = true", "statesync");
    config = setTomlLine(config, "rpc_servers", `rpc_servers = "${ss.rpcServers.join(",")}"`, "statesync");
    config = setTomlLine(config, "trust_height", `trust_height = ${ss.trustHeight}`, "statesync");
    config = setTomlLine(config, "trust_hash", `trust_hash = "${ss.trustHash}"`, "statesync");
  }

  const timeoutCommit = spec.chainParams.consensus?.timeoutCommit;
  if (timeoutCommit) {
    config = setTomlLine(config, "timeout_commit", `timeout_commit = "${timeoutCommit}"`);
  }
  // softsign signs with the uploaded priv_validator_key.json — the
  // validator template's socket privval (tmkms keepalive at 26660) would
  // make the node block forever waiting for a signer that never connects
  if (role === "validator" && spec.security.keyMode === "softsign") {
    config = setTomlLine(config, "priv_validator_laddr", 'priv_validator_laddr = ""');
  }
  fs.writeFileSync(path.join(configDir, "config.toml"), config);

  // --- app.toml ---
  let app = substitute(fs.readFileSync(templatePath(`app.toml.${role}`), "utf8"), vars);
  // The spec's pruning value is authoritative. The vendored sentry template
  // ships pruning="everything", which sparkdreamd refuses to combine with
  // the snapshot settings templated above ("cannot enable state sync
  // snapshots with 'everything' pruning") — so "default" must be WRITTEN,
  // not treated as keep-template.
  if (role === "sentry") {
    app = setTomlLine(app, "pruning", `pruning = "${spec.infra.sentrySettings.pruning}"`);
    // The template ships the LCD off and bound to localhost. The explorer
    // (tailnet tunnel to 1317) and the public api domain (ingress → pod
    // 1317) both need it on and reachable from outside the container.
    if (lcdRequired(spec)) {
      app = replaceOnce(app, "enable = false", "enable = true");
      app = replaceOnce(
        app,
        'address = "tcp://localhost:1317"',
        'address = "tcp://0.0.0.0:1317"',
      );
      // Keplr fetches balances straight from the browser against the public
      // api domain, so the LCD must answer with CORS headers (the RPC side
      // already ships cors_allowed_origins = ["*"] in config.toml.sentry).
      app = replaceOnce(
        app,
        "enabled-unsafe-cors = false",
        "enabled-unsafe-cors = true",
      );
    }
  }
  fs.writeFileSync(path.join(configDir, "app.toml"), app);

  // --- client.toml ---
  const client = substitute(fs.readFileSync(templatePath(`client.toml.${role}`), "utf8"), vars);
  fs.writeFileSync(path.join(configDir, "client.toml"), client);
}
