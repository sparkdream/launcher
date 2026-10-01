import fs from "node:fs";
import path from "node:path";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import type { FleetComponentRow } from "../db.js";
import { AwaitUser, launchDirs, type StepCtx, type StepDef } from "../engine.js";
import { toSsh2CompatiblePrivateKey } from "../keys.js";
import { restartNode } from "../node-ops.js";
import {
  ensureRelayerMnemonic,
  fleetPeer,
  relayerAddress,
  relayerCap,
  suggestedTopUp,
  relayPlan,
  RELAYER_DIR,
  renderHermesConfig,
  renderRelayManifest,
  type RelayChannel,
  type RelayPlan,
} from "../relayer.js";
import { readSecretFile } from "../secrets.js";
import { patchSentryAppToml, sentryServe } from "../sentry-serve.js";
import type { SshTarget } from "../services.js";
import { nodeShellFallback, sshTarget, type Assignments, type DeploymentPlan, type SshEndpoints } from "./phase-bcd.js";
import {
  chainIdentity,
  ensurePeerActive,
  fleetActor,
  sparkDreamPeerPolicy,
  type ChainActor,
  type PeerStatus,
} from "../peering.js";

/** What linking produced: the relayer's address on each chain and the
 *  channels it opened. Also saved to <launch>/relayer/state.json for the
 *  fleet panel, since the step that last linked may be a launch step or any
 *  op's. */
export interface RelayerLinkOutput {
  chains: Array<{
    chainId: string;
    address: string;
    launchId?: string;
    /** Gas balance at the last link, and the cap it should stay under. */
    balance?: string;
    denom?: string;
    cap?: string;
  }>;
  channels: RelayChannel[];
  linkedAt: string;
  /** Federation peers' status on each chain, once link-peers has run. */
  peers?: PeerStatus[];
}

/** Bringup opens clients, connections and channels one handshake at a time,
 *  each waiting on blocks from both chains. */
const BRINGUP_TIMEOUT_MS = 20 * 60_000;

export function relayerStatePath(workRoot: string, launchId: string): string {
  return path.join(launchDirs(workRoot, launchId).root, "relayer", "state.json");
}

/** The relayer container's SSH target: from its fleet row once materialized,
 *  else from send-manifests (during the launch itself). Either way with the
 *  provider's lease-shell as fallback: Hermes only dials out, so a provider
 *  whose forwarded SSH port is dead still runs it fine (seen live, 2026-10-01). */
function relayerTarget(ctx: StepCtx): SshTarget {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find((c) => c.key === "relayer");
  if (row?.ssh_host && row.ssh_port) {
    return sshTarget(ctx, row.ssh_host, row.ssh_port, nodeShellFallback(ctx, row.host_uri, row.dseq, 1, 1, "relayer"));
  }
  const ep = ctx.output<SshEndpoints>("send-manifests")?.perNode.relayer;
  if (!ep) throw new Error("relayer: no SSH endpoint recorded yet");
  const entry = ctx.output<DeploymentPlan>("create-deployments")?.perNode.relayer;
  const a = ctx.output<Assignments>("collect-bids")?.perNode.relayer;
  const fallback = a && entry ? nodeShellFallback(ctx, a.hostUri, entry.dseq, a.gseq, a.oseq, "relayer") : undefined;
  return sshTarget(ctx, ep.host, ep.port, fallback);
}

/** SSH into another fleet's sentry-0 with THAT fleet's key. */
function foreignSentryTarget(ctx: StepCtx, launchId: string): SshTarget {
  const row = (ctx.db.listFleetComponents(launchId) as FleetComponentRow[]).find((c) => c.key === "sentry-0");
  if (!row?.ssh_host || !row.ssh_port) throw new Error(`fleet ${launchId}: sentry-0 has no SSH endpoint recorded`);
  const pem = readSecretFile(path.join(launchDirs(ctx.workRoot, launchId).secrets, "ssh_ed25519.pem"));
  return { host: row.ssh_host, port: row.ssh_port, user: "root", privateKeyPem: toSsh2CompatiblePrivateKey(pem) };
}

