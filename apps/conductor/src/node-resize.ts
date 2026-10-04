import fs from "node:fs";
import path from "node:path";
import { NODE_SIZES, nodeRole, type LaunchSpec, type NodeSize, type RoleResources } from "@sparkdream/launch-spec";
import { AwaitUser, type StepCtx, type StepDef } from "./engine.js";
import { TypeUrl } from "./akash/messages.js";
import { loadSdl, sdlArtifacts } from "./akash/sdl-groups.js";
import {
  componentRow,
  nodeSelfHeight,
  prepareNodeHome,
  refreshSshEndpoints,
  relaunchSteps,
  rowTarget,
  sdlPathFor,
  sentryRpcHeight,
  wireMovedNode,
  type RelaunchParams,
} from "./fleet-ops.js";
import { NODE_HOME, NODE_LOG, NODE_RUNNING_PROBE, restartNode, socatTunnelCmd, START_NODE_CMD } from "./node-ops.js";
import { extractForwardedPort, loadCert, nodeShellFallback, pinnedValue, sshTarget } from "./steps/phase-bcd.js";
import type { GenerateKeysOutput } from "./steps/phase-a.js";
import type { SshTarget } from "./services.js";
import { probeSaysConnected, SIGNER_CONNECTED_PROBE } from "./tmkms.js";
import { managedSigner, repointSigner, signerDepsOf, tryManaged } from "./local-signer.js";

/** Params of a "node-resize" op: the relaunch's, plus the size to move to. */
export interface NodeResizeParams extends RelaunchParams {
  size: NodeSize;
  /** The node's provider when the resize was asked for: leased when it bids
   *  and the policy accepts it; otherwise the op parks for the operator to
   *  lease the policy's pick or a bid of their own. */
  stayOn?: string;
}

/** Local ports the staged node dials its sync peers through (one each). */
const SYNC_PORT_BASE = 17100;
const SYNC_POLL_MS = 15_000;
const SYNC_MAX_HOURS = 72;
/** How close to the fleet's head the staged node has to be to take over. */
const SYNC_SLACK_BLOCKS = 5;
/** A syncing node whose height has not moved for this long is stuck, not
 *  slow: the wait stops instead of polling it for days. */
const SYNC_STALL_MS = 10 * 60_000;
/** How far back the rate and ETA look: recent enough to follow the node's
 *  current speed, long enough to smooth single polls. */
const PACE_WINDOW_MS = 5 * 60_000;

const CONFIG = `${NODE_HOME}/config/config.toml`;
/** The config the bundle gave the staged node, restored at the cutover. */
const STAGED_ORIGINAL = `${CONFIG}.resize-orig`;
/** The staged node's sync config, which it must be on whenever it runs
 *  before the cutover (a rolled-back cutover leaves the launch config). */
const STAGED_SYNC = `${CONFIG}.resize-sync`;
/** The old node's config before it was retired, for undoing the retire. */
const RETIRE_BACKUP = `${CONFIG}.pre-resize`;

/**
 * Key files a node is pointed at while it must not be what it will become
 * (the staged node syncing) or what it was (the old node, retired). CometBFT
 * generates whatever these name at start, so the node runs as an anonymous
 * full node: its own node ID, no consensus key, signing nothing. The real
 * files stay where they are, untouched.
 */
const SYNC_KEYS = {
  node_key_file: "config/resize_sync_node_key.json",
  priv_validator_key_file: "config/resize_sync_pv_key.json",
  priv_validator_state_file: "data/resize_sync_pv_state.json",
  priv_validator_laddr: "",
};
const RETIRED_KEYS = {
  node_key_file: "config/resize_retired_node_key.json",
  priv_validator_key_file: "config/resize_retired_pv_key.json",
  priv_validator_state_file: "data/resize_retired_pv_state.json",
  priv_validator_laddr: "",
};

/**
 * Shell that sets base-section keys of config.toml: each key's line (if any)
 * is deleted and the new lines are prepended, since TOML takes base keys
 * before the first table and the validator template has no line for some of
 * them. Prepending rather than `sed a` because the node image's sed is
 * busybox.
 */
function setBaseKeysCmd(keys: Record<string, string>): string {
  const deletes = Object.keys(keys).map((k) => `/^${k}[[:space:]]*=/d`).join("; ");
  const lines = Object.entries(keys)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\\n");
  return (
    `sed -i '${deletes}' ${CONFIG} && ` +
    `{ printf '${lines}\\n'; cat ${CONFIG}; } > ${CONFIG}.tmp && mv ${CONFIG}.tmp ${CONFIG}`
  );
}

/**
 * Replace a node SDL's compute resources with `res`. Edited as text, like
 * the redeploy nonce: the rendered SDLs carry folded scalars and are
 * regex-edited by other steps, so a round trip through the YAML printer
 * risks reshaping lines those patterns depend on.
 */
