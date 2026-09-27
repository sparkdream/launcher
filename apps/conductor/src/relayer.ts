import fs from "node:fs";
import path from "node:path";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { stringToPath } from "@cosmjs/crypto";
import {
  chainId,
  RELAY_CHANNELS,
  relayerPaths,
  withDefaults,
  type LaunchSpec,
  type RelayerPath,
} from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, LaunchRow } from "./db.js";
import type { Tunnel } from "./components/types.js";
import { readSecretFile, writeSecretFile } from "./secrets.js";

/**
 * The relayer component: one Hermes process relaying every path in
 * topology.components.relayer. This module turns the spec into what the
 * relayer image consumes (deploy/docker/hermes/ in the chain repo): a Hermes
 * config, a path manifest for relayer-bringup, and the mesh tunnels that put
 * each Spark Dream chain's sentry-0 gRPC and RPC on the relayer's localhost.
 */

/** Where the image keeps its config, manifest, keys and channels.json. */
export const RELAYER_DIR = "/data/relayer";
/** Hermes key name on every chain (one key store per chain id). */
export const RELAYER_KEY_NAME = "relayer";
/** mnemonics.json entry holding the relayer's mnemonic, the one secret every
 *  chain's key derives from (each with its own prefix and HD path). */
export const RELAYER_ACCOUNT = "relayer";
const DEFAULT_HD_PATH = "m/44'/118'/0'/0/0";

const GRPC_PORT = 9090;
const RPC_PORT = 26657;

/** A tunnel peer in another fleet: `<component>@<launchId>`. Colon-free, so
 *  the TS_TUNNEL_n=<local>:<target>:<remote> env stays unambiguous. */
export function fleetPeer(key: string, launchId: string): string {
  return `${key}@${launchId}`;
}

export function parseFleetPeer(peer: string): { key: string; launchId?: string } {
  const at = peer.indexOf("@");
  return at < 0 ? { key: peer } : { key: peer.slice(0, at), launchId: peer.slice(at + 1) };
}

/** Distinct fleet counterparties, in path order. Their index fixes their
 *  tunnel ports, so the order must not depend on anything but the spec. */
export function relayFleets(spec: LaunchSpec): string[] {
  const out: string[] = [];
  for (const p of relayerPaths(spec)) {
    if ("fleet" in p.counterparty && !out.includes(p.counterparty.fleet)) out.push(p.counterparty.fleet);
  }
  return out;
}

/** Local ports the relayer reaches chain `i` on: 0 is this fleet's own
 *  sentry-0, 1..n the fleet counterparties in relayFleets order. */
function tunnelPorts(i: number): { grpc: number; rpc: number } {
  return { grpc: GRPC_PORT + i, rpc: RPC_PORT + i };
}

/** The relayer's mesh tunnels: gRPC + RPC on this fleet's sentry-0 and on
 *  each fleet counterparty's. Endpoint counterparties are dialed directly. */
export function relayerTunnels(spec: LaunchSpec): Tunnel[] {
  const out: Tunnel[] = [];
  const add = (i: number, peer: string) => {
    const ports = tunnelPorts(i);
    out.push({ local: ports.grpc, remote: GRPC_PORT, peer });
    out.push({ local: ports.rpc, remote: RPC_PORT, peer });
  };
  add(0, "sentry-0");
  relayFleets(spec).forEach((launchId, i) => add(i + 1, fleetPeer("sentry-0", launchId)));
  return out;
}

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

/**
 * Resolve a path's fleet reference (launch id or unique network name) to the
 * launch id, checking the other fleet is one this relayer can reach: same
 * wallet and Akash network, finished launching, and on the same mesh — its
 * sentry's gRPC is only reachable over the tailnet. Throws with a
 * user-facing message otherwise.
 */
