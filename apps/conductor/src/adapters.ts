import { spawn } from "node:child_process";
import fs from "node:fs";
import { Client, type ClientChannel } from "ssh2";
import { ProviderClient, type MtlsCredentials } from "./akash/client.js";
import { run } from "./exec.js";
import type {
  CertProvider,
  Certificate,
  ProviderGateway,
  RpcProber,
  RpcStatus,
  Services,
  SshResult,
  SshRunner,
  SshTarget,
} from "./services.js";
import { RestAkashApi, type RestEndpoints } from "./akash/rest.js";

/** Connection-level failures — the cases the lease-shell fallback can rescue. */
function isConnectFailure(e: unknown): boolean {
  const s = String((e as any)?.message ?? e);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Timed out while waiting for handshake/i.test(s);
}

/**
 * The session came up and then the command said nothing inside the caller's
 * window (see exec's streamTimeout).
 *
 * Its own class because it is not a connect failure and reads nothing like
 * one, while being exactly as good a reason to try the provider's
 * lease-shell: a forwarded port that completes a handshake and then goes
 * quiet is the shape of a port pointing at a container other than the one it
 * used to. Matched as a plain error it was thrown straight to the caller, so
 * the one path that could still have reached the node — the same path
 * console-air uses, and which works when direct SSH does not — was never
 * tried.
 */
class SshStreamTimeout extends Error {}

/** ssh2-backed runner (§9). One connection per operation — orchestration is low-volume. */
export class Ssh2Runner implements SshRunner {
  constructor(
    /** Injectable for tests; production uses the real mTLS provider client. */
    private readonly shellClient: (creds: MtlsCredentials) => Pick<ProviderClient, "shellExec"> = (
      creds,
    ) => new ProviderClient(creds),
  ) {}

  async exec(
    target: SshTarget,
    command: string,
    opts: { quick?: boolean; timeoutMs?: number } = {},
  ): Promise<SshResult> {
    // readyTimeout below bounds the handshake, but nothing bounds what
    // happens after one: a probe that gets no answer waits forever, inside
    // a retry loop that then never gets to retry. Bounded only where a
    // caller asked for it — long-running work (archive replay, genesis
    // rebuild) has no business being cut off.
    //
    // The bound runs from the moment the command is ASKED for, not from the
    // moment a stream comes back. ssh2 does not call the exec callback
    // until the peer confirms the channel, so a timer armed inside it
    // covers only the case where a session opened and answered nothing —
    // and misses the case where the channel open itself is never answered,
    // which hangs with no timer running at all. That is the shape a
    // forwarded port left pointing at some other container has, and it held
    // a reset's resume for its whole poll budget.
    const streamTimeout = opts.timeoutMs ?? (opts.quick ? Ssh2Runner.QUICK_STREAM_MS : undefined);
    try {
      return await this.withConnection(target, (conn) =>
        new Promise<SshResult>((resolve, reject) => {
          let stream: ClientChannel | undefined;
          const timer =
            streamTimeout === undefined
              ? undefined
              : setTimeout(() => {
                  stream?.destroy();
                  reject(new SshStreamTimeout(`ssh timeout after ${streamTimeout}ms: ${command}`));
                }, streamTimeout);
          conn.exec(command, (err, ch) => {
            if (err) {
              clearTimeout(timer);
              return reject(err);
            }
            stream = ch;
            let stdout = "";
            let stderr = "";
            ch.on("data", (d: Buffer) => (stdout += d.toString())).stderr.on(
              "data",
              (d: Buffer) => (stderr += d.toString()),
            );
            ch.on("close", (code: number) => {
              clearTimeout(timer);
              if (code === 0 || code === null) resolve({ stdout, code: code ?? 0 });
              else reject(new Error(`ssh exit ${code}: ${command}\n${stderr.slice(-1000)}`));
            });
          });
        }),
      );
    } catch (e) {
      if (!target.shellFallback || !(isConnectFailure(e) || e instanceof SshStreamTimeout)) throw e;
      return this.fallbackExec(target, command, opts);
    }
  }

