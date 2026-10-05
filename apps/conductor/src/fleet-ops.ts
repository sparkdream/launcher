import crypto from "node:crypto";
import { originInstruction, pointDns, pointOrigins, publicEndpointRecords, type OriginRecord } from "./dns-steps.js";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  chainId,
  COMPONENT_KINDS,
  headscaleDomain,
  isServicesFleet,
  nodes,
  resolveTopology,
  serviceComponents,
  tunnelPort,
  withDefaults,
  type ComponentKey,
  type ComponentRef,
  type LaunchSpec,
  type LaunchSpecInput,
} from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, FleetOpRow } from "./db.js";
import { backupMastodon, restoreMastodon, type MastodonBackup } from "./steps/mastodon-migrate.js";
import { AwaitUser, launchDirs, RerunFrom, type StepCtx, type StepDef } from "./engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import { createDeploymentMsg, createLeaseMsg, TypeUrl, type Msg } from "./akash/messages.js";
import { feeCoin, feeConfig } from "./fee.js";
import { PRICING_DENOM } from "./render-sdl.js";
import { pollBids } from "./akash/client.js";
import { describeBids, exclusionEntries, manualBidRequired, selectProvider, type Bid, type OfferedBid, type PolicyDecision, type ProviderInfo } from "./akash/policy.js";
import { loadSdl, sdlArtifacts, sortedJson } from "./akash/sdl-groups.js";
import { gateForFreshVolume } from "./akash/update.js";
import { ageIdentityAt, clearPin, extractForwardedPort, headscaleUserId, loadCert, nodeRpcUrl, nodeShellFallback, pinnedValue, sshTarget, templateHeadscaleSdl, waitLeaseStatus, type HeadscaleOutput } from "./steps/phase-bcd.js";
import {
  buildGenesisFiles,
  createNamedAccounts,
  packageNodeDataStep,
  placeholder,
  type GenerateKeysOutput,
} from "./steps/phase-a.js";
import { sparkdreamd } from "./exec.js";
import { renderComponentSdl } from "./render-component-sdl.js";
import { descriptorFor, setServiceEnv } from "./components/index.js";
import { applyMinGasPrices, nodeMinGasPrices, patchNodeAppToml, patchSentryAppToml, readMinGasPrices, sentryServe } from "./sentry-serve.js";
import { fleetPeer, peerRow, relayedBy, sisterChainApis } from "./relayer.js";
import { linkFederationPeers, linkRelayer, openPublicGrpc } from "./steps/relayer-link.js";
import { reconcileSessions, type SessionRole } from "./sessions.js";
import { ensureBridgeOperatorKey } from "./steps/mastodon.js";
import { fleetResolver } from "./verifier.js";
import { deploymentInfoWithRetry, forwardedVerdict, ingressHost, ingressVerdict, pushManifest, wireValidatorPeers } from "./steps/phase-ef.js";
import { resolveStateSyncTrust } from "./steps/join.js";
import { accountCoordinates, awaitTxIncluded, queryJson } from "./steps/phase-g.js";
import {
  assembleUnjailTxJson,
  buildUnjailSignDoc,
  valoperAddress,
  verifySignedDoc,
  type GentxSignResponse,
} from "./gentx.js";
import { NODE_HOME, NODE_LOG, restartNode, rpcUrl, socatTunnelCmd, STALLED_BEHIND_BLOCKS, START_NODE_CMD, VAL_PEER_TUNNEL_PORT, WITNESS_RPC_PORT } from "./node-ops.js";
import { probeSaysConnected, SIGNER_CONNECTED_PROBE } from "./tmkms.js";
import { nodeResizeSteps } from "./node-resize.js";
import { meshBackupSteps } from "./mesh-backup.js";
import { addSentrySteps, type AddSentryParams } from "./add-sentry.js";
import {
  dataBackupSteps,
  dataRestoreSteps,
  restoreChainData,
  type DataBackupParams,
  type DataRestoreParams,
} from "./data-backup.js";
import {
  managedSigner,
  rejoinSignerMesh,
  signerMachine,
  repointSigner,
  resetSignerState,
  restartSigner,
  signerDepsOf,
  tryManaged,
} from "./local-signer.js";
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
  /** Re-placements made because the provider's ingress served nothing (verify). */
  ingressReplacements?: number;
  /** A re-placement under way: the deployment being closed, and its provider. */
  replacing?: { dseq: string; provider: string };
  /** Bids on offer for the pick, refreshed each time the step parks; with a
   *  reason when the op asked on its own (the policy's pick is then also a
   *  choice: AUTO_BID). */
  offeredBids?: { dseq: string; bids: OfferedBid[]; reason?: string };
}

/** A bidChoice provider meaning "lease what the selection policy picks". */
export const AUTO_BID = "auto";

export interface UpgradeParams {
  /** Components in rolling order (sentries first, then validators). */
  components: string[];
  image: string;
  /** Image each component ran when the op was requested: what a node that
   *  cannot run the new one is rolled back to. Absent on older ops. */
  previous?: Record<string, string>;
  /** spec.images before the op recorded the new image, restored on rollback
   *  so relaunches and resets keep rendering the image that works. */
  previousSpecImages?: Record<string, string>;
}

export function componentRow(ctx: StepCtx, key: string): FleetComponentRow {
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
    // every validator dials its first sentry through a peer tunnel; join
    // mode adds an own-sentry witness. An absent entry simply matches
    // nothing.
    const s = topo.validatorSentries[Number(key.split("-")[1])]?.[0];
    if (s !== undefined) {
      peers.set(WITNESS_RPC_PORT, `sentry-${s}`);
      peers.set(VAL_PEER_TUNNEL_PORT, `sentry-${s}`);
    }
  } else if (key.startsWith("sentry-")) {
    for (const v of topo.sentryValidators[Number(key.split("-")[1])] ?? []) {
      peers.set(tunnelPort(v), `val-${v}`);
    }
  } else {
    for (const t of descriptorFor(key)?.tunnels(spec) ?? []) peers.set(t.local, t.peer);
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
  /** The fleet whose SDL this is (another fleet's, for a relayer dialing
   *  this one); its own peers resolve against its rows. */
  fleetId: string = ctx.launchId,
): { text: string; changes: string[] } {
  const peers = tunnelPeers(spec, key);
  if (peers.size === 0) return { text, changes: [] };
  const rows = ctx.db.listFleetComponents(fleetId) as FleetComponentRow[];
  const changes: string[] = [];
  const out = text.replace(
    /TS_TUNNEL_([A-Za-z0-9_]+)=(\d+):(.+?):(\d+)(?=["'\s]|$)/g,
    (whole, name: string, local: string, target: string, remote: string) => {
      const peerKey = peers.get(Number(local));
      if (!peerKey) return whole;
      // `key@launch` names a component in another fleet (a relayer's
      // counterparty sentry): its address lives in that fleet's rows
      const ip = peerKey.includes("@")
        ? peerRow(ctx.db, fleetId, peerKey)?.tailnet_ip
        : rows.find((c) => c.key === peerKey)?.tailnet_ip;
      if (!ip || ip === target) return whole;
      changes.push(`${peerKey} ${target} → ${ip}`);
      return `TS_TUNNEL_${name}=${local}:${ip}:${remote}`;
    },
  );
  return { text: out, changes };
}

/** Mesh components whose tunnel env dials `key` (the explorer, for a sentry). */
function meshDependents(spec: LaunchSpec, key: string): string[] {
  return serviceComponents(spec)
    .filter((c) => c.mesh && [...tunnelPeers(spec, c.key).values()].includes(key))
    .map((c) => c.key);
}

/** A mesh component that dials `key`, in this fleet or (a relayer) another. */
interface MeshDependent {
  fleetId: string;
  key: string;
  spec: LaunchSpec;
  sdlDir: string;
}

/**
 * Every mesh component dialing this fleet's `key`: meshDependents here, plus
 * — for sentry-0 — any other fleet's relayer that tunnels to it. Resolved at
 * run time, since other fleets can start relaying after this op was built.
 */
function allMeshDependents(ctx: StepCtx, spec: LaunchSpec, key: string): MeshDependent[] {
  const out: MeshDependent[] = meshDependents(spec, key).map((k) => ({
    fleetId: ctx.launchId,
    key: k,
    spec,
    sdlDir: ctx.dirs.sdl,
  }));
  if (key !== "sentry-0") return out;
  const peer = fleetPeer("sentry-0", ctx.launchId);
  for (const other of relayedBy(ctx.db, ctx.launchId)) {
    const launch = ctx.db.getLaunch(other);
    if (!launch) continue;
    const otherSpec = withDefaults(JSON.parse(launch.spec_json));
    for (const c of serviceComponents(otherSpec)) {
      if (!c.mesh || !descriptorFor(c.key)?.tunnels(otherSpec).some((t) => t.peer === peer)) continue;
      out.push({ fleetId: other, key: c.key, spec: otherSpec, sdlDir: launchDirs(ctx.workRoot, other).sdl });
    }
  }
  return out;
}

export function rowTarget(ctx: StepCtx, row: FleetComponentRow): SshTarget {
  if (!row.ssh_host || !row.ssh_port) throw new Error(`${row.key}: no SSH endpoint recorded`);
  // a service component's lease-shell runs in its own service, not sparkdreamd
  const node = row.key.startsWith("val-") || row.key.startsWith("sentry-");
  const service = node ? "sparkdreamd" : (descriptorFor(row.key)?.shellService ?? row.key);
  return sshTarget(ctx, row.ssh_host, row.ssh_port, nodeShellFallback(ctx, row.host_uri, row.dseq, 1, 1, service));
}

/**
 * A validator SDL with its own-sentry tunnels set: the outbound p2p proxy
 * every validator dials its first sentry through, plus the light-client
 * witness a joining validator state-syncs against. Text is returned
 * unchanged when it already carries exactly these entries, so a convergent
 * caller does not re-serialize the YAML into a new manifest hash.
 */
export function withValidatorTunnelEnv(text: string, sentryIp: string, witness: boolean): string {
  const want = [`TS_TUNNEL_PEER=${VAL_PEER_TUNNEL_PORT}:${sentryIp}:26656`];
  if (witness) want.unshift(`TS_TUNNEL_WITNESS=${WITNESS_RPC_PORT}:${sentryIp}:26657`);
  const doc = yaml.load(text) as any;
  const svc = doc?.services?.sparkdreamd;
  if (!svc) return text;
  const current: string[] = svc.env ?? [];
  if (want.every((w) => current.includes(w))) return text;
  svc.env = current
    .filter((e) => !e.startsWith("TS_TUNNEL_WITNESS=") && !e.startsWith("TS_TUNNEL_PEER="))
    .concat(want);
  return yaml.dump(doc, { lineWidth: 120 });
}

/**
 * Why a validator's persistent_peers cannot reach its sentries, or null when
 * it can. Re-aiming addresses fixes none of these: the line names the
 * validator itself (collect-gentxs on a reset wrote exactly that), leaves
 * out one of its sentries, or reaches its first sentry at a bare tailnet IP,
 * which userspace tailscale cannot dial, so only the sentry's own redial
 * (and its backoff) ever restores the link.
 */
export function validatorPeersProblem(
  spec: LaunchSpec,
  key: string,
  peers: string,
  nodeIds: Record<string, string>,
  /** Each sentry's current public p2p endpoint ("host:port"), when known: an
   *  entry naming any other public address dials a deployment that is gone
   *  (a sentry relaunch moves it; seen live 2026-10-02). */
  publicP2p: Record<number, string | undefined> = {},
): string | null {
  const entries = peers.split(",").map((e) => e.trim()).filter(Boolean);
  const idOf = (e: string) => e.split("@")[0] ?? "";
  const own = nodeIds[key];
  if (own && entries.some((e) => idOf(e) === own)) return "persistent_peers names the validator itself";
  const sentries = resolveTopology(spec).validatorSentries[Number(key.split("-")[1])] ?? [];
  for (const [i, s] of sentries.entries()) {
    const id = nodeIds[`sentry-${s}`];
    if (!id) continue;
    const entry = entries.find((e) => idOf(e) === id);
    if (!entry) return `persistent_peers has no entry for sentry-${s}`;
    if (i === 0 && /@100\./.test(entry)) {
      return `sentry-${s} is peered at a tailnet IP the validator cannot dial`;
    }
    const addr = entry.slice(entry.indexOf("@") + 1);
    const pub = publicP2p[s];
    if (pub && !/^(127\.0\.0\.1|100\.)/.test(addr) && addr !== pub) {
      return `sentry-${s} is peered at ${addr}, but its public endpoint is now ${pub}`;
    }
  }
  return null;
}

/** A sentry's provider-forwarded public p2p endpoint, read from its lease. */
async function sentryPublicP2p(
  ctx: StepCtx,
  s: number,
): Promise<{ host: string; port: number } | undefined> {
  const row = componentRow(ctx, `sentry-${s}`);
  try {
    const status = await ctx.services.provider.leaseStatus(loadCert(ctx), row.host_uri, row.dseq, 1, 1);
    return extractForwardedPort(status, 26656);
  } catch {
    // no forwarded p2p (or no status): the mesh path is the fallback
    return undefined;
  }
}

export function sdlPathFor(ctx: StepCtx, key: string): string {
  return path.join(ctx.dirs.sdl, `${key}.yaml`);
}

/**
 * Path to a component's tailscaled control socket. tailscaled puts it in
 * TS_STATE_DIR, and the images disagree on where that is: the node image uses
 * ${NODE_HOME}/tailscale, while components rendered by render-component-sdl
 * (the explorer) use /data/tailscale. Probing the node path on the explorer
 * finds no socket and reads as "never joined the mesh" no matter how healthy
 * the container is — a false negative that fails the whole rekey. Resolve it
 * from the component's own rendered SDL, which is what set the variable, and
 * fall back to the node default for anything that does not name one.
 */
function meshSocket(ctx: StepCtx, key: string): string {
  let stateDir: string | undefined;
  try {
    const sdl = fs.readFileSync(sdlPathFor(ctx, key), "utf8");
    stateDir = /^\s*-\s*"?TS_STATE_DIR=([^\s"']+)/m.exec(sdl)?.[1];
  } catch {
    stateDir = undefined;
  }
  return `${stateDir ?? `${NODE_HOME}/tailscale`}/tailscaled.sock`;
}

/**
 * Put a set of components on-chain at the manifest they are about to be sent,
 * then send it. Re-runs are the normal case for these ops (a rekey that died
 * halfway, a fleet the operator repaired by hand in the meantime), and by then
 * the live deployments can sit at a version this launcher never signed. A tx
 * keyed to the step alone would read its own months-old confirmed row, sign
 * nothing, and push a manifest at a version nobody updated — which is exactly
 * what a provider rejects with "422 manifest version validation failed". It is
 * the wedge persist-start already had (§ phase-ef), so this follows the same
 * rule: read each deployment first, sign only the ones that drifted under a
 * key scoped to that exact set, and let a 422 pass only once the versions
 * already agree, where it can only be the provider's "no change to apply".
 */
export async function updateOnChainAndPush(
  ctx: StepCtx,
  owner: string,
  cert: ReturnType<typeof loadCert>,
  baseStep: string,
  items: { row: FleetComponentRow; hash: string; manifestJson: string }[],
): Promise<void> {
  if (items.length === 0) return;
  const drifted: typeof items = [];
  for (const it of items) {
    const onChain = await deploymentInfoWithRetry(ctx, owner, it.row.dseq);
    // Neither of these can be signed into a working tx: an update against a
    // closed or unknown deployment fails on-chain, and a failed tx wedges the
    // signing queue behind a signature that can never succeed.
    if (!onChain) {
      throw new Error(
        `${it.row.key}: deployment ${it.row.dseq} is not on-chain (or the LCD did not answer): ` +
          "retry, and relaunch the component if it stays gone",
      );
    }
    if (onChain.state !== "active") {
      throw new Error(
        `${it.row.key}: deployment ${it.row.dseq} is ${onChain.state}: relaunch the component, then retry`,
      );
    }
    if (onChain.hash !== it.hash) drifted.push(it);
    else ctx.log(`${it.row.key}: on-chain version already matches the manifest`);
  }
  if (drifted.length > 0) {
    // Scoped to the exact set being signed, so a later drift is a new request
    // rather than a confirmed row that skips the signature the provider is
    // waiting on. Any unsigned row under the bare key is dropped: the
    // oldest-first signing queue would otherwise surface it ahead of this one
    // and the operator would sign a payload nothing is waiting for.
    ctx.db.discardUnsignedPendingTx(ctx.launchId, baseStep);
    const tag = crypto
      .createHash("sha256")
      .update(drifted.map((d) => `${d.row.key}:${d.hash}`).join("|"))
      .digest("hex")
      .slice(0, 8);
    await ctx.requireTx(
      `${baseStep}:${tag}`,
      drifted.map((d) => ({
        typeUrl: TypeUrl.UpdateDeployment,
        value: { id: { owner, dseq: d.row.dseq }, hash: d.hash },
      })),
    );
  }
  for (const it of items) {
    await pushManifest(ctx, cert, it.row.key, it.row.host_uri, it.row.dseq, it.manifestJson);
  }
}

/**
 * Rewrite every old tailnet address to its new one in a single pass. Applying
 * the pairs one after another corrupts a swap: headscale reallocates from an
 * empty database in registration order, so a relaunch really can hand val-0
 * the address sentry-0 used to hold. Replacing 100.64.0.1→100.64.0.2 and then
 * 100.64.0.2→100.64.0.1 over the same text collapses BOTH peers onto one
 * address, silently pointing every tunnel at the wrong node.
 */
export function rewriteTailnetIps(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  const alt = [...map.keys()].map((o) => o.replace(/\./g, "\\.")).join("|");
  return text.replace(new RegExp(`(?<![\\d.])(${alt})(?![\\d.])`, "g"), (m) => map.get(m) ?? m);
}

/** How long an SSH poll may run in wall-clock terms, however few attempts
 *  that turns out to be. */
const SSH_POLL_DEADLINE_MS = 6 * 60_000;

/** How long a node gets to come back on its own before a poll starts
 *  issuing the start command itself: long enough for a re-created
 *  container's entrypoint (image pull, tailscale join) to reach the
 *  binary, short enough that a node nothing restarted isn't left idle. */
const NODE_NUDGE_GRACE_MS = 60_000;

/**
 * Poll until `probe` returns true, bounded by attempts AND by the clock.
 *
 * An attempt count is not a bound on its own. A probe against a live box
 * fails in milliseconds; a probe against an endpoint that completes a TCP
 * handshake and then goes quiet burns the ssh readyTimeout and then the
 * lease-shell fallback's own — some forty seconds — so "36 attempts, 5s
 * apart" reads as three minutes and runs for twenty-five. Observed live:
 * a reset's resume poll sat for ten minutes against two forwarded ports
 * that had moved, while the chain it was waiting for was producing blocks
 * the whole time.
 */
export async function pollSsh(
  ctx: StepCtx,
  probe: (attempt: number) => Promise<boolean>,
  opts: { attempts?: number; everyMs?: number; deadlineMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 36;
  const everyMs = opts.everyMs ?? 5000;
  const until = Date.now() + (opts.deadlineMs ?? SSH_POLL_DEADLINE_MS);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      if (Date.now() >= until) break;
      await ctx.services.sleep(everyMs);
    }
    try {
      if (await probe(i)) return true;
    } catch {
      // unreachable, mid-restart, or refusing connections: the loop is the retry
    }
  }
  return false;
}

/**
 * Re-read where each component answers SSH from its provider, correcting
 * the rows that moved.
 *
 * The endpoint on a row is a provider-assigned forwarded port for 2222, and
 * a re-created container comes back on a different one. Any step that
 * restarts containers therefore invalidates its own way back in, and has to
 * re-read before it can reach anything — otherwise its next poll spends its
 * whole budget on a port nothing listens on. The repair op's `endpoints`
 * pass is this same read, run on demand.
 *
 * A provider that cannot be read leaves its row alone: an unreachable
 * provider says nothing about whether the recorded endpoint still works.
 */
export async function refreshSshEndpoints(
  ctx: StepCtx,
  rows: FleetComponentRow[],
): Promise<{ corrected: string[]; unreadable: string[] }> {
  const cert = loadCert(ctx);
  const corrected: string[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    // no recorded endpoint = the component runs no sshd; nothing to fix
    if (row.state !== "active" || !row.ssh_host || !row.host_uri) continue;
    let ssh: { host: string; port: number };
    try {
      const status = await ctx.services.provider.leaseStatus(cert, row.host_uri, row.dseq, 1, 1);
      ssh = extractForwardedPort(status, 2222);
    } catch (e) {
      unreadable.push(`${row.key} (${String(e).slice(0, 60)})`);
      continue;
    }
    if (ssh.host === row.ssh_host && ssh.port === row.ssh_port) continue;
    ctx.log(
      `${row.key}: SSH endpoint was ${row.ssh_host}:${row.ssh_port}, provider now forwards ` +
        `${ssh.host}:${ssh.port}`,
    );
    ctx.db.updateComponentRuntime(ctx.launchId, row.key, { ssh_host: ssh.host, ssh_port: ssh.port });
    corrected.push(row.key);
  }
  return { corrected, unreadable };
}

/** Times a placement moves off a provider whose ingress served nothing, before it pauses. */
const MAX_INGRESS_REPLACEMENTS = 2;

/** Whether a placement's provider is at fault (ingressVerdict, forwardedVerdict). */
export interface PlacementVerdict {
  broken: boolean;
  detail: string;
  provider?: string;
}

/**
 * Re-place an op's placement whose provider serves nothing (its ingress, or
 * its forwarded ports): put the provider on the op's and the wallet's avoid
 * lists, close the deployment (the escrow comes back), and run the op's
 * steps from `deploy` to `to` again for fresh bids (RerunFrom). At most
 * MAX_INGRESS_REPLACEMENTS times. Returns what `judge` found when it does
 * not re-place. Re-entrant: a re-placement under way (op params
 * `replacing`) skips the judging and goes on with its close.
 */
export async function replacePlacement(
  ctx: StepCtx,
  o: {
    opId: number;
    key: string;
    p: (s: string) => string;
    steps: StepDef[];
    deploy: { dseq: string };
    lease: { provider?: string };
    to: string;
    judge: () => Promise<PlacementVerdict>;
  },
): Promise<string | undefined> {
  const { opId, key, p, deploy, lease } = o;
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const live = (): RelaunchParams =>
    JSON.parse(ctx.db.listFleetOps(ctx.launchId).find((x) => x.id === opId)?.params_json ?? "{}") as RelaunchParams;
  let params = live();
  if (params.replacing?.dseq !== deploy.dseq) {
    const verdict = await o.judge();
    if (!verdict.broken) return verdict.detail ? `Checked past DNS: ${verdict.detail}` : undefined;
    const done = params.ingressReplacements ?? 0;
    if (done >= MAX_INGRESS_REPLACEMENTS || !lease.provider) {
      return `${verdict.detail}; already moved ${done} time(s) for this, so it is left to you (relaunch it, or pick a bid by hand)`;
    }
    ctx.log(`${key}: ${verdict.detail}; moving it off ${verdict.provider ?? lease.provider} (attempt ${done + 1} of ${MAX_INGRESS_REPLACEMENTS})`);
    ctx.db.setProviderPref(owner, lease.provider, "avoid", verdict.provider ?? null);
    params = {
      ...params,
      replacing: { dseq: deploy.dseq, provider: lease.provider },
      avoidProviders: [...new Set([...(params.avoidProviders ?? []), lease.provider])],
    };
    ctx.db.updateFleetOpParams(opId, params);
  }
  // close it (a signature; the step resumes here), then place again
  const info = await ctx.services.api.deploymentInfo(owner, deploy.dseq).catch(() => undefined);
  if (info?.state === "active") {
    await ctx.requireTx(p(`replace-close:${deploy.dseq}`), [
      { typeUrl: TypeUrl.CloseDeployment, value: { id: { owner, dseq: deploy.dseq } } },
    ]);
  }
  const { replacing: _r, bidChoice: _b, offeredBids: _o, ...rest } = params;
  ctx.db.updateFleetOpParams(opId, { ...rest, ingressReplacements: (params.ingressReplacements ?? 0) + 1 });
  ctx.db.deletePendingTx(ctx.launchId, p("deploy"));
  ctx.db.deletePendingTx(ctx.launchId, p("lease"));
  clearPin(ctx, `op${opId}-dseq`);
  const from = o.steps.findIndex((st) => st.name === p("deploy"));
  const to = o.steps.findIndex((st) => st.name === o.to);
  throw new RerunFrom(
    o.steps.slice(from, to + 1).map((st) => st.name),
    `${key}: deployment ${deploy.dseq} closed, its provider served nothing`,
  );
}

/** Polls of the double-sign window with no new block before it calls the chain halted. */
const HALT_POLLS = 24;

/**
 * §5 double-sign safety window for a relaunched softsign validator: its
 * fresh volume carries the launch-time priv_validator_state, so it must not
 * sign until the chain is past every height the old node may have signed.
 * That is DOUBLE_SIGN_WINDOW blocks past the height measured at close (or,
 * when the sentry did not answer then, measured now: later is only safer).
 *
 * A chain that cannot advance without this validator (a single-validator
 * fleet, or one holding a third of the power) never clears the window, and
 * the node used to be left unbooted for good. A halted chain is let through
 * only when the network holds no votes at the stuck height: a vote the old
 * node cast there and someone kept is exactly what a fresh vote would
 * conflict with. Votes are kept in memory, so none means none to conflict.
 */
async function doubleSignWindow(
  ctx: StepCtx,
  stepName: string,
  key: string,
  close: { baselineHeight?: number; baselineMissed?: boolean },
): Promise<void> {
  let baseline = close.baselineHeight;
  // no height at close with sentries in the fleet means none answered
  // (or none was active, e.g. one mid-relaunch), not that there are none:
  // measure now, and never skip the window for it
  const hasSentries = ctx.db.listFleetComponents(ctx.launchId).some((c) => c.key.startsWith("sentry-"));
  if (baseline === undefined && (close.baselineMissed || hasSentries)) {
    for (let i = 0; i < 12 && baseline === undefined; i++) {
      if (i > 0) await ctx.services.sleep(5000);
      baseline = await sentryRpcHeight(ctx, key).catch(() => undefined);
    }
    if (baseline === undefined) {
      throw new AwaitUser(
        stepName,
        `no active sentry's RPC answers, so the launcher cannot tell how far the chain is past the last height ` +
          `the old ${key} may have signed; booting it now could double-sign. Bring a sentry back ` +
          "(relaunch it if its provider is gone), then resume.",
      );
    }
  }
  if (baseline === undefined) return; // no sentry in this fleet at all, so no height to read
  let last = -1;
  let still = 0;
  for (let i = 0; i < 120; i++) {
    const height = await sentryRpcHeight(ctx, key).catch(() => undefined);
    if (height !== undefined && height >= baseline + DOUBLE_SIGN_WINDOW) return;
    if (height !== undefined && height === last) still++;
    else still = 0;
    if (height !== undefined) last = height;
    if (still >= HALT_POLLS) {
      const votes = await stuckHeightVotes(ctx, key);
      if (votes === 0) {
        ctx.log(
          `${key}: the chain is halted at ${last} without this validator and the network holds no ` +
            "votes for the next height, so nothing the old node signed can conflict: booting it",
        );
        return;
      }
      throw new AwaitUser(
        stepName,
        `the chain is halted at ${last}, and it cannot advance until ${key} signs again, but ` +
          (votes === null
            ? "the launcher could not read the sentry's consensus state"
            : `the network still holds ${votes} vote(s) for height ${last + 1}`) +
          `. One of them may be the old ${key}'s, and a fresh vote beside it would be a double-sign. ` +
          "If the old node can be reached, resize-style recovery is safer (its signing state moves " +
          "with it). Otherwise resume once the sentry shows no votes at the stuck height.",
      );
    }
    await ctx.services.sleep(5000);
  }
  throw new Error("double-sign window never cleared: the chain advanced too slowly");
}

/**
 * Prevotes plus precommits by validator `key` the sentry holds for the
 * height in progress, summed over rounds; null when its consensus state
 * cannot be read.
 */
async function stuckHeightVotes(ctx: StepCtx, key: string): Promise<number | null> {
  const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key.startsWith("sentry-") && c.state === "active" && c.key !== key,
  );
  if (!sentry) return null;
  const pubkey = ctx.output<{ consensusPubkeys?: Record<string, string> }>("generate-keys")?.consensusPubkeys?.[key];
  try {
    const url = await nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
    return countConsensusVotes(await ctx.services.rpc.getText(`${url}/consensus_state`), pubkey ? consensusAddress(pubkey) : undefined);
  } catch {
    return null;
  }
}

