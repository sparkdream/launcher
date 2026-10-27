import type { AkashApi } from "./client.js";
import type { Bid, ProviderInfo } from "./policy.js";

export interface RestEndpoints {
  /** Akash LCD (chain REST). */
  lcd: string;
  /** Console public API for enriched provider metadata (§9). */
  consoleApi: string;
}

async function getJson(url: string): Promise<any> {
  // public LCDs 500 transiently — retry 5xx and network errors before
  // failing the step that asked (same rationale as txStatus below)
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (res.ok) return res.json();
    lastError = new Error(`GET ${url}: HTTP ${res.status}`);
    if (res.status < 500) break; // 4xx is a real answer, not a hiccup
  }
  throw lastError!;
}

/** Waits between tx lookups when the LCD errors: about 30s in all. */
const TX_LOOKUP_DELAYS_MS = [2000, 4000, 8000, 16000];

/** The default LCDs, tried in order. A public proxy can go down whole
 *  (2026-10-08: rest.cosmos.directory/akash answered 502 on every path for
 *  minutes and stranded a reset on a signed, confirmed tx). */
export const DEFAULT_AKASH_LCDS =
  "https://api.akashnet.net,https://akash-api.polkachu.com,https://rest.cosmos.directory/akash";

/** The default CometBFT RPCs, tried in order (2026-10-27: rpc.akashnet.net
 *  answered 521 alongside api.akashnet.net). */
export const DEFAULT_AKASH_RPCS =
  "https://rpc.akashnet.net:443,https://akash-rpc.polkachu.com,https://rpc.cosmos.directory/akash";

/** AKASH_LCD (or AKASH_RPC) may name several endpoints, comma-separated. */
export function parseLcds(value: string): string[] {
  const list = value.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (list.length === 0) throw new Error("no endpoint named");
  return list;
}

/**
 * GET a path from the first of `bases` that answers, starting at `start`: a
 * 5xx or a network error moves on to the next, any other answer (404
 * included) is the answer. When every base fails, the last 5xx response is
 * returned (a caller reading !res.ok behaves as with one base), or the last
 * network error thrown. `index` is the base that gave `res`.
 */
