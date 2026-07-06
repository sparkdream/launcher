import type { OfflineSigner } from "@cosmjs/proto-signing";

/** The Akash-compatible network paying for compute (infra.akashNetwork). */
export interface ChainConfig {
  chainId: string;
  chainName: string;
  rpc: string;
  rest: string;
  /** Pricing/fee denom, e.g. uact. */
  denom: string;
  bech32Prefix: string;
  /** e.g. "0.025" (in denom per gas). */
  gasPrice: string;
}

export const DEFAULT_CHAIN: ChainConfig = {
  chainId: "sandbox-01",
  chainName: "Akash Sandbox",
  rpc: "https://rpc.sandbox-01.aksh.pw",
  rest: "https://api.sandbox-01.aksh.pw",
  denom: "uakt",
  bech32Prefix: "akash",
  gasPrice: "0.025",
};

const STORAGE_KEY = "launcher.chainConfig";

export function loadChainConfig(): ChainConfig {
  if (typeof window === "undefined") return DEFAULT_CHAIN; // Next prerender
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CHAIN, ...JSON.parse(raw) };
  } catch {
    // fall through to default
  }
  return DEFAULT_CHAIN;
}

export function saveChainConfig(config: ChainConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

interface KeplrWindow {
  keplr?: {
    enable(chainId: string): Promise<void>;
    experimentalSuggestChain(info: unknown): Promise<void>;
    getOfflineSigner(chainId: string): OfflineSigner;
    getKey(chainId: string): Promise<{ bech32Address: string; name: string }>;
  };
}

export function keplr() {
  const k = (window as unknown as KeplrWindow).keplr;
  if (!k) throw new Error("Keplr extension not found — install it and reload");
  return k;
}

/** Register a non-registry chain (our uact network) with Keplr. */
export async function suggestChain(config: ChainConfig): Promise<void> {
  const coinDenom = config.denom.replace(/^u/, "").toUpperCase();
  const currency = {
    coinDenom,
    coinMinimalDenom: config.denom,
    coinDecimals: 6,
  };
  const gas = Number(config.gasPrice);
  await keplr().experimentalSuggestChain({
    chainId: config.chainId,
    chainName: config.chainName,
    rpc: config.rpc,
    rest: config.rest,
    bip44: { coinType: 118 },
    bech32Config: {
      bech32PrefixAccAddr: config.bech32Prefix,
      bech32PrefixAccPub: `${config.bech32Prefix}pub`,
      bech32PrefixValAddr: `${config.bech32Prefix}valoper`,
      bech32PrefixValPub: `${config.bech32Prefix}valoperpub`,
      bech32PrefixConsAddr: `${config.bech32Prefix}valcons`,
      bech32PrefixConsPub: `${config.bech32Prefix}valconspub`,
    },
    currencies: [currency],
    feeCurrencies: [
      { ...currency, gasPriceStep: { low: gas, average: gas, high: gas * 2 } },
    ],
    stakeCurrency: currency,
  });
}

export interface ConnectedWallet {
  address: string;
  name: string;
  signer: OfflineSigner;
}

export async function connectKeplr(config: ChainConfig): Promise<ConnectedWallet> {
  const k = keplr();
  try {
    await k.enable(config.chainId);
  } catch {
    // unknown chain → suggest it, then retry
    await suggestChain(config);
    await k.enable(config.chainId);
  }
  const key = await k.getKey(config.chainId);
  return {
    address: key.bech32Address,
    name: key.name,
    signer: k.getOfflineSigner(config.chainId),
  };
}
