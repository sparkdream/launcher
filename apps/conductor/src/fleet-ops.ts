import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { chainId, headscaleDomain, nodes, resolveTopology, statelessComponents, tunnelPort, withDefaults, type ComponentRef, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, FleetOpRow } from "./db.js";
import { AwaitUser, type StepCtx, type StepDef } from "./engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import { createDeploymentMsg, createLeaseMsg, TypeUrl, type Msg } from "./akash/messages.js";
import { feeCoin, feeConfig } from "./fee.js";
import { PRICING_DENOM } from "./render-sdl.js";
import { isManifestAlreadyDeployed, pollBids } from "./akash/client.js";
import { describeBids, exclusionEntries, manualBidRequired, selectProvider, type Bid, type OfferedBid, type PolicyDecision, type ProviderInfo } from "./akash/policy.js";
import { loadSdl, sdlArtifacts, sortedJson } from "./akash/sdl-groups.js";
import { extractForwardedPort, headscaleUserId, loadCert, nodeRpcUrl, nodeShellFallback, pinnedValue, sshTarget, templateHeadscaleSdl, waitLeaseStatus, type HeadscaleOutput } from "./steps/phase-bcd.js";
import {
  buildGenesisFiles,
  createNamedAccounts,
  packageNodeDataStep,
  placeholder,
  type GenerateKeysOutput,
} from "./steps/phase-a.js";
import { sparkdreamd } from "./exec.js";
import { explorerChainEnv, renderComponentSdl, EXPLORER_SENTRY, EXPLORER_TUNNELS } from "./render-component-sdl.js";
import { ingressHost } from "./steps/phase-ef.js";
import { resolveStateSyncTrust } from "./steps/join.js";
import { accountCoordinates, awaitTxIncluded, queryJson } from "./steps/phase-g.js";
import {
  assembleUnjailTxJson,
  buildUnjailSignDoc,
  valoperAddress,
  verifySignedDoc,
  type GentxSignResponse,
} from "./gentx.js";
import { NODE_HOME, NODE_LOG, restartNode, rpcUrl, socatTunnelCmd, START_NODE_CMD, VAL_PEER_TUNNEL_PORT, WITNESS_RPC_PORT } from "./node-ops.js";
import { probeSaysConnected, SIGNER_CONNECTED_PROBE } from "./tmkms.js";
import { readSecretFile } from "./secrets.js";
import type { SshTarget } from "./services.js";

/**
 * Fleet operations (M5): relaunch (§5 "Component relaunch & close") and
 * rolling upgrades (§5 "Node upgrades") expressed as engine step lists
 * composed onto the owning launch — they inherit checkpointing, the signing
 * loop, and resume for free. Step names are op-scoped (`op<N>:...`) so
 * generations never collide.
 */

const DEPOSIT: Record<string, string> = { uakt: "5000000", uact: "5000000" };
/** §5: wait this many blocks past the last signed height before a relaunched
 *  softsign validator starts signing. */
const DOUBLE_SIGN_WINDOW = 20;

export interface RelaunchParams {
  key: string;
  generation: number;
  /** Provider addresses to keep this relaunch OFF (broken/unwanted hosts). */
  avoidProviders?: string[];
  /** Provider addresses to try first (promoted in the preference order). */
  preferProviders?: string[];
  /** Operator picks the bid by hand: the lease step parks with the bid list
   *  on this op row instead of applying the selection policy. */
  manualBid?: boolean;
  /** The pick, once made. Scoped to the deployment the bids belong to — a
   *  later attempt (new dseq) draws new bids, so an old pick never applies. */
  bidChoice?: { dseq: string; provider: string };
  /** Bids on offer for the pick, refreshed each time the step parks. */
  offeredBids?: { dseq: string; bids: OfferedBid[] };
}

export interface UpgradeParams {
  /** Components in rolling order (sentries first, then validators). */
  components: string[];
  image: string;
}

function componentRow(ctx: StepCtx, key: string): FleetComponentRow {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key === key,
  );
  if (!row) throw new Error(`fleet component ${key} not found`);
  return row;
}

/**
 * The headscale lease to mint preauth keys against. A fleet with its own
 * mesh has a "headscale" component row; a shared-mesh fleet (reuseFleet)
 * has none — its deploy-headscale output points at the owning fleet's
 * lease (headscale never relaunches, so the output stays current).
 */
function headscaleRef(ctx: StepCtx): { hostUri: string; dseq: string; gseq: number; oseq: number } {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key === "headscale",
  );
  // single-group SDL ⇒ gseq/oseq are always 1
  if (row) return { hostUri: row.host_uri, dseq: row.dseq, gseq: 1, oseq: 1 };
  const hs = ctx.db.stepOutput<HeadscaleOutput>(ctx.launchId, "deploy-headscale");
  if (!hs) throw new Error("no headscale for this fleet (deploy-headscale never ran)");
  return { hostUri: hs.hostUri, dseq: hs.dseq, gseq: hs.gseq, oseq: hs.oseq };
}

/**
 * Which mesh component each of `key`'s TS_TUNNEL_* entries dials, keyed by
 * the tunnel's local port (the port is what identifies the peer: the
 * renderers derive it from the peer's index, or from a fixed constant).
 * Everything that re-aims a tunnel env reads this map, so a component's
 * mesh dependencies are stated once.
 */
function tunnelPeers(spec: LaunchSpec, key: string): Map<number, string> {
  const topo = resolveTopology(spec);
  const peers = new Map<number, string>();
  if (key.startsWith("val-")) {
    // join mode bakes an own-sentry witness + peer tunnel (see the persist
    // step); a fresh-launch validator has neither, and an absent entry
    // simply matches nothing.
    const s = topo.validatorSentries[Number(key.split("-")[1])]?.[0];
    if (s !== undefined) {
      peers.set(WITNESS_RPC_PORT, `sentry-${s}`);
      peers.set(VAL_PEER_TUNNEL_PORT, `sentry-${s}`);
    }
  } else if (key.startsWith("sentry-")) {
    for (const v of topo.sentryValidators[Number(key.split("-")[1])] ?? []) {
      peers.set(tunnelPort(v), `val-${v}`);
    }
  } else if (key === "explorer") {
    for (const t of EXPLORER_TUNNELS) peers.set(t.local, EXPLORER_SENTRY);
  }
  return peers;
}

/**
 * Re-aim every TS_TUNNEL_* target in an SDL at the CURRENT tailnet IP of the
 * component it dials. Tailnet IPs are not stable across a peer's lifetime: a
 * peer relaunch or a headscale re-key hands out a different address, and the
 * env baked at launch (or at this component's last persist) then names a dead
 * one. Observed live: an explorer relaunched after its sentry had moved came
 * back tunnelling to the sentry's pre-relaunch IP and served nothing until the
 * env was edited by hand.
 *
 * Placeholder targets are resolved the same way, so an SDL that never reached
 * persist-start is also handled. A peer with no recorded IP is left as-is.
 */
function retargetTunnelEnv(
  ctx: StepCtx,
  spec: LaunchSpec,
  key: string,
  text: string,
): { text: string; changes: string[] } {
  const peers = tunnelPeers(spec, key);
  if (peers.size === 0) return { text, changes: [] };
  const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
  const changes: string[] = [];
  const out = text.replace(
    /TS_TUNNEL_([A-Za-z0-9_]+)=(\d+):(.+?):(\d+)(?=["'\s]|$)/g,
    (whole, name: string, local: string, target: string, remote: string) => {
      const peerKey = peers.get(Number(local));
      if (!peerKey) return whole;
      const ip = rows.find((c) => c.key === peerKey)?.tailnet_ip;
      if (!ip || ip === target) return whole;
      changes.push(`${peerKey} ${target} → ${ip}`);
      return `TS_TUNNEL_${name}=${local}:${ip}:${remote}`;
    },
  );
  return { text: out, changes };
}

/** Mesh components whose tunnel env dials `key` (the explorer, for a sentry). */
function meshDependents(spec: LaunchSpec, key: string): string[] {
  return statelessComponents(spec)
    .filter((c) => c.mesh && [...tunnelPeers(spec, c.key).values()].includes(key))
    .map((c) => c.key);
}

function rowTarget(ctx: StepCtx, row: FleetComponentRow): SshTarget {
  if (!row.ssh_host || !row.ssh_port) throw new Error(`${row.key}: no SSH endpoint recorded`);
  return sshTarget(ctx, row.ssh_host, row.ssh_port, nodeShellFallback(ctx, row.host_uri, row.dseq));
}

function sdlPathFor(ctx: StepCtx, key: string): string {
  return path.join(ctx.dirs.sdl, `${key}.yaml`);
}

async function sentryRpcHeight(ctx: StepCtx, excludeKey?: string): Promise<number | undefined> {
  const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key.startsWith("sentry-") && c.state === "active" && c.key !== excludeKey,
  );
  if (!sentry) return undefined;
  const url = await nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  return (await ctx.services.rpc.status(url)).latestBlockHeight;
}

/** The line cosmos prints on its way down when `halt-height` fires. */
export function haltLogLine(haltHeight: number): string {
  return `halt per configuration height ${haltHeight}`;
}

/** Log tail pulled when looking for the halt line: a boot prints a lot. */
const HALT_LOG_TAIL = 500;

/**
 * Swap the version tag on a recorded image reference.
 *
 * Only ever rewrites a tag that already looks like a version (`v1.2.3` or
 * `1.2.3`), preserving the `v` prefix if it had one: a node reports a version,
 * not an image name, so re-tagging anything else — a floating tag, a
 * digest pin, a custom build — would be a guess. Returns undefined when it
 * cannot tell, so the caller keeps the recorded reference rather than
 * inventing one.
 */
export function retagImage(image: string | null, version: string): string | undefined {
  if (!image) return undefined;
  const at = image.lastIndexOf(":");
  if (at <= image.lastIndexOf("/")) return undefined; // no tag at all
  const prefix = /^(v?)\d+\.\d+\.\d+/.exec(image.slice(at + 1))?.[1];
  if (prefix === undefined) return undefined;
  return `${image.slice(0, at)}:${prefix}${version.replace(/^v/, "")}`;
}

/**
 * Has this node hit its configured halt height?
 *
 * Read from the container's own log stream, and deliberately neither an RPC
 * probe nor an SSH one — both fail for the same reason. sparkdreamd is PID 1
 * (deploy/docker/entrypoint_ssh.sh `exec "$@"`), so refusing the halt-height
 * block exits the container and Akash restarts it, which boots straight back
 * into the same halt: a halted node is a CRASH LOOP, not a stopped process.
 * There is no window where the container is up and the node is down, so
 * "sparkdreamd is gone" is never observable; RPC is dead throughout (and
 * cosmos refuses the halt block inside FinalizeBlock, so the head stops at
 * H-1 and never reaches H anyway); and SSH only answers during each boot
 * attempt, disappearing entirely into the provider's restart backoff
 * ("no active replicas for service"). The log stream is the one source that
 * outlives the restarts, and the halt line is reprinted on every lap.
 */
async function haltObserved(
  ctx: StepCtx,
  row: FleetComponentRow,
  haltHeight: number,
): Promise<boolean> {
  const logs = await ctx.services.provider.leaseLogs(
    loadCert(ctx),
    row.host_uri,
    row.dseq,
    1,
    1,
    HALT_LOG_TAIL,
  );
  return logs.includes(haltLogLine(haltHeight));
}

/**
 * Run a command on a node that may be halting.
 *
 * The crash loop means SSH answers only inside each boot window (sshd comes
 * up before the entrypoint execs sparkdreamd) and refuses connections for the
 * whole of the provider's restart backoff between them. A single attempt is a
 * coin flip, so retry until one lands.
 */
async function execOnHaltingNode(
  ctx: StepCtx,
  row: FleetComponentRow,
  command: string,
  attempts = 120,
): Promise<string> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await ctx.services.ssh.exec(rowTarget(ctx, row), command, { quick: true });
      return res.stdout;
    } catch (e) {
      last = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      if (i === 0 || i % 12 === 0) ctx.log(`${row.key}: waiting for a boot window — ${last}`);
    }
    await ctx.services.sleep(5000);
  }
  throw new Error(`${row.key}: command never landed after ${attempts} attempts (last: ${last})`);
}

/**
 * Manual bid selection (the relaunch option): instead of letting the policy
 * pick, park the op with every bid on the order recorded on its row, and
 * lease exactly the one the operator names — policy filters, the avoid list
 * and anti-affinity included. The whole point is to reach a provider the
 * automatic selection keeps passing over (a cheap host the price-median or
 * uptime floor rejects), so a rejected bid stays choosable; the reason is
 * carried through to the picker and logged when the pick is honored.
 *
 * The choice is scoped to `dseq`: bids belong to one order, so a pick made
 * for an earlier attempt (abandoned op, re-deploy) never carries over.
 */
async function manualBidChoice(
  ctx: StepCtx,
  opId: number,
  stepName: string,
  key: string,
  dseq: string,
  open: Bid[],
  providers: Map<string, ProviderInfo>,
  decision: PolicyDecision,
): Promise<Bid> {
  const op = ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId);
  const params = JSON.parse(op?.params_json ?? "{}") as RelaunchParams;
  const choice = params.bidChoice;
  if (choice && choice.dseq === dseq) {
    const hit = open.find((b) => b.bid.id.provider === choice.provider);
    if (hit) {
      const why = decision.rejected.find((r) => r.provider === choice.provider)?.reason;
      ctx.log(
        `${key}: leasing hand-picked bid from ${choice.provider} ` +
          `(${providers.get(choice.provider)?.hostUri ?? "unknown host"})` +
          (why ? ` — overriding the policy, which rejected it: ${why}` : ""),
      );
      return hit;
    }
    ctx.log(`${key}: the picked bid (${choice.provider}) is no longer on offer — pick again`);
  }
  const offers = describeBids(open, providers, decision);
  const { bidChoice: _dropped, ...rest } = params;
  ctx.db.updateFleetOpParams(opId, { ...rest, offeredBids: { dseq, bids: offers } });
  ctx.log(`${key}: ${offers.length} bid(s) on offer, waiting for a manual pick`);
  throw new AwaitUser(
    stepName,
    `${key}: pick which bid to lease — the fleet panel lists the ${offers.length} bid(s) on ` +
      "this deployment. Bids close a few minutes after they arrive, so if the lease then " +
      "fails, abandon this operation and relaunch to draw a fresh set.",
  );
}

/** Relaunch: close → fresh deploy on a new provider → rewire → guarded start.
 *  Stateless components (§5): no volume, keys, peers, or double-sign risk —
 *  the rewiring and guarded-start steps are replaced by an HTTP health gate. */