export function withNodeResources(text: string, res: RoleResources): string {
  const block = /^( *)resources:\n((?:\1 +.*\n)+)/m;
  const m = block.exec(text);
  if (!m) throw new Error("node SDL has no compute resources block");
  const i = `${m[1]}  `;
  const body =
    `${i}cpu:\n${i}  units: ${res.cpu}\n` +
    `${i}memory:\n${i}  size: ${res.memory}\n` +
    `${i}storage:\n` +
    `${i}  - size: ${res.storage.root}\n` +
    `${i}  - name: data\n` +
    `${i}    size: ${res.storage.data}\n` +
    `${i}    attributes:\n` +
    `${i}      persistent: ${res.storage.persistent}\n` +
    `${i}      class: ${res.storage.class}\n`;
  return text.replace(block, `${m[1]}resources:\n${body}`);
}

const HELD_ACCEPT = "# resize-held-accept: ";

/**
 * Comment out the custom hosts (`accept:` lists) a node SDL serves. A staged
 * deployment carries them held back: a second lease claiming sentry-0's
 * public API and RPC hosts on the same provider could take their traffic
 * over (providers move a hostname to the owner's newest lease) to a node
 * that is still syncing. The lines stay in the file, so the cutover gets the
 * exact text back with {@link releaseAcceptHosts}.
 */
export function holdAcceptHosts(text: string): string {
  return text.replace(/^( +)accept:\n((?:\1 +- .*\n)+)/gm, (block) =>
    block.replace(/^( *)(\S.*)$/gm, (_l, indent: string, rest: string) => `${indent}${HELD_ACCEPT}${rest}`),
  );
}

/** Undo {@link holdAcceptHosts}. */
export function releaseAcceptHosts(text: string): string {
  return text.replace(new RegExp(`^( *)${HELD_ACCEPT}(.*)$`, "gm"), "$1$2");
}

export interface SyncSample {
  /** Wall-clock milliseconds. */
  at: number;
  height: number;
  head: number;
}

/**
 * Sync speed and time left from recent samples. The ETA divides the gap by
 * how fast the GAP closes, not by the node's own speed: the chain's head
 * keeps moving while the node catches up, so the node's block rate alone
 * promises an arrival that keeps receding (seen live: "~22m left" for
 * minutes on end).
 */
export function syncPace(samples: SyncSample[]): { rate?: number; etaSeconds?: number } {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return {};
  const dt = (last.at - first.at) / 1000;
  if (dt <= 0) return {};
  const rate = (last.height - first.height) / dt;
  const gap = last.head - last.height;
  const closing = (first.head - first.height - gap) / dt;
  return {
    ...(rate > 0 ? { rate } : {}),
    ...(closing > 0 && gap > 0 ? { etaSeconds: gap / closing } : {}),
  };
}

interface SyncPeer {
  key: string;
  id: string;
  ip: string;
  port: number;
}

interface StageOutput {
  stagedIp: string;
  peers: SyncPeer[];
}

interface CutoverOutput {
  oldDseq: string;
  oldProvider: string;
  oldTailnetIp: string | null;
  /** The old node's last signed height, handed to the new one (softsign). */
  watermarkHeight?: number;
}

/** What the component looked like before the cutover, pinned so a re-run
 *  after the row switched still knows what to close. */
interface OldPlacement {
  dseq: string;
  provider: string;
  tailnetIp: string | null;
}

/**
 * Move a chain node to a deployment of another size without losing its
 * block history, and with the node down only for the cutover.
 *
 * Akash fixes a deployment's resources, so a resize is a new deployment.
 * Rather than close the node and replay the chain into the new one (down for
 * the whole replay, which grows with the chain), the new deployment is
 * staged BESIDE the running node and fully synced from the fleet's own nodes
 * first, as an anonymous full node with keys of its own. Full sync, not
 * state sync: launcher-genesis fleets keep every block on every node, and
 * the next relaunch of this node's peers replays from block 1 off it. (Join
 * fleets state-sync, as their relaunches do: the chain they joined never
 * served its early blocks to them.)
 *
 * The cutover then swaps identities. The old node is retired in place: its
 * config is pointed at freshly generated keys and it restarts as an
 * anonymous full node, which frees its node ID and, for a softsign
 * validator, freezes its signing watermark. The new node gets the real node
 * key, the consensus key and that watermark, so it can never sign at or
 * below a height the old one signed. The component row moves to the new
 * deployment, the fleet is re-wired to its address exactly as after a
 * relaunch, and the node starts at once. The old deployment is closed after
 * that, and the relaunch's persist (and signer gate, and mesh-client pass)
 * finishes the job.
 *
 * A cutover that fails before the row moves undoes the retire, so the old
 * node goes back to what it was.
 */
