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
  /** state: "active" | "closed"; hash: base64 manifest version (may be absent). */
  deploymentInfo(
    owner: string,
    dseq: string,
  ): Promise<{ state: string; hash?: string } | undefined>;
  leaseState(owner: string, dseq: string, provider: string): Promise<string | undefined>;
  /** Owner-filtered deployment list — fleet reconciliation (§2). */
  listDeployments(owner: string): Promise<DeploymentSummary[]>;
  /** Escrow balance for runway estimation (§5 monitor). */
  deploymentEscrow(owner: string, dseq: string): Promise<Coin | undefined>;
  /**
   * AKT/USD from the chain's own oracle (the price BME settles mints at).
   * undefined when the feed is unavailable or reports unhealthy.
   */
  aktUsdPrice(): Promise<number | undefined>;
}

export interface DeploymentSummary {
  dseq: string;
  state: string;
}

export interface Coin {
  denom: string;
  amount: string;
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
    // "no lease" right after MsgCreateLease is a propagation race: providers
    // learn about leases by watching the chain, and the gateway can lag the
    // confirmed tx by tens of seconds. 3×3s gave up after ~11s and stranded
    // launches on a 404; 6 attempts with backoff waits ~50s instead.
    this.retries = opts.retries ?? 6;
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
        await this.sleep(3000 * attempt); // 3s, 6s, 9s, 12s, 15s ≈ 45s + pre-send
      }
    }
    throw lastError;
  }

  /**
   * One-shot command over the provider's lease-shell websocket (the same
   * mechanism console/`provider-services lease-shell` uses). Needed for
   * containers without sshd (headscale). Frames: first byte is the stream
   * code — 100 stdout, 101 stderr, 102 result JSON, 103 provider failure.
   */
  async shellExec(
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    service: string,
    cmd: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const base = new URL(hostUri);
    const query = new URLSearchParams({ service, podIndex: "0", tty: "0", stdin: "0" });
    cmd.forEach((c, i) => query.set(`cmd${i}`, c));
    const url = `wss://${base.hostname}:${base.port || 8443}/lease/${dseq}/${gseq}/${oseq}/shell?${query}`;
    const { default: WebSocket } = await import("ws");
    return new Promise((resolve, reject) => {
      // servername passes through to tls.connect but ws's types don't
      // declare it — same no-SNI mTLS-path reason as request()
      const ws = new WebSocket(url, {
        cert: this.creds.certPem,
        key: this.creds.keyPem,
        rejectUnauthorized: false,
        servername: "",
      } as unknown as ConstructorParameters<typeof WebSocket>[1]);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          // already closed
        }
        fn();
      };
      const timer = setTimeout(
        () => done(() => reject(new Error(`lease shell: timeout running ${cmd.join(" ")}`))),
        opts.timeoutMs ?? 60_000,
      );
      ws.on("message", (data: Buffer) => {
        const code = data[0];
        const msg = data.subarray(1);
        if (code === 100) stdout += msg.toString();
        else if (code === 101) stderr += msg.toString();
        else if (code === 102) {
          done(() => {
            try {
              const res = JSON.parse(msg.toString() || "{}");
              if (res.message) reject(new Error(`lease shell: ${res.message}`));
              else if (res.exit_code) {
                reject(
                  new Error(
                    `lease shell: exit ${res.exit_code}: ${(stderr || stdout).slice(0, 500)}`,
                  ),
                );
              } else resolve({ stdout, stderr });
            } catch (e) {
              reject(e as Error);
            }
          });
        } else if (code === 103) {
          // infrastructure-level failure frame — typical when the pod is
          // mid-restart; surface whatever output made it through
          const detail = (stderr || stdout).slice(0, 500);
          done(() =>
            reject(
              new Error(
                `lease shell: provider reported a failure${detail ? `: ${detail}` : " (pod restarting?)"}`,
              ),
            ),
          );
        }
      });
      ws.on("error", (e: Error) => done(() => reject(e)));
      ws.on("close", () =>
        done(() => reject(new Error("lease shell: connection closed before result"))),
      );
    });
  }

  async leaseStatus(hostUri: string, dseq: string, gseq: number, oseq: number): Promise<unknown> {
    const body = await this.request(
      "GET",
      hostUri,
      `/lease/${dseq}/${gseq}/${oseq}/status`,
    );
    return JSON.parse(body || "{}");
  }

  async leaseLogs(
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    tail: number,
  ): Promise<string> {
    return this.request(
      "GET",
      hostUri,
      `/lease/${dseq}/${gseq}/${oseq}/logs?follow=false&tail=${tail}`,
    );
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
          // CRITICAL: no SNI. When the SNI matches the provider's hostname
          // and it holds a CA-issued cert for it, the gateway serves plain
          // TLS and expects JWT auth — the client cert is never requested
          // and every mTLS call 401s. No SNI forces the mTLS code path.
          servername: "",
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
  /**
   * After minBids is met, keep polling until no NEW provider has bid for
   * this many consecutive rounds — collects a fuller bid set for the policy
   * engine to choose from (console-air's "waiting for more bids…"), while
   * still stopping once the flow dries up. 0 = return at minBids.
   */
  settleRounds?: number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (attempt: number, bids: Bid[]) => void;
}

/** Poll bids for a dseq until the budget runs out or minBids (+settle) is reached. */
export async function pollBids(
  api: AkashApi,
  owner: string,
  dseq: string,
  opts: BidPollOpts = {},
): Promise<Bid[]> {
  const interval = opts.intervalMs ?? 7000;
  const maxAttempts = opts.maxAttempts ?? Math.floor((5.5 * 60 * 1000) / 7000);
  const settleRounds = opts.settleRounds ?? 0;
  const sleep = opts.sleep ?? defaultSleep;
  let bids: Bid[] = [];
  let providersSeen = 0;
  let stable = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    bids = await api.listBids(owner, dseq);
    opts.onPoll?.(attempt, bids);
    const open = bids.filter((b) => b.bid.state === "open");
    const providers = new Set(open.map((b) => b.bid.id.provider)).size;
    if (opts.minBids && providers >= opts.minBids) {
      stable = providers > providersSeen ? 0 : stable + 1;
      if (stable >= settleRounds) return bids;
    }
    providersSeen = providers;
    if (attempt < maxAttempts) await sleep(interval);
  }
  return bids;
}
