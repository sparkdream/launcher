import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { AkashApi, MtlsCredentials } from "../src/akash/client.js";
import type { Bid, ProviderInfo } from "../src/akash/policy.js";
import type { Msg } from "../src/akash/messages.js";
import type {
  Certificate,
  Services,
  SshResult,
  SshTarget,
} from "../src/services.js";
import type { Signer } from "../src/engine.js";

/** Six providers so a 2×2 fleet + headscale can satisfy strict anti-affinity. */
export function fakeProviders(): Map<string, ProviderInfo> {
  const map = new Map<string, ProviderInfo>();
  for (let i = 1; i <= 6; i++) {
    map.set(`akash1provider${i}`, {
      owner: `akash1provider${i}`,
      hostUri: `https://provider${i}.example.com:8443`,
      isAudited: true,
      uptime7d: 0.999,
      storageClasses: ["beta3"],
    });
  }
  return map;
}

export class FakeAkashApi implements AkashApi {
  height = 1000;
  txCounter = 0;
  failTxHashes = new Set<string>();
  providers = fakeProviders();
  /** 1 AKT = $0.50 → uact fee amounts convert to exactly 2× uakt. */
  aktUsd: number | undefined = 0.5;

  async latestBlockHeight(): Promise<number> {
    return (this.height += 10);
  }

  async aktUsdPrice(): Promise<number | undefined> {
    return this.aktUsd;
  }

  /** When set, the first dseq listBids sees only ever has closed bids —
   *  simulates an order whose bids expired while awaiting a signature. */
  staleFirstOrder = false;
  private firstDseq: string | undefined;

  /** On-chain deployment version hashes (base64), for tests exercising
   *  the "version already matches — skip update tx" reconciliation. */
  deploymentHashes = new Map<string, string>();

  async deploymentInfo(
    _owner: string,
    dseq: string,
  ): Promise<{ state: string; hash?: string } | undefined> {
    if (!this.knownDseqs.has(dseq)) return undefined;
    // a stale order still has an active deployment awaiting the close;
    // no hash (unless set above) → steps skip hash reconciliation in tests
    return {
      state: this.leaseStates.get(dseq) === "closed" ? "closed" : "active",
      hash: this.deploymentHashes.get(dseq),
    };
  }

  /** dseqs whose bids have all expired (create-leases stale-bid recovery). */
  expiredBidDseqs = new Set<string>();

  async listBids(_owner: string, dseq: string): Promise<Bid[]> {
    this.knownDseqs.add(dseq); // every launched dseq shows up on-chain
    if (this.staleFirstOrder) this.firstDseq ??= dseq;
    const state =
      (this.staleFirstOrder && dseq === this.firstDseq) || this.expiredBidDseqs.has(dseq)
        ? "closed"
        : "open";
    // every provider bids on everything; price varies by provider index
    return [...this.providers.keys()].map((provider, i) => ({
      bid: {
        id: { owner: _owner, dseq, gseq: 1, oseq: 1, provider },
        state,
        price: { denom: "uact", amount: String(100 + i * 10) },
      },
    }));
  }

  async listProviders(): Promise<Map<string, ProviderInfo>> {
    return this.providers;
  }

  async txStatus(txHash: string): Promise<"confirmed" | "pending" | "failed"> {
    return this.failTxHashes.has(txHash) ? "failed" : "confirmed";
  }

  async deploymentExists(): Promise<boolean> {
    return true;
  }

  /** dseq → lease state override (default "active"). */
  leaseStates = new Map<string, string>();

  async leaseState(_owner: string, dseq: string): Promise<string> {
    return this.leaseStates.get(dseq) ?? "active";
  }

  /** extra on-chain deployments not created by this launcher (unmanaged). */
  extraDeployments: Array<{ dseq: string; state: string }> = [];
  private knownDseqs = new Set<string>();

  registerDseq(dseq: string): void {
    this.knownDseqs.add(dseq);
  }