export function relaunchSteps(opId: number, params: RelaunchParams, spec: LaunchSpec): StepDef[] {
  const { key } = params;
  const p = (s: string) => `op${opId}:${s}`;
  const isValidator = key.startsWith("val-");
  const valIndex = isValidator ? Number(key.split("-")[1]) : -1;
  const stateless = statelessComponents(spec).find((c) => c.key === key);
  // Trailing steps are conditional (a tmkms validator gets a signer gate, a
  // node the explorer dials gets a mesh-client repoint), so which one closes
  // the op out varies — name it once instead of guessing in each step.
  const signerGate = isValidator && spec.security.keyMode === "tmkms";
  const lastStep = p(
    meshDependents(spec, key).length > 0
      ? "mesh-clients"
      : signerGate
        ? "await-signer"
        : "persist",
  );

  const steps: StepDef[] = [];

  steps.push({
    name: p("close"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      let baseline: number | undefined;
      if (isValidator && spec.security.keyMode === "softsign") {
        // §5 double-sign safety: record height before the old node dies
        baseline = await sentryRpcHeight(ctx);
      }
      const lease = await ctx.services.api.leaseState(owner, row.dseq, row.provider);
      if (lease === "active") {
        await ctx.requireTx(p("close"), [
          { typeUrl: TypeUrl.CloseDeployment, value: { id: { owner, dseq: row.dseq } } },
        ]);
      }
      // old node must actually be gone (zombie check, §5). Proof of
      // execution required, not mere reachability: some provider gateways
      // (observed on jjozzietech) answer lease-shell for an already-closed
      // lease with empty success, which read as "still alive" and wedged
      // the op behind a container that was long torn down.
      if (row.ssh_host && row.ssh_port) {
        try {
          const probe = await ctx.services.ssh.exec(rowTarget(ctx, row), "echo zombie-probe");
          if (probe.stdout.includes("zombie-probe")) {
            throw new AwaitUser(
              p("close"),
              `${key}'s old container still answers SSH after close: wait for the provider to tear it down, then resume`,
            );
          }
        } catch (e) {
          if (e instanceof AwaitUser) throw e;
          // unreachable — exactly what we want
        }
      }
      ctx.db.setComponentState(ctx.launchId, key, "relaunching");
      return { closedDseq: row.dseq, oldTailnetIp: row.tailnet_ip, baselineHeight: baseline };
    },
  });

  steps.push({
    name: p("deploy"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      // the frontend never joins the mesh — no preauth key to mint
      if (!stateless || stateless.mesh) {
        // fresh preauth key via headscale lease-shell (§5: expired keys
        // re-minted; the headscale image has no sshd) — own row or, for a
        // shared mesh, the owning fleet's lease. preauthkeys --user needs
        // the numeric id.
        const hsRef = headscaleRef(ctx);
        // PINNED: this step re-runs after the signature pause — a re-minted
        // key would rewrite the SDL/manifest and drift from the SIGNED
        // deployment's hash (the provider then 422s the manifest)
        const authkey = await pinnedValue(ctx, `op${opId}-authkey`, async () => {
          const userId = await headscaleUserId(ctx, hsRef, spec.network.name);
          const mint = await ctx.services.provider.shellExec(
            loadCert(ctx),
            hsRef.hostUri,
            hsRef.dseq,
            hsRef.gseq,
            hsRef.oseq,
            "headscale",
            ["sh", "-c", `headscale preauthkeys create --user ${userId} --reusable --expiration 8760h --output json`],
          );
          const parsedKey = JSON.parse(mint.stdout.trim());
          const k: string = typeof parsedKey === "string" ? parsedKey : parsedKey.key;
          if (!k) throw new Error("no preauth key in mint output");
          return k;
        });

        const sdlPath = sdlPathFor(ctx, key);
        let sdl = fs.readFileSync(sdlPath, "utf8");
        sdl = sdl.replace(/TS_AUTHKEY=[^\n"']*/g, `TS_AUTHKEY=${authkey}`);
        // fresh volume must wait for node-data again (no-op for components)
        sdl = sdl.replace(/WAIT_FOR_CONFIG=false/g, "WAIT_FOR_CONFIG=true");
        // the peers this component tunnels to may have moved since its env
        // was last written (their own relaunch, a headscale re-key) — deploy
        // with their CURRENT addresses so the fresh container comes up
        // dialing something alive. Nodes get re-wired again at persist; for a
        // stateless component this is the only pass there is.
        const retarget = retargetTunnelEnv(ctx, spec, key, sdl);
        for (const c of retarget.changes) ctx.log(`${key}: tunnel re-aimed at ${c}`);
        fs.writeFileSync(sdlPath, retarget.text);
      }
      const sdlPath = sdlPathFor(ctx, key);

      const artifacts = sdlArtifacts(loadSdl(sdlPath));
      const dseq = await pinnedValue(ctx, `op${opId}-dseq`, async () =>
        String(await ctx.services.api.latestBlockHeight()),
      );
      fs.writeFileSync(
        path.join(ctx.dirs.sdl, `${key}.manifest.json`),
        artifacts.manifestJson,
      );
      const msgs: Msg[] = [
        createDeploymentMsg({
          owner,
          dseq,
          groups: artifacts.groups,
          hash: artifacts.hash,
          deposit: {
            denom: artifacts.pricingDenom,
            amount: DEPOSIT[artifacts.pricingDenom] ?? "5000000",
          },
        }),
      ];
      await ctx.requireTx(p("deploy"), msgs);
      return { dseq, requiredStorageClass: artifacts.requiredStorageClass };
    },
  });

  steps.push({
    name: p("lease"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const deploy = ctx.output<{ dseq: string; requiredStorageClass?: string }>(p("deploy"))!;
      const providers = await ctx.services.api.listProviders();

      // A lease already signed on a prior run IS the choice — don't re-poll
      // bids (leasing flips the winner to "active" and closes the rest; a
      // re-poll would grind through the whole budget and then misreport
      // "no acceptable bids"). Same short-circuit as deploy-headscale.
      const leaseRow = ctx.db.getPendingTx(ctx.launchId, p("lease"));
      if (leaseRow && (leaseRow.status === "signed" || leaseRow.status === "confirmed")) {
        const bidId = JSON.parse(leaseRow.msgs_json)[0].value.bidId;
        await ctx.requireTx(p("lease"), [createLeaseMsg(bidId)]);
        const all = await ctx.services.api.listBids(owner, deploy.dseq);
        return {
          provider: bidId.provider,
          gseq: bidId.gseq,
          oseq: bidId.oseq,
          hostUri: providers.get(bidId.provider)!.hostUri,
          price: all.find((b) => b.bid.id.provider === bidId.provider)?.bid.price.amount ?? "0",
        };
      }

      // avoid (hard, regardless of anti-affinity mode): any provider we're
      // explicitly moving off of — including the one this component just ran
      // on. A relaunch is a "move", so re-picking the same (often broken)
      // provider defeats the purpose. exclude (per the policy's anti-affinity
      // mode): other active components' providers. Stateless components are
      // exempt from anti-affinity (§6) — only the avoid list constrains them.
      const avoidProviders = new Set<string>(params.avoidProviders ?? []);
      const exclude = new Set<string>();
      if (!stateless) {
        for (const c of ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]) {
          if (c.key !== key && c.state === "active") exclude.add(c.provider);
        }
      }
      const bids = await pollBids(ctx.services.api, owner, deploy.dseq, {
        sleep: ctx.services.sleep,
        minBids: 1,
        // console-air-style: gather a fuller bid set before the policy engine picks
        settleRounds: 2,
      });
      // prefer-listed providers win first (before the spec's own preference)
      const preference = [
        ...new Set([...(params.preferProviders ?? []), ...spec.providers.policy.preference]),
      ];
      const open = bids.filter((b) => b.bid.state === "open");
      const decision = selectProvider(open, {
        policy: { ...spec.providers.policy, preference },
        chosenProviders: exclude,
        avoidProviders,
        excludeMatchers: exclusionEntries(spec, key),
        log: ctx.log,
        requiredStorageClass: deploy.requiredStorageClass,
        providers,
      });
      // hand-picked: the operator's bid wins over everything above. The
      // relaunch may ask for a pick; the spec may also require one for this
      // component, in which case every placement of it is the operator's.
      const chosen =
        (params.manualBid ?? manualBidRequired(spec, key)) && open.length > 0
          ? await manualBidChoice(ctx, opId, p("lease"), key, deploy.dseq, open, providers, decision)
          : decision.chosen;
      if (!chosen) {
        // distinguish "market had nothing" from "the bids expired": a bid
        // not leased within a few minutes closes, and providers do not
        // re-bid on an old order — resuming here can never succeed, so
        // point at the abandon path instead of looping on the same order
        const expired = bids.length > 0 && bids.every((b) => b.bid.state !== "open");
        throw new AwaitUser(
          p("lease"),
          expired
            ? `the bids for ${key}'s relaunch deployment have expired (a lease must be signed ` +
                "within a few minutes of the bids arriving). Resuming cannot recover this: " +
                "use Abandon on this operation to close the deployment and refund its escrow, " +
                `then relaunch ${key} again and sign the lease promptly`
            : `no acceptable bids for ${key} relaunch avoiding ${avoidProviders.size + exclude.size} provider(s): ${JSON.stringify(decision.rejected)}`,
        );
      }
      const bidId = chosen.bid.id;
      await ctx.requireTx(p("lease"), [createLeaseMsg(bidId)]);
      return {
        provider: bidId.provider,
        gseq: bidId.gseq,
        oseq: bidId.oseq,
        hostUri: providers.get(bidId.provider)!.hostUri,
        price: chosen.bid.price.amount,
      };
    },
  });

  steps.push({
    name: p("manifest"),
    async run(ctx) {
      const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
      const lease = ctx.output<{
        provider: string;
        gseq: number;
        oseq: number;
        hostUri: string;
        price: string;
      }>(p("lease"))!;
      const cert = loadCert(ctx);
      const manifest = fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8");
      // reconcile hash drift (e.g. pre-pin re-mints rewrote the manifest
      // after the deployment was signed) — update-in-place keeps the lease
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const wantHash = crypto.createHash("sha256").update(manifest).digest("base64");
      const onChain = await ctx.services.api.deploymentInfo(owner, deploy.dseq);
      if (onChain?.hash && onChain.hash !== wantHash) {
        ctx.log(`${key} manifest hash drifted from deployment ${deploy.dseq} — updating on-chain`);
        await ctx.requireTx(`${p("update")}:${wantHash.slice(0, 8)}`, [
          {
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: deploy.dseq }, hash: wantHash },
          },
        ]);
      }
      await ctx.services.provider.sendManifest(cert, lease.hostUri, deploy.dseq, manifest);
      // the frontend image runs no sshd — just wait for the workload
      const wantSsh = !stateless || stateless.mesh;
      const status = await waitLeaseStatus(
        ctx,
        cert,
        lease.hostUri,
        deploy.dseq,
        lease.gseq,
        lease.oseq,
        wantSsh ? { forwardedPort: 2222 } : {},
      );
      ctx.db.updateComponentPlacement(ctx.launchId, key, {
        dseq: deploy.dseq,
        provider: lease.provider,
        host_uri: lease.hostUri,
        price: lease.price,
        generation: params.generation,
      });
      if (!wantSsh) return {};
      const ssh = extractForwardedPort(status, 2222);
      ctx.db.updateComponentRuntime(ctx.launchId, key, {
        ssh_host: ssh.host,
        ssh_port: ssh.port,
      });
      return ssh;
    },
  });

  if (stateless) {
    // §5: stateless components skip the node rewiring and guarded start —
    // the container is live once it answers on its domain. Its tunnels come
    // up correct at boot because the deploy step re-aimed the env at the
    // peers' current tailnet IPs.
    steps.push({
      name: p("verify"),
      async run(ctx) {
        const url = `https://${stateless!.domain}/`;
        for (let i = 0; i < 36; i++) {
          if (await ctx.services.rpc.httpOk(url)) {
            ctx.db.setComponentState(ctx.launchId, key, "active");
            ctx.db.setFleetOpStatus(opId, "done");
            return { healthy: true, url };
          }
          await ctx.services.sleep(5000);
        }
        // the relaunch moved providers, so the domain's DNS record now
        // points at the OLD provider's ingress — pause with the new target
        const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
        const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
        const ingress = await ingressHost(
          ctx, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, stateless!.domain,
        );
        throw new AwaitUser(
          p("verify"),
          `${key} not answering at ${url} — update the DNS record for ${stateless!.domain} → ` +
            `CNAME ${ingress} (the relaunch moved providers), then resume`,
        );
      },
    });
    return steps;
  }

  steps.push({
    name: p("configure"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const target = rowTarget(ctx, row);
      // upload node data (same node key → same node ID, §5) — new volume
      const bundle = path.join(ctx.dirs.bundles, `${key}.tgz`);
      await ctx.services.ssh.upload(target, bundle, "/tmp/node-data.tgz");
      await ctx.services.ssh.exec(
        target,
        `mkdir -p ${NODE_HOME} && tar xzf /tmp/node-data.tgz -C ${NODE_HOME} && touch ${NODE_HOME}/.node-data-uploaded`,
      );
      if (spec.join) {
        // join fleets: the bundle's [statesync] block still carries the
        // launch-time trust anchor, long outside the light-client trust
        // period by relaunch time. The relaunched node starts on an empty
        // volume and MUST state-sync, so re-resolve a fresh anchor (the
        // same refresh start-chain performs) and re-enable [statesync] in
        // case the bundle was packaged with it flipped off.
        const trust = await resolveStateSyncTrust(ctx);
        let servers = trust.rpcServers.join(",");
        if (isValidator) {
          // own-sentry witness on localhost, same rationale as start-chain:
          // the bundle RPCs may be unreachable from the NEW provider
          // (egress filtering killed exactly this relaunch's state sync on
          // datanode.uk), and the local proxy is provider-agnostic
          const s = resolveTopology(spec).validatorSentries[valIndex]?.[0];
          const sentryIp = s !== undefined ? componentRow(ctx, `sentry-${s}`).tailnet_ip : null;
          if (sentryIp) {
            await ctx.services.ssh.exec(target, socatTunnelCmd(WITNESS_RPC_PORT, sentryIp, 26657));
            servers = `http://127.0.0.1:${WITNESS_RPC_PORT},${servers}`;
          }
        }
        await ctx.services.ssh.exec(
          target,
          `sed -i 's|^rpc_servers = .*|rpc_servers = "${servers}"|; ` +
            `s|^trust_height = .*|trust_height = ${trust.trustHeight}|; ` +
            `s|^trust_hash = .*|trust_hash = "${trust.trustHash}"|; ` +
            `/^\\[statesync\\]$/,/^\\[/ s|^enable = false|enable = true|' ${NODE_HOME}/config/config.toml`,
        );
        ctx.log(`${key}: state-sync trust anchor refreshed at height ${trust.trustHeight}`);
      }
      if (!isValidator) {
        // advertise-peers: the new lease assigned a new forwarded 26656 —
        // re-stamp external_address so the sentry keeps advertising a
        // reachable public peer address (§5 "Public peering"). The uploaded
        // node data still carries the OLD lease's address, so on failure it
        // must be blanked, not kept: a stale address gossips a dead endpoint.
        const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
        const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
        let advertised = "";
        try {
          const status = await waitLeaseStatus(
            ctx, loadCert(ctx), lease.hostUri, deploy.dseq, lease.gseq, lease.oseq,
            { forwardedPort: 26656, attempts: 6 },
          );
          const ep = extractForwardedPort(status, 26656);
          advertised = `${ep.host}:${ep.port}`;
        } catch {
          ctx.log(`${key}: provider forwards no P2P port; clearing the stale external_address`);
        }
        await ctx.services.ssh.exec(
          target,
          `sed -i 's|^external_address = .*|external_address = "${advertised}"|' ${NODE_HOME}/config/config.toml`,
        );
      }
      // await mesh join → new tailnet IP
      let ip = "";
      for (let attempt = 1; attempt <= 30; attempt++) {
        const res = await ctx.services.ssh.exec(
          target,
          `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ip -4 2>/dev/null || true`,
        );
        ip = res.stdout.trim().split("\n")[0] ?? "";
        if (/^100\./.test(ip)) break;
        if (attempt === 30) throw new Error(`${key} never joined the mesh after relaunch`);
        await ctx.services.sleep(5000);
      }
      ctx.db.updateComponentRuntime(ctx.launchId, key, { tailnet_ip: ip });
      // The tmkms setup checklist and the signer panel render addresses from
      // the launch's await-mesh table, not from the component rows, so a
      // relaunch that only updated the row left them printing the address
      // this node just moved off — the operator then repoints the signer at
      // a dead endpoint. Refresh it here, same as the headscale relaunch.
      const launchMesh = ctx.db.stepOutput<{ ips: Record<string, string> }>(ctx.launchId, "await-mesh");
      if (launchMesh) {
        ctx.db.stepDone(ctx.launchId, "await-mesh", { ips: { ...launchMesh.ips, [key]: ip } });
      }

      const topo = resolveTopology(spec);
      const publicPeered = new Set<number>();
      if (isValidator) {
        // patch own config's sentry placeholders — public endpoint first
        // (same rationale as patch-validator-peers), tailnet IP fallback
        for (const s of topo.validatorSentries[valIndex] ?? []) {
          const sentryRow = componentRow(ctx, `sentry-${s}`);
          const sentryIp = sentryRow.tailnet_ip;
          if (!sentryIp) throw new Error(`sentry-${s} has no recorded tailnet IP`);
          const token = placeholder.tailnetIp(`sentry-${s}`);
          try {
            const status = await ctx.services.provider.leaseStatus(
              loadCert(ctx), sentryRow.host_uri, sentryRow.dseq, 1, 1,
            );
            const pub = extractForwardedPort(status, 26656);
            const probe = await ctx.services.ssh.exec(
              target,
              `nc -zw 4 ${pub.host} ${pub.port} >/dev/null 2>&1 && echo open || echo closed`,
              { quick: true },
            );
            if (probe.stdout.includes("open")) {
              // cover both the placeholder form and an already-substituted
              // tailnet form (bundles re-packaged after a launch carry IPs)
              await ctx.services.ssh.exec(
                target,
                `sed -i 's|${token}:26656|${pub.host}:${pub.port}|g; ` +
                  `s|@${sentryIp}:26656|@${pub.host}:${pub.port}|g' ${NODE_HOME}/config/config.toml`,
              );
              ctx.log(`${key}: peering with sentry-${s} over its public endpoint ${pub.host}:${pub.port} (no relay)`);
              publicPeered.add(s);
            }
          } catch {
            // no forwarded p2p or probe failure — tailnet fallback below
          }
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|${token}|${sentryIp}|g' ${NODE_HOME}/config/config.toml`,
          );
        }
        // §5: relaunching a validator re-wires its sentries' tunnels.
        // socatTunnelCmd self-cleans the port, so no manual pkill (which,
        // unanchored, could kill its own sh wrapper mid-command).
        for (const s of topo.validatorSentries[valIndex] ?? []) {
          const sentryRow = componentRow(ctx, `sentry-${s}`);
          const port = tunnelPort(valIndex);
          await ctx.services.ssh.exec(rowTarget(ctx, sentryRow), socatTunnelCmd(port, ip));
        }
        if (spec.join) {
          // join validators with no public path still dial OUT through a
          // local mesh proxy — the sentry dial-in alone leaves the link
          // hostage to the sentry dialer's exponential backoff whenever the
          // validator was down a while
          const s0 = (topo.validatorSentries[valIndex] ?? [])[0];
          const sentryIp0 = s0 !== undefined ? componentRow(ctx, `sentry-${s0}`).tailnet_ip : null;
          if (s0 !== undefined && !publicPeered.has(s0) && sentryIp0) {
            await ctx.services.ssh.exec(target, socatTunnelCmd(VAL_PEER_TUNNEL_PORT, sentryIp0, 26656));
            await ctx.services.ssh.exec(
              target,
              `sed -i 's|@${sentryIp0}:26656|@127.0.0.1:${VAL_PEER_TUNNEL_PORT}|' ${NODE_HOME}/config/config.toml`,
            );
          }
        }
      } else {
        // relaunched sentry: create its own tunnels to current validator IPs
        const sIndex = Number(key.split("-")[1]);
        for (const v of topo.sentryValidators[sIndex] ?? []) {
          const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
          if (!valIp) throw new Error(`val-${v} has no recorded tailnet IP`);
          const port = tunnelPort(v);
          await ctx.services.ssh.exec(target, socatTunnelCmd(port, valIp));
        }
        // sentry mesh: the re-uploaded bundle's config still carries tailnet
        // placeholders for the OTHER sentries — substitute their current IPs
        // (same wiring wire-tunnels does on first launch). A fellow sentry
        // with no recorded IP (e.g. mid-relaunch itself) is skipped: its own
        // relaunch re-patches this side when it comes back.
        for (let s2 = 0; s2 < spec.topology.sentries.count; s2++) {
          if (s2 === sIndex) continue;
          const otherIp = componentRow(ctx, `sentry-${s2}`).tailnet_ip;
          if (!otherIp) {
            ctx.log(`${key}: sentry-${s2} has no recorded tailnet IP yet; leaving its peer entry for its own relaunch to fix`);
            continue;
          }
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|${placeholder.tailnetIp(`sentry-${s2}`)}|${otherIp}|g' ${NODE_HOME}/config/config.toml`,
          );
        }
        // §5: relaunching a sentry re-patches its validators' AND fellow
        // sentries' persistent_peers — the old tailnet IP is dead, and the
        // sentry mesh link is the only bridge between validator islands.
        const close = ctx.output<{ oldTailnetIp: string | null }>(p("close"))!;
        const dependents = [
          ...(topo.sentryValidators[sIndex] ?? []).map((v) => `val-${v}`),
          ...Array.from({ length: spec.topology.sentries.count }, (_, s2) => `sentry-${s2}`)
            .filter((k) => k !== key),
        ];
        for (const depKey of dependents) {
          const row = componentRow(ctx, depKey);
          if (!row.tailnet_ip) continue; // not reachable/placed right now
          if (close.oldTailnetIp) {
            await ctx.services.ssh.exec(
              rowTarget(ctx, row),
              `sed -i 's|${close.oldTailnetIp}|${ip}|g' ${NODE_HOME}/config/config.toml`,
            );
          }
          // peer change requires a process restart (documented in the dialog)
          await restartNode(ctx.services.ssh, rowTarget(ctx, row));
        }
      }
      return { tailnetIp: ip };
    },
  });

  steps.push({
    name: p("start"),
    async run(ctx) {
      const close = ctx.output<{ baselineHeight?: number }>(p("close"))!;
      const cfg = ctx.output<{ tailnetIp: string }>(p("configure"))!;

      if (isValidator && spec.security.keyMode === "tmkms") {
        // §5 tmkms fleets: the relaunch moved the validator, so the signer
        // has to be repointed. This step can only ANNOUNCE the new address,
        // never verify it: sparkdreamd owns the privval listener (26660,
        // fronted by the entrypoint's keepalive proxy on 26659) and it has
        // not booted yet — the persist step below is its first and only
        // start. A gate here on that port could therefore never pass, and a
        // resume with a perfectly repointed signer failed forever (observed
        // live). The real check runs after the boot, in await-signer.
        ctx.log(
          `${key}: repoint your tmkms signer while this finishes — ` +
            `addr = "tcp://${cfg.tailnetIp}:26659"`,
        );
      }
      if (isValidator && spec.security.keyMode === "softsign" && close.baselineHeight !== undefined) {
        // §5 double-sign safety window: wait N blocks past the pre-close height
        for (let i = 0; i < 120; i++) {
          const height = await sentryRpcHeight(ctx, key);
          if (height !== undefined && height >= close.baselineHeight + DOUBLE_SIGN_WINDOW) break;
          if (i === 119) throw new Error("double-sign window never cleared (chain halted?)");
          await ctx.services.sleep(5000);
        }
      }
      // Deliberately NOT starting sparkdreamd here. This step used to
      // SSH-start it, and the persist step's manifest push then restarted
      // the container underneath the young process — observed live killing
      // a validator mid-first-commit right after its state-sync restore,
      // leaving a torn state (storeHeight = appHeight + 1) whose boot-time
      // replay panicked, i.e. a crash loop. The node boots exactly once,
      // entrypoint-owned, when persist flips WAIT_FOR_CONFIG off.
      ctx.db.setComponentState(ctx.launchId, key, "active");
      return { gated: true };
    },
  });

  steps.push({
    name: p("persist"),
    async run(ctx) {
      // §5 step 20b, relaunch edition: the deploy step ships the fresh
      // volume in wait mode; this step persists the final shape into the
      // deployments — WAIT_FOR_CONFIG=false so the entrypoint owns
      // sparkdreamd, current tunnel targets in env so restarts self-heal,
      // and the same corrections for the counterpart sentries whose env
      // still names the old validator IP. The manifest push restarts the
      // containers, and THAT restart is the node's first boot: the start
      // step gates but does not launch, so nothing can be killed mid-commit
      // by this push (an SSH-started node torn down here left a replay-
      // panicking crash loop, and a recycled sentry once came back with its
      // env tunnel aimed at the pre-relaunch validator IP — both observed
      // live).
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const cfg = ctx.output<{ tailnetIp: string }>(p("configure"))!;
      const topo = resolveTopology(spec);
      const targets: string[] = [key];
      if (isValidator) targets.push(...(topo.validatorSentries[valIndex] ?? []).map((s) => `sentry-${s}`));

      const msgs: Msg[] = [];
      const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
      for (const k of targets) {
        const row = componentRow(ctx, k);
        const sdlPath = sdlPathFor(ctx, k);
        let text = fs.readFileSync(sdlPath, "utf8");
        text = text.replace(/WAIT_FOR_CONFIG=true/g, "WAIT_FOR_CONFIG=false");
        if (k === key && isValidator && spec.join) {
          // own-sentry witness + outbound peer tunnels (what the configure
          // step wired over SSH), baked so a container restart re-creates
          // them — the entrypoint runs every TS_TUNNEL_* env entry
          const s = topo.validatorSentries[valIndex]?.[0];
          const sentryIp = s !== undefined ? componentRow(ctx, `sentry-${s}`).tailnet_ip : null;
          if (sentryIp) {
            const doc = yaml.load(text) as any;
            const svc = doc.services?.sparkdreamd;
            if (svc) {
              const env: string[] = (svc.env ?? []).filter(
                (e: string) => !e.startsWith("TS_TUNNEL_WITNESS=") && !e.startsWith("TS_TUNNEL_PEER="),
              );
              env.push(`TS_TUNNEL_WITNESS=${WITNESS_RPC_PORT}:${sentryIp}:26657`);
              env.push(`TS_TUNNEL_PEER=${VAL_PEER_TUNNEL_PORT}:${sentryIp}:26656`);
              svc.env = env;
              text = yaml.dump(doc, { lineWidth: 120 });
            }
          }
        }
        if (k !== key) {
          // counterpart sentry: re-aim its tunnel for THIS validator at the
          // new tailnet IP (placeholder form covers never-persisted SDLs)
          text = text
            .replace(
              new RegExp(`(TS_TUNNEL_\\d+=${tunnelPort(valIndex)}:)[0-9.]+(:26656)`, "g"),
              `$1${cfg.tailnetIp}$2`,
            )
            .replaceAll(placeholder.tailnetIp(key), cfg.tailnetIp);
        }
        if (k === key && !isValidator) {
          // relaunched sentry: re-aim its validator tunnels at current IPs
          const sIndex = Number(key.split("-")[1]);
          for (const v of topo.sentryValidators[sIndex] ?? []) {
            const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
            if (!valIp) continue;
            text = text
              .replace(
                new RegExp(`(TS_TUNNEL_\\d+=${tunnelPort(v)}:)[0-9.]+(:26656)`, "g"),
                `$1${valIp}$2`,
              )
              .replaceAll(placeholder.tailnetIp(`val-${v}`), valIp);
          }
        }
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${k}.manifest.json`), artifacts.manifestJson);
        manifests.push({ row, json: artifacts.manifestJson });
        // convergent like retarget: skip deployments already at this version
        const wantHash = Buffer.from(artifacts.hash).toString("base64");
        const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
        if (onChain?.hash === wantHash) {
          ctx.log(`${k}: on-chain version already matches — skipping update tx`);
          continue;
        }
        msgs.push({
          typeUrl: TypeUrl.UpdateDeployment,
          value: { id: { owner, dseq: row.dseq }, hash: wantHash },
        });
      }
      if (msgs.length > 0) await ctx.requireTx(p("persist"), msgs);
      else ctx.db.deletePendingTx(ctx.launchId, p("persist"));
      const cert = loadCert(ctx);
      // Order matters: the counterpart sentries restart FIRST and must be
      // serving at the head again before the relaunched validator boots.
      // Pushing every manifest at once recycled the validator's only
      // snapshot source in the middle of its state-sync restore — the
      // restore completed against the interrupted chunk stream into a
      // subtly corrupt state whose first block panics ("invalid denom"),
      // i.e. a deterministic crash loop. Observed live twice; a restore
      // from a stable sentry executed cleanly.
      const counterparts = manifests.filter((m) => m.row.key !== key);
      for (const { row: r, json } of counterparts) {
        await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
      }
      for (const { row: r } of counterparts) {
        let ok = false;
        let lastProblem = "unreachable";
        for (let i = 0; i < 60 && !ok; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          try {
            const url = await nodeRpcUrl(ctx, r.host_uri, r.dseq);
            const st = await ctx.services.rpc.status(url);
            if (!st.catchingUp && st.latestBlockHeight > 0) ok = true;
            else lastProblem = `catching up at ${st.latestBlockHeight}`;
          } catch (e) {
            lastProblem = String(e).slice(0, 80);
          }
        }
        if (!ok) {
          throw new Error(`${r.key} not back at the head after its persist restart (${lastProblem})`);
        }
      }
      for (const { row: r, json } of manifests.filter((m) => m.row.key === key)) {
        await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
      }
      // the push boots the relaunched node (entrypoint-owned, its first and
      // only start) — wait for the process before declaring the op done
      const row = componentRow(ctx, key);
      let back = false;
      for (let i = 0; i < 36 && !back; i++) {
        if (i > 0) await ctx.services.sleep(5000);
        try {
          const r = await ctx.services.ssh.exec(
            rowTarget(ctx, row),
            "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
            { quick: true },
          );
          back = r.stdout.trim() === "yes";
        } catch {
          // container restarting
        }
      }
      if (!back) throw new Error(`${key} did not come back after the persist restart`);
      if (lastStep === p("persist")) ctx.db.setFleetOpStatus(opId, "done");
      return { persisted: targets };
    },
  });

  if (signerGate) {
    steps.push({
      name: p("await-signer"),
      async run(ctx) {
        // The node is running now (persist booted it), so the privval
        // listener exists and a signer's session is finally observable —
        // this is the earliest point where "is the signer repointed?" is a
        // real question. Same established-session probe as the launch gate:
        // a port check would pass on sparkdreamd's own listener with no
        // signer anywhere, and the chain signs nothing until tmkms dials in.
        const cfg = ctx.output<{ tailnetIp: string }>(p("configure"))!;
        const row = componentRow(ctx, key);
        let connected = false;
        for (let attempt = 0; attempt < 12 && !connected; attempt++) {
          if (attempt > 0) await ctx.services.sleep(5000);
          const probe = await ctx.services.ssh
            .exec(rowTarget(ctx, row), SIGNER_CONNECTED_PROBE)
            .catch(() => ({ stdout: "" }));
          connected = probeSaysConnected(probe.stdout);
        }
        if (!connected) {
          throw new AwaitUser(
            p("await-signer"),
            `repoint your tmkms signer at the relaunched ${key} — the relaunch moved it to a ` +
              `new mesh address:\n  addr = "tcp://${cfg.tailnetIp}:26659"\n` +
              "in the [[validator]] block of tmkms.toml, then restart the signer and resume. " +
              "Keep the existing state file: its watermark is what stops a double-sign.",
          );
        }
        ctx.log(`${key}: signer connected`);
        if (lastStep === p("await-signer")) ctx.db.setFleetOpStatus(opId, "done");
        return { signerConnected: true };
      },
    });
  }

  if (meshDependents(spec, key).length > 0) {
    steps.push({
      name: p("mesh-clients"),
      async run(ctx) {
        // Mesh components dial this node over the tailnet too (the explorer
        // tunnels into sentry-0's LCD and RPC), and the relaunch changed the
        // address their env names. Same treatment as the counterpart
        // sentries: rewrite the env, one update tx, re-push the manifest —
        // which restarts them onto the live address. Left alone, they keep
        // dialing a dead IP until their own next relaunch.
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const cert = loadCert(ctx);
        const msgs: Msg[] = [];
        const pushes: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const depKey of meshDependents(spec, key)) {
          const row = componentRow(ctx, depKey);
          const sdlPath = sdlPathFor(ctx, depKey);
          const retarget = retargetTunnelEnv(ctx, spec, depKey, fs.readFileSync(sdlPath, "utf8"));
          if (retarget.changes.length === 0) continue;
          for (const c of retarget.changes) ctx.log(`${depKey}: tunnel re-aimed at ${c}`);
          fs.writeFileSync(sdlPath, retarget.text);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${depKey}.manifest.json`), artifacts.manifestJson);
          pushes.push({ row, json: artifacts.manifestJson });
          // convergent like retarget: a re-run finds the version already on
          // chain and only re-sends the manifest
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) continue;
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        if (msgs.length > 0) await ctx.requireTx(p("mesh-clients"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("mesh-clients"));
        for (const { row, json } of pushes) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { repointed: pushes.map((p2) => p2.row.key) };
      },
    });
  }

  return steps;
}

