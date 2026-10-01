import fs from "node:fs";
import path from "node:path";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { stringToPath } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";
import { withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb } from "./db.js";
import type { RpcProber } from "./services.js";
import { readSecretFile } from "./secrets.js";
import { RELAYER_ACCOUNT, RELAY_TX_GAS, relayPlan, relayerAddress, relayerCap, suggestedTopUp, type RelayChain } from "./relayer.js";

/**
 * The relayer's money, chain by chain: where each key is, what it holds,
 * whether that is enough, and the ways to change it (a top-up the user's
 * wallet sends, a withdrawal back out). Every key derives from the one
 * relayer mnemonic in the fleet's secrets, so a relayer on another fleet has
 * other addresses, and a relaunched one keeps these.
 */

/** Relay transactions a balance must still cover before it reads as low. */
const LOW_TXS = 50;
/** Gas of a plain bank send (top-up or withdrawal). */
export const SEND_GAS = 120_000;
/** What a zero-gas-price chain gets asked for: its key needs an account and a
 *  balance above zero, not gas money. One whole token at 6 decimals. */
const FREE_GAS_TOPUP = 1_000_000n;

/** How the launcher UI's Keplr can send to a key: a launcher fleet's chain
 *  (suggested to Keplr from its public endpoints) or a chain Keplr already
 *  knows by id (Osmosis, the Hub, ...). */
export type KeplrRoute =
  | {
      kind: "fleet";
      chain: {
        chainId: string;
        chainName: string;
        rpc: string;
        rest?: string;
        bech32Prefix: string;
        denom: string;
        displayDenom: string;
        decimals: number;
        gasPrice: number;
      };
    }
  | { kind: "native"; chainId: string; rpc: string; gasPrice: number };

/** One relayer key to fund: also what a funding pause carries, one per chain. */
export interface FundingRequest {
  chainId: string;
  address: string;
  denom: string;
  displayDenom: string;
  decimals: number;
  /** Suggested top-up, base units. */
  amount: string;
  cap?: string;
  /** The key's balance when this was built, when it could be read. */
  balance?: string;
  /** Absent when the UI cannot send from Keplr (no public RPC known). */
  keplr?: KeplrRoute;
}

export type FundStatus = "ok" | "low" | "empty" | "over-cap" | "unknown";

export interface RelayerFunds extends FundingRequest {
  status: FundStatus;
  /** Why the balance is unknown, when it is. */
  error?: string;
  /** Paths to this chain that are configured but unopened (openWhenFunded). */
  waiting: boolean;
  /** A launcher fleet's chain (own or counterparty), vs one named by endpoints. */
  launchId?: string;
}

/** The relayer's mnemonic, when the fleet has one (never creates it). */
export function readRelayerMnemonic(secretsDir: string): string | undefined {
  const file = path.join(secretsDir, "mnemonics.json");
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(readSecretFile(file)) as Record<string, string>)[RELAYER_ACCOUNT];
}

/** Gas price a send or relay pays: the fee market's ceiling when there is one. */
function sendPrice(c: Pick<RelayChain, "gasPrice" | "dynamicGasPrice">): number {
  return Math.max(c.gasPrice, c.dynamicGasPrice?.max ?? 0);
}

/** What to ask for: ~1000 relays of gas under the cap; on a free-gas chain,
 *  enough to have an account. */
export function fundAmount(c: Pick<RelayChain, "gasPrice" | "dynamicGasPrice">, cap: bigint | undefined): bigint {
  const gas = suggestedTopUp(c, cap);
  if (gas > 0n) return gas;
  return cap !== undefined && cap < FREE_GAS_TOPUP ? cap : FREE_GAS_TOPUP;
}

/** Below this the key runs out within a few dozen relays (on a free-gas
 *  chain: nothing left at all, which fundcheck treats as unfunded). */
export function lowWater(c: Pick<RelayChain, "gasPrice" | "dynamicGasPrice">): bigint {
  const gas = BigInt(Math.ceil(sendPrice(c) * RELAY_TX_GAS * LOW_TXS));
  return gas > 0n ? gas : 1n;
}

export function fundStatus(balance: bigint, c: Pick<RelayChain, "gasPrice" | "dynamicGasPrice">, cap?: bigint): FundStatus {
  if (balance === 0n) return "empty";
  if (balance < lowWater(c)) return "low";
  if (cap !== undefined && balance > cap) return "over-cap";
  return "ok";
}

