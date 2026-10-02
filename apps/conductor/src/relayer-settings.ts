import { chainId, isServicesFleet, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import type { RpcProber } from "./services.js";
import { founderAccount, SPARK_DREAM_CONTENT_TYPES, sparkDreamPeerPolicy } from "./peering.js";
import { resolveRelayFleet, sameMesh } from "./relayer.js";
import { mayUseFleet } from "./bridge-target.js";

/**
 * What the relayer settings editor offers: the sister chains on this
 * launcher a path could lead to (and how the relayer would reach each), a
 * short list of well-known chains for token transfers, the peer policy a
 * federation path starts with, and a probe that fills in a chain's details
 * from its endpoints.
 */

/** Endpoint counterparty fields, as a path's `counterparty` takes them. */
export interface EndpointChain {
  chainId: string;
  rpc: string;
  grpc: string;
  lcd?: string;
  bech32Prefix: string;
  gasDenom: string;
  gasPrice: number;
  dynamicGasPrice?: { multiplier: number; max: number };
  maxBalance?: string;
}

export interface ChainPreset {
  /** Suggested path id. */
  id: string;
  label: string;
  /** Real money pays this chain's gas: the editor opens it only once funded. */
  paid: boolean;
  /** The gas token's display symbol and decimals, for the cap field. */
  symbol: string;
  counterparty: EndpointChain;
}

/**
 * Well-known chains for transfer paths, with endpoints checked live on
 * 2026-10-01 (status, bech32 prefix, minimum gas price). Public endpoints
 * come and go: the editor shows every field, so a stale one is edited, not
 * a dead end.
 */
export const CHAIN_PRESETS: ChainPreset[] = [
  {
    id: "osmosis-testnet",
    label: "Osmosis testnet",
    paid: false,
    symbol: "OSMO",
    counterparty: {
      chainId: "osmo-test-5",
      rpc: "https://rpc.osmotest5.osmosis.zone",
      grpc: "https://grpc.osmotest5.osmosis.zone:443",
      lcd: "https://lcd.osmotest5.osmosis.zone",
      bech32Prefix: "osmo",
      gasDenom: "uosmo",
      gasPrice: 0.05,
      dynamicGasPrice: { multiplier: 1.1, max: 0.1 },
      maxBalance: "10000000",
    },
  },
  {
    id: "osmosis",
    label: "Osmosis",
    paid: true,
    symbol: "OSMO",
    counterparty: {
      chainId: "osmosis-1",
      rpc: "https://rpc.osmosis.zone",
      grpc: "https://grpc.osmosis.zone:443",
      lcd: "https://lcd.osmosis.zone",
      bech32Prefix: "osmo",
      gasDenom: "uosmo",
      gasPrice: 0.05,
      dynamicGasPrice: { multiplier: 1.1, max: 0.2 },
      maxBalance: "5000000",
    },
  },
  {
    id: "cosmoshub",
    label: "Cosmos Hub",
    paid: true,
    symbol: "ATOM",
    counterparty: {
      chainId: "cosmoshub-4",
      rpc: "https://cosmos-rpc.publicnode.com",
      grpc: "https://cosmos-grpc.publicnode.com:443",
      lcd: "https://cosmos-rest.publicnode.com",
      bech32Prefix: "cosmos",
      gasDenom: "uatom",
      gasPrice: 0.005,
      // x/feemarket: follow the base fee, never above 10x the floor
      dynamicGasPrice: { multiplier: 1.1, max: 0.05 },
      maxBalance: "5000000",
    },
  },
  {
    id: "noble",
    label: "Noble",
    paid: true,
    symbol: "USDC",
    counterparty: {
      chainId: "noble-1",
      rpc: "https://noble-rpc.polkachu.com",
      grpc: "http://noble-grpc.polkachu.com:21590",
      lcd: "https://rest.lavenderfive.com:443/noble",
      bech32Prefix: "noble",
      gasDenom: "uusdc",
      gasPrice: 0.1,
      maxBalance: "5000000",
    },
  },
];

/** A fleet on this launcher a path could lead to, and why it cannot when it cannot. */
export interface SisterFleet {
  launchId: string;
  name: string;
  displayName: string;
  chainId: string;
  networkType: string;
  /** mesh: tunnelled over the shared tailnet; public: over its sentry's
   *  forwarded ports, which the first link opens (one signature). */
  route: "mesh" | "public";
  eligible: boolean;
  reason?: string;
  /** The launcher holds its founder key, so it can sign that chain's end of
   *  a federation peer too. */
  founderHeld: boolean;
  /** Its wallet, when not this fleet's: that wallet signs opening its gRPC. */
  otherWallet?: string;
}

export function sisterFleets(db: ConductorDb, launchId: string, owner: string): SisterFleet[] {
  const self = db.getLaunch(launchId);
  if (!self) return [];
  const spec = withDefaults(JSON.parse(self.spec_json));
  const out: SisterFleet[] = [];
  for (const l of db.listLaunches()) {
    // another wallet's fleet only once it shares with this one: on a
    // launcher with sign-in, other owners' fleets are not this owner's to see
    if (l.id === launchId || l.status === "aborted" || !mayUseFleet(l, owner)) continue;
    let other: LaunchSpec;
    try {
      other = withDefaults(JSON.parse(l.spec_json));
    } catch {
      continue;
    }
    if (isServicesFleet(other)) continue;
    let reason: string | undefined;
    try {
      resolveRelayFleet(db, spec, owner, l.id, launchId);
    } catch (e) {
      // the resolver's message names the path; the picker names the fleet
      reason = String(e instanceof Error ? e.message : e).replace(/^relayer path to "[^"]*": /, "");
    }
    out.push({
      launchId: l.id,
      name: other.network.name,
      displayName: other.network.displayName ?? other.network.name,
      chainId: chainId(other),
      networkType: other.network.type,
      route: sameMesh(db, spec, launchId, l.id) ? "mesh" : "public",
      eligible: reason === undefined,
      ...(reason ? { reason } : {}),
      founderHeld: founderAccount(other) !== undefined,
      ...((l.owner ?? "") !== (owner ?? "") ? { otherWallet: l.owner } : {}),
    });
  }
  return out;
}

/** The policy a federation peer starts with, for the editor to show. The
 *  launcher sets it only when none was ever set; after that it is the
 *  community's (the frontend's peer policy form). */
export function defaultPeerPolicySummary(): {
  contentTypes: string[];
  ratePerEpoch: number;
  reputation: boolean;
  requireReview: boolean;
  policy: Record<string, unknown>;
} {
  const policy = sparkDreamPeerPolicy();
  return {
    contentTypes: [...SPARK_DREAM_CONTENT_TYPES],
    ratePerEpoch: Number(policy.inbound_rate_limit_per_epoch),
    reputation: Boolean(policy.allow_reputation_queries),
    requireReview: Boolean(policy.require_review),
    policy,
  };
}

/** What a chain's endpoints say about it. Fields stay unset when the
 *  endpoint that would tell is missing or silent. */
export interface DetectedChain {
  chainId: string;
  bech32Prefix?: string;
  gasDenom?: string;
  gasPrice?: number;
  /** Serves x/federation: a Spark Dream chain a federation path can lead to. */
  federation: boolean;
  /** Its x/identity record, when it has one. */
  identity?: string;
  notes: string[];
}

const trim = (u: string) => u.replace(/\/+$/, "");

/** Lowest-priced entry of a minimum_gas_price list ("0.005uatom,0.01ibc/..."):
 *  native denoms first, since a relayer key holds the chain's own token. */
export function parseMinGasPrice(raw: string): { denom: string; price: number } | undefined {
  const entries = raw
    .split(",")
    .map((e) => /^([0-9.]+)([a-zA-Z][a-zA-Z0-9/._-]*)$/.exec(e.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ denom: m[2]!, price: Number(m[1]) }));
  return entries.find((e) => !e.denom.startsWith("ibc/")) ?? entries[0];
}