export async function failoverFetch(
  bases: string[],
  pathAndQuery: string,
  start = 0,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<{ res: Response; index: number }> {
  let last: { res: Response; index: number } | undefined;
  let lastError: unknown;
  for (let i = 0; i < bases.length; i++) {
    const index = (start + i) % bases.length;
    let res: Response;
    try {
      res = await fetchImpl(`${bases[index]}${pathAndQuery}`, { headers: { accept: "application/json" } });
    } catch (e) {
      lastError = e;
      continue;
    }
    if (res.status >= 500) {
      last = { res, index };
      continue;
    }
    return { res, index };
  }
  if (last) return last;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Why `lcd` or `rpc` does not answer, or null when both do; cached for a
 * minute. Akash's own endpoints and providers can go down together
 * (2026-10-27: api.akashnet.net and rpc.akashnet.net answered 521 while
 * cpu.dal's provider API reset every connection), and a component read down
 * then is no reason to move it.
 */
export function akashOutageProbe(
  lcd: string,
  rpc: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  now: () => number = Date.now,
): () => Promise<string | null> {
  let cached: { at: number; outage: string | null } | undefined;
  const check = async (url: string): Promise<string | null> => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      return res.status >= 500 ? `${new URL(url).host} answers HTTP ${res.status}` : null;
    } catch (e) {
      return `${new URL(url).host} does not answer (${e instanceof Error ? e.message : String(e)})`;
    }
  };
  return async () => {
    if (cached && now() - cached.at < 60_000) return cached.outage;
    const [a, b] = await Promise.all([
      check(`${lcd}/cosmos/base/tendermint/v1beta1/blocks/latest`),
      check(`${rpc.replace(/\/+$/, "")}/status`),
    ]);
    const outage = [a, b].filter(Boolean).join("; ") || null;
    cached = { at: now(), outage };
    return outage;
  };
}

/** Real chain-facing adapter. Field names mirror the LCD (snake_case). */
export class RestAkashApi implements AkashApi {
  private readonly lcds: string[];
  /** The LCD that answered last: tried first next time. */
  private preferred = 0;

  constructor(private readonly endpoints: RestEndpoints) {
    this.lcds = parseLcds(endpoints.lcd);
  }

  /** GET an LCD path across the configured LCDs (failoverFetch). */
  private async lcdFetch(pathAndQuery: string): Promise<Response> {
    const { res, index } = await failoverFetch(this.lcds, pathAndQuery, this.preferred);
    if (res.status < 500) this.preferred = index;
    return res;
  }

  /** JSON from an LCD path, with getJson's retries across failover rounds. */
  private async lcdJson(pathAndQuery: string): Promise<any> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      let res: Response;
      try {
        res = await this.lcdFetch(pathAndQuery);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      if (res.ok) return res.json();
      lastError = new Error(`GET ${pathAndQuery}: HTTP ${res.status}`);
      if (res.status < 500) break; // 4xx is a real answer, not a hiccup
    }
    throw lastError!;
  }

  async latestBlockHeight(): Promise<number> {
    const data = await this.lcdJson(
      `/cosmos/base/tendermint/v1beta1/blocks/latest`,
    );
    return Number(data.block.header.height);
  }

  async listBids(owner: string, dseq: string): Promise<Bid[]> {
    const data = await this.lcdJson(
      `/akash/market/v1beta5/bids/list?filters.owner=${owner}&filters.dseq=${dseq}`,
    );
    return (data.bids ?? []) as Bid[];
  }

  async listProviders(): Promise<Map<string, ProviderInfo>> {
    const data = await getJson(`${this.endpoints.consoleApi}/v1/providers`);
    const map = new Map<string, ProviderInfo>();
    for (const p of data as any[]) {
      map.set(p.owner, {
        owner: p.owner,
        hostUri: p.hostUri,
        isAudited: Boolean(p.isAudited),
        uptime7d: Number(p.uptime7d ?? 0),
        storageClasses: extractStorageClasses(p),
        // only an explicit false is a refusal: an API that stops sending the
        // field should disable this filter, not reject every provider
        customDomain: p.featEndpointCustomDomain !== false,
      });
    }
    return map;
  }

  async txStatus(txHash: string): Promise<"confirmed" | "pending" | "failed"> {
    // public LCDs 500 transiently (and 5xx on malformed hashes, but those
    // are rejected at the tx-result endpoint) — retry before giving up so
    // a hiccup doesn't fail a step whose tx actually confirmed. Outages
    // outlast a few seconds (2026-10-08: a 502 just after a reset's halt
    // signature failed the step though the tx was in a block), so back off
    // across about half a minute, network errors included
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < TX_LOOKUP_DELAYS_MS.length + 1; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, TX_LOOKUP_DELAYS_MS[attempt - 1]));
      let res: Response;
      try {
        res = await this.lcdFetch(`/cosmos/tx/v1beta1/txs/${txHash}`);
      } catch (e) {
        lastError = new Error(`tx lookup: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (res.status === 404) return "pending";
      if (!res.ok) {
        lastError = new Error(`tx lookup: HTTP ${res.status}`);
        continue;
      }
      const data: any = await res.json();
      return data.tx_response?.code === 0 ? "confirmed" : "failed";
    }
    throw lastError ?? new Error("tx lookup failed");
  }

  async deploymentExists(owner: string, dseq: string): Promise<boolean> {
    const res = await this.lcdFetch(
      `/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
    );
    return res.ok;
  }

  async deploymentInfo(
    owner: string,
    dseq: string,
  ): Promise<{ state: string; hash?: string } | undefined> {
    const res = await this.lcdFetch(
      `/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
    );
    if (!res.ok) return undefined;
    const data: any = await res.json();
    if (!data.deployment?.state) return undefined;
    return { state: data.deployment.state, hash: data.deployment.hash };
  }

  async leaseState(owner: string, dseq: string, provider: string): Promise<string | undefined> {
    const data = await this.lcdJson(
      `/akash/market/v1beta5/leases/list?filters.owner=${owner}&filters.dseq=${dseq}&filters.provider=${provider}`,
    );
    return data.leases?.[0]?.lease?.state;
  }

  async listDeployments(owner: string) {
    const data = await this.lcdJson(
      `/akash/deployment/v1beta4/deployments/list?filters.owner=${owner}&pagination.limit=200`,
    );
    return (data.deployments ?? []).map((d: any) => ({
      dseq: String(d.deployment?.id?.dseq ?? d.deployment?.deployment_id?.dseq),
      state: String(d.deployment?.state ?? "unknown"),
    }));
  }

  async aktUsdPrice(): Promise<number | undefined> {
    // aggregated oracle price (twap/median across sources) — the same feed
    // the BME module converts at when settling MsgMintACT
    let data: any;
    try {
      data = await this.lcdJson(`/akash/oracle/v2/aggregated_price/akt`);
    } catch {
      return undefined;
    }
    if (data.price_health && data.price_health.is_healthy === false) return undefined;
    const price = Number(data.aggregated_price?.median_price);
    return price > 0 ? price : undefined;
  }

  async deploymentEscrow(owner: string, dseq: string) {
    const res = await this.lcdFetch(
      `/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
    );
    if (!res.ok) return undefined;
    const data: any = await res.json();
    // current escrow balance lives in escrow_account.state.funds (a DecCoin
    // array), NOT escrow_account.balance — settled at escrow_account's
    // settled_at height, so it's the funds remaining as of last settlement
    const funds: Array<{ denom: string; amount: string }> = data.escrow_account?.state?.funds ?? [];
    const coin = funds[0];
    if (!coin) return undefined;
    // DecCoin → keep the integer part (uact) for balance + runway math
    return { denom: coin.denom, amount: String(coin.amount).split(".")[0]! };
  }
}

/** featPersistentStorageType marketing names → Akash storage classes. */
const STORAGE_TYPE_CLASS: Record<string, string> = {
  hdd: "beta1",
  ssd: "beta2",
  nvme: "beta3",
};

function extractStorageClasses(p: any): string[] {
  // Legacy signal: provider attributes [{key, value}] with
  // capabilities/storage/<class>: true. Most providers now advertise via
  // featPersistentStorage + featPersistentStorageType instead.
  const attrs: Array<{ key: string; value: string }> = p.attributes ?? [];
  const fromAttrs = attrs
    .filter((a) => a.key.startsWith("capabilities/storage/") && a.value === "true")
    .map((a) => a.key.split("/").pop()!)
    .filter(Boolean);
  const fromFeat = p.featPersistentStorage
    ? ((p.featPersistentStorageType ?? []) as string[])
        .map((t) => STORAGE_TYPE_CLASS[t.toLowerCase()])
        .filter((c): c is string => Boolean(c))
    : [];
  return [...new Set([...fromAttrs, ...fromFeat])];
}
