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

/** Real chain-facing adapter. Field names mirror the LCD (snake_case). */
export class RestAkashApi implements AkashApi {
  constructor(private readonly endpoints: RestEndpoints) {}

  async latestBlockHeight(): Promise<number> {
    const data = await getJson(
      `${this.endpoints.lcd}/cosmos/base/tendermint/v1beta1/blocks/latest`,
    );
    return Number(data.block.header.height);
  }

  async listBids(owner: string, dseq: string): Promise<Bid[]> {
    const data = await getJson(
      `${this.endpoints.lcd}/akash/market/v1beta5/bids/list?filters.owner=${owner}&filters.dseq=${dseq}`,
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
      });
    }
    return map;
  }

  async txStatus(txHash: string): Promise<"confirmed" | "pending" | "failed"> {
    // public LCDs 500 transiently (and 5xx on malformed hashes, but those
    // are rejected at the tx-result endpoint) — retry before giving up so
    // a hiccup doesn't fail a step whose tx actually confirmed
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`${this.endpoints.lcd}/cosmos/tx/v1beta1/txs/${txHash}`, {
        headers: { accept: "application/json" },
      });
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
    const res = await fetch(
      `${this.endpoints.lcd}/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
      { headers: { accept: "application/json" } },
    );
    return res.ok;
  }

  async deploymentInfo(
    owner: string,
    dseq: string,
  ): Promise<{ state: string; hash?: string } | undefined> {
    const res = await fetch(
      `${this.endpoints.lcd}/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return undefined;
    const data: any = await res.json();
    if (!data.deployment?.state) return undefined;
    return { state: data.deployment.state, hash: data.deployment.hash };
  }

  async leaseState(owner: string, dseq: string, provider: string): Promise<string | undefined> {
    const data = await getJson(
      `${this.endpoints.lcd}/akash/market/v1beta5/leases/list?filters.owner=${owner}&filters.dseq=${dseq}&filters.provider=${provider}`,
    );
    return data.leases?.[0]?.lease?.state;
  }

  async listDeployments(owner: string) {
    const data = await getJson(
      `${this.endpoints.lcd}/akash/deployment/v1beta4/deployments/list?filters.owner=${owner}&pagination.limit=200`,
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
      data = await getJson(`${this.endpoints.lcd}/akash/oracle/v2/aggregated_price/akt`);
    } catch {
      return undefined;
    }
    if (data.price_health && data.price_health.is_healthy === false) return undefined;
    const price = Number(data.aggregated_price?.median_price);
    return price > 0 ? price : undefined;
  }

  async deploymentEscrow(owner: string, dseq: string) {
    const res = await fetch(
      `${this.endpoints.lcd}/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
      { headers: { accept: "application/json" } },
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
