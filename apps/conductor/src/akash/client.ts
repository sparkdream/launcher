import https from "node:https";
import type { Bid, ProviderInfo } from "./policy.js";

/**
 * Everything the steps need from the outside world, injectable so the
 * whole launch pipeline is testable without a chain (M2 headless, §11).
 */
export interface AkashApi {
  latestBlockHeight(): Promise<number>;
  listBids(owner: string, dseq: string): Promise<Bid[]>;
  listProviders(): Promise<Map<string, ProviderInfo>>;
  /** Throws until the tx is found & successful; caller polls. */
  txStatus(txHash: string): Promise<"confirmed" | "pending" | "failed">;
  deploymentExists(owner: string, dseq: string): Promise<boolean>;
  leaseState(owner: string, dseq: string, provider: string): Promise<string | undefined>;
}

export interface MtlsCredentials {
  certPem: string;
  keyPem: string;
}

export interface ProviderClientOpts {
  retries?: number;
  /** Delay before first manifest PUT — console-air's BEFORE_SEND_MANIFEST_DELAY. */
  preSendDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Direct-mTLS provider client (§9: no hosted proxy — the conductor holds the
 * cert and talks straight to the provider's hostUri).
 */
export class ProviderClient {
  private readonly retries: number;
  private readonly preSendDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly creds: MtlsCredentials,
    opts: ProviderClientOpts = {},
  ) {
    this.retries = opts.retries ?? 3;
    this.preSendDelayMs = opts.preSendDelayMs ?? 5000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** PUT {hostUri}/deployment/{dseq}/manifest — retries on "no lease". */
  async sendManifest(hostUri: string, dseq: string, manifestJson: string): Promise<void> {
    await this.sleep(this.preSendDelayMs);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        await this.request("PUT", hostUri, `/deployment/${dseq}/manifest`, manifestJson);
        return;
      } catch (e) {
        lastError = e as Error;
        if (!/no lease/i.test(lastError.message) || attempt === this.retries) throw lastError;
        await this.sleep(3000);
      }
    }
    throw lastError;
  }

  async leaseStatus(hostUri: string, dseq: string, gseq: number, oseq: number): Promise<unknown> {
    const body = await this.request(
      "GET",
      hostUri,
      `/lease/${dseq}/${gseq}/${oseq}/status`,
    );
    return JSON.parse(body || "{}");
  }

  private request(method: string, hostUri: string, path: string, body?: string): Promise<string> {
    const base = new URL(hostUri);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method,
          hostname: base.hostname,
          port: base.port || 8443,
          path,
          cert: this.creds.certPem,
          key: this.creds.keyPem,
          // Provider certs are self-signed, on-chain-verified — not CA-signed.
          rejectUnauthorized: false,
          headers: body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {},
          timeout: 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(text);
            else reject(new Error(`provider ${method} ${path}: HTTP ${res.statusCode} ${text.slice(0, 500)}`));
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("provider request timeout")));
      if (body) req.write(body);
      req.end();
    });
  }
}

export interface BidPollOpts {
  intervalMs?: number;
  /** console-air budget: ~5.5 min at 7s (§5 step 13). */
  maxAttempts?: number;
  /** Stop early once this many distinct providers have bid (0 = wait out the clock). */
  minBids?: number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (attempt: number, bids: Bid[]) => void;
}

/** Poll bids for a dseq until the budget runs out or minBids is reached. */
export async function pollBids(
  api: AkashApi,
  owner: string,
  dseq: string,
  opts: BidPollOpts = {},
): Promise<Bid[]> {
  const interval = opts.intervalMs ?? 7000;
  const maxAttempts = opts.maxAttempts ?? Math.floor((5.5 * 60 * 1000) / 7000);
  const sleep = opts.sleep ?? defaultSleep;
  let bids: Bid[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    bids = await api.listBids(owner, dseq);
    opts.onPoll?.(attempt, bids);
    const open = bids.filter((b) => b.bid.state === "open");
    if (opts.minBids && open.length >= opts.minBids) return bids;
    if (attempt < maxAttempts) await sleep(interval);
  }
  return bids;
}