/** Hex consensus address (upper case) of a base64 ed25519 consensus pubkey. */
export function consensusAddress(pubkeyBase64: string): string {
  return crypto.createHash("sha256").update(Buffer.from(pubkeyBase64, "base64")).digest("hex").slice(0, 40).toUpperCase();
}

/**
 * Votes in a CometBFT /consensus_state answer. With `address` (hex
 * consensus address), only that validator's: each vote string reads
 * "Vote{<index>:<first 6 address bytes> <height>/<round>/...}", and only a
 * vote by the same validator can conflict with a fresh one, so the other
 * validators' votes on a stalled height must not hold the node back. When
 * the answer carries no vote strings, every vote in the bit arrays counts
 * ("BA{1:x} 100/100 = 1.00"): over-counting only pauses, never double-signs.
 */
export function countConsensusVotes(body: string, address?: string): number | null {
  const json = JSON.parse(body) as {
    result?: {
      round_state?: {
        height_vote_set?: {
          prevotes?: string[];
          precommits?: string[];
          prevotes_bit_array?: string;
          precommits_bit_array?: string;
        }[];
      };
    };
  };
  const rounds = json.result?.round_state?.height_vote_set;
  if (!Array.isArray(rounds)) return null;
  const fingerprint = address?.slice(0, 12).toUpperCase();
  let votes = 0;
  for (const r of rounds) {
    for (const [strings, bits] of [
      [r.prevotes, r.prevotes_bit_array],
      [r.precommits, r.precommits_bit_array],
    ] as const) {
      if (fingerprint && Array.isArray(strings)) {
        votes += strings.filter((v) => /^Vote\{\d+:([0-9A-Fa-f]+) /.exec(v)?.[1]?.toUpperCase() === fingerprint).length;
        continue;
      }
      // the bit array itself: one x per validator that voted
      const m = /\{\d+:([x_]*)\}/.exec(bits ?? "");
      if (m) votes += [...m[1]!].filter((c) => c === "x").length;
    }
  }
  return votes;
}

export async function sentryRpcHeight(ctx: StepCtx, excludeKey?: string): Promise<number | undefined> {
  const sentry = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key.startsWith("sentry-") && c.state === "active" && c.key !== excludeKey,
  );
  if (!sentry) return undefined;
  const url = await nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  return (await ctx.services.rpc.status(url)).latestBlockHeight;
}

/**
 * Height a node reports for ITSELF, over paths that do not run through its
 * SSH endpoint.
 *
 * Two readings, cheapest first: the forwarded CometBFT RPC where the
 * component exposes one, and otherwise the container's own localhost RPC
 * through the provider's lease-shell — the path console-air's shell uses,
 * which keeps answering when a forwarded port has moved. (Validators expose
 * no RPC port, so for them the second reading is the only one.)
 *
 * Either answer is proof this node is up and past genesis, which is what a
 * restart wait is actually asking. SSH silence answers a different question
 * — whether the launcher can still reach the node's shell — and standing in
 * for this one is what turned a moved forwarded port into a failed op.
 */
export async function nodeSelfHeight(
  ctx: StepCtx,
  row: FleetComponentRow,
): Promise<number | undefined> {
  try {
    const url = await nodeRpcUrl(ctx, row.host_uri, row.dseq);
    const h = (await ctx.services.rpc.status(url)).latestBlockHeight;
    if (h > 0) return h;
  } catch {
    // no forwarded RPC on this component, or the port moved with the restart
  }
  try {
    const cert = loadCert(ctx);
    const r = await ctx.services.provider.shellExec(
      { certPem: cert.certPem, keyPem: cert.keyPem },
      row.host_uri,
      row.dseq,
      1,
      1,
      "sparkdreamd",
      ["sh", "-c", "wget -qO- http://127.0.0.1:26657/status 2>/dev/null"],
    );
    const h = Number(/latest_block_height."?:?"?(\d+)/.exec(r.stdout)?.[1]);
    return Number.isFinite(h) && h > 0 ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a freshly swapped node binary cannot run on this chain, read from its
 * log, or undefined when the log shows no such failure.
 *
 * These are the startup failures no amount of waiting fixes: the release
 * cannot read the chain's stored state (a proto field reused with a new type
 * and no migration: devnet 2026-09-30, `wrong wireType = 0 for field
 * MaxTipsSentPerEpoch`), replays it to a different result, or expects a
 * registered upgrade the chain has not reached. Each surfaces while comet
 * replays blocks into the app at boot, before the node serves RPC.
 */
export function incompatibleReleaseReason(logs: string): string | undefined {
  const binaryEarly = /BINARY UPDATED BEFORE TRIGGER! UPGRADE "([^"]+)"/.exec(logs);
  if (binaryEarly) {
    return (
      `this release expects the "${binaryEarly[1]}" upgrade, which the chain has not reached ` +
      "(install it with a halt-height upgrade at that upgrade's height instead)"
    );
  }
  const needed = /UPGRADE "([^"]+)" NEEDED at height/.exec(logs);
  if (needed) {
    return `the chain is waiting for the "${needed[1]}" upgrade, which this release does not carry`;
  }
  const handshake = /error during handshake: ([^\n]*)/.exec(logs);
  if (!handshake) return undefined;
  const detail = handshake[1]!.replace(/\x1b\[[0-9;]*m/g, "").replace(/"\s.*$/, "").trim();
  if (/wireType|encoding error|decode|unmarshal|proto:/i.test(detail)) {
    return (
      "this release cannot read the chain's stored state: its data format changed without " +
      `a migration (${detail.slice(0, 200)})`
    );
  }
  if (/AppHash|app hash|app_hash/i.test(detail)) {
    return (
      "this release computes different results from the chain's history (a state-machine " +
      `change without an upgrade handler) (${detail.slice(0, 200)})`
    );
  }
  return `the node cannot start on the chain's data with this release (${detail.slice(0, 200)})`;
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
 * Read from the container's own log stream, because the halt leaves nothing
 * else to read. cosmos refuses the halt-height block inside FinalizeBlock, so
 * the committed head stops at H-1: an RPC gate of `height >= H` is one
 * nothing can ever satisfy, and comet tears its consensus routine down around
 * the refusal, so the height it does serve stops moving whether or not the
 * halt is why. The log line is the only statement of the halt itself, and the
 * one the operator would read too.
 *
 * The process does not exit (2026-08-25, devnet at 25000): comet logs
 * CONSENSUS FAILURE, stops the WAL, and leaves the container up and quiet,
 * p2p still running. So SSH keeps answering — halt-clear lands on the first
 * try — and the halt line stays in the tail rather than scrolling past on a
 * restart. It can still scroll out on a node that keeps chattering (pex on a
 * sentry), which is what the caller's stickiness is for.
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
  /** Why the op is asking when it did not ask for a pick up front; the
   *  operator may then also leave the choice to the policy (AUTO_BID). */
  reason?: string,
): Promise<Bid> {
  const op = ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId);
  const params = JSON.parse(op?.params_json ?? "{}") as RelaunchParams;
  const choice = params.bidChoice;
  if (choice && choice.dseq === dseq && choice.provider === AUTO_BID) {
    if (decision.chosen) {
      ctx.log(`${key}: leasing the policy's pick, ${decision.chosen.bid.id.provider}, as asked`);
      return decision.chosen;
    }
    ctx.log(`${key}: the policy accepts none of the bids on offer now — pick one`);
  } else if (choice && choice.dseq === dseq) {
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
  ctx.db.updateFleetOpParams(opId, {
    ...rest,
    offeredBids: { dseq, bids: offers, ...(reason ? { reason } : {}) },
  });
  ctx.log(`${key}: ${offers.length} bid(s) on offer, waiting for a manual pick`);
  throw new AwaitUser(
    stepName,
    (reason
      ? `${key}: ${reason}. Lease the selection policy's pick or a bid of your own: `
      : `${key}: pick which bid to lease — `) +
      `the fleet panel lists the ${offers.length} bid(s) on ` +
      "this deployment. Bids close a few minutes after they arrive, so if the lease then " +
      "fails, abandon this operation and relaunch to draw a fresh set.",
  );
}

export interface AddComponentParams {
  key: ComponentKey;
  /** Continues the row's move count when a closed component comes back. */
  generation: number;
  /** The wallet's avoided providers at request time (relaunch takes the same). */
  avoidProviders?: string[];
  /** The operator picks the bid: the lease step parks with every bid (as a relaunch's pick bid). */
  manualBid?: boolean;
}

/** Open what the current spec needs on one of this fleet's sentries — plus
 *  gRPC when another fleet's relayer dials it. Returns whether it changed. */
function ensureSentryServes(ctx: StepCtx, spec: LaunchSpec, key: string, target: SshTarget): Promise<boolean> {
  return patchSentryAppToml(ctx, key, target, sentryServe(spec, relayedBy(ctx.db, ctx.launchId).length > 0));
}

/**
 * Add a service component to a running fleet (§5 day-2): render its SDL,
 * open what it needs on the sentries, then place it exactly as a relaunch
 * places a component — fresh deployment, bids, lease, manifest, health gate —
 * minus the close, since there is nothing to close. requestAddComponent has
 * already enabled it in the stored spec.
 */
export function addComponentSteps(opId: number, params: AddComponentParams, spec: LaunchSpec): StepDef[] {
  const { key } = params;
  const p = (s: string) => `op${opId}:${s}`;
  const steps: StepDef[] = [];

  steps.push({
    name: p("render"),
    async run(ctx) {
      const component = serviceComponents(spec).find((c) => c.key === key);
      if (!component) throw new Error(`${key} is not enabled in the spec`);
      const keys = ctx.output<GenerateKeysOutput>("generate-keys");
      if (!keys) throw new Error("generate-keys output missing");
      // a bridge added after launch: its operator key has to exist before
      // the SDL that carries its mnemonic can render
      if ((key === "mastodon" && spec.topology.components.mastodon?.bridge?.enabled) || key === "bridge") {
        await ensureBridgeOperatorKey(ctx.dirs.secrets, ctx.dirs.node("val-0"));
      }
      renderComponentSdl({
        spec,
        peerChains: sisterChainApis(ctx.db, ctx.launchId, spec),
        component,
        sshPublicKey: keys.sshPublicKey,
        outPath: sdlPathFor(ctx, key),
        placeholder,
        peerTailnetIp: (peer) => peerRow(ctx.db, ctx.launchId, peer)?.tailnet_ip ?? undefined,
        secretsDir: ctx.dirs.secrets,
        resolveFleet: fleetResolver({ ...ctx, spec }),
        launchId: ctx.launchId,
      });
      // the row exists from here on so the fleet shows the component while
      // it is being placed; relaunch's manifest step fills in the placement
      ctx.db.upsertFleetComponent({
        launch_id: ctx.launchId,
        key,
        dseq: "0",
        provider: "",
        host_uri: "",
        price: "0",
        state: "relaunching",
        image: component.image,
      });
      ctx.db.setComponentState(ctx.launchId, key, "relaunching");
      return {};
    },
  });

  // a kind that reads the sentries' LCD, on a fleet launched without one:
  // open it on every live sentry (restarting only the ones that changed)
  if (COMPONENT_KINDS[key].needsLcd) {
    steps.push({
      name: p("sentries"),
      async run(ctx) {
        const changed: string[] = [];
        const rows = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
          (c) => c.key.startsWith("sentry-") && c.state === "active",
        );
        for (const row of rows) {
          const target = rowTarget(ctx, row);
          if (await ensureSentryServes(ctx, spec, row.key, target)) {
            await restartNode(ctx.services.ssh, target);
            changed.push(row.key);
          }
        }
        return { restarted: changed };
      },
    });
  }

  steps.push(
    ...relaunchSteps(
      opId,
      {
        key,
        generation: params.generation,
        ...(params.avoidProviders?.length ? { avoidProviders: params.avoidProviders } : {}),
        ...(params.manualBid ? { manualBid: true } : {}),
      },
      spec,
    ).filter(
      (s) => s.name !== p("close"),
    ),
  );
  return steps;
}

