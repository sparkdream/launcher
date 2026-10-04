import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Secp256k1HdWallet, type StdSignDoc } from "@cosmjs/amino";
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
import { templatePath } from "../src/vendor.js";
import type { LocalSignerHost, MeshCli, TmkmsProcess } from "../src/local-signer.js";
import type { AllowanceInfo, GrantInfo, UnattendedChain } from "../src/unattended.js";

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
      customDomain: true,
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

  /** dseqs the chain has no record of (a deployment that never took effect,
   *  or was pruned) — deploymentInfo answers undefined for them. */
  missingDseqs = new Set<string>();

  async deploymentInfo(
    _owner: string,
    dseq: string,
  ): Promise<{ state: string; hash?: string } | undefined> {
    if (this.missingDseqs.has(dseq)) return undefined;
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
  /** dseqs whose bids Akash has pruned (an order's bids disappear once it
   *  closes — the lease still exists, so callers must not treat the empty
   *  list as evidence of anything). */
  prunedBidDseqs = new Set<string>();

  async listBids(_owner: string, dseq: string): Promise<Bid[]> {
    this.knownDseqs.add(dseq); // every launched dseq shows up on-chain
    if (this.prunedBidDseqs.has(dseq)) return [];
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
  /** waitMode records the gate the pushed manifest carried, for the node
   *  manifests that have one (a stateless component's has none). */
  manifests: Array<{ hostUri: string; dseq: string; waitMode?: boolean }> = [];
  private portCounter = 30000;
  private assigned = new Map<string, { host: string; port: number }>();
  /** Wired by fakeServices: a node manifest push restarts the container,
   *  and the entrypoint then owns sparkdreamd — WAIT_FOR_CONFIG=false boots
   *  it, =true parks the container in wait mode. */
  onNodeManifest?: (sshId: string, waitMode: boolean) => void;

  /** Provider hostUris whose DNS/gateway is dead: every manifest send to them
   *  fails like a real unresolvable provider (send-manifests re-bids away). */
  unreachableProviders = new Set<string>();
  /** dseqs whose lease the provider already closed (manifest timeout): the
   *  gateway answers, but 404s the manifest PUT. */
  leaselessDseqs = new Set<string>();
  /** dseqs the chain has no record of at all — the provider looks them up
   *  and answers "Deployment not found". */
  deploymentNotFoundDseqs = new Set<string>();
  /** Wired by fakeServices to FakeAkashApi.deploymentHashes: emulate the
   *  provider's manifest version check — the PUT 422s unless sha256 of the
   *  manifest matches the deployment's on-chain hash. Inert for dseqs with
   *  no recorded hash, so tests that don't track hashes are unaffected. */
  onChainHash?: (dseq: string) => string | undefined;
  /** dseqs already running the manifest being PUT: a real provider refuses a
   *  PUT identical to what it runs ("nothing to redeploy") with the same
   *  HTTP 422 "manifest version validation failed" as a hash mismatch. Lets
   *  a test drive an upgrade re-run that already landed on the provider. */
  manifestUnchangedDseqs = new Set<string>();
  /** In-container localhost-RPC height for validator reads (upgrade verify,
   *  health monitor): advances on each /status read so a progress-based gate
   *  passes. dseqs in stalledDseqs report a frozen height, modelling a node
   *  that answers but is not making blocks. Shared with {@link FakeRpc} —
   *  see {@link FakeChainHeight}. */
  chain = new FakeChainHeight();
  stalledDseqs = new Set<string>();

  async sendManifest(
    _creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    manifestJson?: string,
  ): Promise<void> {
    if (this.unreachableProviders.has(hostUri)) {
      throw new Error(`getaddrinfo EAI_AGAIN ${new URL(hostUri).hostname}`);
    }
    if (this.leaselessDseqs.has(dseq)) {
      throw new Error(`provider PUT /deployment/${dseq}/manifest: HTTP 404 no lease for deployment`);
    }
    if (this.deploymentNotFoundDseqs.has(dseq)) {
      throw new Error(
        `provider PUT /deployment/${dseq}/manifest: HTTP 500 rpc error: code = NotFound desc = Deployment not found: key not found`,
      );
    }
    if (this.manifestUnchangedDseqs.has(dseq)) {
      throw new Error(
        `provider PUT /deployment/${dseq}/manifest: HTTP 422 manifest version validation failed`,
      );
    }
    const wantHash = this.onChainHash?.(dseq);
    if (wantHash && manifestJson) {
      const got = crypto.createHash("sha256").update(manifestJson).digest("base64");
      if (got !== wantHash) {
        throw new Error(
          `provider PUT /deployment/${dseq}/manifest: HTTP 422 manifest version validation failed`,
        );
      }
    }
    // a lease forwards the ports its deployment was created with: a later
    // manifest asking for another is refused (seen live on 2026-10-02)
    const first = this.lastManifest.get(dseq);
    if (manifestJson && first && !first.includes('"port":9090') && manifestJson.includes('"port":9090')) {
      throw new Error(
        `provider PUT /deployment/${dseq}/manifest: HTTP 422 manifest cross-validation error: group "dcloud": ` +
          'service "sparkdreamd": resource ID 1: over-utilized PORT endpoints',
      );
    }
    if (manifestJson) this.lastManifest.set(dseq, manifestJson);
    const gated = manifestJson?.includes("WAIT_FOR_CONFIG=")
      ? manifestJson.includes("WAIT_FOR_CONFIG=true")
      : undefined;
    this.manifests.push({ hostUri, dseq, ...(gated === undefined ? {} : { waitMode: gated }) });
    if (gated !== undefined) {
      const key = `${hostUri}/${dseq}`;
      if (!this.assigned.has(key)) {
        this.assigned.set(key, { host: new URL(hostUri).hostname, port: ++this.portCounter });
      }
      const ep = this.assigned.get(key)!;
      this.onNodeManifest?.(`${ep.host}:${ep.port}`, gated);
    }
  }

  /** Wired by fakeServices: the container log tail for a node, which is where
   *  a halting node's `halt per configuration height` line shows up. */
  onNodeLogs?: (sshId: string) => string | undefined;

  async leaseLogs(
    _creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    _gseq = 1,
    _oseq = 1,
    _tail = 100,
  ): Promise<string> {
    const ep = this.assigned.get(`${hostUri}/${dseq}`);
    const extra = ep ? this.onNodeLogs?.(`${ep.host}:${ep.port}`) : undefined;
    return `fake log line 1\nfake log line 2\n${extra ?? ""}`;
  }

  /** Simulate containers recycled out of band: the provider re-forwards every
   *  lease's ports, so the next leaseStatus hands out different external
   *  ones and whatever the launcher recorded no longer answers. */
  remapForwardedPorts(): void {
    this.assigned.clear();
  }

  async leaseStatus(_creds: MtlsCredentials, hostUri: string, dseq: string): Promise<unknown> {
    if (this.apiDownDseqs.has(dseq)) {
      throw new Error(`provider GET /lease/${dseq}/1/1/status: HTTP 503 dial tcp 10.233.0.1:443: connect: connection refused`);
    }
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
          // gRPC only once a pushed manifest exposes it (a relayer's public
          // route to a sister fleet on another mesh)
          ...(this.lastManifest.get(dseq)?.includes('"port":9090')
            ? [{ host: ep.host, port: 9090, externalPort: ep.port + 30000 }]
            : []),
        ],
      },
    };
  }

  /** Lease-shell exec — the headscale image has no sshd (mirrors FakeSsh). */
  shellLog: Array<{ dseq: string; script: string }> = [];
  /** Session keys delivered to daemons, keyed "<dseq>/<service>". */
  sessionKeys = new Map<string, string>();
  /** Session-key deliveries that fail before one succeeds (the container
   *  restarting after a deployment update). */
  sessionKeyNotReady = 0;
  /** headscale users created via lease-shell ("sparkdream" pre-seeded for
   *  tests that mint keys without running configure-headscale first). */
  private hsUsers: string[] = ["sparkdream"];
  /** Objects the headscale backup scripts wrote: bucket/key. */
  s3Objects = new Set<string>();
  /** The bucket refuses the credentials (uploads and litestream both fail). */
  s3Rejects = false;
  /** External (non-fleet) nodes reported by "headscale nodes list": the
   *  tmkms host, operator laptops. Tests set this to simulate a mesh join. */
  externalMeshNodes: { name: string; ipAddresses: string[]; online: boolean }[] = [];
  /** Mastodon instances by dseq: accounts created, registrations mode,
   *  bridge token, wallet sign-in chains (the image's mastodon-bootstrap,
   *  answered in memory). */
  mastodon = new Map<
    string,
    { accounts: Set<string>; registrations?: string; token?: string; loginChains?: Record<string, any> }
  >();
  /** Bootstrap calls that fail before one succeeds (instance still starting). */
  mastodonNotReady = 0;

  private mastodonBootstrap(dseq: string, args: string[]): { stdout: string; stderr: string } {
    if (this.mastodonNotReady > 0) {
      this.mastodonNotReady--;
      throw new Error("lease shell: exit 1: ActiveRecord::ConnectionNotEstablished");
    }
    const inst = this.mastodon.get(dseq) ?? { accounts: new Set<string>() };
    this.mastodon.set(dseq, inst);
    const [action, name] = args;
    const out = (o: unknown) => ({ stdout: `progress\n${JSON.stringify(o)}\n`, stderr: "" });
    if (action === "owner") {
      if (inst.accounts.has(name!)) return out({ created: false });
      inst.accounts.add(name!);
      return out({ created: true, password: `pw-${name}-${dseq}` });
    }
    if (action === "registrations") {
      inst.registrations = name;
      return out({ registrations: name });
    }
    if (action === "login-chain" && name === "sync") {
      inst.loginChains = JSON.parse(args[2]!);
      return out({ chains: Object.keys(inst.loginChains!).length });
    }
    if (action === "bridge-token") {
      inst.accounts.add(name!);
      inst.token ??= `token-${dseq}`;
      return out({ token: inst.token });
    }
    throw new Error(`lease shell: exit 2: mastodon-bootstrap ${action}`);
  }

  /** Deployments whose provider's API is down (status and lease-shell both
   *  fail) while the workload keeps running. */
  apiDownDseqs = new Set<string>();

  /** The last manifest each deployment received: what its containers run. */
  lastManifest = new Map<string, string>();

  /** A service's env as its deployment's last manifest set it. */
  private runningEnv(dseq: string, service: string): Record<string, string> {
    const raw = this.lastManifest.get(dseq);
    if (!raw) return {};
    const out: Record<string, string> = {};
    for (const group of JSON.parse(raw) as Array<{ services?: Array<{ name: string; env?: string[] | null }> }>) {
      for (const svc of group.services ?? []) {
        if (svc.name !== service) continue;
        for (const e of svc.env ?? []) {
          const i = e.indexOf("=");
          out[e.slice(0, i)] = e.slice(i + 1);
        }
      }
    }
    return out;
  }

  /** Uploaded media under public/system, by dseq (a resize carries it). */
  mastodonMedia = new Map<string, Buffer>();
  /** Files written through lease-shell, "<dseq>:<path>" -> contents. */
  private shellFiles = new Map<string, Buffer>();
  /** The restore's scratch database, by dseq. */
  private scratchDb = new Map<string, { accounts: string[]; token?: string } | null>();

  /**
   * Mastodon's data as the resize moves it (steps/mastodon-migrate.ts): a
   * dump is the instance's accounts and token as JSON, restored into a
   * scratch database and swapped in by the rename. Undefined when the
   * script is not one of these.
   */
  private mastodonData(dseq: string, script: string): { stdout: string; stderr: string } | undefined {
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    const file = (p: string) => `${dseq}:${p}`;
    let m: RegExpExecArray | null;
    if (/du -sb .*\/opt\/mastodon\/public\/system/.test(script)) return ok(String(this.mastodonMedia.get(dseq)?.length ?? 0));
    if (script.includes("pg_database_size")) return ok("16502107");
    if (/pg_dump .*\| base64 -w0/.test(script)) {
      const inst = this.mastodon.get(dseq);
      const dump = JSON.stringify({ accounts: [...(inst?.accounts ?? [])], token: inst?.token });
      return ok(Buffer.from(dump).toString("base64"));
    }
    if (/tar .*-czf - \. \| base64 -w0/.test(script)) return ok((this.mastodonMedia.get(dseq) ?? Buffer.alloc(0)).toString("base64"));
    if ((m = /^: > (\S+)$/.exec(script))) {
      this.shellFiles.set(file(m[1]!), Buffer.alloc(0));
      return ok();
    }
    if ((m = /^printf '%s' '([A-Za-z0-9+/=]*)' >> (\S+)$/.exec(script))) {
      const prev = this.shellFiles.get(file(m[2]!)) ?? Buffer.alloc(0);
      this.shellFiles.set(file(m[2]!), Buffer.concat([prev, Buffer.from(m[1]!)]));
      return ok();
    }
    if ((m = /^base64 -d (\S+) > (\S+) && rm -f \S+ && sha256sum \S+/.exec(script))) {
      const decoded = Buffer.from((this.shellFiles.get(file(m[1]!)) ?? Buffer.alloc(0)).toString(), "base64");
      this.shellFiles.set(file(m[2]!), decoded);
      return ok(crypto.createHash("sha256").update(decoded).digest("hex"));
    }
    if (script.includes("pg_isready")) return ok("ok");
    if (script.includes("CREATE DATABASE")) {
      this.scratchDb.set(dseq, null);
      return ok();
    }
    if ((m = /pg_restore .* -d \w+ (\S+)/.exec(script))) {
      const dump = this.shellFiles.get(file(m[1]!));
      this.scratchDb.set(dseq, dump ? JSON.parse(dump.toString()) : null);
      return ok();
    }
    if (script.includes("select count(*) from accounts")) return ok(String(this.scratchDb.get(dseq)?.accounts.length ?? 0));
    if (script.includes("RENAME TO")) {
      const restored = this.scratchDb.get(dseq);
      if (restored) this.mastodon.set(dseq, { accounts: new Set(restored.accounts), ...(restored.token ? { token: restored.token } : {}) });
      return ok();
    }
    if (/^test -d \/opt\/mastodon\/public\/system/.test(script)) return ok("ok");
    if ((m = /^tar -xzf (\S+) -C \/opt\/mastodon\/public\/system/.exec(script))) {
      this.mastodonMedia.set(dseq, this.shellFiles.get(file(m[1]!)) ?? Buffer.alloc(0));
      return ok();
    }
    return undefined;
  }

  /** dseq → KiB used on the node's data volume (`df`). */
  diskUsedKb = new Map<string, number>();

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
    if (this.apiDownDseqs.has(dseq)) throw new Error("lease shell: provider reported a failure (pod restarting?)");
    if (cmd[0] === "mastodon-bootstrap") return this.mastodonBootstrap(dseq, cmd.slice(1));
    // a node's data volume: 20 GiB, a quarter used unless a test says otherwise
    if (script.startsWith("df -Pk")) {
      const usedKb = this.diskUsedKb.get(dseq) ?? 5 * 1024 * 1024;
      const totalKb = 20 * 1024 * 1024;
      return {
        stdout:
          "Filesystem           1024-blocks    Used Available Capacity Mounted on\n" +
          `/dev/rbd3            ${totalKb} ${usedKb} ${totalKb - usedKb} ${Math.round((usedKb / totalKb) * 100)}% /root/.sparkdream\n`,
        stderr: "",
      };
    }
    const data = this.mastodonData(dseq, script);
    if (data) return data;
    // printing env vars (the bridge's delivered-env check): what the
    // deployment's last manifest gave the service
    if (/^(printf '%s\\n' "\$\w+"(; )?)+$/.test(script)) {
      const env = this.runningEnv(dseq, _service);
      const vars = [...script.matchAll(/"\$(\w+)"/g)].map((m) => env[m[1]!] ?? "");
      return { stdout: vars.map((v) => `${v}\n`).join(""), stderr: "" };
    }
    if (script.includes("/data/session-key")) {
      if (this.sessionKeyNotReady > 0) {
        this.sessionKeyNotReady--;
        throw new Error("lease shell: no active replicas for service");
      }
      // a daemon's session key, delivered (sessions.ts)
      const mnemonic = /printf '%s\\n' '([a-z ]+)'/.exec(script)?.[1];
      if (!mnemonic) throw new Error(`unexpected session-key script: ${script}`);
      this.sessionKeys.set(`${dseq}/${_service}`, mnemonic);
      return { stdout: "", stderr: "" };
    }
    // headscale mesh backup (mesh-backup.ts): runs on the env the container's
    // manifest gave it; a container running litestream has a replica
    if (script.includes("state-keys.tar.age") && script.includes("s5cmd") && script.includes(" cp ")) {
      const env = this.runningEnv(dseq, _service);
      if (!env.LITESTREAM_S3_BUCKET || !env.AGE_RECIPIENT) throw new Error("lease shell: exit 3: no backup env in this container");
      if (this.s3Rejects) throw new Error("lease shell: exit 1: ERROR \"cp\": AccessDenied");
      this.s3Objects.add(`${env.LITESTREAM_S3_BUCKET}/${env.LITESTREAM_S3_PATH}/state-keys.tar.age`);
      return { stdout: "seeded noise_private.key derp_server_private.key\n", stderr: "" };
    }
    if (script.includes("s5cmd") && script.includes(" ls ")) {
      const env = this.runningEnv(dseq, _service);
      const prefix = `${env.LITESTREAM_S3_BUCKET}/${env.LITESTREAM_S3_PATH}/`;
      const keys = [...this.s3Objects].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      if (env.LITESTREAM_S3_BUCKET && !this.s3Rejects) keys.push("generations/0a1b2c3d4e5f6a7b/snapshots/00000000.snapshot.lz4");
      return { stdout: keys.map((k) => `2026/10/03 12:00:00   1024  ${k}\n`).join(""), stderr: "" };
    }
    if (script.includes("kill 1")) throw new Error("lease shell: connection closed before result");
    if (script.includes("users create")) {
      const name = /users create (\S+)/.exec(script)?.[1];
      if (name && !this.hsUsers.includes(name)) this.hsUsers.push(name);
      return { stdout: "", stderr: "" };
    }
    if (script.includes("users list")) {
      return {
        stdout: JSON.stringify(this.hsUsers.map((name, i) => ({ id: i + 1, name }))),
        stderr: "",
      };
    }
    if (script.includes("nodes list")) {
      return { stdout: JSON.stringify(this.externalMeshNodes), stderr: "" };
    }
    if (script.includes("preauthkeys create")) {
      // mirrors the real CLI: --user must be the numeric id, not a name
      if (!/--user \d+/.test(script)) {
        throw new Error('lease shell: exit 1: invalid argument for "-u, --user" flag: strconv.ParseUint');
      }
      return { stdout: JSON.stringify({ key: `hskey-${this.shellLog.length}` }), stderr: "" };
    }
    if (script.includes("SELECT count(*) FROM users")) return { stdout: "1", stderr: "" };
    if (script.includes("127.0.0.1:26657/status")) {
      const height = this.stalledDseqs.has(dseq) ? this.chain.frozen(dseq) : this.chain.next();
      return {
        stdout: `{"result":{"sync_info":{"latest_block_height":"${height}","catching_up":false}}}`,
        stderr: "",
      };
    }
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
  /** Commands that go unanswered wherever they are sent: the endpoint
   *  completes a handshake and then says nothing, which is what a forwarded
   *  port left pointing at a re-created container does — and what a poll
   *  cannot tell apart from a node that is down. */
  mutedCommands: RegExp[] = [];
  /** Containers whose entrypoint owns sparkdreamd on a home that was never
   *  filled: with no config the SDK writes a default app.toml, refuses its
   *  empty minimum-gas-prices and exits. sparkdreamd is PID 1, so the
   *  provider restarts it forever and lease-shell finds no replica — which is
   *  what makes an un-gated deployment on a fresh volume unrecoverable
   *  (upload-node-data can never get in to deliver the config). */
  crashLooping = new Set<string>();
  /** What `tailscale ping` reports (unjail latency guard). */
  pingOutput = "pong from val-0 (100.64.0.10) via 10.0.0.1:41641 in 12ms";
  /** host:port whose old container still answers after close (zombie check). */
  zombieHosts = new Set<string>();
  /** When true, every node reports "not on the mesh" until await-mesh's
   *  IPv6-black-hole remediation re-runs `tailscale up` on it (models a dead
   *  IPv6 route to headscale that the /etc/hosts IPv4 pin works around). */
  ipv6BlackHole = false;
  /** When false, the IPv4 pin + re-up does NOT clear the black hole (models a
   *  genuinely dead path, so the node never joins and await-mesh must report). */
  rejoinClearsBlackHole = true;
  /** When true, the reachability probe reports headscale unreachable (models
   *  provider egress filtering — distinct from the IPv6 black hole). */
  unreachableHeadscale = false;
  /** Consensus pubkey /status reports in validator_info (the tmkms key-match
   *  check). Unset → the answer carries no validator_info (unknown, never a
   *  mismatch). */
  statusConsensusPubkey: string | null = null;

  /**
   * ssh id → the height its local RPC reports, for a node that answers every
   * probe while no longer following the chain (a consensus panic leaves the
   * RPC up). Anything not listed sits at the fleet's height.
   */
  stoppedHeights = new Map<string, number>();

  /** Shared with the other fake RPC paths — see {@link FakeChainHeight}. */
  chain = new FakeChainHeight();
  /** When true, validators' config.toml still references the pre-rekey IPs
   *  (headscale relaunch's rewire probe). */
  configHasStaleIp = false;
  /** persistent_peers value in a node's config.toml, per host:port. Unset →
   *  the node has no such line (probes that read it simply find nothing). */
  configPeers = new Map<string, string>();
  /** A node's app.toml, per host:port, once something uploads one. Unset →
   *  the node serves the vendored sentry template (LCD off), which is what a
   *  fleet launched without LCD consumers carries. */
  appToml = new Map<string, string>();
  /** Text files uploaded to each container, by `host:port|remotePath`. */
  files = new Map<string, string>();
  /** Relayer: chain ids whose key relayer-fundcheck reports as unfunded. */
  unfundedChains = new Set<string>();
  /** Relayer: containers holding the ready marker (hermes running). */
  relayerReady = new Set<string>();
  /** Relayer: container restarts so far, per target (PID 1's start time). */
  relayerBoots = new Map<string, number>();
  /** Relayer targets on the old image, whose PID 1 (hermes) ignores `kill 1`. */
  relayerIgnoresTerm = new Set<string>();
  /** Relayer: channel ids per path id per container — stable across
   *  re-runs, since bringup reuses what is open. */
  private relayChannels = new Map<string, unknown>();
  /** Relayer: how many times bringup opened a path afresh. */
  relayOpens = 0;
  /** Node resize: old nodes running on generated keys since their retire
   *  restart (their status then reports another node ID). */
  retired = new Set<string>();
  /** Nodes that ignore the retire: still the real node after the restart. */
  retireIgnored = new Set<string>();
  /** When true, a stopped SSH-started node stays behind as a zombie (wait
   *  mode, where PID 1 is a `tail` that never reaps). */
  leavesZombies = false;
  private zombies = new Set<string>();
  /** Signing state a node's priv_validator_state.json holds. */
  signingState = '{"height":"1000123","round":0,"step":3}';
  /** host:port → `du -sm` of the node's data dir (resize storage guard). */
  dataUsageMb = new Map<string, number>();
  /** Chain-data backups: what TOOLS_PROBE reports missing ("" = all there). */
  backupToolsMissing = "";
  /** Nodes whose data volume holds a launcher hold file. */
  holds = new Set<string>();
  /** Containers restarted under a hold: the entrypoint is waiting, the node is not running. */
  heldContainers = new Set<string>();
  containerRestarts = new Map<string, number>();
  /** The bucket chain-data backups land in: bucket/prefix/name. */
  s3Objects = new Set<string>();
  backupFails = false;
  /** Backup/restore scripts die with their container on these nodes (/tmp emptied, no status). */
  scriptsDie = new Set<string>();
  /** Nodes whose container runs in wait mode (PID 1 is a tail). */
  waitMode = new Set<string>();
  /** Launcher scripts stopped, by `host:port|name`. */
  stoppedScripts: string[] = [];
  backupStatus = new Map<string, string>();
  restoreStatus = new Map<string, string>();
  /** node → the backup restored into it. */
  restoredFrom = new Map<string, string>();
  private envFile(id: string, file: string): Record<string, string> {
    const text = this.files.get(`${id}|${file}`) ?? "";
    const out: Record<string, string> = {};
    for (const m of text.matchAll(/^export (\w+)='(.*)'$/gm)) out[m[1]!] = m[2]!;
    return out;
  }
  /** host:port → polls its status still reports catching up (a resize's
   *  staged node syncing). */
  syncingPolls = new Map<string, number>();
  /** Block archive files sitting on a node (restore op), per host:port. */
  archiveFiles = new Map<string, number>();
  /** Nodes holding an uploaded tarball the restore op can unpack. */
  archiveTarballs = new Set<string>();
  /** Exit code the detached replay writes (non-zero = a failed replay). */
  replayExit = 0;
  /** Polls the replay reports RUNNING before it writes that exit code. */
  replayPolls = 2;
  private replaying = new Map<string, number>();
  private rejoined = new Set<string>();
  execLog: Array<{ target: string; command: string }> = [];
  private ipCounter = 10;
  private ips = new Map<string, string>();
  /** halt-height currently configured per node (0 = none). */
  private haltHeights = new Map<string, number>();
  /** Nodes that booted into their halt height and stopped there. */
  private haltedAt = new Map<string, number>();
  /** Fired when a node halts or is released, so the RPC fake can go dark the
   *  way a stopped node's endpoint does. */
  onHaltChange?: (haltedCount: number) => void;

  private noteHalt(): void {
    this.onHaltChange?.(this.haltedAt.size);
  }

  /** Nodes currently stopped at their halt height. */
  haltedNodes(): string[] {
    return [...this.haltedAt.keys()];
  }

  /** The halt line a halting node reprints on every crash-loop lap, as the
   *  provider's log tail would carry it. */
  haltLogFor(id: string): string | undefined {
    const h = this.haltedAt.get(id);
    return h === undefined ? undefined : `ERR halt per configuration height ${h} time 0\n`;
  }

  /** Attempts made against each crash-looping node, so the fake can refuse
   *  the ones that land in the restart backoff. */
  private haltingExecs = new Map<string, number>();
  /** What `sparkdreamd version` reports per node. Unset → the node answers
   *  nothing, the case where repair must keep the recorded image. */
  nodeVersions = new Map<string, string>();

  /** Simulate a mesh re-key: previously assigned tailnet IPs are forgotten,
   *  so the next `ip -4` per target hands out fresh ones. */
  remapTailnetIps(): void {
    this.ips.clear();
  }

  private id(target: SshTarget): string {
    return `${target.host}:${target.port}`;
  }

  async exec(target: SshTarget, command: string): Promise<SshResult> {
    const id = this.id(target);
    if (this.failHosts.has(id)) throw new Error(`connect ECONNREFUSED ${id}`);
    for (const re of this.mutedCommands) {
      if (re.test(command)) throw new Error(`ssh timeout after 20000ms: ${command}`);
    }
    if (this.crashLooping.has(id)) {
      throw new Error(`ssh exit 1 (via lease-shell): lease shell: no active replicas for service`);
    }
    // A halted node is a crash loop, not a stopped process: sparkdreamd is
    // PID 1, so the container exits and the provider restarts it. SSH answers
    // only inside a boot window — model that as every other attempt landing in
    // the restart backoff, where a real provider reports no replicas at all.
    if (this.haltedAt.has(id)) {
      const n = (this.haltingExecs.get(id) ?? 0) + 1;
      this.haltingExecs.set(id, n);
      if (n % 2 === 1) {
        throw new Error(`ssh exit 1 (via lease-shell): lease shell: no active replicas for service`);
      }
    }
    this.execLog.push({ target: id, command });
    const ok = (stdout = ""): SshResult => ({ stdout, code: 0 });

    // --- chain-data backups (data-backup.ts) and the entrypoint's hold ---
    if (command.includes("command -v $t")) return ok(this.backupToolsMissing);
    if (command.includes(".launcher-hold")) {
      if (command.startsWith("test -f")) return ok(this.holds.has(id) ? "held" : "");
      if (command.startsWith("rm -f")) {
        this.holds.delete(id);
        // the entrypoint's hold loop ends and it starts the node
        if (this.heldContainers.delete(id)) this.started.add(id);
        return ok();
      }
      this.holds.add(id);
      return ok();
    }
    if (command.includes("kill -TERM 1")) {
      // the container restarts; under a hold the entrypoint leaves the node stopped
      this.containerRestarts.set(id, (this.containerRestarts.get(id) ?? 0) + 1);
      this.started.delete(id);
      // a new container: /tmp starts empty
      this.backupStatus.delete(id);
      this.restoreStatus.delete(id);
      if (this.holds.has(id)) this.heldContainers.add(id);
      else this.started.add(id);
      return ok();
    }
    if (command.includes("localhost:26657/status")) {
      return ok(`{"result":{"sync_info":{"latest_block_height":"${this.chain.next()}"}}}`);
    }
    // the PID 1 probe (restartNode, the hold) answers only for wait mode; other
    // nodes keep the default, which restartNode reads as "node is a child"
    if (command === "cat /proc/1/comm 2>/dev/null || true" && this.waitMode.has(id)) return ok("tail");
    const script = /\/tmp\/(sd-backup|sd-restore)\.pid/.exec(command)?.[1];
    if (script && command.includes("kill -TERM --")) {
      this.stoppedScripts.push(`${id}|${script}`);
      (script === "sd-backup" ? this.backupStatus : this.restoreStatus).set(id, "failed");
      return ok("stopped");
    }
    if (script && command.includes("kill -0")) {
      const status = (script === "sd-backup" ? this.backupStatus : this.restoreStatus).get(id);
      return ok(`${status || "none"} ${status === "running" ? "alive" : "dead"}`);
    }
    if (command.includes("bash /tmp/sd-backup.sh")) {
      const env = this.envFile(id, "/tmp/sd-backup.env");
      if (this.started.has(id)) throw new Error("fake: backup taken while the node runs");
      if (this.scriptsDie.has(id)) this.backupStatus.delete(id);
      else if (this.backupFails) this.backupStatus.set(id, "failed");
      else {
        this.s3Objects.add(`${env.S3_BUCKET}/${env.S3_PREFIX}/${env.NAME}`);
        this.backupStatus.set(id, "done");
      }
      return ok();
    }
    if (command.includes("bash /tmp/sd-restore.sh")) {
      const env = this.envFile(id, "/tmp/sd-restore.env");
      if (this.started.has(id)) throw new Error("fake: restore into a running node");
      const object = `${env.S3_BUCKET}/${env.S3_PREFIX}/${env.NAME}`;
      if (this.scriptsDie.has(id)) this.restoreStatus.delete(id);
      else if (this.s3Objects.has(object)) {
        this.restoredFrom.set(id, env.NAME!);
        this.restoreStatus.set(id, "done");
      } else this.restoreStatus.set(id, "failed");
      return ok();
    }

    // --- node resize: retire / un-retire, signing state, data usage ---
    if (command.includes("resize_retired_node_key") && command.includes("printf")) {
      if (!this.retireIgnored.has(id)) this.retired.add(id);
      return ok();
    }
    if (command.includes("resize_retired_node_key") && command.includes("echo restored")) {
      const was = this.retired.delete(id);
      return ok(was ? "restored" : "");
    }
    if (command.startsWith("cat ") && command.includes("priv_validator_state.json")) {
      return ok(this.signingState);
    }
    if (command.startsWith("du -sm")) {
      const mb = this.dataUsageMb.get(id);
      return ok(mb === undefined ? "" : String(mb));
    }

    // --- relayer container (deploy/docker/hermes in the chain repo) ---
    const manifest = () =>
      JSON.parse(this.files.get(`${id}|/data/relayer/relayer.json`) ?? '{"chains":[],"paths":[]}') as {
        chains: Array<{ id: string }>;
        paths: Array<{ id: string; a: string; b: string; port: string; version: string }>;
      };
    if (command === "relayer-bringup --keys-only") return ok();
    if (command === "relayer-fundcheck || true") {
      return ok(
        JSON.stringify(
          manifest().chains.map((c) => {
            const funded = !this.unfundedChains.has(c.id);
            return { chain: c.id, address: "", balance: funded ? "1000000" : "0", denom: "", account: null, ready: funded };
          }),
        ),
      );
    }
    if (command === "relayer-bringup") {
      const m = manifest();
      const out = m.paths.map((p, i) => {
        const key = `${id}|${p.id}`;
        if (!this.relayChannels.has(key)) {
          this.relayOpens++;
          this.relayChannels.set(key, {
            id: p.id,
            port: p.port,
            version: p.version,
            a: { chain: p.a, client: "07-tendermint-0", connection: "connection-0", channel: `channel-${i}` },
            b: { chain: p.b, client: "07-tendermint-0", connection: "connection-0", channel: `channel-${i}` },
          });
        }
        return this.relayChannels.get(key);
      });
      return ok(JSON.stringify(out));
    }
    if (command === "test -f /data/relayer/ready && echo running || true") {
      return ok(this.relayerReady.has(id) ? "running" : "");
    }
    if (command.startsWith("pgrep -x hermes")) {
      return ok(this.relayerReady.has(id) ? "relaying" : "unlinked");
    }
    if (command === "awk '{print $22}' /proc/1/stat") {
      return ok(String(1000 + (this.relayerBoots.get(id) ?? 0)));
    }
    if (command.startsWith("setsid sh -c 'sleep 1; kill 1'")) {
      if (!this.relayerIgnoresTerm.has(id)) this.relayerBoots.set(id, (this.relayerBoots.get(id) ?? 0) + 1);
      return ok();
    }
    if (command === "touch /data/relayer/ready") {
      this.relayerReady.add(id);
      return ok();
    }

    if (/^cat \S+\/config\/app\.toml$/.test(command)) {
      return ok(this.appToml.get(id) ?? fs.readFileSync(templatePath("app.toml.sentry"), "utf8"));
    }

    // --- restore op: archive discovery, the detached replay, its poll ---
    if (command.includes("echo NONE")) {
      const n = this.archiveFiles.get(id) ?? 0;
      return ok(n > 0 ? `DIR /root/.sparkdream/archives ${n}` : "NONE");
    }
    if (command.includes("tar tzf")) {
      // an uploaded tarball unpacks into the archive dir
      if (!this.archiveTarballs.has(id)) return ok();
      this.archiveFiles.set(id, 3);
      return ok("unpacked /root/.sparkdream/archives.tar.gz");
    }
    // the archive file names, which is where the replay's target height
    // comes from: one 1000-block file per archive the node holds
    if (command.startsWith("ls ") && command.includes("blocks_*_to_*")) {
      const n = this.archiveFiles.get(id) ?? 0;
      return ok(
        Array.from(
          { length: n },
          (_, i) => `/root/.sparkdream/archives/blocks_${i * 1000 + 1}_to_${(i + 1) * 1000}.jsonl.gz`,
        ).join("\n"),
      );
    }
    if (command.includes("replay-from-archive --home")) {
      this.replaying.set(id, this.replayPolls);
      return ok();
    }
    if (command.includes("replay[-]from-archive")) {
      const left = this.replaying.get(id);
      if (left === undefined) return ok(); // nothing running, no exit code yet
      if (left > 0) {
        this.replaying.set(id, left - 1);
        // climbing, as a real replay's does: the op measures a rate off it
        const height = 1000 * (this.replayPolls - left + 1);
        return ok(`RUNNING\nINF Replay progress height=${height} blocks_replayed=100`);
      }
      this.replaying.delete(id);
      return ok(`EXIT ${this.replayExit}`);
    }

    if (command.includes("test -f") && command.includes(".node-data-uploaded")) {
      return ok(this.uploaded.has(id) ? "yes" : "no");
    }
    if (command.includes("tar xzf")) {
      this.uploaded.add(id);
      return ok();
    }
    if (command.includes("echo zombie-probe")) {
      // a torn-down lease answers with empty success on some gateways
      return ok(this.zombieHosts.has(id) ? "zombie-probe" : "");
    }
    if (command.includes("tailscale") && command.includes(" ping ")) {
      return ok(this.pingOutput);
    }
    if (command.includes("tailscale") && command.includes("ip -4")) {
      // black-holed until the IPv4 pin + re-up remediation runs on this node
      if (this.ipv6BlackHole && !this.rejoined.has(id)) return ok("");
      if (!this.ips.has(id)) this.ips.set(id, `100.64.0.${this.ipCounter++}`);
      return ok(this.ips.get(id)!);
    }
    // mesh re-key (headscale relaunch): config.toml peer-IP presence probe
    if (command.includes("grep -c") && command.includes("config.toml")) {
      return ok(this.configHasStaleIp ? "1" : "0");
    }
    // persistent_peers on the volume (the repoint op reads it, repairs stale
    // tailnet addresses in it, and writes the whole line back)
    if (command.includes("grep '^persistent_peers")) {
      const peers = this.configPeers.get(id);
      // the real file also carries persistent_peers_max_dial_period; the
      // launcher's pattern anchors on the assignment so it never comes back
      return ok(peers === undefined ? "" : `persistent_peers = "${peers}"`);
    }
    if (command.includes("sed -i 's|^persistent_peers")) {
      const next = /persistent_peers = "(.*)"\|/.exec(command);
      if (next) this.configPeers.set(id, next[1]!);
      return ok();
    }
    // await-mesh remediation: resolve headscale's IPv4 (the piped awk result)
    if (command.includes("nslookup")) return ok("104.21.47.136");
    // re-up after pinning IPv4 → this node can now join the mesh
    if (command.includes("tailscale") && command.includes(" up ")) {
      if (this.rejoinClearsBlackHole) this.rejoined.add(id);
      return ok();
    }
    // reachability probe (await-mesh's descriptive failure) — reachable by default
    if (command.includes("/health") && command.includes("REACH_OK")) {
      return ok(this.unreachableHeadscale ? "REACH_FAIL" : "REACH_OK");
    }
    if (command.includes("preauthkeys create")) {
      return ok(JSON.stringify({ key: `hskey-${this.execLog.length}` }));
    }
    if (command.includes("SELECT count(*) FROM users")) return ok("1");
    if (command.includes("netstat -tn") && command.includes("26660")) {
      // signer-connected probe (await-signer, /tmkms/status): count of
      // established privval sessions through the keepalive proxy
      return ok(this.signerConnected ? "1" : "0");
    }
    if (command.includes("127.0.0.1:26657/status")) {
      // sync gates (phase-g bond gate, unjail op) read the node's local RPC;
      // the tmkms key-match check reads validator_info (present only while a
      // signer holds the privval session — modelled by the knob)
      const validatorInfo = this.statusConsensusPubkey
        ? `,"validator_info":{"pub_key":{"value":"${this.statusConsensusPubkey}"}}`
        : "";
      const syncing = this.syncingPolls.get(id) ?? 0;
      if (syncing > 0) this.syncingPolls.set(id, syncing - 1);
      const height = syncing > 0 ? 1000 * (10 - syncing) : (this.stoppedHeights.get(id) ?? this.chain.next());
      // a retired node runs under a node key it generated itself
      const nodeInfo = this.retired.has(id)
        ? `"node_info":{"protocol_version":{"p2p":"8","block":"11"},"id":"${"e".repeat(40)}"},`
        : "";
      return ok(
        `{"result":{${nodeInfo}"sync_info":{"latest_block_height":"${height}","catching_up":${syncing > 0}}${validatorInfo}}}`,
      );
    }
    if (command.includes("nc -z 127.0.0.1 26660")) {
      // the privval backend listener belongs to sparkdreamd (the entrypoint's
      // keepalive proxy on 26659 only forwards to it), so the port is closed
      // whenever the node is not running — a container in wait mode answers
      // "no" no matter how the signer is configured
      return ok(this.started.has(id) ? "ok" : "no");
    }
    // --- halt-height: the sed that configures it, the probe that reads it ---
    if (command.includes("halt-height =")) {
      const n = Number(/halt-height = (\d+)/.exec(command)?.[1] ?? 0);
      this.haltHeights.set(id, n);
      if (n === 0) {
        this.haltedAt.delete(id);
        this.noteHalt();
      }
      return ok();
    }
    // a chain query run on the node against its own RPC: answered by the
    // same stub binary the tests point the launcher's local CLI at
    if (/^sparkdreamd '?query'? /.test(command)) {
      const bin = process.env.SPARKDREAMD_BIN;
      if (!bin) throw new Error(`no SPARKDREAMD_BIN stub for: ${command}`);
      return ok(execFileSync("sh", ["-c", `${bin} ${command.slice("sparkdreamd ".length)}`], { encoding: "utf8" }));
    }
    if (command.includes("sparkdreamd version")) {
      const v = this.nodeVersions.get(id);
      return ok(v === undefined ? "" : v);
    }
    if (command.includes("pgrep -x sparkdreamd")) {
      // a zombie still matches pgrep; only a probe reading /proc/<pid>/stat
      // tells it from a running node
      const zombie = this.zombies.has(id) && !command.includes("/stat");
      return ok(this.started.has(id) || zombie ? "yes" : "no");
    }
    if (command.includes("pkill -x sparkdreamd")) {
      if (this.leavesZombies && this.started.has(id)) this.zombies.add(id);
      this.started.delete(id);
      return ok();
    }
    if (command.includes("sparkdreamd start")) {
      const halt = this.haltHeights.get(id) ?? 0;
      if (halt > 0) {
        // boots, runs up to the configured height, refuses that block and
        // exits — which is why restarting a halted node never brings it back
        this.haltedAt.set(id, halt);
        this.noteHalt();
        return ok();
      }
      this.started.add(id);
      return ok();
    }
    // sed / kill / pkill / socat / users create / nc verify — all fine
    return ok();
  }

  async upload(target: SshTarget, localPath: string, remotePath?: string): Promise<void> {
    if (!fs.existsSync(localPath)) throw new Error(`upload source missing: ${localPath}`);
    // a node-data bundle carries the node's rendered app.toml: what the
    // node runs from here on, as on a real container after tar xzf
    if (remotePath === "/tmp/node-data.tgz" && localPath.endsWith(".tgz")) {
      try {
        const app = execFileSync("tar", ["-xzOf", localPath, "config/app.toml"], { encoding: "utf8" });
        if (app) this.appToml.set(this.id(target), app);
      } catch {
        // a test bundle without one: the template default stands
      }
    }
    if (remotePath?.endsWith("/config/app.toml")) {
      this.appToml.set(this.id(target), fs.readFileSync(localPath, "utf8"));
    }
    if (remotePath && /\.(toml|json|mnemonic|env|age|sh)$/.test(remotePath)) {
      this.files.set(`${this.id(target)}|${remotePath}`, fs.readFileSync(localPath, "utf8"));
    }
  }

  async download(_target: SshTarget, _remote: string, localPath: string): Promise<void> {
    fs.writeFileSync(localPath, "fake");
  }
}

