import type { AkashApi, MtlsCredentials } from "./akash/client.js";

/** SSH target for a deployed node (forwarded port from lease status). */
export interface SshTarget {
  host: string;
  port: number;
  user: string;
  privateKeyPem: string;
  /**
   * Provider lease-shell escape hatch: some providers' forwarded ports
   * reset non-HTTP TCP while their gateway works fine. When SSH cannot
   * CONNECT (resets/refused/timeouts — not auth failures), the runner
   * reroutes exec/upload/download through the lease shell.
   */
  shellFallback?: {
    creds: MtlsCredentials;
    hostUri: string;
    dseq: string;
    gseq: number;
    oseq: number;
    service: string;
  };
}

export interface SshResult {
  stdout: string;
  code: number;
}

export interface SshRunner {
  /**
   * opts.quick marks a probe inside a caller-owned retry loop: one attempt,
   * short lease-shell timeout, no transient-error retries — without it a
   * flaky provider turns a bounded poll gate into hours (up to 4 × 60s
   * websocket timeouts per probe).
   */
  exec(target: SshTarget, command: string, opts?: { quick?: boolean }): Promise<SshResult>;
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
  /** HTTP status code of a GET, 0 on network error. */
  httpStatus(url: string): Promise<number>;
  /** GET body as text; throws on network error or non-2xx (join mode: genesis + trust hash). */
  getText(url: string): Promise<string>;
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
  /** One-shot command in a lease container without sshd (headscale). */
  shellExec(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    service: string,
    cmd: string[],
  ): Promise<{ stdout: string; stderr: string }>;
  /** Recent service logs (non-follow) for the fleet logs viewer (M5). */
  leaseLogs(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    tail: number,
  ): Promise<string>;
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
