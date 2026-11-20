/**
 * Failures that say nothing about the work itself: the connection to a
 * provider, an RPC or a container broke, and the same call a moment later
 * may well go through.
 */

/** Gateway/pod-level lease-shell failures worth retrying, seen live as
 *  "Unexpected server response: 500" (handshake), "provider reported a
 *  failure" (frame 103, pod mid-restart), and "no active replicase for
 *  service" (pod not yet running: hit when a relaunch upload raced the fresh
 *  container's first boot). A command that ran and exited non-zero surfaces
 *  as "lease shell: exit N" and is never retried. */
export const TRANSIENT_SHELL_ERROR =
  /Unexpected server response: 5\d\d|ECONNRESET|socket hang up|provider reported a failure|no active replicase/;

const NETWORK_ERROR =
  /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|fetch failed|Unexpected server response: 5\d\d|Timed out while waiting for handshake|Connection lost before handshake|closed before the SSH handshake|aborted due to timeout/i;

/** A step's error text reads as a broken connection, not a refused request. */
export function isNetworkError(message: string): boolean {
  return NETWORK_ERROR.test(message);
}

/**
 * Run a lease-shell call, trying again (2 s, 4 s, 8 s apart) when it fails
 * the way a provider's gateway fails in passing. Only for commands that are
 * safe to run twice: a connection dropped after the command ran looks the
 * same as one dropped before.
 */
export async function retryTransientShell<T>(
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>,
  onRetry: (error: string) => void = () => {},
  attempts = 4,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !TRANSIENT_SHELL_ERROR.test(String(e))) throw e;
      onRetry(e instanceof Error ? e.message : String(e));
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}
