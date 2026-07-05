import fs from "node:fs";
import path from "node:path";
import { nodes, type LaunchSpec } from "@sparkdream/launch-spec";
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
 */
export function updateDeploymentMsgs(input: UpdateInput): {
  msgs: Msg[];
  manifests: Record<string, string>;
} {
  const msgs: Msg[] = [];
  const manifests: Record<string, string> = {};
  for (const node of nodes(input.spec)) {
    const sdlPath = path.join(input.sdlDir, `${node.key}.yaml`);
    let text = fs.readFileSync(sdlPath, "utf8");
    text = text.replace(/WAIT_FOR_CONFIG=true/g, "WAIT_FOR_CONFIG=false");
    for (const [key, ip] of Object.entries(input.mesh)) {
      text = text.replaceAll(`{{TAILNET_IP:${key}}}`, ip);
    }
    fs.writeFileSync(sdlPath, text);

    const artifacts = sdlArtifacts(loadSdl(sdlPath));
    manifests[node.key] = sortedJson(artifacts.manifest);
    msgs.push({
      typeUrl: TypeUrl.UpdateDeployment,
      value: {
        id: { owner: input.owner, dseq: input.plan.perNode[node.key]!.dseq },
        hash: Buffer.from(artifacts.hash).toString("base64"),
      },
    });
  }
  return { msgs, manifests };
}