  async upload(target: SshTarget, localPath: string, remotePath: string): Promise<void> {
    try {
      return await this.withConnection(target, (conn) =>
        new Promise<void>((resolve, reject) => {
          conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
          });
        }),
      );
    } catch (e) {
      if (!target.shellFallback || !isConnectFailure(e)) throw e;
      // base64 through the shell, chunked to stay under argv limits
      const b64 = fs.readFileSync(localPath).toString("base64");
      const tmp = `${remotePath}.b64`;
      const CHUNK = 200_000;
      for (let i = 0; i < b64.length || i === 0; i += CHUNK) {
        const op = i === 0 ? ">" : ">>";
        await this.fallbackExec(target, `printf '%s' '${b64.slice(i, i + CHUNK)}' ${op} ${tmp}`);
      }
      await this.fallbackExec(target, `base64 -d ${tmp} > ${remotePath} && rm ${tmp}`);
    }
  }

  async download(target: SshTarget, remotePath: string, localPath: string): Promise<void> {
    try {
      return await this.withConnection(target, (conn) =>
        new Promise<void>((resolve, reject) => {
          conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.fastGet(remotePath, localPath, (e) => (e ? reject(e) : resolve()));
          });
        }),
      );
    } catch (e) {
      if (!target.shellFallback || !isConnectFailure(e)) throw e;
      const out = await this.fallbackExec(target, `base64 ${remotePath}`);
      fs.writeFileSync(localPath, Buffer.from(out.stdout.replace(/\s+/g, ""), "base64"));
    }
  }

  /** Gateway/pod-level failures worth retrying, seen live as "Unexpected
   *  server response: 500" (handshake), "provider reported a failure"
   *  (frame 103, pod mid-restart), and "no active replicase for service"
   *  (pod not yet running — hit when a relaunch upload raced the fresh
   *  container's first boot). A command that ran and exited non-zero
   *  surfaces as "lease shell: exit N" and is never retried. */
  /** Ceiling on a quick probe's command stream (the handshake has its own
   *  readyTimeout); a probe that cannot answer inside this is unreachable
   *  as far as its caller's poll is concerned. */
  private static readonly QUICK_STREAM_MS = 20_000;

  private static readonly TRANSIENT_SHELL_ERROR =
    /Unexpected server response: 5\d\d|ECONNRESET|socket hang up|provider reported a failure|no active replicase/;

  private async fallbackExec(
    target: SshTarget,
    command: string,
    opts: { quick?: boolean; timeoutMs?: number } = {},
  ): Promise<SshResult> {
    const f = target.shellFallback!;
    const client = this.shellClient(f.creds);
    const attempts = opts.quick ? 1 : 4;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        const r = await client.shellExec(
          f.hostUri,
          f.dseq,
          f.gseq,
          f.oseq,
          f.service,
          ["sh", "-c", command],
          opts.timeoutMs !== undefined
            ? { timeoutMs: opts.timeoutMs }
            : opts.quick
              ? { timeoutMs: 15_000 }
              : {},
        );
        return { stdout: r.stdout, code: 0 };
      } catch (e) {
        lastError = e;
        if (!Ssh2Runner.TRANSIENT_SHELL_ERROR.test(String(e))) break;
      }
    }
    // keep the ssh-exit error shape callers already match on
    throw new Error(`ssh exit 1 (via lease-shell): ${command}\n${String(lastError).slice(-500)}`);
  }

  private withConnection<T>(target: SshTarget, fn: (conn: Client) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn
        .on("ready", () => {
          fn(conn)
            .then((v) => {
              conn.end();
              resolve(v);
            })
            .catch((e) => {
              conn.end();
              reject(e);
            });
        })
        .on("error", reject)
        .connect({
          host: target.host,
          port: target.port,
          username: target.user,
          privateKey: target.privateKeyPem,
          readyTimeout: 20_000,
        });
    });
  }
}

