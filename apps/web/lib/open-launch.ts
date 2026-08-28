/**
 * Which launch the Launch panel is open on.
 *
 * The fleet view is wallet-scoped: connecting a different deploy account
 * (testnet vs devnet, say) swaps every fleet card on the page. The Launch
 * panel above them has to swap with it, so the open launch is remembered per
 * account and resolved against that account's own fleets. A launch id
 * remembered for another account, or for a launch since deleted, is not a
 * choice this account can honor: it left the header naming one chain over
 * another chain's fleet.
 *
 * That leaves the account's fleets as the authority, and the choice is a
 * ranking over them rather than a stored id alone.
 */

/** A row of the wallet-scoped fleet view, reduced to what the choice needs. */
export interface LaunchChoice {
  launchId: string;
  /** "completed" once the run finished; anything else still wants a look. */
  launchStatus: string;
  /** Has at least one deployment that is not closed. */
  alive: boolean;
}

/** What an account stores when it deliberately opens the spec editor. */
export const EDITOR = "";

/**
 * The launch to open for an account, given what it stored, what the fleet
 * sweep says it has, and what is open right now.
 */
export function openLaunchFor(
  stored: string | null,
  fleets: LaunchChoice[],
  current: string | null,
): string | null {
  // a remembered launch the account still has stays open
  if (stored && fleets.some((f) => f.launchId === stored)) return stored;
  // a launch just created is stored and open before the next sweep sees it:
  // an older snapshot is not evidence the account does not have it
  if (stored && stored === current) return stored;
  // never orphan a launch that needs attention (running, paused on a
  // signature, failed): the panel holds the only banners that reach it, and
  // that outranks even a deliberately opened editor
  const attention = [...fleets].reverse().find((f) => f.launchStatus !== "completed");
  if (attention) return attention.launchId;
  if (stored === EDITOR) return null;
  // nothing this account chose (its first look, or what it chose is gone,
  // deleted or from a reset store): open the chain it is running, so the
  // header names the fleet below it
  return [...fleets].reverse().find((f) => f.alive)?.launchId ?? null;
}
