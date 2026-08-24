import fs from "node:fs";
import path from "node:path";
import { nodes, statelessComponents, type LaunchSpec } from "@sparkdream/launch-spec";
import { TypeUrl, type Msg } from "./messages.js";
import { loadSdl, sdlArtifacts, sortedJson } from "./sdl-groups.js";
import type { DeploymentPlan } from "../steps/phase-bcd.js";

export interface UpdateInput {
  spec: LaunchSpec;
  owner: string;
  sdlDir: string;
  plan: DeploymentPlan;
  /** node key → tailnet IP (Phase E table). */
  mesh: Record<string, string>;
}

/** One component's persisted SDL: what to sign for it, and what to PUT. */
export interface PersistUpdate {
  key: string;
  dseq: string;
  /** base64 manifest version — the value the provider recomputes and checks. */
  hash: string;
  manifestJson: string;
  msg: Msg;
}

/**
 * §5 step 20b: rewrite each node's SDL — WAIT_FOR_CONFIG=false and real
 * tunnel targets — and build the per-component MsgUpdateDeployment plus the
 * manifests to re-PUT. Same providers, no re-bid.
 *
 * Mesh components (the explorer) ride along: their TS_TUNNEL targets carry
 * the same {{TAILNET_IP:sentry-0}} placeholder, and baking the real IP into
 * the env here means the container self-heals on any later restart — no SSH
 * rewiring step needed. The frontend has no placeholders and no
 * WAIT_FOR_CONFIG gate, so it is left alone (an update would only restart it).
 *
 * Per component rather than one batch because the caller reconciles each
 * against the on-chain version before signing: a component whose deployment
 * was re-placed since the last persist is on a different hash from its
 * neighbours, and only the drifted ones belong in the tx.
 */
export function updateDeploymentMsgs(input: UpdateInput): PersistUpdate[] {
  const updates: PersistUpdate[] = [];
  const keys = [
    ...nodes(input.spec).map((n) => n.key),
    ...statelessComponents(input.spec)
      .filter((c) => c.mesh)
      .map((c) => c.key),
  ];
  for (const key of keys) {
    const sdlPath = path.join(input.sdlDir, `${key}.yaml`);
    let text = fs.readFileSync(sdlPath, "utf8");
    text = text.replace(/WAIT_FOR_CONFIG=true/g, "WAIT_FOR_CONFIG=false");
    for (const [meshKey, ip] of Object.entries(input.mesh)) {
      text = text.replaceAll(`{{TAILNET_IP:${meshKey}}}`, ip);
    }
    fs.writeFileSync(sdlPath, text);

    const artifacts = sdlArtifacts(loadSdl(sdlPath));
    const dseq = input.plan.perNode[key]!.dseq;
    const hash = Buffer.from(artifacts.hash).toString("base64");
    updates.push({
      key,
      dseq,
      hash,
      manifestJson: artifacts.manifestJson,
      msg: {
        typeUrl: TypeUrl.UpdateDeployment,
        value: { id: { owner: input.owner, dseq }, hash },
      },
    });
  }
  return updates;
}

/**
 * The inverse of the persist rewrite, for a component about to be deployed
 * onto a FRESH volume. Every new dseq is a new persistent volume, and a node
 * whose home is empty with the gate off boots straight into `sparkdreamd
 * start`: the SDK writes a default app.toml, refuses to start on its empty
 * `minimum-gas-prices` and exits. sparkdreamd is PID 1, so the container
 * crash-loops, and a crash-looping container has no replica to lease-shell
 * into — upload-node-data, the step that would deliver the very config the
 * node is missing, then fails with "no active replicas" and the launch is
 * wedged (seen live on a devnet sentry re-placed after persist-start).
 *
 * So every path that creates a deployment from an already-persisted SDL has
 * to re-gate first: the relaunch op, an in-launch re-place, and the
 * whole-batch redeploy after stale bids. No-op on a first launch (the SDL is
 * still gated from Phase A) and on a stateless component, whose SDL carries
 * no gate at all.
 */
export function gateForFreshVolume(text: string): string {
  return text.replace(/WAIT_FOR_CONFIG=false/g, "WAIT_FOR_CONFIG=true");
}

/** File form of {@link gateForFreshVolume}: true when it actually re-gated. */
export function gateSdlForFreshVolume(sdlPath: string): boolean {
  const text = fs.readFileSync(sdlPath, "utf8");
  const gated = gateForFreshVolume(text);
  if (gated === text) return false;
  fs.writeFileSync(sdlPath, gated);
  return true;
}