/**
 * Link (or re-link) the fleet's relayer to its chains: configure and key it,
 * wait for funding, open or reuse every path's channel, start Hermes. The
 * trailing step of adding a relayer, and its own op after anything that
 * wipes IBC state — a chain reset here or on a counterparty, or a relaunched
 * relayer's fresh volume. Marks the op done itself, since it may follow
 * steps that would otherwise have done so.
 */
export function relinkSteps(opId: number, spec: LaunchSpec): StepDef[] {
  const link = `op${opId}:link-relayer`;
  const peers = `op${opId}:link-peers`;
  return [
    { name: link, run: (ctx) => linkRelayer(ctx, link, spec) },
    {
      name: peers,
      async run(ctx) {
        const out = await linkFederationPeers(ctx, peers, spec);
        ctx.db.setFleetOpStatus(opId, "done");
        return out;
      },
    },
  ];
}

/**
 * Open this fleet's sentry-0 gRPC to relayers on other meshes ("public-grpc"
 * op). Earlier builds queued it from another wallet's relayer for an
 * in-place deployment update, which providers refuse (a lease's ports are
 * fixed when it is created); it now only prepares the sentry and records
 * the endpoint when the lease already forwards gRPC.
 */
export function publicGrpcSteps(opId: number): StepDef[] {
  const name = `op${opId}:public-grpc`;
  return [
    {
      name,
      async run(ctx) {
        // Never a pause: a gRPC port comes with a new deployment only, so
        // what this op cannot do is a relaunch of sentry-0, which runs
        // after it (ops run in order) and must not wait behind it
        let relaunch: string | undefined;
        const ep = await openPublicGrpc(ctx, ctx.launchId, (msg) => {
          relaunch = msg;
          throw new RelaunchNeeded();
        }).catch((e) => {
          if (e instanceof RelaunchNeeded) return undefined;
          throw e;
        });
        if (relaunch) ctx.log(relaunch);
        ctx.db.setFleetOpStatus(opId, "done");
        return ep ?? { relaunchNeeded: true };
      },
    },
  ];
}

class RelaunchNeeded extends Error {}

/** Params of a "relayer-paths" op: the new paths are already in the spec. */
export interface RelayerPathsParams {
  /** The set of fleet counterparties changed, so the relayer's mesh tunnels
   *  (its deployment's TS_TUNNEL env) must change before it can link. */
  retunnel: boolean;
}

/**
 * Change a running relayer's paths (requestRelayerPaths stored them): when
 * the fleet counterparties changed, rewrite the relayer's tunnel env in
 * place (one update tx, manifest re-sent, the container restarts on its
 * volume, keys and channels kept), then link as a relink does. Linking
 * opens the new paths' channels, reuses the open ones, and pins Hermes'
 * packet filter to exactly the paths now in the spec. A dropped path's
 * channel stays open on chain; Hermes just stops relaying it.
 */
export function relayerPathsSteps(opId: number, params: RelayerPathsParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const steps: StepDef[] = [];
  if (params.retunnel) {
    steps.push({
      name: p("tunnels"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const row = componentRow(ctx, "relayer");
        const tunnels = descriptorFor("relayer")!.tunnels(spec);
        const env: string[] = [];
        for (const [i, t] of tunnels.entries()) {
          const peer = peerRow(ctx.db, ctx.launchId, t.peer);
          if (!peer?.tailnet_ip) throw new Error(`relayer: ${t.peer} has no recorded tailnet IP to tunnel to`);
          env.push(`TS_TUNNEL_${i + 1}=${t.local}:${peer.tailnet_ip}:${t.remote}`);
        }
        const sdlPath = sdlPathFor(ctx, "relayer");
        const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
        const svc = doc.services?.relayer;
        if (!svc) throw new Error("relayer.yaml has no services.relayer");
        svc.env = [...((svc.env ?? []) as string[]).filter((e) => !e.startsWith("TS_TUNNEL_")), ...env];
        fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, "relayer.manifest.json"), artifacts.manifestJson);
        // convergent: a re-run after the signature finds the version on
        // chain and only re-sends the manifest (unconditionally, as mesh-env
        // does: skipping it there is how an update lands unapplied)
        const wantHash = Buffer.from(artifacts.hash).toString("base64");
        const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
        if (onChain?.hash !== wantHash) {
          await ctx.requireTx(p("tunnels"), [
            { typeUrl: TypeUrl.UpdateDeployment, value: { id: { owner, dseq: row.dseq }, hash: wantHash } },
          ]);
        } else {
          ctx.db.deletePendingTx(ctx.launchId, p("tunnels"));
        }
        await ctx.services.provider.sendManifest(loadCert(ctx), row.host_uri, row.dseq, artifacts.manifestJson);
        for (const e of env) ctx.log(`relayer: ${e}`);
        // the update restarts the container: link once it answers again
        const target = rowTarget(ctx, row);
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          up = await ctx.services.ssh
            .exec(target, "true", { quick: true })
            .then(() => true)
            .catch(() => false);
        }
        if (!up) throw new Error("relayer: container never came back after its tunnel update");
        return { tunnels: env };
      },
    });
  }
  steps.push(...relinkSteps(opId, spec));
  return steps;
}

/** Params of a "mastodon-resize" op: the relaunch's, plus the new size and,
 *  when the move turns wallet sign-in on or off (a service more or less),
 *  its new settings. */
export interface MastodonResizeParams extends RelaunchParams {
  size: "small" | "standard";
  walletLogin?: Record<string, unknown>;
}

/**
 * Move the Mastodon instance to a new deployment: a new size, or wallet
 * sign-in turned on or off (the login service added or dropped). Akash fixes
 * a deployment's resources, so either is a new deployment, and the data has
 * to move with it. Backup
 * (database and uploaded media, over lease-shell, kept encrypted) → render
 * the SDL at the new size → the relaunch (close, deploy, lease, manifest) →
 * restore into the new deployment before anything configures it → the
 * domain gate and Mastodon's configure steps (the bridge's token, peer and
 * session). The instance is down from the close until the restore's restart.
 * The current provider is preferred, not avoided: staying on it keeps the
 * domains' DNS target.
 */
export function mastodonResizeSteps(opId: number, params: MastodonResizeParams, spec: LaunchSpec): StepDef[] {
  const key = "mastodon";
  const p = (s: string) => `op${opId}:${s}`;
  const moved = {
    size: params.size,
    ...(params.walletLogin ? { walletLogin: params.walletLogin } : {}),
  };
  const sized = withDefaults({
    ...spec,
    topology: {
      ...spec.topology,
      components: { ...spec.topology.components, mastodon: { ...spec.topology.components.mastodon!, ...moved } },
    },
  } as unknown as LaunchSpecInput);
  const relaunch = relaunchSteps(opId, params, sized);
  const at = relaunch.findIndex((s) => s.name === p("manifest"));
  if (at < 0) throw new Error("relaunch steps have no manifest step");
  return [
    { name: p("backup"), run: (ctx) => backupMastodon(ctx, p("backup")) },
    {
      name: p("render"),
      async run(ctx) {
        const component = serviceComponents(sized).find((c) => c.key === key);
        if (!component) throw new Error("mastodon is not enabled in the spec");
        const keys = ctx.output<GenerateKeysOutput>("generate-keys");
        if (!keys) throw new Error("generate-keys output missing");
        renderComponentSdl({
          spec: sized,
          peerChains: sisterChainApis(ctx.db, ctx.launchId, sized),
          component,
          sshPublicKey: keys.sshPublicKey,
          outPath: sdlPathFor(ctx, key),
          placeholder,
          peerTailnetIp: (peer) => peerRow(ctx.db, ctx.launchId, peer)?.tailnet_ip ?? undefined,
          secretsDir: ctx.dirs.secrets,
          resolveFleet: fleetResolver({ ...ctx, spec: sized }),
          launchId: ctx.launchId,
        });
        return moved;
      },
    },
    ...relaunch.slice(0, at + 1),
    {
      name: p("restore"),
      async run(ctx) {
        const out = await restoreMastodon(ctx, p("restore"), ctx.output<MastodonBackup>(p("backup"))!);
        // the new deployment holds the data at the new size (and sign-in
        // setting): from here on the spec renders it that way (upgrades, a
        // later relaunch, the chain sync configure runs next)
        const launch = ctx.db.getLaunch(ctx.launchId)!;
        const stored = JSON.parse(launch.spec_json);
        Object.assign(stored.topology.components.mastodon, moved);
        ctx.db.setLaunchSpec(ctx.launchId, JSON.stringify(stored));
        return out;
      },
    },
    ...relaunch.slice(at + 1),
  ];
}

/** Params of a "reconfigure" op: the components whose chain setup to redo. */
export interface ReconfigureParams {
  keys: string[];
}

/**
 * Redo the chain-side setup of components that stay where they are (their
 * kinds' configureSteps: Mastodon's peer, bridge bond and session, the
 * verifier's bond and session), on their existing deployments. Queued behind
 * a chain reset, which wipes that state but leaves the deployments, their
 * volumes and their data alone; a relaunch would move them and lose it.
 */
export function reconfigureSteps(opId: number, params: ReconfigureParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const steps = params.keys.flatMap((key) => descriptorFor(key)?.configureSteps?.(p, spec) ?? []);
  return [
    ...steps,
    {
      name: p("reconfigured"),
      async run(ctx) {
        ctx.db.setFleetOpStatus(opId, "done");
        return { components: params.keys };
      },
    },
  ];
}

/** Params of a "sessions" op: the roles to rotate even if their key holds. */
export interface SessionsParams {
  force?: SessionRole[];
}

/**
 * Renew the daemons' session keys (§5 session keys): what is due, what the
 * chain lost (a reset), what `force` names; retire the grants of daemons
 * that are gone. Local signing only, so the monitor starts it unattended.
 */
export function sessionsSteps(opId: number, params: SessionsParams, spec: LaunchSpec): StepDef[] {
  const name = `op${opId}:sessions`;
  return [
    {
      name,
      async run(ctx) {
        const out = await reconcileSessions(ctx, spec, params.force ?? []);
        ctx.db.setFleetOpStatus(opId, "done");
        return out;
      },
    },
  ];
}

/** Relaunch: close → fresh deploy on a new provider → rewire → guarded start.
 *  Stateless components (§5): no volume, keys, peers, or double-sign risk —
 *  the rewiring and guarded-start steps are replaced by an HTTP health gate. */
/**
 * Fill a fresh node volume from the node's launch bundle (same node key, so
 * the same node ID, §5) and converge what the bundle predates: the sentry's
 * served endpoints, the gas price, and on a join fleet the state-sync trust
 * anchor. The relaunch's configure step and a node resize's staging both
 * start a node this way.
 */
/**
 * A sentry must accept several peers from one IP: under userspace tailscale
 * every mesh peer reaches it from 127.0.0.1 (its validator's link is a local
 * tunnel too), and with allow_duplicate_ip = false CometBFT refuses all but
 * the first, closing the rest before the handshake ("secret conn failed:
 * EOF" on the dialer). Seen live 2026-10-04: devnet's sentry-0 kept only its
 * val-0 link and refused sentry-1 and a resize's staged copy. Sets it in the
 * node's config.toml; with `restart`, restarts the node when it changed
 * (the setting is read at start). Returns whether it changed.
 */
export async function acceptMeshPeers(ctx: StepCtx, target: SshTarget, opts: { restart: boolean }): Promise<boolean> {
  const config = `${NODE_HOME}/config/config.toml`;
  const out = await ctx.services.ssh.exec(
    target,
    `grep -q '^allow_duplicate_ip = true' ${config} && echo ok || ` +
      `{ sed -i 's|^allow_duplicate_ip = .*|allow_duplicate_ip = true|' ${config} && echo changed; }`,
  );
  const changed = out.stdout.includes("changed");
  if (changed && opts.restart) await restartNode(ctx.services.ssh, target);
  return changed;
}

export async function prepareNodeHome(
  ctx: StepCtx,
  spec: LaunchSpec,
  key: string,
  target: SshTarget,
  opts: { withoutSigningKey?: boolean } = {},
): Promise<void> {
  const isValidator = key.startsWith("val-");
  const valIndex = isValidator ? Number(key.split("-")[1]) : -1;
  // upload node data (same node key → same node ID, §5) — new volume
  const bundle = path.join(ctx.dirs.bundles, `${key}.tgz`);
  await ctx.services.ssh.upload(target, bundle, "/tmp/node-data.tgz");
  await ctx.services.ssh.exec(
    target,
    `mkdir -p ${NODE_HOME} && tar xzf /tmp/node-data.tgz -C ${NODE_HOME}` +
      // a softsign bundle carries the consensus key: a node that must not
      // sign yet gets it only when it takes over (node resize)
      (opts.withoutSigningKey ? ` && rm -f ${NODE_HOME}/config/priv_validator_key.json /tmp/node-data.tgz` : "") +
      ` && touch ${NODE_HOME}/.node-data-uploaded`,
  );
  // the bundle was rendered at launch; a component added since may need
  // the sentry to open more (its LCD) — converge on the current spec
  // before the node first starts
  if (key.startsWith("sentry-")) {
    await ensureSentryServes(ctx, spec, key, target);
    // a bundle packed before sentries took duplicate IPs (every mesh peer
    // arrives from 127.0.0.1) would refuse all but one peer
    await acceptMeshPeers(ctx, target, { restart: false });
  }
  // the bundle carries the app.toml rendered at launch: a gas price
  // corrected since (or hand-edited on the old node) would otherwise come
  // back with the relaunch, as a 25000 one did on 2026-10-02
  await patchNodeAppToml(ctx, key, target, { minGasPrices: nodeMinGasPrices(spec) });
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
  // the fleet's latest chain-data backup, when it has one: the node starts
  // from there instead of replaying the chain from block 1 (or state-syncing)
  await restoreChainData(ctx, spec, key, target);
}

/**
 * Wire a chain node that has just moved to a new deployment into the fleet:
 * its advertised address (sentries), its tailnet IP on the row and in the
 * tmkms checklist, its own peers and tunnels, and every counterpart that
 * named its old address. Returns the node's new tailnet IP.
 */
