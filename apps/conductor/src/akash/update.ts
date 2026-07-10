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

/**
 * §5 step 20b: rewrite each node's SDL — WAIT_FOR_CONFIG=false and real
 * tunnel targets — and build the batched MsgUpdateDeployment plus the
 * manifests to re-PUT. Same providers, no re-bid.
 *
 * Mesh components (the explorer) ride along: their TS_TUNNEL targets carry
 * the same {{TAILNET_IP:sentry-0}} placeholder, and baking the real IP into
 * the env here means the container self-heals on any later restart — no SSH
 * rewiring step needed. The frontend has no placeholders and no
 * WAIT_FOR_CONFIG gate, so it is left alone (an update would only restart it).
 */
export function updateDeploymentMsgs(input: UpdateInput): {
  msgs: Msg[];
  manifests: Record<string, string>;
} {
  const msgs: Msg[] = [];
  const manifests: Record<string, string> = {};
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
    manifests[key] = artifacts.manifestJson;
    msgs.push({
      typeUrl: TypeUrl.UpdateDeployment,
      value: {
        id: { owner: input.owner, dseq: input.plan.perNode[key]!.dseq },
        hash: Buffer.from(artifacts.hash).toString("base64"),
      },
    });
  }
  return { msgs, manifests };
}
