import { chainId, type LaunchSpec } from "@sparkdream/launch-spec";
import { battleRelayer, battleTargetId } from "../battle.js";
import type { StepCtx } from "../engine.js";
import { ensureSession, sessionKeyFile } from "../sessions.js";
import { ensureBattleClasses } from "../steps/battle.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

// one Node process runs every match (bots included) on one core; the
// persistent volume keeps the profile database (and the session key) across
// restarts and updates
const resources: SdlResources = {
  cpu: { units: 1 },
  memory: { size: "1Gi" },
  storage: [
    { size: "1Gi" },
    { name: "data", size: "1Gi", attributes: { persistent: true, class: "beta3" } },
  ],
};

/** The explorer link the game's HUD shows for its txs, when the target chain runs one. */
function explorerUrl(spec: LaunchSpec): string | undefined {
  const explorer = spec.topology.components.explorer;
  return explorer.enabled && explorer.domain ? `https://${explorer.domain}/${explorer.route ?? spec.network.name}` : undefined;
}

/**
 * The game's web3 env (battle-royale's README lists it): the target chain
 * reached through its public api (LCD) and rpc domains, the game management
 * account as CHAIN_GRANTER with the session key file the launcher delivers
 * (sessions.ts), and PUBLIC_URL, the base of the match token uris the game
 * mints (its own domain). No key of any kind is in the SDL.
 */
export function battleWeb3Env(input: RenderInput): string[] {
  const { spec, component } = input;
  const web3 = spec.topology.components.battle?.web3;
  if (!web3) return [];
  const targetId = battleTargetId(spec, input.launchId ?? "");
  const target = input.resolveFleet?.(targetId);
  if (!target) throw new Error(`battle web3 target fleet ${targetId} could not be resolved`);
  const t = target.spec;
  const pub = t.topology.publicEndpoints;
  if (!(pub?.api && pub?.rpc)) throw new Error("the battle game's target chain has no publicEndpoints.api and .rpc");
  const granter = web3.wallet ?? target.accounts[`acct-${web3.account}`];
  if (!granter) throw new Error(`no address recorded for battle account ${web3.account} on ${targetId}`);
  const explorer = explorerUrl(t);
  return [
    "CHAIN_ENABLED=1",
    `CHAIN_ID=${chainId(t)}`,
    `CHAIN_NAME=${t.network.name}`,
    `CHAIN_RPC=https://${pub.rpc}`,
    `CHAIN_LCD=https://${pub.api}`,
    `CHAIN_DENOM=${t.token.baseDenom}`,
    `CHAIN_DISPLAY_DENOM=${t.token.displayDenom}`,
    `CHAIN_PREFIX=${t.network.bech32Prefix}`,
    `CHAIN_GAS_PRICE=${t.token.minGasPrice}${t.token.baseDenom}`,
    // empty turns the HUD's tx links off; unset, the game would link to its built-in devnet explorer
    `CHAIN_EXPLORER=${explorer ?? ""}`,
    `CHAIN_GRANTER=${granter}`,
    `CHAIN_SESSION_KEY_FILE=${sessionKeyFile("battle")}`,
    `PUBLIC_URL=https://${component.domain!}`,
  ];
}

/**
 * The battle royale game: the battle-royale repo's image, one process serving
 * the game page and its WebSocket game server on port 2567. The client
 * connects to whatever origin served the page, so a plain deployment carries
 * nothing domain- or chain-specific. With battle.web3 the env names the
 * chain the game writes match results to and the account it writes them
 * for; the game signs through a session key delivered into its data volume
 * (see battleWeb3Env). Its profile database (SQLite) lives in /app/data
 * (the image takes ownership of the volume before dropping root).
 */
function render(input: RenderInput) {
  const { component } = input;
  const env = battleWeb3Env(input);
  return {
    battle: {
      service: {
        image: component.image,
        ...(env.length > 0 ? { env } : {}),
        expose: [{ port: 2567, as: 80, accept: [component.domain!], to: [{ global: true }] }],
        params: { storage: { data: { mount: "/app/data", readOnly: false } } },
      },
      resources,
    },
  };
}

export const battle: ComponentDescriptor = {
  key: "battle",
  render,
  resources: () => [resources],
  imageServices: ["battle"],
  shellService: "battle",
  tunnels: () => [],
  // the env holds nothing the spec doesn't (the session key travels by
  // lease-shell), so a chain reset renders it again
  envRefresh: "rerender",
  // the match token uris are built on the game's own domain
  retargetEnv: (spec) =>
    spec.topology.components.battle?.web3 ? { PUBLIC_URL: `https://${spec.topology.components.battle.domain}` } : {},
  // once the game is up: its classes (by the account's own key), then its session key
  configureSteps: (name, spec) =>
    spec.topology.components.battle?.web3
      ? [
          { name: name("battle-classes"), run: (ctx: StepCtx) => ensureBattleClasses(ctx, name("battle-classes"), spec) },
          { name: name("session-battle"), run: (ctx: StepCtx) => ensureSession(ctx, spec, "battle") },
        ]
      : [],
};

export { battleRelayer };
