import type { OfflineSigner } from "@cosmjs/proto-signing";
import { SigningStargateClient, type SigningStargateClientOptions } from "@cosmjs/stargate";
import type { ChainConfig } from "./keplr";

/**
 * Public Akash mainnet endpoints tried after the configured one: Akash's own
 * can go down whole (2026-10-27: api.akashnet.net and rpc.akashnet.net both
 * answered 521, and every balance read and Keplr signature failed with them).
 */
const AKASH_MAINNET_FALLBACKS = {
  rpc: ["https://akash-rpc.polkachu.com", "https://rpc.cosmos.directory/akash"],
  rest: ["https://akash-api.polkachu.com", "https://rest.cosmos.directory/akash"],
};

/** The chain's configured endpoint first, then the fallbacks (akashnet-2 only). */
export function endpointsOf(chain: ChainConfig, kind: "rpc" | "rest"): string[] {
  const extra = chain.chainId === "akashnet-2" ? AKASH_MAINNET_FALLBACKS[kind] : [];
  const norm = (u: string) => u.replace(/\/+$/, "");
  return [...new Set([chain[kind], ...extra].map(norm))];
}

/** A signing client on the first of the chain's RPCs that answers. */
export async function connectSigning(
  chain: ChainConfig,
  signer: OfflineSigner,
  options: SigningStargateClientOptions,
): Promise<SigningStargateClient> {
  let lastError: unknown;
  for (const rpc of endpointsOf(chain, "rpc")) {
    try {
      return await SigningStargateClient.connectWithSigner(rpc, signer, options);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