export async function wireMovedNode(
  ctx: StepCtx,
  spec: LaunchSpec,
  key: string,
  target: SshTarget,
  moved: {
    deploy: { dseq: string };
    lease: { hostUri: string; gseq: number; oseq: number };
    oldTailnetIp: string | null;
    /** a node new to the fleet (add-sentry): its peers gain an entry for
     *  it, where a moved node's old address is rewritten */
    added?: boolean;
  },
): Promise<{ tailnetIp: string }> {
  const isValidator = key.startsWith("val-");
  const valIndex = isValidator ? Number(key.split("-")[1]) : -1;
  if (!isValidator) {
    // advertise-peers: the new lease assigned a new forwarded 26656 —
    // re-stamp external_address so the sentry keeps advertising a
    // reachable public peer address (§5 "Public peering"). The uploaded
    // node data still carries the OLD lease's address, so on failure it
    // must be blanked, not kept: a stale address gossips a dead endpoint.
    const { deploy, lease } = moved;
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
      `tailscale --socket=${meshSocket(ctx, key)} ip -4 2>/dev/null || true`,
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
  if (isValidator) {
    // own peers: public endpoint first, else the dial-out tunnel to the
    // first sentry. The whole line is written, since the bundle this
    // node booted from may carry any stale form of it.
    await wireValidatorPeers(
      ctx,
      key,
      target,
      (s) => componentRow(ctx, `sentry-${s}`).tailnet_ip,
      (s) => sentryPublicP2p(ctx, s),
    );
    // §5: relaunching a validator re-wires its sentries' tunnels.
    // socatTunnelCmd self-cleans the port, so no manual pkill (which,
    // unanchored, could kill its own sh wrapper mid-command).
    // A sentry that cannot be reached right now (its provider is gone,
    // it is mid-relaunch) is logged and skipped rather than failing the
    // op: this write lands on a DIFFERENT machine, and failing it here
    // stranded the validator at WAIT_FOR_CONFIG so it never started at
    // all, over a link that has its own reconcilers. The sentry's own
    // relaunch re-aims this tunnel when it comes back, and repair's
    // mesh-env pass re-aims it from the SDL meanwhile, which is the same
    // tolerance the sentry branch below already applies to its peers.
    for (const s of topo.validatorSentries[valIndex] ?? []) {
      const sentryRow = componentRow(ctx, `sentry-${s}`);
      const port = tunnelPort(valIndex);
      try {
        await ctx.services.ssh.exec(rowTarget(ctx, sentryRow), socatTunnelCmd(port, ip));
      } catch (e) {
        ctx.log(
          `${key}: sentry-${s} unreachable (${e instanceof Error ? e.message : String(e)}); ` +
            `leaving its tunnel for its own relaunch or repair to re-aim`,
        );
      }
    }
  } else {
    // relaunched sentry: create its own tunnels to current validator IPs
    const sIndex = Number(key.split("-")[1]);
    // A validator with no recorded address (mid-relaunch itself) is skipped:
    // its own relaunch re-aims this sentry's tunnel at it when it comes back.
    for (const v of topo.sentryValidators[sIndex] ?? []) {
      const valIp = componentRow(ctx, `val-${v}`).tailnet_ip;
      if (!valIp) {
        ctx.log(`${key}: val-${v} has no recorded tailnet IP yet; leaving its tunnel for its own relaunch to create`);
        continue;
      }
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
    const dependents = [
      ...(topo.sentryValidators[sIndex] ?? []).map((v) => `val-${v}`),
      ...Array.from({ length: spec.topology.sentries.count }, (_, s2) => `sentry-${s2}`)
        .filter((k) => k !== key),
    ];
    // These writes land on OTHER machines. One that cannot be reached (its
    // provider is gone, it is mid-relaunch) is logged and skipped, as the
    // validator branch above does: failing here stranded the moved sentry
    // unbooted, cutting the validator off for good, over links that have
    // their own reconcilers (the dependent's own relaunch, repair's peers
    // pass).
    for (const depKey of dependents) {
      const row = componentRow(ctx, depKey);
      if (!row.tailnet_ip) continue; // not reachable/placed right now
      try {
        await repatchDependent(row);
      } catch (e) {
        ctx.log(
          `${key}: ${depKey} unreachable (${e instanceof Error ? e.message : String(e)}); ` +
            `leaving its peers for its own relaunch or repair to fix`,
        );
      }
    }
  }
  return { tailnetIp: ip };

  async function repatchDependent(row: FleetComponentRow): Promise<void> {
    if (row.key.startsWith("val-")) {
      // A validator's line is rebuilt whole: it may name this sentry's
      // old PUBLIC endpoint (public-first peering), which a tailnet-IP
      // sed never matches, leaving the validator dialing a closed
      // deployment (seen live 2026-10-02). Its dial-out tunnel's env is
      // re-aimed by the persist step below, whose manifest push
      // restarts it onto that.
      await wireValidatorPeers(
        ctx,
        row.key,
        rowTarget(ctx, row),
        (s) => componentRow(ctx, `sentry-${s}`).tailnet_ip,
        (s) => sentryPublicP2p(ctx, s),
      );
    } else if (moved.oldTailnetIp) {
      await ctx.services.ssh.exec(
        rowTarget(ctx, row),
        `sed -i 's|${moved.oldTailnetIp}|${ip}|g' ${NODE_HOME}/config/config.toml`,
      );
    }
    if (moved.added) {
      // a new sentry: fellow sentries peer with it directly over the mesh,
      // and every node it talks to keeps it as an unconditional peer
      const id = ctx.output<GenerateKeysOutput>("generate-keys")?.nodeIds[key];
      if (!id) throw new Error(`no node id recorded for ${key}`);
      const config = `${NODE_HOME}/config/config.toml`;
      const cmds = [appendTomlListCmd(config, "unconditional_peer_ids", id, id)];
      if (row.key.startsWith("sentry-")) cmds.unshift(appendTomlListCmd(config, "persistent_peers", `${id}@${ip}:26656`, id));
      await ctx.services.ssh.exec(rowTarget(ctx, row), cmds.join(" && "));
    }
    // peer change requires a process restart (documented in the dialog)
    await restartNode(ctx.services.ssh, rowTarget(ctx, row));
  }
}

/**
 * Shell that appends `entry` to a quoted comma list in a TOML file (CometBFT's
 * persistent_peers, unconditional_peer_ids), unless `id` is already in it.
 * Busybox sed: -E, and the empty list ("") is mended after the append.
 */
export function appendTomlListCmd(file: string, field: string, entry: string, id: string): string {
  return (
    `{ grep -Eq '^${field} = ".*${id}' ${file} || ` +
    `sed -i -E 's|^${field} = "(.*)"|${field} = "\\1,${entry}"|; s|^${field} = ",|${field} = "|' ${file}; }`
  );
}

/** The same append on a config.toml held by the launcher (node homes for bundles). */
export function withTomlListEntry(text: string, field: string, entry: string, id: string): string {
  const re = new RegExp(`^${field} = "(.*)"$`, "m");
  const m = re.exec(text);
  if (!m || m[1]!.includes(id)) return text;
  const list = m[1] ? `${m[1]},${entry}` : entry;
  return text.replace(re, `${field} = "${list}"`);
}

/**
 * How a relaunch's steps are bent to another op's use. A node resize deploys
 * its new deployment from a staged SDL beside the running one, and has the
 * component row move to it only at its own cutover.
 */
export interface RelaunchOpts {
  /** The SDL (and manifest file) the new deployment is created from, when it
   *  is not the component's own. */
  staged?: { sdl: (ctx: StepCtx) => string; manifest: (ctx: StepCtx) => string };
  /** Runs at persist right before this component's own manifest push, which
   *  re-creates its container. */
  beforeOwnPush?: (ctx: StepCtx) => Promise<void>;
  /** Bid only on providers serving custom domains even when the staged SDL
   *  carries none yet (its hosts are held back until it takes over). */
  requiresCustomDomain?: (ctx: StepCtx) => boolean | undefined;
  /** Lease this provider's bid when the policy picks it; otherwise park
   *  with every bid and let the operator choose between a bid of their own
   *  and the policy's pick (a resize that would rather stay put). */
  pickUnlessProvider?: string;
}

export function relaunchSteps(
  opId: number,
  params: RelaunchParams,
  spec: LaunchSpec,
  opts: RelaunchOpts = {},
): StepDef[] {
  const { key } = params;
  const p = (s: string) => `op${opId}:${s}`;
  const sdlOf = (ctx: StepCtx) => opts.staged?.sdl(ctx) ?? sdlPathFor(ctx, key);
  const manifestOf = (ctx: StepCtx) =>
    opts.staged?.manifest(ctx) ?? path.join(ctx.dirs.sdl, `${key}.manifest.json`);
  const isValidator = key.startsWith("val-");
  const valIndex = isValidator ? Number(key.split("-")[1]) : -1;
  const stateless = serviceComponents(spec).find((c) => c.key === key);
  // Trailing steps are conditional (a tmkms validator gets a signer gate, a
  // node the explorer dials gets a mesh-client repoint), so which one closes
  // the op out varies — name it once instead of guessing in each step.
  const signerGate = isValidator && spec.security.keyMode === "tmkms";
  // sentry-0 always gets the mesh-client pass: another fleet's relayer may
  // dial it, which only the db (at run time) can tell
  const meshClients = key === "sentry-0" || meshDependents(spec, key).length > 0;
  // sentry-0 serves the fleet's public API/RPC domains: a move lands them on
  // another provider's ingress, so their DNS has to follow
  const publicDomains = key === "sentry-0" ? sentryPublicDomains(spec) : [];
  const lastStep = p(
    publicDomains.length > 0
      ? "public-dns"
      : meshClients
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
      let baselineMissed = false;
      if (isValidator && spec.security.keyMode === "softsign") {
        // §5 double-sign safety: record height before the old node dies. A
        // sentry that does not answer right now (the outage that prompted
        // this relaunch may have hit it too) must not block the close: the
        // start step measures it then instead, which can only be higher,
        // so the window it waits out is at least as long
        try {
          baseline = await sentryRpcHeight(ctx);
        } catch {
          baselineMissed = true;
        }
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
      return {
        closedDseq: row.dseq,
        oldTailnetIp: row.tailnet_ip,
        baselineHeight: baseline,
        ...(baselineMissed ? { baselineMissed: true } : {}),
      };
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

        const sdlPath = sdlOf(ctx);
        let sdl = fs.readFileSync(sdlPath, "utf8");
        sdl = sdl.replace(/TS_AUTHKEY=[^\n"']*/g, `TS_AUTHKEY=${authkey}`);
        // fresh volume must wait for node-data again (no-op for components)
        sdl = gateForFreshVolume(sdl);
        // the peers this component tunnels to may have moved since its env
        // was last written (their own relaunch, a headscale re-key) — deploy
        // with their CURRENT addresses so the fresh container comes up
        // dialing something alive. Nodes get re-wired again at persist; for a
        // stateless component this is the only pass there is.
        const retarget = retargetTunnelEnv(ctx, spec, key, sdl);
        for (const c of retarget.changes) ctx.log(`${key}: tunnel re-aimed at ${c}`);
        fs.writeFileSync(sdlPath, retarget.text);
      }
      const sdlPath = sdlOf(ctx);

      const artifacts = sdlArtifacts(loadSdl(sdlPath));
      const dseq = await pinnedValue(ctx, `op${opId}-dseq`, async () =>
        String(await ctx.services.api.latestBlockHeight()),
      );
      fs.writeFileSync(manifestOf(ctx), artifacts.manifestJson);
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
      return {
        dseq,
        requiredStorageClass: artifacts.requiredStorageClass,
        requiresCustomDomain: artifacts.requiresCustomDomain || Boolean(opts.requiresCustomDomain?.(ctx)),
      };
    },
  });

  steps.push({
    name: p("lease"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const deploy = ctx.output<{
        dseq: string;
        requiredStorageClass?: string;
        requiresCustomDomain?: boolean | undefined;
      }>(p("deploy"))!;
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
      // the op's live params: a re-placement off a broken ingress adds the
      // provider it left after these steps were built
      const live = JSON.parse(ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId)?.params_json ?? "{}") as RelaunchParams;
      // and the wallet's avoid list as it stands now (an op requested before
      // a provider was avoided keeps off it too), except where the component
      // runs: a resize may stay on its own provider
      const current = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find((c) => c.key === key)?.provider;
      const avoidProviders = new Set<string>([
        ...(params.avoidProviders ?? []),
        ...(live.avoidProviders ?? []),
        ...ctx.db.providerPrefs(owner).avoid.filter((pr) => pr !== current || params.avoidProviders?.includes(pr)),
        // a kind that must keep off a host decided elsewhere (the verifier
        // off the Mastodon it checks)
        ...(descriptorFor(key)?.avoidProviders?.({ db: ctx.db, launchId: ctx.launchId, spec, assigned: {} }) ?? []),
      ]);
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
        requiresCustomDomain: deploy.requiresCustomDomain,
        providers,
      });
      // hand-picked: the operator's bid wins over everything above. The
      // relaunch may ask for a pick; the spec may also require one for this
      // component, in which case every placement of it is the operator's.
      // an op that wants one provider asks when it cannot have it, rather
      // than leasing wherever the policy lands
      const stay = opts.pickUnlessProvider;
      const missedStay =
        stay !== undefined && decision.chosen?.bid.id.provider !== stay
          ? open.some((b) => b.bid.id.provider === stay)
            ? `its current provider's bid was passed over (${
                decision.rejected.find((r) => r.provider === stay)?.reason ?? "another bid won"
              })`
            : "its current provider did not bid"
          : undefined;
      const chosen =
        ((params.manualBid ?? manualBidRequired(spec, key)) || missedStay !== undefined) && open.length > 0
          ? await manualBidChoice(ctx, opId, p("lease"), key, deploy.dseq, open, providers, decision, missedStay)
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
      const manifest = fs.readFileSync(manifestOf(ctx), "utf8");
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
      // a component whose image runs no sshd (the frontend) — just wait for
      // the workload
      const wantSsh = !stateless || stateless.ssh;
      const status = await waitLeaseStatus(
        ctx,
        cert,
        lease.hostUri,
        deploy.dseq,
        lease.gseq,
        lease.oseq,
        wantSsh ? { forwardedPort: 2222 } : {},
      );
      // a staged deployment is not the component yet: the row keeps naming
      // the running one until the op that staged it cuts over
      if (!opts.staged) {
        ctx.db.updateComponentPlacement(ctx.launchId, key, {
          dseq: deploy.dseq,
          provider: lease.provider,
          host_uri: lease.hostUri,
          price: lease.price,
          generation: params.generation,
        });
      }
      if (!wantSsh) return {};
      const ssh = extractForwardedPort(status, 2222);
      if (!opts.staged) {
        ctx.db.updateComponentRuntime(ctx.launchId, key, {
          ssh_host: ssh.host,
          ssh_port: ssh.port,
        });
      }
      return ssh;
    },
  });

  // steps the kind runs once it is placed (the relayer's link); when there
  // are some, the op is done after them rather than at the health gate
  const configure = stateless ? (descriptorFor(key)?.configureSteps?.(p, spec) ?? []) : [];
  const finishAtGate = configure.length === 0;

  /** replacePlacement for this relaunch's own steps, from deploy up to `to`. */
  const replaceOffBrokenIngress = (
    ctx: StepCtx,
    deploy: { dseq: string },
    lease: { hostUri: string; gseq: number; oseq: number; provider?: string },
    judge: () => Promise<PlacementVerdict>,
    to = p("verify"),
  ) => replacePlacement(ctx, { opId, key, p, steps, deploy, lease, to, judge });

  if (stateless) {
    // §5: stateless components skip the node rewiring and guarded start —
    // the container is live once it answers on its domain. Its tunnels come
    // up correct at boot because the deploy step re-aimed the env at the
    // peers' current tailnet IPs.
    steps.push({
      name: p("verify"),
      async run(ctx) {
        const domain = stateless!.domain;
        if (!domain) {
          // no public domain to probe: the lease being up is the gate
          ctx.db.setComponentState(ctx.launchId, key, "active");
          if (finishAtGate) ctx.db.setFleetOpStatus(opId, "done");
          return { healthy: true };
        }
        const url = `https://${domain}/`;
        // a re-placement this step started, back from its close signature
        const placed = ctx.output<{ dseq: string }>(p("deploy"));
        const leased = ctx.output<{ hostUri: string; gseq: number; oseq: number; provider?: string }>(p("lease"));
        const pending = (JSON.parse(ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId)?.params_json ?? "{}") as RelaunchParams).replacing;
        if (placed && leased && pending?.dseq === placed.dseq) {
          await replaceOffBrokenIngress(ctx, placed, leased, async () => ({ broken: true, detail: "" }));
        }
        // every domain the component serves, each on its health path: a
        // move can add one (Mastodon's login.<domain> when sign-in is turned
        // on) that no DNS record points at yet, while the main domain still
        // answers from the same provider
        const probes = descriptorFor(key)?.ingress?.(spec) ?? [{ domain, healthUrl: url }];
        let dark = probes;
        for (let i = 0; i < 36; i++) {
          const answers = await Promise.all(dark.map((d) => ctx.services.rpc.httpOk(d.healthUrl)));
          dark = dark.filter((_, j) => !answers[j]);
          if (dark.length === 0) {
            ctx.db.setComponentState(ctx.launchId, key, "active");
            if (finishAtGate) ctx.db.setFleetOpStatus(opId, "done");
            return { healthy: true, url };
          }
          await ctx.services.sleep(5000);
        }
        // a domain that does not answer points at the OLD provider's
        // ingress (the relaunch moved providers) or at nothing yet (it is
        // new): pause with the target, the same for every domain
        const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
        const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
        // each domain to its own service's ingress hostname
        const targets: { domain: string; target: string }[] = [];
        for (const d of dark) {
          targets.push({ domain: d.domain, target: await ingressHost(ctx, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, d.domain) });
        }
        if ((await pointDns(ctx, targets)).length > 0) {
          for (let i = 0; i < 36 && dark.length > 0; i++) {
            await ctx.services.sleep(5000);
            const answers = await Promise.all(dark.map((d) => ctx.services.rpc.httpOk(d.healthUrl)));
            dark = dark.filter((_, j) => !answers[j]);
          }
          if (dark.length === 0) {
            ctx.db.setComponentState(ctx.launchId, key, "active");
            if (finishAtGate) ctx.db.setFleetOpStatus(opId, "done");
            return { healthy: true, url, dnsUpdated: true };
          }
        }
        // DNS or the provider? The provider's own hostname tells: a ready
        // container it does not serve either means its ingress is broken,
        // and the component moves (closing this deployment, keeping off
        // that provider) instead of waiting for a record that cannot help
        const verdict = await replaceOffBrokenIngress(ctx, deploy, lease, () =>
          ingressVerdict(ctx, { ...lease, dseq: deploy.dseq }, dark[0]!.domain, new URL(dark[0]!.healthUrl).pathname),
        );
        const records = targets.filter((t) => dark.some((d) => d.domain === t.domain)).map((t) => `${t.domain} → CNAME ${t.target}`);
        throw new AwaitUser(
          p("verify"),
          (verdict ? `${verdict}. ` : "") +
          `${key} not answering at ${dark.map((d) => d.healthUrl).join(", ")} — create or update the DNS ` +
            `record${records.length > 1 ? "s" : ""} ${records.join(", ")} ` +
            "(Cloudflare: proxy on, SSL=Flexible), then resume",
        );
      },
    });
    if (!finishAtGate) {
      steps.push(...configure, {
        name: p("done"),
        async run(ctx) {
          ctx.db.setFleetOpStatus(opId, "done");
          return {};
        },
      });
    }
    return steps;
  }

  steps.push({
    name: p("configure"),
    async run(ctx) {
      const row = componentRow(ctx, key);
      const target = rowTarget(ctx, row);
      await prepareNodeHome(ctx, spec, key, target);
      // no close step: a node added to the fleet (add-sentry), which has
      // no old address to replace and is appended to its peers instead
      const close = ctx.output<{ oldTailnetIp: string | null }>(p("close"));
      return wireMovedNode(ctx, spec, key, target, {
        deploy: ctx.output<{ dseq: string }>(p("deploy"))!,
        lease: ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!,
        oldTailnetIp: close?.oldTailnetIp ?? null,
        ...(close ? {} : { added: true }),
      });
    },
  });

  steps.push({
    name: p("start"),
    async run(ctx) {
      const close = ctx.output<{ baselineHeight?: number; baselineMissed?: boolean }>(p("close")) ?? {};
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
          managedSigner(signerDepsOf(ctx), key)
            ? `${key}: the launcher repoints its managed tmkms signer at ` +
                `tcp://${cfg.tailnetIp}:26659 once the node boots`
            : `${key}: repoint your tmkms signer while this finishes — ` +
                `addr = "tcp://${cfg.tailnetIp}:26659"`,
        );
      }
      if (isValidator && spec.security.keyMode === "softsign") {
        await doubleSignWindow(ctx, p("start"), key, close);
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
      // a relaunched sentry moved: the validators that dial it first carry
      // its old address in their peer-tunnel env, and a container restart
      // would re-create that dead tunnel. Re-aimed in this same tx.
      const dialers = isValidator
        ? []
        : Array.from({ length: spec.topology.validators.count }, (_, v) => v)
            .filter((v) => topo.validatorSentries[v]?.[0] === Number(key.split("-")[1]))
            .map((v) => `val-${v}`)
            .filter((k) => {
              const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find((c) => c.key === k);
              return row?.state === "active" && fs.existsSync(sdlPathFor(ctx, k));
            });
      targets.push(...dialers);

      const msgs: Msg[] = [];
      const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
      for (const k of targets) {
        const row = componentRow(ctx, k);
        const sdlPath = sdlPathFor(ctx, k);
        let text = fs.readFileSync(sdlPath, "utf8");
        text = text.replace(/WAIT_FOR_CONFIG=true/g, "WAIT_FOR_CONFIG=false");
        if (k === key && isValidator) {
          // outbound peer tunnel (and, joining, the own-sentry witness) that
          // the configure step wired over SSH, baked so a container restart
          // re-creates them: the entrypoint runs every TS_TUNNEL_* env entry
          const s = topo.validatorSentries[valIndex]?.[0];
          const sentryIp = s !== undefined ? componentRow(ctx, `sentry-${s}`).tailnet_ip : null;
          if (sentryIp) text = withValidatorTunnelEnv(text, sentryIp, Boolean(spec.join));
        }
        if (dialers.includes(k)) {
          text = withValidatorTunnelEnv(text, cfg.tailnetIp, Boolean(spec.join));
        } else if (k !== key) {
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
      const counterparts = manifests.filter((m) => m.row.key !== key && !dialers.includes(m.row.key));
      // A counterpart whose provider will not answer is logged and dropped
      // from the ordering below rather than failing the op. That ordering
      // exists to keep a sentry serving at the head while the validator
      // state-syncs off it, and a sentry nobody can reach is serving nothing,
      // so there is no snapshot stream left to interrupt. Failing here
      // instead stranded the validator unbooted behind a sentry that may
      // never come back; the sentry's own relaunch re-pushes this manifest.
      const pushed: typeof counterparts = [];
      for (const { row: r, json } of counterparts) {
        try {
          await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
          pushed.push({ row: r, json });
        } catch (e) {
          ctx.log(
            `${r.key}: manifest push failed (${e instanceof Error ? e.message : String(e)}); ` +
              `continuing without it, its own relaunch or repair re-pushes`,
          );
        }
      }
      for (const { row: r } of pushed) {
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
      if (opts.beforeOwnPush) await opts.beforeOwnPush(ctx);
      for (const { row: r, json } of manifests.filter((m) => m.row.key === key)) {
        await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
      }
      // the dialing validators last: their restart re-creates the peer
      // tunnel at the relaunched sentry, which is up by now. An unreachable
      // provider is logged, not fatal: repair's mesh-env re-pushes it
      for (const { row: r, json } of manifests.filter((m) => dialers.includes(m.row.key))) {
        try {
          await ctx.services.provider.sendManifest(cert, r.host_uri, r.dseq, json);
          ctx.log(`${r.key}: peer tunnel re-aimed at ${cfg.tailnetIp}`);
        } catch (e) {
          ctx.log(
            `${r.key}: manifest push failed (${e instanceof Error ? e.message : String(e)}); ` +
              "its peer tunnel still names the old address until repair re-pushes it",
          );
        }
      }
      // Every manifest pushed above re-created a container, and a re-created
      // container answers SSH on a different forwarded port: probing without
      // re-reading spends the whole wait on a port nothing listens on, and
      // leaves the rows wrong for await-signer and verify after it.
      await refreshSshEndpoints(ctx, manifests.map((m) => m.row));
      // the push boots the relaunched node (entrypoint-owned, its first and
      // only start) — wait for the process before declaring the op done,
      // reading it both ways round: its shell, and its own RPC, which does
      // not go through its shell. A node that is demonstrably serving blocks
      // is back whatever its endpoint record says; failing the op over an
      // unreachable shell aborts a relaunch that worked, and the stale
      // record is repair-fleet's job.
      const row = componentRow(ctx, key);
      let height: number | undefined;
      const back = await pollSsh(
        ctx,
        async (i) => {
          if (i > 0 && i % 6 === 0) ctx.log(`${key}: waiting for the node (attempt ${i})`);
          try {
            const r = await ctx.services.ssh.exec(
              rowTarget(ctx, row),
              "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
              { quick: true },
            );
            if (r.stdout.trim() === "yes") return true;
          } catch {
            // container restarting, endpoint moved, or the provider is
            // refusing the shell: the loop is the retry
          }
          height = await nodeSelfHeight(ctx, row);
          return height !== undefined;
        },
        // a first boot can include an image pull and a state-sync restore
        { attempts: 60, deadlineMs: 8 * 60_000 },
      );
      if (!back) {
        throw new Error(
          `${key} did not come back after the persist restart: no answer over SSH, and it is ` +
            "serving no RPC either",
        );
      }
      if (height !== undefined) {
        ctx.log(
          `${key}: no answer over SSH, but it is serving RPC at height ${height} — treating the ` +
            "restart as done. Run repair fleet to re-read where it answers.",
        );
      }
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
        // a signer on the launcher's own machine is repointed here instead
        // of asking the operator to (local-signer.ts)
        const local = await tryManaged(signerDepsOf(ctx), (d) =>
          repointSigner(d, key, cfg.tailnetIp, "relaunch"),
        );
        let connected = false;
        for (let attempt = 0; attempt < 12 && !connected; attempt++) {
          if (attempt > 0) await ctx.services.sleep(5000);
          const probe = await ctx.services.ssh
            // quick: one attempt, bounded — this is a probe inside a
            // caller-owned retry loop, and an unbounded one hangs the
            // whole gate on an endpoint that answers the handshake and
            // then goes quiet
            .exec(rowTarget(ctx, row), SIGNER_CONNECTED_PROBE, { quick: true })
            .catch(() => ({ stdout: "" }));
          connected = probeSaysConnected(probe.stdout);
        }
        if (!connected) {
          throw new AwaitUser(
            p("await-signer"),
            `repoint your tmkms signer at the relaunched ${key} — the relaunch moved it to a ` +
              `new mesh address:\n  addr = "tcp://${cfg.tailnetIp}:26659"\n` +
              "in the [[validator]] block of tmkms.toml, then restart the signer and resume. " +
              "Keep the existing state file: its watermark is what stops a double-sign." +
              local.note,
          );
        }
        ctx.log(`${key}: signer connected`);
        if (lastStep === p("await-signer")) ctx.db.setFleetOpStatus(opId, "done");
        return { signerConnected: true };
      },
    });
  }

  if (meshClients) {
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
        for (const dep of allMeshDependents(ctx, spec, key)) {
          const depKey = dep.key;
          const row = (ctx.db.listFleetComponents(dep.fleetId) as FleetComponentRow[]).find(
            (c) => c.key === depKey && c.state !== "closed",
          );
          if (!row) continue;
          const sdlPath = path.join(dep.sdlDir, `${depKey}.yaml`);
          const retarget = retargetTunnelEnv(ctx, dep.spec, depKey, fs.readFileSync(sdlPath, "utf8"), dep.fleetId);
          const label = dep.fleetId === ctx.launchId ? depKey : fleetPeer(depKey, dep.fleetId);
          for (const c of retarget.changes) ctx.log(`${label}: tunnel re-aimed at ${c}`);
          if (retarget.changes.length > 0) fs.writeFileSync(sdlPath, retarget.text);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          fs.writeFileSync(path.join(dep.sdlDir, `${depKey}.manifest.json`), artifacts.manifestJson);
          // Pushed whether or not this run rewrote the SDL, as repair's
          // mesh-env does: the update tx pauses this step for a signature,
          // and the re-run after it finds the SDL already re-aimed. Skipping
          // the push then left the update on chain and the provider never
          // told, so the container kept dialing the old address. Seen live:
          // a relayer tunnelling to a resized sentry-0's old IP for a day,
          // its relinks hanging on the dead tunnel. A provider already
          // running this manifest changes nothing.
          pushes.push({ row, json: artifacts.manifestJson });
          // convergent like retarget: a re-run finds the version already on
          // chain and only re-sends the manifest
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          if (onChain?.hash === wantHash) continue;
          if (retarget.changes.length === 0 && !onChain?.hash) continue;
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        if (msgs.length > 0) await ctx.requireTx(p("mesh-clients"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("mesh-clients"));
        for (const { row, json } of pushes) {
          try {
            await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
          } catch (e) {
            // same tolerance as the counterpart sentries above: a mesh client
            // on an unreachable provider keeps dialing the old address until
            // its own relaunch or a repair re-pushes, which beats failing a
            // relaunch that otherwise finished
            ctx.log(
              `${row.key}: manifest push failed (${e instanceof Error ? e.message : String(e)}); ` +
                `leaving its tunnel for its own relaunch or repair to re-aim`,
            );
          }
        }
        if (lastStep === p("mesh-clients")) ctx.db.setFleetOpStatus(opId, "done");
        return { repointed: pushes.map((p2) => p2.row.key) };
      },
    });
  }

  if (publicDomains.length > 0) {
    steps.push({
      name: p("public-dns"),
      async run(ctx) {
        // a re-placement this step started, back from its close signature
        {
          const placed = ctx.output<{ dseq: string }>(p("deploy"));
          const leased = ctx.output<{ hostUri: string; gseq: number; oseq: number; provider?: string }>(p("lease"));
          const live = JSON.parse(ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId)?.params_json ?? "{}") as RelaunchParams;
          if (placed && leased && live.replacing?.dseq === placed.dseq) {
            await replaceOffBrokenIngress(ctx, placed, leased, async () => ({ broken: true, detail: "" }), p("public-dns"));
          }
        }
        // the node is serving again (persist booted it); a domain still
        // dark after a few minutes points at the old provider's ingress
        let dark = publicDomains;
        for (let i = 0; i < 36 && dark.length > 0; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          const answers = await Promise.all(dark.map((d) => ctx.services.rpc.httpOk(d.url)));
          dark = dark.filter((_, j) => !answers[j]);
        }
        if (dark.length > 0) {
          const deploy = ctx.output<{ dseq: string }>(p("deploy"))!;
          const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number }>(p("lease"))!;
          // the API and RPC are forwarded ports on the provider's host, not
          // its port-80 ingress: a CNAME there plus an Origin Rule per domain
          const status = await ctx.services.provider.leaseStatus(loadCert(ctx), lease.hostUri, deploy.dseq, lease.gseq, lease.oseq);
          const targets = publicEndpointRecords(status, dark);
          // the launcher's DNS token, when it has one, then a few more minutes
          if ((await pointOrigins(ctx, targets)).length > 0) {
            for (let i = 0; i < 36 && dark.length > 0; i++) {
              await ctx.services.sleep(5000);
              const answers = await Promise.all(dark.map((d) => ctx.services.rpc.httpOk(d.url)));
              dark = dark.filter((_, j) => !answers[j]);
            }
            if (dark.length === 0) {
              ctx.db.setFleetOpStatus(opId, "done");
              return { answering: publicDomains.map((d) => d.domain), dnsUpdated: true };
            }
          }
          // DNS or the provider? Its forwarded ports, tried directly while
          // the node answers on its own host, tell: a provider that does not
          // forward them is left, the node placed again
          // (not in a resize: past its handover this deployment IS the node,
          // so it only says what it found)
          const judge = () =>
            forwardedVerdict(ctx, { ...lease, dseq: deploy.dseq }, rowTarget(ctx, componentRow(ctx, key)), [
              ...(dark.some((d) => d.name === "RPC") ? [{ port: 26657, path: "/status" }] : []),
              ...(dark.some((d) => d.name === "API") ? [{ port: 1317, path: "/cosmos/base/tendermint/v1beta1/node_info" }] : []),
            ]);
          const verdict = opts.staged
            ? await judge().then((v) => (v.detail ? `Checked past DNS: ${v.detail}` : undefined))
            : await replaceOffBrokenIngress(ctx, deploy, lease, judge, p("public-dns"));
          const records = targets.filter((t) => dark.some((d) => d.domain === t.domain)).map(originInstruction);
          throw new AwaitUser(
            p("public-dns"),
            (verdict ? `${verdict}. ` : "") +
            `${key} moved to another provider, and the fleet's public ` +
              `${dark.map((d) => d.name).join(" and ")} no longer answer${dark.length > 1 ? "" : "s"} at ` +
              `${dark.map((d) => d.url).join(", ")}. Set ${records.join("; ")} ` +
              `(Cloudflare: proxy on, SSL=Flexible), then resume.`,
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { answering: publicDomains.map((d) => d.domain) };
      },
    });
  }

  return steps;
}