  async listDeployments(_owner: string) {
    const fromLaunches = [...this.knownDseqs].map((dseq) => ({
      dseq,
      state: this.leaseStates.get(dseq) === "closed" ? "closed" : "active",
    }));
    return [...fromLaunches, ...this.extraDeployments];
  }

  escrowBalances = new Map<string, { denom: string; amount: string }>();

  async deploymentEscrow(_owner: string, dseq: string) {
    return this.escrowBalances.get(dseq) ?? { denom: "uact", amount: "5000000" };
  }

}

export class FakeProviderGateway {
  manifests: Array<{ hostUri: string; dseq: string }> = [];
  private portCounter = 30000;
  private assigned = new Map<string, { host: string; port: number }>();

  async sendManifest(_creds: MtlsCredentials, hostUri: string, dseq: string): Promise<void> {
    this.manifests.push({ hostUri, dseq });
  }

  async leaseLogs(): Promise<string> {
    return "fake log line 1\nfake log line 2\n";
  }

  async leaseStatus(_creds: MtlsCredentials, hostUri: string, dseq: string): Promise<unknown> {
    const key = `${hostUri}/${dseq}`;
    if (!this.assigned.has(key)) {
      this.assigned.set(key, {
        host: new URL(hostUri).hostname,
        port: ++this.portCounter,
      });
    }
    const ep = this.assigned.get(key)!;
    return {
      services: {
        headscale: { available: 1, total: 1, uris: [`fake.ingress.${ep.host}`] },
        sparkdreamd: { available: 1, total: 1 },
      },
      forwarded_ports: {
        sparkdreamd: [
          { host: ep.host, port: 2222, externalPort: ep.port },
          // RPC rides a RANDOM_PORT too — nodeRpcUrl resolves it from here
          { host: ep.host, port: 26657, externalPort: ep.port + 10000 },
          // P2P is global on sentries (§5 "Public peering") — the source of
          // external_address and the join bundle's peer strings
          { host: ep.host, port: 26656, externalPort: ep.port + 20000 },
        ],
      },
    };
  }