/**
 * Headscale relaunch: the one component relaunchSteps cannot do, because a
 * naive redeploy re-keys the whole mesh (noise key, DERP key, preauth keys,
 * node registrations all live in the container, and this fleet may have no
 * S3 backup). Two paths:
 *
 *  - backup configured: the fresh container restores db + static keys from
 *    S3 at boot, the mesh identity survives, and clients reconnect as-is.
 *    Only the DNS record and the launcher's tracking need updating.
 *  - no backup: the mesh re-keys. The op mints fresh preauth keys on the new
 *    server, pushes them into every mesh component's env (manifest update +
 *    restart), re-collects tailnet IPs (sequential allocation means they can
 *    shuffle), rewrites env IP references, re-patches validators' peers, and
 *    ends gated on the tmkms signer re-joining, since the chain signs
 *    nothing until it does.
 *
 * Either way the launch-time step outputs everything downstream reads
 * (deploy-headscale, configure-headscale, await-mesh) are refreshed, so the
 * tmkms panel, future relaunches, and shared-mesh fleets keep working.
 */
export function headscaleRelaunchSteps(opId: number, params: RelaunchParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const key = "headscale";
  const domain = headscaleDomain(spec);
  const backup = spec.topology.headscale.backup;
  const meshKeys = [
    ...nodes(spec).map((n) => n.key),
    ...statelessComponents(spec).filter((c) => c.mesh).map((c) => c.key),
  ];
  const valKeys = nodes(spec).filter((n) => n.key.startsWith("val-")).map((n) => n.key);

  const hsShell = (ctx: StepCtx, hs: { hostUri: string; dseq: string; gseq: number; oseq: number }, script: string) =>
    ctx.services.provider.shellExec(loadCert(ctx), hs.hostUri, hs.dseq, hs.gseq, hs.oseq, "headscale", ["sh", "-c", script]);

  /** A node's assigned tailnet IPv4, or undefined while it has not joined. */
  const tailnetIp = async (ctx: StepCtx, target: SshTarget): Promise<string | undefined> => {
    const res = await ctx.services.ssh
      .exec(target, `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ip -4 2>/dev/null || true`)
      .catch(() => ({ stdout: "" }));
    const ip = res.stdout.trim().split("\n")[0]!;
    return ip && ip.startsWith("100.") ? ip : undefined;
  };

  /** Wait out a manifest-push container restart, then for mesh (re)join. */
  const collectIp = async (ctx: StepCtx, row: FleetComponentRow): Promise<string> => {
    const target = rowTarget(ctx, row);
    let sshUp = false;
    for (let i = 0; i < 40 && !sshUp; i++) {
      if (i > 0) await ctx.services.sleep(5000);
      sshUp = await ctx.services.ssh
        .exec(target, "true", { quick: true })
        .then(() => true)
        .catch(() => false);
    }
    if (!sshUp) throw new Error(`${row.key}: container never came back after its manifest update`);
    let ip: string | undefined;
    for (let i = 0; i < 30 && !ip; i++) {
      if (i > 0) await ctx.services.sleep(5000);
      ip = await tailnetIp(ctx, target);
    }
    if (!ip) {
      throw new Error(
        `${row.key} never joined the new mesh: headscale answers at ${domain} (the op verified it), ` +
          "so check the node's tailscaled log and that its provider can reach the new headscale host",
      );
    }
    return ip;
  };

  const steps: StepDef[] = [];

  steps.push({
    name: p("close"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const lease = await ctx.services.api.leaseState(owner, row.dseq, row.provider);
      if (lease === "active") {
        await ctx.requireTx(p("close"), [
          { typeUrl: TypeUrl.CloseDeployment, value: { id: { owner, dseq: row.dseq } } },
        ]);
      }
      // no zombie check: the headscale image has no sshd to probe, and a
      // second headscale answering the domain briefly is harmless (clients
      // only switch at the DNS flip below)
      ctx.db.setComponentState(ctx.launchId, key, "relaunching");
      return { closedDseq: row.dseq };
    },
  });

  steps.push({
    name: p("deploy"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      // same render as deploy-headscale, backup env included when configured
      const sdl = templateHeadscaleSdl(spec, {
        ageRecipient: backup
          ? ctx.output<{ ageRecipient: string }>("generate-keys")!.ageRecipient
          : undefined,
        ageIdentity: backup
          ? readSecretFile(path.join(ctx.dirs.secrets, "age.txt"))
              .split("\n")
              .find((l) => l.startsWith("AGE-SECRET-KEY-"))
          : undefined,
      });
      const sdlPath = sdlPathFor(ctx, key);
      fs.writeFileSync(sdlPath, yaml.dump(sdl, { lineWidth: 120 }));
      const artifacts = sdlArtifacts(loadSdl(sdlPath));
      const dseq = await pinnedValue(ctx, `op${opId}-dseq`, async () =>
        String(await ctx.services.api.latestBlockHeight()),
      );
      fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
      await ctx.requireTx(p("deploy"), [
        createDeploymentMsg({
          owner,
          dseq,
          groups: artifacts.groups,
          hash: artifacts.hash,
          deposit: {
            denom: artifacts.pricingDenom,
            amount: DEPOSIT[artifacts.pricingDenom] ?? "5000000",
          },
        }),
      ]);
      return { dseq, requiredStorageClass: artifacts.requiredStorageClass };
    },
  });

  steps.push({
    name: p("lease"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const deploy = ctx.output<{ dseq: string; requiredStorageClass?: string }>(p("deploy"))!;
      const providers = await ctx.services.api.listProviders();

      // a lease signed on a prior run IS the choice (same short-circuit as
      // the component relaunch: re-polling bids misreads the leased order)
      const leaseRow = ctx.db.getPendingTx(ctx.launchId, p("lease"));
      if (leaseRow && (leaseRow.status === "signed" || leaseRow.status === "confirmed")) {
        const bidId = JSON.parse(leaseRow.msgs_json)[0].value.bidId;
        await ctx.requireTx(p("lease"), [createLeaseMsg(bidId)]);
        const all = await ctx.services.api.listBids(owner, deploy.dseq);
        return {
          provider: bidId.provider,
          gseq: bidId.gseq,
          oseq: bidId.oseq,
          hostUri: providers.get(bidId.provider)!.hostUri,
          price: all.find((b) => b.bid.id.provider === bidId.provider)?.bid.price.amount ?? "0",
        };
      }

      // headscale placement is price-driven like at launch (no anti-affinity
      // against the fleet); the avoid list (old provider + wallet's) and the
      // spec's headscale exclusions constrain it
      const avoidProviders = new Set<string>(params.avoidProviders ?? []);
      const bids = await pollBids(ctx.services.api, owner, deploy.dseq, {
        sleep: ctx.services.sleep,
        minBids: 1,
        settleRounds: 2,
      });
      const preference = [
        ...new Set([...(params.preferProviders ?? []), ...spec.providers.policy.preference]),
      ];
      const open = bids.filter((b) => b.bid.state === "open");
      const decision = selectProvider(open, {
        policy: { ...spec.providers.policy, preference },
        chosenProviders: new Set<string>(),
        avoidProviders,
        excludeMatchers: exclusionEntries(spec, key),
        log: ctx.log,
        requiredStorageClass: deploy.requiredStorageClass,
        providers,
      });
      const chosen =
        (params.manualBid ?? manualBidRequired(spec, key)) && open.length > 0
          ? await manualBidChoice(ctx, opId, p("lease"), key, deploy.dseq, open, providers, decision)
          : decision.chosen;
      if (!chosen) {
        const expired = bids.length > 0 && bids.every((b) => b.bid.state !== "open");
        throw new AwaitUser(
          p("lease"),
          expired
            ? `the bids for the headscale relaunch deployment have expired (a lease must be signed ` +
                "within a few minutes of the bids arriving). Resuming cannot recover this: " +
                "use Abandon on this operation to close the deployment and refund its escrow, " +
                "then relaunch headscale again and sign the lease promptly"
            : `no acceptable bids for the headscale relaunch avoiding ${avoidProviders.size} provider(s): ${JSON.stringify(decision.rejected)}`,
        );
      }
      const bidId = chosen.bid.id;
      await ctx.requireTx(p("lease"), [createLeaseMsg(bidId)]);
      return {
        provider: bidId.provider,
        gseq: bidId.gseq,
        oseq: bidId.oseq,
        hostUri: providers.get(bidId.provider)!.hostUri,
        price: chosen.bid.price.amount,
      };
    },
  });

  steps.push({
    name: p("manifest"),
    async run(ctx) {
      const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
      const lease = ctx.output<{
        provider: string;
        gseq: number;
        oseq: number;
        hostUri: string;
        price: string;
      }>(p("lease"))!;
      const cert = loadCert(ctx);
      const manifest = fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8");
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const wantHash = crypto.createHash("sha256").update(manifest).digest("base64");
      const onChain = await ctx.services.api.deploymentInfo(owner, deploy.dseq);
      if (onChain?.hash && onChain.hash !== wantHash) {
        ctx.log(`headscale manifest hash drifted from deployment ${deploy.dseq} — updating on-chain`);
        await ctx.requireTx(`${p("update")}:${wantHash.slice(0, 8)}`, [
          { typeUrl: TypeUrl.UpdateDeployment, value: { id: { owner, dseq: deploy.dseq }, hash: wantHash } },
        ]);
      }
      await ctx.services.provider.sendManifest(cert, lease.hostUri, deploy.dseq, manifest);
      // no sshd and no forwarded SSH port: the lease itself is the readiness
      // signal; the configure step's shell loop takes it from there
      await waitLeaseStatus(ctx, cert, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, {});
      ctx.db.updateComponentPlacement(ctx.launchId, key, {
        dseq: deploy.dseq,
        provider: lease.provider,
        host_uri: lease.hostUri,
        price: lease.price,
        generation: params.generation,
      });
      return { placed: true };
    },
  });

  steps.push({
    name: p("configure"),
    async run(ctx) {
      const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
      const lease = ctx.output<{ provider: string; hostUri: string; price: string; gseq: number; oseq: number }>(
        p("lease"),
      )!;
      const hs = { hostUri: lease.hostUri, dseq: deploy.dseq, gseq: lease.gseq, oseq: lease.oseq };
      // the shell itself is the readiness signal (lease-status counters read
      // ready mid-crash-loop) — mirrors configure-headscale at launch
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        if (i > 0) await ctx.services.sleep(4000);
        try {
          await hsShell(ctx, hs, "true");
          up = true;
        } catch {
          // pod still starting
        }
      }
      if (!up) throw new Error("headscale never accepted lease-shell commands after the manifest push");
      await hsShell(ctx, hs, `sed -i 's|^server_url:.*|server_url: https://${domain}|' /etc/headscale/config.yaml`);
      // kill 1 restarts the container and drops the shell connection with it
      await hsShell(ctx, hs, "kill 1").catch(() => {});
      up = false;
      for (let i = 0; i < 30 && !up; i++) {
        await ctx.services.sleep(4000);
        try {
          await hsShell(ctx, hs, "true");
          up = true;
        } catch {
          // restarting
        }
      }
      if (!up) throw new Error("headscale did not come back after the server_url restart");
      // the tracker update is path-independent: everything downstream reads
      // the deploy-headscale output (tmkms panel, shared-mesh fleets, mints)
      ctx.db.stepDone(ctx.launchId, "deploy-headscale", {
        dseq: deploy.dseq,
        provider: lease.provider,
        hostUri: lease.hostUri,
        price: lease.price,
        gseq: lease.gseq,
        oseq: lease.oseq,
      } satisfies HeadscaleOutput);

      if (backup) {
        // restore path: the entrypoint pulled db + static keys from S3 at
        // boot. Prove it actually restored before skipping the re-key: an
        // empty db here means the mesh identity is GONE and silently
        // continuing would strand every client on stale keys
        const users = await hsShell(ctx, hs, "headscale users list --output json");
        const list = JSON.parse(users.stdout.trim() || "[]");
        if (!Array.isArray(list) || list.length === 0) {
          throw new Error(
            "headscale relaunched with backup configured, but the restored db has no users: " +
              "the S3 restore did not take (check the headscale container logs for the litestream " +
              "restore and the age identity). The mesh identity did not come back; fix the backup " +
              "and resume, or relaunch again after removing topology.headscale.backup to re-key.",
          );
        }
        return { restored: true };
      }

      // re-key path: fresh user + per-component preauth keys, mirroring
      // configure-headscale at launch. The new keys replace the launch-time
      // step output so the tmkms panel and later ops see them.
      await hsShell(ctx, hs, `headscale users create ${spec.network.name} 2>/dev/null || true`);
      const userId = await headscaleUserId(ctx, hs, spec.network.name);
      const mint = async (label: string) => {
        const res = await hsShell(
          ctx,
          hs,
          `headscale preauthkeys create --user ${userId} --reusable --expiration 8760h --output json`,
        );
        const parsed = JSON.parse(res.stdout.trim());
        const k: string = typeof parsed === "string" ? parsed : parsed.key;
        if (!k) throw new Error(`no preauth key in mint output for ${label}`);
        return k;
      };
      const perNode: Record<string, string> = {};
      for (const k of meshKeys) perNode[k] = await mint(k);
      const home = await mint("home");
      ctx.db.stepDone(ctx.launchId, "configure-headscale", { perNode, home });
      return { restored: false, keys: { perNode, home } };
    },
  });

  steps.push({
    name: p("dns"),
    async run(ctx) {
      const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
      const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
      const ingress = await ingressHost(ctx, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, domain);
      // poll briefly first (the record may already be right, e.g. a wildcard
      // or a fast flip), then gate unconditionally: the relaunch moved
      // providers, so the domain points at the OLD headscale until the user
      // flips it, and a health pass against the old server would split the
      // mesh (keys minted on the new one, clients registering on the old)
      for (let i = 0; i < 6; i++) {
        if (await ctx.services.rpc.httpOk(`https://${domain}/health`)) return { dns: true };
        await ctx.services.sleep(5000);
      }
      throw new AwaitUser(
        p("dns"),
        `headscale moved to a new provider: update the DNS record for ${domain} → CNAME ${ingress}, ` +
          "then resume. Every mesh client dials this domain, so nothing re-registers until it " +
          "points at the new deployment.",
      );
    },
  });

  steps.push({
    name: p("rekey"),
    async run(ctx) {
      const configure = ctx.output<{ restored: boolean; keys?: { perNode: Record<string, string>; home: string } }>(
        p("configure"),
      )!;
      if (configure.restored) return { skipped: true, reason: "mesh identity restored from backup" };
      const keys = configure.keys!;
      const cert = loadCert(ctx);
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;

      // phase A: fresh preauth key into every mesh component's env. The
      // manifest push restarts the container, whose entrypoint re-runs
      // tailscale up with the new key against the new mesh.
      const updateMsgs: Msg[] = [];
      const planned: { row: FleetComponentRow; text: string }[] = [];
      for (const k of meshKeys) {
        const row = componentRow(ctx, k);
        const sdlPath = sdlPathFor(ctx, k);
        let text = fs.readFileSync(sdlPath, "utf8");
        if (!text.includes("TS_AUTHKEY=")) continue;
        text = text.replace(/TS_AUTHKEY=[^\n"']*/g, `TS_AUTHKEY=${keys.perNode[k]}`);
        planned.push({ row, text });
      }
      for (const { row, text } of planned) {
        const sdlPath = sdlPathFor(ctx, row.key);
        fs.writeFileSync(sdlPath, text);
        // hashes go on-chain in ONE tx (one signature) before any PUT;
        // providers 422 a manifest whose hash drifted from the deployment
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), artifacts.manifestJson);
        updateMsgs.push({
          typeUrl: TypeUrl.UpdateDeployment,
          value: { id: { owner, dseq: row.dseq }, hash: artifacts.hash },
        });
      }
      if (updateMsgs.length > 0) await ctx.requireTx(p("rekey"), updateMsgs);
      for (const { row } of planned) {
        const manifest = fs.readFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), "utf8");
        await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, manifest);
      }

      // collect: every component re-registers and reports its new tailnet IP
      // (sequential allocation on a fresh db — IPs can shuffle)
      const newIps: Record<string, string> = {};
      for (const { row } of planned) newIps[row.key] = await collectIp(ctx, row);

      // phase B: env references to the OLD IPs (sentry tunnels to validators,
      // explorer tunnels to sentries) point nowhere now; rewrite and push
      // once more where they occur. Skipped for components whose env names
      // no stale IP (validators, fresh-from-launch placeholders).
      const launchMesh = ctx.db.stepOutput<{ ips: Record<string, string> }>(ctx.launchId, "await-mesh");
      const ipMap = new Map<string, string>();
      for (const k of meshKeys) {
        const oldIp = componentRow(ctx, k).tailnet_ip ?? launchMesh?.ips[k];
        if (oldIp && newIps[k] && oldIp !== newIps[k]) ipMap.set(oldIp, newIps[k]);
      }
      const ipMsgs: Msg[] = [];
      const changedRows: FleetComponentRow[] = [];
      for (const { row } of planned) {
        const sdlPath = sdlPathFor(ctx, row.key);
        let text = fs.readFileSync(sdlPath, "utf8");
        let changed = false;
        for (const [o, n] of ipMap) {
          if (!text.includes(o)) continue;
          text = text.replace(new RegExp(`(?<![\\d.])${o.replace(/\./g, "\\.")}(?![\\d.])`, "g"), n);
          changed = true;
        }
        if (!changed) continue;
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), artifacts.manifestJson);
        ipMsgs.push({
          typeUrl: TypeUrl.UpdateDeployment,
          value: { id: { owner, dseq: row.dseq }, hash: artifacts.hash },
        });
        changedRows.push(row);
      }
      if (ipMsgs.length > 0) await ctx.requireTx(p("rekey-ips"), ipMsgs);
      for (const row of changedRows) {
        const manifest = fs.readFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), "utf8");
        await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, manifest);
      }
      // the second push restarts them again; wait for the mesh to settle
      for (const row of changedRows) await collectIp(ctx, row);
      return { newIps, ipMap: Object.fromEntries(ipMap) };
    },
  });

  steps.push({
    name: p("rewire"),
    async run(ctx) {
      const rekey = ctx.output<{ skipped?: boolean; newIps?: Record<string, string>; ipMap?: Record<string, string> }>(
        p("rekey"),
      )!;
      if (rekey.skipped) return { skipped: true };
      const newIps = rekey.newIps!;
      const pairs = Object.entries(rekey.ipMap ?? {});
      // trackers: component rows + the launch's await-mesh output
      for (const [k, ip] of Object.entries(newIps)) {
        ctx.db.updateComponentRuntime(ctx.launchId, k, { tailnet_ip: ip });
      }
      const launchMesh = ctx.db.stepOutput<{ ips: Record<string, string> }>(ctx.launchId, "await-mesh");
      ctx.db.stepDone(ctx.launchId, "await-mesh", { ips: { ...(launchMesh?.ips ?? {}), ...newIps } });
      // validators' persistent_peers live in config.toml on the volume (not
      // the env): sed stale IPs and restart. Fleets peered over the sentry's
      // PUBLIC endpoint match nothing and skip the restart.
      for (const vk of valKeys) {
        const row = componentRow(ctx, vk);
        const target = rowTarget(ctx, row);
        let touched = false;
        for (const [o, n] of pairs) {
          const has = await ctx.services.ssh.exec(
            target,
            `grep -c '${o.replace(/\./g, "\\.")}' ${NODE_HOME}/config/config.toml || true`,
          );
          if (has.stdout.trim() === "0" || has.stdout.trim() === "") continue;
          await ctx.services.ssh.exec(target, `sed -i 's|${o}|${n}|g' ${NODE_HOME}/config/config.toml`);
          touched = true;
        }
        if (touched) await restartNode(ctx.services.ssh, target);
      }
      return { rewired: true };
    },
  });

  steps.push({
    name: p("signer"),
    async run(ctx) {
      const rekey = ctx.output<{ skipped?: boolean }>(p("rekey"))!;
      if (rekey.skipped || spec.security.keyMode !== "tmkms") return { skipped: true };
      const configure = ctx.output<{ keys?: { home: string } }>(p("configure"))!;
      const rekeyOut = ctx.output<{ newIps?: Record<string, string> }>(p("rekey"))!;
      const home = configure.keys!.home;
      const newIps = rekeyOut.newIps ?? {};
      // a ready signer's reconnect lands within seconds: poll a minute before
      // parking (same cushion as resume-signing's await-signer)
      const poll = async (): Promise<string[]> => {
        const missing: string[] = [];
        for (const vk of valKeys) {
          const row = componentRow(ctx, vk);
          const probe = await ctx.services.ssh
            .exec(rowTarget(ctx, row), SIGNER_CONNECTED_PROBE)
            .catch(() => ({ stdout: "" }));
          if (!probeSaysConnected(probe.stdout)) missing.push(vk);
        }
        return missing;
      };
      for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) await ctx.services.sleep(5000);
        if ((await poll()).length === 0) return { connected: true };
      }
      const addrs = valKeys
        .map((vk) => `  ${vk}: addr = "tcp://${newIps[vk] ?? "<see tmkms panel>"}:26659"`)
        .join("\n");
      throw new AwaitUser(
        p("signer"),
        "the mesh re-keyed: re-join your tmkms signer machine to the new mesh and repoint it " +
          "at the validator(s), then restart tmkms:\n" +
          `  sudo tailscale up --login-server=https://${domain} --authkey=${home} --hostname tmkms-${spec.network.name}\n` +
          `${addrs}\n` +
          "Resume once the tmkms panel reports the signer connected.",
      );
    },
  });

  steps.push({
    name: p("verify"),
    async run(ctx) {
      if (!(await ctx.services.rpc.httpOk(`https://${domain}/health`))) {
        throw new Error(`headscale health check failed at ${domain} at the end of the op`);
      }
      ctx.db.setComponentState(ctx.launchId, key, "active");
      ctx.db.setFleetOpStatus(opId, "done");
      return { ok: true };
    },
  });

  return steps;
}

