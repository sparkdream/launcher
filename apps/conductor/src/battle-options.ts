import { chainId, sessionDays, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { sessionCeiling } from "./sessions.js";
import type { ConductorDb, LaunchRow } from "./db.js";
import { mayUseFleet } from "./bridge-target.js";
import type { RpcProber } from "./services.js";
import { battleClassList, type BattleClass } from "./steps/battle.js";

/**
 * What the battle game's onchain dialog starts from: the settings stored
 * now, the chain fleets the game could write to, and, once a chain and an
 * account are picked, that account as the chain sees it (membership,
 * balance, whether it already owns the game's classes) with the costs and
 * limits the chain sets. Read through the target's public api domain, the
 * same one the game server uses; a chain that cannot be read leaves the
 * check with an error rather than failing the dialog.
 */

/** Trust levels x/artifact accepts for class creation. */
const PROVISIONAL_OR_ABOVE = ["provisional", "established", "trusted", "core"];

export interface BattleWeb3Target {
  id: string;
  name: string;
  chainId: string;
  /** This fleet's own chain. */
  self: boolean;
  /** Why the game cannot write to it, or null. */
  unusable: string | null;
  /** Another wallet's fleet: it takes only a member address from the wallet,
   *  never its generated accounts. */
  foreign: boolean;
  /** Another wallet's fleet that does not share itself with this one. */
  notShared: boolean;
  /** Its launcher-generated members PROVISIONAL or above (battle.web3.account);
   *  none on another wallet's fleet. */
  accounts: string[];
  bech32Prefix: string;
  baseDenom: string;
  displayDenom: string;
  /** Display-unit exponent of the token. */
  exponent: number;
}

export interface BattleWeb3Check {
  address: string;
  /** Its x/rep trust level (lowercase), or null when it is not a member. */
  trustLevel: string | null;
  /** Whether that level may create the game's classes. */
  canCreateClasses: boolean;
  /** Balance in the base denom. */
  balance: string | null;
  /** It already owns every class the game needs: no class creation to sign. */
  classesReady: boolean;
  /** Base-denom cost of creating the missing classes (burned), from the chain's params. */
  classCost: string | null;
  /** Base-denom deposit each minted token locks (refundable on burn). */
  tokenDeposit: string | null;
  /** The chain's caps on a session grant. */
  sessionMax: { days: number; spendLimit: string } | null;
  /** The chain could not be read. */
  error?: string;
}

export interface BattleWeb3Options {
  /** The game's domain. */
  domain?: string;
  current: {
    enabled: boolean;
    target?: string;
    wallet?: string;
    account?: string;
    session: { days?: number; spendLimit: string };
  };
  /** Default grant lifetime in days on this fleet's network type. */
  defaultDays: number;
  targets: BattleWeb3Target[];
  check?: BattleWeb3Check;
}

function specOf(launch: LaunchRow): LaunchSpec {
  return withDefaults(JSON.parse(launch.spec_json));
}

function trustOf(member: unknown): string | undefined {
  if (member === true) return "core";
  if (member && typeof member === "object") return (member as { trustLevel?: string }).trustLevel;
  return undefined;
}

function targetOf(launch: LaunchRow, self: boolean, owner: string): BattleWeb3Target {
  const spec = specOf(launch);
  const pub = spec.topology.publicEndpoints;
  const foreign = (launch.owner ?? "") !== (owner ?? "");
  const notShared = !mayUseFleet(launch, owner);
  return {
    id: launch.id,
    name: spec.network.name,
    chainId: chainId(spec),
    self,
    unusable: notShared
      ? "it belongs to another wallet that does not share it with this one (its owner can add this wallet with share…)"
      : pub?.api && pub?.rpc
        ? null
        : "it has no public api and rpc domains for the game to reach",
    foreign,
    notShared,
    accounts: foreign
      ? []
      : spec.accounts.initial
          .filter((a) => a.generate && PROVISIONAL_OR_ABOVE.includes(trustOf(a.member) ?? ""))
          .map((a) => a.name),
    bech32Prefix: spec.network.bech32Prefix,
    baseDenom: spec.token.baseDenom,
    displayDenom: spec.token.displayDenom,
    exponent: spec.token.exponent,
  };
}

/**
 * The chain fleets the game could write to: this one, and the launcher's
 * other finished chain fleets. Another wallet's fleet is usable when it
 * shares itself with this wallet (sharing.wallets); one that doesn't is
 * listed unusable, so the dialog can say how to share it.
 */
export function battleTargets(db: ConductorDb, launch: LaunchRow): BattleWeb3Target[] {
  const out: BattleWeb3Target[] = [];
  for (const l of db.listLaunches()) {
    if (l.status === "aborted") continue;
    if (db.getStep(l.id, "finalize")?.status !== "done") continue;
    let spec: LaunchSpec;
    try {
      spec = specOf(l);
    } catch {
      continue;
    }
    if (spec.kind === "services") continue;
    out.push(targetOf(l, l.id === launch.id, launch.owner));
  }
  // this fleet first, then by name
  return out.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
}

async function getJson(rpc: RpcProber, url: string): Promise<any> {
  return JSON.parse(await rpc.getText(url));
}

/** The picked account on the picked chain, as that chain sees it. */
export async function battleAccountCheck(
  db: ConductorDb,
  rpc: RpcProber,
  target: BattleWeb3Target,
  account: string,
  /** The classes the game needs (battleClassList), or why they could not be read. */
  needed: readonly BattleClass[] | Error,
): Promise<BattleWeb3Check> {
  if (target.foreign && !account.startsWith(`${target.bech32Prefix}1`)) {
    throw new Error(`${target.name} belongs to another wallet: use a member address whose key is in your wallet`);
  }
  const address = account.startsWith(`${target.bech32Prefix}1`)
    ? account
    : db.stepOutput<{ accounts: Record<string, string> }>(target.id, "generate-keys")?.accounts[`acct-${account}`];
  if (!address) throw new Error(`"${account}" is neither an address on ${target.name} nor one of its generated accounts`);
  const blank: BattleWeb3Check = {
    address,
    trustLevel: null,
    canCreateClasses: false,
    balance: null,
    classesReady: false,
    classCost: null,
    tokenDeposit: null,
    sessionMax: null,
  };
  if (needed instanceof Error) return { ...blank, error: needed.message };
  const api = specOf(db.getLaunch(target.id)!).topology.publicEndpoints?.api;
  if (!api) return { ...blank, error: `${target.name} has no public api domain` };
  const base = `https://${api}`;
  let params: any;
  try {
    params = (await getJson(rpc, `${base}/sparkdream/artifact/v1/params`)).params;
  } catch (e) {
    return { ...blank, error: `${target.name} could not be read at ${api}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const [member, balance, classes, session] = await Promise.all([
    // not found (a non-member) answers 404, which reads as null
    getJson(rpc, `${base}/sparkdream/rep/v1/member/${address}`).then((r) => r.member).catch(() => null),
    getJson(rpc, `${base}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(target.baseDenom)}`)
      .then((r) => String(r.balance?.amount ?? "0"))
      .catch(() => null),
    // unread is not "none": the dialog would say every class is still to create
    getJson(rpc, `${base}/sparkdream/artifact/v1/classes_by_owner/${address}`)
      .then((r) => (r.classes ?? []) as Array<{ symbol?: string; class?: { symbol?: string } }>)
      .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    getJson(rpc, `${base}/sparkdream/session/v1/params`).then((r) => r.params).catch(() => null),
  ]);
  const trustLevel = member ? String(member.trust_level ?? "TRUST_LEVEL_NEW").replace(/^TRUST_LEVEL_/, "").toLowerCase() : null;
  if (classes instanceof Error) return { ...blank, error: `the classes ${address} owns on ${target.name} could not be read at ${api}: ${classes.message}` };
  const owned = new Set(classes.map((c) => String(c.class?.symbol ?? c.symbol ?? "")));
  const missing = needed.filter((c) => !owned.has(c.symbol)).length;
  const fee = params?.class_creation_fee ? BigInt(params.class_creation_fee) : null;
  return {
    address,
    trustLevel,
    canCreateClasses: trustLevel !== null && PROVISIONAL_OR_ABOVE.includes(trustLevel),
    balance,
    classesReady: missing === 0,
    classCost: fee === null ? null : String(fee * BigInt(missing)),
    tokenDeposit: params?.token_deposit ? String(params.token_deposit) : null,
    sessionMax: session
      ? { days: Math.floor(Number(sessionCeiling(session).replace(/s$/, "")) / 86_400), spendLimit: String(session.max_spend_limit_amount ?? "0") }
      : null,
  };
}

/** Everything the dialog shows; `query` picks the chain and account to check. */
export async function battleWeb3Options(
  db: ConductorDb,
  rpc: RpcProber,
  launch: LaunchRow,
  query: { target?: string; account?: string } = {},
): Promise<BattleWeb3Options> {
  const spec = specOf(launch);
  const battle = spec.topology.components.battle;
  if (!battle?.enabled) throw new Error("battle is not enabled in this fleet");
  const web3 = battle.web3;
  const targets = battleTargets(db, launch);
  const options: BattleWeb3Options = {
    ...(battle.domain ? { domain: battle.domain } : {}),
    current: {
      enabled: Boolean(web3),
      ...(web3 ? { target: web3.target?.fleet ?? launch.id } : {}),
      ...(web3?.wallet ? { wallet: web3.wallet } : {}),
      ...(web3?.account ? { account: web3.account } : {}),
      session: { ...(web3?.session.days ? { days: web3.session.days } : {}), spendLimit: web3?.session.spendLimit ?? "25000000" },
    },
    defaultDays: sessionDays(spec, undefined),
    targets,
  };
  const account = query.account?.trim();
  if (!query.target || !account) return options;
  const target = targets.find((t) => t.id === query.target && !t.notShared);
  if (!target) throw new Error(`fleet ${query.target} is not a chain fleet the game can write to`);
  return { ...options, check: await battleAccountCheck(db, rpc, target, account, await battleClassList(rpc, spec).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))) };
}
