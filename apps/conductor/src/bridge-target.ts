import { withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, LaunchRow } from "./db.js";

/**
 * The standalone bridge's target: the fleet running the Mastodon instance it
 * links (a services fleet, typically), and that instance's domain.
 */

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

/**
 * Whether `owner` may use fleet `target` from a fleet of its own: it is
 * the target's wallet, or one the target's spec shares with
 * (sharing.wallets, a services fleet owner's explicit opt-in).
 */
export function mayUseFleet(target: LaunchRow, owner: string): boolean {
  if ((target.owner ?? "") === (owner ?? "")) return true;
  try {
    return (specOf(target).sharing?.wallets ?? []).includes(owner);
  } catch {
    return false;
  }
}

/**
 * Resolve bridge.target.fleet (launch id or network name) to a launch id and
 * the instance's domain. The target must be this wallet's (the launcher
 * reaches its Mastodon with that fleet's certificate), finished launching,
 * and running an instance; it cannot be the bridge's own fleet, whose
 * Mastodon would carry the sidecar instead.
 */
export function resolveBridgeTarget(
  db: ConductorDb,
  owner: string,
  ref: string,
  selfId?: string,
): { fleet: string; domain: string } {
  let target = db.getLaunch(ref);
  if (!target) {
    const matches = db.listLaunches().filter((l) => {
      if (l.status === "aborted" || l.id === selfId) return false;
      try {
        return specOf(l).network.name === ref;
      } catch {
        return false;
      }
    });
    if (matches.length > 1) throw new Error(`bridge target "${ref}" matches ${matches.length} fleets — use the launch id`);
    target = matches[0];
  }
  if (!target) throw new Error(`bridge target "${ref}": no such fleet on this launcher`);
  if (target.id === selfId) throw new Error("a fleet bridges its own Mastodon with the Mastodon component's bridge, not a standalone one");
  if (target.status === "aborted") throw new Error(`bridge target "${ref}": that fleet was shut down`);
  if (!mayUseFleet(target, owner)) {
    throw new Error(
      `bridge target "${ref}": that fleet belongs to a different wallet that does not share it with this one ` +
        "(its owner can add this wallet to its sharing list)",
    );
  }
  if (db.getStep(target.id, "finalize")?.status !== "done") {
    throw new Error(`bridge target "${ref}": that fleet has not finished launching`);
  }
  const m = specOf(target).topology.components.mastodon;
  if (!m?.enabled || !m.domain) throw new Error(`bridge target "${ref}": that fleet runs no Mastodon`);
  return { fleet: target.id, domain: m.domain };
}

/**
 * The fleet whose Mastodon a chain's posts come from: the chain fleet itself
 * when it runs one (bridged by its sidecar, or not bridged yet), else the
 * standalone bridge's target, or none.
 */
export function mastodonFleetOf(spec: LaunchSpec, chainLaunchId: string): string | undefined {
  const m = spec.topology.components.mastodon;
  if (m?.enabled) return chainLaunchId;
  const b = spec.topology.components.bridge;
  return b?.enabled ? b.target.fleet : undefined;
}

/** Chain fleets whose standalone bridge links fleet `launchId`'s Mastodon
 *  (their bridge component not closed). */
export function bridgeDependents(db: Pick<ConductorDb, "listLaunches" | "listFleetComponents">, launchId: string): LaunchRow[] {
  return db.listLaunches().filter((l) => {
    if (l.id === launchId || l.status === "aborted") return false;
    try {
      const b = specOf(l).topology.components.bridge;
      if (!b?.enabled || b.target.fleet !== launchId) return false;
    } catch {
      return false;
    }
    return db.listFleetComponents(l.id).some((c) => c.key === "bridge" && c.state !== "closed");
  });
}

/** That Mastodon's running row, for placement rules (keep off its host). */
export function linkedMastodonRow(db: Pick<ConductorDb, "listFleetComponents" | "getLaunch">, spec: LaunchSpec, chainLaunchId: string) {
  const fleet = mastodonFleetOf(spec, chainLaunchId);
  if (!fleet) return undefined;
  return (db.listFleetComponents(fleet) as FleetComponentRow[]).find(
    (c) => c.key === "mastodon" && c.state !== "closed" && c.provider,
  );
}