/**
 * Probe a chain from its endpoints: the RPC names the chain, and the LCD (when
 * given) its address prefix, minimum gas price, and whether it runs
 * x/federation and x/identity. Read-only HTTP GETs, through the launcher's
 * RPC prober so tests can answer them.
 */
export async function detectChain(rpcProber: RpcProber, rpc: string, lcd?: string): Promise<DetectedChain> {
  let status: any;
  try {
    status = JSON.parse(await rpcProber.getText(`${trim(rpc)}/status`));
  } catch (e) {
    throw new Error(`the RPC did not answer /status (${String(e instanceof Error ? e.message : e).slice(0, 120)})`);
  }
  const id = status?.result?.node_info?.network;
  if (typeof id !== "string" || !id) throw new Error("the RPC's /status names no chain");
  const out: DetectedChain = { chainId: id, federation: false, notes: [] };
  if (!lcd) {
    out.notes.push("no LCD given: enter the address prefix and gas price by hand");
    return out;
  }
  const get = async (route: string): Promise<any | undefined> => {
    try {
      return JSON.parse(await rpcProber.getText(`${trim(lcd)}${route}`));
    } catch {
      return undefined;
    }
  };
  const [bech32, config, federation, identity] = await Promise.all([
    get("/cosmos/auth/v1beta1/bech32"),
    get("/cosmos/base/node/v1beta1/config"),
    get("/sparkdream/federation/v1/params"),
    get("/sparkdream/identity/v1/chain-identity"),
  ]);
  if (typeof bech32?.bech32_prefix === "string") out.bech32Prefix = bech32.bech32_prefix;
  else out.notes.push("the LCD did not report an address prefix");
  const gas = typeof config?.minimum_gas_price === "string" ? parseMinGasPrice(config.minimum_gas_price) : undefined;
  if (gas) {
    out.gasDenom = gas.denom;
    out.gasPrice = gas.price;
  } else {
    out.notes.push("the node sets no minimum gas price: check the chain's docs for its fee token and price");
  }
  out.federation = Boolean(federation?.params);
  const name = identity?.identity?.chain_human_name;
  if (typeof name === "string") out.identity = name;
  return out;
}
