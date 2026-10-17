import { withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
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
export const BATTLE_CLASSES: readonly { symbol: string; name: string; description: string; transferable: boolean }[] = [
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

/** Gas for four class creations in one tx. */
const CREATE_CLASSES_GAS = 1_200_000;

function createClassMsg(creator: string, spec: (typeof BATTLE_CLASSES)[number], denom: string): unknown {
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
  const missing = BATTLE_CLASSES.filter((c) => !owned.has(c.symbol));
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
      { signerRole: "the game management account", signer: relayer.address, gas: CREATE_CLASSES_GAS },
    );
  }

  const signer: ChainActor = { ...chain, signer: { ...relayer.key, address: relayer.address } };
  await sendTx(ctx, signer, `${chain.chainId}-battle-classes`, msgs, { gas: CREATE_CLASSES_GAS });
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