/** Rolling upgrade (§5 "Node upgrades"): serial per component, health-gated. */
export function upgradeSteps(opId: number, params: UpgradeParams, spec: LaunchSpec): StepDef[] {
  const steps: StepDef[] = [];
  const stateless = new Map<string, ComponentRef>(
    statelessComponents(spec).map((c) => [c.key, c]),
  );
  const ordered = [...params.components].sort((a, b) => {
    // stateless components upgrade freely, then sentries, validators last
    // (§5 rolling sequencer)
    const rank = (k: string) => (stateless.has(k) ? 0 : k.startsWith("val-") ? 2 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const key of ordered) {
    const p = (s: string) => `op${opId}:${key}:${s}`;
    const earlier = ordered.slice(0, ordered.indexOf(key));

    steps.push({
      name: p("update"),
      async run(ctx) {
        const row = componentRow(ctx, key);
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const sdlPath = sdlPathFor(ctx, key);
        let sdl = fs.readFileSync(sdlPath, "utf8");
        // precondition (§5): a gated container would come back down
        if (sdl.includes("WAIT_FOR_CONFIG=true")) {
          throw new Error(`${key}: WAIT_FOR_CONFIG still true — run persist-start (step 20b) first`);
        }
        sdl = sdl.replace(/image: .*/g, `image: ${params.image}`);
        fs.writeFileSync(sdlPath, sdl);
        // the explorer reads its chain identity from env (v1.0.6+ renders
        // /chain-config.json from it) — inject the current values on upgrade
        // so installing the env-aware image also delivers the env, without
        // needing a chain reset. In place, so persist-start's resolved
        // tunnel targets survive.
        if (key === "explorer") setExplorerChainEnv(sdlPath, spec);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(
          path.join(ctx.dirs.sdl, `${key}.manifest.json`),
          artifacts.manifestJson,
        );
        // convergent, like retarget: a retried op re-walks components an
        // earlier attempt already updated on-chain, and an update tx whose
        // hash matches the live version is rejected ("invalid: deployment
        // hash") — re-send the manifest only for those
        const wantHash = Buffer.from(artifacts.hash).toString("base64");
        const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
        if (onChain?.hash === wantHash) {
          ctx.log(`${key}: on-chain version already matches — skipping update tx`);
          ctx.db.deletePendingTx(ctx.launchId, p("update"));
        } else {
          const msgs: Msg[] = [
            {
              typeUrl: TypeUrl.UpdateDeployment,
              value: { id: { owner, dseq: row.dseq }, hash: wantHash },
            },
          ];
          // upgrade service fee — flat, once per op, riding the first
          // update tx that actually happens (skipped components can't
          // carry it: there's no tx to batch it into)
          const fee = feeConfig();
          const feeDue = earlier.every(
            (k) => ctx.output<{ txSkipped?: boolean }>(`op${opId}:${k}:update`)?.txSkipped,
          );
          if (feeDue && fee.upgradeFlat > 0) {
            const coin = await feeCoin(
              PRICING_DENOM[spec.infra.akashNetwork],
              String(fee.upgradeFlat),
              ctx.services.api,
            );
            if (coin) msgs.push(sendMsg(owner, fee.address, coin));
            else ctx.log("AKT oracle price unavailable — upgrade fee skipped");
          }
          await ctx.requireTx(p("update"), msgs);
        }
        const cert = loadCert(ctx);
        try {
          await ctx.services.provider.sendManifest(
            cert,
            row.host_uri,
            row.dseq,
            fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8"),
          );
        } catch (e) {
          // A provider refuses (HTTP 422 "manifest version validation failed")
          // a PUT whose manifest matches the one it already runs — there is
          // nothing to redeploy. By this point the on-chain version already
          // equals this manifest's hash (skipped or just updated above), so
          // the 422 can only mean the component is already on the target
          // manifest: treat it as done and move on rather than wedging the
          // rollout on a re-run of an upgrade that already landed.
          if (!isManifestAlreadyDeployed(e)) throw e;
          ctx.log(`${key}: already running the target manifest — provider reports no change`);
        }
        ctx.db.updateComponentRuntime(ctx.launchId, key, { image: params.image });
        return { image: params.image, txSkipped: onChain?.hash === wantHash };
      },
    });

    steps.push({
      name: p("verify"),
      async run(ctx) {
        // stateless (§5): ephemeral filesystem, so the update is just the
        // image swap plus an HTTP health gate on the public domain
        const comp = stateless.get(key);
        if (comp) {
          const url = `https://${comp.domain}/`;
          for (let i = 0; i < 60; i++) {
            if (await ctx.services.rpc.httpOk(url)) return { healthy: true, url };
            await ctx.services.sleep(5000);
          }
          throw new Error(`${key} did not answer at ${url} after upgrade`);
        }
        const row = componentRow(ctx, key);
        // persistent volume → same tailnet IP, supervised restart (§5): the
        // gate is "node back and progressing" before the next component.
        // Probe failures are expected while the provider restarts the
        // container, so they only log (deduped) instead of failing the step.
        let lastNote = "";
        const note = (m: string) => {
          if (m === lastNote) return;
          lastNote = m;
          ctx.log(`${key} verify: ${m}`);
        };
        const cause = (e: unknown) =>
          (e instanceof Error ? e.message : String(e)).slice(0, 200);
        for (let i = 0; i < 60; i++) {
          if (key.startsWith("sentry-")) {
            // a sentry proves itself over its public RPC — height progress
            // is the gate, so a broken sshd can't wedge the rollout
            try {
              const url = await nodeRpcUrl(ctx, row.host_uri, row.dseq);
              const a = await ctx.services.rpc.status(url);
              await ctx.services.sleep(3000);
              const b = await ctx.services.rpc.status(url);
              if (b.latestBlockHeight > a.latestBlockHeight) return { healthy: true };
              note(`rpc answers but height is stalled at ${b.latestBlockHeight}`);
            } catch (e) {
              note(`rpc not up yet: ${cause(e)}`);
            }
          } else {
            // validators expose no public RPC, and this upgrade just restarted
            // the container, so its forwarded SSH port has been reassigned:
            // probing over the SSH runner burns the full ~20s dead-port
            // timeout every iteration before falling back (and the old pgrep
            // gate needs procps the node image does not carry). Read the
            // node's own localhost RPC in-container via lease-shell — the
            // port-independent, progress-based check the health monitor
            // already relies on (fleet.ts) — and gate on the height advancing.
            try {
              const inContainerHeight = async () => {
                const r = await ctx.services.provider.shellExec(
                  loadCert(ctx), row.host_uri, row.dseq, 1, 1, "sparkdreamd",
                  ["sh", "-c", "wget -qO- http://127.0.0.1:26657/status 2>/dev/null"],
                );
                return Number(/latest_block_height."?:?"?(\d+)/.exec(r.stdout)?.[1]);
              };
              const a = await inContainerHeight();
              await ctx.services.sleep(3000);
              const b = await inContainerHeight();
              if (Number.isFinite(b) && b > a) return { healthy: true };
              note(
                Number.isFinite(b)
                  ? `in-container rpc answers but height is stalled at ${b}`
                  : "in-container rpc not up yet",
              );
            } catch (e) {
              note(`in-container rpc probe failed: ${cause(e)}`);
            }
          }
          await ctx.services.sleep(5000);
        }
        throw new Error(
          `${key} did not come back healthy after upgrade (last: ${lastNote || "no probe ran"})`,
        );
      },
    });
  }

  steps.push({
    name: `op${opId}:finish`,
    async run(ctx) {
      ctx.db.setFleetOpStatus(opId, "done");
      return { upgraded: ordered, image: params.image };
    },
  });

  return steps;
}

export interface HaltUpgradeParams {
  image: string;
  haltHeight: number;
}

/**
 * Coordinated halt-height upgrade (§5 "Node upgrades", consensus-breaking
 * releases; M7): halt every node at H, swap every image, resume together.
 */
export function haltUpgradeSteps(
  opId: number,
  params: HaltUpgradeParams,
  spec: LaunchSpec,
): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  // chain nodes only — headscale and the stateless components run neither
  // sparkdreamd nor halt-height
  const nodeRows = (ctx: StepCtx) =>
    (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
      (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
    );

  return [
    {
      name: p("halt-set"),
      async run(ctx) {
        // halt-height is read at process start → set it, restart each node
        for (const row of nodeRows(ctx)) {
          const target = rowTarget(ctx, row);
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|^halt-height =.*|halt-height = ${params.haltHeight}|' ${NODE_HOME}/config/app.toml`,
          );
          await restartNode(ctx.services.ssh, target);
        }
        return { haltHeight: params.haltHeight };
      },
    },
    {
      name: p("halt-wait"),
      async run(ctx) {
        // every node carries the same halt-height, so they all stop within a
        // block of each other — the gate is ALL of them halted, since the next
        // step clears the setting and the one after restarts containers.
        // Sticky: a node in its restart backoff serves no logs at all, so an
        // unreadable stream is missing information, never evidence that a node
        // already seen halting has somehow resumed.
        const halted = new Set<string>();
        let lastNote = "";
        let note = "no probe ran";
        for (let i = 0; i < 720; i++) {
          const problems: string[] = [];
          for (const row of nodeRows(ctx)) {
            if (halted.has(row.key)) continue;
            try {
              if (await haltObserved(ctx, row, params.haltHeight)) halted.add(row.key);
              else problems.push(`${row.key} still running`);
            } catch (e) {
              // no logs to read: mid-restart, or the provider is unhappy.
              // Either way this round learned nothing — keep polling.
              problems.push(
                `${row.key} unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`,
              );
            }
          }
          const keys = nodeRows(ctx).map((r) => r.key);
          if (keys.length > 0 && keys.every((k) => halted.has(k))) {
            // FinalizeBlock refuses the halt-height block, so the committed
            // head is the one below it
            return { haltedAt: params.haltHeight - 1, nodes: keys };
          }
          note = problems.join(", ") || "no chain nodes to halt";
          if (note !== lastNote) {
            ctx.log(`halt-wait: waiting for ${params.haltHeight} — ${note}`);
            lastNote = note;
          }
          await ctx.services.sleep(5000);
        }
        throw new Error(
          `nodes never halted at ${params.haltHeight} (last: ${note})`,
        );
      },
    },
    {
      name: p("halt-clear"),
      async run(ctx) {
        // clear BEFORE the image swap restarts containers, or the new
        // binary comes up and halts again immediately. Every node is crash
        // looping by now, so this has to wait for a boot window rather than
        // assume SSH answers on the first try.
        for (const row of nodeRows(ctx)) {
          await execOnHaltingNode(
            ctx,
            row,
            `sed -i 's|^halt-height =.*|halt-height = 0|' ${NODE_HOME}/config/app.toml`,
          );
        }
        return { cleared: true };
      },
    },
    {
      name: p("update-all"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const msgs: Msg[] = [];
        const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const row of nodeRows(ctx)) {
          const sdlPath = sdlPathFor(ctx, row.key);
          let sdl = fs.readFileSync(sdlPath, "utf8");
          sdl = sdl.replace(/image: .*/g, `image: ${params.image}`);
          fs.writeFileSync(sdlPath, sdl);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          const json = artifacts.manifestJson;
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), json);
          manifests.push({ row, json });
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: {
              id: { owner, dseq: row.dseq },
              hash: Buffer.from(artifacts.hash).toString("base64"),
            },
          });
        }
        // upgrade service fee — flat, once per op, on this batched update
        const fee = feeConfig();
        if (fee.upgradeFlat > 0) {
          const coin = await feeCoin(
            PRICING_DENOM[spec.infra.akashNetwork],
            String(fee.upgradeFlat),
            ctx.services.api,
          );
          if (coin) msgs.push(sendMsg(owner, fee.address, coin));
          else ctx.log("AKT oracle price unavailable — upgrade fee skipped");
        }
        // one batched tx: all nodes move to the new binary together
        await ctx.requireTx(p("update-all"), msgs);
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
          ctx.db.updateComponentRuntime(ctx.launchId, row.key, { image: params.image });
        }
        return { updated: manifests.map((m) => m.row.key) };
      },
    },
    {
      name: p("resume-verify"),
      async run(ctx) {
        // providers restart containers on the new image; WAIT_FOR_CONFIG=false
        // (step 20b) auto-starts them — chain resumes once >2/3 are back
        for (let i = 0; i < 240; i++) {
          try {
            const height = await sentryRpcHeight(ctx);
            if (height !== undefined && height > params.haltHeight) {
              ctx.db.setFleetOpStatus(opId, "done");
              return { resumedAt: height };
            }
          } catch {
            // the sentry halted with everything else and its RPC comes back
            // only once the provider has restarted it on the new image — the
            // loop is the retry, not a reason to fail the op
          }
          await ctx.services.sleep(5000);
        }
        throw new Error("chain did not resume after the coordinated upgrade");
      },
    },
  ];
}

