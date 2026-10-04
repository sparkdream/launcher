import type { AkashApi, MtlsCredentials } from "./akash/client.js";
import type { LocalSignerHost, RemoteHost } from "./local-signer.js";
import type { UnattendedChain } from "./unattended.js";
import type { DnsUpdater } from "./dns.js";

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
  /**
   * How long to wait for the SSH handshake before giving up and letting the
   * shellFallback take over (ssh2's readyTimeout). Defaults to 20s, which is
   * the right patience for a real node behind a provider's forwarded port.
   *
   * Overridable because "the connect fails" is not something a caller can
   * provoke portably: a host that refuses is instant, but one that blackholes
   * the SYN costs the full timeout, and under WSL2's loopback neither holds --
   * closed ports accept the connection and port 1 swallows it. Tests set a
   * small budget so the fallback path is reached the same way everywhere.
   */
  readyTimeoutMs?: number;
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
   * websocket timeouts per probe). quick also bounds the direct-SSH command
   * stream, which is otherwise open-ended: a port that completes a TCP
   * handshake and then says nothing hangs the read forever.
   *
   * opts.timeoutMs bounds one attempt explicitly. Left unset, a non-quick
   * exec keeps its open-ended stream, because plenty of the work here
   * legitimately outruns any default worth picking (an archive replay, a
   * genesis rebuild); set it on anything that should not be allowed to.
   */
  exec(
    target: SshTarget,
    command: string,
    opts?: { quick?: boolean; timeoutMs?: number },
  ): Promise<SshResult>;
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
  /** One-shot command in a lease container without sshd (headscale).
   *  `timeoutMs` for the long ones (a database dump); 60 s otherwise. */
  shellExec(
    creds: MtlsCredentials,
    hostUri: string,
    dseq: string,
    gseq: number,
    oseq: number,
    service: string,
    cmd: string[],
    opts?: { timeoutMs?: number },
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
  /** The launcher's own machine, when a tmkms signer can be managed on it
   *  (local-signer.ts). Absent: every signer pause stays the operator's. */
  localSigner?: LocalSignerHost;
  /** A signer machine reached over SSH (a Pi with the hardware key). */
  remoteSigner?: (remote: RemoteHost) => LocalSignerHost;
  /** Authz queries and MsgExec signing for unattended recovery (unattended.ts). */
  unattended?: UnattendedChain;
  /** DNS updates after a move (dns.ts); absent or unconfigured = the operator does them. */
  dns?: DnsUpdater;
}
