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

// Akash mainnet — Keplr knows akashnet-2 natively, so connect skips the
// suggest-chain prompt. Deployments price in uact (minted from AKT via BME).
export const DEFAULT_CHAIN: ChainConfig = {
  chainId: "akashnet-2",
  chainName: "Akash",
  rpc: "https://rpc.akashnet.net",
  rest: "https://api.akashnet.net",
  denom: "uact",
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
    /** Amino signing — the Ledger-compatible path used for gentxs (§5 3b). */
    signAmino(
      chainId: string,
      signer: string,
      signDoc: unknown,
      signOptions?: { preferNoSetFee?: boolean; preferNoSetMemo?: boolean },
    ): Promise<unknown>;
    /** ADR-36 arbitrary-data signature — wallet-session auth (M6 §2). */
    signArbitrary(chainId: string, signer: string, data: string): Promise<AuthSignature>;
  };
}

export interface AuthSignature {
  pub_key: { type: string; value: string };
  signature: string;
}

/** Sign a server nonce for wallet-session auth (M6, §2). */
export async function signAuthNonce(
  config: ChainConfig,
  address: string,
  nonce: string,
): Promise<AuthSignature> {
  return keplr().signArbitrary(config.chainId, address, nonce);
}

export function keplr() {
  const k = (window as unknown as KeplrWindow).keplr;
  if (!k) throw new Error("Keplr extension not found — install it and reload");
  return k;
}

/**
 * Wait for the extension to inject `window.keplr` — on a fresh page load the
 * app can hydrate before the content script runs. False on timeout.
 */
export async function waitForKeplr(timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (!(window as unknown as KeplrWindow).keplr) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
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

/**
 * Register the NEW chain (the one being launched) in Keplr so it can sign
 * gentxs pre-genesis. Endpoints aren't live yet — Keplr accepts that; the
 * sign call itself is fully offline.
 */
export async function suggestNewChain(spec: any): Promise<string> {
  // join mode signs against the LIVE chain, whose id comes from the bundle
  const chainId = spec.join?.chainId ?? `${spec.network.name}-${spec.network.chainIdSuffix ?? 1}`;
  const coinDenom = spec.token.displayDenom;
  const currency = {
    coinDenom,
    coinMinimalDenom: spec.token.baseDenom,
    coinDecimals: spec.token.exponent ?? 6,
  };
  const prefix = spec.network.bech32Prefix;
  await keplr().experimentalSuggestChain({
    chainId,
    chainName: `${spec.network.name} (${spec.network.type})`,
    // placeholders until the sentries are live
    rpc: "http://127.0.0.1:26657",
    rest: "http://127.0.0.1:1317",
    bip44: { coinType: 118 },
    bech32Config: {
      bech32PrefixAccAddr: prefix,
      bech32PrefixAccPub: `${prefix}pub`,
      bech32PrefixValAddr: `${prefix}valoper`,
      bech32PrefixValPub: `${prefix}valoperpub`,
      bech32PrefixConsAddr: `${prefix}valcons`,
      bech32PrefixConsPub: `${prefix}valconspub`,
    },
    currencies: [currency],
    feeCurrencies: [{ ...currency, gasPriceStep: { low: 0, average: 0, high: 0 } }],
    stakeCurrency: currency,
  });
  await keplr().enable(chainId);
  return chainId;
}

/** Sign a gentx sign doc with the wallet account owning `address`. */
export async function signGentx(spec: any, address: string, signDoc: unknown): Promise<unknown> {
  const chainId = await suggestNewChain(spec);
  // preferNoSetFee/Memo: the sign doc must round-trip unmodified — the
  // conductor rejects msg drift, and fee is zero at genesis anyway
  return keplr().signAmino(chainId, address, signDoc, {
    preferNoSetFee: true,
    preferNoSetMemo: true,
  });
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
