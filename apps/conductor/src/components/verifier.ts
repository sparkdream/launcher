import { chainId } from "@sparkdream/launch-spec";
import type { FleetComponentRow } from "../db.js";
import type { StepCtx } from "../engine.js";
import { SESSION_KEY_FILE, ensureSession } from "../sessions.js";
import { bondVerifier, refreshVerifierGranter } from "../steps/verifier.js";
import { verifierPeers, verifierTargetId } from "../verifier.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

/** sdapverify's SDA_GAS default. */
const VERIFY_GAS = 200_000;

const resources: SdlResources = {
  // media downloads for hashing need some scratch; the small volume holds
  // only the session key, so a container restart does not idle it
  cpu: { units: 0.5 },
  memory: { size: "512Mi" },
  storage: [{ size: "2Gi" }, { name: "state", size: "64Mi", attributes: { persistent: true, class: "beta3" } }],
};

/**
 * Akash providers refuse a manifest with no globally exposed service ("zero
 * global services"), and sdapverify listens on nothing. This expose only
 * satisfies that rule: a plain TCP port (not 80, so no ingress hostname),
 * with nothing behind it.
 */
const PLACEHOLDER_EXPOSE = { port: 8080, as: 8080, proto: "tcp", to: [{ global: true }] };

/**
 * sdapverify (the sdap image), watching the target chain through its public
 * api and re-fetching every post a bridge anchors there. It listens on
 * nothing (see PLACEHOLDER_EXPOSE for the one port it declares). It signs
 * through a session key the launcher writes to /data (sessions.ts); the
 * member's own key never leaves the launcher. Until the key arrives it
 * polls and holds its verdicts.
 */
function render(input: RenderInput) {
  const { spec, component } = input;
  const v = spec.topology.components.verifier!;
  const targetId = verifierTargetId(spec, input.launchId ?? "");
  const target = input.resolveFleet?.(targetId);
  if (!target) throw new Error(`verifier target fleet ${targetId} could not be resolved`);
  const t = target.spec;
  const granter = v.wallet ?? target.accounts[`acct-${v.account}`];
  if (!granter) throw new Error(`no address recorded for verifier account ${v.account} on the target fleet`);
  const env = [
    `SDA_SESSION_KEY_FILE=${SESSION_KEY_FILE}`,
    `SDA_GRANTER=${granter}`,
    `SDA_PEER_IDS=${verifierPeers(spec, t).join(",")}`,
    `SDA_LCD=https://${t.topology.publicEndpoints!.api}`,
    `SDA_CHAIN_ID=${chainId(t)}`,
    `SDA_PREFIX=${t.network.bech32Prefix}`,
    `SDA_DENOM=${t.token.baseDenom}`,
    `SDA_GAS=${VERIFY_GAS}`,
    `SDA_FEE=${Math.ceil(Number(t.token.minGasPrice) * VERIFY_GAS)}`,
    ...(v.alarmWebhook ? [`ALARM_WEBHOOK=${v.alarmWebhook}`] : []),
  ];
  return {
    verifier: {
      // args, not command: the image's entrypoint readies /data and drops
      // to its unprivileged user
      service: {
        image: component.image,
        args: ["sdapverify"],
        env,
        expose: [PLACEHOLDER_EXPOSE],
        params: { storage: { state: { mount: "/data", readOnly: false } } },
      },
      resources,
    },
  };
}

export const verifier: ComponentDescriptor = {
  key: "verifier",
  render,
  resources: () => [resources],
  imageServices: ["verifier"],
  shellService: "verifier",
  tunnels: () => [],
  envRefresh: "none",
  // never on the host that serves the posts it checks: a provider-side fault
  // (DNS, an intercepting proxy) would then fool bridge and verifier alike
  avoidProviders({ db, launchId, spec, assigned }) {
    const targetId = verifierTargetId(spec, launchId);
    if (targetId === launchId && assigned.mastodon) return [assigned.mastodon];
    const row = (db.listFleetComponents(targetId) as FleetComponentRow[]).find(
      (c) => c.key === "mastodon" && c.state !== "closed" && c.provider,
    );
    return row ? [row.provider] : [];
  },
  configureSteps: (name, spec) => [
    { name: name("verifier-granter"), run: (ctx: StepCtx) => refreshVerifierGranter(ctx, name("verifier-granter"), spec) },
    { name: name("bond-verifier"), run: (ctx: StepCtx) => bondVerifier(ctx, name("bond-verifier"), spec) },
    { name: name("session-verifier"), run: (ctx: StepCtx) => ensureSession(ctx, spec, "verifier") },
  ],
};

