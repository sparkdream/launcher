import fs from "node:fs";
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

  async latestBlockHeight(): Promise<number> {
    return (this.height += 10);
  }

  async listBids(_owner: string, dseq: string): Promise<Bid[]> {
    // every provider bids on everything; price varies by provider index
    return [...this.providers.keys()].map((provider, i) => ({
      bid: {
        bid_id: { owner: _owner, dseq, gseq: 1, oseq: 1, provider },
        state: "open",
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

  async leaseState(): Promise<string> {
    return "active";
  }
}

export class FakeProviderGateway {
  manifests: Array<{ hostUri: string; dseq: string }> = [];
  private portCounter = 30000;
  private assigned = new Map<string, { host: string; port: number }>();

  async sendManifest(_creds: MtlsCredentials, hostUri: string, dseq: string): Promise<void> {
    this.manifests.push({ hostUri, dseq });
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
      forwarded_ports: {
        sparkdreamd: [{ host: ep.host, port: 2222, externalPort: ep.port }],
      },
    };
  }
}

/** Simulates node-side state: uploads, mesh join, processes. */
export class FakeSsh {
  uploaded = new Set<string>();
  started = new Set<string>();
  signerConnected = true;
  execLog: Array<{ target: string; command: string }> = [];
  private ipCounter = 10;
  private ips = new Map<string, string>();

  private id(target: SshTarget): string {
    return `${target.host}:${target.port}`;
  }

  async exec(target: SshTarget, command: string): Promise<SshResult> {
    const id = this.id(target);
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

  async status(url: string) {
    const h = (this.heights.get(url) ?? 0) + 5;
    this.heights.set(url, h);
    return { latestBlockHeight: h, catchingUp: false };
  }

  async httpOk(): Promise<boolean> {
    return this.httpOkResult;
  }
}

const FAKE_CERT: Certificate = {
  certPem: "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n",
  keyPem: "-----BEGIN EC PRIVATE KEY-----\nFAKE\n-----END EC PRIVATE KEY-----\n",
  pubkeyPem: "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n",
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
    encryptBackup: async (_src, _recipient, outFile) => {
      fs.writeFileSync(outFile, "age-fake");
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
