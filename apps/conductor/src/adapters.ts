import { spawn } from "node:child_process";
import fs from "node:fs";
import { Client } from "ssh2";
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

/** ssh2-backed runner (§9). One connection per operation — orchestration is low-volume. */
export class Ssh2Runner implements SshRunner {
  constructor(
    /** Injectable for tests; production uses the real mTLS provider client. */
    private readonly shellClient: (creds: MtlsCredentials) => Pick<ProviderClient, "shellExec"> = (
      creds,
    ) => new ProviderClient(creds),
  ) {}

  async exec(target: SshTarget, command: string): Promise<SshResult> {
    try {
      return await this.withConnection(target, (conn) =>
        new Promise<SshResult>((resolve, reject) => {
          conn.exec(command, (err, stream) => {
            if (err) return reject(err);
            let stdout = "";
            let stderr = "";
            stream
              .on("data", (d: Buffer) => (stdout += d.toString()))
              .stderr.on("data", (d: Buffer) => (stderr += d.toString()));
            stream.on("close", (code: number) => {
              if (code === 0 || code === null) resolve({ stdout, code: code ?? 0 });
              else reject(new Error(`ssh exit ${code}: ${command}\n${stderr.slice(-1000)}`));
            });
          });
        }),
      );
    } catch (e) {
      if (!target.shellFallback || !isConnectFailure(e)) throw e;
      return this.fallbackExec(target, command);
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

  private async fallbackExec(target: SshTarget, command: string): Promise<SshResult> {
    const f = target.shellFallback!;
    const client = this.shellClient(f.creds);
    try {
      const r = await client.shellExec(f.hostUri, f.dseq, f.gseq, f.oseq, f.service, [
        "sh",
        "-c",
        command,
      ]);
      return { stdout: r.stdout, code: 0 };
    } catch (e) {
      // keep the ssh-exit error shape callers already match on
      throw new Error(`ssh exit 1 (via lease-shell): ${command}\n${String(e).slice(-500)}`);
    }
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