export { pointDns } from "./dns-steps.js";

/** The fleet's public API/RPC domains, all served by sentry-0, with the URL
 *  that proves each one reaches the node (the same probes verify-chain uses). */
export function sentryPublicDomains(spec: LaunchSpec): { name: string; domain: string; url: string }[] {
  const pub = isServicesFleet(spec) ? undefined : spec.topology.publicEndpoints;
  const out: { name: string; domain: string; url: string }[] = [];
  if (pub?.api) out.push({ name: "API", domain: pub.api, url: `https://${pub.api}/cosmos/base/tendermint/v1beta1/node_info` });
  if (pub?.rpc) out.push({ name: "RPC", domain: pub.rpc, url: `https://${pub.rpc}/status` });
  return out;
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
    ...serviceComponents(spec).filter((c) => c.mesh).map((c) => c.key),
  ];
  const valKeys = nodes(spec).filter((n) => n.key.startsWith("val-")).map((n) => n.key);

  const hsShell = (ctx: StepCtx, hs: { hostUri: string; dseq: string; gseq: number; oseq: number }, script: string) =>
    ctx.services.provider.shellExec(loadCert(ctx), hs.hostUri, hs.dseq, hs.gseq, hs.oseq, "headscale", ["sh", "-c", script]);

  /** A component's assigned tailnet IPv4, or undefined while it has not joined. */
  const tailnetIp = async (ctx: StepCtx, key: string, target: SshTarget): Promise<string | undefined> => {
    const res = await ctx.services.ssh
      .exec(target, `tailscale --socket=${meshSocket(ctx, key)} ip -4 2>/dev/null || true`)
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
      ip = await tailnetIp(ctx, row.key, target);
    }
    if (!ip) {
      throw new Error(
        `${row.key} never joined the new mesh: headscale answers at ${domain} (the op verified it), ` +
          `and its tailscaled socket was probed at ${meshSocket(ctx, row.key)}. Check the component's ` +
          "tailscaled log and that its provider can reach the new headscale host",
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
        ageIdentity: backup ? ageIdentityAt(ctx.dirs.secrets) : undefined,
        secretsDir: ctx.dirs.secrets,
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
      return {
        dseq,
        requiredStorageClass: artifacts.requiredStorageClass,
        requiresCustomDomain: artifacts.requiresCustomDomain,
      };
    },
  });

  steps.push({
    name: p("lease"),
    async run(ctx) {
      const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
      const deploy = ctx.output<{
        dseq: string;
        requiredStorageClass?: string;
        requiresCustomDomain?: boolean | undefined;
      }>(p("deploy"))!;
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
      // spec's headscale exclusions constrain it; read live, so a provider
      // a re-placement left (op params, wallet list) is kept off too
      const live = JSON.parse(ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId)?.params_json ?? "{}") as RelaunchParams;
      const avoidProviders = new Set<string>([
        ...(params.avoidProviders ?? []),
        ...(live.avoidProviders ?? []),
        ...ctx.db.providerPrefs(owner).avoid,
      ]);
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
        requiresCustomDomain: deploy.requiresCustomDomain,
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
      const lease = ctx.output<{ hostUri: string; gseq: number; oseq: number; provider?: string }>(p("lease"))!;
      // a re-placement this step started, back from its close signature
      const replace = (judge: () => Promise<PlacementVerdict>) =>
        replacePlacement(ctx, { opId, key: "headscale", p, steps, deploy, lease, to: p("dns"), judge });
      const live = JSON.parse(ctx.db.listFleetOps(ctx.launchId).find((o) => o.id === opId)?.params_json ?? "{}") as RelaunchParams;
      if (live.replacing?.dseq === deploy.dseq) await replace(async () => ({ broken: true, detail: "" }));
      const ingress = await ingressHost(ctx, lease.hostUri, deploy.dseq, lease.gseq, lease.oseq, domain);
      // the launcher's DNS token flips it here when it can
      const flipped = (await pointDns(ctx, [{ domain, target: ingress }])).length > 0;
      // poll briefly first (the record may already be right, e.g. a wildcard
      // or a fast flip), then gate unconditionally: the relaunch moved
      // providers, so the domain points at the OLD headscale until the user
      // flips it, and a health pass against the old server would split the
      // mesh (keys minted on the new one, clients registering on the old)
      for (let i = 0; i < (flipped ? 36 : 6); i++) {
        if (await ctx.services.rpc.httpOk(`https://${domain}/health`)) return { dns: true };
        await ctx.services.sleep(5000);
      }
      // DNS or the provider? The provider's own hostname for headscale
      // tells, whatever the record says: one that does not serve it either
      // means the ingress is broken, and headscale moves again
      const verdict = await replace(() => ingressVerdict(ctx, { ...lease, dseq: deploy.dseq }, domain, "/health"));
      throw new AwaitUser(
        p("dns"),
        (verdict ? `${verdict}. ` : "") +
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
      const planned: { row: FleetComponentRow; text: string }[] = [];
      for (const k of meshKeys) {
        const row = componentRow(ctx, k);
        const sdlPath = sdlPathFor(ctx, k);
        let text = fs.readFileSync(sdlPath, "utf8");
        if (!text.includes("TS_AUTHKEY=")) continue;
        text = text.replace(/TS_AUTHKEY=[^\n"']*/g, `TS_AUTHKEY=${keys.perNode[k]}`);
        planned.push({ row, text });
      }
      // hashes go on-chain before any PUT; providers 422 a manifest whose hash
      // drifted from the deployment
      const items: { row: FleetComponentRow; hash: string; manifestJson: string }[] = [];
      for (const { row, text } of planned) {
        const sdlPath = sdlPathFor(ctx, row.key);
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), artifacts.manifestJson);
        items.push({
          row,
          hash: Buffer.from(artifacts.hash).toString("base64"),
          manifestJson: artifacts.manifestJson,
        });
      }
      await updateOnChainAndPush(ctx, owner, cert, p("rekey"), items);

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
      const ipItems: { row: FleetComponentRow; hash: string; manifestJson: string }[] = [];
      for (const { row } of planned) {
        const sdlPath = sdlPathFor(ctx, row.key);
        const before = fs.readFileSync(sdlPath, "utf8");
        // one pass over the whole map: see rewriteTailnetIps on why applying
        // the pairs in sequence corrupts a swapped pair
        const text = rewriteTailnetIps(before, ipMap);
        if (text === before) continue;
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${row.key}.manifest.json`), artifacts.manifestJson);
        ipItems.push({
          row,
          hash: Buffer.from(artifacts.hash).toString("base64"),
          manifestJson: artifacts.manifestJson,
        });
      }
      await updateOnChainAndPush(ctx, owner, cert, p("rekey-ips"), ipItems);
      // the second push restarts them again; wait for the mesh to settle
      for (const { row } of ipItems) await collectIp(ctx, row);
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
      const esc = (s: string): string => s.replace(/\./g, "\\.");
      for (const vk of valKeys) {
        const row = componentRow(ctx, vk);
        const target = rowTarget(ctx, row);
        const cfg = `${NODE_HOME}/config/config.toml`;
        const present: [string, string][] = [];
        for (const [o, n] of pairs) {
          const has = await ctx.services.ssh.exec(target, `grep -c '${esc(o)}' ${cfg} || true`);
          const count = has.stdout.trim();
          if (count === "0" || count === "") continue;
          present.push([o, n]);
        }
        if (present.length === 0) continue;
        // Two passes inside ONE sed: every old address becomes a unique token
        // before any token becomes a new address. Substituting the pairs one
        // after another folds a swapped pair onto a single address (see
        // rewriteTailnetIps), which would point persistent_peers at the wrong
        // node. The match patterns escape their dots; the replacements are
        // literal addresses.
        const args = [
          ...present.map(([o], i) => `-e 's|${esc(o)}|@@TSIP${i}@@|g'`),
          ...present.map(([, n], i) => `-e 's|@@TSIP${i}@@|${n}|g'`),
        ].join(" ");
        await ctx.services.ssh.exec(target, `sed -i ${args} ${cfg}`);
        await restartNode(ctx.services.ssh, target);
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
      // signers on the launcher's own machine: log that machine back into
      // the re-keyed mesh (once per Tailscale CLI), then repoint each one
      const deps = signerDepsOf(ctx);
      const notes: string[] = [];
      const rejoined = new Set<string>();
      for (const vk of valKeys) {
        const b = managedSigner(deps, vk);
        if (!b) continue;
        const ip = newIps[vk] ?? componentRow(ctx, vk).tailnet_ip;
        const res = await tryManaged(deps, async (d) => {
          // one login per machine: a local and a remote signer can both use "tailscale"
          const machine = `${signerMachine(b)}|${b.meshCli}`;
          if (b.meshCli && !rejoined.has(machine)) {
            await rejoinSignerMesh(d, b, `https://${domain}`, home);
            rejoined.add(machine);
          }
          if (!ip) throw new Error(`${vk} has no recorded mesh address yet`);
          return repointSigner(d, vk, ip, "headscale re-key");
        });
        if (res.note) notes.push(res.note);
      }
      // a ready signer's reconnect lands within seconds: poll a minute before
      // parking (same cushion as resume-signing's await-signer)
      const poll = async (): Promise<string[]> => {
        const missing: string[] = [];
        for (const vk of valKeys) {
          const row = componentRow(ctx, vk);
          const probe = await ctx.services.ssh
            // quick: one attempt, bounded — a probe inside a caller-owned
            // retry loop, and an unbounded one here hangs the whole gate on
            // an endpoint that answers the handshake and then goes quiet
            .exec(rowTarget(ctx, row), SIGNER_CONNECTED_PROBE, { quick: true })
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
          "Resume once the tmkms panel reports the signer connected." +
          [...new Set(notes)].join(""),
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

/**
 * Point one component's deployment at `image`: SDL swap, MsgUpdateDeployment
 * (skipped when the chain already holds that hash), manifest push, row image.
 * Shared by the upgrade's update step and its rollback.
 */
async function swapComponentImage(
  ctx: StepCtx,
  spec: LaunchSpec,
  key: string,
  image: string,
  txStep: string,
  extraMsgs: (owner: string) => Promise<Msg[]>,
): Promise<{ services: string[]; txSkipped: boolean }> {
  const row = componentRow(ctx, key);
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const sdlPath = sdlPathFor(ctx, key);
  const sdl = fs.readFileSync(sdlPath, "utf8");
  // precondition (§5): a gated container would come back down
  if (sdl.includes("WAIT_FOR_CONFIG=true")) {
    throw new Error(`${key}: WAIT_FOR_CONFIG still true — run persist-start (step 20b) first`);
  }
  // service components read their chain identity from env (the
  // explorer renders /chain-config.json from it, the frontend serves
  // /api/config from it) — refresh the current values on upgrade so
  // installing an image that reads a newly added var also delivers
  // the var, without needing a chain reset. How is per kind
  // (descriptor.envRefresh): patched in place so persist-start's
  // resolved tunnel targets survive, or re-rendered wholesale.
  refreshComponentEnv(ctx, spec, key, sdlPath);
  const swapped = setComponentImage(sdlPath, key, image, spec);
  if (swapped.length === 0) {
    // nothing in the deployment changes: no tx, no manifest
    ctx.log(`${key}: no running service uses ${image} yet — recorded in the spec for the next render`);
    return { services: swapped, txSkipped: true };
  }
  // the row shows the component's main image: a side service's
  // upgrade (Mastodon's bridge) leaves it as it is
  const mainSwapped =
    swapped.includes("*") || (descriptorFor(key)?.imageServices ?? []).some((s) => swapped.includes(s));
  const artifacts = sdlArtifacts(loadSdl(sdlPath));
  fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
  // convergent, like retarget: a retried op re-walks components an
  // earlier attempt already updated on-chain, and an update tx whose
  // hash matches the live version is rejected ("invalid: deployment
  // hash") — re-send the manifest only for those
  const wantHash = Buffer.from(artifacts.hash).toString("base64");
  const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
  if (onChain?.hash === wantHash) {
    ctx.log(`${key}: on-chain version already matches — skipping update tx`);
    ctx.db.deletePendingTx(ctx.launchId, txStep);
  } else {
    const msgs: Msg[] = [
      {
        typeUrl: TypeUrl.UpdateDeployment,
        value: { id: { owner, dseq: row.dseq }, hash: wantHash },
      },
      ...(await extraMsgs(owner)),
    ];
    await ctx.requireTx(txStep, msgs);
  }
  // The row is written only once the provider has taken the manifest.
  // Recording it before the push made the fleet claim an image that was
  // never deployed, which the upgrade button then read as "already on
  // that version" and refused to re-send (2026-09-18).
  await pushManifest(
    ctx,
    loadCert(ctx),
    key,
    row.host_uri,
    row.dseq,
    fs.readFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), "utf8"),
  );
  if (mainSwapped) ctx.db.updateComponentRuntime(ctx.launchId, key, { image });
  return { services: swapped, txSkipped: onChain?.hash === wantHash };
}

