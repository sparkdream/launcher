import { withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, LaunchRow } from "./db.js";
import { launchDirs } from "./engine.js";
import { mayUseFleet } from "./bridge-target.js";

/**
 * The battle royale component's web3 mode: which chain the game server
 * writes to, and as whom. A target is this fleet or another fleet on the
 * launcher; either way the game acts for the game management account, a
 * member of the target chain: one of the target's launcher-generated
 * members (battle.web3.account), or a member whose key stays in the user's
 * wallet (battle.web3.wallet). That account creates the game's classes once
 * and grants the game server an x/session key (sessions.ts); its own key
 * never reaches the game's provider.
 */

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

/** The target fleet's launch id: the spec's target, or this fleet. */
export function battleTargetId(spec: LaunchSpec, selfId: string): string {
  return spec.topology.components.battle?.web3?.target?.fleet ?? selfId;
}

/** Trust levels x/artifact accepts for class creation (its default min is PROVISIONAL). */
const PROVISIONAL_OR_ABOVE = ["provisional", "established", "trusted", "core"];

/**
 * Check the game management account against the target chain's spec.
 * Throws with a user-facing message. `targetSpec` is this spec when the game
 * writes to its own fleet's chain.
 */
export function checkBattleAccount(spec: LaunchSpec, targetSpec: LaunchSpec): void {
  const web3 = spec.topology.components.battle?.web3;
  if (!web3) return;
  if (web3.wallet) {
    // its standing is the chain's to say: checked when the classes are created
    if (!web3.wallet.startsWith(`${targetSpec.network.bech32Prefix}1`)) {
      throw new Error(`battle wallet "${web3.wallet}" is not an address on the target chain (${targetSpec.network.bech32Prefix})`);
    }
  } else {
    const acct = targetSpec.accounts.initial.find((a) => a.name === web3.account);
    const trust = acct && typeof acct.member === "object" ? acct.member.trustLevel : acct?.member === true ? "core" : undefined;
    if (!acct?.generate) {
      throw new Error(`battle account "${web3.account}" is not a launcher-generated account on the target chain`);
    }
    if (!trust || !PROVISIONAL_OR_ABOVE.includes(trust)) {
      throw new Error(`battle account "${web3.account}" must be a member PROVISIONAL or above on the target chain (x/artifact class creation)`);
    }
  }
  const pub = targetSpec.topology.publicEndpoints;
  if (!(pub?.api && pub?.rpc)) {
    throw new Error("the battle game's target chain has no publicEndpoints.api and .rpc to query and broadcast through");
  }
}

/**
 * The game management account: its address, and the launcher's key for it
 * when the launcher holds one (battle.web3.account). A wallet member has no
 * key here: what it must sign pauses for the wallet.
 */
export function battleRelayer(
  spec: LaunchSpec,
  selfId: string,
  db: Pick<ConductorDb, "stepOutput">,
  workRoot: string,
): { address: string; label: string; key?: { home: string; key: string } } {
  const web3 = spec.topology.components.battle!.web3!;
  if (web3.wallet) return { address: web3.wallet, label: `your game management account ${web3.wallet}` };
  const targetId = battleTargetId(spec, selfId);
  const address = db.stepOutput<{ accounts: Record<string, string> }>(targetId, "generate-keys")?.accounts[`acct-${web3.account}`];
  if (!address) throw new Error(`no address recorded for battle account ${web3.account} on ${targetId}`);
  return {
    address,
    label: `game management account ${web3.account} (${address})`,
    key: { home: launchDirs(workRoot, targetId).node("val-0"), key: `acct-${web3.account}` },
  };
}

/** Resolve battle.web3.target.fleet (id or network name) to a launch id. */
export function resolveBattleTarget(db: ConductorDb, spec: LaunchSpec, owner: string, ref: string, selfId?: string): string {
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
    if (matches.length > 1) throw new Error(`battle web3 target "${ref}" matches ${matches.length} fleets — use the launch id`);
    target = matches[0];
  }
  if (!target) throw new Error(`battle web3 target "${ref}": no such fleet on this launcher`);
  if (target.status === "aborted") throw new Error(`battle web3 target "${ref}": that fleet was shut down`);
  // another wallet's fleet only when it shares itself with this one, and
  // then with a wallet member: a battle.account signs with the target's
  // generated key, which only the wallet that owns the target may lend
  if (!mayUseFleet(target, owner)) {
    throw new Error(
      `battle web3 target "${ref}": that fleet belongs to a different wallet that does not share it with this one ` +
        "(its owner can add this wallet to its sharing list)",
    );
  }
  if ((target.owner ?? "") !== (owner ?? "") && spec.topology.components.battle?.web3?.account) {
    throw new Error(
      `battle web3 target "${ref}": that fleet belongs to a different wallet, so its generated accounts stay with it: ` +
        "use a member address whose key is in your wallet",
    );
  }
  if (db.getStep(target.id, "finalize")?.status !== "done") {
    throw new Error(`battle web3 target "${ref}": that fleet has not finished launching`);
  }
  checkBattleAccount(spec, specOf(target));
  return target.id;
}
