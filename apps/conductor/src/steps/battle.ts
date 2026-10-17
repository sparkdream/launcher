import { imageBefore, versionTag, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { battleRelayer, battleTargetId } from "../battle.js";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { fleetActor, sendTx, walletPause, type ChainActor } from "../peering.js";
import { ensureSession } from "../sessions.js";
import { queryJson } from "./phase-g.js";

/**
 * The game's x/artifact classes, as the battle-royale server expects them
 * (its server/src/chain/classes.ts resolves them by symbol among the classes
 * the game management account owns). Created once per account by that
 * account itself: MsgCreateClass burns SPARK and is not delegable to a
 * session key, so the game server never holds the authority to do it.
 */
export interface BattleClass {
  symbol: string;
  name: string;
  description: string;
  transferable: boolean;
}

// What battle-royale v1.0.2 and earlier need at boot (all four, BRMAP
// included); v1.0.3 and later publish their own list, and v1.0.4 dropped BRMAP.
export const BATTLE_CLASSES: readonly BattleClass[] = [
  {
    symbol: "BRCAREER",
    name: "Battle Royale Career",
    description: "One soulbound token per linked player carrying their lifetime record: matches, wins, kills, damage, collected items, maps and achievements.",
    transferable: false,
  },
  {
    symbol: "BRBADGE",
    name: "Battle Royale Badges",
    description: "Soulbound achievement badges minted to players as they unlock them.",
    transferable: false,
  },
  {
    symbol: "BRMAP",
    name: "Battle Royale Maps",
    description: "Collectible map tokens, one per match, minted to the winner with the layout's seed so anyone can verify the ground it was won on.",
    transferable: true,
  },
  {
    symbol: "BRMATCH",
    name: "Battle Royale Matches",
    description: "One record per finished match with linked players, held by the game's relayer: map, winner and the sha256 of the full result served at the token's uri.",
    transferable: false,
  },
];

/** The first battle-royale release that lists its classes at /chain-status. */
const CLASS_LIST_SINCE = "v1.0.3";

/** How long a game that should list its classes gets to answer: an update
 *  restarts it just before the class step reads the list. */
const CLASS_LIST_TRIES = 12;
const CLASS_LIST_RETRY_MS = 10_000;

/**
 * The classes the game needs, as the deployed game says (its /chain-status
 * lists them since battle-royale v1.0.3), so a new class needs a game
 * release, not a launcher one. A game tagged before v1.0.3 gets the
 * built-in BATTLE_CLASSES; so does one tagged otherwise (dev, a digest)
 * that answers without a list. A game that should list them and does not
 * answer is waited for (`wait`, between tries) and then refused, never
 * replaced by the built-in list: on 2026-10-17 the class step read it while
 * the update was restarting v1.0.4, fell back, and asked for BRMAP, a class
 * that release had dropped. A malformed list is refused too.
 */
export async function battleClassList(
  rpc: { getText(url: string): Promise<string> },
  spec: LaunchSpec,
  wait?: (ms: number) => Promise<void>,
): Promise<readonly BattleClass[]> {
  const domain = spec.topology.components.battle?.domain;
  const image = spec.images?.battle;
  if (!domain || (image && imageBefore(image, CLASS_LIST_SINCE))) return BATTLE_CLASSES;
  let status: { classes?: unknown } | undefined;
  let lastError = "";
  for (let attempt = 0; attempt < (wait ? CLASS_LIST_TRIES : 1) && !status; attempt++) {
    if (attempt > 0) await wait!(CLASS_LIST_RETRY_MS);
    try {
      status = JSON.parse(await rpc.getText(`https://${domain}/chain-status`)) as { classes?: unknown };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  if (!status) {
    throw new Error(`the battle game at ${domain} did not answer /chain-status with the classes it needs (${lastError}): retry once it is up`);
  }
  if (!Array.isArray(status.classes)) {
    if (image && versionTag(image)) {
      throw new Error(`the battle game at ${domain} (${image}) lists no classes at /chain-status`);
    }
    return BATTLE_CLASSES;
  }
  const list = status.classes as unknown[];
  const valid = list.filter(
    (c): c is BattleClass =>
      !!c && typeof c === "object" &&
      typeof (c as BattleClass).symbol === "string" && /^[A-Z0-9]{1,16}$/.test((c as BattleClass).symbol) &&
      typeof (c as BattleClass).name === "string" && typeof (c as BattleClass).description === "string" &&
      typeof (c as BattleClass).transferable === "boolean",
  );
  if (valid.length === 0 || valid.length !== list.length) {
    throw new Error(`the battle game at ${domain} lists classes the launcher cannot read at /chain-status`);
  }
  return valid;
}

/** Gas per class creation (four in one tx took 1.2M). */
const CREATE_CLASS_GAS = 300_000;

function createClassMsg(creator: string, spec: BattleClass, denom: string): unknown {
  return {
    "@type": "/sparkdream.artifact.v1.MsgCreateClass",
    creator,
    name: spec.name,
    symbol: spec.symbol,
    description: spec.description,
    uri: "",
    uri_hash: "",
    token_uri_base: "",
    flags: { transferable: spec.transferable, burn_authorization: "BURN_AUTHORIZATION_HOLDER", token_metadata_mutable: true },
    max_supply: "0",
    mint_policy: { public_mint_enabled: false, price: { denom, amount: "0" }, start_time: "0", end_time: "0", per_address_limit: 0 },
    payout_address: "",
    royalty_bps: 0,
    royalty_recipients: [],
    minters: [],
    accepted_content_license: "CC0-1.0",
  };
}

/** Symbols of the classes `owner` has on the chain. */
async function ownedSymbols(chain: ChainActor, owner: string): Promise<Set<string>> {
  const out = await queryJson(["query", "artifact", "classes-by-owner", owner], chain.rpc).catch(() => ({ classes: [] }));
  const classes = (out.classes ?? []) as Array<{ symbol?: string; class?: { symbol?: string } }>;
  return new Set(classes.map((c) => String(c.class?.symbol ?? c.symbol ?? "")));
}

/**
 * Make sure the game management account owns the four classes on the target
 * chain: with a launcher-held key, create the missing ones; with a wallet
 * member, pause for its signature (CLI commands included for a key on
 * another computer). Idempotent: nothing is sent when they all exist.
 */
export async function ensureBattleClasses(
  ctx: StepCtx,
  stepName: string,
  spec: LaunchSpec,
): Promise<{ address: string; created: string[] }> {
  const targetId = battleTargetId(spec, ctx.launchId);
  const target = targetId === ctx.launchId ? spec : withDefaults(JSON.parse(ctx.db.getLaunch(targetId)!.spec_json));
  const relayer = battleRelayer(spec, ctx.launchId, ctx.db, ctx.workRoot);
  const chain = await fleetActor(ctx, targetId, targetId === ctx.launchId ? "this fleet" : `fleet ${target.network.name}`);

  const owned = await ownedSymbols(chain, relayer.address);
  const missing = (await battleClassList(ctx.services.rpc, spec, (ms) => ctx.services.sleep(ms))).filter((c) => !owned.has(c.symbol));
  if (missing.length === 0) return { address: relayer.address, created: [] };
  const msgs = missing.map((c) => createClassMsg(relayer.address, c, chain.gasDenom));

  if (!relayer.key) {
    // what the wallet would be asked to sign must be something the chain accepts
    const m = await queryJson(["query", "rep", "get-member", relayer.address], chain.rpc)
      .then((out) => out.member)
      .catch(() => undefined);
    if (!m) {
      throw new AwaitUser(stepName, `${relayer.label} is not a member of ${chain.chainId}: only a member PROVISIONAL or above can create the game's classes`);
    }
    if (String(m.trust_level ?? "TRUST_LEVEL_NEW") === "TRUST_LEVEL_NEW") {
      throw new AwaitUser(
        stepName,
        `${relayer.label} is new on ${chain.chainId}: creating the game's classes needs PROVISIONAL or above. ` +
          "Point battle.web3.wallet at such a member, then resume",
      );
    }
    throw await walletPause(
      ctx,
      stepName,
      chain,
      `create the game's ${missing.map((c) => c.symbol).join(", ")} classes`,
      msgs,
      { signerRole: "the game management account", signer: relayer.address, gas: CREATE_CLASS_GAS * msgs.length },
    );
  }

  const signer: ChainActor = { ...chain, signer: { ...relayer.key, address: relayer.address } };
  await sendTx(ctx, signer, `${chain.chainId}-battle-classes`, msgs, { gas: CREATE_CLASS_GAS * msgs.length });
  ctx.log(`battle: ${relayer.label} created ${missing.map((c) => c.symbol).join(", ")} on ${chain.chainId}`);
  return { address: relayer.address, created: missing.map((c) => c.symbol) };
}

/**
 * The game's web3 setup at launch (no-op without battle.web3): the same two
 * steps an add or reconfigure runs, its classes and then its session key.
 */
export const configureBattleStep: StepDef = {
  name: "configure-battle",
  async run(ctx) {
    const battle = ctx.spec.topology.components.battle;
    if (!battle?.enabled || !battle.web3) return { skipped: true };
    const classes = await ensureBattleClasses(ctx, "configure-battle", ctx.spec);
    return { ...classes, session: await ensureSession(ctx, ctx.spec, "battle") };
  },
};
