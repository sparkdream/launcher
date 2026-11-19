import type { ConductorDb, FleetComponentRow } from "./db.js";

/**
 * The serving sentry: the one sentry of a fleet that everything outside the
 * chain's own p2p goes through. The public API and RPC domains point at its
 * forwarded ports, the explorer and the relayer tunnel to it over the mesh,
 * and other fleets' relayers dial it.
 *
 * It is sentry-0 until the fleet switches (a "switch-sentry" op), which is
 * what lets a second sentry take over while the first is down or being
 * moved. Service components' descriptors still name their tunnel peer
 * "sentry-0": in a descriptor that name means "the serving sentry", and
 * servingPeer turns it into the component that holds the role now.
 */

/** The name descriptors use for the serving sentry, and the default holder. */
export const DEFAULT_SERVING_SENTRY = "sentry-0";

const setting = (launchId: string) => `serving-sentry:${launchId}`;

/** The sentry serving this fleet now. Falls back to sentry-0 when the stored
 *  one is no longer a running sentry of the fleet (removed, or closed). */
export function servingSentry(db: ConductorDb, launchId: string): string {
  const stored = db.getSetting(setting(launchId));
  if (!stored || stored === DEFAULT_SERVING_SENTRY) return DEFAULT_SERVING_SENTRY;
  const row = (db.listFleetComponents(launchId) as FleetComponentRow[]).find((c) => c.key === stored);
  return row && row.state !== "closed" ? stored : DEFAULT_SERVING_SENTRY;
}

export function setServingSentry(db: ConductorDb, launchId: string, key: string): void {
  if (!/^sentry-\d+$/.test(key)) throw new Error(`${key} is not a sentry`);
  if (key === DEFAULT_SERVING_SENTRY) db.deleteSetting(setting(launchId));
  else db.setSetting(setting(launchId), key);
}

/**
 * A descriptor's tunnel peer as the component it means now: "sentry-0"
 * becomes this fleet's serving sentry, "sentry-0@<launch>" that fleet's.
 * Any other peer is returned as it is.
 */
export function servingPeer(db: ConductorDb, launchId: string, peer: string): string {
  const at = peer.indexOf("@");
  const key = at < 0 ? peer : peer.slice(0, at);
  if (key !== DEFAULT_SERVING_SENTRY) return peer;
  if (at < 0) return servingSentry(db, launchId);
  const other = peer.slice(at + 1);
  return `${servingSentry(db, other)}@${other}`;
}

/** The serving sentry's row, when it is running. */
export function servingSentryRow(db: ConductorDb, launchId: string): FleetComponentRow | undefined {
  const key = servingSentry(db, launchId);
  const row = (db.listFleetComponents(launchId) as FleetComponentRow[]).find((c) => c.key === key);
  return row && row.state !== "closed" ? row : undefined;
}