/**
 * A counterparty fleet's sentry-0 must serve gRPC beyond localhost for the
 * relayer's tunnel to reach it — its own spec never asked for that. Opened
 * here, restarting the sentry only when the file changed; that fleet's
 * relaunches keep it open (relayedBy).
 */
async function openCounterpartySentries(ctx: StepCtx, plan: RelayPlan): Promise<void> {
  for (const chain of plan.chains) {
    if (!chain.launchId || chain.launchId === ctx.launchId) continue;
    const other = ctx.db.getLaunch(chain.launchId);
    if (!other) throw new Error(`relayer counterparty fleet ${chain.launchId} is gone`);
    const otherSpec = JSON.parse(other.spec_json) as LaunchSpec;
    const target = foreignSentryTarget(ctx, chain.launchId);
    const serve = { ...sentryServe(otherSpec), grpc: true };
    if (await patchSentryAppToml(ctx, fleetPeer("sentry-0", chain.launchId), target, serve)) {
      await restartNode(ctx.services.ssh, target);
    }
  }
}

/**
 * Link the relayer to every chain in its paths (§5 relayer): configure and
 * key it, wait until every key can pay gas, open each path's clients,
 * connection and channel, then pin the packet filter to exactly those
 * channels and start Hermes. Idempotent end to end — relayer-bringup reuses
 * whatever is already open — so a resume, a relink after a chain reset, or a
 * relaunched relayer all run the same thing.
 */
