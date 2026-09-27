import { SigningStargateClient } from "@cosmjs/stargate";
import { encodedToEncodeObjects, sparkdreamSigning } from "@sparkdream/akash-tx";
import type { WalletRequest } from "./api";
import { connectFleetChain, withAppFee } from "./keplr";

/** Gas when the request names none: what the conductor signs with itself. */
const DEFAULT_GAS = 400_000;

/**
 * Sign and broadcast a wallet-signed pause's transaction: the messages as the
 * chain binary encoded them, the connected account's address wherever the
 * conductor left "<signer>", out through the fleet's public RPC. Resolves once the chain accepted
 * it; the conductor re-checks chain state itself when the launch resumes.
 */
export async function signWalletRequest(req: WalletRequest): Promise<{ address: string; txHash: string }> {
  const wallet = await connectFleetChain(req.chain);
  if (req.signer && wallet.address !== req.signer) {
    throw new Error(
      `this transaction must be signed by ${req.signer}, but your wallet's active account is ${wallet.address}: ` +
        "switch accounts in Keplr and sign again",
    );
  }
  const { registry, aminoTypes } = sparkdreamSigning();
  // the chain's own encoding, with the wallet's address where "<signer>" was
  const msgs = encodedToEncodeObjects(req.encoded, wallet.address);
  const gas = req.gas ?? DEFAULT_GAS;
  let amount = BigInt(Math.ceil(req.chain.gasPrice * gas));
  if (req.minFee && req.minFee.denom === req.chain.denom && BigInt(req.minFee.amount) > amount) {
    amount = BigInt(req.minFee.amount);
  }
  const fee = { amount: amount > 0n ? [{ denom: req.chain.denom, amount: amount.toString() }] : [], gas: String(gas) };
  const client = await SigningStargateClient.connectWithSigner(req.chain.rpc, wallet.signer, { registry, aminoTypes });
  try {
    // the fee here meets any floor the chain enforces: Keplr must not swap it
    const result = await withAppFee(() =>
      client.signAndBroadcast(wallet.address, msgs, fee, "signed in the SparkDream launcher"),
    );
    if (result.code !== 0) {
      throw new Error(`the chain rejected the transaction (code ${result.code}): ${result.rawLog ?? ""}`);
    }
    return { address: wallet.address, txHash: result.transactionHash };
  } finally {
    client.disconnect();
  }
}