export class FetchRpcProber implements RpcProber {
  async status(url: string): Promise<RpcStatus> {
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`rpc ${url}/status: HTTP ${res.status}`);
    const data: any = await res.json();
    const sync = data.result?.sync_info ?? data.sync_info;
    return {
      latestBlockHeight: Number(sync.latest_block_height),
      catchingUp: Boolean(sync.catching_up),
    };
  }

  async httpOk(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async httpStatus(url: string): Promise<number> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return res.status;
    } catch {
      return 0;
    }
  }

  async getText(url: string): Promise<string> {
    // 60s: a genesis document can be tens of MB
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res.text();
  }
}

/**
 * Akash client certificates are self-signed secp256r1 X.509 with the wallet
 * address as CN. openssl keeps us out of hand-rolled ASN.1.
 */
export class OpensslCertProvider implements CertProvider {
  async generate(ownerAddress: string): Promise<Certificate> {
    const tmp = fs.mkdtempSync("/tmp/akash-cert-");
    try {
      const keyPath = `${tmp}/key.pem`;
      const certPath = `${tmp}/cert.pem`;
      await run("openssl", [
        "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath,
      ]);
      await run("openssl", [
        "req", "-new", "-x509", "-key", keyPath, "-out", certPath,
        "-days", "365", "-subj", `/CN=${ownerAddress}`,
        "-addext", "basicConstraints=critical,CA:true",
        "-addext", "keyUsage=critical,keyEncipherment,dataEncipherment",
        "-addext", "extendedKeyUsage=clientAuth",
      ]);
      const keyPem = fs.readFileSync(keyPath, "utf8");
      const certPem = fs.readFileSync(certPath, "utf8");
      const { stdout } = await run("openssl", ["ec", "-in", keyPath, "-pubout"]);
      // x/cert demands the (nonstandard) "EC PUBLIC KEY" PEM label but parses
      // the bytes as plain PKIX/SPKI — exactly what -pubout emits under
      // "PUBLIC KEY". Same relabel console-air's CertificateManager does;
      // without it MsgCreateCertificate fails: "invalid pubkey value:
      // invalid pem block type".
      const pubkeyPem = stdout.replace(/(BEGIN|END) PUBLIC KEY/g, "$1 EC PUBLIC KEY");
      return { certPem, keyPem, pubkeyPem };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

export class DirectProviderGateway implements ProviderGateway {
  sendManifest(creds: MtlsCredentials, hostUri: string, dseq: string, manifestJson: string) {
    return new ProviderClient(creds).sendManifest(hostUri, dseq, manifestJson);
  }

  leaseStatus(creds: MtlsCredentials, hostUri: string, dseq: string, gseq: number, oseq: number) {
    return new ProviderClient(creds).leaseStatus(hostUri, dseq, gseq, oseq);
  }

  shellExec(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    service: string,
    cmd: string[],
  ) {
    return new ProviderClient(creds).shellExec(hostUri, dseq, gseq, oseq, service, cmd);
  }

  leaseLogs(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    tail: number,
  ) {
    return new ProviderClient(creds).leaseLogs(hostUri, dseq, gseq, oseq, tail);
  }
}

/** tar the dir and pipe through the age CLI. */
export async function ageEncryptDir(srcDir: string, recipient: string, outFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["czf", "-", "-C", srcDir, "."]);
    const age = spawn("age", ["-r", recipient, "-o", outFile]);
    tar.stdout.pipe(age.stdin);
    age.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`age exit ${code}`))));
    tar.on("error", reject);
    age.on("error", reject);
  });
}

export function productionServices(endpoints: RestEndpoints): Services {
  return {
    api: new RestAkashApi(endpoints),
    provider: new DirectProviderGateway(),
    ssh: new Ssh2Runner(),
    rpc: new FetchRpcProber(),
    certs: new OpensslCertProvider(),
    encryptBackup: ageEncryptDir,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