  /** Lease-shell exec — the headscale image has no sshd (mirrors FakeSsh). */
  shellLog: Array<{ dseq: string; script: string }> = [];
  async shellExec(
    _creds: MtlsCredentials,
    _hostUri: string,
    dseq: string,
    _gseq: number,
    _oseq: number,
    _service: string,
    cmd: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const script = cmd[cmd.length - 1] ?? "";
    this.shellLog.push({ dseq, script });
    if (script.includes("kill 1")) throw new Error("lease shell: connection closed before result");
    if (script.includes("users list")) {
      return { stdout: JSON.stringify([{ id: 1, name: "sparkdream" }]), stderr: "" };
    }
    if (script.includes("preauthkeys create")) {
      // mirrors the real CLI: --user must be the numeric id, not a name
      if (!/--user \d+/.test(script)) {
        throw new Error('lease shell: exit 1: invalid argument for "-u, --user" flag: strconv.ParseUint');
      }
      return { stdout: JSON.stringify({ key: `hskey-${this.shellLog.length}` }), stderr: "" };
    }
    if (script.includes("SELECT count(*) FROM users")) return { stdout: "1", stderr: "" };
    if (script.startsWith("base64 ")) {
      return { stdout: Buffer.from("FAKE").toString("base64"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

/** Simulates node-side state: uploads, mesh join, processes. */
export class FakeSsh {
  uploaded = new Set<string>();
  started = new Set<string>();
  signerConnected = true;
  /** host:port targets that refuse connections (torn-down containers). */
  failHosts = new Set<string>();
  execLog: Array<{ target: string; command: string }> = [];
  private ipCounter = 10;
  private ips = new Map<string, string>();

  private id(target: SshTarget): string {
    return `${target.host}:${target.port}`;
  }

  async exec(target: SshTarget, command: string): Promise<SshResult> {
    const id = this.id(target);
    if (this.failHosts.has(id)) throw new Error(`connect ECONNREFUSED ${id}`);
    this.execLog.push({ target: id, command });
    const ok = (stdout = ""): SshResult => ({ stdout, code: 0 });

    if (command.includes("test -f") && command.includes(".node-data-uploaded")) {
      return ok(this.uploaded.has(id) ? "yes" : "no");
    }
    if (command.includes("tar xzf")) {
      this.uploaded.add(id);
      return ok();
    }
    if (command.includes("tailscale") && command.includes("ip -4")) {
      if (!this.ips.has(id)) this.ips.set(id, `100.64.0.${this.ipCounter++}`);
      return ok(this.ips.get(id)!);
    }
    if (command.includes("preauthkeys create")) {
      return ok(JSON.stringify({ key: `hskey-${this.execLog.length}` }));
    }
    if (command.includes("SELECT count(*) FROM users")) return ok("1");
    if (command.includes("nc -z 127.0.0.1 26660")) {
      return ok(this.signerConnected ? "ok" : "no");
    }
    if (command.includes("pgrep -x sparkdreamd")) {
      return ok(this.started.has(id) ? "yes" : "no");
    }
    if (command.includes("pkill -x sparkdreamd")) {
      this.started.delete(id);
      return ok();
    }
    if (command.includes("sparkdreamd start")) {
      this.started.add(id);
      return ok();
    }
    // sed / kill / pkill / socat / users create / nc verify — all fine
    return ok();
  }

  async upload(target: SshTarget, localPath: string): Promise<void> {
    if (!fs.existsSync(localPath)) throw new Error(`upload source missing: ${localPath}`);
  }

  async download(_target: SshTarget, _remote: string, localPath: string): Promise<void> {
    fs.writeFileSync(localPath, "fake");
  }
}

export class FakeRpc {
  private heights = new Map<string, number>();
  httpOkResult = true;
  /** Docker Hub tag probe — 200 = image exists (validate-spec fail-fast). */
  httpStatusResult = 200;

  async httpStatus(_url: string): Promise<number> {
    return this.httpStatusResult;
  }

  async status(url: string) {
    const h = (this.heights.get(url) ?? 0) + 5;
    this.heights.set(url, h);
    return { latestBlockHeight: h, catchingUp: false };
  }

  /** Hosts that answer false regardless of httpOkResult (dark domains). */
  darkUrls = new Set<string>();

  async httpOk(url?: string): Promise<boolean> {
    if (url && [...this.darkUrls].some((d) => url.includes(d))) return false;
    return this.httpOkResult;
  }

  /** url (or a substring of it) → body served by getText (join mode). */
  texts = new Map<string, string>();

  async getText(url: string): Promise<string> {
    for (const [key, body] of this.texts) {
      if (url.includes(key)) return body;
    }
    throw new Error(`FakeRpc.getText: no body registered for ${url}`);
  }
}

const FAKE_CERT: Certificate = {
  certPem: "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n",
  keyPem: "-----BEGIN EC PRIVATE KEY-----\nFAKE\n-----END EC PRIVATE KEY-----\n",
  pubkeyPem: "-----BEGIN EC PUBLIC KEY-----\nFAKE\n-----END EC PUBLIC KEY-----\n",
};

export interface FakeWorld extends Services {
  api: FakeAkashApi;
  provider: FakeProviderGateway;
  ssh: FakeSsh;
  rpc: FakeRpc;
}

export function fakeServices(): FakeWorld {
  return {
    api: new FakeAkashApi(),
    provider: new FakeProviderGateway(),
    ssh: new FakeSsh(),
    rpc: new FakeRpc(),
    certs: { generate: async () => FAKE_CERT },
    // "encryption" placeholder: a plain tarball, so bundle round-trips are
    // testable (real adapter pipes tar through the age CLI)
    encryptBackup: async (src, _recipient, outFile) => {
      execFileSync("tar", ["czf", outFile, "-C", src, "."]);
    },
    sleep: async () => {},
  };
}

export class FakeSigner implements Signer {
  signed: Msg[][] = [];
  async sign(msgs: Msg[]): Promise<string> {
    this.signed.push(msgs);
    return `FAKETX${this.signed.length.toString().padStart(4, "0")}`;
  }
}