export async function linkRelayer(ctx: StepCtx, stepName: string, spec: LaunchSpec): Promise<RelayerLinkOutput> {
  const plan = relayPlan(ctx.db, ctx.launchId, spec);
  const mnemonic = await ensureRelayerMnemonic(ctx.dirs.secrets);
  const chains = await Promise.all(
    plan.chains.map(async (c) => ({
      chainId: c.chainId,
      address: await relayerAddress(mnemonic, c),
      ...(c.launchId ? { launchId: c.launchId } : {}),
    })),
  );

  await openCounterpartySentries(ctx, plan);

  const target = relayerTarget(ctx);
  const local = path.join(ctx.dirs.root, "relayer");
  fs.mkdirSync(path.join(local, "mnemonics"), { recursive: true });
  const put = async (name: string, content: string) => {
    const file = path.join(local, name);
    fs.writeFileSync(file, content, { mode: 0o600 });
    await ctx.services.ssh.upload(target, file, `${RELAYER_DIR}/${name}`);
  };
  await ctx.services.ssh.exec(target, `mkdir -p ${RELAYER_DIR}/mnemonics && chmod 700 ${RELAYER_DIR}/mnemonics`);
  await put("config.toml", renderHermesConfig(plan));
  await put("relayer.json", renderRelayManifest(plan));
  // one mnemonic, one file per chain: bringup imports each with that chain's
  // HD path and deletes it; the plaintext never outlives the import there
  for (const c of plan.chains) await put(`mnemonics/${c.chainId}.mnemonic`, mnemonic);
  fs.rmSync(path.join(local, "mnemonics"), { recursive: true, force: true });
  await ctx.services.ssh.exec(target, "relayer-bringup --keys-only");

  // every key must be able to pay gas before a handshake can start
  const check = await ctx.services.ssh.exec(target, "relayer-fundcheck || true");
  const status = JSON.parse(check.stdout) as Array<{
    chain: string;
    address: string;
    balance: string;
    denom: string;
    account: boolean | null;
    ready: boolean;
  }>;
  // the key lives on the relayer's provider: ask for gas money only, and
  // say so when a balance has grown past the cap
  for (const c of chains) {
    const planned = plan.chains.find((p) => p.chainId === c.chainId)!;
    const s = status.find((x) => x.chain === c.chainId);
    const cap = relayerCap(spec, planned);
    Object.assign(c, {
      ...(s ? { balance: s.balance, denom: s.denom || planned.gasDenom } : {}),
      ...(cap !== undefined ? { cap: cap.toString() } : {}),
    });
    if (s && cap !== undefined && BigInt(s.balance || "0") > cap) {
      ctx.log(
        `relayer: WARNING ${c.chainId} key ${c.address} holds ${s.balance} ${planned.gasDenom}, above its cap of ${cap}: ` +
          "the key sits on the relayer's provider; move the excess out",
      );
    }
  }
  const unready = status.filter((s) => !s.ready);
  if (unready.length > 0) {
    throw new AwaitUser(
      stepName,
      "fund the relayer so it can pay gas, then resume. Its key sits on the relayer's provider (Hermes cannot " +
        "sign through a session key), so send gas money only and top up later rather than pre-fund: " +
        unready
          .map((s) => {
            const planned = plan.chains.find((c) => c.chainId === s.chain);
            const address = s.address || chains.find((c) => c.chainId === s.chain)?.address;
            const denom = planned?.gasDenom ?? "its gas denom";
            const cap = planned ? relayerCap(spec, planned) : undefined;
            const topUp = planned ? suggestedTopUp(planned, cap) : undefined;
            // a chain with no gas price charges nothing, but the key still
            // needs an account and a balance: ask for "some", not "about 0"
            const amount =
              topUp === undefined ? "" : topUp === 0n ? "a small amount of " : `about ${topUp} `;
            return (
              `${s.chain}: send ${amount}${denom} to ${address}` +
              (topUp === 0n ? " (gas is free there, but the key needs an account with a balance)" : "") +
              (cap !== undefined ? ` (cap ${cap})` : "") +
              (s.account === false ? " (account not found yet)" : "")
            );
          })
          .join("; "),
    );
  }

  const opened = await ctx.services.ssh.exec(target, "relayer-bringup", { timeoutMs: BRINGUP_TIMEOUT_MS });
  const channels = JSON.parse(opened.stdout) as RelayChannel[];

  // pin the filter to the channels just opened, then (re)start hermes: a
  // first link only needs the ready marker; a relink restarts the container,
  // whose relayer-run re-execs hermes on the new config
  await put("config.toml", renderHermesConfig(plan, channels));
  const running = (await ctx.services.ssh.exec(target, `test -f ${RELAYER_DIR}/ready && echo running || true`)).stdout;
  await ctx.services.ssh.exec(target, `touch ${RELAYER_DIR}/ready`);
  if (running.includes("running")) {
    await ctx.services.ssh.exec(target, "(sleep 1; kill 1) >/dev/null 2>&1 &").catch(() => undefined);
  }

  const out: RelayerLinkOutput = { chains, channels, linkedAt: new Date().toISOString() };
  const previous = fs.existsSync(relayerStatePath(ctx.workRoot, ctx.launchId))
    ? (JSON.parse(fs.readFileSync(relayerStatePath(ctx.workRoot, ctx.launchId), "utf8")) as RelayerLinkOutput)
    : undefined;
  if (previous?.peers) out.peers = previous.peers;
  fs.writeFileSync(relayerStatePath(ctx.workRoot, ctx.launchId), JSON.stringify(out, null, 2));
  for (const ch of channels) {
    ctx.log(`relayer: ${ch.id} open — ${ch.a.chain}/${ch.a.channel} <-> ${ch.b.chain}/${ch.b.channel} (${ch.port})`);
  }
  return out;
}

/**
 * Bring every federation path's peers to ACTIVE on both chains (§5
 * peer-link): the relayer's channel carries nothing until each chain has
 * registered the other, set a policy and activated it. Both ends of a path to
 * another fleet are handled here, signed with each fleet's launcher-held
 * founder key. For a chain named by endpoints only this fleet's end is the
 * launcher's to do; the step then waits until that chain reports its end
 * ACTIVE, having written the messages its Operations Committee must send.
 */