/** Display unit for a denom outside the launcher's own chains: uosmo → OSMO. */
function displayOf(denom: string): { displayDenom: string; decimals: number } {
  if (/^u[a-z]+$/.test(denom)) return { displayDenom: denom.slice(1).toUpperCase(), decimals: 6 };
  return { displayDenom: denom, decimals: 0 };
}

/** The launcher owner's own address on another chain: same key, that chain's
 *  prefix (every chain here uses coin type 118, as Akash does). The default
 *  destination for a withdrawal. */
export function ownerAddressOn(owner: string, prefix: string): string | undefined {
  try {
    return toBech32(prefix, fromBech32(owner).data);
  } catch {
    return undefined;
  }
}

function specOf(db: ConductorDb, launchId: string): LaunchSpec | undefined {
  const l = db.getLaunch(launchId);
  return l ? withDefaults(JSON.parse(l.spec_json)) : undefined;
}

/** Public endpoints and token display of a chain, for reading and sending. */
function publicFacts(
  db: ConductorDb,
  c: RelayChain,
): { lcd?: string; rpc?: string; chainName: string; displayDenom: string; decimals: number } {
  const other = c.launchId ? specOf(db, c.launchId) : undefined;
  if (other) {
    const pub = other.topology.publicEndpoints;
    return {
      ...(pub?.api ? { lcd: `https://${pub.api}` } : {}),
      ...(pub?.rpc ? { rpc: `https://${pub.rpc}` } : {}),
      chainName: other.network.displayName ?? other.network.name,
      displayDenom: other.token.displayDenom,
      decimals: other.token.exponent ?? 6,
    };
  }
  return {
    ...(c.lcd ? { lcd: c.lcd } : {}),
    rpc: c.rpc,
    chainName: c.chainId,
    ...displayOf(c.gasDenom),
  };
}

/** A key's balance in one denom through a chain's REST API. */
export async function readBalance(rpc: RpcProber, lcd: string, address: string, denom: string): Promise<bigint> {
  const url = `${lcd.replace(/\/$/, "")}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`;
  const body = JSON.parse(await rpc.getText(url)) as { balance?: { amount?: string } };
  return BigInt(body.balance?.amount ?? "0");
}

/**
 * Every relayer key with its live balance and whether it needs attention.
 * `waitingChains` are the chains whose paths the last link left unopened
 * (openWhenFunded): an empty key there is expected, not a fault.
 */
export async function relayerFunds(
  db: ConductorDb,
  rpc: RpcProber,
  launchId: string,
  spec: LaunchSpec,
  secretsDir: string,
  waitingChains: Set<string> = new Set(),
): Promise<RelayerFunds[]> {
  const mnemonic = readRelayerMnemonic(secretsDir);
  if (!mnemonic || !spec.topology.components.relayer?.enabled) return [];
  const plan = relayPlan(db, launchId, spec);
  return Promise.all(
    plan.chains.map(async (c): Promise<RelayerFunds> => {
      const facts = publicFacts(db, c);
      const cap = relayerCap(spec, c);
      const address = await relayerAddress(mnemonic, c);
      const keplr: KeplrRoute | undefined = c.launchId
        ? facts.rpc
          ? {
              kind: "fleet",
              chain: {
                chainId: c.chainId,
                chainName: facts.chainName,
                rpc: facts.rpc,
                ...(facts.lcd ? { rest: facts.lcd } : {}),
                bech32Prefix: c.bech32Prefix,
                denom: c.gasDenom,
                displayDenom: facts.displayDenom,
                decimals: facts.decimals,
                gasPrice: c.gasPrice,
              },
            }
          : undefined
        : { kind: "native", chainId: c.chainId, rpc: c.rpc, gasPrice: sendPrice(c) };
      const base: RelayerFunds = {
        chainId: c.chainId,
        address,
        denom: c.gasDenom,
        displayDenom: facts.displayDenom,
        decimals: facts.decimals,
        amount: fundAmount(c, cap).toString(),
        ...(cap !== undefined ? { cap: cap.toString() } : {}),
        ...(keplr ? { keplr } : {}),
        status: "unknown",
        waiting: waitingChains.has(c.chainId),
        ...(c.launchId ? { launchId: c.launchId } : {}),
      };
      if (!facts.lcd) return { ...base, error: "no REST endpoint known for this chain (set the path's lcd)" };
      try {
        const balance = await readBalance(rpc, facts.lcd, address, c.gasDenom);
        return { ...base, balance: balance.toString(), status: fundStatus(balance, c, cap) };
      } catch (e) {
        return { ...base, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
      }
    }),
  );
}

/** One line per key that needs a top-up, for the fleet health detail. */
export function lowFundsDetail(funds: RelayerFunds[]): string[] {
  return funds
    .filter((f) => !f.waiting && (f.status === "low" || f.status === "empty"))
    .map(
      (f) =>
        `${f.chainId} key ${f.status === "empty" ? "is empty" : `holds only ${f.balance} ${f.denom}`}: ` +
        `hermes stops relaying there when it runs out; send about ${f.amount} ${f.denom} to ${f.address}`,
    );
}

/** Seam for tests: how a withdrawal reaches a chain. */
export interface WithdrawDeps {
  connect(rpc: string, mnemonic: string, prefix: string, hdPath: string): Promise<{
    address: string;
    send(to: string, amount: { denom: string; amount: string }, fee: { amount: { denom: string; amount: string }[]; gas: string }): Promise<string>;
    disconnect(): void;
  }>;
}

export const cosmjsWithdraw: WithdrawDeps = {
  async connect(rpc, mnemonic, prefix, hdPath) {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix, hdPaths: [stringToPath(hdPath)] });
    const [account] = await wallet.getAccounts();
    const client = await SigningStargateClient.connectWithSigner(rpc, wallet);
    return {
      address: account!.address,
      async send(to, amount, fee) {
        const res = await client.sendTokens(account!.address, to, [amount], fee, "relayer withdrawal (SparkDream launcher)");
        if (res.code !== 0) throw new Error(`the chain rejected the withdrawal (code ${res.code}): ${res.rawLog ?? ""}`);
        return res.transactionHash;
      },
      disconnect: () => client.disconnect(),
    };
  },
};