export function nodeResizeSteps(opId: number, params: NodeResizeParams, spec: LaunchSpec): StepDef[] {
  const { key, size } = params;
  const p = (s: string) => `op${opId}:${s}`;
  const role = nodeRole(key);
  const isValidator = role === "validator";
  const softsign = isValidator && spec.security.keyMode === "softsign";
  const stagedSdl = (ctx: StepCtx) => path.join(ctx.dirs.sdl, `${key}.resize-op${opId}.yaml`);
  const stagedManifest = (ctx: StepCtx) => path.join(ctx.dirs.sdl, `${key}.resize-op${opId}.manifest.json`);
  const stagedSshPin = (ctx: StepCtx) => path.join(ctx.dirs.root, `op${opId}-staged-ssh.json`);

  const relaunch = relaunchSteps(opId, params, spec, {
    staged: { sdl: stagedSdl, manifest: stagedManifest },
    requiresCustomDomain: (ctx) => ctx.output<{ requiresCustomDomain?: boolean }>(p("render"))?.requiresCustomDomain,
    // staying keeps sentry-0's DNS target; moving is the operator's call
    ...(params.stayOn ? { pickUnlessProvider: params.stayOn } : {}),
    beforeOwnPush: async (ctx) => {
      // the node runs as an SSH-started process since the cutover; the push
      // re-creates the container under it, which killed a young node
      // mid-commit once (a torn state whose replay panics), so stop it
      // cleanly first and let the entrypoint own the next boot
      await stopNode(ctx, rowTarget(ctx, componentRow(ctx, key)));
    },
  });
  const pick = (name: string) => relaunch.filter((s) => s.name === p(name));

  /** The staged node's SSH target, re-read from its lease when it moved. */
  const stagedTarget = (ctx: StepCtx): SshTarget => {
    const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
    const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
    const pinned = fs.existsSync(stagedSshPin(ctx))
      ? (JSON.parse(fs.readFileSync(stagedSshPin(ctx), "utf8")) as { host: string; port: number })
      : ctx.output<{ host: string; port: number }>(p("manifest"))!;
    return sshTarget(
      ctx,
      pinned.host,
      pinned.port,
      nodeShellFallback(ctx, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, "sparkdreamd"),
    );
  };
  const refreshStagedSsh = async (ctx: StepCtx): Promise<void> => {
    const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
    const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
    try {
      const status = await ctx.services.provider.leaseStatus(loadCert(ctx), lease.hostUri, deploy.dseq, lease.gseq, lease.oseq);
      fs.writeFileSync(stagedSshPin(ctx), JSON.stringify(extractForwardedPort(status, 2222)));
    } catch {
      // the provider cannot say right now; the caller's loop retries
    }
  };

  /** Bring the staged node's sync tunnels and process back if they are gone
   *  (its container restarted, which leaves it in wait mode). */
  const ensureSyncing = async (ctx: StepCtx): Promise<boolean> => {
    const stage = ctx.output<StageOutput>(p("stage"))!;
    const target = stagedTarget(ctx);
    const running = await ctx.services.ssh.exec(target, NODE_RUNNING_PROBE, {
      quick: true,
    });
    if (running.stdout.trim() === "yes") return false;
    for (const peer of stage.peers) await ctx.services.ssh.exec(target, socatTunnelCmd(peer.port, peer.ip));
    // never under the real node key while the old node still holds it
    await ctx.services.ssh.exec(target, `grep -q resize_sync_node_key ${CONFIG} || cp ${STAGED_SYNC} ${CONFIG}`);
    await ctx.services.ssh.exec(target, START_NODE_CMD);
    return true;
  };

  /** Where the fleet's chain is: a sentry's RPC, or the old node itself. */
  const fleetHead = async (ctx: StepCtx): Promise<number | undefined> => {
    try {
      const h = await sentryRpcHeight(ctx);
      if (h !== undefined) return h;
    } catch {
      // no sentry answering: fall through to the node being replaced
    }
    return nodeSelfHeight(ctx, componentRow(ctx, key));
  };

  /**
   * Wait for the staged node to reach the fleet's head, publishing its
   * position as the op's progress. Re-attaches to a sync already running.
   */
  const waitSynced = async (ctx: StepCtx, maxMs: number): Promise<number> => {
    const samples: SyncSample[] = [];
    let lastMoved = 0;
    let lastHeight: number | undefined;
    let lastLogged = 0;
    let restarts = 0;
    let quiet = 0;
    const polls = Math.max(1, Math.ceil(maxMs / SYNC_POLL_MS));
    for (let i = 0; i < polls; i++) {
      const now = i * SYNC_POLL_MS;
      if (i > 0) await ctx.services.sleep(SYNC_POLL_MS);
      // an abort closes the new deployment under this loop, whose probes
      // swallow errors: stop on the op's status instead of polling for days
      if (ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId)?.status !== "active") {
        throw new Error(`${key}: the resize was aborted`);
      }
      let height: number | undefined;
      let catchingUp = true;
      try {
        const out = await ctx.services.ssh.exec(
          stagedTarget(ctx),
          "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true",
          { quick: true },
        );
        const h = Number(/latest_block_height"?\s*:\s*"?(\d+)/.exec(out.stdout)?.[1]);
        if (Number.isFinite(h) && h > 0) height = h;
        catchingUp = /catching_up"?\s*:\s*"?(\w+)/.exec(out.stdout)?.[1] !== "false";
      } catch {
        await refreshStagedSsh(ctx);
      }
      if (height === undefined) {
        // not serving yet (booting, or a state sync still restoring), or
        // gone: after a minute of silence look for the process itself
        if (++quiet >= 4) {
          quiet = 0;
          const restarted = await ensureSyncing(ctx).catch(() => false);
          if (restarted && ++restarts > 5) {
            const log = await ctx.services.ssh
              .exec(stagedTarget(ctx), `tail -n 15 ${NODE_LOG} 2>/dev/null || true`)
              .catch(() => ({ stdout: "" }));
            throw new Error(`${key}: the new deployment's node keeps exiting while it syncs. Last output:\n${log.stdout.trim()}`);
          }
          if (restarted) ctx.log(`${key}: the new deployment's node was not running; started it again`);
        }
        continue;
      }
      quiet = 0;
      const head = await fleetHead(ctx).catch(() => undefined);
      if (head !== undefined) {
        samples.push({ at: Date.now(), height, head });
        while (samples.length > 2 && samples.at(-1)!.at - samples[0]!.at > PACE_WINDOW_MS) samples.shift();
      }
      const pace = syncPace(samples);
      ctx.db.setFleetOpProgress(opId, {
        label: `${key}: syncing the ${size} deployment`,
        current: height,
        target: head,
        percent: head ? Math.round(Math.min(100, (height / head) * 100) * 10) / 10 : undefined,
        rate: pace.rate ? Math.round(pace.rate * 100) / 100 : undefined,
        etaSeconds: pace.etaSeconds ? Math.round(pace.etaSeconds) : undefined,
        elapsedSeconds: Math.round(now / 1000),
        updatedAt: new Date().toISOString(),
      });
      if (!catchingUp && (head === undefined || height >= head - SYNC_SLACK_BLOCKS)) return height;
      // slow is fine, stuck is not: a node that stops advancing gets reported
      // rather than watched until the cap
      if (lastHeight === undefined || height > lastHeight) {
        lastHeight = height;
        lastMoved = now;
      } else if (now - lastMoved >= SYNC_STALL_MS) {
        const log = await ctx.services.ssh
          .exec(stagedTarget(ctx), `tail -n 15 ${NODE_LOG} 2>/dev/null || true`)
          .catch(() => ({ stdout: "" }));
        throw new Error(
          `${key}: the new deployment has not advanced past height ${height} for ` +
            `${Math.round(SYNC_STALL_MS / 60_000)} minutes. Resume to keep waiting. Last output:\n${log.stdout.trim()}`,
        );
      }
      if (now - lastLogged >= 10 * 60_000) {
        lastLogged = now;
        ctx.log(`${key}: new deployment at height ${height}${head ? ` of ${head}` : ""}`);
      }
    }
    throw new Error(
      `${key}: the new deployment is still syncing after ${Math.round(maxMs / 3_600_000)} hours; it keeps going ` +
        "on its own, so resume the op to keep watching it",
    );
  };

  return [
    {
      name: p("render"),
      async run(ctx) {
        // the node's current SDL, at the new size: env, tunnels and image
        // stay what the running node has, its public hosts held back
        const text = fs.readFileSync(sdlPathFor(ctx, key), "utf8");
        fs.writeFileSync(stagedSdl(ctx), holdAcceptHosts(withNodeResources(text, NODE_SIZES[size][role])));
        return {
          size,
          resources: NODE_SIZES[size][role],
          requiresCustomDomain: sdlArtifacts(loadSdl(sdlPathFor(ctx, key))).requiresCustomDomain,
        };
      },
    },
    ...pick("deploy"),
    ...pick("lease"),
    ...pick("manifest"),
    {
      name: p("stage"),
      async run(ctx) {
        const target = stagedTarget(ctx);
        await prepareNodeHome(ctx, spec, key, target, { withoutSigningKey: true });
        await ctx.services.ssh.exec(target, `cp ${CONFIG} ${STAGED_ORIGINAL}`);

        let stagedIp = "";
        for (let attempt = 1; attempt <= 30; attempt++) {
          const res = await ctx.services.ssh.exec(target, `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ip -4 2>/dev/null || true`);
          stagedIp = res.stdout.trim().split("\n")[0] ?? "";
          if (/^100\./.test(stagedIp)) break;
          if (attempt === 30) throw new Error(`${key}: the new deployment never joined the mesh`);
          await ctx.services.sleep(5000);
        }

        // Sync from the fleet's own full nodes: every sentry, plus the node
        // being replaced (a validator's only full-history peer when it has
        // no sentry of its own). Reached through tunnels, since a userspace
        // tailnet IP cannot be dialed from a normal socket.
        const ids = ctx.output<GenerateKeysOutput>("generate-keys")?.nodeIds ?? {};
        const sources = [
          ...Array.from({ length: spec.topology.sentries.count }, (_, s) => `sentry-${s}`),
          ...(isValidator ? [key] : []),
        ];
        const rows = ctx.db.listFleetComponents(ctx.launchId);
        const peers: SyncPeer[] = [];
        for (const k of sources) {
          const row = rows.find((c) => c.key === k);
          if (!row || row.state !== "active" || !row.tailnet_ip || !ids[k]) continue;
          peers.push({ key: k, id: ids[k]!, ip: row.tailnet_ip, port: SYNC_PORT_BASE + peers.length });
        }
        if (peers.length === 0 && !spec.join) {
          throw new Error(`${key}: no node of the fleet is up to sync the new deployment from`);
        }
        for (const peer of peers) await ctx.services.ssh.exec(target, socatTunnelCmd(peer.port, peer.ip));
        const peerLine = [
          ...peers.map((x) => `${x.id}@127.0.0.1:${x.port}`),
          ...(spec.join?.peers ?? []),
        ].join(",");
        await ctx.services.ssh.exec(
          target,
          `${setBaseKeysCmd(SYNC_KEYS)} && sed -i ` +
            `'s|^persistent_peers[[:space:]]*=.*|persistent_peers = "${peerLine}"|; ` +
            `s|^external_address = .*|external_address = ""|; ` +
            `s|^pex = .*|pex = false|; ` +
            `s|^allow_duplicate_ip = .*|allow_duplicate_ip = true|' ${CONFIG} && cp ${CONFIG} ${STAGED_SYNC}`,
        );
        await ctx.services.ssh.exec(target, START_NODE_CMD);
        ctx.log(`${key}: new ${size} deployment syncing from ${peers.map((x) => x.key).join(", ") || "the join peers"}`);
        return { stagedIp, peers } satisfies StageOutput;
      },
    },
    {
      name: p("sync"),
      async run(ctx) {
        await ensureSyncing(ctx).catch(() => false);
        const height = await waitSynced(ctx, SYNC_MAX_HOURS * 3_600_000);
        ctx.log(`${key}: new deployment caught up at height ${height}`);
        return { height };
      },
    },
    // A tmkms validator signs nothing between the retire and the moment its
    // signer dials the new address, so the operator hears about the new
    // address BEFORE the cutover, once, with time to edit tmkms.toml.
    ...(isValidator && spec.security.keyMode === "tmkms"
      ? [
          {
            name: p("prepare-signer"),
            async run(ctx: StepCtx) {
              // an op that reached the cutover before this step existed (or a
              // re-run past it) has nothing left to warn about
              if (ctx.db.getStep(ctx.launchId, p("cutover"))?.status === "done") return { skipped: true };
              const told = path.join(ctx.dirs.root, `op${opId}-signer-told`);
              const stage = ctx.output<StageOutput>(p("stage"))!;
              const addr = `tcp://${stage.stagedIp}:26659`;
              if (fs.existsSync(told)) return { addr };
              // a signer on the launcher's own machine needs no warning: the
              // launcher repoints and restarts it at the handover itself
              if (managedSigner(signerDepsOf(ctx), key)) {
                ctx.log(`${key}: the launcher repoints its managed tmkms signer at ${addr} during the handover`);
                return { addr, managed: true };
              }
              fs.writeFileSync(told, new Date().toISOString());
              throw new AwaitUser(
                p("prepare-signer"),
                `${key}'s new deployment has caught up. The next step hands the validator over to it, and ` +
                  `from then on it signs nothing until your tmkms signer dials its new address:\n` +
                  `  addr = "${addr}"\n` +
                  "Edit the [[validator]] block of tmkms.toml now, but do not restart the signer yet (the old " +
                  "node is still signing). Resume when you are at the signer: the handover takes about a " +
                  "minute, then the op pauses with the tmkms panel open, and that is when you restart it.",
              );
            },
          },
        ]
      : []),
    {
      name: p("cutover"),
      async run(ctx) {
        const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
        const lease = ctx.output<{ provider: string; hostUri: string; price: string }>(p("lease"))!;
        const current = componentRow(ctx, key);
        const old = JSON.parse(
          await pinnedValue(ctx, `op${opId}-resize-old`, async () =>
            JSON.stringify({
              dseq: current.dseq,
              provider: current.provider,
              tailnetIp: current.tailnet_ip,
            } satisfies OldPlacement),
          ),
        ) as OldPlacement;
        if (current.dseq === deploy.dseq) {
          // a re-run after the row already moved: nothing left to hand over
          return { oldDseq: old.dseq, oldProvider: old.provider, oldTailnetIp: old.tailnetIp } satisfies CutoverOutput;
        }

        // the op may have waited (a signature, a pause) since the sync
        await ensureSyncing(ctx).catch(() => false);
        // as long as it takes: the stall check stops a node that is stuck
        await waitSynced(ctx, SYNC_MAX_HOURS * 3_600_000);
        const staged = stagedTarget(ctx);
        await stopNode(ctx, staged);
        // the sync tunnels (SYNC_PORT_BASE upwards)
        await ctx.services.ssh.exec(staged, `pkill -f "^socat TCP-LISTEN:171[0-9][0-9]," 2>/dev/null; true`);

        const realId = ctx.output<GenerateKeysOutput>("generate-keys")?.nodeIds[key];
        if (!realId) throw new Error(`no node id recorded for ${key}`);
        await retireOld(ctx, key, realId, p("cutover"));

        let watermark: string | undefined;
        let watermarkHeight: number | undefined;
        try {
          if (softsign) {
            // the old node stopped signing with the restart above, so this
            // is the last height it will ever have signed
            const state = await ctx.services.ssh.exec(
              rowTarget(ctx, componentRow(ctx, key)),
              `cat ${NODE_HOME}/data/priv_validator_state.json`,
            );
            const parsed = JSON.parse(state.stdout) as { height?: string };
            if (parsed.height === undefined) throw new Error("no height in the old node's signing state");
            watermark = state.stdout;
            watermarkHeight = Number(parsed.height);
          }
          // the staged node becomes the node: its launch config back (the
          // real node key it never used), and for a softsign validator the
          // consensus key and the old node's watermark
          let promote = `cp ${STAGED_ORIGINAL} ${CONFIG}`;
          if (softsign) {
            await ctx.services.ssh.upload(staged, path.join(ctx.dirs.bundles, `${key}.tgz`), "/tmp/node-data.tgz");
            const local = path.join(ctx.dirs.root, `op${opId}-watermark.json`);
            fs.writeFileSync(local, watermark!);
            await ctx.services.ssh.upload(staged, local, `${NODE_HOME}/data/priv_validator_state.json`);
            promote +=
              ` && tar xzf /tmp/node-data.tgz -C ${NODE_HOME} config/priv_validator_key.json` +
              " && rm -f /tmp/node-data.tgz";
          }
          promote +=
            ` && rm -f ${NODE_HOME}/config/resize_sync_node_key.json ${NODE_HOME}/config/resize_sync_pv_key.json` +
            ` ${NODE_HOME}/data/resize_sync_pv_state.json`;
          await ctx.services.ssh.exec(staged, promote);
        } catch (e) {
          // the old node goes back to what it was; the staged one keeps no
          // key and goes back on its sync config
          await ctx.services.ssh
            .exec(staged, `rm -f ${NODE_HOME}/config/priv_validator_key.json; cp ${STAGED_SYNC} ${CONFIG}`)
            .catch(() => undefined);
          const undone = await unretireOld(ctx, key).then(
            () => "the old node was restored and is running as before",
            (u) => `restoring the old node ALSO failed (${u instanceof Error ? u.message : String(u)}): ` +
              `run restart on ${key}, then check that it signs`,
          );
          throw new Error(
            `${key}: the cutover failed (${e instanceof Error ? e.message : String(e)}); ${undone}. ` +
              "Resume to try the cutover again, or abort to close the new deployment",
          );
        }

        // from here on the new deployment IS the component
        const manifest = ctx.output<{ host: string; port: number }>(p("manifest"))!;
        const ssh = fs.existsSync(stagedSshPin(ctx))
          ? (JSON.parse(fs.readFileSync(stagedSshPin(ctx), "utf8")) as { host: string; port: number })
          : manifest;
        // its public hosts come back with it; persist's update claims them,
        // after close-old has let them go
        fs.writeFileSync(sdlPathFor(ctx, key), releaseAcceptHosts(fs.readFileSync(stagedSdl(ctx), "utf8")));
        fs.copyFileSync(stagedManifest(ctx), path.join(ctx.dirs.sdl, `${key}.manifest.json`));
        ctx.db.updateComponentPlacement(ctx.launchId, key, {
          dseq: deploy.dseq,
          provider: lease.provider,
          host_uri: lease.hostUri,
          price: lease.price,
          generation: params.generation,
        });
        ctx.db.updateComponentRuntime(ctx.launchId, key, { ssh_host: ssh.host, ssh_port: ssh.port });
        ctx.db.setComponentState(ctx.launchId, key, "relaunching");
        recordNodeSize(ctx, key, size);
        ctx.db.setFleetOpProgress(opId, null);
        return {
          oldDseq: old.dseq,
          oldProvider: old.provider,
          oldTailnetIp: old.tailnetIp,
          ...(watermarkHeight !== undefined ? { watermarkHeight } : {}),
        } satisfies CutoverOutput;
      },
    },
    {
      // the relaunch's own configure step name: persist and the signer gate
      // read the new tailnet IP from it
      name: p("configure"),
      async run(ctx) {
        const cut = ctx.output<CutoverOutput>(p("cutover"))!;
        return wireMovedNode(ctx, spec, key, rowTarget(ctx, componentRow(ctx, key)), {
          deploy: ctx.output<{ dseq: string }>(p("deploy"))!,
          lease: ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!,
          oldTailnetIp: cut.oldTailnetIp,
        });
      },
    },
    {
      name: p("start-node"),
      async run(ctx) {
        // started now rather than at persist, whose update tx can wait on a
        // signature for as long as the operator takes
        const target = rowTarget(ctx, componentRow(ctx, key));
        const up = async () =>
          (await ctx.services.ssh.exec(target, NODE_RUNNING_PROBE, { quick: true }))
            .stdout.trim() === "yes";
        if (isValidator && spec.security.keyMode === "tmkms") {
          // A remote-signer node waits only seconds for its signer at start,
          // then exits ("can't get pubkey: endpoint connection timed out"),
          // and the signer still dials the old address until the operator
          // repoints it. Keep starting it until a signer session exists
          // (seen live 2026-10-03: one start, one exit, a halted devnet).
          const cfg = ctx.output<{ tailnetIp: string }>(p("configure"))!;
          const addr = `tcp://${cfg.tailnetIp}:26659`;
          // managed signer: repointed and restarted right here, the moment
          // the old node stopped signing (tmkms keeps redialing until the
          // node below is up)
          const local = await tryManaged(signerDepsOf(ctx), (d) =>
            repointSigner(d, key, cfg.tailnetIp, "resize handover"),
          );
          if (!local.managed) ctx.log(`${key}: handed over; restart your tmkms signer now (addr = "${addr}")`);
          for (let i = 0; i < 36; i++) {
            if (!(await up().catch(() => true))) {
              await ctx.services.ssh.exec(target, START_NODE_CMD).catch(() => undefined);
            }
            await ctx.services.sleep(5000);
            const probe = await ctx.services.ssh
              .exec(target, SIGNER_CONNECTED_PROBE, { quick: true })
              .catch(() => ({ stdout: "" }));
            if (probeSaysConnected(probe.stdout)) {
              ctx.db.setComponentState(ctx.launchId, key, "active");
              ctx.log(`${key}: signer connected; the validator is signing on the new deployment`);
              return { started: true, signerConnected: true };
            }
          }
          throw new AwaitUser(
            p("start-node"),
            `${key} is on its new deployment and signs nothing until your tmkms signer dials it. Make sure ` +
              `tmkms.toml has\n  addr = "${addr}"\nin the [[validator]] block, restart the signer, then resume. ` +
              "The node is started again on resume and kept starting until the signer connects (it exits " +
              "after a few seconds without one). Keep the signer's state file: its watermark is what stops " +
              "a double-sign." +
              local.note,
          );
        }
        if (!(await up())) await ctx.services.ssh.exec(target, START_NODE_CMD);
        await ctx.services.sleep(5000);
        if (!(await up())) {
          const log = await ctx.services.ssh.exec(target, `tail -n 15 ${NODE_LOG} 2>/dev/null || true`);
          throw new Error(`${key}: the node did not start on the new deployment. Last output:\n${log.stdout.trim()}`);
        }
        ctx.db.setComponentState(ctx.launchId, key, "active");
        return { started: true };
      },
    },
    {
      name: p("close-old"),
      async run(ctx) {
        const cut = ctx.output<CutoverOutput>(p("cutover"))!;
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const lease = await ctx.services.api.leaseState(owner, cut.oldDseq, cut.oldProvider);
        if (lease === "active") {
          await ctx.requireTx(p("close-old"), [
            { typeUrl: TypeUrl.CloseDeployment, value: { id: { owner, dseq: cut.oldDseq } } },
          ]);
        } else {
          ctx.db.deletePendingTx(ctx.launchId, p("close-old"));
        }
        return { closedDseq: cut.oldDseq };
      },
    },
    ...pick("persist"),
    ...pick("await-signer"),
    ...pick("mesh-clients"),
    ...pick("public-dns"),
  ];
}