export async function linkFederationPeers(
  ctx: StepCtx,
  stepName: string,
  spec: LaunchSpec,
): Promise<{ peers: PeerStatus[] }> {
  const plan = relayPlan(ctx.db, ctx.launchId, spec);
  const federation = plan.paths.filter((p) => p.kind === "federation");
  if (federation.length === 0) return { peers: [] };
  const state = fs.existsSync(relayerStatePath(ctx.workRoot, ctx.launchId))
    ? (JSON.parse(fs.readFileSync(relayerStatePath(ctx.workRoot, ctx.launchId), "utf8")) as RelayerLinkOutput)
    : undefined;
  if (!state) throw new Error("the relayer has not been linked yet: no channels to register peers on");

  const own = await fleetActor(ctx, ctx.launchId, "this fleet");
  const ownIdentity = await chainIdentity(own.rpc);
  const peers: PeerStatus[] = [];
  for (const p of federation) {
    const ch = state.channels.find((c) => c.id === p.id);
    if (!ch) throw new Error(`relayer path ${p.id} has no open channel yet`);
    // the transfer channel to the same chain, if the relayer opened one:
    // voucher metadata is keyed on it (MsgRegisterPeer ibc_transfer_channel_id)
    const xfer = state.channels.find((c) => c.port === "transfer" && c.b.chain === p.b);
    const counterparty = plan.chains.find((c) => c.chainId === p.b)!;
    const remote: ChainActor = counterparty.launchId
      ? await fleetActor(ctx, counterparty.launchId, `fleet ${counterparty.launchId}`)
      : {
          chainId: counterparty.chainId,
          rpc: counterparty.rpc,
          gasDenom: counterparty.gasDenom,
          gasPrice: counterparty.gasPrice,
          outDir: path.join(ctx.dirs.root, "peering"),
          label: "the counterparty chain (not launched here)",
        };
    const remoteIdentity = await chainIdentity(remote.rpc);
    peers.push(
      await ensurePeerActive(ctx, stepName, own, {
        id: p.b,
        type: "PEER_TYPE_SPARK_DREAM",
        displayName: p.b,
        ibcChannelId: ch.a.channel,
        ...(xfer ? { ibcTransferChannelId: xfer.a.channel } : {}),
        ...(remoteIdentity ? { peerIdentity: remoteIdentity } : {}),
        policy: sparkDreamPeerPolicy(),
      }),
    );
    peers.push(
      await ensurePeerActive(ctx, stepName, remote, {
        id: p.a,
        type: "PEER_TYPE_SPARK_DREAM",
        displayName: p.a,
        ibcChannelId: ch.b.channel,
        ...(xfer ? { ibcTransferChannelId: xfer.b.channel } : {}),
        ...(ownIdentity ? { peerIdentity: ownIdentity } : {}),
        policy: sparkDreamPeerPolicy(),
      }),
    );
  }
  // the fleet panel shows these beside the channels
  fs.writeFileSync(
    relayerStatePath(ctx.workRoot, ctx.launchId),
    JSON.stringify({ ...state, peers }, null, 2),
  );
  for (const peer of peers) ctx.log(`federation: ${peer.chainId} peer ${peer.peerId} ${peer.status}`);
  return { peers };
}

/** Launch step: link a relayer the spec enables, after the chain is verified. */
export const linkRelayerStep: StepDef = {
  name: "link-relayer",
  async run(ctx) {
    if (!ctx.spec.topology.components.relayer?.enabled) return { skipped: true };
    return linkRelayer(ctx, "link-relayer", ctx.spec);
  },
};

/** Launch step: register and activate the federation paths' peers. */
export const linkPeersStep: StepDef = {
  name: "link-peers",
  async run(ctx) {
    if (!ctx.spec.topology.components.relayer?.enabled) return { skipped: true };
    return linkFederationPeers(ctx, "link-peers", ctx.spec);
  },
};
