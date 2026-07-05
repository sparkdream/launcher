import type { AkashApi, MtlsCredentials } from "./akash/client.js";

/** SSH target for a deployed node (forwarded port from lease status). */
export interface SshTarget {
  host: string;
  port: number;
  user: string;
  privateKeyPem: string;
}

export interface SshResult {
  stdout: string;
  code: number;
}

export interface SshRunner {
  exec(target: SshTarget, command: string): Promise<SshResult>;
  upload(target: SshTarget, localPath: string, remotePath: string): Promise<void>;
  download(target: SshTarget, remotePath: string, localPath: string): Promise<void>;
}

export interface RpcStatus {
  latestBlockHeight: number;
  catchingUp: boolean;
}

export interface RpcProber {
  status(url: string): Promise<RpcStatus>;
  httpOk(url: string): Promise<boolean>;
}

export interface Certificate extends MtlsCredentials {
  pubkeyPem: string;
}

export interface CertProvider {
  /** Generate a fresh Akash client certificate for the wallet address. */
  generate(owner: string): Promise<Certificate>;
}

export interface ProviderGateway {
  sendManifest(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    manifestJson: string,
  ): Promise<void>;
  leaseStatus(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
  ): Promise<unknown>;
}

/**
 * Injection seam between the state machine and the outside world. Real
 * adapters for production; fakes in tests (M2 headless testing, §11).
 */
export interface Services {
  api: AkashApi;
  provider: ProviderGateway;
  ssh: SshRunner;
  rpc: RpcProber;
  certs: CertProvider;
  /** age-encrypt a directory to outFile for the given recipient. */
  encryptBackup(srcDir: string, recipient: string, outFile: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}