/**
 * The one chain height behind every fake RPC path.
 *
 * A fleet's nodes all follow the same chain, so the height a sentry serves
 * on its forwarded port ({@link FakeRpc}) and the one a validator serves to
 * an in-container read ({@link FakeProviderGateway.shellExec}) have to stay
 * within a block or two of each other. They used to come from unrelated
 * counters, which is invisible to a check that reads one node but not to the
 * health monitor, which compares them: a fleet whose fake sentry sat at 10
 * while its fake validator sat at a million looked like a dead sentry.
 *
 * A dseq frozen through `stalledDseqs` keeps the height of its last read
 * while the rest of the fleet moves on — a node that answers but has stopped
 * making blocks.
 */
export class FakeChainHeight {
  private h = 1_000_000;
  private frozenAt = new Map<string, number>();

  next(): number {
    return ++this.h;
  }

  /** Height for a node that has stopped: pinned the first time it is read. */
  frozen(id: string): number {
    const at = this.frozenAt.get(id) ?? this.h;
    this.frozenAt.set(id, at);
    return at;
  }
}

export class FakeRpc {
  /** Shared with {@link FakeProviderGateway} — see {@link FakeChainHeight}. */
  chain = new FakeChainHeight();
  httpOkResult = true;
  /** Docker Hub tag probe — 200 = image exists (validate-spec fail-fast). */
  httpStatusResult = 200;

