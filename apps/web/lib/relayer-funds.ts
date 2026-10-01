import { SigningStargateClient } from "@cosmjs/stargate";
import type { FundingRequest } from "./api";
import { connectFleetChain, keplr, withAppFee } from "./keplr";

/** Gas of a plain bank send; the conductor's withdrawals use the same. */
const SEND_GAS = 120_000;

/** Base units → display units ("2500000", 6 → "2.5"). */
export function toDisplay(amount: string, decimals: number): string {
  if (decimals === 0) return amount;
  const n = BigInt(amount || "0");
  const unit = 10n ** BigInt(decimals);
  const frac = (n % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${n / unit}${frac ? `.${frac}` : ""}`;
}

/** Display units → base units ("2.5", 6 → "2500000"); null when not a number. */
export function toBase(display: string, decimals: number): string | null {
  const v = display.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return null;
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) return null;
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}

/**
 * Send `amount` (base units) to a relayer key from the wallet connected in
 * Keplr: a launcher fleet's chain is suggested to Keplr from its public
 * endpoints, any other chain must be one Keplr already knows. The fee is the
 * relayer's own gas price for that chain (at least the chain's minimum).
 */
export async function sendToRelayerKey(row: FundingRequest, amount: string): Promise<{ from: string; txHash: string }> {
  if (!row.keplr) throw new Error(`the launcher knows no public RPC for ${row.chainId}: send from another wallet`);
  const route = row.keplr;
  let from: string;
  let signer;
  let rpc: string;
  let gasPrice: number;
  if (route.kind === "fleet") {
    const w = await connectFleetChain(route.chain);
    from = w.address;
    signer = w.signer;
    rpc = route.chain.rpc;
    gasPrice = route.chain.gasPrice;
  } else {
    const k = keplr();
    try {
      await k.enable(route.chainId);
    } catch (e) {
      throw new Error(`Keplr does not know ${route.chainId} (${String(e)}): send from another wallet`);
    }
    from = (await k.getKey(route.chainId)).bech32Address;
    signer = await k.getOfflineSignerAuto(route.chainId);
    rpc = route.rpc;
    gasPrice = route.gasPrice;
  }
  const feeAmount = BigInt(Math.ceil(gasPrice * SEND_GAS));
  const fee = { amount: feeAmount > 0n ? [{ denom: row.denom, amount: feeAmount.toString() }] : [], gas: String(SEND_GAS) };
  const client = await SigningStargateClient.connectWithSigner(rpc, signer);
  try {
    const res = await withAppFee(() =>
      client.sendTokens(from, row.address, [{ denom: row.denom, amount }], fee, "fund relayer (SparkDream launcher)"),
    );
    if (res.code !== 0) throw new Error(`the chain rejected the send (code ${res.code}): ${res.rawLog ?? ""}`);
    return { from, txHash: res.transactionHash };
  } finally {
    client.disconnect();
  }
}