export function resolveRelayFleet(
  db: ConductorDb,
  spec: LaunchSpec,
  owner: string,
  ref: string,
  selfId?: string,
): string {
  let target = db.getLaunch(ref);
  if (!target) {
    const matches = db.listLaunches().filter((l) => {
      if (l.status === "aborted" || l.id === selfId) return false;
      try {
        return specOf(l).network.name === ref;
      } catch {
        return false;
      }
    });
    if (matches.length > 1) {
      throw new Error(`relayer path to "${ref}" matches ${matches.length} fleets — reference the launch id instead`);
    }
    target = matches[0];
  }
  const at = `relayer path to "${ref}"`;
  if (!target) throw new Error(`${at}: no such fleet on this launcher`);
  if (target.id === selfId) throw new Error(`${at}: a fleet cannot relay to itself`);
  if (target.status === "aborted") throw new Error(`${at}: that fleet was shut down`);
  if ((target.owner ?? "") !== (owner ?? "")) {
    throw new Error(`${at}: that fleet belongs to a different wallet`);
  }
  const other = specOf(target);
  if (other.infra.akashNetwork !== spec.infra.akashNetwork) {
    throw new Error(`${at}: that fleet runs on Akash ${other.infra.akashNetwork}, this one on ${spec.infra.akashNetwork}`);
  }
  if (db.getStep(target.id, "finalize")?.status !== "done") {
    throw new Error(`${at}: that fleet has not finished launching`);
  }
  // one mesh: either fleet borrows the other's headscale, or both borrow a third's
  const meshOf = (id: string | undefined, s: LaunchSpec) => s.topology.headscale.reuseFleet ?? id;
  if (meshOf(target.id, other) !== meshOf(selfId, spec)) {
    throw new Error(
      `${at}: that fleet is on a different mesh — its sentry's gRPC is only reachable over the tailnet, ` +
        `so set topology.headscale.reuseFleet to share one mesh between the two fleets`,
    );
  }
  const sentry = db.listFleetComponents(target.id).find((c) => c.key === "sentry-0");
  if (!sentry || sentry.state === "closed") throw new Error(`${at}: that fleet has no running sentry-0`);
  return target.id;
}

/** One chain the relayer signs on. */
export interface RelayChain {
  chainId: string;
  bech32Prefix: string;
  gasDenom: string;
  gasPrice: number;
  hdPath: string;
  trustingPeriod?: string;
  rpc: string;
  grpc: string;
  ws: string;
  /** LCD, when known: lets relayer-fundcheck see whether the key's account exists. */
  lcd?: string;
  /** The launch running it, for a Spark Dream chain on this launcher. */
  launchId?: string;
}

/** Relay transactions a suggested top-up covers: weeks of light traffic. */
const TOPUP_TXS = 1_000;
/** Gas of a typical relay tx (client update + one packet). */
const RELAY_TX_GAS = 300_000;

/**
 * The most the relayer key should hold on `chain`, in its gas denom, if the
 * spec bounds it: relayer.maxBalance for a Spark Dream fleet, the path's own
 * maxBalance for a chain named by endpoints. The key sits on the relayer's
 * provider, so this is what a compromised provider can take.
 */
export function relayerCap(spec: LaunchSpec, chain: Pick<RelayChain, "chainId" | "launchId">): bigint | undefined {
  const relayer = spec.topology.components.relayer;
  if (!relayer) return undefined;
  if (chain.launchId) return BigInt(relayer.maxBalance);
  for (const p of relayer.paths) {
    const cp = p.counterparty;
    if (!("fleet" in cp) && cp.chainId === chain.chainId && cp.maxBalance) return BigInt(cp.maxBalance);
  }
  return undefined;
}

/** A top-up worth asking for: ~1000 relay txs of gas, never above the cap. */
export function suggestedTopUp(chain: Pick<RelayChain, "gasPrice">, cap: bigint | undefined): bigint {
  const gas = BigInt(Math.ceil(chain.gasPrice * RELAY_TX_GAS * TOPUP_TXS));
  return cap !== undefined && cap < gas ? cap : gas;
}

export interface RelayPlanPath {
  id: string;
  kind: RelayerPath["kind"];
  port: string;
  version: string;
  /** This fleet's chain id. */
  a: string;
  b: string;
}

export interface RelayPlan {
  /** This fleet's chain first. */
  chains: RelayChain[];
  paths: RelayPlanPath[];
}

