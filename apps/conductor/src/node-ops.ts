import type { Services, SshTarget } from "./services.js";

/**
 * Shared node-container conventions: every deployed node (validator, sentry)
 * runs sparkdreamd out of the same home dir with the same start command and
 * exposes CometBFT RPC on 26657. Launch steps, fleet ops, and the health
 * monitor all speak these; keep them in one place.
 */

export const NODE_HOME = "/root/.sparkdream";

/** File the node's output is written to (launcher reads it over SSH). */
export const NODE_LOG = `${NODE_HOME}/sparkdreamd.log`;

/**
 * Detached start, logging into the node home (idempotent callers pgrep
 * first). The log is ALSO mirrored to the container's PID-1 stdout via a
 * `tail -F`, so the Akash provider's log stream — what console-air's Logs
 * tab and the launcher's own logs button read — shows the real chain output
 * instead of only the entrypoint boot banner. The mirror is guarded so
 * repeated starts don't stack tails.
 */
export const START_NODE_CMD =
  `nohup sparkdreamd start --home ${NODE_HOME} > ${NODE_LOG} 2>&1 & ` +
  // ^tail anchors past our own sh wrapper / pgrep, whose cmdlines also
  // contain "tail -F …" — an unanchored match is always a false positive
  `pgrep -f "^tail -F ${NODE_LOG}" >/dev/null || ` +
  `(nohup tail -F ${NODE_LOG} > /proc/1/fd/1 2>/dev/null &)`;

/** Kill + start pair for config changes that need a process restart. */
export async function restartNode(ssh: Services["ssh"], target: SshTarget): Promise<void> {
  await ssh.exec(target, "pkill -x sparkdreamd || true");
  await ssh.exec(target, `sleep 1 && ${START_NODE_CMD}`);
}

/** CometBFT RPC URL for a provider host URI (RPC is exposed on 26657). */
export function rpcUrl(hostUri: string): string {
  const u = new URL(hostUri);
  return `${u.protocol}//${u.hostname}:26657`;
}

/**
 * Local port a joining validator's light client uses to reach its own
 * sentry's RPC (§5 join mode): tailnet IPs are not dialable from normal
 * sockets (userspace tailscale), and bundle RPCs ride forwarded ports that
 * egress-filtered providers block — localhost is always reachable.
 */
export const WITNESS_RPC_PORT = 26658;

/**
 * Local port a joining validator dials to reach its own sentry's p2p port:
 * outbound tailnet dials need a proxy (userspace tailscale), and dialing
 * out lets the validator re-establish its only peer link itself instead of
 * waiting out the sentry dialer's exponential backoff after downtime.
 */
export const VAL_PEER_TUNNEL_PORT = 16657;

/**
 * Mesh tunnel: listen on the local port and pipe to the target node's p2p
 * port (or another port, e.g. RPC for the statesync witness) over
 * tailscale, then probe that the listener is up.
 */
export function socatTunnelCmd(listenPort: number, targetIp: string, targetPort = 26656): string {
  // Self-cleaning: kill any existing listener on this port FIRST, so a
  // re-run (e.g. relaunch configure) can't stack duplicate fork listeners
  // on the same port — two listeners churn out "connection reset" noise.
  // ^socat anchors past our own sh wrapper and pkill's own cmdline.
  //
  // The probe then confirms THIS tunnel (target IP in the socat cmdline),
  // not merely that the port listens — a leftover placeholder tunnel also
  // satisfies a bare port check and silently blackholes p2p.
  // keepalive on the listen leg (same timers as the entrypoint's tmkms
  // proxy): a stalled DERP flow otherwise hangs the p2p connection silently
  // until CometBFT's slow ping/pong timeout — tens of seconds of missed
  // votes per stall. Tight keepalives surface the dead leg in ~25s so the
  // peer drops cleanly and redials immediately.
  return (
    `pkill -f "^socat TCP-LISTEN:${listenPort}," 2>/dev/null; sleep 0.3; ` +
    `nohup socat TCP-LISTEN:${listenPort},fork,reuseaddr,keepalive,keepidle=10,keepintvl=5,keepcnt=3 ` +
    `EXEC:"tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock nc ${targetIp} ${targetPort}" ` +
    `>/dev/null 2>&1 & sleep 1 && nc -z 127.0.0.1 ${listenPort} && ` +
    `pgrep -f "^socat.*nc ${targetIp} ${targetPort}" >/dev/null`
  );
}
