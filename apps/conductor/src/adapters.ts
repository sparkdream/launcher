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

/** ssh2-backed runner (§9). One connection per operation — orchestration is low-volume. */
export class Ssh2Runner implements SshRunner {
  exec(target: SshTarget, command: string): Promise<SshResult> {
    return this.withConnection(target, (conn) =>
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
  }

  upload(target: SshTarget, localPath: string, remotePath: string): Promise<void> {
    return this.withConnection(target, (conn) =>
      new Promise<void>((resolve, reject) => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err);
          sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
        });
      }),
    );
  }

  download(target: SshTarget, remotePath: string, localPath: string): Promise<void> {
    return this.withConnection(target, (conn) =>
      new Promise<void>((resolve, reject) => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err);
          sftp.fastGet(remotePath, localPath, (e) => (e ? reject(e) : resolve()));
        });
      }),
    );
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
      const { stdout: pubkeyPem } = await run("openssl", ["ec", "-in", keyPath, "-pubout"]);
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