/** A Spark Dream chain as the relayer reaches it: over its local tunnel ports. */
function sparkDreamChain(spec: LaunchSpec, index: number, launchId: string): RelayChain {
  const ports = tunnelPorts(index);
  return {
    chainId: chainId(spec),
    bech32Prefix: spec.network.bech32Prefix,
    gasDenom: spec.token.baseDenom,
    gasPrice: Number(spec.token.minGasPrice),
    hdPath: DEFAULT_HD_PATH,
    rpc: `http://127.0.0.1:${ports.rpc}`,
    grpc: `http://127.0.0.1:${ports.grpc}`,
    ws: `ws://127.0.0.1:${ports.rpc}/websocket`,
    ...(spec.topology.publicEndpoints?.api ? { lcd: `https://${spec.topology.publicEndpoints.api}` } : {}),
    launchId,
  };
}

/** Everything the relayer needs to know, resolved against the launcher's db. */
export function relayPlan(db: ConductorDb, launchId: string, spec: LaunchSpec): RelayPlan {
  const own = sparkDreamChain(spec, 0, launchId);
  const chains: RelayChain[] = [own];
  const fleets = relayFleets(spec);
  fleets.forEach((id, i) => {
    const launch = db.getLaunch(id);
    if (!launch) throw new Error(`relayer counterparty fleet ${id} is gone from this launcher`);
    chains.push(sparkDreamChain(specOf(launch), i + 1, id));
  });
  const paths: RelayPlanPath[] = [];
  for (const p of relayerPaths(spec)) {
    const cp = p.counterparty;
    let b: string;
    if ("fleet" in cp) {
      b = chains[fleets.indexOf(cp.fleet) + 1]!.chainId;
    } else {
      b = cp.chainId;
      if (!chains.some((c) => c.chainId === cp.chainId)) {
        chains.push({
          chainId: cp.chainId,
          bech32Prefix: cp.bech32Prefix,
          gasDenom: cp.gasDenom,
          gasPrice: cp.gasPrice,
          hdPath: cp.hdPath,
          ...(cp.trustingPeriod ? { trustingPeriod: cp.trustingPeriod } : {}),
          rpc: cp.rpc,
          grpc: cp.grpc,
          ws: cp.ws ?? `${cp.rpc.replace(/^http/, "ws").replace(/\/$/, "")}/websocket`,
          ...(cp.lcd ? { lcd: cp.lcd } : {}),
        });
      }
    }
    const ch = RELAY_CHANNELS[p.kind];
    paths.push({ id: p.id, kind: p.kind, port: ch.port, version: ch.version, a: own.chainId, b });
  }
  return { chains, paths };
}

/** One opened path, as relayer-bringup writes it to channels.json. */
export interface RelayChannel {
  id: string;
  port: string;
  version: string;
  a: { chain: string; client: string; connection: string; channel: string };
  b: { chain: string; client: string; connection: string; channel: string };
}

const q = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** TOML float: Hermes reads gas_price.price as f64, which an integer literal is not. */
const float = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

/**
 * The Hermes config. Before bringup the packet filter admits each path's port
 * on any channel (bringup opens channels, and must be able to); once the
 * channels are known it is pinned to exactly those, so a stranger opening a
 * transfer channel on the same connection does not get relayed on our gas.
 */
