import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { TypeUrl } from "../akash/messages.js";
import { loadSdl, sdlArtifacts } from "../akash/sdl-groups.js";
import { setServiceEnv } from "../components/index.js";
import { AwaitUser, type StepCtx, type StepDef } from "../engine.js";
import { fleetActor, sendTx, walletPause, type ChainActor } from "../peering.js";
import { componentLease, ensureSession } from "../sessions.js";
import { verifierMember, verifierTargetId } from "../verifier.js";
import { loadCert } from "./phase-bcd.js";
import { pushManifest } from "./phase-ef.js";
import { queryJson } from "./phase-g.js";

const ESTABLISHED_OR_ABOVE = ["TRUST_LEVEL_ESTABLISHED", "TRUST_LEVEL_TRUSTED", "TRUST_LEVEL_CORE"];

/**
 * Bond the verifier's member as a federation-verifier on the target chain
 * (x/rep MsgBondRole). A launcher-generated member (verifier.account) signs
 * here with its own key, which stays with the launcher; a wallet member
 * (verifier.wallet) is asked to sign in the pause card, after the member's
 * standing and unlocked DREAM are checked so the chain does not refuse what
 * the wallet signs. Either way the daemon only ever gets a session key
 * (sessions.ts). Skipped once the bond is in place, so it re-runs after
 * every placement for free.
 */
export async function bondVerifier(
  ctx: StepCtx,
  stepName: string,
  spec: LaunchSpec,
): Promise<{ account: string; address: string; bond: string; bonded: boolean }> {
  const v = spec.topology.components.verifier!;
  const targetId = verifierTargetId(spec, ctx.launchId);
  const target = targetId === ctx.launchId ? spec : withDefaults(JSON.parse(ctx.db.getLaunch(targetId)!.spec_json));
  const member = verifierMember(spec, ctx.launchId, ctx.db, ctx.workRoot);
  const { address } = member;
  const account = v.account ?? v.wallet!;

  const chain = await fleetActor(ctx, targetId, targetId === ctx.launchId ? "this fleet" : `fleet ${target.network.name}`);
  const current = await queryJson(["query", "rep", "bonded-role", "federation-verifier", address], chain.rpc)
    .then((out) => BigInt(out.bonded_role?.current_bond ?? "0"))
    .catch(() => 0n);
  if (current >= BigInt(v.bond)) return { account, address, bond: current.toString(), bonded: false };

  const top = (BigInt(v.bond) - current).toString();
  const bond = (creator: string) => ({
    "@type": "/sparkdream.rep.v1.MsgBondRole",
    creator,
    role_type: "ROLE_TYPE_FEDERATION_VERIFIER",
    amount: top,
  });
  const short = () =>
    new AwaitUser(
      stepName,
      `${member.label} needs ${top} more micro-DREAM unlocked to bond as a federation verifier: ` +
        "send it DREAM on the target chain, then resume",
    );

  if (!member.key) {
    // what the wallet would be asked to sign must be something the chain accepts
    const m = await queryJson(["query", "rep", "get-member", address], chain.rpc)
      .then((out) => out.member)
      .catch(() => undefined);
    if (!m) {
      throw new AwaitUser(stepName, `${member.label} is not a member of ${chain.chainId}: only a member ESTABLISHED or above can verify`);
    }
    const trust = String(m.trust_level ?? "TRUST_LEVEL_NEW");
    if (!ESTABLISHED_OR_ABOVE.includes(trust)) {
      throw new AwaitUser(
        stepName,
        `${member.label} is ${trust.replace("TRUST_LEVEL_", "").toLowerCase()} on ${chain.chainId}: ` +
          "a federation verifier must be ESTABLISHED or above. Point verifier.wallet at such a member, then resume",
      );
    }
    const unlocked = BigInt(m.dream_balance ?? "0") - BigInt(m.staked_dream ?? "0");
    if (unlocked < BigInt(top)) throw short();
    throw await walletPause(
      ctx,
      stepName,
      chain,
      `bond ${top} micro-DREAM as a federation verifier`,
      [bond(address)],
      { signerRole: "the verifier member", signer: address },
    );
  }

  const signer: ChainActor = { ...chain, signer: { ...member.key, address } };
  try {
    await sendTx(ctx, signer, `${chain.chainId}-bond-verifier`, [bond(address)]);
  } catch (e) {
    if (/insufficient|balance|not enough/i.test(String(e))) throw short();
    throw e;
  }
  ctx.log(`verifier: ${account} bonded ${top} micro-DREAM as federation-verifier on ${chain.chainId}`);
  return { account, address, bond: v.bond, bonded: true };
}

/**
 * Point the running verifier at its member's current address. The member
 * is fixed for a wallet member, but a launcher-generated one (verifier.
 * account) gets a fresh key when a chain reset rebuilds the keyring, and the
 * deployment's SDA_GRANTER still names the old address: one deployment
 * update puts the new one in. A no-op whenever the env already matches.
 */
export async function refreshVerifierGranter(ctx: StepCtx, stepName: string, spec: LaunchSpec): Promise<{ granter: string; updated: boolean }> {
  const { address } = verifierMember(spec, ctx.launchId, ctx.db, ctx.workRoot);
  const sdlPath = path.join(ctx.dirs.sdl, "verifier.yaml");
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const current = (doc.services?.verifier?.env as string[] | undefined)?.find((e) => e.startsWith("SDA_GRANTER="));
  if (current === `SDA_GRANTER=${address}`) return { granter: address, updated: false };

  setServiceEnv(doc, ["verifier"], { SDA_GRANTER: address });
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
  const artifacts = sdlArtifacts(loadSdl(sdlPath));
  fs.writeFileSync(path.join(ctx.dirs.sdl, "verifier.manifest.json"), artifacts.manifestJson);
  const lease = componentLease(ctx, "verifier");
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const wantHash = Buffer.from(artifacts.hash).toString("base64");
  const onChain = await ctx.services.api.deploymentInfo(owner, lease.dseq);
  if (onChain?.hash !== wantHash) {
    await ctx.requireTx(`${stepName}:update`, [
      { typeUrl: TypeUrl.UpdateDeployment, value: { id: { owner, dseq: lease.dseq }, hash: wantHash } },
    ]);
  }
  await pushManifest(ctx, loadCert(ctx), "verifier", lease.hostUri, lease.dseq, artifacts.manifestJson);
  ctx.log(`verifier: granter is now ${address} (the member's key changed)`);
  return { granter: address, updated: true };
}

/** Launch step: bond an enabled verifier once its chain is up. */
export const configureVerifierStep: StepDef = {
  name: "configure-verifier",
  async run(ctx) {
    if (!ctx.spec.topology.components.verifier?.enabled) return { skipped: true };
    const bonded = await bondVerifier(ctx, "configure-verifier", ctx.spec);
    return { ...bonded, session: await ensureSession(ctx, ctx.spec, "verifier") };
  },
};