export interface RetargetParams {
  /** Deployments whose SDLs must be re-rendered for the new domains. */
  components: string[];
}

/**
 * Rewrite the domain-bearing parts of an already-deployed SDL from the
 * (updated) spec: accept-domain ingress lists, and the frontend's runtime
 * endpoint env. Everything else — baked tailnet IPs, auth keys, images —
 * is preserved, which is why this mutates the on-disk SDL instead of
 * re-rendering from scratch.
 */
export function retargetSdl(sdlPath: string, key: string, spec: LaunchSpec): void {
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const comps = spec.topology.components;
  const pub = spec.topology.publicEndpoints;
  if (key === "explorer" || key === "frontend") {
    const svc = doc.services?.[key];
    if (!svc) throw new Error(`${key}.yaml has no services.${key}`);
    const domain = comps[key].domain;
    if (!domain) throw new Error(`${key} has no domain in the spec`);
    for (const e of svc.expose ?? []) if (e.accept) e.accept = [domain];
    if (key === "frontend") {
      const env: string[] = svc.env ?? [];
      const set = (k: string, v: string | undefined) => {
        const i = env.findIndex((x) => x.startsWith(k + "="));
        if (v === undefined) {
          if (i >= 0) env.splice(i, 1);
        } else if (i >= 0) env[i] = `${k}=${v}`;
        else env.push(`${k}=${v}`);
      };
      if (pub?.api) set("LCD_ENDPOINT", `https://${pub.api}`);
      if (pub?.rpc) set("RPC_ENDPOINT", `https://${pub.rpc}`);
      set(
        "EXPLORER_URL",
        comps.explorer.enabled && comps.explorer.domain
          ? `https://${comps.explorer.domain}/${comps.explorer.route ?? spec.network.name}`
          : undefined,
      );
      svc.env = env;
    }
  } else {
    // sentry-0: LCD accept rides the 1317 expose, RPC accept the 26657 one
    const svc = doc.services?.sparkdreamd;
    if (!svc) throw new Error(`${key}.yaml has no services.sparkdreamd`);
    for (const e of svc.expose ?? []) {
      if (e.port === 1317 && pub?.api) e.accept = [pub.api];
      if (e.port === 26657 && pub?.rpc) e.accept = [pub.rpc];
    }
  }
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
}

/**
 * Domain retarget: batch one MsgUpdateDeployment per affected deployment
 * (same signature), re-send manifests, then gate on the new domains
 * answering. No service fee — it's configuration, not an upgrade. The spec
 * was already updated by requestDomainUpdate, so health checks and future
 * relaunches use the new domains.
 */
export function retargetSteps(opId: number, params: RetargetParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  return [
    {
      name: p("update"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const msgs: Msg[] = [];
        const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const key of params.components) {
          const row = componentRow(ctx, key);
          retargetSdl(sdlPathFor(ctx, key), key, spec);
          const artifacts = sdlArtifacts(loadSdl(sdlPathFor(ctx, key)));
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
          manifests.push({ row, json: artifacts.manifestJson });
          // convergent, like deploy-headscale's hash reconciliation: if the
          // on-chain version already matches (an earlier retarget landed),
          // an update tx would be rejected with ErrInvalidHash ("nothing to
          // change") — just re-send the manifest for that one
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) {
            ctx.log(`${key}: on-chain version already matches — skipping update tx`);
            continue;
          }
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        if (msgs.length > 0) {
          await ctx.requireTx(p("update"), msgs);
        } else {
          // everything already on-chain — drop a tx an earlier pass enqueued
          ctx.db.deletePendingTx(ctx.launchId, p("update"));
        }
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        return { updated: params.components };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const comps = spec.topology.components;
        const pub = spec.topology.publicEndpoints;
        const urls: string[] = [];
        for (const key of params.components) {
          if (key === "explorer" || key === "frontend") urls.push(`https://${comps[key].domain}/`);
        }
        if (params.components.some((k) => k.startsWith("sentry-"))) {
          if (pub?.api) urls.push(`https://${pub.api}/cosmos/base/tendermint/v1beta1/node_info`);
          if (pub?.rpc) urls.push(`https://${pub.rpc}/status`);
        }
        const dark: string[] = [];
        for (const url of urls) {
          let ok = false;
          for (let i = 0; i < 24 && !ok; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            ok = await ctx.services.rpc.httpOk(url);
          }
          if (!ok) dark.push(url);
        }
        if (dark.length > 0) {
          throw new AwaitUser(
            p("verify"),
            `not reachable after the domain update: ${dark.join(", ")} — ` +
              "create or repoint the DNS records (CNAME each domain to its provider ingress host, " +
              "same target as before for unchanged providers), then resume.",
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { verified: urls };
      },
    },
  ];
}

export interface ResetChainParams {
  /** New sparkdreamd image — set when the reset rides a chain upgrade. */
  image?: string;
}

/**
 * Patch the explorer's chain-identity env into its deployed SDL in place —
 * everything else (baked tunnel IPs, auth keys, image) is preserved, same
 * rationale as retargetSdl.
 */
function setExplorerChainEnv(sdlPath: string, spec: LaunchSpec): void {
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const svc = doc.services?.explorer;
  if (!svc) throw new Error("explorer.yaml has no services.explorer");
  const env: string[] = svc.env ?? [];
  for (const [k, v] of Object.entries(explorerChainEnv(spec))) {
    const i = env.findIndex((x) => x.startsWith(k + "="));
    if (i >= 0) env[i] = `${k}=${v}`;
    else env.push(`${k}=${v}`);
  }
  svc.env = env;
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
}

/**
 * Rewrite WAIT_FOR_CONFIG in the on-disk node SDLs and build the batched
 * MsgUpdateDeployment + manifests. This is how a reset stops and resumes
 * the chain: after persist-start the entrypoint execs sparkdreamd as PID 1,
 * so pkill just restarts the container into a self-healed running node —
 * the only way to hold a node stopped is its own wait mode ("container
 * alive, SSH in, upload config/data"), and the only way out is flipping
 * back. Convergent like retarget: deployments already at the wanted hash
 * are skipped, so re-runs and relaunched nodes (SDL already in wait mode)
 * don't produce rejected txs.
 */
async function flipWaitMode(
  ctx: StepCtx,
  rows: FleetComponentRow[],
  value: "true" | "false",
): Promise<{ msgs: Msg[]; manifests: Array<{ row: FleetComponentRow; json: string }> }> {
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const msgs: Msg[] = [];
  const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
  for (const row of rows) {
    const sdlPath = sdlPathFor(ctx, row.key);
    const sdl = fs
      .readFileSync(sdlPath, "utf8")
      .replace(/WAIT_FOR_CONFIG=(true|false)/g, `WAIT_FOR_CONFIG=${value}`);
    fs.writeFileSync(sdlPath, sdl);
    const artifacts = sdlArtifacts(loadSdl(sdlPath));
    fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), artifacts.manifestJson);
    manifests.push({ row, json: artifacts.manifestJson });
    const wantHash = Buffer.from(artifacts.hash).toString("base64");
    const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
    if (onChain?.hash === wantHash) continue;
    msgs.push({
      typeUrl: TypeUrl.UpdateDeployment,
      value: { id: { owner, dseq: row.dseq }, hash: wantHash },
    });
  }
  return { msgs, manifests };
}

/**
 * Chain reset (§5 "Chain reset"): wipe all chain state and restart from a
 * freshly built genesis under a bumped chain-id, on the SAME deployments —
 * no new leases, providers, mesh, or DNS. For state-breaking chain upgrades:
 * the (already-updated) spec's genesis-shaping fields — accounts, members,
 * chainParams, token — all take effect, and the operator/account keyring is
 * rebuilt from scratch (fresh mnemonics; edited account lists just work).
 * The bumped chain-id is also what makes restarting safe: signer state
 * (softsign priv_validator_state, tmkms) can never confuse the new chain
 * with the old one.
 */