export function renderHermesConfig(plan: RelayPlan, channels?: RelayChannel[]): string {
  const out: string[] = [
    "# Rendered by the SparkDream launcher (relayer component). Edits here are",
    "# overwritten the next time the launcher links the relayer.",
    "[global]",
    "log_level = 'info'",
    "",
    "[mode.clients]",
    "enabled = true",
    "refresh = true",
    "misbehaviour = true",
    "",
    "[mode.connections]",
    "enabled = true",
    "",
    "[mode.channels]",
    "enabled = true",
    "",
    "[mode.packets]",
    "enabled = true",
    "clear_interval = 100",
    "clear_on_start = true",
    "tx_confirmation = true",
    "",
    // Hermes requires host and port on both blocks even when disabled
    "[rest]",
    "enabled = false",
    "host = '127.0.0.1'",
    "port = 3000",
    "",
    "[telemetry]",
    "enabled = false",
    "host = '127.0.0.1'",
    "port = 3001",
    "",
  ];
  for (const c of plan.chains) {
    const filter: string[] = [];
    for (const p of plan.paths) {
      if (p.a !== c.chainId && p.b !== c.chainId) continue;
      const opened = channels?.find((ch) => ch.id === p.id);
      const end = opened ? (opened.a.chain === c.chainId ? opened.a : opened.b) : undefined;
      const entry = `[${q(p.port)}, ${q(end?.channel ?? "*")}]`;
      if (!filter.includes(entry)) filter.push(entry);
    }
    out.push(
      "[[chains]]",
      `id = ${q(c.chainId)}`,
      "type = 'CosmosSdk'",
      `rpc_addr = ${q(c.rpc)}`,
      `grpc_addr = ${q(c.grpc)}`,
      `event_source = { mode = 'push', url = ${q(c.ws)}, batch_delay = '500ms' }`,
      "rpc_timeout = '20s'",
      `account_prefix = ${q(c.bech32Prefix)}`,
      `key_name = ${q(RELAYER_KEY_NAME)}`,
      `key_store_folder = ${q(`${RELAYER_DIR}/keys`)}`,
      "address_type = { derivation = 'cosmos' }",
      "store_prefix = 'ibc'",
      "default_gas = 200000",
      "max_gas = 4000000",
      `gas_price = { price = ${float(c.gasPrice)}, denom = ${q(c.gasDenom)} }`,
      // 1.5 runs out creating a client on these chains (see deploy/relayer)
      "gas_multiplier = 2.5",
      "max_msg_num = 30",
      "max_tx_size = 180000",
      "clock_drift = '10s'",
      "max_block_time = '30s'",
      ...(c.trustingPeriod ? [`trusting_period = ${q(c.trustingPeriod)}`] : []),
      "trust_threshold = { numerator = '2', denominator = '3' }",
      "memo_prefix = 'sparkdream-launcher'",
      "",
      "[chains.packet_filter]",
      "policy = 'allow'",
      `list = [${filter.join(", ")}]`,
      "",
    );
  }
  return out.join("\n");
}

/** relayer-bringup's path manifest ($RELAYER_DIR/relayer.json). */
export function renderRelayManifest(plan: RelayPlan): string {
  return JSON.stringify(
    {
      chains: plan.chains.map((c) => ({ id: c.chainId, hd_path: c.hdPath, ...(c.lcd ? { lcd: c.lcd } : {}) })),
      paths: plan.paths.map((p) => ({ id: p.id, a: p.a, b: p.b, port: p.port, version: p.version, order: "unordered" })),
    },
    null,
    2,
  );
}

/**
 * The relayer's mnemonic, generated into secrets/mnemonics.json (beside the
 * fleet's other generated accounts, so it is exported and revealed the same
 * way) the first time anything asks for it.
 */
export async function ensureRelayerMnemonic(secretsDir: string): Promise<string> {
  const file = path.join(secretsDir, "mnemonics.json");
  const all: Record<string, string> = fs.existsSync(file) ? JSON.parse(readSecretFile(file)) : {};
  if (!all[RELAYER_ACCOUNT]) {
    all[RELAYER_ACCOUNT] = (await Secp256k1HdWallet.generate(24)).mnemonic;
    writeSecretFile(file, JSON.stringify(all, null, 2));
  }
  return all[RELAYER_ACCOUNT]!;
}

/** The relayer's address on a chain (same mnemonic everywhere). */
export async function relayerAddress(mnemonic: string, chain: Pick<RelayChain, "bech32Prefix" | "hdPath">): Promise<string> {
  const wallet = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: chain.bech32Prefix,
    hdPaths: [stringToPath(chain.hdPath)],
  });
  const [account] = await wallet.getAccounts();
  return account!.address;
}

/** Fleets whose relayer dials this launch's sentry-0, so it must keep serving
 *  gRPC even though its own spec asks for none. */
export function relayedBy(db: ConductorDb, launchId: string): string[] {
  return db
    .listLaunches()
    .filter((l) => {
      if (l.id === launchId || l.status === "aborted") return false;
      try {
        return relayFleets(specOf(l)).includes(launchId);
      } catch {
        return false;
      }
    })
    .map((l) => l.id);
}

/** A tunnel peer's fleet row: own-fleet keys from this launch, `key@launch`
 *  from that launch. */
export function peerRow(db: ConductorDb, launchId: string, peer: string): FleetComponentRow | undefined {
  const { key, launchId: other } = parseFleetPeer(peer);
  return (db.listFleetComponents(other ?? launchId) as FleetComponentRow[]).find((c) => c.key === key);
}