  async httpStatus(_url: string): Promise<number> {
    return this.httpStatusResult;
  }

  /** While the chain is halted every node has stopped, so nothing serves RPC:
   *  the probe fails outright rather than returning a stale height. */
  chainHalted = false;

  /**
   * URL fragment → the height that node's RPC is pinned at, and whether it
   * admits to catching up. Models a node that answers every probe while no
   * longer following the chain, which is how a consensus panic looks from
   * outside: the RPC stays up at the height the state machine died on.
   */
  stoppedHeights = new Map<string, { height: number; catchingUp: boolean }>();

  async status(url: string) {
    if (this.chainHalted) throw new Error(`rpc ${url}/status: connect ECONNREFUSED`);
    for (const [fragment, at] of this.stoppedHeights) {
      if (url.includes(fragment)) {
        return { latestBlockHeight: at.height, catchingUp: at.catchingUp };
      }
    }
    return { latestBlockHeight: this.chain.next(), catchingUp: false };
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
  const ssh = new FakeSsh();
  const provider = new FakeProviderGateway();
  const api = new FakeAkashApi();
  const rpc = new FakeRpc();
  // one chain behind all three RPC paths: forwarded port, lease shell, SSH
  rpc.chain = provider.chain;
  ssh.chain = provider.chain;
  provider.onChainHash = (dseq) => api.deploymentHashes.get(dseq);
  provider.onNodeManifest = (sshId, waitMode) => {
    if (waitMode) {
      ssh.started.delete(sshId);
      ssh.crashLooping.delete(sshId);
    } else {
      ssh.started.add(sshId);
      // the entrypoint boots the node itself now: on a volume nobody has
      // uploaded to, that is a crash loop, not a running node
      if (!ssh.uploaded.has(sshId)) ssh.crashLooping.add(sshId);
    }
  };
  // a halted node stops serving RPC — the coupling that makes a height probe
  // useless for detecting a deliberate halt
  ssh.onHaltChange = (halted) => {
    rpc.chainHalted = halted > 0;
  };
  // ...and prints its halt line to the container log, the one stream that
  // outlives the restarts
  provider.onNodeLogs = (sshId) => ssh.haltLogFor(sshId);
  return {
    api,
    provider,
    ssh,
    rpc,
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
  /** Apply to chain state what a CONFIRMED tx does (deployment versions,
   *  lease states). requireTx only returns once the tx confirms, so a step
   *  that signs and then pushes really does meet a chain that has moved —
   *  tests whose steps depend on that ordering wire this up. */
  onSigned?: (msgs: Msg[]) => void;
  async sign(msgs: Msg[]): Promise<string> {
    this.signed.push(msgs);
    this.onSigned?.(msgs);
    return `FAKETX${this.signed.length.toString().padStart(4, "0")}`;
  }
}

/**
 * Keplr's response shape, verbatim from its source: the background keyring
 * returns the signed doc after this recursive alphabetical key sort
 * (keplr-wallet packages/common/src/json/sort.ts, applied in
 * keyring-cosmos/service.ts). Amino sign bytes are sorted JSON either way,
 * so a signature cosmjs produced over the original doc is valid over the
 * sorted one — exactly as with Keplr.
 */
export function keplrSortObjectByKey(obj: any): any {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(keplrSortObjectByKey);
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  sortedKeys.forEach((key) => {
    result[key] = keplrSortObjectByKey(obj[key]);
  });
  return result;
}

/**
 * Keplr-faithful signAmino for tests: cosmjs produces the signature, and
 * the response carries the key-sorted doc exactly as the real extension
 * returns it — a plain cosmjs response would not exercise the conductor's
 * drift check the way Keplr does.
 */
export async function keplrSignAmino(
  wallet: Secp256k1HdWallet,
  address: string,
  signDocJson: string,
): Promise<string> {
  const signDoc = JSON.parse(signDocJson) as StdSignDoc;
  const { signature } = await wallet.signAmino(address, signDoc);
  return JSON.stringify({ signed: keplrSortObjectByKey(signDoc), signature });
}

/**
 * The launcher's own machine for a managed tmkms signer (local-signer.ts):
 * files, processes, systemd user units and Tailscale CLIs, all in memory.
 * `onRestart` runs on every (re)start of a unit, which is where a test
 * decides whether the signer now holds a session (FakeSsh.signerConnected).
 */
export class FakeSignerHost implements LocalSignerHost {
  files = new Map<string, string>();
  procs: TmkmsProcess[] = [];
  units = new Map<string, { contents: string; active: boolean }>();
  restarts: string[] = [];
  killed: number[] = [];
  meshUps: { cli: string; args: string[] }[] = [];
  clis: MeshCli[] = [];
  onRestart?: (unit: string) => void;
  private nextPid = 5000;

  async processes() {
    return this.procs.map((p) => ({ ...p }));
  }
  async readFile(file: string) {
    const text = this.files.get(file);
    if (text === undefined) throw new Error(`ENOENT: ${file}`);
    return text;
  }
  async writeFile(file: string, text: string) {
    const prev = this.files.get(file);
    if (prev !== undefined) this.files.set(`${file}.bak`, prev);
    this.files.set(file, text);
  }
  async exists(file: string) {
    return this.files.has(file);
  }
  async rename(from: string, to: string) {
    const text = await this.readFile(from);
    this.files.delete(from);
    this.files.set(to, text);
  }
  async installUnit(unit: string, contents: string) {
    this.units.set(unit, { contents, active: this.units.get(unit)?.active ?? false });
  }
  async unitActive(unit: string) {
    return this.units.get(unit)?.active ?? false;
  }
  private up(unit: string) {
    const u = this.units.get(unit);
    if (!u) throw new Error(`Unit ${unit} not found.`);
    u.active = true;
    // the unit's process, as /proc would show it; an operator's own unit
    // (a wrapper script, say) keeps the process the test gave it
    const exec = /^ExecStart="([^"]+)" start -c "([^"]+)"$/m.exec(u.contents) ?? /^ExecStart=(\S+) start -c (\S+)$/m.exec(u.contents);
    const cwd = /^WorkingDirectory=(.+)$/m.exec(u.contents)?.[1];
    if (exec && cwd) {
      this.procs = this.procs.filter((p) => p.unit !== unit);
      this.procs.push({ pid: this.nextPid++, bin: exec[1]!, cwd, config: exec[2]!, unit });
    }
    this.restarts.push(unit);
    this.onRestart?.(unit);
  }
  async startUnit(unit: string) {
    this.up(unit);
  }
  async restartUnit(unit: string) {
    this.up(unit);
  }
  async stopUnit(unit: string) {
    const u = this.units.get(unit);
    if (u) u.active = false;
    this.procs = this.procs.filter((p) => p.unit !== unit);
  }
  async kill(pid: number) {
    this.killed.push(pid);
    this.procs = this.procs.filter((p) => p.pid !== pid);
  }
  async unitLog() {
    return "";
  }
  async meshClis() {
    return this.clis;
  }
  /** When set, `tailscale up` fails the way exec.ts reports it: with the whole command line. */
  meshUpFails = false;
  async meshUp(cli: string, args: string[]) {
    if (this.meshUpFails) throw new Error(`${cli} ${args.join(" ")} exited 1: backend error`);
    this.meshUps.push({ cli, args });
  }
}

/** Akash authz for unattended recovery (unattended.ts): grants on a map, MsgExec recorded. */
export class FakeUnattendedChain implements UnattendedChain {
  grantsByPair = new Map<string, GrantInfo[]>();
  allowances = new Map<string, AllowanceInfo>();
  execs: { granter: string; msgs: Msg[] }[] = [];
  async grants(granter: string, grantee: string): Promise<GrantInfo[]> {
    return this.grantsByPair.get(`${granter}/${grantee}`) ?? [];
  }
  async allowance(granter: string, grantee: string): Promise<AllowanceInfo | null> {
    return this.allowances.get(`${granter}/${grantee}`) ?? null;
  }
  async exec(_mnemonic: string, granter: string, msgs: Msg[]): Promise<string> {
    this.execs.push({ granter, msgs });
    return this.execs.length.toString(16).padStart(64, "e");
  }
  /** Everything a grant covers, for granter → grantee, expiring in `days`. */
  grantAll(granter: string, grantee: string, types: readonly string[], days = 30): void {
    const expiration = new Date(Date.now() + days * 86_400_000).toISOString();
    this.grantsByPair.set(`${granter}/${grantee}`, types.map((msgType) => ({ msgType, expiration })));
  }
}