export function resetChainSteps(opId: number, params: ResetChainParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const cid = chainId(spec);
  const bondDenom = spec.token.bondDenom ?? spec.token.baseDenom;
  const nodeRows = (ctx: StepCtx) =>
    (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
      (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
    );

  const steps: StepDef[] = [
    {
      name: p("halt"),
      async run(ctx) {
        // hold every node stopped via its wait mode (see flipWaitMode);
        // no service fee — it's the reset's stop mechanism, not an upgrade
        const { msgs, manifests } = await flipWaitMode(ctx, nodeRows(ctx), "true");
        if (msgs.length > 0) await ctx.requireTx(p("halt"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("halt"));
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        // converge to "stopped": once the wait-mode env is on-chain, ANY
        // container restart lands in wait mode — so killing a straggler
        // (even PID-1 sparkdreamd) is terminal, not a self-heal loop
        for (const row of nodeRows(ctx)) {
          let stopped = false;
          for (let i = 0; i < 36 && !stopped; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            if (i > 0 && i % 6 === 0) ctx.log(`${row.key}: waiting for wait mode (attempt ${i})`);
            try {
              const running = await ctx.services.ssh.exec(
                rowTarget(ctx, row),
                "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
                { quick: true },
              );
              if (running.stdout.trim() === "no") {
                stopped = true;
                break;
              }
              await ctx.services.ssh.exec(rowTarget(ctx, row), "pkill -x sparkdreamd || true", {
                quick: true,
              });
            } catch {
              // container restarting into wait mode
            }
          }
          if (!stopped) throw new Error(`${row.key}: sparkdreamd still running after the wait-mode flip`);
        }
        return { halted: nodeRows(ctx).map((r) => r.key) };
      },
    },
    {
      name: p("reset-keys"),
      async run(ctx) {
        const master = ctx.dirs.node("val-0");
        // the whole account keyring is rebuilt — edited account lists (new,
        // renamed, member changes) regenerate cleanly; old mnemonics die here
        fs.rmSync(path.join(master, "keyring-test"), { recursive: true, force: true });
        fs.rmSync(path.join(master, "config", "gentx"), { recursive: true, force: true });
        // fresh genesis skeleton with the NEW chain-id, from a throwaway home
        // (init in the node homes would clobber their rendered configs)
        const scratch = path.join(ctx.dirs.root, `op${opId}-init`);
        fs.rmSync(scratch, { recursive: true, force: true });
        await sparkdreamd([
          "init", "reset", "--chain-id", cid, "--default-denom", bondDenom, "--home", scratch,
        ]);
        fs.copyFileSync(
          path.join(scratch, "config", "genesis.json"),
          path.join(master, "config", "genesis.json"),
        );
        fs.rmSync(scratch, { recursive: true, force: true });

        const accounts = await createNamedAccounts(ctx);
        // fold the new addresses into the launch's generate-keys output —
        // the accounts view and later ops read it (node keys are untouched)
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        if (!keys) throw new Error("generate-keys output missing");
        ctx.db.stepDone(ctx.launchId, "generate-keys", { ...keys, accounts });
        // external operators re-sign gentxs against the new chain-id — the
        // old sign docs are stale, so drop the rows entirely
        ctx.db.deleteGentxs(ctx.launchId);
        return { chainId: cid, accounts: Object.keys(accounts).length };
      },
    },
    {
      name: p("rebuild-genesis"),
      async run(ctx) {
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        if (!keys) throw new Error("generate-keys output missing");
        const result = await buildGenesisFiles(ctx, keys);
        // bundles feed future relaunches — re-pack so they carry the new genesis
        await packageNodeDataStep.run(ctx);
        return result;
      },
    },
  ];

  if (params.image) {
    steps.push({
      name: p("swap-image"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const msgs: Msg[] = [];
        const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const row of nodeRows(ctx)) {
          const sdlPath = sdlPathFor(ctx, row.key);
          let sdl = fs.readFileSync(sdlPath, "utf8");
          sdl = sdl.replace(/image: .*/g, `image: ${params.image}`);
          fs.writeFileSync(sdlPath, sdl);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(
            path.join(ctx.dirs.sdl, `${row.key}.manifest.json`),
            artifacts.manifestJson,
          );
          manifests.push({ row, json: artifacts.manifestJson });
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) {
            ctx.log(`${row.key}: on-chain version already matches — skipping update tx`);
            continue;
          }
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        // it's an upgrade — same flat fee as the rolling/halt upgrade ops
        const fee = feeConfig();
        if (msgs.length > 0 && fee.upgradeFlat > 0) {
          const coin = await feeCoin(
            PRICING_DENOM[spec.infra.akashNetwork],
            String(fee.upgradeFlat),
            ctx.services.api,
          );
          if (coin) msgs.push(sendMsg(owner, fee.address, coin));
          else ctx.log("AKT oracle price unavailable — upgrade fee skipped");
        }
        if (msgs.length > 0) await ctx.requireTx(p("swap-image"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("swap-image"));
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
          ctx.db.updateComponentRuntime(ctx.launchId, row.key, { image: params.image! });
        }
        // providers restart the containers — into wait mode, since op:halt
        // flipped the env first; wait for SSH back before the wipe
        for (const row of nodeRows(ctx)) {
          let up = false;
          for (let i = 0; i < 60 && !up; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            try {
              await ctx.services.ssh.exec(rowTarget(ctx, row), "true");
              up = true;
            } catch {
              // container still restarting
            }
          }
          if (!up) throw new Error(`${row.key} unreachable after the image swap`);
        }
        return { image: params.image };
      },
    });
  }

  steps.push(
    {
      name: p("wipe"),
      async run(ctx) {
        const master = ctx.dirs.node("val-0");
        const genesisPath = path.join(master, "config", "genesis.json");
        // nothing is running (wait mode, enforced by op:halt) — the data
        // wipe and genesis swap happen on a quiet home dir
        for (const row of nodeRows(ctx)) {
          const target = rowTarget(ctx, row);
          await ctx.services.ssh.exec(
            target,
            `sparkdreamd comet unsafe-reset-all --home ${NODE_HOME}`,
          );
          await ctx.services.ssh.upload(target, genesisPath, `${NODE_HOME}/config/genesis.json`);
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|^chain-id =.*|chain-id = "${cid}"|' ${NODE_HOME}/config/client.toml`,
          );
        }
        return { wiped: nodeRows(ctx).map((r) => r.key), chainId: cid };
      },
    },
  );

  if (spec.security.keyMode === "tmkms") {
    steps.push({
      name: p("signer"),
      async run(ctx) {
        // new chain-id → the signer needs [chain] id updated BEFORE the
        // nodes resume (tmkms state is per-chain-id, so it starts fresh).
        //
        // Announce-once, not probe: op:halt left every node in wait mode, so
        // sparkdreamd — the process that owns the privval listener — is not
        // running, and any port check here reports "no signer" no matter how
        // correctly the signer is configured. Gating on that wedged the op
        // permanently (the same defect the relaunch had). The signer is
        // verifiable only after the nodes boot, which op:verify covers: no
        // signer means no blocks, and its failure says so.
        const notice = `op${opId}-signer-notice`;
        const alreadyAsked = fs.existsSync(path.join(ctx.dirs.root, `${notice}.pin`));
        await pinnedValue(ctx, notice, async () => "asked");
        if (!alreadyAsked) {
          const vals = nodeRows(ctx).filter((r) => r.key.startsWith("val-")).map((r) => r.key);
          throw new AwaitUser(
            p("signer"),
            `update your tmkms config for ${vals.join(", ")}: set chain_id = "${cid}" in ` +
              "tmkms.toml (both [[chain]] and [[validator]]), restart the signer, then resume. " +
              "The reset's new chain-id also means a fresh state file, which is correct here: " +
              "the old watermark belongs to the chain being discarded.",
          );
        }
        return { signersReady: true };
      },
    });
  }

  steps.push(
    {
      name: p("start"),
      async run(ctx) {
        // resume: flip wait mode off — the entrypoint execs sparkdreamd on
        // the new genesis when the containers restart
        const { msgs, manifests } = await flipWaitMode(ctx, nodeRows(ctx), "false");
        // the frontend and explorer embed chain identity in their env
        // (CHAIN_ID/CHAIN_NAME, denoms, display symbols — the Keplr
        // suggest-chain payload and the explorer's runtime chain config) —
        // refresh both on the resume tx, or they keep advertising the
        // pre-reset chain. The frontend re-renders wholesale (no
        // placeholders); the explorer's env is patched in place, because a
        // re-render would reintroduce the {{TS_AUTHKEY}}/tunnel
        // placeholders that persist-start already resolved.
        const componentRows = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
          (c) => (c.key === "frontend" || c.key === "explorer") && c.state === "active",
        );
        for (const row of componentRows) {
          const sdlPath = sdlPathFor(ctx, row.key);
          if (row.key === "frontend") {
            const keys = ctx.output<GenerateKeysOutput>("generate-keys");
            if (!keys) throw new Error("generate-keys output missing");
            const component = statelessComponents(spec).find((c) => c.key === "frontend")!;
            renderComponentSdl({
              spec,
              component,
              sshPublicKey: keys.sshPublicKey,
              outPath: sdlPath,
              placeholder,
            });
          } else {
            setExplorerChainEnv(sdlPath, spec);
          }
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(
            path.join(ctx.dirs.sdl, `${row.key}.manifest.json`),
            artifacts.manifestJson,
          );
          manifests.push({ row, json: artifacts.manifestJson });
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash !== wantHash) {
            msgs.push({
              typeUrl: TypeUrl.UpdateDeployment,
              value: { id: { owner, dseq: row.dseq }, hash: wantHash },
            });
          }
        }
        if (msgs.length > 0) await ctx.requireTx(p("start"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("start"));
        const cert = loadCert(ctx);
        for (const { row, json } of manifests) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        // sentries first — validators dial them on start
        const rows = nodeRows(ctx).sort(
          (a, b) =>
            (a.key.startsWith("val-") ? 1 : 0) - (b.key.startsWith("val-") ? 1 : 0) ||
            a.key.localeCompare(b.key),
        );
        for (const row of rows) {
          let running = false;
          for (let i = 0; i < 36 && !running; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            if (i > 0 && i % 6 === 0) ctx.log(`${row.key}: waiting for the node (attempt ${i})`);
            try {
              const r = await ctx.services.ssh.exec(
                rowTarget(ctx, row),
                "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
                { quick: true },
              );
              if (r.stdout.trim() === "yes") running = true;
              // a node whose deployment hash didn't change (relaunched nodes
              // already carried wait mode) gets no container restart and
              // must be started the SSH way. The long grace period keeps the
              // nudge clear of a restarting container's entrypoint (tailscale
              // join etc.) — racing it would double-start sparkdreamd.
              else if (i >= 12) await ctx.services.ssh.exec(rowTarget(ctx, row), START_NODE_CMD);
            } catch {
              // container restarting
            }
          }
          if (!running) throw new Error(`${row.key} did not come back after the resume flip`);
        }
        return { resumed: rows.map((r) => r.key) };
      },
    },
    {
      name: p("retunnel"),
      async run(ctx) {
        // sentry-side p2p tunnels: the restarts killed SSH-issued socat
        // listeners; env-baked ones self-heal but relaunched nodes' don't —
        // re-issuing is idempotent, so do it for every sentry
        const topo = resolveTopology(spec);
        for (const row of nodeRows(ctx).filter((r) => r.key.startsWith("sentry-"))) {
          const sIndex = Number(row.key.split("-")[1]);
          for (const v of topo.sentryValidators[sIndex] ?? []) {
            const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
            if (!valIp) throw new Error(`val-${v} has no recorded tailnet IP`);
            await ctx.services.ssh.exec(rowTarget(ctx, row), socatTunnelCmd(tunnelPort(v), valIp));
          }
        }
        return { retunneled: true };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        let height: number | undefined;
        for (let i = 0; i < 120 && height === undefined; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          if (i > 0 && i % 12 === 0) ctx.log(`waiting for block production (attempt ${i})`);
          try {
            const h = await sentryRpcHeight(ctx);
            if (h !== undefined && h >= 1) height = h;
          } catch {
            // sentry RPC still rebooting — the loop is the retry
          }
        }
        if (height === undefined) {
          throw new Error(
            "chain did not start producing blocks after the reset" +
              (spec.security.keyMode === "tmkms"
                ? ` — check the signer: with the new chain-id "${cid}" tmkms must have chain_id ` +
                  "updated in both [[chain]] and [[validator]], and no votes are signed until it reconnects"
                : ""),
          );
        }
        // the frontend and explorer restarted with the new chain env — gate
        // on both answering again
        const active = new Set(
          (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[])
            .filter((c) => c.state === "active")
            .map((c) => c.key),
        );
        for (const comp of statelessComponents(spec).filter((c) => active.has(c.key))) {
          let ok = false;
          for (let i = 0; i < 24 && !ok; i++) {
            if (i > 0) await ctx.services.sleep(5000);
            ok = await ctx.services.rpc.httpOk(`https://${comp.domain}/`);
          }
          if (!ok) throw new Error(`${comp.key} did not answer at https://${comp.domain}/ after the reset`);
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { chainId: cid, height };
      },
    },
  );

  return steps;
}

export interface UnjailParams {
  /** Validator component key, e.g. "val-0". */
  key: string;
}

/** Gas budget for MsgUnjail (a light tx; generous headroom). */
const UNJAIL_GAS = 300_000;

/**
 * Unjail a downtime-jailed validator (§5): gate on the node being back at
 * the chain head (unjailing a still-lagging node just re-jails it one
 * signed-blocks window later), broadcast MsgUnjail from the operator key
 * the conductor holds, and verify the validator re-enters the bonded set.
 * Generated operators only — external operators hold their own keys and
 * unjail from their own wallet (requestUnjail refuses them up front).
 */
export function unjailSteps(opId: number, params: UnjailParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const v = Number(params.key.split("-")[1]);
  const cid = chainId(spec);

  const ownRpc = async (ctx: StepCtx): Promise<string> => {
    const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
      (c) => c.key.startsWith("sentry-") && c.state === "active",
    );
    if (!sentry) throw new Error("no active sentry to reach the chain through");
    return nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  };

  const operator = (ctx: StepCtx): string => {
    const keys = ctx.output<GenerateKeysOutput>("generate-keys");
    const address = keys?.accounts[`op-val-${v}`];
    if (!address) throw new Error(`no operator account recorded for ${params.key}`);
    return address;
  };

  return [
    {
      name: p("sync-gate"),
      async run(ctx) {
        // same rationale as the phase-g bond gate: the chain only lifts the
        // jail; whether it sticks depends on the node signing immediately
        const row = componentRow(ctx, params.key);
        const target = rowTarget(ctx, row);
        let lastProblem = "no probe yet";
        for (let i = 0; i < 120; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          const head = await sentryRpcHeight(ctx);
          const probe = await ctx.services.ssh.exec(
            target,
            "wget -qO- http://127.0.0.1:26657/status 2>/dev/null || true",
            { quick: true },
          );
          const height = Number(/latest_block_height"?\s*:\s*"?(\d+)/.exec(probe.stdout)?.[1]);
          const catchingUp = /catching_up"?\s*:\s*"?(\w+)/.exec(probe.stdout)?.[1] === "true";
          if (Number.isFinite(height) && !catchingUp && (head === undefined || height >= head - 3)) {
            return { height, head };
          }
          lastProblem = Number.isFinite(height)
            ? `${catchingUp ? "catching up " : ""}at height ${height}, chain head ${head ?? "unknown"}`
            : "local RPC not answering";
        }
        throw new Error(
          `${params.key} is not at the chain head after ~10 min (${lastProblem}) — ` +
            "unjailing now would only re-jail it; fix the node first, then resume",
        );
      },
    },
    {
      name: p("unjail"),
      async run(ctx) {
        const rpc = await ownRpc(ctx);
        const address = operator(ctx);
        const valoper = valoperAddress(address);
        const val = await queryJson(["query", "staking", "validator", valoper], rpc);
        if (!(val.validator ?? val).jailed) {
          return { alreadyUnjailed: true }; // idempotent re-run
        }
        // the chain refuses MsgUnjail before jailed_until — a fast relaunch
        // can beat the 10-minute jail clock here (observed live: "validator
        // still jailed" burned a fee); wait the window out instead
        try {
          const keys = ctx.output<GenerateKeysOutput>("generate-keys");
          const pubkey = keys?.consensusPubkeys[params.key];
          if (pubkey) {
            const pubkeyArg = JSON.stringify({ "@type": "/cosmos.crypto.ed25519.PubKey", key: pubkey });
            const out = await queryJson(["query", "slashing", "signing-info", pubkeyArg], rpc);
            const info = out.val_signing_info ?? out;
            const until = info.jailed_until ? new Date(info.jailed_until).getTime() : 0;
            const waitMs = until - Date.now() + 5000;
            if (waitMs > 0 && waitMs < 3_600_000) {
              ctx.log(`${params.key}: jailed until ${info.jailed_until} — waiting ${Math.ceil(waitMs / 1000)}s`);
              await ctx.services.sleep(waitMs);
            }
          }
        } catch {
          // best-effort: a failed query falls through to the broadcast,
          // whose own error stays the source of truth
        }
        const fee = Math.ceil(Number(spec.token.minGasPrice) * UNJAIL_GAS);

        if (Array.isArray(spec.topology.validators.operators)) {
          // external operator: the wallet signs MsgUnjail through the same
          // amino signing loop as promote-validator's create-validator
          const coords = await accountCoordinates(ctx, rpc, address);
          const signDoc = buildUnjailSignDoc(address, cid, {
            ...coords,
            fee: {
              amount: fee > 0 ? [{ denom: spec.token.baseDenom, amount: String(fee) }] : [],
              gas: String(UNJAIL_GAS),
            },
          });
          // the gentx row for this valIndex may still hold Phase G's SIGNED
          // create-validator response — requireGentx would hand it straight
          // back; clear it so the wallet is served the unjail doc instead
          const row = ctx.db.getPendingGentx(ctx.launchId, v);
          if (row?.status === "signed" && row.sign_doc_json !== JSON.stringify(signDoc)) {
            ctx.db.resetGentx(ctx.launchId, v);
          }
          const responseJson = ctx.requireGentx(v, address, JSON.stringify(signDoc));
          const response = JSON.parse(responseJson) as GentxSignResponse;
          const verdict = await verifySignedDoc(signDoc, response, address);
          if (!verdict.ok) {
            ctx.db.resetGentx(ctx.launchId, v);
            throw new Error(`unjail signature for ${params.key} rejected: ${verdict.reason}`);
          }
          const txFile = path.join(ctx.dirs.root, `op${opId}-unjail.signed.json`);
          fs.writeFileSync(txFile, assembleUnjailTxJson(address, response));
          try {
            const { stdout } = await sparkdreamd([
              "tx", "broadcast", txFile, "--node", rpc, "--output", "json",
            ]);
            const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
            if (res.code) {
              throw new Error(`unjail rejected at broadcast (code ${res.code}): ${res.raw_log ?? ""}`);
            }
            await awaitTxIncluded(ctx, rpc, res.txhash);
            return { txhash: res.txhash };
          } catch (e) {
            // a stale sequence (the operator transacted between sign and
            // broadcast) needs a FRESH sign doc — never replay the cached one
            ctx.db.resetGentx(ctx.launchId, v);
            throw e;
          }
        }

        // generated operator: the conductor holds the key in the master keyring
        const { stdout } = await sparkdreamd([
          "tx", "slashing", "unjail",
          "--from", `op-val-${v}`,
          "--keyring-backend", "test",
          "--home", ctx.dirs.node("val-0"),
          "--chain-id", cid,
          "--node", rpc,
          "--gas", String(UNJAIL_GAS),
          "--fees", `${fee}${spec.token.baseDenom}`,
          "--yes",
          "--output", "json",
        ]);
        const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
        if (res.code) {
          // e.g. still inside jailed_until, or slashed below min-self-delegation
          throw new Error(`unjail rejected at broadcast (code ${res.code}): ${res.raw_log ?? ""}`);
        }
        await awaitTxIncluded(ctx, rpc, res.txhash);
        return { txhash: res.txhash };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const rpc = await ownRpc(ctx);
        const valoper = valoperAddress(operator(ctx));
        let status = "";
        let jailed = true;
        for (let i = 0; i < 36 && (jailed || status !== "BOND_STATUS_BONDED"); i++) {
          if (i > 0) await ctx.services.sleep(5000);
          try {
            const out = await queryJson(["query", "staking", "validator", valoper], rpc);
            const val = out.validator ?? out;
            jailed = Boolean(val.jailed);
            status = val.status ?? "";
          } catch {
            // transient RPC failure — the loop is the retry
          }
        }
        if (jailed || status !== "BOND_STATUS_BONDED") {
          throw new Error(
            `${params.key} did not re-enter the bonded set after ~3 min ` +
              `(jailed: ${jailed}, status: ${status || "unknown"})`,
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { unjailed: true };
      },
    },
  ];
}

export interface ResumeSigningParams {
  /** Validator component key, e.g. "val-0". */
  key: string;
}

/** Blocks of live signing the verify step insists on observing. */
const RESUME_PROBE_BLOCKS = 10;

/**
 * Resume signing on a stalled tmkms validator: the signer box went away
 * (power, network, a mesh re-key) and its privval session dropped, so the
 * validator started missing blocks — on a small fleet the chain stalls
 * outright. Without this op the only recovery is bouncing the deployment by
 * hand through another tool, and that out-of-band manifest update drifts the
 * on-chain hash away from the launcher's SDL and 422s every later manifest
 * send (seen live). Instead: gate on the signer session being back (the user
 * brings the signer up first), restart sparkdreamd in place — no manifest
 * change, no hash drift — then prove the validator is signing by watching
 * its signing-info counters advance.
 */
export function resumeSigningSteps(opId: number, params: ResumeSigningParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const v = Number(params.key.split("-")[1]);

  const ownRpc = async (ctx: StepCtx): Promise<string> => {
    const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
      (c) => c.key.startsWith("sentry-") && c.state === "active",
    );
    if (!sentry) throw new Error("no active sentry to reach the chain through");
    return nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  };

  return [
    {
      // named to rhyme with the launch's await-signer on purpose: the UI
      // auto-opens the tmkms setup card for any *await-signer step that
      // parks at AwaitUser
      name: p("await-signer"),
      async run(ctx) {
        const row = componentRow(ctx, params.key);
        const target = rowTarget(ctx, row);
        // a ready signer's reconnect lands within seconds — poll a minute
        // before parking (same cushion as the launch's await-signer)
        for (let attempt = 0; attempt < 12; attempt++) {
          if (attempt > 0) await ctx.services.sleep(5000);
          const probe = await ctx.services.ssh.exec(target, SIGNER_CONNECTED_PROBE);
          if (probeSaysConnected(probe.stdout)) return { connected: true };
        }
        throw new AwaitUser(
          p("await-signer"),
          `${params.key} has no connected tmkms signer: start (or restart) the signer and let ` +
            "it rejoin the mesh (the tmkms panel shows the live session state). Resume once " +
            "it reports connected; the op then restarts the validator process in place and " +
            "watches it sign blocks again.",
        );
      },
    },
    {
      name: p("restart"),
      async run(ctx) {
        // process bounce over SSH (lease-shell fallback): unlike a manifest
        // update this changes nothing on-chain, so nothing can drift
        const row = componentRow(ctx, params.key);
        await restartNode(ctx.services.ssh, rowTarget(ctx, row));
        return { restarted: true };
      },
    },
    {
      name: p("verify"),
      async run(ctx) {
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        const address = keys?.accounts[`op-val-${v}`];
        const pubkey =
          keys?.consensusPubkeys[params.key] ?? spec.topology.validators.consensusPubkeys?.[v];
        const rpc = await ownRpc(ctx);
        if (!address || !pubkey) {
          throw new Error(
            `${params.key}: no operator account or consensus pubkey recorded; cannot probe signing`,
          );
        }
        const valoper = valoperAddress(address);
        const pubkeyArg = JSON.stringify({ "@type": "/cosmos.crypto.ed25519.PubKey", key: pubkey });
        let baseline: { offset: number; missed: number } | undefined;
        let lastProblem = "no signing info yet";
        for (let i = 0; i < 90; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          // a stall long enough to jail means no restart can resume the
          // chain — recovery is the unjail op, and making this step fail
          // would only obscure that (same rationale as verify-signing)
          try {
            const out = await queryJson(["query", "staking", "validator", valoper], rpc);
            if (Boolean((out.validator ?? out).jailed)) {
              ctx.log(
                `${params.key} was downtime-jailed during the stall. The process is restarted ` +
                  "and the signer connected, but the chain re-admits it only via the fleet " +
                  "panel's unjail action (it gates on the node being back at the head first).",
              );
              ctx.db.setFleetOpStatus(opId, "done");
              return { restarted: true, jailed: true };
            }
          } catch (e) {
            lastProblem = `validator query failed (${String(e).slice(0, 80)})`;
            continue;
          }
          let info: any;
          try {
            const out = await queryJson(["query", "slashing", "signing-info", pubkeyArg], rpc);
            info = out.val_signing_info ?? out;
          } catch (e) {
            lastProblem = `signing-info query failed (${String(e).slice(0, 80)})`;
            continue;
          }
          // index_offset advances per block in the active set (so it also
          // stands still while the whole chain is stalled);
          // missed_blocks_counter grows per block this validator failed to sign
          const offset = Number(info.index_offset ?? 0);
          const missed = Number(info.missed_blocks_counter ?? 0);
          if (!baseline) baseline = { offset, missed };
          const seen = offset - baseline.offset;
          const missedDelta = Math.max(0, missed - baseline.missed);
          if (seen < RESUME_PROBE_BLOCKS) {
            lastProblem =
              seen <= 0
                ? "no new blocks since the restart (chain stalled or node not in the set)"
                : `observed ${Math.max(0, seen)} of ${RESUME_PROBE_BLOCKS} blocks`;
            continue;
          }
          if (missedDelta * 2 > seen) {
            throw new Error(
              `${params.key} missed ${missedDelta} of the last ${seen} blocks after the restart, ` +
                "so it is still not signing: check the signer session (tmkms panel), the key it " +
                "holds, and the node's peers",
            );
          }
          ctx.log(
            `${params.key}: signing confirmed (${seen - missedDelta}/${seen} blocks in the probe window)`,
          );
          ctx.db.setFleetOpStatus(opId, "done");
          return { restarted: true, signing: true };
        }
        throw new Error(
          `${params.key}: could not confirm signing after ~7 min (${lastProblem}); the chain ` +
            "only produces blocks when this validator signs, so check the signer session and the node",
        );
      },
    },
  ];
}

