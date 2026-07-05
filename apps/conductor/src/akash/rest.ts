import type { AkashApi } from "./client.js";
import type { Bid, ProviderInfo } from "./policy.js";

export interface RestEndpoints {
  /** Akash LCD (chain REST). */
  lcd: string;
  /** Console public API for enriched provider metadata (§9). */
  consoleApi: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
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
    const res = await fetch(`${this.endpoints.lcd}/cosmos/tx/v1beta1/txs/${txHash}`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return "pending";
    if (!res.ok) throw new Error(`tx lookup: HTTP ${res.status}`);
    const data: any = await res.json();
    return data.tx_response?.code === 0 ? "confirmed" : "failed";
  }

  async deploymentExists(owner: string, dseq: string): Promise<boolean> {
    const res = await fetch(
      `${this.endpoints.lcd}/akash/deployment/v1beta4/deployments/info?id.owner=${owner}&id.dseq=${dseq}`,
      { headers: { accept: "application/json" } },
    );
    return res.ok;
  }

  async leaseState(owner: string, dseq: string, provider: string): Promise<string | undefined> {
    const data = await getJson(
      `${this.endpoints.lcd}/akash/market/v1beta5/leases/list?filters.owner=${owner}&filters.dseq=${dseq}&filters.provider=${provider}`,
    );
    return data.leases?.[0]?.lease?.state;
  }
}

function extractStorageClasses(p: any): string[] {
  // Console API surfaces provider attributes as [{key, value}]; persistent
  // storage support appears as capabilities/storage/<class>: true.
  const attrs: Array<{ key: string; value: string }> = p.attributes ?? [];
  return attrs
    .filter((a) => a.key.startsWith("capabilities/storage/") && a.value === "true")
    .map((a) => a.key.split("/").pop()!)
    .filter(Boolean);
}