/** Stop an SSH-started node cleanly and confirm it is gone. */
async function stopNode(ctx: StepCtx, target: SshTarget): Promise<void> {
  await ctx.services.ssh.exec(target, "pkill -x sparkdreamd || true");
  for (let i = 0; i < 30; i++) {
    const alive = await ctx.services.ssh.exec(target, NODE_RUNNING_PROBE, {
      quick: true,
    });
    if (alive.stdout.trim() === "no") return;
    if (i === 15) await ctx.services.ssh.exec(target, "pkill -9 -x sparkdreamd || true");
    await ctx.services.sleep(2000);
  }
  throw new Error("sparkdreamd would not stop");
}

/** The node ID the node's running process reports, if it answers. */
async function runningNodeId(ctx: StepCtx, key: string): Promise<string | undefined> {
  const out = await ctx.services.ssh.exec(
    rowTarget(ctx, componentRow(ctx, key)),
    "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true",
    { quick: true },
  );
  // non-greedy across protocol_version, the object node_info opens with
  return /"node_info"\s*:\s*\{[\s\S]*?"id"\s*:\s*"([0-9a-f]{40})"/.exec(out.stdout)?.[1];
}

/**
 * Point the old node at freshly generated keys and restart it, then confirm
 * the restarted process runs under another node ID: from that moment it
 * signs nothing and the real node ID is free for the new deployment.
 */
async function retireOld(ctx: StepCtx, key: string, realId: string, step: string): Promise<void> {
  const reach = async () => rowTarget(ctx, componentRow(ctx, key));
  let retired = false;
  for (let attempt = 0; attempt < 3 && !retired; attempt++) {
    try {
      await ctx.services.ssh.exec(
        await reach(),
        `[ -f ${RETIRE_BACKUP} ] || cp ${CONFIG} ${RETIRE_BACKUP}; ` +
          `grep -q resize_retired_node_key ${CONFIG} || { ${setBaseKeysCmd(RETIRED_KEYS)}; }`,
      );
      retired = true;
    } catch {
      await refreshSshEndpoints(ctx, [componentRow(ctx, key)]);
    }
  }
  if (!retired) {
    throw new AwaitUser(
      step,
      `${key}'s current node does not answer over SSH, so it cannot hand its identity over safely. ` +
        "A resize needs the old node reachable; if it is gone for good, relaunch it instead (relaunch " +
        "handles a dead node). Otherwise resume once it answers again.",
    );
  }
  await restartNode(ctx.services.ssh, await reach());
  let lastId: string | undefined;
  for (let i = 0; i < 36; i++) {
    await ctx.services.sleep(5000);
    try {
      lastId = await runningNodeId(ctx, key);
      if (lastId && lastId !== realId) {
        ctx.log(`${key}: old node retired (now running as ${lastId.slice(0, 12)}…, signing nothing)`);
        return;
      }
    } catch {
      // the restart moved its SSH endpoint, or it is still coming up
      await refreshSshEndpoints(ctx, [componentRow(ctx, key)]).catch(() => undefined);
    }
  }
  await unretireOld(ctx, key).catch(() => undefined);
  throw new Error(
    `${key}: the old node did not come back under a new identity after its retire restart ` +
      `(${lastId ? `still running as ${lastId.slice(0, 12)}…` : "no answer from its RPC"}); it was restored as it was`,
  );
}

/** The steps that hand the node's identity over: an abort while one of them
 *  runs would race it (undoing the retire while the new node is being given
 *  the key), so it waits for them to finish or fail. */
export const HANDOVER_STEPS = ["cutover", "configure", "start-node"];

/** Shell undoing retireOld's config change; prints "restored" when there
 *  was one to undo (the node then needs a restart to run on it). */
export const UNRETIRE_CMD =
  `grep -q resize_retired_node_key ${CONFIG} && [ -f ${RETIRE_BACKUP} ] && ` +
  `cp ${RETIRE_BACKUP} ${CONFIG} && echo restored; true`;

/** Undo retireOld: the old node's own config back, and a restart onto it. */
async function unretireOld(ctx: StepCtx, key: string): Promise<void> {
  const target = rowTarget(ctx, componentRow(ctx, key));
  const out = await ctx.services.ssh.exec(target, UNRETIRE_CMD);
  if (out.stdout.includes("restored")) await restartNode(ctx.services.ssh, target);
}

/** Record the node's size in the stored spec, which every later render of
 *  it (relaunch, upgrade, re-place) reads. */
function recordNodeSize(ctx: StepCtx, key: string, size: NodeSize): void {
  const launch = ctx.db.getLaunch(ctx.launchId)!;
  const stored = JSON.parse(launch.spec_json);
  stored.infra = stored.infra ?? {};
  stored.infra.nodeSizes = { ...(stored.infra.nodeSizes ?? {}), [key]: size };
  ctx.db.setLaunchSpec(ctx.launchId, JSON.stringify(stored));
}