export interface RestoreArchiveParams {
  /** Node component key (validator or sentry), e.g. "val-0". */
  key: string;
  /** Directory holding blocks_*.jsonl.gz; resolved on the node when absent. */
  archiveDir?: string;
  /** --validate: verify the app hash after every block (default true). */
  validate?: boolean;
  /** --end-height: stop the replay here (0/absent = every archived block). */
  endHeight?: number;
}

/** Where the replay writes its output and its exit code on the node. The log
 *  is deliberately NOT mirrored to the container's stdout (unlike the node
 *  log): the replay prints a progress line every 5s for hours, which is what
 *  crashes log viewers watching the provider stream. */
const REPLAY_LOG = `${NODE_HOME}/replay-archive.log`;
const REPLAY_EXIT = `${NODE_HOME}/replay-archive.exit`;
/** Bracketed so the poll command's own shell (whose cmdline contains this
 *  pattern) is not what the pgrep matches. */
const REPLAY_PGREP = 'pgrep -f "replay[-]from-archive" >/dev/null';
/** Dir the op unpacks an uploaded archive tarball into, and the first place
 *  it looks for loose archive files. */
const ARCHIVE_DIR = `${NODE_HOME}/archives`;
/** Poll cadence while the replay runs, and how long the step watches before
 *  giving up on it (the process keeps running; re-running the op re-attaches). */
const REPLAY_POLL_MS = 15_000;
const REPLAY_MAX_HOURS = 12;

/**
 * Restore block history into a node from archive files (§5): run
 * `sparkdreamd replay-from-archive` against the node's own databases, then
 * start the node back up on the rebuilt state.
 *
 * The replay opens the blockstore/state/application LevelDBs directly, so
 * sparkdreamd has to be stopped for it — and it runs for hours, printing a
 * progress line every 5 seconds. Driving it by hand through a lease shell
 * means the console has to survive both (Akash Console does not: the output
 * volume kills it, and the disconnect takes the replay with it). So the op
 * detaches the process, keeps its output in a file on the node, and polls,
 * logging only the height it has reached. A dropped launcher connection,
 * a restarted conductor, or a re-run of the op re-attaches to the same
 * running replay instead of starting a second one.
 */
export function restoreArchiveSteps(opId: number, params: RestoreArchiveParams): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const validate = params.validate !== false;
  const target = (ctx: StepCtx) => rowTarget(ctx, componentRow(ctx, params.key));

  /**
   * The block range the archives on the node cover, read off their names:
   * `target` is the height the replay is working towards and `floor` the
   * block before the first one on offer, so a set starting at 500 001 does
   * not read as 0% when it is nearly done. Archives named some other way
   * yield nothing, and the op then reports a height with no percentage.
   */
  const archiveRange = async (
    ctx: StepCtx,
    dir: string,
  ): Promise<{ target?: number; floor?: number }> => {
    const names = await ctx.services.ssh.exec(target(ctx), `ls ${dir}/blocks_*_to_*.jsonl.gz`, {
      quick: true,
    });
    const ranges = [...names.stdout.matchAll(/blocks_(\d+)_to_(\d+)\.jsonl\.gz/g)].map((m) => ({
      from: Number(m[1]),
      to: Number(m[2]),
    }));
    if (ranges.length === 0) return {};
    return {
      target: Math.max(...ranges.map((r) => r.to)),
      floor: Math.min(...ranges.map((r) => r.from)) - 1,
    };
  };

  /** Last few log lines, for an error message or a park reason. */
  const tail = async (ctx: StepCtx, lines = 5): Promise<string> => {
    const out = await ctx.services.ssh.exec(target(ctx), `tail -n ${lines} ${REPLAY_LOG} 2>/dev/null || true`, {
      quick: true,
    });
    return out.stdout.trim();
  };

  return [
    {
      name: p("find-archive"),
      async run(ctx) {
        // The upload action writes files verbatim into the chain home and
        // the operator never gets the SSH key, so unpacking an uploaded
        // tarball has to happen here — otherwise a .tar.gz of archives is
        // stranded on the node with no way to open it.
        const candidates = [params.archiveDir, ARCHIVE_DIR, `${NODE_HOME}/archive`, NODE_HOME].filter(
          (d): d is string => Boolean(d),
        );
        const find =
          candidates
            .map((d) => `if ls ${d}/blocks_*_to_*.jsonl.gz >/dev/null 2>&1; then ` +
              `echo "DIR ${d} $(ls ${d}/blocks_*_to_*.jsonl.gz | wc -l)"; exit 0; fi`)
            .join("; ") + "; echo NONE";
        const unpack =
          `mkdir -p ${ARCHIVE_DIR}; for f in ${NODE_HOME}/*.tar.gz ${NODE_HOME}/*.tgz; do ` +
          `[ -f "$f" ] || continue; ` +
          `tar tzf "$f" 2>/dev/null | grep -q "blocks_.*_to_.*\\.jsonl\\.gz" || continue; ` +
          `tar xzf "$f" -C ${ARCHIVE_DIR} || continue; echo "unpacked $f"; done; ` +
          // flatten: a tarball made from a directory nests the archives one
          // or more levels down, and --archive-dir does not recurse
          `find ${ARCHIVE_DIR} -mindepth 2 -name 'blocks_*_to_*.jsonl.gz' -exec mv {} ${ARCHIVE_DIR} \\; 2>/dev/null; true`;

        let res = await ctx.services.ssh.exec(target(ctx), find);
        if (!/^DIR /m.test(res.stdout)) {
          const un = await ctx.services.ssh.exec(target(ctx), unpack);
          for (const line of un.stdout.split("\n").filter((l) => l.startsWith("unpacked "))) {
            ctx.log(`${params.key}: ${line}`);
          }
          res = await ctx.services.ssh.exec(target(ctx), find);
        }
        const hit = /^DIR (\S+) (\d+)/m.exec(res.stdout);
        if (!hit) {
          throw new AwaitUser(
            p("find-archive"),
            `${params.key} has no block archives to restore from: upload the ` +
              "blocks_<from>_to_<to>.jsonl.gz files (or one .tar.gz containing them) with the " +
              "fleet view's upload button, then resume. They land in the chain home, and this " +
              "step unpacks a tarball into ./archives on its own.",
          );
        }
        const dir = hit[1]!;
        const count = hit[2]!;
        const range = await archiveRange(ctx, dir);
        ctx.log(
          `${params.key}: replaying from ${count} archive file(s) in ${dir}` +
            (range.target ? ` (blocks ${(range.floor ?? 0) + 1} to ${range.target})` : ""),
        );
        return { dir, files: Number(count), ...range };
      },
    },
    {
      name: p("stop-node"),
      async run(ctx) {
        // the replay opens the same LevelDBs the node holds open — a running
        // sparkdreamd makes it fail on the lock, so stop it and confirm
        const t = target(ctx);
        await ctx.services.ssh.exec(t, "pkill -x sparkdreamd || true");
        for (let i = 0; i < 20; i++) {
          await ctx.services.sleep(2000);
          const alive = await ctx.services.ssh.exec(t, "pgrep -x sparkdreamd >/dev/null && echo yes || echo no", {
            quick: true,
          });
          if (alive.stdout.trim() === "no") return { stopped: true };
          if (i === 9) await ctx.services.ssh.exec(t, "pkill -9 -x sparkdreamd || true");
        }
        throw new Error(`${params.key}: sparkdreamd is still running, so the replay cannot open its databases`);
      },
    },
    {
      name: p("replay"),
      async run(ctx) {
        const found = ctx.output<{ dir: string; target?: number; floor?: number }>(p("find-archive"));
        const dir = found?.dir ?? ARCHIVE_DIR;
        // find-archive is checkpointed, so a replay that started before it
        // recorded a range (or under an older conductor) has none to read —
        // re-derive it here rather than watch a bar-less replay for hours
        const range = found?.target === undefined ? await archiveRange(ctx, dir) : found;
        const endHeight = params.endHeight ?? range.target;
        const floor = range.floor ?? 0;
        const t = target(ctx);
        const cmd =
          `sparkdreamd replay-from-archive --home ${NODE_HOME} --archive-dir ${dir}` +
          ` --validate ${validate}` +
          (params.endHeight ? ` --end-height ${params.endHeight}` : "");

        // re-attach if a previous run of this step (or a conductor restart)
        // left the replay going; only start one when nothing is running
        const state = await ctx.services.ssh.exec(
          t,
          `${REPLAY_PGREP} && echo RUNNING; [ -f ${REPLAY_EXIT} ] && echo "EXIT $(cat ${REPLAY_EXIT})"; true`,
        );
        if (!state.stdout.includes("RUNNING")) {
          await ctx.services.ssh.exec(
            t,
            `rm -f ${REPLAY_LOG} ${REPLAY_EXIT}; cd ${NODE_HOME} && ` +
              `nohup sh -c '${cmd} > ${REPLAY_LOG} 2>&1; echo $? > ${REPLAY_EXIT}' >/dev/null 2>&1 </dev/null & ` +
              `sleep 3; ${REPLAY_PGREP} || [ -f ${REPLAY_EXIT} ]`,
          );
          ctx.log(`${params.key}: ${cmd}`);
        } else {
          ctx.log(`${params.key}: a replay is already running on the node — watching it`);
        }

        let lastLogged = 0;
        let height = "";
        // rate is measured from the first height this run of the step sees, not
        // from block zero: a re-attach joins a replay already hours in, and
        // dividing its height by this step's elapsed time would read as a rate
        // several times the real one and an ETA in the past.
        let firstHeight: number | undefined;
        let firstAt = 0;
        /** Rewrite the op's live position; the UI reads this, not the log. */
        const publish = (elapsedMs: number) => {
          const current = height ? Number(height) : undefined;
          const span = endHeight && endHeight > floor ? endHeight - floor : undefined;
          const percent =
            current !== undefined && span
              ? Math.min(100, Math.max(0, ((current - floor) / span) * 100))
              : undefined;
          // two distinct samples, or the rate is 0/0
          const rate =
            current !== undefined && firstHeight !== undefined && elapsedMs > firstAt
              ? ((current - firstHeight) / (elapsedMs - firstAt)) * 1000
              : undefined;
          ctx.db.setFleetOpProgress(opId, {
            label: `${params.key}: replaying block history`,
            current,
            target: endHeight,
            percent: percent === undefined ? undefined : Math.round(percent * 10) / 10,
            rate: rate && rate > 0 ? Math.round(rate * 100) / 100 : undefined,
            etaSeconds:
              rate && rate > 0 && endHeight && current !== undefined && endHeight > current
                ? Math.round((endHeight - current) / rate)
                : undefined,
            elapsedSeconds: Math.round(elapsedMs / 1000),
            updatedAt: new Date().toISOString(),
          });
        };
        publish(0);

        const polls = (REPLAY_MAX_HOURS * 3600 * 1000) / REPLAY_POLL_MS;
        for (let i = 0; i < polls; i++) {
          await ctx.services.sleep(REPLAY_POLL_MS);
          const out = await ctx.services.ssh.exec(
            t,
            `[ -f ${REPLAY_EXIT} ] && echo "EXIT $(cat ${REPLAY_EXIT})"; ${REPLAY_PGREP} && echo RUNNING; ` +
              `tail -n 3 ${REPLAY_LOG} 2>/dev/null; true`,
            { quick: true },
          );
          height = /height=(\d+)/.exec(out.stdout)?.[1] ?? height;
          const now = (i + 1) * REPLAY_POLL_MS;
          if (height && firstHeight === undefined) {
            firstHeight = Number(height);
            firstAt = now;
          }
          const exit = /^EXIT (\d+)/m.exec(out.stdout);
          if (exit) {
            if (exit[1] !== "0") {
              throw new Error(
                `${params.key}: replay-from-archive exited ${exit[1]}. Last output:\n${await tail(ctx, 15)}`,
              );
            }
            const done = await tail(ctx, 4);
            publish(now);
            ctx.log(`${params.key}: replay complete${height ? ` at height ${height}` : ""}\n${done}`);
            return { height: height ? Number(height) : undefined, dir };
          }
          if (!out.stdout.includes("RUNNING")) {
            // gone without writing an exit code: the container restarted (or
            // something killed it) mid-replay. Replay is resumable — it picks
            // up from the node's committed height — so say so plainly.
            throw new Error(
              `${params.key}: the replay process disappeared without finishing (the container may ` +
                `have restarted). It resumes from where it stopped: run restore again. Last output:\n${await tail(ctx, 15)}`,
            );
          }
          // the position the fleet view reads is rewritten every poll; the log
          // still gets one line every ~2 min (the replay prints one every 5s)
          publish(now);
          if (now - lastLogged >= 120_000) {
            lastLogged = now;
            const pct =
              endHeight && height && endHeight > floor
                ? ` (${Math.round(((Number(height) - floor) / (endHeight - floor)) * 100)}%)`
                : "";
            ctx.log(
              `${params.key}: replaying${height ? `, at height ${height}` : ""}${
                endHeight ? ` of ${endHeight}` : ""
              }${pct} (${Math.round(now / 60000)} min)`,
            );
          }
        }
        throw new Error(
          `${params.key}: the replay is still running after ${REPLAY_MAX_HOURS}h${
            height ? ` (height ${height})` : ""
          }; it keeps going on the node — run restore again to re-attach and keep watching`,
        );
      },
    },
    {
      name: p("start-node"),
      async run(ctx) {
        const t = target(ctx);
        await ctx.services.ssh.exec(t, START_NODE_CMD);
        await ctx.services.sleep(5000);
        const alive = await ctx.services.ssh.exec(t, "pgrep -x sparkdreamd >/dev/null && echo yes || echo no", {
          quick: true,
        });
        if (alive.stdout.trim() !== "yes") {
          const log = await ctx.services.ssh.exec(t, `tail -n 15 ${NODE_LOG} 2>/dev/null || true`);
          throw new Error(
            `${params.key}: the node did not start on the restored state. Last output:\n${log.stdout.trim()}`,
          );
        }
        // the op is over: drop the live position rather than leave a finished
        // bar sitting at whatever the last poll saw
        ctx.db.setFleetOpProgress(opId, null);
        ctx.db.setFleetOpStatus(opId, "done");
        return { started: true };
      },
    },
  ];
}