/** A node's verify outcome when it did not come up on the new image. */
interface UpgradeVerifyOutput {
  healthy: boolean;
  /** Plain-words cause, shown in the op's final error. */
  reason?: string;
}

/** Output of a node's rollback step when it actually rolled back. */
interface UpgradeRollbackOutput {
  rolledBack?: boolean;
  skipped?: boolean;
  to?: string;
  reason?: string;
}

/** Rolling upgrade (§5 "Node upgrades"): serial per component, health-gated.
 *
 *  A chain node that cannot run the new release is put back on the image it
 *  ran before, and the components after it are left alone. That only happens
 *  when rolling back is known to be safe: its log names a startup failure no
 *  wait fixes ({@link incompatibleReleaseReason}), or it never served RPC at
 *  all, so it cannot have committed a block on the new binary. A node that
 *  came up but stalls keeps the old behavior (the step fails for the operator
 *  to judge), since the new binary may already have written state the old one
 *  cannot read. */
export function upgradeSteps(opId: number, params: UpgradeParams, spec: LaunchSpec): StepDef[] {
  const steps: StepDef[] = [];
  const stateless = new Map<string, ComponentRef>(
    serviceComponents(spec).map((c) => [c.key, c]),
  );
  const ordered = [...params.components].sort((a, b) => {
    // stateless components upgrade freely, then sentries, validators last
    // (§5 rolling sequencer)
    const rank = (k: string) => (stateless.has(k) ? 0 : k.startsWith("val-") ? 2 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  // the component whose rollback ended the rollout, if any
  const rolledBack = (ctx: StepCtx): { key: string; out: UpgradeRollbackOutput } | undefined => {
    for (const k of ordered) {
      const out = ctx.output<UpgradeRollbackOutput>(`op${opId}:${k}:rollback`);
      if (out?.rolledBack) return { key: k, out };
    }
    return undefined;
  };

  for (const key of ordered) {
    const p = (s: string) => `op${opId}:${key}:${s}`;
    const earlier = ordered.slice(0, ordered.indexOf(key));
    const isNode = !stateless.has(key);

    steps.push({
      name: p("update"),
      async run(ctx) {
        if (rolledBack(ctx)) return { skipped: true };
        // upgrade service fee — flat, once per op, riding the first
        // update tx that actually happens (skipped components can't
        // carry it: there's no tx to batch it into)
        const fee = async (owner: string): Promise<Msg[]> => {
          const cfg = feeConfig();
          const feeDue = earlier.every(
            (k) => ctx.output<{ txSkipped?: boolean }>(`op${opId}:${k}:update`)?.txSkipped,
          );
          if (!feeDue || cfg.upgradeFlat <= 0) return [];
          const coin = await feeCoin(
            PRICING_DENOM[spec.infra.akashNetwork],
            String(cfg.upgradeFlat),
            ctx.services.api,
          );
          if (coin) return [sendMsg(owner, cfg.address, coin)];
          ctx.log("AKT oracle price unavailable — upgrade fee skipped");
          return [];
        };
        const r = await swapComponentImage(ctx, spec, key, params.image, p("update"), fee);
        return { image: params.image, ...r };
      },
    });

    steps.push({
      name: p("verify"),
      async run(ctx): Promise<UpgradeVerifyOutput & Record<string, unknown>> {
        if (rolledBack(ctx)) return { healthy: true, skipped: true };
        // service components (§5): the update is just the image swap plus
        // an HTTP health gate on the public domain, when the kind has one
        const comp = stateless.get(key);
        if (comp && !comp.domain) return { healthy: true };
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
        // whether the node ever answered with a height: one that never did
        // cannot have committed anything on the new binary
        let served = false;
        // a boot that dies at the handshake says why in its log; reading it
        // every few rounds ends a hopeless wait early
        const incompatible = async (): Promise<string | undefined> => {
          try {
            const logs = await ctx.services.provider.leaseLogs(
              loadCert(ctx), row.host_uri, row.dseq, 1, 1, HALT_LOG_TAIL,
            );
            return incompatibleReleaseReason(logs);
          } catch {
            return undefined; // mid-restart: no stream to read yet
          }
        };
        for (let i = 0; i < 60; i++) {
          if (key.startsWith("sentry-")) {
            // a sentry proves itself over its public RPC — height progress
            // is the gate, so a broken sshd can't wedge the rollout
            try {
              const url = await nodeRpcUrl(ctx, row.host_uri, row.dseq);
              const a = await ctx.services.rpc.status(url);
              served = true;
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
              if (Number.isFinite(a)) served = true;
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
          if (!served && i % 6 === 5) {
            const reason = await incompatible();
            if (reason) return { healthy: false, reason };
          }
          await ctx.services.sleep(5000);
        }
        if (!served) {
          const reason =
            (await incompatible()) ??
            `it never came up on the new image (last: ${lastNote || "no probe ran"})`;
          return { healthy: false, reason };
        }
        throw new Error(
          `${key} did not come back healthy after upgrade (last: ${lastNote || "no probe ran"})`,
        );
      },
    });

    if (!isNode) continue;
    steps.push({
      name: p("rollback"),
      async run(ctx): Promise<UpgradeRollbackOutput> {
        const verify = ctx.output<UpgradeVerifyOutput>(p("verify"));
        if (!verify || verify.healthy) return { skipped: true };
        // rows made before images were recorded carry none; chain nodes
        // render from the spec's sparkdreamd image, so that is what ran
        const prev = params.previous?.[key] ?? params.previousSpecImages?.sparkdreamd;
        if (!prev || prev === params.image) {
          throw new Error(
            `${key} cannot run ${params.image}: ${verify.reason}. The image it ran before is ` +
              "not recorded, so it was not rolled back; upgrade it back to its previous version.",
          );
        }
        ctx.log(`${key}: ${verify.reason}; rolling back to ${prev}`);
        await swapComponentImage(ctx, spec, key, prev, p("rollback"), async () => []);
        // the op recorded the new image in the spec at request time; put the
        // old one back so relaunches and resets render what actually works
        restoreSpecImages(ctx, params.image, params.previousSpecImages);
        return { rolledBack: true, to: prev, reason: verify.reason ?? "it failed its health check" };
      },
    });
  }

  steps.push({
    name: `op${opId}:finish`,
    async run(ctx) {
      const rb = rolledBack(ctx);
      if (rb) {
        // the op stays open on this error so it is seen; retrying it only
        // repeats this message (every component step skips once one rolled
        // back), so nothing can push the image any further
        const untouched = ordered.slice(ordered.indexOf(rb.key) + 1);
        throw new Error(
          `Upgrade to ${params.image} stopped and rolled back: ${rb.key} could not run it, because ${rb.out.reason}. ` +
            `${rb.key} is back on ${rb.out.to}` +
            (untouched.length > 0 ? `; ${untouched.join(", ")} not touched` : "") +
            ". Abort this operation to dismiss it.",
        );
      }
      ctx.db.setFleetOpStatus(opId, "done");
      return { upgraded: ordered, image: params.image };
    },
  });

  return steps;
}

export interface HaltUpgradeParams {
  image: string;
  haltHeight: number;
  /** Image each chain node ran when the op was requested (rollback target).
   *  Absent on older ops. */
  previous?: Record<string, string>;
  /** spec.images before the op recorded the new image. */
  previousSpecImages?: Record<string, string>;
}

/**
 * Move every chain node to `image` in one batched MsgUpdateDeployment, then
 * push the manifests and record the image on each row. The halt upgrade's
 * swap, and its rollback's.
 */
async function swapNodeImages(
  ctx: StepCtx,
  rows: FleetComponentRow[],
  image: (row: FleetComponentRow) => string,
  txStep: string,
  extraMsgs: (owner: string) => Promise<Msg[]>,
): Promise<string[]> {
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const msgs: Msg[] = [];
  const manifests: Array<{ row: FleetComponentRow; json: string }> = [];
  for (const row of rows) {
    const sdlPath = sdlPathFor(ctx, row.key);
    let sdl = fs.readFileSync(sdlPath, "utf8");
    sdl = sdl.replace(/image: .*/g, `image: ${image(row)}`);
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
  msgs.push(...(await extraMsgs(owner)));
  // one batched tx: all nodes move together
  await ctx.requireTx(txStep, msgs);
  const cert = loadCert(ctx);
  for (const { row, json } of manifests) {
    await ctx.services.provider.sendManifest(cert, row.host_uri, row.dseq, json);
    ctx.db.updateComponentRuntime(ctx.launchId, row.key, { image: image(row) });
  }
  return manifests.map((m) => m.row.key);
}

/** Put the op's recorded spec images back where the op replaced them. */
function restoreSpecImages(
  ctx: StepCtx,
  image: string,
  previousSpecImages: Record<string, string> | undefined,
): void {
  const stored = JSON.parse(ctx.db.getLaunch(ctx.launchId)!.spec_json) as LaunchSpec;
  const images = stored.images as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(previousSpecImages ?? {})) {
    if (images[k] === image) images[k] = v;
  }
  ctx.db.setLaunchSpec(ctx.launchId, JSON.stringify(stored));
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
        const updated = await swapNodeImages(
          ctx,
          nodeRows(ctx),
          () => params.image,
          p("update-all"),
          async (owner) => {
            // upgrade service fee — flat, once per op, on this batched update
            const fee = feeConfig();
            if (fee.upgradeFlat <= 0) return [];
            const coin = await feeCoin(
              PRICING_DENOM[spec.infra.akashNetwork],
              String(fee.upgradeFlat),
              ctx.services.api,
            );
            if (coin) return [sendMsg(owner, fee.address, coin)];
            ctx.log("AKT oracle price unavailable — upgrade fee skipped");
            return [];
          },
        );
        return { updated };
      },
    },
    {
      name: p("resume-verify"),
      async run(ctx): Promise<{ resumedAt?: number; reason?: string }> {
        // providers restart containers on the new image; WAIT_FOR_CONFIG=false
        // (step 20b) auto-starts them — chain resumes once >2/3 are back.
        // highest head seen: once it reaches the halt height the new binary
        // has committed a block, and rolling back is no longer safe
        let highest = 0;
        // a node that dies at boot says why in its log; reading the nodes
        // every minute ends a hopeless wait early
        const incompatible = async (): Promise<string | undefined> => {
          const cert = loadCert(ctx);
          for (const row of nodeRows(ctx)) {
            try {
              const logs = await ctx.services.provider.leaseLogs(
                cert, row.host_uri, row.dseq, 1, 1, HALT_LOG_TAIL,
              );
              const reason = incompatibleReleaseReason(logs);
              if (reason) return `${row.key}: ${reason}`;
            } catch {
              // mid-restart: no stream to read yet
            }
          }
          return undefined;
        };
        for (let i = 0; i < 240; i++) {
          try {
            const height = await sentryRpcHeight(ctx);
            if (height !== undefined) highest = Math.max(highest, height);
            if (height !== undefined && height > params.haltHeight) {
              return { resumedAt: height };
            }
          } catch {
            // the sentry halted with everything else and its RPC comes back
            // only once the provider has restarted it on the new image — the
            // loop is the retry, not a reason to fail the op
          }
          if (highest < params.haltHeight && i % 12 === 11) {
            const reason = await incompatible();
            if (reason) return { reason };
          }
          await ctx.services.sleep(5000);
        }
        if (highest < params.haltHeight) {
          return {
            reason:
              (await incompatible()) ??
              `the chain never got past the halt height ${params.haltHeight} on the new image`,
          };
        }
        throw new Error("chain did not resume after the coordinated upgrade");
      },
    },
    {
      name: p("rollback"),
      async run(ctx) {
        const verify = ctx.output<{ resumedAt?: number; reason?: string }>(p("resume-verify"));
        if (!verify?.reason) return { skipped: true };
        // the new binary never committed a block (the head stayed below the
        // halt height), and halt-clear already reset the setting, so the old
        // binary picks the chain up exactly where it halted
        const rows = nodeRows(ctx);
        const fallback = params.previousSpecImages?.sparkdreamd;
        const target = (row: FleetComponentRow) => params.previous?.[row.key] ?? fallback;
        const missing = rows.filter((r) => !target(r) || target(r) === params.image);
        if (missing.length > 0) {
          throw new Error(
            `the nodes cannot run ${params.image}: ${verify.reason}. The image ` +
              `${missing.map((r) => r.key).join(", ")} ran before is not recorded, so nothing ` +
              "was rolled back; upgrade the nodes back to their previous version.",
          );
        }
        ctx.log(`${verify.reason}; rolling every node back`);
        await swapNodeImages(ctx, rows, (row) => target(row)!, p("rollback"), async () => []);
        restoreSpecImages(ctx, params.image, params.previousSpecImages);
        // the chain only runs again once the old binary is back on enough
        // power; wait for it so the op's closing message can say so
        let resumedAt: number | undefined;
        for (let i = 0; i < 120 && resumedAt === undefined; i++) {
          if (i > 0) await ctx.services.sleep(5000);
          try {
            const h = await sentryRpcHeight(ctx);
            if (h !== undefined && h >= params.haltHeight) resumedAt = h;
          } catch {
            // restarting on the old image
          }
        }
        return {
          rolledBack: true,
          to: [...new Set(rows.map((r) => target(r)!))].join(", "),
          reason: verify.reason,
          ...(resumedAt !== undefined ? { resumedAt } : {}),
        };
      },
    },
    {
      name: p("finish"),
      async run(ctx) {
        const rb = ctx.output<{ rolledBack?: boolean; to?: string; reason?: string; resumedAt?: number }>(
          p("rollback"),
        );
        if (rb?.rolledBack) {
          // the op stays open on this error so it is seen; a retry only
          // repeats it
          throw new Error(
            `Upgrade to ${params.image} stopped and rolled back: ${rb.reason}. Every node is back ` +
              `on ${rb.to}` +
              (rb.resumedAt !== undefined
                ? ` and the chain resumed (height ${rb.resumedAt})`
                : ", but the chain has not resumed yet: check the nodes") +
              ". Abort this operation to dismiss it.",
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return { resumedAt: ctx.output<{ resumedAt?: number }>(p("resume-verify"))?.resumedAt };
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
  const pub = spec.topology.publicEndpoints;
  const d = descriptorFor(key);
  if (d) {
    const domain = serviceComponents(spec).find((c) => c.key === key)?.domain;
    if (!domain) throw new Error(`${key} has no domain in the spec`);
    for (const name of d.imageServices) {
      const svc = doc.services?.[name];
      if (!svc) throw new Error(`${key}.yaml has no services.${name}`);
      for (const e of svc.expose ?? []) if (e.accept) e.accept = [domain];
    }
    if (d.retargetEnv) setServiceEnv(doc, d.imageServices, d.retargetEnv(spec));
    d.retargetDoc?.(doc, spec);
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
        const pub = spec.topology.publicEndpoints;
        const urls: string[] = [];
        for (const key of params.components) {
          // every domain the component serves, on its health path (Mastodon:
          // its login domain too), else its one domain
          const ingress = descriptorFor(key)?.ingress?.(spec);
          if (ingress) {
            urls.push(...ingress.map((i) => i.healthUrl));
            continue;
          }
          const domain = serviceComponents(spec).find((c) => c.key === key)?.domain;
          if (domain) urls.push(`https://${domain}/`);
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
          // name each service component's ingress, so a domain that is new
          // (not repointed) has its target spelled out
          const targets: string[] = [];
          const cnames: { domain: string; target: string }[] = [];
          for (const key of params.components) {
            const own = serviceComponents(spec).find((c) => c.key === key)?.domain;
            if (!own) continue;
            // the domains this component serves, among the dark ones
            const served = new Set(descriptorFor(key)?.ingress?.(spec).map((i) => i.domain) ?? [own]);
            const row = componentRow(ctx, key);
            for (const domain of dark.map((u) => new URL(u).hostname).filter((h) => served.has(h))) {
              const host = await ingressHost(ctx, row.host_uri, row.dseq, 1, 1, domain).catch(() => undefined);
              if (host) {
                targets.push(`${domain} → CNAME ${host}`);
                cnames.push({ domain, target: host });
              }
            }
          }
          // the sentry's public endpoints: forwarded ports, so CNAME plus Origin Rule
          const darkHosts = new Set(dark.map((u) => new URL(u).hostname));
          const endpoints = sentryPublicDomains(spec).filter((d) => darkHosts.has(d.domain));
          let origins: OriginRecord[] = [];
          if (endpoints.length > 0 && params.components.some((k) => k.startsWith("sentry-"))) {
            const s0 = componentRow(ctx, "sentry-0");
            const status = await ctx.services.provider.leaseStatus(loadCert(ctx), s0.host_uri, s0.dseq, 1, 1).catch(() => undefined);
            if (status) {
              origins = publicEndpointRecords(status, endpoints);
              targets.push(...origins.map(originInstruction));
            }
          }
          // the launcher's DNS token first, then a few minutes for it to take
          const set = [...(await pointDns(ctx, cnames)), ...(await pointOrigins(ctx, origins))];
          if (set.length > 0) {
            let still = dark;
            for (let i = 0; i < 36 && still.length > 0; i++) {
              await ctx.services.sleep(5000);
              const ok = await Promise.all(still.map((u) => ctx.services.rpc.httpOk(u)));
              still = still.filter((_, j) => !ok[j]);
            }
            if (still.length === 0) {
              ctx.db.setFleetOpStatus(opId, "done");
              return { verified: urls, dnsUpdated: set };
            }
          }
          throw new AwaitUser(
            p("verify"),
            `not reachable after the domain update: ${dark.join(", ")} — ` +
              "create or repoint the DNS records (CNAME each domain to its provider ingress host" +
              (targets.length > 0 ? `: ${targets.join("; ")}` : ", same target as before for unchanged providers") +
              "; Cloudflare: proxy on, SSL=Flexible), then resume.",
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
 * Refresh a service component's chain-identity env in its deployed SDL, the
 * way its kind asks (descriptor.envRefresh): "patch" sets chainEnv(spec) in
 * place, preserving the baked tunnel IPs and auth keys (same rationale as
 * retargetSdl); "rerender" renders the SDL again from the spec, for a kind
 * whose deployed SDL holds nothing the spec doesn't. No-op for chain nodes.
 */
function refreshComponentEnv(ctx: StepCtx, spec: LaunchSpec, key: string, sdlPath: string): void {
  const d = descriptorFor(key);
  if (!d || d.envRefresh === "none") return;
  if (d.envRefresh === "rerender") {
    rerenderComponentSdl(ctx, spec, key, sdlPath);
    return;
  }
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  setServiceEnv(doc, d.imageServices, d.chainEnv?.(spec) ?? {});
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
}

/** Re-render a service component's SDL from the spec. */
function rerenderComponentSdl(ctx: StepCtx, spec: LaunchSpec, key: string, sdlPath: string): void {
  const keys = ctx.output<GenerateKeysOutput>("generate-keys");
  if (!keys) throw new Error("generate-keys output missing");
  // an upgrade/reset op can name a component the edited spec has since
  // turned off: say so rather than crashing inside the renderer
  const component = serviceComponents(spec).find((c) => c.key === key);
  if (!component) throw new Error(`${key} is disabled in the spec — cannot re-render its SDL`);
  renderComponentSdl({
    spec,
    peerChains: sisterChainApis(ctx.db, ctx.launchId, spec),
    component,
    sshPublicKey: keys.sshPublicKey,
    outPath: sdlPath,
    placeholder,
    peerTailnetIp: (peer) => peerRow(ctx.db, ctx.launchId, peer)?.tailnet_ip ?? undefined,
    secretsDir: ctx.dirs.secrets,
    resolveFleet: fleetResolver({ ...ctx, spec }),
    launchId: ctx.launchId,
  });
}

/** An image reference without its tag or digest: "repo/name". */
export function imageRepo(image: string): string {
  const noDigest = image.split("@")[0]!;
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

/**
 * Point a deployed SDL at a new image; returns the services it swapped.
 * Node SDLs run one service, so every image line is it. A service component
 * swaps the services already running that image's repository (Mastodon's
 * bridge or login for an sdap image, its streaming for the upstream
 * streaming image), else its image services; a sidecar that runs something
 * else (a database) keeps its own image either way. A side image no running
 * service uses (sdap on a Mastodon without bridge or sign-in) swaps nothing:
 * the spec records it for the next render, and falling back to the image
 * services would run it in place of Mastodon.
 */
function setComponentImage(sdlPath: string, key: string, image: string, spec: LaunchSpec): string[] {
  const d = descriptorFor(key);
  if (!d) {
    const sdl = fs.readFileSync(sdlPath, "utf8");
    fs.writeFileSync(sdlPath, sdl.replace(/image: .*/g, `image: ${image}`));
    return ["*"];
  }
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const running = Object.entries(doc.services ?? {}) as Array<[string, { image?: string }]>;
  const same = running.filter(([, svc]) => svc.image && imageRepo(svc.image) === imageRepo(image)).map(([name]) => name);
  const images = spec.images as Record<string, string | undefined>;
  const sideOnly =
    same.length === 0 &&
    Object.values(d.sideImages ?? {}).some((k) => images[k] && imageRepo(images[k]!) === imageRepo(image));
  if (sideOnly) return [];
  const targets = same.length > 0 ? same : d.imageServices;
  for (const name of targets) {
    const svc = doc.services?.[name];
    if (!svc) throw new Error(`${key}.yaml has no services.${name}`);
    svc.image = image;
  }
  fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
  return targets;
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
 * freshly built genesis, on the SAME deployments and under the SAME
 * chain-id — no new leases, providers, mesh, or DNS, and nothing pointed at
 * the chain has to be re-aimed. For state-breaking chain upgrades: the
 * (already-updated) spec's genesis-shaping fields — accounts, members,
 * chainParams, token — all take effect, and the operator/account keyring is
 * rebuilt from scratch (fresh mnemonics; edited account lists just work).
 *
 * Keeping the chain-id means signer state is what has to be made safe: the
 * new chain starts at height 1 under an id every signer has already voted
 * on. op:signer stops the reset between the wipe and the restart — the one
 * window where nothing can sign — for the operator to clear every signer's
 * watermark, this fleet's and anyone else's on the same chain.
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
        // the flip above re-created every container, and a re-created
        // container answers SSH on a new forwarded port — re-read before
        // probing, or the poll below talks to nothing
        await refreshSshEndpoints(ctx, nodeRows(ctx));
        // converge to "stopped": once the wait-mode env is on-chain, ANY
        // container restart lands in wait mode — so killing a straggler
        // (even PID-1 sparkdreamd) is terminal, not a self-heal loop
        for (const row of nodeRows(ctx)) {
          const stopped = await pollSsh(ctx, async (i) => {
            if (i > 0 && i % 6 === 0) ctx.log(`${row.key}: waiting for wait mode (attempt ${i})`);
            const running = await ctx.services.ssh.exec(
              rowTarget(ctx, row),
              "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
              { quick: true },
            );
            if (running.stdout.trim() === "no") return true;
            await ctx.services.ssh.exec(rowTarget(ctx, row), "pkill -x sparkdreamd || true", {
              quick: true,
            });
            return false;
          });
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

  steps.push({
    name: p("signer"),
    async run(ctx) {
      // The reset keeps the chain-id, so nothing about the signer's config
      // changes — but the chain it signs for restarts at height 1 while the
      // signer still holds a watermark from the chain being discarded. That
      // watermark is the only thing standing between the two chains, and
      // clearing it is the operator's move, not ours: tmkms state lives on
      // their box, and a validator outside this fleet is not ours to touch
      // at all. So the op stops here, after the wipe and before any node
      // restarts, which is the one window where nothing can sign.
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
      // signers on the launcher's own machine are cleared here (state file
      // renamed aside, signer restarted): only the rest need the operator
      const tmkms = spec.security.keyMode === "tmkms";
      const allVals = nodeRows(ctx).filter((r) => r.key.startsWith("val-")).map((r) => r.key);
      const cleared: string[] = [];
      const notes: string[] = [];
      if (tmkms && !alreadyAsked) {
        const deps = signerDepsOf(ctx);
        // a re-run after a crash mid-loop resets a signer twice, which is
        // harmless: nothing has signed on the new chain before op:start
        for (const vk of allVals) {
          const res = await tryManaged(deps, (d) => resetSignerState(d, vk));
          if (res.ok) cleared.push(vk);
          else if (res.note) notes.push(res.note);
        }
        if (cleared.length === allVals.length && allVals.length > 0) {
          ctx.log(
            `managed tmkms signer(s) cleared for ${cleared.join(", ")}. Any validator signing on ` +
              `${cid} from outside this fleet must clear its own signer state before it signs again.`,
          );
          return { signersReady: true, managedReset: cleared };
        }
      }
      await pinnedValue(ctx, notice, async () => "asked");
      if (!alreadyAsked) {
        const vals = allVals.filter((v) => !cleared.includes(v));
        throw new AwaitUser(
          p("signer"),
          `${cid} restarts at height 1 on a fresh genesis, and every signer for it must be ` +
            "back to a zero watermark before it does. " +
            (tmkms
              ? `For ${vals.join(", ")}: clear the tmkms state file (delete it, or set height, ` +
                "round and step to 0) and restart the signer. Leave chain_id as it is: the " +
                `chain-id has not changed. A signer still holding the old chain's height will ` +
                "sign nothing, and the fleet will come up producing no blocks. "
              : `This fleet's own nodes (${vals.join(", ")}) were reset with their data, so ` +
                "their priv_validator_state.json is already zeroed. ") +
            `Any validator signing on ${cid} from outside this fleet must have its own signer ` +
            "state cleared too, and must not sign again until it does: the old chain's votes " +
            "and this one's now share a chain-id, so the same key voting twice at one height " +
            "is a double-sign. Resume once every signer is clear." +
            (cleared.length > 0 ? ` (The launcher already cleared its managed signer for ${cleared.join(", ")}.)` : "") +
            notes.join(""),
        );
      }
      return { signersReady: true };
    },
  });

  steps.push(
    {
      name: p("start"),
      async run(ctx) {
        // resume: flip wait mode off — the entrypoint execs sparkdreamd on
        // the new genesis when the containers restart
        const { msgs, manifests } = await flipWaitMode(ctx, nodeRows(ctx), "false");
        // service components embed chain identity in their env (CHAIN_ID/
        // CHAIN_NAME, denoms, display symbols — the Keplr suggest-chain
        // payload and the explorer's runtime chain config) — refresh them on
        // the resume tx, or they keep advertising the pre-reset chain. Each
        // kind refreshes its own way (descriptor.envRefresh): a patch keeps
        // the {{TS_AUTHKEY}}/tunnel values persist-start resolved, which a
        // re-render would turn back into placeholders.
        const componentRows = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
          (c) => c.state === "active" && (descriptorFor(c.key)?.envRefresh ?? "none") !== "none",
        );
        for (const row of componentRows) {
          const sdlPath = sdlPathFor(ctx, row.key);
          refreshComponentEnv(ctx, spec, row.key, sdlPath);
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
        // the manifest push above re-created every container, so the SSH
        // endpoints on these rows are exactly as stale as the restart made
        // them; re-read them from the providers before probing
        await refreshSshEndpoints(ctx, rows);
        // What the resume is FOR is the chain, and the sentry's RPC states
        // it directly: the reset restarts at height 1, on nodes whose data
        // this op wiped, so a committed block is this chain's and means the
        // validators booted, reached their signers and are producing. SSH
        // is the secondary reading — the way to nudge a node whose
        // deployment hash didn't change (no container restart, so nothing
        // started it), and the only reading there is before the first
        // block. Gating on SSH alone spent a full poll budget PER NODE
        // whenever the shells had moved or gone quiet, against a chain that
        // was already minting blocks the fleet view was drawing — and the
        // budget is not even a floor: a probe that hangs never comes back
        // to be timed, so this ran for over an hour on a devnet whose chain
        // had restarted cleanly and was past height 2000 (2026-08-28). So
        // the chain is asked first and on every round, the nodes are probed
        // together rather than one budget after another, and the whole
        // fleet shares one clock.
        const sentry = rows.find((r) => r.key.startsWith("sentry-"));
        let rpcUrl: string | undefined;
        const chainHeight = async (): Promise<number | undefined> => {
          if (!sentry) return undefined;
          try {
            rpcUrl ??= await nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
            const h = (await ctx.services.rpc.status(rpcUrl)).latestBlockHeight;
            // height 0 is comet up on the new genesis with nothing committed
            // — exactly what a sentry serves when the validator never came
            // back, so it is not proof of anything yet
            return h > 0 ? h : undefined;
          } catch {
            rpcUrl = undefined; // a restart moves the forwarded RPC port too
            return undefined;
          }
        };
        const nudgeAfter = Date.now() + NODE_NUDGE_GRACE_MS;
        const up = new Set<string>();
        let height: number | undefined;
        const resumed = await pollSsh(
          ctx,
          async (i) => {
            // blocks are proof for the FLEET, not for each node in it: a
            // chain can produce with a sentry still stopped, and the only
            // thing that starts a node nothing restarted is the nudge
            // below. So the chain ends the wait once every node has had its
            // grace period and its nudge — before that, keep probing.
            height = await chainHeight();
            if (height !== undefined && Date.now() >= nudgeAfter) return true;
            const pending = rows.filter((r) => !up.has(r.key));
            if (i > 0 && i % 6 === 0) {
              ctx.log(`waiting for ${pending.map((r) => r.key).join(", ")} (attempt ${i})`);
            }
            // probed together: independent nodes on independent providers,
            // where a probe that fails costs the full SSH timeout — run in
            // series they turn one node's dead endpoint into every other
            // node's wait
            const answers = await Promise.all(
              pending.map(async (row) => {
                try {
                  const r = await ctx.services.ssh.exec(
                    rowTarget(ctx, row),
                    "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
                    { quick: true },
                  );
                  return { row, running: r.stdout.trim() === "yes" };
                } catch {
                  return { row, running: undefined }; // unreachable: the loop is the retry
                }
              }),
            );
            for (const a of answers) if (a.running) up.add(a.row.key);
            // nudges stay in row order (sentries first — validators dial
            // them on start), and only ever off a probe that ANSWERED "no":
            // nudging a node we cannot reach used to fire blind after 12
            // failures, which both risked double-starting a node that was
            // running fine and, being non-quick, cost four websocket
            // timeouts per attempt.
            for (const a of answers) {
              if (a.running !== false || Date.now() < nudgeAfter) continue;
              await ctx.services.ssh
                .exec(rowTarget(ctx, a.row), START_NODE_CMD, { quick: true })
                .catch(() => {
                  // the probe answered, so this should reach it too; if it
                  // doesn't, the next round re-probes and the chain check
                  // still decides the step
                });
            }
            return rows.every((r) => up.has(r.key));
          },
          // one clock for the fleet, wide enough for a slow container
          // restart (image pull, mesh join) to reach its first block; the
          // chain check ends the poll the moment it does, so the ceiling
          // only ever costs a fleet that really did not come back
          { attempts: 200, deadlineMs: 12 * 60_000 },
        );
        if (!resumed) height ??= await chainHeight();
        const silent = rows.filter((r) => !up.has(r.key)).map((r) => r.key);
        if (silent.length > 0) {
          // SSH silence is not proof a node is down — the endpoint may have
          // moved again, or its provider may be refusing the shell. The
          // chain cannot be stale in the same way, so let it answer: if it
          // is producing blocks the resume did what it was for, and the
          // stale record is repair-fleet's job, not a reason to fail a reset
          // that worked (observed live: this step failing a fleet whose
          // chain had been up for ten minutes).
          if (height === undefined) {
            throw new Error(
              `${silent.join(", ")} did not come back after the resume flip, and no sentry RPC ` +
                "is answering either — the chain is not running",
            );
          }
          ctx.log(
            `${silent.join(", ")}: no answer over SSH, but ${cid} is producing blocks (height ` +
              `${height}) — treating the resume as done. Run repair fleet to re-read where ` +
              "they answer.",
          );
        }
        return {
          resumed: rows.map((r) => r.key),
          ...(height !== undefined ? { height } : {}),
          ...(silent.length > 0 ? { silent } : {}),
        };
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
                ? `: check the signer. The chain-id is still "${cid}", so tmkms needs no config ` +
                  "change — but it signs nothing until its state file is back to a zero " +
                  "watermark, and the height it carries from the discarded chain is far ahead " +
                  "of the one this chain restarted at"
                : ""),
          );
        }
        // the service components restarted with the new chain env — gate on
        // each one with a domain answering again
        const active = new Set(
          (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[])
            .filter((c) => c.state === "active")
            .map((c) => c.key),
        );
        for (const comp of serviceComponents(spec).filter((c) => active.has(c.key) && c.domain)) {
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
/**
 * Run a `sparkdreamd query` on a node against its own local RPC, so the
 * answer is that node's view of the chain rather than whatever the public
 * endpoint (a sentry, possibly partitioned) last saw.
 */
async function nodeQueryJson(ctx: StepCtx, target: SshTarget, args: string[]): Promise<any> {
  const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const res = await ctx.services.ssh.exec(
    target,
    `sparkdreamd ${args.map(quote).join(" ")} --node tcp://127.0.0.1:26657 --output json`,
    { quick: true },
  );
  return JSON.parse(res.stdout);
}

/**
 * After a validator is confirmed signing, say so plainly when the public RPC
 * is not following: the chain is fine, the sentry has lost its validator
 * link. Informational only, since the validator dials its sentry itself on
 * a restart and the gap usually closes within a minute.
 */
async function notePublicLag(
  ctx: StepCtx,
  key: string,
  target: SshTarget,
  rpc: string | null,
): Promise<void> {
  if (!rpc) return;
  try {
    const own = await ctx.services.ssh.exec(target, "wget -qO- http://127.0.0.1:26657/status", { quick: true });
    const ownHeight = Number(JSON.parse(own.stdout).result.sync_info.latest_block_height);
    const pub = await ctx.services.rpc.status(rpc);
    const behind = ownHeight - pub.latestBlockHeight;
    if (behind > STALLED_BEHIND_BLOCKS) {
      ctx.log(
        `the public RPC is ${behind} blocks behind ${key} (${pub.latestBlockHeight} vs ${ownHeight}): ` +
          "its sentry has lost the link to the validator. It should reconnect now that the " +
          "validator is back; if it stays behind, restart the sentry, or run repair if " +
          `${key}'s peers predate its dial-out tunnel.`,
      );
    }
  } catch {
    // either side unreadable: nothing useful to add
  }
}

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
        // a managed signer is restarted (and repointed, if its addr went
        // stale) up front: a stalled session is as likely on the signer's
        // side as on the node's, and the node restarts in the next step
        const local = await tryManaged(signerDepsOf(ctx), (d) =>
          row.tailnet_ip
            ? repointSigner(d, params.key, row.tailnet_ip, "resume signing")
            : restartSigner(d, params.key, "resume signing"),
        );
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
            "watches it sign blocks again." +
            local.note,
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
        // Ask the validator's own node, not the public RPC: that is a
        // sentry, and a sentry cut off from its validator reports "no new
        // blocks" while the validator signs the chain forward alone (seen
        // live on a single-validator testnet: the op failed here while
        // val-0 was 230 blocks ahead of its frozen sentry).
        const target = rowTarget(ctx, componentRow(ctx, params.key));
        const query = (args: string[]) => nodeQueryJson(ctx, target, args);
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
            const out = await query(["query", "staking", "validator", valoper]);
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
            const out = await query(["query", "slashing", "signing-info", pubkeyArg]);
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
          await notePublicLag(ctx, params.key, target, await ownRpc(ctx).catch(() => null));
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

export interface ForceRedeployParams {
  key: string;
}

/** Env var carrying the force-redeploy nonce. Inert to every image. */
export const REDEPLOY_NONCE_ENV = "LAUNCHER_REDEPLOY_NONCE";

/**
 * Set (or refresh) the redeploy nonce in an SDL's env list.
 *
 * Edited as text rather than by re-dumping parsed YAML: the rendered SDLs
 * carry folded scalars (the SSH key) and are regex-edited by half a dozen
 * other steps, so a round trip through the YAML printer risks reshaping lines
 * those patterns depend on. The nonce line is inserted beside an existing
 * plain env entry so it inherits that entry's indentation.
 */
export function withRedeployNonce(text: string, nonce: string): string {
  const existing = new RegExp(`^(\\s*)- ${REDEPLOY_NONCE_ENV}=.*$`, "m");
  if (existing.test(text)) {
    return text.replace(existing, (_m, indent: string) => `${indent}- ${REDEPLOY_NONCE_ENV}=${nonce}`);
  }
  const anchor = /^(\s*)- [A-Z][A-Z0-9_]*=.*$/m.exec(text);
  if (!anchor) throw new Error("SDL has no plain env entry to anchor the redeploy nonce to");
  return text.replace(anchor[0], `${anchor[0]}\n${anchor[1]}- ${REDEPLOY_NONCE_ENV}=${nonce}`);
}

/**
 * Force a provider to re-create a component's container.
 *
 * A deployment can sit at the right manifest while the container the provider
 * actually runs was never re-created from it — the two are separate facts, and
 * once they diverge nothing notices, because every convergence check compares
 * the chain against the launcher and sees them agree. That is not a state the
 * fleet can be argued out of: an identical PUT is refused ("nothing to
 * redeploy"), and signalling the process is useless where it is the
 * container's PID 1 and the kernel drops signals init does not handle.
 *
 * So make the manifest genuinely new. The nonce exists only to change the
 * hash; the redeploy it forces is what re-applies whatever env had gone stale.
 * Seen live: a sentry running a tunnel aimed at the address it had itself been
 * given, peering with itself, while chain and launcher both read as correct.
 */
export function forceRedeploySteps(
  opId: number,
  params: ForceRedeployParams,
  _spec: LaunchSpec,
): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const key = params.key;
  return [
    {
      name: p("redeploy"),
      async run(ctx) {
        const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
        const row = componentRow(ctx, key);
        if (row.state !== "active") {
          throw new Error(`${key} is ${row.state}: relaunch it instead of forcing a redeploy`);
        }
        const sdlPath = sdlPathFor(ctx, key);
        // pinnedValue: a re-run must reuse the nonce it already signed for,
        // or the step would sign a fresh manifest on every retry and never
        // agree with the version the operator just approved
        const nonce = await pinnedValue(ctx, `${p("redeploy")}.nonce`, async () =>
          String(Math.floor(Date.now() / 1000)),
        );
        const text = withRedeployNonce(fs.readFileSync(sdlPath, "utf8"), nonce);
        fs.writeFileSync(sdlPath, text);
        const artifacts = sdlArtifacts(loadSdl(sdlPath));
        fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
        ctx.log(`${key}: redeploying at nonce ${nonce}`);
        await updateOnChainAndPush(ctx, owner, loadCert(ctx), p("redeploy"), [
          { row, hash: Buffer.from(artifacts.hash).toString("base64"), manifestJson: artifacts.manifestJson },
        ]);
        ctx.db.setFleetOpStatus(opId, "done");
        return { key, nonce };
      },
    },
  ];
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
 * Most of today's passes serve one failure: a component's mesh address moved
 * and the fleet kept dialing the old one. The last one serves another, a
 * chain node that has stopped following the chain and cannot restart itself.
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
 * And one pass that holds no address at all:
 *
 *  - **wedged**: a node whose consensus state machine has died. It answers
 *    every check above — active lease, funded escrow, right address, live
 *    RPC — while no longer following the chain, and only a restart revives
 *    it.
 *
 * So: a component already pointing at the current address is left alone, its
 * container is never restarted, and a re-run of a finished op does nothing.
 */
/**
 * Bring every node's minimum-gas-prices to the spec's, everywhere it lives:
 * the launcher's node homes (re-packing the bundles a relaunch boots from
 * when one changed) and each live node's app.toml, sentries before
 * validators, restarting only the nodes whose file changed. It is node
 * config, not consensus, so nodes can differ for a moment without harm.
 *
 * Exists because the value drifted three ways at once on the testnet: the
 * spec held a fee pasted into the per-gas field (25000), the live nodes had
 * been hand-corrected to 0.025, and a relaunch booted the July bundle and
 * brought 25000 back on the public sentry.
 */
export async function convergeGasPrice(
  ctx: StepCtx,
  spec: LaunchSpec,
): Promise<{ want: string; homes: string[]; nodes: string[]; unreachable: string[] }> {
  const want = nodeMinGasPrices(spec);
  const homes: string[] = [];
  for (const node of nodes(spec)) {
    const file = path.join(ctx.dirs.node(node.key), "config", "app.toml");
    if (!fs.existsSync(file)) continue;
    const current = fs.readFileSync(file, "utf8");
    const next = applyMinGasPrices(current, want);
    if (next === current) continue;
    fs.writeFileSync(file, next);
    homes.push(node.key);
    ctx.log(`${node.key}: launcher copy minimum-gas-prices ${readMinGasPrices(current) ?? "(unset)"} → ${want}`);
  }
  if (homes.length > 0 && fs.existsSync(ctx.dirs.bundles)) await packageNodeDataStep.run(ctx);

  const rows = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).filter(
    (r) => r.state === "active" && r.ssh_host && /^(sentry|val)-/.test(r.key),
  );
  // sentries first: a validator restart is a pause in signing, keep it last
  rows.sort((a, b) => Number(b.key.startsWith("sentry-")) - Number(a.key.startsWith("sentry-")));
  const changed: string[] = [];
  const unreachable: string[] = [];
  for (const row of rows) {
    const target = rowTarget(ctx, row);
    try {
      if (await patchNodeAppToml(ctx, row.key, target, { minGasPrices: want })) {
        await restartNode(ctx.services.ssh, target);
        changed.push(row.key);
      }
    } catch (e) {
      unreachable.push(row.key);
      ctx.log(`${row.key}: could not converge minimum-gas-prices (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (homes.length === 0 && changed.length === 0 && unreachable.length === 0) {
    ctx.log(`every node already runs minimum-gas-prices ${want}`);
  }
  return { want, homes, nodes: changed, unreachable };
}

/** Params of a "gas-price" op: the new value is already in the spec. */
export interface GasPriceParams {
  minGasPrice: string;
  previous: string;
}

/** Apply a corrected token.minGasPrice to a running fleet (fleet action
 *  "gas price…"): convergeGasPrice, against the spec just stored. */
export function gasPriceSteps(opId: number, spec: LaunchSpec): StepDef[] {
  const name = `op${opId}:converge`;
  return [
    {
      name,
      async run(ctx) {
        const out = await convergeGasPrice(ctx, spec);
        if (out.unreachable.length > 0) {
          throw new Error(
            `could not reach ${out.unreachable.join(", ")} to set minimum-gas-prices ${out.want}: retry once ` +
              "they answer (relaunch converges a node too)",
          );
        }
        ctx.db.setFleetOpStatus(opId, "done");
        return out;
      },
    },
  ];
}

export function repairSteps(opId: number, params: RepairParams, spec: LaunchSpec): StepDef[] {
  const p = (s: string) => `op${opId}:${s}`;
  const meshKeys = [
    ...nodes(spec).map((n) => n.key),
    ...serviceComponents(spec)
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
        // Shared with the steps that restart containers and so invalidate
        // their own way back in (the reset's halt and start).
        const { corrected, unreadable } = await refreshSshEndpoints(
          ctx,
          ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[],
        );
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
            .exec(rowTarget(ctx, row), `tailscale --socket=${meshSocket(ctx, key)} ip -4 2>/dev/null || true`, {
              quick: true,
            })
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
          let text = fs.readFileSync(sdlPath, "utf8");
          const added: string[] = [];
          if (key.startsWith("val-")) {
            // validators placed before the dial-out tunnel existed have no
            // TS_TUNNEL_PEER: give them one, so the peers pass below can
            // point the validator at it and a restart keeps it
            const s = resolveTopology(spec).validatorSentries[Number(key.split("-")[1])]?.[0];
            const sentryIp = s !== undefined ? rows.find((c) => c.key === `sentry-${s}`)?.tailnet_ip : null;
            if (sentryIp && !/TS_TUNNEL_PEER=/.test(text)) {
              text = withValidatorTunnelEnv(text, sentryIp, Boolean(spec.join));
              added.push(`sentry-${s} peer tunnel added`);
            }
          }
          const retarget = retargetTunnelEnv(ctx, spec, key, text);
          for (const c of added) ctx.log(`${key}: ${c}`);
          for (const c of retarget.changes) ctx.log(`${key}: tunnel re-aimed at ${c}`);
          retarget.changes.push(...added);
          if (retarget.changes.length > 0) fs.writeFileSync(sdlPath, retarget.text);
          const artifacts = sdlArtifacts(loadSdl(sdlPath));
          const wantHash = Buffer.from(artifacts.hash).toString("base64");
          const onChain = await ctx.services.api.deploymentInfo(owner, row.dseq);
          // The PUT is unconditional, and deliberately so. Gating it on
          // "something changed this run" cannot work here: the signature
          // pauses the step, and on the re-run the chain already carries the
          // new version, so the very component that needed the push reads as
          // settled and gets skipped — the update lands on-chain and the
          // provider is never told, which is the silent split this step exists
          // to close. Seen live: a sentry left tunnelling to its own address,
          // with chain and launcher both reading as correct. Re-sending a
          // manifest a provider already runs is refused as "nothing to
          // redeploy" and changes nothing, so the only cost of pushing anyway
          // is the request itself.
          fs.writeFileSync(path.join(ctx.dirs.sdl, `${key}.manifest.json`), artifacts.manifestJson);
          pushes.push({ row, json: artifacts.manifestJson });
          // Convergent: an update whose hash already matches is rejected
          // on-chain ("nothing to change") and wedges the signing queue behind
          // a signature that can never succeed, so never sign into that.
          // Beyond it, we sign when we just rewrote the SDL (the manifest is
          // then different by construction) or when the chain positively
          // reports a different version. A chain that reported no version at
          // all is a reason to leave it alone, not to sign blindly — the
          // manifest is pushed either way, and that is what repairs the
          // container.
          if (onChain?.hash === wantHash) continue;
          if (retarget.changes.length === 0 && !onChain?.hash) continue;
          msgs.push({
            typeUrl: TypeUrl.UpdateDeployment,
            value: { id: { owner, dseq: row.dseq }, hash: wantHash },
          });
        }
        if (pushes.length === 0) {
          ctx.log("no meshed component has a tunnel to re-aim");
          ctx.db.deletePendingTx(ctx.launchId, p("mesh-env"));
          return { repointed: [] };
        }
        if (msgs.length > 0) await ctx.requireTx(p("mesh-env"), msgs);
        else ctx.db.deletePendingTx(ctx.launchId, p("mesh-env"));
        const cert = loadCert(ctx);
        for (const { row, json } of pushes) {
          await pushManifest(ctx, cert, row.key, row.host_uri, row.dseq, json);
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
            .exec(target, `grep '^persistent_peers[[:space:]]*=' ${NODE_HOME}/config/config.toml`, {
              quick: true,
            })
            .catch(() => ({ stdout: "" }));
          const line = /^persistent_peers\s*=\s*"(.*)"/m.exec(got.stdout);
          if (!line) continue;
          if (key.startsWith("val-")) {
            const publicP2p: Record<number, string | undefined> = {};
            for (const s of resolveTopology(spec).validatorSentries[Number(key.split("-")[1])] ?? []) {
              const ep = await sentryPublicP2p(ctx, s).catch(() => undefined);
              publicP2p[s] = ep ? `${ep.host}:${ep.port}` : undefined;
            }
            const problem = validatorPeersProblem(spec, key, line[1] ?? "", nodeIds, publicP2p);
            if (problem) {
              // not an address to re-aim but a line to rebuild: write it the
              // way a fresh launch would (public endpoint first, else the
              // dial-out tunnel mesh-env just made sure the SDL carries)
              ctx.log(`${key}: ${problem}; rewiring its peers`);
              const wired = await wireValidatorPeers(
                ctx,
                key,
                target,
                (s) => rows.find((c) => c.key === `sentry-${s}`)?.tailnet_ip,
                (s) => sentryPublicP2p(ctx, s),
              );
              ctx.log(`${key}: persistent_peers = "${wired.peers}"`);
              await restartNode(ctx.services.ssh, target);
              repaired.push(key);
              continue;
            }
          }
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
          // Anchor on the assignment. `^persistent_peers.*` also matches
          // CometBFT's persistent_peers_max_dial_period, twenty lines further
          // down the [p2p] section, and rewriting THAT line to a second
          // `persistent_peers = "..."` leaves a config the node refuses to
          // parse at all ("toml: key persistent_peers is already defined") —
          // it exits before it can tell anyone why. Seen live on a validator.
          await ctx.services.ssh.exec(
            target,
            `sed -i 's|^persistent_peers[[:space:]]*=.*|persistent_peers = "${next}"|' ` +
              `${NODE_HOME}/config/config.toml`,
          );
          // a peer change only takes effect on a restart of the process
          await restartNode(ctx.services.ssh, target);
          repaired.push(key);
        }
        if (repaired.length === 0) ctx.log("every peer entry already names its node's current address");
        return { repaired };
      },
    },
    {
      name: p("gas-price"),
      async run(ctx) {
        // node config drifts quietly (hand edits, a relaunch from an old
        // bundle): every node back to the spec's minimum-gas-prices
        return convergeGasPrice(ctx, spec);
      },
    },
    {
      name: p("mesh-peers"),
      async run(ctx) {
        // sentries that refuse a second mesh peer (acceptMeshPeers): only
        // those change and restart, one at a time
        const fixed: string[] = [];
        const unreachable: string[] = [];
        for (const r of ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]) {
          if (!r.key.startsWith("sentry-") || r.state !== "active") continue;
          try {
            if (await acceptMeshPeers(ctx, rowTarget(ctx, r), { restart: true })) {
              fixed.push(r.key);
              ctx.log(`${r.key}: now accepts several mesh peers (allow_duplicate_ip = true); restarted`);
            }
          } catch {
            unreachable.push(r.key);
          }
        }
        return { fixed, ...(unreachable.length > 0 ? { unreachable } : {}) };
      },
    },
    {
      name: p("dns"),
      async run(ctx) {
        // DNS that drifted from the leases (a record edited by hand, a move
        // whose DNS pause was skipped): with the launcher's token, every
        // public domain that does not answer is pointed at where its
        // component runs now. Domains that answer are left alone, so a
        // record pointed elsewhere on purpose stays.
        if (!ctx.services.dns) return { skipped: "no DNS token" };
        const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
        const row = (k: string) => rows.find((r) => r.key === k && r.state === "active");
        const fixed: string[] = [];
        const dark = async (url: string) => !(await ctx.services.rpc.httpOk(url));
        for (const c of serviceComponents(spec)) {
          const r = row(c.key);
          if (!r || !c.domain) continue;
          const probes = descriptorFor(c.key)?.ingress?.(spec) ?? [{ domain: c.domain, healthUrl: `https://${c.domain}/` }];
          for (const pr of probes) {
            if (!(await dark(pr.healthUrl))) continue;
            const target = await ingressHost(ctx, r.host_uri, r.dseq, 1, 1, pr.domain).catch(() => undefined);
            if (target) fixed.push(...(await pointDns(ctx, [{ domain: pr.domain, target }])));
          }
        }
        const s0 = row("sentry-0");
        const endpoints = [];
        for (const d of sentryPublicDomains(spec)) if (await dark(d.url)) endpoints.push(d);
        if (s0 && endpoints.length > 0) {
          const status = await ctx.services.provider.leaseStatus(loadCert(ctx), s0.host_uri, s0.dseq, 1, 1).catch(() => undefined);
          if (status) fixed.push(...(await pointOrigins(ctx, publicEndpointRecords(status, endpoints))));
        }
        const hs = row("headscale");
        const hsDomain = isServicesFleet(spec) || spec.topology.headscale.reuseFleet ? undefined : headscaleDomain(spec);
        if (hs && hsDomain && (await dark(`https://${hsDomain}/health`))) {
          const target = await ingressHost(ctx, hs.host_uri, hs.dseq, 1, 1, hsDomain).catch(() => undefined);
          if (target) fixed.push(...(await pointDns(ctx, [{ domain: hsDomain, target }])));
        }
        if (fixed.length > 0) ctx.log(`repair: DNS repointed for ${fixed.join(", ")}`);
        return { repointed: fixed };
      },
    },
    {
      name: p("wedged"),
      async run(ctx) {
        // A chain node can stop following the chain while every check above
        // it passes: the lease is active, the escrow is funded, the mesh
        // address is right, the RPC answers. CometBFT's consensus state
        // machine exits on a panic — a block whose parent is not the one the
        // node committed, say — and takes nothing else with it. The RPC, the
        // reactor's gossip routines and the peer connections all stay up, so
        // the node reports itself caught up at the height it died on, and
        // because `catching_up` is false it reads as healthy everywhere.
        //
        // It cannot recover on its own. Nothing drains the consensus queue
        // once its reader is gone, so the queue fills, every peer's receive
        // routine blocks on it, and the node stops reading its sockets
        // entirely — which its peers see as a ping timeout and answer by
        // reconnecting, forever. Only a restart rebuilds the state machine,
        // and on the way back up the node block-syncs from where it stopped.
        //
        // Restarting is therefore the whole repair, and the test for who
        // needs it is the same contradiction the health monitor flags: a
        // node claiming to be caught up while sitting well below the head.
        // Nothing to compare against means nothing to do, so a fleet whose
        // nodes all agree — including one that has genuinely halted — is
        // left alone.
        const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
        const live: { key: string; row: FleetComponentRow; height: number; catchingUp: boolean }[] = [];
        for (const key of nodes(spec).map((n) => n.key)) {
          const row = rows.find((c) => c.key === key);
          if (!row || row.state !== "active" || !row.ssh_host) continue;
          const got = await ctx.services.ssh
            .exec(rowTarget(ctx, row), "wget -qO- http://127.0.0.1:26657/status", { quick: true })
            .catch(() => ({ stdout: "" }));
          const height = Number(/latest_block_height."?:?"?(\d+)/.exec(got.stdout)?.[1]);
          if (!Number.isFinite(height)) {
            ctx.log(`${key}: RPC not answering, leaving it for the health monitor`);
            continue;
          }
          live.push({
            key,
            row,
            height,
            catchingUp: /catching_up"?:?"?(\w+)/.exec(got.stdout)?.[1] === "true",
          });
        }
        const head = Math.max(0, ...live.map((n) => n.height));
        const restarted: string[] = [];
        for (const n of live) {
          if (n.catchingUp || head - n.height <= STALLED_BEHIND_BLOCKS) continue;
          ctx.log(
            `${n.key}: stopped at height ${n.height}, ${head - n.height} behind the fleet ` +
              `(head ${head}) while reporting itself caught up — restarting it`,
          );
          await restartNode(ctx.services.ssh, rowTarget(ctx, n.row));
          restarted.push(n.key);
        }
        if (restarted.length === 0) ctx.log("every chain node is following the chain");
        ctx.db.setFleetOpStatus(opId, "done");
        return { restarted };
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
  const all: StepDef[] = [];
  const done = new Set(db.listSteps(launchId).filter((s) => s.status === "done").map((s) => s.name));
  for (const op of db.listFleetOps(launchId) as FleetOpRow[]) {
    if (op.status !== "active" && op.status !== "done") continue;
    if (!wanted(op.kind)) continue;
    const steps: StepDef[] = [];
    // done ops keep their steps in the list — checkpointed rows skip instantly
    const params = JSON.parse(op.params_json);
    if (op.kind === "relaunch") {
      steps.push(
        ...(params.key === "headscale"
          ? headscaleRelaunchSteps(op.id, params, spec)
          : relaunchSteps(op.id, params, spec)),
      );
    }
    if (op.kind === "add-component") steps.push(...addComponentSteps(op.id, params, spec));
    if (op.kind === "relink") steps.push(...relinkSteps(op.id, spec));
    if (op.kind === "public-grpc") steps.push(...publicGrpcSteps(op.id));
    if (op.kind === "gas-price") steps.push(...gasPriceSteps(op.id, spec));
    if (op.kind === "mesh-backup") steps.push(...meshBackupSteps(op.id, spec));
    if (op.kind === "add-sentry") steps.push(...addSentrySteps(op.id, params as AddSentryParams, spec));
    if (op.kind === "data-backup") steps.push(...dataBackupSteps(op.id, params as DataBackupParams, spec));
    if (op.kind === "data-restore") steps.push(...dataRestoreSteps(op.id, params as DataRestoreParams, spec));
    if (op.kind === "relayer-paths") steps.push(...relayerPathsSteps(op.id, params, spec));
    if (op.kind === "sessions") steps.push(...sessionsSteps(op.id, params, spec));
    if (op.kind === "reconfigure") steps.push(...reconfigureSteps(op.id, params, spec));
    if (op.kind === "mastodon-resize") steps.push(...mastodonResizeSteps(op.id, params, spec));
    if (op.kind === "node-resize") steps.push(...nodeResizeSteps(op.id, params, spec));
    if (op.kind === "upgrade") steps.push(...upgradeSteps(op.id, params, spec));
    if (op.kind === "halt-upgrade") steps.push(...haltUpgradeSteps(op.id, params, spec));
    if (op.kind === "retarget") steps.push(...retargetSteps(op.id, params, spec));
    if (op.kind === "reset-chain") steps.push(...resetChainSteps(op.id, params, spec));
    if (op.kind === "unjail") steps.push(...unjailSteps(op.id, params, spec));
    if (op.kind === "resume-signing") steps.push(...resumeSigningSteps(op.id, params, spec));
    if (op.kind === "restore-archive") steps.push(...restoreArchiveSteps(op.id, params));
    if (op.kind === "repair") steps.push(...repairSteps(op.id, params, spec));
    if (op.kind === "force-redeploy") steps.push(...forceRedeploySteps(op.id, params, spec));
    // ...but only the steps it ran. Rebuilt from today's spec, a done op can
    // take another shape (its component since removed from the spec turns a
    // service relaunch into a node one, 2026-09-28), and a step it never had
    // would run now, long after the op finished
    all.push(...(op.status === "done" ? steps.filter((st) => done.has(st.name)) : steps));
  }
  return all;
}