/**
 * Send everything the relayer key holds on `chainId`, less the fee, to `to`.
 * Signed here with the relayer's own key (the launcher holds its mnemonic)
 * through the chain's public RPC. Hermes signs with the same key, so relaying
 * on that chain stops once it is empty: this is for retiring a path or a
 * relayer, or taking back an over-funded key.
 */
export async function withdrawRelayerFunds(
  db: ConductorDb,
  rpc: RpcProber,
  launchId: string,
  spec: LaunchSpec,
  secretsDir: string,
  chainId: string,
  to: string,
  deps: WithdrawDeps = cosmjsWithdraw,
): Promise<{ txHash: string; amount: string; denom: string; to: string }> {
  const mnemonic = readRelayerMnemonic(secretsDir);
  if (!mnemonic) throw new Error("this fleet has no relayer key");
  const chain = relayPlan(db, launchId, spec).chains.find((c) => c.chainId === chainId);
  if (!chain) throw new Error(`the relayer has no key on ${chainId}`);
  let prefix: string;
  try {
    prefix = fromBech32(to).prefix;
  } catch {
    throw new Error(`${to} is not a valid address`);
  }
  if (prefix !== chain.bech32Prefix) throw new Error(`addresses on ${chainId} start with ${chain.bech32Prefix}1`);
  const facts = publicFacts(db, chain);
  if (!facts.lcd || !facts.rpc) throw new Error(`no public REST and RPC endpoints known for ${chainId}`);
  const from = await relayerAddress(mnemonic, chain);
  if (to === from) throw new Error("that is the relayer's own address");
  const balance = await readBalance(rpc, facts.lcd, from, chain.gasDenom);
  const feeAmount = BigInt(Math.ceil(sendPrice(chain) * SEND_GAS));
  if (balance <= feeAmount) {
    throw new Error(`the relayer key holds ${balance} ${chain.gasDenom} on ${chainId}, not more than the ${feeAmount} fee`);
  }
  const amount = (balance - feeAmount).toString();
  const client = await deps.connect(facts.rpc, mnemonic, chain.bech32Prefix, chain.hdPath);
  try {
    const txHash = await client.send(
      to,
      { denom: chain.gasDenom, amount },
      { amount: feeAmount > 0n ? [{ denom: chain.gasDenom, amount: feeAmount.toString() }] : [], gas: String(SEND_GAS) },
    );
    return { txHash, amount, denom: chain.gasDenom, to };
  } finally {
    client.disconnect();
  }
}
