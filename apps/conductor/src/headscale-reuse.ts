import { withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, LaunchRow } from "./db.js";
import type { HeadscaleOutput } from "./steps/phase-bcd.js";

/**
 * Shared mesh (topology.headscale.reuseFleet): a fleet that attaches to an
 * existing fleet's headscale instead of deploying its own — so a signer
 * machine logged into one tailnet reaches every fleet sharing it. The
 * attaching fleet gets its own headscale user and preauth keys on the
 * owning fleet's server; the server itself stays the owning fleet's
 * deployment, managed and paid for there.
 */
export interface SharedHeadscale {
  /** Launch id of the fleet that owns the headscale deployment. */
  launchId: string;
  /** Its network name (for messages). */
  name: string;
  domain: string;
  dseq: string;
  provider: string;
  hostUri: string;
  gseq: number;
  oseq: number;
}

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

/**
 * Resolve a spec's reuseFleet reference into the owning fleet's live
 * headscale. Accepts a launch id or a network name (unique among this
 * launcher's non-aborted launches). Throws with a user-facing message on
 * any unusable reference; returns null when the spec runs its own mesh.
 *
 * The same-wallet check is load-bearing, not cosmetic: the attaching
 * launch manages the shared headscale over the provider's lease-shell,
 * whose mTLS cert must belong to the lease owner.
 */
export function resolveSharedHeadscale(
  db: ConductorDb,
  spec: LaunchSpec,
  owner: string,
): SharedHeadscale | null {
  const ref = spec.topology.headscale.reuseFleet;
  if (!ref) return null;
  let target = db.getLaunch(ref);
  if (!target) {
    const matches = db.listLaunches().filter((l) => {
      if (l.status === "aborted") return false;
      try {
        return specOf(l).network.name === ref;
      } catch {
        return false; // unparseable historical spec
      }
    });
    if (matches.length > 1) {
      throw new Error(
        `reuseFleet "${ref}" matches ${matches.length} fleets — reference the launch id instead`,
      );
    }
    target = matches[0];
  }
  if (!target) throw new Error(`reuseFleet "${ref}": no such fleet on this launcher`);
  if (target.status === "aborted") {
    throw new Error(`reuseFleet "${ref}": that fleet was shut down — its mesh is gone`);
  }
  if ((target.owner ?? "") !== (owner ?? "")) {
    throw new Error(
      `reuseFleet "${ref}": that fleet belongs to a different wallet — managing its ` +
        "headscale over lease-shell needs the same owner",
    );
  }
  const targetSpec = specOf(target);
  if (targetSpec.topology.headscale.reuseFleet) {
    throw new Error(
      `reuseFleet "${ref}": that fleet shares its mesh too — reference the owning fleet ` +
        `("${targetSpec.topology.headscale.reuseFleet}") directly`,
    );
  }
  if (targetSpec.infra.akashNetwork !== spec.infra.akashNetwork) {
    throw new Error(
      `reuseFleet "${ref}": that fleet runs on Akash ${targetSpec.infra.akashNetwork}, ` +
        `this spec on ${spec.infra.akashNetwork}`,
    );
  }
  const hs = db.stepOutput<HeadscaleOutput>(target.id, "deploy-headscale");
  if (!hs) {
    throw new Error(`reuseFleet "${ref}": that fleet has no headscale deployed yet — launch it first`);
  }
  const row = db.listFleetComponents(target.id).find((c) => c.key === "headscale");
  if (row?.state === "closed") {
    throw new Error(`reuseFleet "${ref}": that fleet's headscale is closed`);
  }
  const domain = targetSpec.topology.headscale.domain;
  if (!domain) {
    throw new Error(`reuseFleet "${ref}": that fleet's spec has no headscale domain`);
  }
  return {
    launchId: target.id,
    name: targetSpec.network.name,
    domain,
    dseq: hs.dseq,
    provider: hs.provider,
    hostUri: hs.hostUri,
    gseq: hs.gseq,
    oseq: hs.oseq,
  };
}

/**
 * Fleets that share this launch's headscale and are not shut down — the
 * owning fleet must refuse to close its mesh while any exist. A launch
 * counts as live until every one of its components is closed (a created
 * but not-yet-deployed dependent counts too: closing the mesh would strand
 * its launch mid-flight).
 */
export function dependentFleets(db: ConductorDb, launchId: string): LaunchRow[] {
  return db.listLaunches().filter((l) => {
    if (l.id === launchId || l.status === "aborted") return false;
    let spec: LaunchSpec;
    try {
      spec = specOf(l);
    } catch {
      return false; // unparseable historical spec — never block on it
    }
    if (spec.topology.headscale.reuseFleet !== launchId) return false;
    const components = db.listFleetComponents(l.id);
    return components.length === 0 || components.some((c) => c.state !== "closed");
  });
}
