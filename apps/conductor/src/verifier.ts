import { bridgePeerIds, fleetBridge, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, LaunchRow } from "./db.js";
import { launchDirs } from "./engine.js";

/**
 * The verifier component (sdapverify): which chain it watches, and as whom.
 * A target is this fleet or another fleet on the launcher; either way the
 * verifier acts as a member of the target chain, never the bridge operator:
 * one of the target's launcher-generated members (verifier.account), or a
 * member whose key stays in the user's wallet (verifier.wallet).
 */

const ESTABLISHED_OR_ABOVE = ["established", "trusted", "core"];

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

/** The target fleet's launch id: the spec's target, or this fleet. */
export function verifierTargetId(spec: LaunchSpec, selfId: string): string {
  return spec.topology.components.verifier?.target?.fleet ?? selfId;
}

/** ActivityPub peers to verify: the spec's list, else the target's Mastodon. */
export function verifierPeers(spec: LaunchSpec, target: LaunchSpec): string[] {
  const v = spec.topology.components.verifier!;
  if (v.peers?.length) return v.peers;
  // the target chain's bridge (a sidecar or a standalone one) anchors for
  // its instance and any other servers it bridges as peers
  if (fleetBridge(target)) return bridgePeerIds(target);
  const m = target.topology.components.mastodon;
  return m?.enabled && m.domain ? [m.domain] : [];
}

/**
 * Check a verifier's target and account, resolving a fleet reference to its
 * launch id. Throws with a user-facing message. `targetSpec` is the target's
 * spec (this spec when the verifier checks its own fleet).
 */
export function checkVerifierAccount(spec: LaunchSpec, targetSpec: LaunchSpec): void {
  const v = spec.topology.components.verifier!;
  if (v.wallet) {
    // its standing is the chain's to say: checked when it bonds
    if (!v.wallet.startsWith(`${targetSpec.network.bech32Prefix}1`)) {
      throw new Error(`verifier wallet "${v.wallet}" is not an address on the target chain (${targetSpec.network.bech32Prefix})`);
    }
  } else {
    const acct = targetSpec.accounts.initial.find((a) => a.name === v.account);
    const trust = acct && typeof acct.member === "object" ? acct.member.trustLevel : undefined;
    if (!acct?.generate) {
      throw new Error(`verifier account "${v.account}" is not a launcher-generated account on the target chain`);
    }
    if (!trust || !ESTABLISHED_OR_ABOVE.includes(trust)) {
      throw new Error(`verifier account "${v.account}" must be a member ESTABLISHED or above on the target chain`);
    }
  }
  if (!targetSpec.topology.publicEndpoints?.api) {
    throw new Error("the verifier's target chain has no publicEndpoints.api to read and broadcast through");
  }
  if (verifierPeers(spec, targetSpec).length === 0) {
    throw new Error("the verifier has no ActivityPub peers: set verifier.peers, or target a fleet running Mastodon");
  }
}

/**
 * The member the verifier acts as: its address, and the launcher's key for
 * it when the launcher holds one (verifier.account). A wallet member
 * (verifier.wallet) has no key here: what it must sign pauses for the wallet.
 */
export function verifierMember(
  spec: LaunchSpec,
  selfId: string,
  db: Pick<ConductorDb, "stepOutput">,
  workRoot: string,
): { address: string; label: string; key?: { home: string; key: string } } {
  const v = spec.topology.components.verifier!;
  if (v.wallet) return { address: v.wallet, label: `your member account ${v.wallet}` };
  const targetId = verifierTargetId(spec, selfId);
  const address = db.stepOutput<{ accounts: Record<string, string> }>(targetId, "generate-keys")?.accounts[`acct-${v.account}`];
  if (!address) throw new Error(`no address recorded for verifier account ${v.account} on ${targetId}`);
  return {
    address,
    label: `verifier account ${v.account} (${address})`,
    key: { home: launchDirs(workRoot, targetId).node("val-0"), key: `acct-${v.account}` },
  };
}

/** Resolve verifier.target.fleet (id or network name) to a launch id. */
export function resolveVerifierTarget(
  db: ConductorDb,
  spec: LaunchSpec,
  owner: string,
  ref: string,
  selfId?: string,
): string {
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
    if (matches.length > 1) throw new Error(`verifier target "${ref}" matches ${matches.length} fleets — use the launch id`);
    target = matches[0];
  }
  if (!target) throw new Error(`verifier target "${ref}": no such fleet on this launcher`);
  if (target.status === "aborted") throw new Error(`verifier target "${ref}": that fleet was shut down`);
  // a verifier.account signs with the target's generated key: only the
  // wallet that owns the target may lend it (and a wallet member's fleet
  // must still be one this wallet runs, to be reachable from here)
  if ((target.owner ?? "") !== (owner ?? "")) {
    throw new Error(`verifier target "${ref}": that fleet belongs to a different wallet`);
  }
  if (db.getStep(target.id, "finalize")?.status !== "done") {
    throw new Error(`verifier target "${ref}": that fleet has not finished launching`);
  }
  checkVerifierAccount(spec, specOf(target));
  return target.id;
}

/** RenderInput.resolveFleet for a step: any fleet's spec and secrets. */
export function fleetResolver(ctx: {
  db: ConductorDb;
  workRoot: string;
  launchId: string;
  spec: LaunchSpec;
  dirs: { secrets: string };
}) {
  // generated accounts' addresses (the verifier's granter)
  const accounts = (launchId: string) =>
    ctx.db.stepOutput<{ accounts: Record<string, string> }>(launchId, "generate-keys")?.accounts ?? {};
  return (launchId: string) => {
    if (launchId === ctx.launchId) {
      return { spec: ctx.spec, secretsDir: ctx.dirs.secrets, launchId, accounts: accounts(launchId) };
    }
    const launch = ctx.db.getLaunch(launchId);
    if (!launch) return undefined;
    return {
      spec: specOf(launch),
      secretsDir: launchDirs(ctx.workRoot, launchId).secrets,
      launchId,
      accounts: accounts(launchId),
    };
  };
}