export interface RepairParams {
  /** The component the operator clicked. The sweep itself is fleet-wide;
   *  this only shapes the log lines. */
  key: string;
}

/**
 * Repair (§5): reconcile the fleet against reality and fix what has drifted,
 * without relaunching anything. One op made of independent passes, so future
 * repairs are added here rather than as another button.
 *
 * **The contract every pass must keep**, because they share one action and
 * one confirm dialog:
 *
 *  1. *Convergent* — find nothing wrong, change nothing, cost nothing. A
 *     run on a healthy fleet must be free to click.
 *  2. *Narrow* — touch only what is actually broken. A pass that would
 *     restart a healthy component to fix a broken one does not belong.
 *  3. *Priced up front* — whatever it can cost (a restart, a signature) is
 *     named in {@link FleetService.repairWarnings}, since the operator agrees
 *     to the whole op, not to one pass. A repair too expensive to state that
 *     plainly should report the problem and let the operator choose the op.
 *
 * Today's passes all serve one failure: a component's mesh address moved and
 * the fleet kept dialing the old one.
 *
 * Tailnet IPs move: a component relaunch or a headscale re-key hands out a
 * different address, and everything that dials the old one goes dark. The
 * relaunch op already repairs its own blast radius (persist re-aims the
 * counterpart sentries, mesh-clients the explorer), but an address can go
 * stale outside a relaunch — a re-key, an aborted op, a relaunch whose
 * dependents were unplaced at the time, a deployment bounced by hand in
 * another tool — and until now the only cure was relaunching the
 * *dependents*, which moves them to new providers, re-syncs their volumes and
 * costs an escrow cycle, all to change one env line.
 *
 * It starts by correcting what the launcher believes, not by acting on it —
 * a repair driven off a stale record just bakes the wrong value in deeper:
 *
 *  - **endpoints**: where each component answers SSH, re-read from its
 *    provider's lease status. The port is provider-assigned, so a container
 *    recycled outside the launcher comes back on a different one, and every
 *    later pass reaches components through this.
 *  - **addresses**: each reachable component's live tailnet IP, which the
 *    remaining passes — and every later relaunch, tmkms address and health
 *    check — then read.
 *
 * Together those two are what make the launcher's state self-healing after
 * work done outside it: a deployment bounced by hand in Akash Console comes
 * back on a new forwarded port AND a new mesh address, and the launcher
 * discovers both instead of being wedged by them.
 *
 * Two more places hold an address, and they need different treatment:
 *
 *  - **mesh-env**: tunnel targets in the SDL (a sentry's `TS_TUNNEL_<v>` at its validator's
 *    p2p port, the explorer's at its sentry's LCD/RPC). Fixing it is a
 *    deployment update: rewrite the SDL, one batched MsgUpdateDeployment,
 *    re-push the manifests. The push restarts those containers, which is what
 *    re-creates the tunnels at the right target.
 *  - **peers**: `persistent_peers` in config.toml on the volume (a validator dialing
 *    its sentries, sentries dialing each other — those ride the tailnet
 *    directly, not a tunnel). Fixing it is an SSH edit plus a process
 *    restart; nothing on-chain changes, so no hash can drift.
 *
 * So: a component already pointing at the current address is left alone, its
 * container is never restarted, and a re-run of a finished op does nothing.
 */
export function repairSteps(opId: number, params: RepairParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const meshKeys = [
    ...nodes(spec).map((n) => n.key),
    ...statelessComponents(spec)
      .filter((c) => c.mesh)
      .map((c) => c.key),
  ];

  return [
    {
      name: p("endpoints"),
      async run(ctx) {
        // Every later pass reaches a component over the SSH endpoint on its
        // row, and that endpoint is a provider-assigned forwarded port for
        // 2222 — which a container recycled outside the launcher comes back
        // on a DIFFERENT one of. The row then points at a port nothing
        // listens on, the component reads as unreachable, and repair
        // correctly declines to touch it while being unable to fix it. So
        // re-read the mapping from lease status first: the provider is the
        // authority on where a component answers, exactly as at launch.
        const cert = loadCert(ctx);
        const corrected: string[] = [];
        const unreadable: string[] = [];
        for (const row of ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]) {
          // no recorded endpoint = the component runs no sshd; nothing to fix
          if (row.state !== "active" || !row.ssh_host || !row.host_uri) continue;
          let ssh: { host: string; port: number };
          try {
            const status = await ctx.services.provider.leaseStatus(cert, row.host_uri, row.dseq, 1, 1);
            ssh = extractForwardedPort(status, 2222);
          } catch (e) {
            // an unreachable provider (or a lease with no forwarded 2222)
            // says nothing about whether the recorded endpoint still works
            unreadable.push(`${row.key} (${String(e).slice(0, 60)})`);
            continue;
          }
          if (ssh.host === row.ssh_host && ssh.port === row.ssh_port) continue;
          ctx.log(
            `${row.key}: SSH endpoint was ${row.ssh_host}:${row.ssh_port}, provider now forwards ` +
              `${ssh.host}:${ssh.port}`,
          );
          ctx.db.updateComponentRuntime(ctx.launchId, row.key, {
            ssh_host: ssh.host,
            ssh_port: ssh.port,
          });
          corrected.push(row.key);
        }
        if (unreadable.length > 0) {
          ctx.log(`could not read a lease status for ${unreadable.join(", ")} — keeping their endpoints`);
        }
        if (corrected.length === 0) ctx.log("every recorded SSH endpoint matches the provider's");
        return { corrected, unreadable };
      },
    },
    {
      name: p("addresses"),
      async run(ctx) {
        // Ask each box what its address actually is. The launcher's record is
        // a snapshot from the last time it placed or probed the component,
        // and anything that restarted the container since — a hand-driven
        // redeploy in another console, a provider bounce, a headscale re-key
        // — re-joined the mesh on an address the launcher never saw. Fixing
        // the links from a stale record would just bake the wrong address in.
        const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
        const corrected: Record<string, string> = {};
        const unreachable: string[] = [];
        for (const key of meshKeys) {
          const row = rows.find((c) => c.key === key);
          if (!row || row.state !== "active" || !row.ssh_host) continue;
          const res = await ctx.services.ssh
            .exec(
              rowTarget(ctx, row),
              `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ip -4 2>/dev/null || true`,
              { quick: true },
            )
            .catch(() => ({ stdout: "" }));
          const ip = res.stdout.trim().split("\n")[0] ?? "";
          // not on the mesh right now (or not reachable): leave the record
          // alone rather than erase an address that may still be correct
          if (!/^100\./.test(ip)) {
            unreachable.push(key);
            continue;
          }
          if (ip === row.tailnet_ip) continue;
          ctx.log(`${key}: recorded address was ${row.tailnet_ip ?? "unset"}, live address is ${ip}`);
          ctx.db.updateComponentRuntime(ctx.launchId, key, { tailnet_ip: ip });
          corrected[key] = ip;
        }
        if (unreachable.length > 0) {
          ctx.log(
            `no live address from ${unreachable.join(", ")} — keeping the recorded one for ` +
              "them (a component off the mesh cannot be asked where it is)",
          );
        }
        if (Object.keys(corrected).length === 0) {
          ctx.log("every recorded address matches the live one");
        } else {
          // the tmkms checklist, the signer panel and future relaunches read
          // the launch's await-mesh table rather than the component rows —
          // left behind, they keep printing addresses that just moved
          const launchMesh = ctx.db.stepOutput<{ ips: Record<string, string> }>(
            ctx.launchId,
            "await-mesh",
          );
          if (launchMesh) {
            ctx.db.stepDone(ctx.launchId, "await-mesh", {
              ips: { ...launchMesh.ips, ...corrected },
            });
          }
        }
        return { corrected, unreachable };
      },
    },
    {
      name: p("images"),
      async run(ctx) {
        // The recorded image is a snapshot of the last placement or upgrade
        // the LAUNCHER drove. A version swapped in outside it — an operator
        // finishing a wedged upgrade by hand in the Akash console — leaves the
        // row advertising a version that is not running, and the fleet card
        // reads it straight off that row. Ask the binary: the node is the only
        // authority on what it is executing. Chain nodes only; nothing else in
        // the fleet can be asked its version this way.
        const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
        const corrected: Record<string, string> = {};
        const unreadable: string[] = [];
        for (const row of rows) {
          if (row.state !== "active" || !row.ssh_host || !/^(val|sentry)-/.test(row.key)) continue;
          const res = await ctx.services.ssh
            .exec(rowTarget(ctx, row), "sparkdreamd version 2>&1 | head -1", { quick: true })
            .catch(() => ({ stdout: "" }));
          const version = /\d+\.\d+\.\d+[^\s]*/.exec(res.stdout.trim())?.[0];
          if (!version) {
            unreadable.push(row.key);
            continue;
          }
          const wanted = retagImage(row.image, version);
          if (!wanted || wanted === row.image) continue;
          ctx.log(`${row.key}: recorded image was ${row.image}, node reports ${version}`);
          ctx.db.updateComponentRuntime(ctx.launchId, row.key, { image: wanted });
          // the on-disk SDL is the launcher's model of the deployment: left
          // stale, the next upgrade derives its manifest from the wrong image
          const sdlPath = sdlPathFor(ctx, row.key);
          if (fs.existsSync(sdlPath)) {
            fs.writeFileSync(
              sdlPath,
              fs.readFileSync(sdlPath, "utf8").replace(/image: .*/g, `image: ${wanted}`),
            );
          }
          corrected[row.key] = wanted;
        }
        if (unreadable.length > 0) {
          ctx.log(
            `no version from ${unreadable.join(", ")} — keeping their recorded image (a node ` +
              "that cannot be asked may still be running what the record says)",
          );
        }
        if (Object.keys(corrected).length === 0) {
          ctx.log("every recorded node image matches the version the node reports");
        }
        return { corrected, unreadable };
      },
    },
    {
      name: p("mesh-env"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
        const msgs: Msg[] = [];
        const pushes: Array<{ row: FleetComponentRow; json: string }> = [];
        for (const key of meshKeys) {
          if (tunnelPeers(spec, key).size === 0) continue;
          const row = rows.find((c) => c.key === key);
          if (!row || row.state !== "active") continue;
          const sdlPath = sdlPathFor(ctx, key);
          if (!fs.existsSync(sdlPath)) continue;
          const retarget = retargetTunnelEnv(ctx, spec, key, fs.readFileSync(sdlPath, "utf8"));
          if (retarget.changes.length === 0) continue;
          for (const c of retarget.changes) ctx.log(`${key}: tunnel re-aimed at ${c}`);
          fs.writeFileSync(sdlPath, retarget.text);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
          pushes.push({ row, json: artifacts.manifestJson });
          // convergent, like retarget: a deployment already at this version
          // would reject the update ("nothing to change") — re-send only
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) continue;
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        if (pushes.length === 0) {
          ctx.log("every tunnel already names its peer's current address");
          ctx.db.deletePendingTx(ctx.launchId, p("mesh-env"));
          return { repointed: [] };
        }
        if (msgs.length > 0) await ctx.requireTx(p("mesh-env"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("mesh-env"));
        const cert = loadCert(ctx);
        for (const { row, json } of pushes) {
          await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
        }
        return { repointed: pushes.map((x) => x.row.key) };
      },
    },
    {
      name: p("peers"),
      async run(ctx) {
        const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
        const nodeIds = ctx.output<GenerateKeysOutput>("generate-keys")?.nodeIds ?? {};
        // node id → the component that owns it, so a peer entry can be
        // matched to a fleet member without parsing its address first
        const keyForId = new Map(Object.entries(nodeIds).map(([k, id]) => [id, k]));
        const repaired: string[] = [];
        for (const key of nodes(spec).map((n) => n.key)) {
          const row = rows.find((c) => c.key === key);
          if (!row || row.state !== "active" || !row.ssh_host) continue;
          const target = rowTarget(ctx, row);
          const got = await ctx.services.ssh
            .exec(target, `grep '^persistent_peers' ${NODE_HOME}/config/config.toml`, { quick: true })
            .catch(() => ({ stdout: "" }));
          const line = /^persistent_peers\s*=\s*"(.*)"/m.exec(got.stdout);
          if (!line) continue;
          const changes: string[] = [];
          const next = (line[1] ?? "")
            .split(",")
            .filter(Boolean)
            .map((entry) => {
              const m = /^([^@]+)@(.+):(\d+)$/.exec(entry.trim());
              if (!m) return entry.trim();
              const [, id, addr, port] = m as unknown as [string, string, string, string];
              const peerKey = keyForId.get(id);
              const ip = peerKey ? rows.find((c) => c.key === peerKey)?.tailnet_ip : undefined;
              if (!peerKey || !ip || addr === ip) return entry.trim();
              // 127.0.0.1 is a tunnel entry (a sentry reaches its validators
              // through one) — the env pass owns those, and rewriting the
              // loopback to a tailnet IP would break the design. A public
              // hostname is a join-mode peer, deliberately off the mesh.
              if (!addr.startsWith("100.") && !addr.startsWith("{{")) return entry.trim();
              changes.push(`${peerKey} ${addr} → ${ip}`);
              return `${id}@${ip}:${port}`;
            })
            .join(",");
          if (changes.length === 0) continue;
          for (const c of changes) ctx.log(`${key}: peer re-aimed at ${c}`);
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|^persistent_peers.*|persistent_peers = "${next}"|' ${NODE_HOME}/config/config.toml`,
          );
          // a peer change only takes effect on a restart of the process
          await restartNode(ctx.services.ssh, target);
          repaired.push(key);
        }
        if (repaired.length === 0) ctx.log("every peer entry already names its node's current address");
        ctx.db.setFleetOpStatus(opId, "done");
        return { repaired };
      },
    },
  ];
}

/**
 * Op kinds whose steps run BEFORE the launch's own, not after (see
 * {@link buildPreLaunchOpSteps}).
 */
const PRE_LAUNCH_OP_KINDS = new Set(["restore-archive", "repair"]);

/**
 * Steps for ops that must not queue behind the launch. The composed list is
 * launch-steps-then-op-steps, so an op only ever runs once every launch step
 * is done — right for a relaunch or an upgrade, and wrong for the two ops
 * whose whole job is to cure what the launch is stuck on:
 *
 *  - **restore-archive**: a node missing its block history is usually why the
 *    launch is parked (`verify-chain` failing on a chain that produces
 *    nothing is exactly the state restore fixes).
 *  - **repair**: a fleet dialing dead addresses does not gossip, so it does
 *    not produce blocks, so `verify-chain` fails — the same step, for the
 *    reason repair exists to fix.
 *
 * Behind that failure the op would never start. Seen live twice, and the
 * symptom is identical both times: the op sits with no step rows at all while
 * the operator watches a spinner that is really the LAUNCH's step, wondering
 * whether the op is doing anything (it is not). These run first instead, so a
 * parked launch is no obstacle; the launch's own steps then re-run against
 * the repaired fleet.
 */
export function buildPreLaunchOpSteps(db: ConductorDb, launchId: string): StepDef[] {
  return buildSteps(db, launchId, (kind) => PRE_LAUNCH_OP_KINDS.has(kind));
}

/** Steps for every active op of a launch, in creation order. */
export function buildOpSteps(db: ConductorDb, launchId: string): StepDef[] {
  return buildSteps(db, launchId, (kind) => !PRE_LAUNCH_OP_KINDS.has(kind));
}

function buildSteps(
  db: ConductorDb,
  launchId: string,
  wanted: (kind: string) => boolean,
): StepDef[] {
  const launch = db.getLaunch(launchId);
  if (!launch) return [];
  const spec = withDefaults(JSON.parse(launch.spec_json));
  const steps: StepDef[] = [];
  for (const op of db.listFleetOps(launchId) as FleetOpRow[]) {
    if (op.status !== "active" && op.status !== "done") continue;
    if (!wanted(op.kind)) continue;
    // done ops keep their steps in the list — checkpointed rows skip instantly
    const params = JSON.parse(op.params_json);
    if (op.kind === "relaunch") {
      steps.push(
        ...(params.key === "headscale"
          ? headscaleRelaunchSteps(op.id, params, spec)
          : relaunchSteps(op.id, params, spec)),
      );
    }
    if (op.kind === "upgrade") steps.push(...upgradeSteps(op.id, params, spec));
    if (op.kind === "halt-upgrade") steps.push(...haltUpgradeSteps(op.id, params, spec));
    if (op.kind === "retarget") steps.push(...retargetSteps(op.id, params, spec));
    if (op.kind === "reset-chain") steps.push(...resetChainSteps(op.id, params, spec));
    if (op.kind === "unjail") steps.push(...unjailSteps(op.id, params, spec));
    if (op.kind === "resume-signing") steps.push(...resumeSigningSteps(op.id, params, spec));
    if (op.kind === "restore-archive") steps.push(...restoreArchiveSteps(op.id, params));
    if (op.kind === "repair") steps.push(...repairSteps(op.id, params, spec));
  }
  return steps;
}
