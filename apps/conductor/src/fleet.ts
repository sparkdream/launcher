import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { fromBech32 } from "@cosmjs/encoding";
import {
  chainId,
  COMPONENT_KEYS,
  COMPONENT_KINDS,
  SERVICES_FLEET_COMPONENTS,
  frozenResetViolations,
  isComponentKey,
  componentDomain,
  isServicesFleet,
  minGasPriceProblem,
  NODE_SIZES,
  nodeResources,
  nodeRole,
  nodeSize,
  fleetBridge,
  imageBefore,
  mastodonLoginDomain,
  mastodonStreamingDomain,
  profiles,
  versionTag,
  resolveTopology,
  serviceComponents,
  validateSpec,
  withDefaults,
  type LaunchSpec,
  type LaunchSpecInput,
  type NodeSize,
  type RoleResources,
  type RelayerPath,
} from "@sparkdream/launch-spec";
import { descriptorFor } from "./components/index.js";
import { peerProgress, type PeerSetup } from "./peering.js";
import { publicRelayEndpointStale, publicRelayFleets, RELAYER_ACCOUNT, relayerTunnels, resolveRelayCounterparty } from "./relayer.js";
import {
  cosmjsWithdraw,
  lowFundsDetail,
  ownerAddressOn,
  relayerFunds,
  withdrawRelayerFunds,
  type RelayerFunds,
  type WithdrawDeps,
} from "./relayer-funds.js";

/** Automatic recovery attempts per component per 24 hours before it gives up and alerts. */
const AUTO_ATTEMPTS_PER_DAY = 2;

/** How long an automatic restart gets to bring a component back before its container is re-created. */
export const RESTART_GRACE_MS = 5 * 60_000;

/** Run inside the headscale container: "answers", "wedged" (running, its listener silent) or "gone". */
export const HEADSCALE_SELF_CHECK =
  "if wget -qO- -T5 http://127.0.0.1:8080/health >/dev/null 2>&1; then echo answers; " +
  "elif pidof headscale >/dev/null; then echo wedged; else echo gone; fi";

/**
 * Restart headscale by signalling headscale itself, not PID 1. With a mesh
 * backup PID 1 is litestream, which handles one SIGTERM by waiting on
 * headscale and then ignores every later signal: on 2026-10-07 headscale
 * took 18 minutes to shut down (its long-poll handlers panicking on a closed
 * channel), litestream never exited after it, and the container was never
 * re-created. A headscale that ignores the TERM is killed 20s later; its
 * exit ends litestream's -exec, which ends the container. Whatever is still
 * down after RESTART_GRACE_MS is re-created by a force redeploy.
 */
export const HEADSCALE_RESTART =
  "pkill -TERM -x headscale || kill 1; " +
  "setsid sh -c 'sleep 20; pkill -KILL -x headscale' </dev/null >/dev/null 2>&1 &";

/** Which components auto-recovery may act on, per fleet (all off by default). */
export interface AutoRecoverPolicy {
  enabled: boolean;
  validators: boolean;
  sentries: boolean;
  headscale: boolean;
  services: boolean;
}
const DEFAULT_AUTO_RECOVER: AutoRecoverPolicy = {
  enabled: false,
  validators: true,
  sentries: true,
  headscale: true,
  services: true,
};

export interface UnattendedStatus {
  /** the conductor can query and sign on Akash at all */
  available: boolean;
  /** the launcher's key the wallet grants to */
  grantee: string;
  settings: UnattendedSettings;
  /** null: could not be read */
  grants: GrantInfo[] | null;
  allowance: AllowanceInfo | null;
  /** why the allowance cannot pay unattended fees (granted in the wrong denom, expired, missing) */
  allowanceProblem: string | null;
  spentToday: string;
  /** msg types a full grant covers */
  covers: string[];
}

/** Consecutive monitor checks (45s apart) without a signer session before a restart. */
const SIGNER_WATCH_MISSES = 3;
const SIGNER_WATCH_COOLDOWN_MS = 10 * 60_000;

export interface LocalSignerView {
  /** this launcher can manage a signer on its own machine at all */
  available: boolean;
  validators: {
    key: string;
    managed: boolean;
    /** unmanaged, but a tmkms process on this machine signs for it */
    adoptable: boolean;
    unit: string | null;
    active: boolean | null;
    config: string | null;
    /** the addr the managed config points at */
    addr: string | null;
    addrMatches: boolean | null;
    lastAction: { at: string; what: string } | null;
    /** where the managed signer runs: "this machine" or the SSH alias */
    machine: string | null;
  }[];
}

/** How often the monitor reads the relayer's balances. */
const RELAYER_FUNDS_EVERY_MS = 15 * 60_000;
/** How often a settled fleet's mesh is swept for leftover nodes. */
const MESH_STRAY_EVERY_MS = 10 * 60_000;
import { checkVerifierAccount, resolveVerifierTarget } from "./verifier.js";
import { bridgeDependents, mayUseFleet, resolveBridgeTarget } from "./bridge-target.js";
import { resolveSmtpPasswordSource } from "./services-spec.js";
import { replaceRerunSteps } from "./services-steps.js";
import { readMastodonSecrets, stashSmtpPassword } from "./components/mastodon-secrets.js";
import { readNtfySecrets } from "./components/ntfy.js";

/** The accounts-panel entry for the Mastodon instance's Owner. */
const MASTODON_OWNER = "mastodon-owner";
/** Blocks per second a node replays at, before the fleet has measured its own (devnet, 2026-10). */
const SYNC_RATE_DEFAULT = 5;
/** A latest chain-data backup older than this is alerted (a moved node replays everything since). */
const BACKUP_STALE_DAYS = 7;

/** "40 minutes", "8.5 hours", "2 days". */
function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** The fleet card's add dialog: what can be added, at what estimated cost (FleetService.addOptions). */
export interface AddOptions {
  kinds: Array<{
    key: string;
    label: string;
    summary: string;
    version?: string;
    needsDomain: boolean;
    lowUsd?: number;
    highUsd?: number;
    signatures: number;
    steps: string[];
  }>;
  sentry?: {
    name: string;
    have: number;
    signatures: number;
    sizes: Array<{ id: "small" | "standard" | "large"; cpu: number; memory: string; data: string; lowUsd: number; highUsd: number }>;
    steps: string[];
    scratchSync?: { blocks: number; blocksPerSecond: number; hours: number; reason: string };
  };
}

/** The accounts-panel entry for the ntfy app's login (its "mnemonic" is the password). */
const NTFY_LOGIN = "ntfy-login";
import { relayerStatePath, type RelayerLinkOutput } from "./steps/relayer-link.js";
import {
  grantHolds,
  readSessions,
  sessionChainLaunch,
  sessionRoles,
  sessionsDue,
  sessionSummary,
  type SessionRole,
} from "./sessions.js";
import type { ConductorDb, FleetComponentRow, FleetOpProgress, FleetOpRow, IncidentRow, LaunchRow } from "./db.js";
import { launchDirs } from "./engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import { accountDepositMsg, closeDeploymentMsg } from "./akash/messages.js";
import type { OfferedBid } from "./akash/policy.js";
import { bpsAmount, feeCoin, feeConfig } from "./fee.js";
import { NODE_HOME, restartNode, rpcUrl, stalled } from "./node-ops.js";
import { meshSocketFromSdl, sweepMeshStrays } from "./mesh-strays.js";
import { sparkdreamd } from "./exec.js";
import { resolveChainAssets, runWithAssets } from "./chain-assets/index.js";
import { valoperAddress } from "./gentx.js";
import { PRICING_DENOM } from "./render-sdl.js";
import type { Services } from "./services.js";
import { copySecretsDecrypted, copySecretsEncrypted, readSecretFile, writeSecretFile } from "./secrets.js";
import { toSsh2CompatiblePrivateKey } from "./keys.js";
import { extractForwardedPort, headscaleBackupPath, providerUnreachable, resolveS3Secret, templateHeadscaleSdl, type Assignments, type DeploymentPlan, type HeadscaleOutput, type SshEndpoints } from "./steps/phase-bcd.js";
import { canonicalGenesisSha256 } from "./steps/join.js";
import { serviceIngressHost } from "./steps/phase-ef.js";
import { dependentFleets } from "./headscale-reuse.js";
import { AUTO_BID, consensusAddress, imageRepo, sentryPublicDomains } from "./fleet-ops.js";
import {
  keepPreviousS3Secret,
  markMeshBackupUnverified,
  meshBackupUnverified,
  S3_SECRET_FILE,
  undoMeshBackup,
  type MeshBackupParams,
} from "./mesh-backup.js";
import { removeSentry, undoAddSentry, type AddSentryParams } from "./add-sentry.js";
import {
  autoRestoreEnabled,
  backupSource,
  dataBackups,
  restoreBlocker,
  dataBackupStorage,
  lastDataBackup,
  latestRestorable,
  lastDataBreak,
  deleteDataBackup,
  type DataBackupParams,
  type DataRestoreParams,
  type DataBackupRecord,
} from "./data-backup.js";
import { HANDOVER_STEPS, UNRETIRE_CMD, type NodeResizeParams } from "./node-resize.js";
import { estimateComponent, estimateNode, sizeToBytes } from "./estimate.js";
import { cloudflareToken } from "./dns.js";
import {
  depositsOf,
  opsKey,
  recordSpend,
  spentToday,
  allowanceProblem,
  unattendedBlocker,
  unattendedSettings,
  UNATTENDED_FEE_DENOM,
  type AllowanceInfo,
  type GrantInfo,
  type UnattendedSettings,
} from "./unattended.js";
import { UNATTENDED_MSG_TYPES, unattendedGrantMsgs, unattendedRevokeMsgs, type Msg } from "@sparkdream/akash-tx";
import {
  alertFor,
  alertSettings,
  sendAlert,
  trackIncident,
  type IncidentEvent,
  type ProviderProbe,
} from "./incidents.js";
import {
  adoptSigner,
  candidateFor,
  clearBinding,
  hostFor,
  resolveSshAlias,
  type RemoteHost,
  type SignerDeps,
  getBinding,
  managedSigner,
  parseTmkmsConfig,
  repointSigner,
  restartSigner,
  signerAddr,
  type LocalSignerBinding,
} from "./local-signer.js";
import { probeSaysConnected, SIGNER_CONNECTED_PROBE } from "./tmkms.js";

import type { AddComponentParams, GasPriceParams, MastodonResizeParams, ReconfigureParams, RelaunchParams, RelayerPathsParams, ResetChainParams, RetargetParams, UpgradeParams, HaltUpgradeParams } from "./fleet-ops.js";

/**
 * Fleet layer (M5, §5 day-2): wallet-scoped read-model reconciled against
 * the chain, background health monitor, and per-component actions. Owner
 * scoping note: until wallet-session auth lands (M6), the owner address
 * arrives as a request parameter — the §2 session rule replaces that.
 */

/**
 * How far a chain node may sit below the fleet's head while still calling
 * itself caught up (see {@link FleetService.tick}).
 *
 * A node keeping up commits the same blocks as everyone else, so the only
 * spread between two healthy nodes is the skew between their probes — a
 * block or two. The margin is set well above that because the state it
 * catches is not a slow node but a stopped one, which crosses any threshold
 * within a minute and then never comes back.
 */
function stalledDetail(
  status: { height: number },
  head: number,
  details: string[],
): string {
  return details
    .concat(
      `stopped at height ${status.height}, ${head - status.height} behind the fleet ` +
        `(head ${head}), while reporting itself caught up — the node answers RPC but is ` +
        `no longer following the chain. Run repair fleet, which restarts it in place`,
    )
    .join("; ");
}

/**
 * Blocks per day for escrow runway estimation: the spec's commit timeout
 * plus ~2s of propose/vote overhead per block (~6s blocks when unset).
 */
function blocksPerDay(spec: LaunchSpec): number {
  const timeout = spec.chainParams.consensus?.timeoutCommit;
  const blockSeconds = timeout ? Number(timeout.replace(/s$/, "")) + 2 : 6;
  return Math.round(86_400 / blockSeconds);
}

/** Lease-shell service name for a component: chain nodes run the `sparkdreamd`
 *  service, a service component names its own (descriptor.shellService), and
 *  headscale's service is named after its key. */
function leaseServiceName(key: string): string {
  if (key.startsWith("val-") || key.startsWith("sentry-")) return "sparkdreamd";
  return descriptorFor(key)?.shellService ?? key;
}

/** Directory an uploaded file lands in, per component. Node uploads go into
 *  the chain home (where `config/` and `data/` live, so a dropped snapshot or
 *  config file is already beside what reads it); a service component's go
 *  where its kind says (COMPONENT_KINDS uploadDir — a persistent volume, the only
 *  path that survives a container restart). Throws for components that
 *  accept no uploads at all. */
export function uploadDirFor(key: string): string {
  const dir = isComponentKey(key) ? COMPONENT_KINDS[key].uploadDir : undefined;
  if (dir) return dir;
  if (key.startsWith("val-") || key.startsWith("sentry-")) return NODE_HOME;
  throw new Error(`${key} runs no sshd; cannot accept file uploads`);
}

export interface ComponentView {
  key: string;
  dseq: string;
  /** Provider account address (akash1…). */
  provider: string;
  /** Human-readable provider hostname (from its gateway URI). */
  providerName: string;
  /** Akash lease price: micro-denom per block (DecCoin amount string). */
  price: string;
  /** Pricing micro-denom, e.g. "uact" — the price's unit. */
  priceDenom: string;
  /** Escrow balance (deployment funds): micro-denom amount, or null. */
  escrow?: string | null;
  state: string;
  /** Deployed image reference (upgrades update it). */
  image: string | null;
  /** Address on the headscale mesh (100.x), for components that joined it —
   *  null for the headscale server itself and the frontend, which stay off
   *  the tailnet. Re-read live by the repair and relaunch ops. */
  tailnetIp: string | null;
  /** True when the component runs sshd and has a recorded forwarded endpoint —
   *  i.e. the user can push files to it (nodes + explorer; headscale and the
   *  frontend image run no sshd). */
  ssh: boolean;
  /** Chain nodes: the size tier they run at ("custom" when hand-edited
   *  resources match none), which the resize action offers to change. */
  size?: NodeSize | "custom";
  health?: { status: string; detail: string | null; checked_at: string } | undefined;
}

export interface FleetView {
  launchId: string;
  launchStatus: string;
  /** The spec's network name — distinguishes fleets that share a chain id
   *  (e.g. an origin fleet and a joiner on the same chain). */
  name: string;
  /** "chain", or "services" for a fleet of shared components with no chain
   *  (the UI hides chain actions on it). */
  kind: "chain" | "services";
  chainId: string;
  /** softsign | tmkms — the UI gates signer-related actions on this. */
  keyMode: string;
  /** tmkms fleets on a launcher that can run their signer on its own
   *  machine (local-signer.ts): validators whose signer it manages, and
   *  those whose signer runs here unmanaged (the card offers to manage). */
  localSigner?: { managed: string[]; adoptable: string[]; remote: boolean };
  /** Chain fleets with a headscale of their own: where its backup goes, or
   *  null when it has none (the card offers to turn it on). */
  /** verified: false while a mesh-backup op has not yet seen the backup land */
  meshBackup?: { bucket: string; path: string; verified: boolean } | null;
  /** Chain fleets: recorded chain-data backups (newest first) and their schedule. */
  dataBackups?: {
    schedule: "off" | "daily" | "weekly";
    /** relaunched and added nodes start from the latest usable backup */
    autoRestore: boolean;
    /** the chosen "copy from" sentry, null for the automatic pick */
    source: string | null;
    /** the sentry a backup started now would copy */
    sourceNow: string | null;
    /** verified: read back and unpacked after its upload */
    backups: Array<{ name: string; height: number; takenAt: string; from: string; verified: boolean; blocker: string | null }>;
    /** No usable backup: what a moved or added node would replay from block 1
     *  (blocks, the rate it is estimated at, hours). Absent with a usable backup. */
    scratchSync?: { blocks: number; blocksPerSecond: number; hours: number; reason: string };
    /** Age in days of the latest usable backup (absent without one). */
    latestAgeDays?: number;
  };
  /** Which components auto-recovery may act on (off unless turned on). */
  autoRecover: AutoRecoverPolicy;
  /** Confirmed outages (incidents.ts): open ones first, then the latest resolved. */
  incidents: Array<{
    id: number;
    component: string;
    status: string;
    cause: string;
    /** fleet action that fixes it (the card's restore button), if any */
    action: string | null;
    detail: string | null;
    openedAt: string;
    closedAt: string | null;
  }>;
  /** Chain fleets: token.minGasPrice (per gas unit, base denom), and why it
   *  is implausible when it is (a fee pasted into the per-gas field). */
  minGasPrice?: string;
  gasDenom?: string;
  gasPriceProblem?: string;
  components: ComponentView[];
  ops: Array<{
    id: number;
    kind: string;
    status: string;
    params: unknown;
    /** Live position of a long op (archive replay); absent for the rest. */
    progress?: FleetOpProgress;
  }>;
  /** Placements the launch itself is holding for a manual bid pick (§6.6).
   *  Op-made placements carry theirs on the op's params instead. */
  bidPicks: Array<{ key: string; dseq: string; bids: OfferedBid[] }>;
  /** The daemons' session keys (§5 session keys): grants, never the keys. */
  sessions: ReturnType<typeof sessionSummary>;
}

export interface FleetSummary {
  fleets: FleetView[];
  /** On-chain deployments this launcher has no record of (§2). */
  unmanaged: Array<{ dseq: string; state: string }>;
}

export interface PendingTxOrigin {
  /**
   * Plain-language account of what put this signature request in the queue.
   * The step name alone ("fleet:close:27846438") does not tell a user which
   * button produced it, and the banner is often read long after the click.
   */
  origin: string;
  /**
   * fleet-action — a standalone request (close, shutdown, top-up); dismissing
   * it cancels the action outright.
   * launch-step — the launch engine is blocked on it; dismissing clears the
   * banner, but the step re-enqueues an equivalent tx on the next resume,
   * so the way to stop it for good is aborting the op or the launch.
   */
  kind: "fleet-action" | "launch-step";
}

/** Explain a queued signature request so it can be dismissed knowingly. */
export function describePendingTx(
  db: ConductorDb,
  launchId: string,
  step: string,
): PendingTxOrigin {
  if (step === "fleet:shutdown") {
    return { kind: "fleet-action", origin: "the fleet shutdown you requested" };
  }
  const fleetAction = /^fleet:(close|topup):(.+)$/.exec(step);
  if (fleetAction) {
    const action = fleetAction[1]!;
    const dseq = fleetAction[2]!;
    const component = db.getFleetComponentByDseq(launchId, dseq);
    const what = component ? `${component.key} (dseq ${dseq})` : `deployment ${dseq}`;
    return {
      kind: "fleet-action",
      origin:
        action === "topup"
          ? `a deposit top-up for ${what}`
          : component
            ? `closing ${what}, from its close or re-place action`
            : // no component row owns this dseq: an abandoned op's deployment,
              // whose close requestAbortOp enqueues to refund the escrow
              `closing ${what}, the deployment left behind by an abandoned operation`,
    };
  }
  const opStep = /^op(\d+):(.+)$/.exec(step);
  if (opStep) {
    const opId = opStep[1]!;
    const name = opStep[2]!;
    const op = db.listFleetOps(launchId).find((o) => o.id === Number(opId));
    return {
      kind: "launch-step",
      origin: op
        ? `the ${op.kind} operation (#${opId}), at its ${name} step`
        : `operation #${opId}, at its ${name} step`,
    };
  }
  return { kind: "launch-step", origin: `the launch's ${step} step` };
}

/** A chain node's height, as the fleet panel shows it. `source: "node"` is
 *  the node's own RPC; `"chain"` is the chain's view through a sentry, for a
 *  validator whose provider could not be reached (`providerError`), with
 *  `signed` telling whether it signed the latest commit. */
export interface NodeHeight {
  height: number;
  catchingUp: boolean;
  source: "node" | "chain";
  signed?: boolean;
  providerError?: string;
}

/** A chain node's data volume (the persistent mount at the node home). */
export interface NodeDisk {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** 0-100, as df reports it (used of used + available). */
  percentUsed: number;
  checkedAt: string;
}

/**
 * Parse `df -Pk <dir>` (POSIX format, 1 KiB blocks): the last line is the
 * filesystem holding the directory. Undefined when the output is not df's.
 */
export function parseDf(stdout: string): Omit<NodeDisk, "checkedAt"> | undefined {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const m = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(line);
  if (!m) return undefined;
  const [total, used, free] = [m[1], m[2], m[3]].map((n) => Number(n) * 1024) as [number, number, number];
  return { totalBytes: total, usedBytes: used, freeBytes: free, percentUsed: Number(m[4]) };
}

/** CometBFT consensus address (uppercase hex) of a base64 ed25519 pubkey. */
export { consensusAddress };

/** The Mastodon settings a running instance can change (settings action). */
export interface MastodonSettings {
  registrations?: "open" | "approved" | "none";
  walletLogin?: Record<string, unknown>;
}

/**
 * The components one fleet op works on, from its params; undefined when it
 * may touch any (a chain reset, a fleet-wide upgrade, a repair).
 */
function opComponents(op: FleetOpRow): string[] | undefined {
  let p: { key?: unknown; keys?: unknown; components?: unknown; source?: unknown };
  try {
    p = JSON.parse(op.params_json);
  } catch {
    return undefined;
  }
  switch (op.kind) {
    case "relink":
    case "relayer-paths":
      return ["relayer"];
    case "public-grpc":
      return ["sentry-0"];
    case "mesh-backup":
      return ["headscale"];
  }
  const keys = [p.key, ...(Array.isArray(p.keys) ? p.keys : []), ...(Array.isArray(p.components) ? p.components : []), p.source]
    .filter((k): k is string => typeof k === "string");
  return keys.length > 0 ? keys : undefined;
}

export class FleetService {
  /** Last hourly on-chain look at each fleet's session grants. */
  private readonly sessionChecks = new Map<string, number>();
  private readonly meshStrayChecks = new Map<string, number>();
  /** Last look at each relayer's balances, and the low keys it found. */
  private readonly relayerFundChecks = new Map<string, { at: number; low: string[] }>();
  /** How a relayer withdrawal reaches a chain; tests swap in a fake. */
  withdrawDeps: WithdrawDeps = cosmjsWithdraw;

  constructor(
    private readonly db: ConductorDb,
    private readonly services: Services,
    private readonly workRoot: string,
  ) {}

  private spec(launch: LaunchRow): LaunchSpec {
    return withDefaults(JSON.parse(launch.spec_json));
  }

  /**
   * Populate fleet_components from the launch's step outputs. Idempotent
   * per component (inserts DO NOTHING on conflict): components appear as
   * their outputs land mid-launch — an early materialization must not stop
   * later ones (headscale exists steps before the nodes do).
   */
  materialize(launchId: string): void {
    const launch = this.db.getLaunch(launchId);
    const spec = launch ? this.spec(launch) : undefined;
    const hs = this.db.stepOutput<HeadscaleOutput>(launchId, "deploy-headscale");
    const plan = this.db.stepOutput<{ perNode: Record<string, { dseq: string }> }>(
      launchId,
      "create-deployments",
    );
    const assignments = this.db.stepOutput<Assignments>(launchId, "collect-bids");
    const ssh = this.db.stepOutput<SshEndpoints>(launchId, "send-manifests");
    const mesh = this.db.stepOutput<{ ips: Record<string, string> }>(launchId, "await-mesh");
    if (hs && !hs.reused) {
      // adopt a redeployed headscale the same way as the node batch below
      const hsRow = this.db.listFleetComponents(launchId).find((c) => c.key === "headscale");
      if (hsRow && Number(hs.dseq) > Number(hsRow.dseq)) {
        this.db.updateComponentPlacement(launchId, "headscale", {
          dseq: hs.dseq,
          provider: hs.provider,
          host_uri: hs.hostUri,
          price: hs.price,
          generation: hsRow.generation,
        });
      }
      this.db.upsertFleetComponent({
        launch_id: launchId,
        key: "headscale",
        dseq: hs.dseq,
        provider: hs.provider,
        host_uri: hs.hostUri,
        price: hs.price,
        state: "active",
        // no sshd in the headscale image — it's managed via lease-shell
        ssh_host: null,
        ssh_port: null,
        image: spec?.images.headscale ?? null,
      });
      // rows from launches materialized before the image column carried
      // headscale need the backfill (upserts DO NOTHING on conflict)
      this.db.backfillComponentEndpoints(launchId, "headscale", {
        image: spec?.images.headscale ?? null,
      });
    }
    if (plan && assignments) {
      // stateless components deploy in the same batch as the nodes but run
      // their own images
      const componentImages = new Map<string, string>(
        spec ? serviceComponents(spec).map((c) => [c.key, c.image]) : [],
      );
      const existing = new Map(
        this.db.listFleetComponents(launchId).map((c) => [c.key, c]),
      );
      for (const [key, entry] of Object.entries(plan.perNode)) {
        const a = assignments.perNode[key];
        if (!a) continue;
        // a service component deployed at launch and removed since
        // (removeComponent): the spec no longer enables it, so its launch
        // outputs must not bring the row back
        if (spec && !/^(val|sentry)-/.test(key) && !componentImages.has(key)) continue;
        // stale-bid recovery and the mid-launch re-place both redeploy inside
        // the launch: the step outputs then carry a NEW dseq while the row
        // holds the closed old placement (upsert is DO NOTHING). Adopt the
        // newer one, ordered by dseq — the deployment's creation height, the
        // only clock the launch and the relaunch ops share. A relaunch op
        // writes the row ahead of these outputs, so its placement has the
        // higher dseq and is never clobbered by them; generation counts the
        // component's moves and is not that clock (a generation-3 row was
        // stuck on a dead deployment because only generation-0 rows adopted).
        const row = existing.get(key);
        if (row && Number(entry.dseq) > Number(row.dseq)) {
          this.db.updateComponentPlacement(launchId, key, {
            dseq: entry.dseq,
            provider: a.provider,
            host_uri: a.hostUri,
            price: a.price,
            generation: row.generation,
          });
          // endpoints belong to the placement: a fresh lease means a fresh
          // forwarded SSH port, and the new container joins the mesh under a
          // new tailnet IP. COALESCE-style backfill would keep the dead ones.
          this.db.updateComponentRuntime(launchId, key, {
            ...(ssh?.perNode[key] ? { ssh_host: ssh.perNode[key]!.host, ssh_port: ssh.perNode[key]!.port } : {}),
            ...(mesh?.ips[key] ? { tailnet_ip: mesh.ips[key]! } : {}),
          });
        }
        this.db.upsertFleetComponent({
          launch_id: launchId,
          key,
          dseq: entry.dseq,
          provider: a.provider,
          host_uri: a.hostUri,
          price: a.price,
          state: "active",
          ssh_host: ssh?.perNode[key]?.host ?? null,
          ssh_port: ssh?.perNode[key]?.port ?? null,
          tailnet_ip: mesh?.ips[key] ?? null,
          image: componentImages.get(key) ?? spec?.images.sparkdreamd ?? null,
        });
        // A tailnet IP belongs to a container, not to a component: the mesh
        // hands out a new one every time a fresh container registers. When
        // the row and the outputs name the SAME deployment, the IP await-mesh
        // last read IS that container's, so adopt it — the backfill below
        // only fills nulls and would keep a dead address (seen live: the
        // tmkms checklist offered the previous container's IP after a
        // re-place, and the signer dialed nothing).
        const meshIp = mesh?.ips[key];
        if (row && row.dseq === entry.dseq && meshIp && row.tailnet_ip !== meshIp) {
          this.db.updateComponentRuntime(launchId, key, { tailnet_ip: meshIp });
        }
        // endpoints land in later steps than the row itself
        this.db.backfillComponentEndpoints(launchId, key, {
          ssh_host: ssh?.perNode[key]?.host ?? null,
          ssh_port: ssh?.perNode[key]?.port ?? null,
          tailnet_ip: mesh?.ips[key] ?? null,
          image: componentImages.get(key) ?? spec?.images.sparkdreamd ?? null,
        });
      }
    }
  }

  /**
   * dseq → resolved RPC url + when. `url: null` means the node has no
   * forwarded RPC port (validators aren't publicly exposed) → query
   * localhost RPC over SSH instead. Forwarded ports are stable until redeploy.
   */
  private rpcUrlCache = new Map<string, { url: string | null; at: number }>();

  /** dseq → the provider's last refusal of a validator's in-container probe,
   *  so the UI's frequent polls go straight to the chain's view for a while
   *  instead of each waiting out the provider's timeout. */
  private providerDown = new Map<string, { error: string; at: number }>();
  /** dseq → the height probe in flight: concurrent polls share it. */
  private heightInflight = new Map<string, Promise<NodeHeight | null>>();
  /** Disk reads per dseq: the volume fills over days, so a minute is fresh. */
  private diskCache = new Map<string, { disk: NodeDisk | null; at: number; probe?: Promise<NodeDisk | null> }>();

  /**
   * Current block height of a node's CometBFT RPC — a lightweight probe the
   * UI polls a few times a second for a live-updating indicator, separate
   * from the periodic health sweep.
   *
   * Sentries expose RPC on a forwarded port (direct HTTP). Validators do
   * NOT (they sit behind sentries), so their RPC is read over SSH from
   * inside the container. The resolution is cached so we don't hit the
   * provider on every call.
   */
  /**
   * How full a chain node's data volume is, read with `df` through the
   * provider's lease-shell (the path the height probe uses for validators:
   * about a second, with no SSH timeout to sit through on a provider whose
   * forwarded port is dead). Cached for a minute per deployment.
   */
  async componentDisk(launch: LaunchRow, component: FleetComponentRow): Promise<NodeDisk | null> {
    if (!/^(val|sentry)-/.test(component.key)) return null;
    const cached = this.diskCache.get(component.dseq);
    if (cached?.probe) return cached.probe;
    if (cached && Date.now() - cached.at < 60_000) return cached.disk;
    const probe = this.services.provider
      .shellExec(this.mtlsCreds(launch), component.host_uri, component.dseq, 1, 1, "sparkdreamd", [
        "sh",
        "-c",
        `df -Pk ${NODE_HOME} 2>/dev/null`,
      ])
      .then((r) => {
        const df = parseDf(r.stdout);
        return df ? { ...df, checkedAt: new Date().toISOString() } : null;
      })
      .catch(() => null)
      .then((disk) => {
        this.diskCache.set(component.dseq, { disk, at: Date.now() });
        return disk;
      });
    this.diskCache.set(component.dseq, { disk: cached?.disk ?? null, at: cached?.at ?? 0, probe });
    return probe;
  }

  async componentHeight(launch: LaunchRow, component: FleetComponentRow): Promise<NodeHeight | null> {
    // only chain nodes have an RPC; headscale/explorer/frontend do not
    if (!/^(val|sentry)-/.test(component.key)) return null;
    const inflight = this.heightInflight.get(component.dseq);
    if (inflight) return inflight;
    const probe = this.probeHeight(launch, component).finally(() => this.heightInflight.delete(component.dseq));
    this.heightInflight.set(component.dseq, probe);
    return probe;
  }

  private async probeHeight(launch: LaunchRow, component: FleetComponentRow): Promise<NodeHeight | null> {
    const down = this.providerDown.get(component.dseq);
    if (down && Date.now() - down.at < 60_000) return this.chainView(launch, component, down.error);
    let cached = this.rpcUrlCache.get(component.dseq);
    if (!cached || Date.now() - cached.at > 120_000) {
      let url: string | null = null;
      try {
        const lease = await this.services.provider.leaseStatus(
          this.mtlsCreds(launch),
          component.host_uri,
          component.dseq,
          1,
          1,
        );
        const ep = extractForwardedPort(lease, 26657);
        url = `http://${ep.host}:${ep.port}`;
      } catch {
        url = null; // no forwarded RPC → SSH path
      }
      cached = { url, at: Date.now() };
      this.rpcUrlCache.set(component.dseq, cached);
    }
    try {
      if (cached.url) {
        const s = await this.services.rpc.status(cached.url);
        return { height: s.latestBlockHeight, catchingUp: s.catchingUp, source: "node" };
      }
      // No forwarded RPC (validators): read localhost RPC in-container via
      // the provider lease-shell DIRECTLY (~1s). NOT the SSH runner — its
      // try-SSH-then-fallback path waits the full ~20s SSH timeout on
      // providers whose forwarded port is dead (e.g. jjozzietech).
      const r = await this.services.provider.shellExec(
        this.mtlsCreds(launch),
        component.host_uri,
        component.dseq,
        1,
        1,
        "sparkdreamd",
        ["sh", "-c", "wget -qO- http://127.0.0.1:26657/status 2>/dev/null"],
      );
      const height = Number(/latest_block_height."?:?"?(\d+)/.exec(r.stdout)?.[1]);
      const catchingUp = /catching_up"?:?"?(\w+)/.exec(r.stdout)?.[1] === "true";
      this.providerDown.delete(component.dseq);
      return Number.isFinite(height) ? { height, catchingUp, source: "node" } : null;
    } catch (e) {
      this.rpcUrlCache.delete(component.dseq); // forwarded port / endpoint moved
      // a validator the provider cannot reach into (its API down, the pod
      // restarting) is not necessarily a validator that stopped: say what
      // the chain shows of it instead of showing nothing
      if (!component.key.startsWith("val-")) return null;
      const error = String((e as Error)?.message ?? e).slice(0, 200);
      this.providerDown.set(component.dseq, { error, at: Date.now() });
      return this.chainView(launch, component, error);
    }
  }

  /**
   * A validator as the chain sees it, read through the fleet's sentry: the
   * latest committed height, and whether this validator's signature is in
   * that commit (its consensus address from generate-keys). For when its
   * provider cannot run the in-container probe.
   */
  private async chainView(launch: LaunchRow, component: FleetComponentRow, providerError: string): Promise<NodeHeight | null> {
    const url = await this.sentryRpcUrl(launch).catch(() => null);
    if (!url) return null;
    try {
      const commit = JSON.parse(await this.services.rpc.getText(`${url}/commit`)) as any;
      const header = commit.result?.signed_header ?? commit.signed_header;
      const height = Number(header?.header?.height);
      if (!Number.isFinite(height)) return null;
      const pubkey = this.db.stepOutput<{ consensusPubkeys?: Record<string, string> }>(launch.id, "generate-keys")
        ?.consensusPubkeys?.[component.key];
      const address = pubkey ? consensusAddress(pubkey) : undefined;
      const signatures: Array<{ validator_address?: string; block_id_flag?: number | string }> = header?.commit?.signatures ?? [];
      // block_id_flag 2 = BLOCK_ID_FLAG_COMMIT: it signed this block
      const signed = address
        ? signatures.some((sig) => sig.validator_address === address && Number(sig.block_id_flag) === 2)
        : undefined;
      return { height, catchingUp: false, source: "chain", ...(signed === undefined ? {} : { signed }), providerError };
    } catch {
      return null;
    }
  }

  /** Forwarded RPC URL of the first active sentry (cached), or null. */
  private async sentryRpcUrl(launch: LaunchRow): Promise<string | null> {
    const sentry = this.db
      .listFleetComponents(launch.id)
      .find((c) => c.key.startsWith("sentry-") && c.state === "active");
    if (!sentry) return null;
    let cached = this.rpcUrlCache.get(sentry.dseq);
    if (!cached || Date.now() - cached.at > 120_000) {
      let url: string | null = null;
      try {
        const lease = await this.services.provider.leaseStatus(
          this.mtlsCreds(launch), sentry.host_uri, sentry.dseq, 1, 1,
        );
        const ep = extractForwardedPort(lease, 26657);
        url = `http://${ep.host}:${ep.port}`;
      } catch {
        url = null;
      }
      cached = { url, at: Date.now() };
      this.rpcUrlCache.set(sentry.dseq, cached);
    }
    return cached.url;
  }

  /**
   * Chain-side jailed flag for a validator component. undefined = unknown
   * (RPC unreachable, no operator account, validator never promoted) — the
   * monitor must never report "jailed" on a probe failure.
   */
  private async validatorJailed(
    launch: LaunchRow,
    spec: LaunchSpec,
    key: string,
  ): Promise<boolean | undefined> {
    try {
      const keys = this.db.stepOutput<{ accounts: Record<string, string> }>(
        launch.id,
        "generate-keys",
      );
      const address = keys?.accounts[`op-${key}`];
      if (!address) return undefined;
      const rpc = await this.sentryRpcUrl(launch);
      if (!rpc) return undefined;
      const { stdout } = await runWithAssets(resolveChainAssets(spec, this.workRoot), () =>
        sparkdreamd([
          "query", "staking", "validator", valoperAddress(address),
          "--node", rpc, "--output", "json",
        ]),
      );
      const out = JSON.parse(stdout);
      return Boolean((out.validator ?? out).jailed);
    } catch {
      return undefined; // includes "not found" for a not-yet-promoted joiner
    }
  }

  /** dseq → escrow balance + when. Escrow drains over days, so a short
   *  cache keeps the 5s fleet poll from hitting the LCD every time. */
  private escrowCache = new Map<string, { amount: string | null; at: number }>();

  private async escrowFor(owner: string, dseq: string): Promise<string | null> {
    const cached = this.escrowCache.get(dseq);
    if (cached && Date.now() - cached.at < 20_000) return cached.amount;
    let amount: string | null = null;
    try {
      const coin = await this.services.api.deploymentEscrow(owner, dseq);
      amount = coin?.amount ?? null;
    } catch {
      amount = cached?.amount ?? null; // LCD hiccup → keep last known
    }
    this.escrowCache.set(dseq, { amount, at: Date.now() });
    return amount;
  }

  /** Wallet-scoped fleet view + on-chain reconciliation (§2). */
  async fleetForOwner(owner: string): Promise<FleetSummary> {
    const launches = this.db.listLaunchesByOwner(owner);
    const known = new Set<string>();
    const fleets: FleetView[] = [];

    for (const launch of launches) {
      this.materialize(launch.id);
      const spec = this.spec(launch);
      const health = new Map(
        this.db.listComponentHealth(launch.id).map((h) => [h.component, h]),
      );
      const components = await Promise.all(
        this.db.listFleetComponents(launch.id).map(async (c) => {
          known.add(c.dseq);
          const h = health.get(c.key);
          let providerName = c.provider;
          try {
            providerName = new URL(c.host_uri).hostname;
          } catch {
            // malformed host_uri — fall back to the address
          }
          const escrow = c.state === "closed" ? null : await this.escrowFor(owner, c.dseq);
          return {
            key: c.key,
            dseq: c.dseq,
            provider: c.provider,
            providerName,
            price: c.price,
            priceDenom: PRICING_DENOM[spec.infra.akashNetwork],
            escrow,
            state: c.state,
            image: c.image,
            tailnetIp: c.tailnet_ip,
            ssh: c.ssh_host != null && c.ssh_port != null,
            ...(/^(val|sentry)-\d+$/.test(c.key) ? { size: nodeSize(spec, c.key) } : {}),
            health: h
              ? { status: h.status, detail: h.detail, checked_at: h.checked_at }
              : undefined,
          };
        }),
      );
      // an op's new deployment before the component moves onto it (a node
      // resize's staged one, for hours) is the launcher's, not unmanaged
      for (const op of this.db.listFleetOps(launch.id, "active")) {
        const staged = this.db.stepOutput<{ dseq: string }>(launch.id, `op${op.id}:deploy`);
        if (staged?.dseq) known.add(staged.dseq);
      }
      const localSigner = await this.localSignerSummary(launch, spec);
      fleets.push({
        launchId: launch.id,
        launchStatus: launch.status,
        name: spec.network.name,
        kind: spec.kind ?? "chain",
        // join-aware: a joined fleet runs the LIVE chain, not name-suffix
        chainId: chainId(spec),
        keyMode: spec.security.keyMode,
        ...(localSigner ? { localSigner } : {}),
        ...(isServicesFleet(spec)
          ? {}
          : {
              dataBackups: {
                schedule: this.dataBackupSchedule(launch.id),
                // the chosen "copy from" sentry (null: automatic), and who a backup now would copy
                source: this.db.getSetting(`data-backup-source:${launch.id}`),
                sourceNow: this.backupSourceFor(launch.id)?.key ?? null,
                autoRestore: autoRestoreEnabled(this.db, launch.id),
                backups: dataBackups(this.db, launch.id).map((b) => ({
                  name: b.name,
                  height: b.height,
                  takenAt: b.takenAt,
                  from: b.from,
                  verified: b.verified === true,
                  blocker: restoreBlocker(this.db, launch.id, launchDirs(this.workRoot, launch.id).node, b),
                })),
                ...(await this.backupStanding(launch).catch(() => ({}))),
              },
            }),
        autoRecover: this.autoRecoverPolicy(launch.id),
        incidents: this.db.listIncidents(launch.id, 5).map((i) => ({
          id: i.id,
          component: i.component,
          status: i.status,
          cause: i.cause,
          action: i.action,
          detail: i.detail,
          openedAt: i.opened_at,
          closedAt: i.closed_at,
        })),
        ...(isServicesFleet(spec) || spec.topology.headscale.reuseFleet
          ? {}
          : {
              meshBackup: spec.topology.headscale.backup
                ? {
                    bucket: spec.topology.headscale.backup.s3.bucket,
                    path: headscaleBackupPath(spec),
                    verified: !meshBackupUnverified(this.db, launch.id),
                  }
                : null,
            }),
        // per gas unit, base denom; the card warns when it is really a fee
        ...(isServicesFleet(spec)
          ? {}
          : (() => {
              const problem = minGasPriceProblem(spec.token.minGasPrice, spec.token.baseDenom, spec.token.exponent);
              return {
                minGasPrice: spec.token.minGasPrice,
                gasDenom: spec.token.baseDenom,
                ...(problem ? { gasPriceProblem: problem } : {}),
              };
            })()),
        components,
        ops: this.db.listFleetOps(launch.id).map((o) => ({
          id: o.id,
          kind: o.kind,
          status: o.status,
          params: JSON.parse(o.params_json),
          ...(o.progress_json
            ? { progress: JSON.parse(o.progress_json) as FleetOpProgress }
            : {}),
        })),
        // only rows with bids on them are offers; a row without is a request
        // the placement has not reached yet, and an answered one is on its way
        bidPicks: this.db
          .listBidPicks(launch.id)
          .filter((p) => p.offers_json && p.dseq && !p.provider)
          .map((p) => ({
            key: p.key,
            dseq: p.dseq!,
            bids: JSON.parse(p.offers_json!) as OfferedBid[],
          })),
        sessions: sessionSummary(launchDirs(this.workRoot, launch.id).secrets),
      });
    }

    // reconcile: chain is the source of truth for closed-out-of-band and
    // for deployments another launcher instance created
    let unmanaged: Array<{ dseq: string; state: string }> = [];
    try {
      const onChain = await this.services.api.listDeployments(owner);
      const byDseq = new Map(onChain.map((d) => [d.dseq, d.state]));
      for (const fleet of fleets) {
        for (const c of fleet.components) {
          const chainState = byDseq.get(c.dseq);
          // only an explicit on-chain "closed" flips state: absence from the
          // list can be pagination truncation or LCD lag, and closed is a
          // one-way transition with no path back to active
          if (c.state === "active" && chainState === "closed") {
            this.db.setComponentState(fleet.launchId, c.key, "closed");
            c.state = "closed";
          }
        }
      }
      // closed unknown deployments are history, not something to manage
      unmanaged = onChain.filter((d) => !known.has(d.dseq) && d.state !== "closed");
    } catch {
      // chain unreachable — serve the local view; the monitor will catch up
    }

    return { fleets, unmanaged };
  }

  /**
   * One monitor pass for a launch (§5 "Fleet health monitor"): lease state,
   * escrow runway, sentry RPC height. Serial and cheap; the caller owns the
   * cadence (30–60s in production, direct calls in tests).
   */
  async tick(launchId: string): Promise<void> {
    const launch = this.db.getLaunch(launchId);
    if (!launch) return;
    // a fleet paused inside an op is still a running fleet: everything the
    // op is not working on keeps its readings current (its rows are not
    // rebuilt mid-op, which would hand the op's half-made deployments over)
    const scope = launch.status === "paused" ? this.pausedOpScope(launchId) : new Set<string>();
    if (launch.status !== "completed" && launch.status !== "paused") return;
    if (scope === "all") return;
    if (launch.status === "completed") this.materialize(launchId);
    const owner = launch.owner;
    const spec = this.spec(launch);
    const perDay = blocksPerDay(spec);
    // each public ingress a component serves, and the URL proving it does
    const componentHealthUrls = new Map<string, string[]>(
      serviceComponents(spec).flatMap((c) => {
        const ingress = descriptorFor(c.key)?.ingress?.(spec);
        if (ingress) return [[c.key, ingress.map((i) => i.healthUrl)] as const];
        return c.domain ? [[c.key, [`https://${c.domain}/`]] as const] : [];
      }),
    );

    // Every chain node's height, probed once up front, because no node's
    // height means anything on its own: the number that says whether one is
    // keeping up is the fleet's head, and the node reporting it may be any
    // of them. Sentries read theirs off the forwarded RPC the check below
    // used to open by hand; validators, which forward no RPC, cost one
    // lease-shell each and are few.
    const chainRows = this.db
      .listFleetComponents(launchId)
      .filter((c) => c.state !== "closed" && /^(val|sentry)-/.test(c.key));
    const heights = new Map<string, { height: number; catchingUp: boolean }>();
    await Promise.all(
      chainRows.map(async (c) => {
        const h = await this.componentHeight(launch, c).catch(() => null);
        if (h) heights.set(c.key, h);
      }),
    );
    const head = Math.max(0, ...[...heights.values()].map((h) => h.height));

    // components are independent — probe them concurrently so one slow
    // provider doesn't stretch the whole pass
    await Promise.all(
      this.db.listFleetComponents(launchId).map(async (c) => {
        if (scope.has(c.key)) return;
        if (c.state === "closed") {
          this.db.setComponentHealth(launchId, c.key, "closed");
          return;
        }
        try {
          const lease = await this.services.api.leaseState(owner, c.dseq, c.provider);
          if (lease !== "active") {
            this.db.setComponentHealth(launchId, c.key, "lease-not-active", `lease: ${lease}`);
            return;
          }
          const details: string[] = [];
          const escrow = await this.services.api.deploymentEscrow(owner, c.dseq);
          if (escrow) {
            const runwayDays = Number(escrow.amount) / (Math.max(1, Number(c.price)) * perDay);
            details.push(`runway ${runwayDays.toFixed(1)}d`);
            if (runwayDays < 3) {
              this.db.setComponentHealth(launchId, c.key, "low-escrow", details.join("; "));
              return;
            }
          }
          if (c.key.startsWith("sentry-")) {
            const status = heights.get(c.key);
            if (!status) throw new Error("RPC not answering");
            // height is shown by the live per-second indicator, not here —
            // this check only flags a stalled/catching-up sentry
            if (status.catchingUp) {
              this.db.setComponentHealth(launchId, c.key, "catching-up", details.join("; "));
              return;
            }
            if (stalled(status, head)) {
              this.db.setComponentHealth(
                launchId, c.key, "stalled", stalledDetail(status, head, details),
              );
              return;
            }
          } else if (c.key.startsWith("val-")) {
            const status = heights.get(c.key);
            if (status && !status.catchingUp && stalled(status, head)) {
              this.db.setComponentHealth(
                launchId, c.key, "stalled", stalledDetail(status, head, details),
              );
              return;
            }
            // chain-side jailed flag (downtime-jailing is invisible to the
            // lease/escrow checks — the container hums along fine)
            if (await this.validatorJailed(launch, spec, c.key)) {
              this.db.setComponentHealth(
                launchId, c.key, "jailed",
                "downtime-jailed on chain — unjail re-enters the set once the node is synced",
              );
              return;
            }
          } else if (c.key === "headscale") {
            // The mesh's front door. An active lease and healthy escrow say
            // nothing about whether nodes can actually reach the control
            // endpoint — and every join depends on it, so a headscale that
            // is up but unreachable reads "healthy" while no node can
            // register (seen live: Cloudflare answered TLS but never
            // responded, and the fleet showed green throughout while a
            // sentry failed to join for hours).
            const domain = spec.topology.headscale.domain;
            if (domain) {
              const url = `https://${domain}/health`;
              if (!(await this.services.rpc.httpOk(url))) {
                this.db.setComponentHealth(
                  launchId,
                  c.key,
                  "unreachable",
                  `${url} not answering — nodes cannot join the mesh. headscale's HTTP ` +
                    `listener can wedge while the process still runs (the CLI uses a local ` +
                    `socket, so "nodes list" keeps working): try restarting it, then check ` +
                    `the domain's DNS`,
                );
                return;
              }
            }
          } else if (componentHealthUrls.has(c.key)) {
            // service components: HTTP 200 on every public ingress (§5 step 21)
            for (const url of componentHealthUrls.get(c.key)!) {
              if (!(await this.services.rpc.httpOk(url))) {
                this.db.setComponentHealth(
                  launchId, c.key, "unreachable", `${url} not answering`,
                );
                return;
              }
            }
          } else if (descriptorFor(c.key)?.probe && c.ssh_host) {
            // domainless components: ask the container itself
            const probe = descriptorFor(c.key)!.probe!;
            const { stdout } = await this.services.ssh.exec(this.sshTargetFor(launch, c), probe.command, { quick: true });
            const verdict = probe.verdict(stdout);
            details.push(verdict.detail);
            if (!verdict.healthy) {
              this.db.setComponentHealth(launchId, c.key, verdict.status ?? "unreachable", details.join("; "));
              return;
            }
            // a running hermes with an empty key relays nothing on that chain,
            // and a transfer sent there waits (its refund too) until topped up
            if (c.key === "relayer") {
              const low = await this.relayerLowFunds(launch);
              if (low.length > 0) {
                this.db.setComponentHealth(launchId, c.key, "low-gas", [...details, ...low].join("; "));
                return;
              }
            }
          }
          this.db.setComponentHealth(launchId, c.key, "healthy", details.join("; "));
        } catch (e) {
          // lease says up but the node doesn't answer — the state on-chain
          // reconciliation alone can never see (§5 monitor)
          this.db.setComponentHealth(launchId, c.key, "unreachable", String(e).slice(0, 300));
        }
      }),
    );
  }

  // --- actions (§5 "Component relaunch & close": close + restart slice) ---

  /**
   * Topology guard: closing a sentry that is some validator's only peer
   * path isolates that validator (§5 pre-action guards).
   */
  /** Sentries whose loss (close or relaunch downtime) isolates a validator. */
  private sentryIsolationWarnings(
    spec: LaunchSpec,
    component: FleetComponentRow,
    while_: string,
  ): string[] {
    const warnings: string[] = [];
    if (!component.key.startsWith("sentry-")) return warnings;
    const s = Number(component.key.split("-")[1]);
    const topo = resolveTopology(spec);
    for (const v of topo.sentryValidators[s] ?? []) {
      const others = (topo.validatorSentries[v] ?? []).filter((x) => x !== s);
      if (others.length === 0) {
        warnings.push(
          `sentry-${s} is validator ${v}'s only connection to the chain: ${while_}, ` +
            `the validator misses blocks and risks being downtime-jailed`,
        );
      }
    }
    return warnings;
  }

  closeWarnings(launch: LaunchRow, component: FleetComponentRow): string[] {
    const spec = this.spec(launch);
    const warnings = this.sentryIsolationWarnings(spec, component, "while it is closed");
    if (component.key === "headscale") {
      warnings.push("closing headscale severs the mesh: nodes keep running but cannot re-wire");
      const dependents = dependentFleets(this.db, launch.id);
      if (dependents.length > 0) {
        warnings.push(
          `this mesh is shared: fleet(s) ${dependents
            .map((d) => this.spec(d).network.name)
            .join(", ")} ride it via reuseFleet and would be severed too`,
        );
      }
    }
    if (component.key === "mastodon") {
      const bridged = this.bridgeDependents(launch.id);
      if (bridged.length > 0) {
        warnings.push(
          `fleet(s) ${bridged.map((d) => this.spec(d).network.name).join(", ")} bridge this instance to their ` +
            "chains: their bridges stop anchoring while it is closed, and a new instance starts with an empty " +
            "database (their bridge accounts are re-made when they are reconfigured)",
        );
      }
    }
    if (component.key.startsWith("val-")) {
      warnings.push(
        `closing ${component.key} deletes its node data, and the chain keeps expecting its ` +
          "signatures: it will be downtime-jailed unless it is relaunched or its stake is " +
          "unbonded. Its keys stay safe in the launcher" +
          (spec.security.keyMode === "tmkms" ? " and your tmkms signer" : "") +
          ", so a later relaunch can restore it.",
      );
    }
    return warnings;
  }

  /**
   * Relaunch is close plus redeploy, so the transient risks differ from a
   * plain close: keys/config are restored automatically and the op enforces
   * the double-sign safety window, but the node is down until the
   * replacement syncs.
   */
  relaunchWarnings(launch: LaunchRow, component: FleetComponentRow): string[] {
    const spec = this.spec(launch);
    const warnings = this.sentryIsolationWarnings(spec, component, "while it relaunches");
    if (component.key === "headscale") {
      warnings.push(
        spec.topology.headscale.backup && meshBackupUnverified(this.db, launch.id)
          ? "headscale's backup was never verified (back up mesh… did not finish): a relaunch may " +
              "find nothing in the bucket and come up with an empty mesh. Finish or redo back up mesh… first."
          : spec.topology.headscale.backup
          ? "relaunching headscale redeploys it on a different provider and restores the mesh " +
              "from its S3 backup, so every client reconnects as-is. You will be asked to point " +
              "the domain's DNS record at the new provider."
          : "relaunching headscale RE-KEYS the whole mesh (no backup is configured): every " +
              "component re-registers with a fresh preauth key, tailnet IPs can change, and a " +
              "tmkms signer must re-join with the new key the op shows at the end. The chain " +
              "signs nothing between the DNS flip and the signer repoint.",
      );
    } else if (component.key === "mastodon") {
      warnings.push(
        "relaunching Mastodon starts it on EMPTY volumes on another provider: its accounts, posts " +
          "and uploaded media stay behind with the closed deployment, and the launcher creates a new " +
          "owner account. To move the instance with its data (to change its size, or to leave a " +
          "provider), use resize instead.",
      );
    } else if (component.key.startsWith("val-")) {
      warnings.push(
        `relaunching ${component.key} closes its current deployment and redeploys it on a ` +
          "different provider. The node is offline until the replacement syncs; its keys and " +
          "config are restored automatically" +
          (spec.security.keyMode === "tmkms"
            ? managedSigner(this.signerDeps(launch.id), component.key)
              ? ", and the launcher repoints and restarts its managed tmkms signer at the new node."
              : ", and you will be prompted to repoint your tmkms signer to the new node."
            : ", and the launcher waits a safety window before it signs again, so there is no double-sign risk."),
      );
    } else if (component.key === "sentry-0") {
      const domains = sentryPublicDomains(spec).map((d) => d.domain);
      if (domains.length > 0) {
        warnings.push(
          `sentry-0 serves the public ${domains.join(" and ")} domain${domains.length > 1 ? "s" : ""}: they go ` +
            "dark until their DNS records point at the new provider, and the relaunch pauses at the end " +
            "with the records to set.",
        );
      }
    }
    return warnings;
  }

  /** Fleets riding this launch's mesh — refuse to sever them (§ shared mesh). */
  /**
   * A Mastodon's domains must not be another fleet's on this launcher: the
   * ingress health check would pass against the other instance (its DNS
   * answers), and the new one would bridge as that instance's peer. Linking
   * a chain to an existing instance is the standalone bridge's job.
   */
  private assertMastodonDomainFree(launch: LaunchRow, spec: LaunchSpec): void {
    const domainsOf = (s: LaunchSpec) => {
      const m = s.topology.components.mastodon;
      if (!m?.enabled || !m.domain) return [];
      return [m.domain, mastodonStreamingDomain(s), mastodonLoginDomain(s)].filter((d): d is string => Boolean(d));
    };
    const mine = new Set(domainsOf(spec));
    for (const other of this.db.listLaunches()) {
      if (other.id === launch.id || other.status === "aborted") continue;
      let theirs: string[];
      try {
        theirs = domainsOf(this.spec(other));
      } catch {
        continue;
      }
      const clash = theirs.find((d) => mine.has(d));
      if (clash) {
        const name = this.spec(other).network.name;
        throw new Error(
          mayUseFleet(other, launch.owner)
            ? `${clash} is already served by fleet "${name}"'s Mastodon. ` +
                `To link this chain to that instance, add a bridge component targeting "${name}" instead`
            : `${clash} is already served by another wallet's Mastodon on this launcher: choose a domain of this instance's own`,
        );
      }
    }
  }

  /** Chain fleets whose standalone bridge links this fleet's Mastodon. */
  private bridgeDependents(launchId: string): LaunchRow[] {
    return bridgeDependents(this.db, launchId);
  }

  private assertNoDependentFleets(launch: LaunchRow, closing: string): void {
    const bridged = this.bridgeDependents(launch.id);
    if (closing.startsWith("shutting") && bridged.length > 0) {
      throw new Error(
        `${closing} would take down the Mastodon that fleet(s) ` +
          bridged.map((d) => `"${this.spec(d).network.name}" (${d.id})`).join(", ") +
          " bridge to their chains: close their bridge components first",
      );
    }
    const dependents = dependentFleets(this.db, launch.id);
    if (dependents.length > 0) {
      throw new Error(
        `${closing} would sever the shared mesh: fleet(s) ` +
          dependents.map((d) => `"${this.spec(d).network.name}" (${d.id})`).join(", ") +
          " share this fleet's headscale via reuseFleet — shut those fleets down first",
      );
    }
  }

  /** Enqueue MsgCloseDeployment into the launch's signing loop. */
  requestClose(launch: LaunchRow, component: FleetComponentRow): { step: string } {
    if (component.key === "headscale") {
      this.assertNoDependentFleets(launch, "closing headscale");
    }
    const step = `fleet:close:${component.dseq}`;
    this.db.enqueuePendingTx(
      launch.id,
      step,
      JSON.stringify([closeDeploymentMsg(launch.owner, component.dseq)]),
    );
    return { step };
  }

  /**
   * Shut the whole fleet down: one batched MsgCloseDeployment per active
   * component in a single tx through the signing loop.
   */
  async requestShutdown(launch: LaunchRow): Promise<{ step: string; closing: string[] }> {
    this.assertNoDependentFleets(launch, "shutting this fleet down");
    this.materialize(launch.id);
    // shutting down abandons whatever the launch was waiting on — drop any
    // unsigned engine tx (e.g. create-leases with expired bids) so it can't
    // shadow the closes in the oldest-first signing queue. Do this even when
    // nothing is left to close: a wedged queue is exactly why a user reaches
    // for shutdown on an already-dead launch.
    this.db.clearUnsignedPendingTxs(launch.id);
    const components = this.db
      .listFleetComponents(launch.id)
      .filter((c) => c.state !== "closed");
    // skip anything already closed on-chain — a close for it fails simulation
    const closing: FleetComponentRow[] = [];
    for (const c of components) {
      const info = await this.services.api.deploymentInfo(launch.owner, c.dseq).catch(() => undefined);
      if (!info || info.state === "active") closing.push(c);
      else this.db.setComponentState(launch.id, c.key, "closed");
    }
    if (closing.length === 0) {
      // still useful on an already-closed fleet: end an in-flight launch
      // that was shut down before this reconciliation existed
      if (launch.status !== "completed") this.db.setLaunchStatus(launch.id, "aborted");
      throw new Error("nothing to shut down — all deployments are closed");
    }
    const step = "fleet:shutdown";
    this.db.deletePendingTx(launch.id, step); // re-request replaces a signed-but-stale one
    this.db.enqueuePendingTx(
      launch.id,
      step,
      JSON.stringify(closing.map((c) => closeDeploymentMsg(launch.owner, c.dseq))),
    );
    return { step, closing: closing.map((c) => c.key) };
  }

  /**
   * Permanently delete a shut-down launch: every db record plus the work
   * directory (rendered SDLs, step outputs, SECRETS — mnemonics, tmkms keys,
   * the age identity). Refused while any deployment might still be open.
   * The fleet bundle export is the archival path; deletion is for launches
   * the user is done with.
   */
  async deleteLaunch(launch: LaunchRow): Promise<void> {
    this.materialize(launch.id);
    for (const c of this.db.listFleetComponents(launch.id)) {
      if (c.state === "closed") continue;
      const info = await this.services.api
        .deploymentInfo(launch.owner, c.dseq)
        .catch(() => undefined);
      if (!info) {
        throw new Error(`cannot verify ${c.key} (dseq ${c.dseq}) on-chain — not deleting`);
      }
      if (info.state === "active") {
        throw new Error(`${c.key} is still active on-chain — shut down the fleet first`);
      }
      this.db.setComponentState(launch.id, c.key, "closed");
    }
    this.db.deleteLaunch(launch.id);
    fs.rmSync(launchDirs(this.workRoot, launch.id).root, { recursive: true, force: true });
  }

  private mnemonics(launch: LaunchRow): Record<string, string> {
    const file = path.join(launchDirs(this.workRoot, launch.id).secrets, "mnemonics.json");
    if (!fs.existsSync(file)) return {};
    return JSON.parse(readSecretFile(file));
  }

  /** Named accounts from generate-keys: addresses openly, mnemonics flagged
   *  only — reveal goes through mnemonic() so seeds never ride list calls. */
  accounts(launch: LaunchRow): Array<{ name: string; address: string; hasMnemonic: boolean }> {
    const keys = this.db.stepOutput<{ accounts: Record<string, string> }>(
      launch.id,
      "generate-keys",
    );
    if (!keys) throw new Error("launch has no generated keys yet");
    const mnemonics = this.mnemonics(launch);
    const accounts = { ...keys.accounts };
    // a relayer added after launch is not among generate-keys' accounts; its
    // own-chain address comes from its last link (the first chain listed)
    const relayer = this.relayerState(launch)?.chains[0];
    if (!(RELAYER_ACCOUNT in accounts) && RELAYER_ACCOUNT in mnemonics && relayer) {
      accounts[RELAYER_ACCOUNT] = relayer.address;
    }
    const out = Object.entries(accounts).map(([name, address]) => ({
      name,
      address,
      hasMnemonic: name in mnemonics,
    }));
    // the Mastodon owner: its "address" is the handle, its secret the
    // password the instance generated (captured once, at creation)
    const masto = this.spec(launch).topology.components.mastodon;
    const password = readMastodonSecrets(launchDirs(this.workRoot, launch.id).secrets)?.ownerPassword;
    if (masto?.enabled && masto.owner && password) {
      out.push({ name: MASTODON_OWNER, address: `@${masto.owner.username}@${masto.domain}`, hasMnemonic: true });
    }
    // the alerts server's phone login: user@domain, its secret the password
    // the ntfy app asks for
    const ntfy = this.spec(launch).topology.components.ntfy;
    if (ntfy?.enabled && ntfy.domain && readNtfySecrets(launchDirs(this.workRoot, launch.id).secrets)) {
      out.push({ name: NTFY_LOGIN, address: `${ntfy.user ?? "phone"} @ https://${ntfy.domain}`, hasMnemonic: true });
    }
    return out;
  }

  mnemonic(launch: LaunchRow, name: string): string {
    if (name === NTFY_LOGIN) {
      const password = readNtfySecrets(launchDirs(this.workRoot, launch.id).secrets)?.phonePassword;
      if (!password) throw new Error("no ntfy login generated yet");
      return password;
    }
    if (name === MASTODON_OWNER) {
      const password = readMastodonSecrets(launchDirs(this.workRoot, launch.id).secrets)?.ownerPassword;
      if (!password) throw new Error("no Mastodon owner password recorded");
      return password;
    }
    const m = this.mnemonics(launch)[name];
    // external operators (§3) are addresses only — their keys never exist here
    if (!m) throw new Error(`no mnemonic stored for ${name}`);
    return m;
  }

  /** The rendered SDL a component was deployed with (paste into console). */
  componentSdl(launch: LaunchRow, component: FleetComponentRow): string {
    const dirs = launchDirs(this.workRoot, launch.id);
    const file = path.join(dirs.sdl, `${component.key}.yaml`);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    if (component.key === "headscale") {
      // launches from before the deploy step persisted headscale.yaml —
      // re-template it (identical inputs → identical SDL)
      const spec = this.spec(launch);
      const keys = this.db.stepOutput<{ ageRecipient: string }>(launch.id, "generate-keys");
      const ageIdentity = spec.topology.headscale.backup
        ? readSecretFile(path.join(dirs.secrets, "age.txt"))
            .split("\n")
            .find((l) => l.startsWith("AGE-SECRET-KEY-"))
        : undefined;
      return yaml.dump(
        templateHeadscaleSdl(spec, { ageRecipient: keys?.ageRecipient, ageIdentity, secretsDir: dirs.secrets }),
        { lineWidth: 120 },
      );
    }
    throw new Error(`no rendered SDL for ${component.key}`);
  }

  /**
   * Confirm signed fleet txs (the launch step engine only drives launch
   * steps, so fleet txs are settled here — called on tx-result and ticks).
   * Returns the other fleets it queued an op on, for the caller to drive.
   */
  async settleFleetTxs(launchId: string): Promise<string[]> {
    const queued: string[] = [];
    for (const row of this.db.listSignedFleetTxs(launchId)) {
      const status = await this.services.api.txStatus(row.tx_hash!);
      if (status === "pending") continue;
      if (status === "failed") {
        this.db.setPendingTxStatus(launchId, row.step, "pending"); // re-sign
        continue;
      }
      this.db.setPendingTxStatus(launchId, row.step, "confirmed");
      const [, action, dseq] = row.step.split(":");
      if (action === "close" && dseq) {
        const component = this.db.getFleetComponentByDseq(launchId, dseq);
        if (component) this.db.setComponentState(launchId, component.key, "closed");
        if (component?.key === "bridge") queued.push(...this.queueLoginResync(launchId));
      }
      if (action === "shutdown") {
        const bridged = this.db.listFleetComponents(launchId).some((c) => c.key === "bridge" && c.state !== "closed");
        for (const c of this.db.listFleetComponents(launchId)) {
          if (c.state !== "closed") this.db.setComponentState(launchId, c.key, "closed");
        }
        if (bridged) queued.push(...this.queueLoginResync(launchId));
        // shutting down an in-flight launch ends it — otherwise it lingers
        // "paused" on whatever step it died at, error banner and all
        const launch = this.db.getLaunch(launchId);
        if (launch && launch.status !== "completed") {
          this.db.setLaunchStatus(launchId, "aborted");
        }
      }
    }
    return queued;
  }

  /**
   * This chain fleet's standalone bridge just closed: the Mastodon it linked
   * stops offering the chain at wallet sign-in. A "reconfigure" of that
   * Mastodon re-syncs its chain list, which no longer counts this fleet (its
   * bridge row is closed). Returns the fleet to drive, if any.
   */
  private queueLoginResync(launchId: string): string[] {
    const launch = this.db.getLaunch(launchId);
    const b = launch ? this.spec(launch).topology.components.bridge : undefined;
    if (!b?.enabled) return [];
    const target = this.db.getLaunch(b.target.fleet);
    if (!target || target.status !== "completed" || !mastodonLoginDomain(this.spec(target))) return [];
    if (!this.db.listFleetComponents(target.id).some((c) => c.key === "mastodon" && c.state === "active")) return [];
    this.db.createFleetOp(target.id, "reconfigure", { keys: ["mastodon"] } satisfies ReconfigureParams);
    return [target.id];
  }

  /** Restart the component (no signature — §2 scoping rule). Nodes restart
   *  over SSH; headscale (no sshd) and the stateless components restart via
   *  provider lease-shell — killing PID 1 makes the provider recreate the
   *  container, which re-reads its env (tunnels included) at boot. headscale
   *  is the exception: see HEADSCALE_RESTART. */
  async restart(launch: LaunchRow, component: FleetComponentRow): Promise<void> {
    if (component.key === "headscale" || descriptorFor(component.key)) {
      await this.services.provider
        .shellExec(
          this.mtlsCreds(launch), component.host_uri, component.dseq, 1, 1, leaseServiceName(component.key),
          ["sh", "-c", component.key === "headscale" ? HEADSCALE_RESTART : "kill 1"],
        )
        .catch(() => {
          // killing PID 1 drops the shell connection — expected
        });
      return;
    }
    await restartNode(this.services.ssh, this.sshTargetFor(launch, component));
  }

  /**
   * Pre-reset guard (§5 pre-action guards): wiping `data/` throws away every
   * block the node holds and the app state with it. The node stays stopped
   * afterwards — a restart would start re-syncing from peers and take the
   * height with it, which is exactly what a following archive restore needs
   * it not to do.
   */
  resetDataWarnings(launch: LaunchRow, component: FleetComponentRow): string[] {
    const warnings = [
      `This erases ${component.key}'s blockchain database: every block it holds and the ` +
        "application state with it. Node key and consensus key are kept, so it keeps its " +
        "identity. The node is left STOPPED — restore replays the archives from block 1 into " +
        "the empty database, or restart re-syncs it from its peers (slow on a long chain).",
    ];
    if (!component.key.startsWith("val-")) return warnings;
    const active = this.db
      .listFleetComponents(launch.id)
      .filter((c) => c.key.startsWith("val-") && c.state === "active").length;
    warnings.push(
      `${component.key} signs nothing from now until it is back at the chain head, which is a ` +
        `downtime jail if that takes long enough${
          active <= 1 ? ", and it is this fleet's only active validator, so the chain stops with it" : ""
        }.`,
    );
    if (this.spec(launch).security.keyMode !== "tmkms") {
      // softsign keeps the double-sign watermark in the data dir the reset
      // wipes; tmkms keeps it on the signer, where the reset cannot reach it
      warnings.push(
        `${component.key} signs locally (softsign), so the reset also clears its ` +
          "priv_validator_state.json — the file that stops it signing a second block at a " +
          "height it already signed. If this node ever rejoins a chain that kept those blocks " +
          "and re-signs one of them, that is a double sign and the stake is slashed.",
      );
    }
    return warnings;
  }

  /**
   * Wipe a node's chain data (`comet unsafe-reset-all`) and leave it stopped,
   * ready for an archive restore from block 1 — replay only ever appends from
   * the node's committed height, so rebuilding history BELOW it means starting
   * from an empty database. Keys and the address book survive.
   */
  async resetData(
    launch: LaunchRow,
    component: FleetComponentRow,
  ): Promise<{ output: string }> {
    if (!/^(val|sentry)-/.test(component.key)) {
      throw new Error(`reset data applies to chain nodes, not ${component.key}`);
    }
    const target = this.sshTargetFor(launch, component);
    // the reset opens the same databases the node holds — stop it first, and
    // confirm, or the wipe half-happens against a live process
    await this.services.ssh.exec(target, "pkill -x sparkdreamd || true");
    for (let i = 0; i < 10; i++) {
      const alive = await this.services.ssh.exec(
        target,
        "pgrep -x sparkdreamd >/dev/null && echo yes || echo no",
        { quick: true },
      );
      if (alive.stdout.trim() === "no") break;
      if (i === 4) await this.services.ssh.exec(target, "pkill -9 -x sparkdreamd || true");
      if (i === 9) throw new Error(`${component.key}: sparkdreamd will not stop; data left alone`);
      await this.services.sleep(2000);
    }
    const res = await this.services.ssh.exec(
      target,
      `sparkdreamd comet unsafe-reset-all --home ${NODE_HOME} --keep-addr-book 2>&1`,
    );
    return { output: res.stdout.trim().slice(-2000) };
  }

  clearHaltHeightWarnings(launch: LaunchRow): string[] {
    return [
      "Every chain node's halt-height is set back to 0, so a node that stopped at it no longer " +
        "stops there. Nothing is started: the nodes stay exactly as they are, and a node already " +
        "halted stays down until you restart it or an upgrade replaces its image. Use this to " +
        "recover a halt-height upgrade that was abandoned before it could clear the setting " +
        "itself, which otherwise leaves every node halting again on each restart.",
    ];
  }

  /**
   * Reset `halt-height` to 0 across the fleet's chain nodes.
   *
   * The halt-upgrade op clears the setting itself once it has seen the halt
   * (`halt-clear`), so this is the recovery path for the case where that op
   * never got there: aborted, or wedged before the clear. Without it the
   * setting is unreachable — the launcher exposes no other way to edit
   * app.toml, restart re-halts at the same block, and the image swap does not
   * touch the config volume — so the fleet halts forever at a height that has
   * already passed.
   */
  async clearHaltHeight(launch: LaunchRow): Promise<{ cleared: string[] }> {
    const nodes = this.db
      .listFleetComponents(launch.id)
      .filter((c) => c.state === "active" && /^(val|sentry)-/.test(c.key));
    const cleared: string[] = [];
    for (const component of nodes) {
      // sparkdreamd is PID 1, so a node stopped at its halt height is really
      // a crash loop: the container exits, the provider restarts it, and it
      // halts again. SSH answers only inside each boot window, so a single
      // attempt usually lands in the restart backoff instead.
      let last = "";
      for (let i = 0; i < 60; i++) {
        try {
          await this.services.ssh.exec(
            this.sshTargetFor(launch, component),
            `sed -i 's|^halt-height =.*|halt-height = 0|' ${NODE_HOME}/config/app.toml`,
          );
          cleared.push(component.key);
          break;
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
        await this.services.sleep(5000);
      }
      if (!cleared.includes(component.key)) {
        throw new Error(
          `${component.key}: halt-height not cleared — no boot window in 5 min (last: ${last}). ` +
            `Cleared so far: ${cleared.join(", ") || "none"}.`,
        );
      }
    }
    return { cleared };
  }

  private mtlsCreds(launch: LaunchRow) {
    const dirs = launchDirs(this.workRoot, launch.id);
    return {
      certPem: fs.readFileSync(path.join(dirs.secrets, "akash-cert.pem"), "utf8"),
      keyPem: readSecretFile(path.join(dirs.secrets, "akash-cert-key.pem")),
    };
  }

  /** How alerts reach ntfy or a webhook; tests swap in a fake. */
  alertFetch: typeof fetch = (...args) => fetch(...args);

  /**
   * Turn this pass's health readings into incidents (incidents.ts) and
   * alert on the ones that opened or resolved. Runs after tick().
   */
  async trackIncidents(launchId: string): Promise<IncidentEvent[]> {
    const launch = this.db.getLaunch(launchId);
    if (!launch) return [];
    // paused inside an op: what the op is moving reads down because of it;
    // the rest is watched as usual (auto-recovery defers to the op)
    const scope = launch.status === "paused" ? this.pausedOpScope(launchId) : new Set<string>();
    if (scope === "all") return [];
    const rows = this.db.listFleetComponents(launchId) as FleetComponentRow[];
    const events: IncidentEvent[] = [];
    for (const h of this.db.listComponentHealth(launchId)) {
      const row = rows.find((r) => r.key === h.component);
      if (!row || scope.has(h.component)) continue;
      const ev = await trackIncident(this.db, launchId, h.component, h.status, h.detail, () =>
        this.probeProvider(launch, row),
      );
      if (ev) events.push(ev);
    }
    const settings = alertSettings(this.db);
    if (events.length > 0 && (settings.ntfy || settings.webhook)) {
      const fleetName = this.spec(launch).network.name;
      for (const ev of events) {
        const failures = await sendAlert(settings, alertFor(fleetName, ev), this.alertFetch);
        for (const f of failures) console.log(`[alerts] ${fleetName}/${ev.incident.component}: ${f}`);
      }
    }
    for (const ev of events) {
      if (ev.kind === "opened") await this.autoRecover(launch, ev.incident).catch((e) => console.log(`[auto-recover] ${e}`));
    }
    // incidents that opened while another op ran: their turn once it is done
    const deferred = this.deferredRecoveries.get(launchId);
    if (deferred && deferred.size > 0 && this.db.listFleetOps(launchId, "active").length === 0) {
      for (const component of [...deferred]) {
        deferred.delete(component);
        const incident = this.db.openIncident(launchId, component);
        if (incident?.confirmed_at) {
          await this.autoRecover(launch, incident).catch((e) => console.log(`[auto-recover] ${e}`));
        }
      }
    }
    // a restart that did not take: re-create the container instead. Without
    // this the incident stayed open with nothing more tried, because
    // auto-recovery only ever acts when an incident opens
    for (const incident of this.db.listIncidents(launchId, 0)) {
      if (scope.has(incident.component) || !this.restartDidNotTake(launchId, incident)) continue;
      await this.autoRecover(launch, incident, { escalate: true }).catch((e) => console.log(`[auto-recover] ${e}`));
    }
    return events;
  }

  /**
   * The incident's automatic restart is RESTART_GRACE_MS old and nothing
   * automatic has been tried on the component since.
   */
  private restartDidNotTake(launchId: string, incident: IncidentRow, now = Date.now()): boolean {
    if (incident.action !== "restart" || !incident.confirmed_at || incident.closed_at) return false;
    const raw = this.db.getSetting(`auto-restarts:${launchId}:${incident.component}`);
    const last = Math.max(0, ...(raw ? (JSON.parse(raw) as string[]) : []).map((t) => Date.parse(t)));
    if (last < Date.parse(incident.confirmed_at) || now - last < RESTART_GRACE_MS) return false;
    return !this.db.listFleetOps(launchId).some((o) => {
      const p = JSON.parse(o.params_json) as { auto?: boolean; key?: string };
      return p.auto && p.key === incident.component && Date.parse(o.created_at) >= last;
    });
  }

  /**
   * The components a paused launch's active ops are working on, whose
   * readings mid-op are the op's own doing (a node it stopped, a lease it
   * closed) rather than an outage. "all" when an op may touch any of them,
   * or when the launch is paused outside any op (a launch still launching
   * has no running fleet to watch).
   */
  pausedOpScope(launchId: string): Set<string> | "all" {
    const ops = this.db.listFleetOps(launchId, "active");
    if (ops.length === 0) return "all";
    const scope = new Set<string>();
    for (const op of ops) {
      const keys = opComponents(op);
      if (!keys) return "all";
      for (const k of keys) scope.add(k);
    }
    return scope;
  }

  /** Components whose incident opened while an op was active, per launch. */
  private readonly deferredRecoveries = new Map<string, Set<string>>();

  /** Automatic restarts of `key` in the last 24 hours (restarts are no op, so ops do not count them). */
  private recentAutoRestarts(launchId: string, key: string, record = false): number {
    const setting = `auto-restarts:${launchId}:${key}`;
    const raw = this.db.getSetting(setting);
    const now = Date.now();
    const kept = (raw ? (JSON.parse(raw) as string[]) : []).filter((t) => now - Date.parse(t) < 86_400_000);
    if (record) kept.push(new Date(now).toISOString());
    this.db.setSetting(setting, JSON.stringify(kept));
    return kept.length;
  }

  /** Launches whose auto-recovery started an op this pass; the server drives them. */
  readonly autoStarted = new Set<string>();

  /** A one-off alert outside the incident lifecycle (auto-recovery news). */
  private async notify(launch: LaunchRow, component: string, title: string, message: string): Promise<void> {
    const settings = alertSettings(this.db);
    if (!settings.ntfy && !settings.webhook) return;
    const fleetName = this.spec(launch).network.name;
    await sendAlert(
      settings,
      { fleet: fleetName, component, kind: "auto", severity: "warn", title: `${fleetName}: ${title}`, message, action: null },
      this.alertFetch,
    );
  }

  autoRecoverPolicy(launchId: string): AutoRecoverPolicy {
    const raw = this.db.getSetting(`auto-recover:${launchId}`);
    return { ...DEFAULT_AUTO_RECOVER, ...(raw ? (JSON.parse(raw) as Partial<AutoRecoverPolicy>) : {}) };
  }

  setAutoRecoverPolicy(launch: LaunchRow, policy: Partial<AutoRecoverPolicy>): AutoRecoverPolicy {
    const next = { ...this.autoRecoverPolicy(launch.id), ...policy };
    this.db.setSetting(`auto-recover:${launch.id}`, JSON.stringify(next));
    return next;
  }

  /**
   * An incident just confirmed: start its fix, when this fleet's policy
   * covers the component and it is safe to. The op it starts carries
   * auto: true, which is what lets signUnattended sign its txs.
   */
  private async autoRecover(launch: LaunchRow, incident: IncidentRow, opts: { escalate?: boolean } = {}): Promise<void> {
    const policy = this.autoRecoverPolicy(launch.id);
    const key = incident.component;
    const group: keyof AutoRecoverPolicy = key.startsWith("val-")
      ? "validators"
      : key.startsWith("sentry-")
        ? "sentries"
        : key === "headscale"
          ? "headscale"
          : "services";
    if (!policy.enabled || !policy[group]) return;
    const action = opts.escalate ? "force-redeploy" : incident.action;
    if (action !== "relaunch" && action !== "force-redeploy" && action !== "restart") return;
    const row = (this.db.listFleetComponents(launch.id) as FleetComponentRow[]).find((c) => c.key === key);
    if (!row || row.state === "closed") return;
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      // an escalation is looked for on every pass anyway
      if (opts.escalate) return;
      // not now, but not never: tried again once the running op is done
      let deferred = this.deferredRecoveries.get(launch.id);
      if (!deferred) this.deferredRecoveries.set(launch.id, (deferred = new Set()));
      deferred.add(key);
      return;
    }
    const spec = this.spec(launch);
    const recent =
      this.db.listFleetOps(launch.id).filter((o) => {
        const p = JSON.parse(o.params_json) as { auto?: boolean; key?: string };
        return p.auto && p.key === key && Date.now() - Date.parse(o.created_at) < 86_400_000;
      }).length + this.recentAutoRestarts(launch.id, key);
    if (recent >= AUTO_ATTEMPTS_PER_DAY) {
      await this.notify(
        launch,
        key,
        `${key} still down, giving up on automatic recovery`,
        `${recent} automatic attempts in 24 hours did not bring ${key} back (${incident.cause}). Over to you.`,
      );
      return;
    }
    if (action === "relaunch") {
      // a softsign validator moves only once the chain shows its old lease
      // closed: an old container still signing beside the new one is a
      // double-sign. tmkms keeps its own watermark, so it needs no proof.
      if (key.startsWith("val-") && spec.security.keyMode === "softsign" && incident.status !== "lease-not-active") {
        await this.notify(launch, key, `${key} needs you`, `${key} is unreachable but its lease is still open; a softsign validator is only moved automatically once the provider has closed the lease. Relaunch it by hand if the provider is gone.`);
        return;
      }
      if (key === "headscale" && (!spec.topology.headscale.backup || meshBackupUnverified(this.db, launch.id))) {
        await this.notify(
          launch,
          key,
          "headscale needs you",
          spec.topology.headscale.backup
            ? "headscale is down and its backup was never verified (back up mesh… did not finish): a relaunch could restore an empty mesh, so it is left to you."
            : "headscale is down and has no backup: a relaunch would re-key the whole mesh, so it is left to you (turn on the mesh backup to let it recover alone).",
        );
        return;
      }
      await this.requestRelaunch(launch, row, { auto: true });
    } else if (action === "force-redeploy") {
      this.requestForceRedeploy(launch, row, { auto: true });
    } else {
      this.recentAutoRestarts(launch.id, key, true);
      await this.restart(launch, row);
      await this.notify(launch, key, `restarted ${key}`, `${key} was restarted automatically (${incident.cause}).`);
      return;
    }
    this.autoStarted.add(launch.id);
    const signing = unattendedSettings(this.db, launch.owner).enabled;
    await this.notify(
      launch,
      key,
      `recovering ${key} automatically`,
      (opts.escalate
        ? `${key} is still down ${RESTART_GRACE_MS / 60_000} min after an automatic restart (${incident.cause}): started ${action} of ${key} to re-create its container.`
        : `${incident.cause}: started ${action} of ${key}.`) +
        (signing ? " Its transactions are signed with the launcher's grant." : " Its transactions wait for your Keplr signature (unattended signing is off)."),
    );
  }

  /** Grant info is a chain round trip; a minute's cache serves a whole relaunch. */
  private readonly grantCache = new Map<string, { at: number; grants: GrantInfo[]; allowance?: AllowanceInfo | null | undefined }>();
  /** Steps whose unattended refusal was already alerted. */
  private readonly refusedSteps = new Set<string>();

  /**
   * Sign the launch's next pending tx with the launcher's grant, when it
   * belongs to an op auto-recovery started and passes every rule
   * (unattendedBlocker). True when it was signed: the caller drives on.
   */
  async signUnattended(launchId: string): Promise<boolean> {
    // one signing at a time per launch: the monitor pass and a drive's
    // completion can both reach here for the same pending tx, and two
    // broadcasts of it collide on the account sequence (or a dseq)
    if (this.unattendedSigning.has(launchId)) return false;
    this.unattendedSigning.add(launchId);
    try {
      return await this.signUnattendedOnce(launchId);
    } finally {
      this.unattendedSigning.delete(launchId);
    }
  }

  /** Launches whose pending tx signUnattended is signing right now. */
  private readonly unattendedSigning = new Set<string>();

  private async signUnattendedOnce(launchId: string): Promise<boolean> {
    const chain = this.services.unattended;
    const launch = this.db.getLaunch(launchId);
    if (!chain || !launch) return false;
    const pending = this.db.nextPendingTx(launchId);
    const m = pending ? /^op(\d+):/.exec(pending.step) : null;
    if (!pending || !m) return false;
    const op = this.db.listFleetOps(launchId).find((o) => o.id === Number(m[1]));
    if (!op || op.status !== "active" || !(JSON.parse(op.params_json) as { auto?: boolean }).auto) return false;
    const msgs = JSON.parse(pending.msgs_json) as Msg[];
    const settings = unattendedSettings(this.db, launch.owner);
    const { mnemonic, address } = await opsKey(this.workRoot, launch.owner);
    let cached = this.grantCache.get(launch.owner);
    if (!cached || Date.now() - cached.at > 60_000) {
      cached = {
        at: Date.now(),
        grants: await chain.grants(launch.owner, address).catch(() => []),
        // unreadable: left to the broadcast to tell
        allowance: await chain.allowance(launch.owner, address).catch(() => undefined),
      };
      this.grantCache.set(launch.owner, cached);
    }
    const blocker = unattendedBlocker({
      owner: launch.owner,
      msgs,
      settings,
      grants: cached.grants,
      allowance: cached.allowance,
      spent: spentToday(this.db, launch.owner, settings.dailyCap.denom),
    });
    if (blocker) {
      const tag = `${launchId}:${pending.step}`;
      if (!this.refusedSteps.has(tag)) {
        this.refusedSteps.add(tag);
        await this.notify(launch, op.kind, "automatic recovery waits for your signature", `${pending.step}: ${blocker}. Sign it in the launcher (Keplr) to continue.`);
      }
      return false;
    }
    let hash: string;
    try {
      hash = await chain.exec(mnemonic, launch.owner, msgs);
    } catch (e) {
      // retried on every monitor pass, alerted once: a refused broadcast
      // (2026-10-07: fees in a denom the node does not take) otherwise
      // left the step on "Signature needed" for hours with no word why
      const tag = `${launchId}:${pending.step}:exec`;
      if (!this.refusedSteps.has(tag)) {
        this.refusedSteps.add(tag);
        await this.notify(launch, op.kind, "automatic recovery could not sign", `${pending.step}: ${String(e instanceof Error ? e.message : e)}. Sign it in the launcher (Keplr) to continue.`);
      }
      throw e;
    }
    this.db.setPendingTxSigned(launchId, pending.step, hash);
    const deposits = depositsOf(msgs).map((d) => ({
      at: new Date().toISOString(),
      denom: d.denom,
      amount: d.amount.toString(),
      step: pending.step,
    }));
    if (deposits.length > 0) recordSpend(this.db, launch.owner, deposits);
    return true;
  }

  /** The wallet's unattended-recovery state: the launcher's key, the grant on chain, the settings. */
  async unattendedStatus(owner: string): Promise<UnattendedStatus> {
    const { address } = await opsKey(this.workRoot, owner);
    const settings = unattendedSettings(this.db, owner);
    const chain = this.services.unattended;
    const grants = chain ? await chain.grants(owner, address).catch(() => null) : null;
    // undefined: could not be read (no warning on a guess)
    const allowance = chain ? await chain.allowance(owner, address).catch(() => undefined) : undefined;
    if (grants) this.grantCache.set(owner, { at: Date.now(), grants, allowance });
    return {
      available: Boolean(chain),
      grantee: address,
      settings,
      grants,
      allowance: allowance ?? null,
      allowanceProblem: allowance === undefined ? null : allowanceProblem(allowance),
      spentToday: spentToday(this.db, owner, settings.dailyCap.denom).toString(),
      covers: UNATTENDED_MSG_TYPES as unknown as string[],
    };
  }

  /** What the wallet signs (Keplr) to grant or revoke unattended recovery. */
  async unattendedMsgs(owner: string, kind: "grant" | "revoke", days = 30, feeLimit = { denom: UNATTENDED_FEE_DENOM, amount: "5000000" }): Promise<Msg[]> {
    const { address } = await opsKey(this.workRoot, owner);
    // what the chain holds now: a renewal must replace a live fee allowance
    // (a second one is refused), and a revoke may only name what is there
    // (one missing grant fails the whole tx). Unknown: assume a fresh grant
    // and a full revoke, as before
    const chain = this.services.unattended;
    const grants = chain ? await chain.grants(owner, address).catch(() => null) : null;
    const allowance = chain ? await chain.allowance(owner, address).catch(() => undefined) : undefined;
    if (kind === "revoke") {
      const types = grants ? UNATTENDED_MSG_TYPES.filter((t) => grants.some((g) => g.msgType === t)) : UNATTENDED_MSG_TYPES;
      const withAllowance = allowance !== null;
      if (types.length === 0 && !withAllowance) throw new Error("nothing to revoke: the chain holds no grant for the launcher's key");
      return unattendedRevokeMsgs(owner, address, withAllowance, types);
    }
    if (!(days >= 1 && days <= 365)) throw new Error("a grant lasts 1 to 365 days");
    if (!/^\d+$/.test(feeLimit.amount)) throw new Error("the fee limit is a whole number of base units");
    const expiration = new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
    return unattendedGrantMsgs(owner, address, expiration, feeLimit, { replaceAllowance: Boolean(allowance) });
  }



  /** Where an unreachable component's trouble is: its provider, its container, or its service. */
  private async probeProvider(launch: LaunchRow, row: FleetComponentRow): Promise<ProviderProbe> {
    let status: unknown;
    try {
      status = await this.services.provider.leaseStatus(this.mtlsCreds(launch), row.host_uri, row.dseq, 1, 1);
    } catch (e) {
      return providerUnreachable(e) ? "unreachable" : "unknown";
    }
    const services = Object.values(
      ((status as { services?: Record<string, { available?: number; total?: number }> })?.services ?? {}),
    );
    if (services.some((s) => (s.total ?? 0) > 0 && (s.available ?? 0) === 0)) return "service-down";
    if (services.length === 0) return "unknown";
    // headscale is judged by its public URL alone, which a provider or
    // Cloudflare blip fails as surely as a dead headscale: ask the container
    if (row.key === "headscale") {
      const self = await this.services.provider
        .shellExec(this.mtlsCreds(launch), row.host_uri, row.dseq, 1, 1, leaseServiceName(row.key), [
          "sh",
          "-c",
          HEADSCALE_SELF_CHECK,
        ])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      if (self === "answers") return "public-only";
      // the process is gone while litestream (PID 1) keeps the container up
      if (self === "gone") return "service-down";
    }
    // a public component: does the provider serve it on its own hostname?
    // Not doing so while the container runs is the ingress, not the service
    const ingress = isComponentKey(row.key) && COMPONENT_KINDS[row.key].domain ? descriptorFor(row.key)?.ingress?.(this.spec(launch)) : undefined;
    const domain = ingress?.[0]?.domain ?? (isComponentKey(row.key) ? componentDomain(this.spec(launch), row.key) : undefined);
    const generated = domain ? serviceIngressHost(status, domain) : undefined;
    if (domain && generated) {
      const path = ingress?.[0] ? new URL(ingress[0].healthUrl).pathname : "/";
      if (!(await this.services.rpc.httpOk(`http://${generated}${path}`))) return "ingress-broken";
    }
    return "up";
  }

  /** Send a test alert to the configured channels; the failures, if any. */
  async testAlert(): Promise<string[]> {
    const settings = alertSettings(this.db);
    if (!settings.ntfy && !settings.webhook) return ["no alert channel is configured"];
    return sendAlert(
      settings,
      {
        fleet: "launcher",
        component: "alerts",
        kind: "test",
        severity: "warn",
        title: "SparkDream launcher: test alert",
        message: "Alerts from this launcher reach you here.",
        action: null,
      },
      this.alertFetch,
    );
  }

  /** Per managed signer: consecutive "no session" checks, last watchdog restart. */
  private readonly signerWatch = new Map<string, { misses: number; lastRestart: number }>();

  /**
   * Monitor pass over launcher-managed tmkms signers (local-signer.ts). Two
   * cures, both convergent: a signer whose config still points at a
   * validator's old mesh address is repointed at once, and one with no
   * privval session for SIGNER_WATCH_MISSES checks in a row is restarted
   * (at most once per SIGNER_WATCH_COOLDOWN_MS). A validator the launcher
   * cannot reach says nothing about the signer and leaves the count alone.
   * Never during an op: ops drive the signer themselves.
   */
  async signerWatchdog(launchId: string): Promise<void> {
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status !== "completed") return;
    if (this.spec(launch).security.keyMode !== "tmkms") return;
    if (this.db.listFleetOps(launch.id, "active").length > 0) return;
    const deps = this.signerDeps(launchId, (m) => console.log(`[signer ${launchId.slice(0, 8)}] ${m}`));
    for (const row of this.db.listFleetComponents(launchId) as FleetComponentRow[]) {
      if (!row.key.startsWith("val-") || row.state !== "active" || !row.tailnet_ip) continue;
      const b = managedSigner(deps, row.key);
      const host = b && hostFor(deps, b);
      if (!b || !host) continue;
      const watchKey = `${launchId}:${row.key}`;
      const w = this.signerWatch.get(watchKey) ?? { misses: 0, lastRestart: 0 };
      this.signerWatch.set(watchKey, w);
      try {
        const view = parseTmkmsConfig(await host.readFile(b.config));
        const addr = view.validators.find((v) => v.chainId === b.chainId)?.addr;
        if (addr && addr !== signerAddr(row.tailnet_ip)) {
          await repointSigner(deps, row.key, row.tailnet_ip, `watchdog: config pointed at ${addr}`);
          w.misses = 0;
          w.lastRestart = Date.now();
          continue;
        }
        let connected: boolean;
        try {
          const probe = await this.services.ssh.exec(this.sshTargetFor(launch, row), SIGNER_CONNECTED_PROBE, {
            quick: true,
          });
          connected = probeSaysConnected(probe.stdout);
        } catch {
          continue;
        }
        if (connected) {
          w.misses = 0;
          continue;
        }
        w.misses++;
        if (w.misses >= SIGNER_WATCH_MISSES && Date.now() - w.lastRestart >= SIGNER_WATCH_COOLDOWN_MS) {
          await restartSigner(deps, row.key, `watchdog: no signer session for ${w.misses} checks`);
          w.misses = 0;
          w.lastRestart = Date.now();
        }
      } catch (e) {
        deps.log?.(`${row.key}: watchdog could not act: ${String(e instanceof Error ? e.message : e)}`);
      }
    }
  }

  /**
   * Which validators' signers the fleet card can offer to manage: those
   * already managed, and those a tmkms process on this machine signs for
   * right now. Undefined (no action at all) on softsign fleets and on a
   * launcher that cannot manage a signer.
   */
  private async localSignerSummary(
    launch: LaunchRow,
    spec: LaunchSpec,
  ): Promise<{ managed: string[]; adoptable: string[]; remote: boolean } | undefined> {
    const host = this.services.localSigner;
    const remote = Boolean(this.services.remoteSigner);
    if ((!host && !remote) || spec.security.keyMode !== "tmkms") return undefined;
    const count = spec.topology.validators.count;
    const rows = this.db.listFleetComponents(launch.id) as FleetComponentRow[];
    const managed: string[] = [];
    const adoptable: string[] = [];
    for (let v = 0; v < count; v++) {
      const key = `val-${v}`;
      if (getBinding(this.db, launch.id, key)) {
        managed.push(key);
        continue;
      }
      const ip = rows.find((r) => r.key === key)?.tailnet_ip ?? null;
      const found = host ? await candidateFor(host, chainId(spec), key, ip, count).catch(() => null) : null;
      // a released signer still runs under the launcher's unit: adopting it
      // again only re-records the binding
      if (found) adoptable.push(key);
    }
    return { managed, adoptable, remote };
  }

  /** Signer deps for this launch: the local machine, and remote ones over SSH. */
  private signerDeps(launchId: string, log?: (m: string) => void): SignerDeps {
    return {
      db: this.db,
      host: this.services.localSigner,
      remote: this.services.remoteSigner,
      launchId,
      ...(log ? { log } : {}),
    };
  }

  /** Managed-signer state per validator, for the tmkms panel. */
  async localSignerView(launch: LaunchRow): Promise<LocalSignerView> {
    const local = this.services.localSigner;
    const deps = this.signerDeps(launch.id);
    const spec = this.spec(launch);
    const rows = this.db.listFleetComponents(launch.id) as FleetComponentRow[];
    const validators: LocalSignerView["validators"] = [];
    for (let v = 0; v < spec.topology.validators.count; v++) {
      const key = `val-${v}`;
      const b = getBinding(this.db, launch.id, key);
      const host = b ? hostFor(deps, b) : undefined;
      const ip = rows.find((r) => r.key === key)?.tailnet_ip ?? null;
      if (!b || !host) {
        const adoptable = local
          ? Boolean(await candidateFor(local, chainId(spec), key, ip, spec.topology.validators.count).catch(() => null))
          : false;
        validators.push({ key, managed: false, adoptable, unit: null, active: null, config: null, addr: null, addrMatches: null, lastAction: null, machine: null });
        continue;
      }
      let addr: string | null = null;
      try {
        addr = parseTmkmsConfig(await host.readFile(b.config)).validators.find((x) => x.chainId === b.chainId)?.addr ?? null;
      } catch {
        addr = null;
      }
      validators.push({
        key,
        managed: true,
        adoptable: false,
        unit: b.unit,
        active: await host.unitActive(b.unit, b.scope).catch(() => null),
        machine: b.remote ? (b.remote.alias ?? b.remote.host) : "this machine",
        config: b.config,
        addr,
        addrMatches: addr && ip ? addr === signerAddr(ip) : null,
        lastAction: b.lastAction ?? null,
      });
    }
    return { available: Boolean(local || this.services.remoteSigner), validators };
  }

  /** Move the running tmkms signer for `key` under a launcher-owned unit. */
  async adoptLocalSigner(launch: LaunchRow, key: string, remoteAlias?: string): Promise<LocalSignerBinding> {
    const spec = this.spec(launch);
    if (spec.security.keyMode !== "tmkms") throw new Error("launch is not in tmkms mode");
    if (!/^val-\d+$/.test(key) || Number(key.slice(4)) >= spec.topology.validators.count) {
      throw new Error(`${key} is not a validator of this fleet`);
    }
    const row = (this.db.listFleetComponents(launch.id) as FleetComponentRow[]).find((r) => r.key === key);
    const ip = row?.tailnet_ip ?? this.db.stepOutput<{ ips: Record<string, string> }>(launch.id, "await-mesh")?.ips[key] ?? null;
    // a signer on another machine: an ssh_config alias the conductor can read
    let remote: RemoteHost | undefined;
    if (remoteAlias?.trim()) {
      if (!this.services.remoteSigner) throw new Error("this launcher cannot reach a signer over SSH");
      remote = resolveSshAlias(remoteAlias.trim()) ?? undefined;
      if (!remote) throw new Error(`no ssh_config entry (with an IdentityFile) named ${remoteAlias.trim()}`);
    }
    return adoptSigner(this.signerDeps(launch.id), {
      key,
      chainId: chainId(spec),
      tailnetIp: ip,
      validatorCount: spec.topology.validators.count,
      ...(remote ? { remote } : {}),
    });
  }

  /** Forget the binding: the unit keeps running, the launcher stops touching it. */
  releaseLocalSigner(launch: LaunchRow, key: string): void {
    clearBinding(this.db, launch.id, key);
    this.signerWatch.delete(`${launch.id}:${key}`);
  }

  private sshTargetFor(launch: LaunchRow, component: FleetComponentRow) {
    if (!component.ssh_host || !component.ssh_port) {
      throw new Error(`no SSH endpoint recorded for ${component.key}`);
    }
    const dirs = launchDirs(this.workRoot, launch.id);
    return {
      host: component.ssh_host,
      port: component.ssh_port,
      user: "root",
      privateKeyPem: toSsh2CompatiblePrivateKey(readSecretFile(path.join(dirs.secrets, "ssh_ed25519.pem"))),
      // lease-shell fallback for providers whose forwarded ports drop SSH
      shellFallback: {
        creds: this.mtlsCreds(launch),
        hostUri: component.host_uri,
        dseq: component.dseq,
        gseq: 1,
        oseq: 1,
        service: leaseServiceName(component.key),
      },
    };
  }

  /** Push a file into a component's container over SSH (with lease-shell
   *  fallback). Generic: the bytes are written verbatim to remotePath — no
   *  unpacking is done on the node; move or extract the file from the Akash
   *  shell afterwards. Only components that run sshd (nodes + explorer) are
   *  valid targets; headscale and the frontend image have no sshd.
   *  Callers pick the directory with {@link uploadDirFor}. */
  async uploadToNode(
    launch: LaunchRow,
    component: FleetComponentRow,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    uploadDirFor(component.key); // rejects components with no sshd
    const target = this.sshTargetFor(launch, component);
    await this.services.ssh.upload(target, localPath, remotePath);
  }

  /** Escrow top-up: unsigned deposit into the launch's signing loop, plus
   *  the top-up service fee batched into the same tx (§ fee.ts). */
  async requestTopUp(
    launch: LaunchRow,
    component: FleetComponentRow,
    amount: string,
  ): Promise<{ step: string }> {
    const step = `fleet:topup:${component.dseq}`;
    // the deposit must match the escrow's denom — same per-network mapping
    // the SDLs were rendered with
    const denom = PRICING_DENOM[this.spec(launch).infra.akashNetwork];
    const msgs = [accountDepositMsg(launch.owner, component.dseq, { denom, amount })];
    const fee = feeConfig();
    if (fee.topupBps > 0) {
      const coin = await feeCoin(denom, bpsAmount(amount, fee.topupBps), this.services.api);
      if (coin) msgs.push(sendMsg(launch.owner, fee.address, coin));
    }
    this.db.enqueuePendingTx(launch.id, step, JSON.stringify(msgs));
    return { step };
  }

  /**
   * Re-place a component while its launch is still running (§5
   * send-manifests recovery). A relaunch op cannot help here: op steps are
   * appended AFTER the launch steps, so nothing runs while the launch is
   * paused — a node that dies mid-launch would otherwise deadlock the whole
   * thing (seen live: a sentry whose deployment was closed after
   * send-manifests had already checkpointed `done`, leaving await-mesh
   * waiting forever for a container that no longer existed).
   *
   * Instead, undo the node-bootstrap steps for everyone and let the launch
   * redo them. That is safe because each is idempotent for the healthy
   * components — manifests re-PUT unchanged, node data skips on its marker
   * file — while the dead component falls into send-manifests' own
   * "lease is gone" recovery, which re-deploys and re-bids it honoring
   * anti-affinity and the avoid list.
   */
  async requestReplace(
    launch: LaunchRow,
    component: FleetComponentRow,
  ): Promise<{ step?: string; closing: boolean }> {
    if (launch.status === "completed") {
      throw new Error(
        `${component.key}: this launch has finished — use relaunch, which moves the component through a proper op`,
      );
    }
    if (component.key === "headscale") {
      throw new Error("headscale cannot be re-placed mid-launch (it re-keys the whole mesh)");
    }
    // send-manifests only re-deploys what the launch's own plan placed. A
    // component an add-component op brought in (the relayer, say) would be
    // closed here and never come back, and a finished launch re-running its
    // steps after an op-driven mixup is exactly when this gets clicked.
    const plan = this.db.stepOutput<DeploymentPlan>(launch.id, "create-deployments");
    if (plan && !plan.perNode[component.key]) {
      const pending = this.db
        .listSteps(launch.id)
        .filter((s) => s.status !== "done" && !s.name.startsWith("op"))
        .map((s) => s.name);
      throw new Error(
        `${component.key} was added after the launch, so it can only be relaunched once the launch finishes` +
          (pending.length > 0 ? ` (in progress: ${pending.join(", ")})` : "") +
          ". Wait for it to complete, then relaunch.",
      );
    }
    // close it first when it is still leased, so the re-place is a genuine
    // move and the escrow comes back; an already-closed deployment (the
    // usual case here) skips straight to the step reset
    let step: string | undefined;
    const info = await this.services.api
      .deploymentInfo(launch.owner, component.dseq)
      .catch(() => undefined);
    if (info?.state === "active") {
      step = `fleet:close:${component.dseq}`;
      this.db.enqueuePendingTx(
        launch.id,
        step,
        JSON.stringify([closeDeploymentMsg(launch.owner, component.dseq)]),
      );
    }
    // Re-run the steps that place and bootstrap nodes — and everything after
    // them. A launch caught mid-flight has not completed those later steps
    // anyway, so this used to reset only the two placement ones; but a launch
    // that finished and was re-opened (a component died after the fact) has
    // them all marked done, and they then skip. The fresh container is left
    // with nobody discovering its tailnet IP (await-mesh), no peer repointed
    // at it (wire-tunnels, patch-validator-peers), and, on a tmkms fleet, no
    // pause to repoint the signer at its new address (await-signer) — the
    // node boots, times out fetching its pubkey, and crash-loops.
    // a services fleet has its own, shorter pipeline: everything after the
    // manifests (its domain check and the components' configuration)
    for (const name of replaceRerunSteps(this.spec(launch))) {
      this.db.resetStep(launch.id, name);
    }
    return { ...(step ? { step } : {}), closing: info?.state === "active" };
  }

  /** Relaunch / rolling upgrade → fleet_ops rows; steps composed by buildOpSteps. */
  async requestRelaunch(
    launch: LaunchRow,
    component: FleetComponentRow,
    opts: { manualBid?: boolean; auto?: boolean } = {},
  ): Promise<number> {
    // headscale relaunches through a dedicated flow (headscaleRelaunchSteps):
    // a naive redeploy re-keys the whole mesh. A shared-mesh fleet has no
    // headscale of its own to relaunch; the owning fleet runs the op.
    if (component.key === "headscale") {
      const reuse = this.spec(launch).topology.headscale.reuseFleet;
      if (reuse) {
        throw new Error(
          `this fleet rides fleet ${reuse}'s mesh — relaunch the headscale from that fleet's panel`,
        );
      }
    } else if (!isComponentKey(component.key) || COMPONENT_KINDS[component.key].mesh) {
      // mesh members (nodes, and service components whose kind joins the
      // mesh) mint a preauth key via headscale on relaunch
      this.assertMeshAlive(launch, `${component.key} cannot relaunch`);
    }
    const resizing = this.db
      .listFleetOps(launch.id, "active")
      .find((o) => o.kind === "node-resize" && JSON.parse(o.params_json).key === component.key);
    if (resizing) {
      throw new Error(
        `${component.key} is being resized (op #${resizing.id}): abort that op first to relaunch it instead`,
      );
    }
    const prefs = this.db.providerPrefs(launch.owner);
    // always move OFF the current provider (that's the point of a relaunch),
    // plus the wallet's global avoid list
    const avoidProviders = [...new Set([component.provider, ...prefs.avoid])];
    // a previous relaunch on this component may still be active (the user
    // clicked again, or aborted and re-clicked). Two concurrent relaunch ops on
    // one component ping-pong: each op's close step reads the component row,
    // which the other op's manifest step just rewrote to its own new dseq, so
    // each closes what the other deployed — a deploy→lease→deploy loop. Supersede any stacked op first.
    await this.supersedeRelaunchOps(launch, component.key);
    return this.db.createFleetOp(launch.id, "relaunch", {
      key: component.key,
      generation: component.generation + 1,
      avoidProviders,
      preferProviders: prefs.prefer,
      ...(opts.manualBid ? { manualBid: true } : {}),
      // started by auto-recovery: its txs may be signed with the grant
      ...(opts.auto ? { auto: true } : {}),
    });
  }

  /**
   * Move the Mastodon instance to a deployment of another size, data and all
   * (mastodonResizeSteps). The current provider is preferred rather than
   * avoided, since staying keeps the domains' DNS target; the spec records
   * the size only once the new deployment holds the restored data.
   */
  async requestMastodonResize(
    launch: LaunchRow,
    component: FleetComponentRow,
    size: "small" | "standard",
  ): Promise<number> {
    this.assertMastodonIdle(launch, component, "resized");
    return this.queueMastodonMove(launch, component, { size });
  }

  /**
   * What a node resize will do and risk, for the confirmation dialog. Also
   * refuses (throws) what it cannot do: the node already at that size, or a
   * new size whose data volume cannot hold the chain the node keeps now.
   */
  /**
   * Where a moved or added node would start: the latest usable chain-data
   * backup (its age), or block 1 (how long that replay would take, at the
   * fleet's last measured sync rate, else SYNC_RATE_DEFAULT). A join fleet
   * state-syncs and is never asked.
   */
  async backupStanding(launch: LaunchRow): Promise<{
    scratchSync?: { blocks: number; blocksPerSecond: number; hours: number; reason: string };
    latestAgeDays?: number;
  }> {
    const spec = this.spec(launch);
    if (isServicesFleet(spec) || spec.join) return {};
    const usable = this.usableBackup(launch);
    if (usable.record) return { latestAgeDays: Math.floor((Date.now() - Date.parse(usable.record.takenAt)) / 86_400_000) };
    // the fleet view asks on every refresh: the head is read once a minute
    let height = this.headCache.get(launch.id);
    if (!height || Date.now() - height.at > 60_000) {
      const url = await this.sentryRpcUrl(launch).catch(() => null);
      const h = url ? await this.services.rpc.status(url).then((st) => st.latestBlockHeight).catch(() => 0) : 0;
      height = { at: Date.now(), value: h };
      this.headCache.set(launch.id, height);
    }
    if (!height.value) return {};
    const rate = Number(this.db.getSetting(`sync-rate:${launch.id}`)) || SYNC_RATE_DEFAULT;
    return {
      scratchSync: {
        blocks: height.value,
        blocksPerSecond: rate,
        hours: Math.round((height.value / rate / 3600) * 10) / 10,
        reason: usable.reason,
      },
    };
  }

  /** Chain head per launch for backupStanding, read at most once a minute. */
  private readonly headCache = new Map<string, { at: number; value: number }>();

  /** The latest backup a new node would restore, or why there is none. */
  private usableBackup(launch: LaunchRow): { record?: DataBackupRecord; reason: string } {
    if (!lastDataBackup(this.db, launch.id)) return { reason: "this fleet has no chain-data backup" };
    if (!autoRestoreEnabled(this.db, launch.id)) return { reason: "automatic restore from backups is off" };
    const { record, blocker } = latestRestorable(this.db, launch.id, launchDirs(this.workRoot, launch.id).node);
    if (!record) return { reason: blocker ?? "no backup can be restored" };
    return { record, reason: "" };
  }

  /** The confirm-dialog warning for an op that places a node with nothing to restore. */
  async scratchSyncWarnings(launch: LaunchRow, key: string): Promise<string[]> {
    if (!/^(val|sentry)-\d+$/.test(key)) return [];
    const { scratchSync } = await this.backupStanding(launch).catch(() => ({}) as { scratchSync?: undefined });
    if (!scratchSync) return [];
    return [
      `No chain-data backup to start from (${scratchSync.reason}): the new ${key} replays all ` +
        `~${scratchSync.blocks.toLocaleString("en-US")} blocks from its peers, about ${formatHours(scratchSync.hours)} ` +
        `at ~${scratchSync.blocksPerSecond} blocks/s. Taking one first (chain backups… → Back up now) makes this minutes.`,
    ];
  }

  /**
   * Monitor pass: a chain fleet with a backup bucket but no usable chain-data
   * backup, or only one older than BACKUP_STALE_DAYS, is alerted at most
   * once a day (a node it has to move would replay the chain for hours).
   */
  async backupStaleCheck(launchId: string): Promise<void> {
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status === "aborted") return;
    const spec = this.spec(launch);
    if (isServicesFleet(spec) || spec.join || !dataBackupStorage(spec, launchDirs(this.workRoot, launch.id).secrets)) return;
    if (this.db.getStep(launch.id, "finalize")?.status !== "done") return;
    const standing = await this.backupStanding(launch).catch(() => ({}) as Awaited<ReturnType<FleetService["backupStanding"]>>);
    const stale = standing.latestAgeDays !== undefined && standing.latestAgeDays > BACKUP_STALE_DAYS;
    if (!standing.scratchSync && !stale) return;
    const today = new Date().toISOString().slice(0, 10);
    const key = `backup-stale-alerted:${launch.id}`;
    if (this.db.getSetting(key) === today) return;
    this.db.setSetting(key, today);
    await this.notify(
      launch,
      "chain-data",
      stale ? `chain-data backup ${standing.latestAgeDays} days old` : "no chain-data backup",
      stale
        ? `The latest chain-data backup is ${standing.latestAgeDays} days old: a node moved now replays everything since. Take one (chain backups… → Back up now) or set a schedule.`
        : `A node this fleet has to move or add replays all ~${standing.scratchSync!.blocks.toLocaleString("en-US")} blocks (about ${formatHours(standing.scratchSync!.hours)}). Take a backup (chain backups… → Back up now), then set a schedule.`,
    );
  }

  async nodeResizeWarnings(launch: LaunchRow, component: FleetComponentRow, size: NodeSize): Promise<string[]> {
    const spec = this.spec(launch);
    this.assertNodeResizable(launch, component, size);
    const role = nodeRole(component.key);
    const target = NODE_SIZES[size][role];
    const warnings: string[] = [];
    // a full sync brings the whole block history along, so the new data
    // volume has to hold what this node holds now, with room to grow
    try {
      const out = await this.services.ssh.exec(
        this.sshTargetFor(launch, component),
        `du -sm ${NODE_HOME}/data 2>/dev/null | cut -f1`,
        { quick: true },
      );
      const usedMb = Number(out.stdout.trim());
      const capacityMb = sizeToBytes(target.storage.data) / 2 ** 20;
      if (Number.isFinite(usedMb) && usedMb > 0 && usedMb > capacityMb * 0.8) {
        throw new Error(
          `${component.key} holds ${Math.round(usedMb / 1024)} GiB of chain data, more than "${size}" ` +
            `(${target.storage.data}) can take with room to grow: pick a larger size`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("pick a larger size")) throw e;
      warnings.push(
        `could not read how much chain data ${component.key} holds, so whether ${target.storage.data} is ` +
          "enough was not checked",
      );
    }
    warnings.push(
      `A new ${size} deployment (${target.cpu} CPU, ${target.memory} RAM, ${target.storage.data} data) is ` +
        `created beside the running ${component.key} on the same provider (if that provider does not bid ` +
        "or its bid is passed over, the op pauses for you to lease the selection policy's pick or a bid " +
        "of your own), and " +
        (spec.join
          ? "state-syncs from the chain"
          : this.usableBackup(launch).record
            ? `starts from the chain-data backup taken at height ${this.usableBackup(launch).record!.height.toLocaleString("en-US")}, then syncs the rest off the fleet's own nodes`
            : "syncs the whole chain from block 1 off the fleet's own nodes") +
        " while the current node keeps running. On a long chain this takes hours, both deployments are " +
        "paid for meanwhile, and the fleet's other operations wait until it is done.",
    );
    warnings.push(...(await this.scratchSyncWarnings(launch, component.key)));
    if (role === "validator") {
      warnings.push(
        spec.security.keyMode === "tmkms"
          ? `At the cutover ${component.key} moves to a new mesh address and signs nothing until your ` +
              "tmkms signer dials it. Once the sync is done the op pauses BEFORE the cutover to give you " +
              "the new address to put in tmkms.toml; after the handover (about a minute) it pauses again " +
              "for you to restart the signer. Be at the signer when you resume: missed blocks count " +
              "toward downtime jailing."
          : `At the cutover ${component.key} stops signing for about a minute. Its last signed height ` +
              "moves to the new node with it, so the new node cannot double-sign.",
      );
      if (!spec.join && spec.topology.validators.count === 1) {
        warnings.push("This chain has a single validator: it produces no blocks during the cutover.");
      }
    } else {
      warnings.push(
        ...this.sentryIsolationWarnings(spec, component, "during the cutover (about a minute)"),
      );
      if (component.key === "sentry-0" && (spec.topology.publicEndpoints?.api || spec.topology.publicEndpoints?.rpc)) {
        warnings.push(
          "sentry-0 serves the public API/RPC domains: if the new deployment lands on another provider, " +
            "their DNS records must be pointed at it.",
        );
      }
    }
    return warnings;
  }

  /**
   * Move a chain node to a deployment of another size (nodeResizeSteps): the
   * new one syncs beside the running node, then takes over its identity.
   * The current provider is preferred, so a public sentry's domains keep
   * their DNS target.
   */
  async requestNodeResize(launch: LaunchRow, component: FleetComponentRow, size: NodeSize): Promise<number> {
    this.assertNodeResizable(launch, component, size);
    this.assertMeshAlive(launch, `${component.key} cannot be resized`);
    const prefs = this.db.providerPrefs(launch.owner);
    return this.db.createFleetOp(launch.id, "node-resize", {
      key: component.key,
      generation: component.generation + 1,
      avoidProviders: prefs.avoid.filter((p) => p !== component.provider),
      preferProviders: [...new Set([component.provider, ...prefs.prefer])],
      // a provider on the wallet's avoid list is not one to stay on
      ...(prefs.avoid.includes(component.provider) ? {} : { stayOn: component.provider }),
      size,
    } satisfies NodeResizeParams);
  }

  /**
   * What the resize dialog shows: the node's current size and resources, each
   * size with its estimate, the data disk's use, and whether a size is too
   * small to sync into (the same 80 % rule nodeResizeWarnings refuses by) or
   * the resize is blocked outright.
   */
  async resizeOptions(launch: LaunchRow, component: FleetComponentRow): Promise<{
    current: { size: NodeSize | "custom"; resources: RoleResources };
    sizes: Array<{ id: NodeSize; resources: RoleResources; lowUsd: number; highUsd: number; tooSmall?: string }>;
    disk: NodeDisk | null;
    blocked?: string;
    /** what the cutover risks, one short line each (the confirm the dialog replaced said these) */
    risks: string[];
    /** a tmkms validator: the op pauses for the signer before and after the cutover */
    tmkms: boolean;
  }> {
    const spec = this.spec(launch);
    const role = nodeRole(component.key);
    const risks: string[] = [];
    if (role === "validator" && !spec.join && spec.topology.validators.count === 1) {
      risks.push("This chain has a single validator: it produces no blocks during the cutover.");
    }
    for (const w of this.sentryIsolationWarnings(spec, component, "for the minute of the cutover")) risks.push(`${w}.`);
    if (
      component.key === "sentry-0" &&
      (spec.topology.publicEndpoints?.api || spec.topology.publicEndpoints?.rpc) &&
      !cloudflareToken(this.workRoot)
    ) {
      risks.push("sentry-0 serves the public API/RPC: if it moves provider, point their DNS records at it.");
    }
    const disk = await this.componentDisk(launch, component).catch(() => null);
    let blocked: string | undefined;
    try {
      // any size other than the current one passes the size check
      const other = (["small", "standard", "large"] as const).find((s) => s !== nodeSize(spec, component.key))!;
      this.assertNodeResizable(launch, component, other);
    } catch (e) {
      blocked = e instanceof Error ? e.message : String(e);
    }
    return {
      current: { size: nodeSize(spec, component.key), resources: nodeResources(spec, component.key) },
      sizes: (["small", "standard", "large"] as const).map((id) => {
        const resources = NODE_SIZES[id][role];
        const capacity = sizeToBytes(resources.storage.data);
        return {
          id,
          resources,
          ...estimateNode(resources),
          ...(disk && disk.usedBytes > capacity * 0.8
            ? { tooSmall: `${component.key} holds ${Math.round(disk.usedBytes / 2 ** 30)} GiB of chain data, more than ${resources.storage.data} can take with room to grow` }
            : {}),
        };
      }),
      disk,
      ...(blocked ? { blocked } : {}),
      risks,
      tmkms: role === "validator" && spec.security.keyMode === "tmkms",
    };
  }

  private assertNodeResizable(launch: LaunchRow, component: FleetComponentRow, size: NodeSize): void {
    if (!/^(val|sentry)-\d+$/.test(component.key)) {
      throw new Error("only chain nodes (validators and sentries) are resized this way");
    }
    if (component.state !== "active") throw new Error(`${component.key} is ${component.state}, not active`);
    const current = nodeSize(this.spec(launch), component.key);
    if (current === size) throw new Error(`${component.key} is already ${size}`);
    const active = this.db.listFleetOps(launch.id, "active");
    const moving = active.find(
      (o) =>
        (o.kind === "relaunch" || o.kind === "node-resize") && JSON.parse(o.params_json).key === component.key,
    );
    if (moving) throw new Error(`${component.key} is already being moved (op #${moving.id}): finish or abort that op first`);
    // one at a time: a resize holds the fleet's nodes as its sync source
    const other = active.find((o) => o.kind === "node-resize");
    if (other) {
      throw new Error(
        `${JSON.parse(other.params_json).key} is being resized (op #${other.id}): resize one node at a time`,
      );
    }
  }

  private assertMastodonIdle(launch: LaunchRow, component: FleetComponentRow, verb: string): void {
    if (component.key !== "mastodon") throw new Error(`only the Mastodon component can be ${verb}`);
    if (component.state !== "active") throw new Error(`mastodon is ${component.state}, not active`);
    if (launch.status !== "completed") throw new Error("the launch has not finished");
    const busy = this.db
      .listFleetOps(launch.id, "active")
      .some((o) => o.kind === "mastodon-resize" || (o.kind === "relaunch" && JSON.parse(o.params_json).key === "mastodon"));
    if (busy) throw new Error("Mastodon is already being moved: finish or abort that op first");
  }

  private queueMastodonMove(
    launch: LaunchRow,
    component: FleetComponentRow,
    move: Pick<MastodonResizeParams, "size" | "walletLogin">,
  ): number {
    const prefs = this.db.providerPrefs(launch.owner);
    return this.db.createFleetOp(launch.id, "mastodon-resize", {
      key: "mastodon",
      generation: component.generation + 1,
      avoidProviders: prefs.avoid.filter((p) => p !== component.provider),
      preferProviders: [...new Set([component.provider, ...prefs.prefer])],
      ...move,
    } satisfies MastodonResizeParams);
  }

  /** Whether applying `settings` moves the instance to a new deployment
   *  (throws when they do not validate); nothing is changed. */
  mastodonSettingsMove(launch: LaunchRow, settings: MastodonSettings): boolean {
    return this.planMastodonSettings(launch, settings).move;
  }

  /**
   * The login domain the running deployment serves, read from its SDL (the
   * spec's default may have moved on since it was rendered), or undefined
   * when it runs no login service.
   */
  private deployedLoginDomain(launch: LaunchRow): string | undefined {
    const file = path.join(launchDirs(this.workRoot, launch.id).sdl, "mastodon.yaml");
    if (!fs.existsSync(file)) return mastodonLoginDomain(this.spec(launch));
    const doc = yaml.load(fs.readFileSync(file, "utf8")) as any;
    const login = doc?.services?.login;
    if (!login) return undefined;
    return (login.expose ?? []).flatMap((e: { accept?: string[] }) => e.accept ?? [])[0];
  }

  private planMastodonSettings(launch: LaunchRow, settings: MastodonSettings) {
    const current = this.spec(launch);
    const stored = JSON.parse(launch.spec_json);
    const m = stored.topology.components.mastodon;
    if (!m?.enabled) throw new Error("this fleet runs no Mastodon");
    if (settings.registrations) m.registrations = settings.registrations;
    const walletLogin = settings.walletLogin ? { ...(m.walletLogin ?? {}), ...settings.walletLogin } : m.walletLogin;
    const next = withDefaults({
      ...stored,
      topology: { ...stored.topology, components: { ...stored.topology.components, mastodon: { ...m, walletLogin } } },
    });
    const { errors } = validateSpec(next);
    if (errors.length > 0) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    const deployed = this.deployedLoginDomain(launch);
    const wanted = mastodonLoginDomain(next);
    // a login service added or dropped is a new deployment; a login domain
    // that moves while sign-in stays on is a manifest change, done in place
    const move = (deployed === undefined) !== (wanted === undefined);
    const retarget = !move && wanted !== undefined && deployed !== wanted;
    return { current, stored, m, walletLogin, move, retarget };
  }

  /**
   * Change a running Mastodon's settings: who may sign up, and wallet
   * sign-in. What only the instance itself holds (the registrations mode,
   * the sign-in trust floor, which live in its database and the chain list)
   * is applied in place by a "reconfigure", with no signature. A new login
   * domain is a manifest change: a "retarget" updates the deployment in
   * place (one signature) and gates on the new domain. Turning wallet
   * sign-in on or off changes the deployment's services, which Akash
   * cannot do to a running deployment: that is the
   * resize's move at the current size, data and all, and the spec takes the
   * sign-in settings only once the new deployment holds the data.
   */
  requestMastodonSettings(
    launch: LaunchRow,
    component: FleetComponentRow,
    settings: MastodonSettings,
  ): { opId: number; move: boolean } {
    this.assertMastodonIdle(launch, component, "reconfigured");
    const { current, stored, m, walletLogin, move, retarget } = this.planMastodonSettings(launch, settings);
    if (move) {
      // registrations apply now (the move's configure sets them); sign-in
      // lands in the spec with the new deployment
      this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
      const size = current.topology.components.mastodon!.size ?? "small";
      return { opId: this.queueMastodonMove(launch, component, { size, walletLogin }), move };
    }
    if (walletLogin) m.walletLogin = walletLogin;
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
    // the login domain first (one deployment update, then its DNS gate),
    // then configure re-applies registrations and re-syncs the chains
    if (retarget) this.db.createFleetOp(launch.id, "retarget", { components: ["mastodon"] } satisfies RetargetParams);
    const opId = this.db.createFleetOp(launch.id, "reconfigure", { keys: ["mastodon"] } satisfies ReconfigureParams);
    return { opId, move };
  }

  /**
   * Set the other Mastodon servers the bridge anchors for as peers of their
   * own (mastodon.bridge.peers), on a running fleet: the spec takes the list
   * (entries already there keep their authors setting), and a "reconfigure"
   * op registers and binds the new ones and updates the bridge's peer list
   * in place, as does one for every verifier watching this chain. A server
   * dropped from the list stops being watched; its peer and binding stay on
   * chain, for the committee to suspend or remove.
   */
  requestBridgePeers(launch: LaunchRow, ids: string[]): Array<{ launchId: string; opId: number }> {
    const spec = this.spec(launch);
    // the fleet's bridge: its Mastodon's sidecar, or a standalone component
    const fb = fleetBridge(spec);
    if (!fb) throw new Error("this fleet runs no bridge");
    const host = fb.kind === "sidecar" ? "mastodon" : "bridge";
    const row = this.db.listFleetComponents(launch.id).find((c) => c.key === host);
    if (row?.state !== "active") throw new Error(`the ${host === "bridge" ? "bridge" : "Mastodon"} is not running`);
    const wanted = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    const kept = new Map((fb.link.peers ?? []).map((p) => [p.id.toLowerCase(), p]));
    const stored = JSON.parse(launch.spec_json);
    const storedLink = fb.kind === "sidecar" ? stored.topology.components.mastodon.bridge : stored.topology.components.bridge;
    storedLink.peers = wanted.map((id) => kept.get(id) ?? { id });
    const { errors } = validateSpec(withDefaults(stored));
    if (errors.length > 0) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));

    const ops: Array<{ launchId: string; opId: number }> = [];
    const ownVerifier = this.db.listFleetComponents(launch.id).some((c) => c.key === "verifier" && c.state === "active") &&
      !spec.topology.components.verifier?.target;
    ops.push({
      launchId: launch.id,
      opId: this.db.createFleetOp(launch.id, "reconfigure", {
        keys: [host, ...(ownVerifier ? ["verifier"] : [])],
      } satisfies ReconfigureParams),
    });
    // a verifier on another fleet of this launcher that checks this chain
    for (const other of this.db.listLaunches()) {
      if (other.id === launch.id || other.status !== "completed") continue;
      const v = this.spec(other).topology.components.verifier;
      if (!v?.enabled || v.target?.fleet !== launch.id || v.peers?.length) continue;
      if (!this.db.listFleetComponents(other.id).some((c) => c.key === "verifier" && c.state === "active")) continue;
      ops.push({ launchId: other.id, opId: this.db.createFleetOp(other.id, "reconfigure", { keys: ["verifier"] } satisfies ReconfigureParams) });
    }
    return ops;
  }

  /**
   * Take a closed service component out of the fleet: the spec stops
   * enabling it (its settings stay, so adding it back later starts from
   * them) and its row and health go. What it set up elsewhere stays where it
   * is: its peer and bond on chain, its secrets here (a Mastodon's keys, the
   * bridge operator's key), for a re-add to pick up. A daemon's session
   * grant is retired by the next "sessions" op, which finds no component
   * running it.
   */
  /**
   * What the fleet card's add dialog offers: every kind this fleet can
   * still add, and a sentry for a running chain fleet, each with what it is
   * for, the image it would run, an estimate (the launch cost table's
   * rates, USD/month) and the steps it goes through, so the choice and its
   * cost are visible before anything is signed.
   */
  async addOptions(launch: LaunchRow): Promise<AddOptions> {
    const spec = this.spec(launch);
    const rows = this.db.listFleetComponents(launch.id) as FleetComponentRow[];
    const chain = !isServicesFleet(spec);
    const images = spec.images as Record<string, string | undefined>;
    const defaults = profiles[spec.network.type]?.images as Record<string, string | undefined> | undefined;
    const tagOf = (image?: string) => image?.split(":").pop();
    const kinds: AddOptions["kinds"] = [];
    for (const key of COMPONENT_KEYS) {
      if (!chain && !SERVICES_FLEET_COMPONENTS.includes(key)) continue;
      if (rows.some((r) => r.key === key && r.state !== "closed")) continue;
      // a component added now runs the current release (requestAddComponent)
      const current = images[key];
      const latest = defaults?.[key];
      const latestTag = latest ? versionTag(latest) : undefined;
      const image =
        current && latest && latestTag && imageRepo(current) === imageRepo(latest) && imageBefore(current, `v${latestTag.join(".")}`)
          ? latest
          : (current ?? latest);
      const kind = COMPONENT_KINDS[key];
      // priced as it would deploy: enabled in the spec. A kind whose
      // settings are still missing (a relayer's paths) has no estimate yet
      let estimate: { lowUsd: number; highUsd: number } | undefined;
      try {
        const preview = withDefaults({
          ...JSON.parse(launch.spec_json),
          topology: {
            ...spec.topology,
            components: { ...spec.topology.components, [key]: { ...(spec.topology.components as any)[key], enabled: true } },
          },
        } as any);
        estimate = estimateComponent(preview, key);
      } catch {
        // most kinds' resources do not depend on their settings
        estimate = estimateComponent(spec, key);
      }
      kinds.push({
        key,
        label: kind.label,
        summary: kind.summary,
        ...(tagOf(image) ? { version: tagOf(image)! } : {}),
        needsDomain: kind.domain,
        ...(estimate ? { lowUsd: estimate.lowUsd, highUsd: estimate.highUsd } : {}),
        signatures: 2,
        steps: [
          "New lease on an Akash provider, off the ones your wallet avoids",
          "Deposit and 2 signatures (deployment, lease)",
          `Pulls ${key}${tagOf(image) ? ` ${tagOf(image)}` : ""} and starts it`,
          kind.domain
            ? "Its domain is pointed at it (with the Cloudflare token) and checked until it answers"
            : "Checked until its lease is up",
        ],
      });
    }
    let sentry: AddOptions["sentry"];
    const active = rows.filter((r) => r.state === "active");
    if (chain && launch.status !== "aborted" && active.length > 0) {
      const next = `sentry-${spec.topology.sentries.count}`;
      const standing = await this.backupStanding(launch).catch(() => ({}) as Awaited<ReturnType<FleetService["backupStanding"]>>);
      const backup = this.usableBackup(launch).record;
      sentry = {
        name: next,
        have: rows.filter((r) => r.key.startsWith("sentry-") && r.state !== "closed").length,
        signatures: 3,
        sizes: (["small", "standard", "large"] as const).map((id) => {
          const r = NODE_SIZES[id].sentry;
          const e = estimateNode(r);
          return { id, cpu: r.cpu, memory: r.memory, data: r.storage.data, lowUsd: e.lowUsd, highUsd: e.highUsd };
        }),
        steps: [
          "New lease on a provider other than the fleet's nodes', off the ones your wallet avoids",
          "Deposit and 3 signatures",
          backup
            ? `Restores the latest chain-data backup (height ${backup.height.toLocaleString("en-US")})`
            : standing.scratchSync
              ? `No chain-data backup: replays all ~${standing.scratchSync.blocks.toLocaleString("en-US")} blocks from block 1, about ${formatHours(standing.scratchSync.hours)} (take a backup first to make this minutes)`
              : "Syncs the chain from its peers",
          "Syncs the remaining blocks from its peers and joins the mesh",
        ],
        ...(standing.scratchSync ? { scratchSync: standing.scratchSync } : {}),
      };
    }
    return { kinds, ...(sentry ? { sentry } : {}) };
  }

  /**
   * Take the fleet's closed, highest-numbered sentry out (add-sentry.ts
   * removeSentry): the spec counts one fewer, its row and node id go, and
   * the other nodes, here and running, stop listing it as a peer. Returns
   * the running nodes that could not be edited (they drop it at a later
   * repair or relaunch).
   */
  async removeSentry(launch: LaunchRow, key: string): Promise<{ unreachable: string[] }> {
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another operation is in progress: remove the sentry once it is done");
    }
    return removeSentry(this.db, launchDirs(this.workRoot, launch.id), launch.id, key, async (row, command) => {
      const full = (this.db.listFleetComponents(launch.id) as FleetComponentRow[]).find((c) => c.key === row.key)!;
      await this.services.ssh.exec(this.sshTargetFor(launch, full), command);
    });
  }

  removeComponent(launch: LaunchRow, key: string): void {
    if (!isComponentKey(key)) throw new Error(`${key} is not a service component; nodes and the mesh are not removed this way`);
    const row = this.db.listFleetComponents(launch.id).find((c) => c.key === key);
    if (!row) throw new Error(`${key} is not in this fleet`);
    if (row.state !== "closed") throw new Error(`close ${key} first: only a closed component can be removed`);
    const busy = this.db.listFleetOps(launch.id, "active").some((o) => {
      try {
        const p = JSON.parse(o.params_json);
        return p.key === key || (Array.isArray(p.keys) && p.keys.includes(key)) || (Array.isArray(p.components) && p.components.includes(key));
      } catch {
        return false;
      }
    });
    if (busy) throw new Error(`an op on ${key} is still running: finish or abort it first`);
    const stored = JSON.parse(launch.spec_json);
    const comp = stored.topology?.components?.[key];
    if (comp) comp.enabled = false;
    const { errors } = validateSpec(withDefaults(stored));
    if (errors.length > 0) {
      throw new Error(`without ${key} the spec would not validate: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    }
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
    this.db.deleteFleetComponent(launch.id, key);
  }

  /**
   * Set the wallets a fleet is shared with (sharing.wallets): their chain
   * fleets may link bridges to a services fleet's Mastodon, and their
   * relayers may relay to a chain fleet. Owner only (the route checks).
   * Removing a wallet does not undo links already made; it stops new links
   * and re-links.
   */
  setSharing(launch: LaunchRow, wallets: string[]): string[] {
    const list = [...new Set(wallets.map((w) => w.trim()).filter(Boolean))].filter((w) => w !== launch.owner);
    const stored = JSON.parse(launch.spec_json);
    if (list.length > 0) stored.sharing = { wallets: list };
    else delete stored.sharing;
    const { errors } = validateSpec(withDefaults(stored));
    if (errors.length > 0) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
    return list;
  }

  /** Joining the mesh mints a preauth key via headscale — impossible once the
   *  mesh is gone. A shared mesh (reuseFleet) has no headscale row here;
   *  check the owning fleet's. */
  private assertMeshAlive(launch: LaunchRow, what: string): void {
    const reuse = this.spec(launch).topology.headscale.reuseFleet;
    const hs = this.db
      .listFleetComponents(reuse ?? launch.id)
      .find((c) => c.key === "headscale");
    if (hs?.state === "closed" || (reuse && !hs)) {
      throw new Error(
        `${what}: ` +
          (reuse
            ? `the shared headscale (fleet ${reuse}) is closed or gone`
            : "headscale is closed (fleet shut down)") +
          " — joining the mesh needs it to mint a preauth key",
      );
    }
  }

  /** Live balance of every relayer key, with what each needs (funds panel). */
  async relayerFunds(launch: LaunchRow): Promise<RelayerFunds[]> {
    const waiting = new Set((this.relayerState(launch)?.waiting ?? []).map((w) => w.chainId));
    return relayerFunds(
      this.db, this.services.rpc, launch.id, this.spec(launch), launchDirs(this.workRoot, launch.id).secrets, waiting,
    );
  }

  /** Keys an opened path depends on that are low or empty, as health detail
   *  lines. Balances are read at most every RELAYER_FUNDS_EVERY_MS (they are
   *  remote REST calls, and a key drains over days, not minutes). */
  private async relayerLowFunds(launch: LaunchRow): Promise<string[]> {
    const cached = this.relayerFundChecks.get(launch.id);
    if (cached && Date.now() - cached.at < RELAYER_FUNDS_EVERY_MS) return cached.low;
    const low = lowFundsDetail(await this.relayerFunds(launch).catch(() => []));
    this.relayerFundChecks.set(launch.id, { at: Date.now(), low });
    return low;
  }

  /** Send a relayer key's whole balance on one chain (less the fee) to `to`,
   *  by default the owner's own address there. */
  async withdrawRelayerFunds(
    launch: LaunchRow,
    chainId: string,
    to?: string,
  ): Promise<{ txHash: string; amount: string; denom: string; to: string }> {
    const spec = this.spec(launch);
    const funds = await this.relayerFunds(launch);
    const key = funds.find((f) => f.chainId === chainId);
    if (!key) throw new Error(`the relayer has no key on ${chainId}`);
    const prefix = fromBech32(key.address).prefix;
    const dest = to?.trim() || ownerAddressOn(launch.owner, prefix);
    if (!dest) throw new Error(`name an address on ${chainId} to send to`);
    const out = await withdrawRelayerFunds(
      this.db, this.services.rpc, launch.id, spec, launchDirs(this.workRoot, launch.id).secrets, chainId, dest,
      this.withdrawDeps,
    );
    this.relayerFundChecks.delete(launch.id);
    return out;
  }

  /** The relayer's addresses and channels from its last link, if any. */
  relayerState(launch: LaunchRow): RelayerLinkOutput | undefined {
    const file = relayerStatePath(this.workRoot, launch.id);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as RelayerLinkOutput) : undefined;
  }

  /**
   * Evict stray mesh nodes (mesh-strays.ts): leftovers of replaced
   * components that their provider kept running after the lease closed.
   * Only on a settled fleet (completed and not being driven, so no placement
   * is mid-flight), at most every MESH_STRAY_EVERY_MS, and alerted when it
   * finds any: a closed lease still running is the provider's fault and
   * worth knowing about.
   */
  async evictMeshStrays(launchId: string): Promise<void> {
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status !== "completed") return;
    const last = this.meshStrayChecks.get(launchId) ?? 0;
    if (Date.now() - last < MESH_STRAY_EVERY_MS) return;
    this.meshStrayChecks.set(launchId, Date.now());
    const rows = this.db.listFleetComponents(launchId) as FleetComponentRow[];
    const own = rows.find((c) => c.key === "headscale" && c.state === "active");
    const hs = own
      ? { hostUri: own.host_uri, dseq: own.dseq, gseq: 1, oseq: 1 }
      : this.db.stepOutput<{ hostUri: string; dseq: string; gseq: number; oseq: number }>(launchId, "deploy-headscale");
    if (!hs) return; // services fleet without a mesh
    const spec = this.spec(launch);
    const dirs = launchDirs(this.workRoot, launchId);
    const res = await sweepMeshStrays(spec, rows, {
      headscale: async (script) =>
        (await this.services.provider.shellExec(this.mtlsCreds(launch), hs.hostUri, hs.dseq, hs.gseq, hs.oseq, "headscale", ["sh", "-c", script]))
          .stdout,
      liveIp: async (row) => {
        if (!row.ssh_host) return null;
        let sdl: string | undefined;
        try {
          sdl = fs.readFileSync(path.join(dirs.sdl, `${row.key}.yaml`), "utf8");
        } catch {
          sdl = undefined;
        }
        const { stdout } = await this.services.ssh.exec(
          this.sshTargetFor(launch, row),
          `tailscale --socket=${meshSocketFromSdl(sdl, NODE_HOME)} ip -4 2>/dev/null || true`,
          { quick: true },
        );
        return stdout.trim().split("\n")[0] || null;
      },
      log: () => {},
    });
    if (res.evicted.length > 0) {
      const names = res.evicted.map((n) => `${n.givenName} (${n.ip}${n.online ? ", online" : ""})`).join(", ");
      await this.notify(
        launch,
        "headscale",
        "evicted leftover mesh nodes",
        `Removed from the mesh: ${names}. These are replaced components' old nodes; any marked online ` +
          "is a container its provider kept running after the lease closed.",
      ).catch(() => {});
    }
  }

  /**
   * Whether the daemons' session keys need a "sessions" op (§5 session keys):
   * a running daemon with no key, a moved one, a due renewal or a retired
   * daemon's grant (local records, every pass), or a grant the chain no
   * longer honours, spent or revoked or reset away (checked hourly).
   */
  async sessionsDue(launchId: string): Promise<boolean> {
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status !== "completed") return false;
    const spec = this.spec(launch);
    const secrets = launchDirs(this.workRoot, launchId).secrets;
    if (sessionsDue(this.db, launchId, secrets, spec)) return true;
    const last = this.sessionChecks.get(launchId) ?? 0;
    if (Date.now() - last < 3_600_000) return false;
    this.sessionChecks.set(launchId, Date.now());
    for (const [role, record] of Object.entries(readSessions(secrets))) {
      const chainLaunch = this.db.getLaunch(sessionChainLaunch(spec, launchId, role as SessionRole));
      const rpc = chainLaunch ? await this.sentryRpcUrl(chainLaunch) : null;
      if (!rpc) continue;
      const holds = await runWithAssets(resolveChainAssets(this.spec(chainLaunch!), this.workRoot), () =>
        grantHolds(rpc, record),
      ).catch(() => true); // an unanswered query is no reason to rotate
      if (!holds) return true;
    }
    return false;
  }

  /**
   * Queue a "sessions" op: renew what is due, or rotate `force`'s roles now
   * (the fleet panel's rotate button). The monitor's own requests step aside
   * while any other op runs; a user's request says why it cannot start.
   */
  requestSessions(launch: LaunchRow, force: SessionRole[] = []): number | undefined {
    const spec = this.spec(launch);
    for (const role of force) {
      if (!sessionRoles(spec).includes(role)) throw new Error(`this fleet runs no ${role} daemon`);
    }
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      if (force.length > 0) throw new Error("another operation is in progress: rotate once it is done");
      return undefined;
    }
    return this.db.createFleetOp(launch.id, "sessions", { force });
  }

  /**
   * Correct a running chain fleet's token.minGasPrice (a price per gas unit
   * in the base denom) and converge every node to it: the stored spec, the
   * launcher's node copies and relaunch bundles, and each live node's
   * app.toml ("gas-price" op). Refuses a value that is a fee, not a price.
   */
  /**
   * Copy a node's chain data to the fleet's backup bucket ("data-backup"
   * op). The source is a sentry other than sentry-0 when there is one; with
   * only sentry-0 the public endpoints and the validator's path go quiet
   * for the copy, which the UI warns about (and the schedule never does).
   */
  requestDataBackup(launch: LaunchRow, opts: { auto?: boolean } = {}): { opId: number; source: string } {
    const spec = this.spec(launch);
    if (isServicesFleet(spec)) throw new Error("a services fleet has no chain data");
    if (!dataBackupStorage(spec, launchDirs(this.workRoot, launch.id).secrets)) {
      throw new Error("turn on the mesh backup first: chain data goes to the same bucket");
    }
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another operation is in progress: back up once it is done");
    }
    const source = this.backupSourceFor(launch.id, opts);
    if (!source) throw new Error("no running sentry to copy the chain data from");
    if (opts.auto && source.key === "sentry-0") throw new Error("scheduled backups need a second sentry");
    const opId = this.db.createFleetOp(launch.id, "data-backup", {
      source: source.key,
      ...(opts.auto ? { auto: true } : {}),
    } satisfies DataBackupParams);
    return { opId, source: source.key };
  }

  /**
   * The sentry a backup copies: the fleet's chosen one ("copy from" in the
   * chain backups dialog) while it runs, else the automatic pick
   * (backupSource). A scheduled backup never takes a chosen sentry-0, whose
   * public endpoints would stop for the copy.
   */
  backupSourceFor(launchId: string, opts: { auto?: boolean } = {}): FleetComponentRow | undefined {
    const rows = this.db.listFleetComponents(launchId) as FleetComponentRow[];
    const chosen = this.db.getSetting(`data-backup-source:${launchId}`);
    const row = chosen ? rows.find((r) => r.key === chosen && r.state === "active" && r.ssh_host) : undefined;
    if (row && !(opts.auto && row.key === "sentry-0")) return row;
    return backupSource(rows);
  }

  /** Choose the sentry backups copy, or null for the automatic pick. */
  setDataBackupSource(launch: LaunchRow, key: string | null): void {
    if (key === null) {
      this.db.deleteSetting(`data-backup-source:${launch.id}`);
      return;
    }
    const row = this.db.listFleetComponents(launch.id).find((c) => c.key === key);
    if (!/^sentry-\d+$/.test(key) || !row) throw new Error(`${key} is not a sentry of this fleet (a validator is never copied)`);
    if (row.state !== "active") throw new Error(`${key} is not running`);
    this.db.setSetting(`data-backup-source:${launch.id}`, key);
  }

  /** Replace a node's chain data with a recorded backup, in place ("data-restore" op). */
  requestDataRestore(launch: LaunchRow, component: FleetComponentRow, name: string): number {
    if (!/^(val|sentry)-\d+$/.test(component.key)) throw new Error("only chain nodes hold chain data");
    if (component.state !== "active") throw new Error(`${component.key} is not running`);
    const record = dataBackups(this.db, launch.id).find((r) => r.name === name);
    if (!record) throw new Error(`no backup named ${name} is recorded for this fleet`);
    const blocker = restoreBlocker(this.db, launch.id, launchDirs(this.workRoot, launch.id).node, record);
    if (blocker) throw new Error(blocker);
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another operation is in progress: restore once it is done");
    }
    return this.db.createFleetOp(launch.id, "data-restore", { key: component.key, name } satisfies DataRestoreParams);
  }

  /**
   * Delete a recorded backup from the bucket and the fleet's list (the
   * chain backups dialog's delete). The bucket is reached through a running
   * sentry, which has the backup tools.
   */
  async deleteDataBackup(launch: LaunchRow, name: string): Promise<void> {
    if (!dataBackups(this.db, launch.id).some((r) => r.name === name)) {
      throw new Error(`no backup named ${name} is recorded for this fleet`);
    }
    const running = this.db
      .listFleetOps(launch.id, "active")
      .find((o) => (o.kind === "data-backup" || o.kind === "data-restore") && o.params_json.includes(name));
    if (running) throw new Error(`op ${running.id} is using ${name}: delete it once that is done`);
    const via = backupSource(this.db.listFleetComponents(launch.id) as FleetComponentRow[]);
    if (!via) throw new Error("no running sentry to reach the bucket through");
    await deleteDataBackup(
      this.db,
      this.services,
      launch.id,
      this.spec(launch),
      launchDirs(this.workRoot, launch.id).secrets,
      this.sshTargetFor(launch, via),
      name,
    );
  }

  setAutoRestore(launch: LaunchRow, on: boolean): void {
    this.db.setSetting(`data-restore-auto:${launch.id}`, on ? "on" : "off");
  }

  /** How often scheduled chain-data backups run: "off" (default), "daily" or "weekly". */
  dataBackupSchedule(launchId: string): "off" | "daily" | "weekly" {
    const v = this.db.getSetting(`data-backup-schedule:${launchId}`);
    return v === "daily" || v === "weekly" ? v : "off";
  }

  setDataBackupSchedule(launch: LaunchRow, schedule: string): void {
    if (schedule !== "off" && schedule !== "daily" && schedule !== "weekly") {
      throw new Error('schedule must be "off", "daily" or "weekly"');
    }
    if (schedule !== "off" && !dataBackupStorage(this.spec(launch), launchDirs(this.workRoot, launch.id).secrets)) {
      throw new Error("turn on the mesh backup first: chain data goes to the same bucket");
    }
    this.db.setSetting(`data-backup-schedule:${launch.id}`, schedule);
  }

  /**
   * A scheduled backup is due: on schedule, past its interval, nothing else
   * running, no outage open, and a sentry to copy other than sentry-0 (a
   * schedule never takes the public endpoints down).
   */
  dataBackupDue(launchId: string, now = Date.now()): boolean {
    const schedule = this.dataBackupSchedule(launchId);
    if (schedule === "off") return false;
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status !== "completed") return false;
    if (this.db.listFleetOps(launchId, "active").length > 0) return false;
    // never take a node down while anything is: on 2026-10-07 the schedule
    // held sentry-1, the only node still up, an hour into a mesh outage
    if (this.db.listIncidents(launchId, 0).length > 0) return false;
    const source = this.backupSourceFor(launchId, { auto: true });
    if (!source || source.key === "sentry-0") return false;
    // a backup that never passed its check does not count as taken
    const last = dataBackups(this.db, launchId).find((r) => r.verified);
    const every = schedule === "daily" ? 86_400_000 : 7 * 86_400_000;
    // a failed attempt waits a full interval too, rather than retrying every minute
    const lastAttempt = this.db
      .listFleetOps(launchId)
      .filter((o) => o.kind === "data-backup")
      .map((o) => Date.parse(o.created_at))
      .sort((a, b) => b - a)[0];
    const since = Math.max(last ? Date.parse(last.takenAt) : 0, lastAttempt ?? 0);
    // a node upgrade (or reset) just made every backup unusable: take one
    // now rather than leave the fleet up to a day without
    const broke = lastDataBreak(this.db, launchId);
    if (broke !== undefined && broke > since) return true;
    return now - since >= every;
  }

  /**
   * Add a sentry to a running chain fleet ("add-sentry" op). The spec counts
   * it from here on (an explicit sentry mapping gains an entry fronting the
   * validator round-robin would give it); the op builds its home and places
   * it. `size` records a per-node size for it, as resize does.
   */
  requestAddSentry(launch: LaunchRow, opts: { size?: "small" | "standard" | "large"; manualBid?: boolean } = {}): { opId: number; key: string } {
    const spec = this.spec(launch);
    if (isServicesFleet(spec)) throw new Error("a services fleet runs no chain");
    if (this.db.getStep(launch.id, "finalize")?.status !== "done") {
      throw new Error("the launch has not finished: add a sentry once it has");
    }
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another operation is in progress: add the sentry once it is done");
    }
    this.assertMeshAlive(launch, "a sentry cannot be added");
    const s = spec.topology.sentries.count;
    const key = `sentry-${s}`;
    const stored = JSON.parse(launch.spec_json);
    stored.topology.sentries = { ...stored.topology.sentries, count: s + 1 };
    const mapping = spec.topology.sentries.mapping;
    if (Array.isArray(mapping)) {
      stored.topology.sentries.mapping = [...mapping, [s % spec.topology.validators.count]];
    }
    if (opts.size) {
      stored.infra = { ...stored.infra, nodeSizes: { ...(stored.infra?.nodeSizes ?? {}), [key]: opts.size } };
    }
    const { errors } = validateSpec(withDefaults(stored));
    if (errors.length > 0) throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
    const avoid = this.providerPrefs(launch.owner).avoid;
    const opId = this.db.createFleetOp(launch.id, "add-sentry", {
      key,
      sentriesBefore: JSON.parse(launch.spec_json).topology.sentries,
      ...(avoid.length > 0 ? { avoidProviders: avoid } : {}),
      ...(opts.manualBid ? { manualBid: true } : {}),
    } satisfies AddSentryParams);
    return { opId, key };
  }

  /**
   * Turn on the headscale backup of a running fleet ("mesh-backup" op):
   * S3 settings go into the spec (the secret into the launch's secrets as
   * secret:s3-backup), then the op adds the backup env to the running
   * headscale, uploads its static keys and checks the bucket holds both
   * halves. A blank secret reuses the one another fleet of this launcher
   * already holds for the same access key.
   */
  requestMeshBackup(
    launch: LaunchRow,
    s3: { endpoint: string; bucket: string; region?: string; accessKeyId: string; secret?: string; path?: string },
  ): number {
    const spec = this.spec(launch);
    if (isServicesFleet(spec)) throw new Error("a services fleet runs no mesh");
    if (spec.topology.headscale.reuseFleet) {
      throw new Error("this fleet shares another fleet's mesh: back up that fleet's headscale instead");
    }
    const row = (this.db.listFleetComponents(launch.id) as FleetComponentRow[]).find((c) => c.key === "headscale");
    if (!row || row.state !== "active") throw new Error("this fleet has no running headscale");
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another operation is in progress: turn on the backup once it is done");
    }
    const endpoint = s3.endpoint.trim();
    const bucket = s3.bucket.trim();
    const accessKeyId = s3.accessKeyId.trim();
    if (!/^https:\/\/[^\s/]+/.test(endpoint)) throw new Error("the S3 endpoint must be an https:// URL");
    if (!bucket || !accessKeyId) throw new Error("bucket and access key are required");
    let secret = s3.secret?.trim();
    if (!secret) secret = this.knownS3Secret(launch.owner, accessKeyId, launch.id);
    if (!secret) throw new Error("the S3 secret key is required (no other fleet here holds one for this access key)");
    const dirs = launchDirs(this.workRoot, launch.id);
    keepPreviousS3Secret(dirs.secrets);
    writeSecretFile(path.join(dirs.secrets, S3_SECRET_FILE), secret);
    const stored = JSON.parse(launch.spec_json);
    const backupBefore = stored.topology.headscale?.backup ?? null;
    stored.topology.headscale = {
      ...stored.topology.headscale,
      backup: {
        s3: {
          endpoint,
          bucket,
          region: s3.region?.trim() || "us-west-2",
          accessKeyId,
          secretRef: "secret:s3-backup",
          ...(s3.path?.trim() ? { path: s3.path.trim() } : {}),
        },
      },
    };
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
    const updated = withDefaults(stored);
    const opId = this.db.createFleetOp(launch.id, "mesh-backup", {
      endpoint,
      bucket,
      path: headscaleBackupPath(updated),
      backupBefore,
    } satisfies MeshBackupParams);
    markMeshBackupUnverified(this.db, launch.id, opId);
    return opId;
  }

  /** The S3 secret another fleet of this wallet holds for `accessKeyId`. */
  private knownS3Secret(owner: string, accessKeyId: string, exceptLaunch: string): string | undefined {
    for (const other of this.db.listLaunches()) {
      if (other.id === exceptLaunch || other.owner !== owner) continue;
      const backup = withDefaults(JSON.parse(other.spec_json)).topology.headscale.backup;
      if (backup?.s3.accessKeyId !== accessKeyId) continue;
      const secret = resolveS3Secret(backup, launchDirs(this.workRoot, other.id).secrets);
      if (secret) return secret;
    }
    return undefined;
  }

  /** S3 settings (never the secret) of another fleet of this wallet, to prefill the backup form. */
  knownBackupStorage(owner: string): { endpoint: string; bucket: string; region: string; accessKeyId: string } | null {
    for (const other of this.db.listLaunches()) {
      if (other.owner !== owner) continue;
      const backup = withDefaults(JSON.parse(other.spec_json)).topology.headscale.backup;
      if (backup) {
        const { endpoint, bucket, region, accessKeyId } = backup.s3;
        return { endpoint, bucket, region, accessKeyId };
      }
    }
    return null;
  }

  requestGasPrice(launch: LaunchRow, minGasPrice: string): number {
    const value = minGasPrice.trim();
    const spec = this.spec(launch);
    if (isServicesFleet(spec)) throw new Error("a services fleet runs no chain");
    const problem = minGasPriceProblem(value, spec.token.baseDenom, spec.token.exponent);
    if (problem) throw new Error(`token.minGasPrice: ${problem}`);
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another operation is in progress: set the gas price once it is done");
    }
    const previous = spec.token.minGasPrice;
    const stored = JSON.parse(launch.spec_json);
    stored.token = { ...stored.token, minGasPrice: value };
    this.db.setLaunchSpec(launch.id, JSON.stringify(stored));
    return this.db.createFleetOp(launch.id, "gas-price", { minGasPrice: value, previous } satisfies GasPriceParams);
  }

  /** Re-link an active relayer: reopen whatever a chain reset closed and
   *  restart Hermes on the current channels. */
  requestRelink(launch: LaunchRow): number {
    const row = this.db.listFleetComponents(launch.id).find((c) => c.key === "relayer");
    if (!row || row.state !== "active") throw new Error("this fleet has no active relayer");
    if (this.db.listFleetOps(launch.id, "active").some((o) => o.kind === "relink")) {
      throw new Error("a relink is already in progress");
    }
    return this.db.createFleetOp(launch.id, "relink", {});
  }

  /**
   * Replace a running relayer's paths (add a chain, drop one): the spec
   * takes them, checked as adding the relayer checks them, and a
   * "relayer-paths" op links the relayer to them. A new or dropped fleet
   * counterparty changes the relayer's mesh tunnels, which the op updates
   * in place first (one signature); endpoint counterparties are dialed
   * directly, so changing only those needs none.
   */
  requestRelayerPaths(
    launch: LaunchRow,
    paths: RelayerPath[],
    opts: { maxBalance?: string } = {},
  ): number | undefined {
    const row = this.db.listFleetComponents(launch.id).find((c) => c.key === "relayer");
    if (!row || row.state !== "active") throw new Error("this fleet has no active relayer");
    const busy = this.db.listFleetOps(launch.id, "active").find((o) => {
      if (o.kind === "relink" || o.kind === "relayer-paths") return true;
      try {
        return (JSON.parse(o.params_json) as { key?: string }).key === "relayer";
      } catch {
        return false;
      }
    });
    if (busy) throw new Error(`the relayer is busy with a ${busy.kind} op: finish or abort it first`);
    const current = this.spec(launch);
    const spec = this.spec(launch);
    spec.topology.components.relayer = {
      ...spec.topology.components.relayer!,
      paths,
      ...(opts.maxBalance !== undefined ? { maxBalance: opts.maxBalance } : {}),
    };
    Object.assign(spec, withDefaults(spec as unknown as LaunchSpecInput));
    for (const p of spec.topology.components.relayer!.paths) {
      if ("fleet" in p.counterparty) {
        resolveRelayCounterparty(this.db, spec, launch.owner, p.counterparty, launch.id);
      }
    }
    const { errors } = validateSpec(spec);
    if (errors.length > 0) {
      throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    }
    const retunnel = JSON.stringify(relayerTunnels(current)) !== JSON.stringify(relayerTunnels(spec));
    this.db.setLaunchSpec(launch.id, JSON.stringify(spec));
    // a cap change alone is the launcher's own bookkeeping (funding prompts,
    // the over-cap flag): nothing on the relayer changes, so no relink
    const samePaths =
      JSON.stringify(current.topology.components.relayer?.paths ?? []) ===
      JSON.stringify(spec.topology.components.relayer!.paths);
    if (samePaths) return undefined;
    return this.db.createFleetOp(launch.id, "relayer-paths", { retunnel } satisfies RelayerPathsParams);
  }

  /**
   * Queue a relink when a sister fleet this relayer reaches over its public
   * ports moved its sentry-0 (a relaunch hands out new forwarded ports, and
   * Hermes keeps dialing the old ones). The relink reads the new ports from
   * lease status. Called by the monitor; true when it queued one to drive.
   */
  /**
   * A public-grpc op another wallet's relayer queued on this fleet: it has
   * never run (no request drives it), so the monitor starts it, and it then
   * waits in this fleet's panel for this fleet's wallet to sign. True when
   * there is one to drive.
   */
  undrivenPublicGrpc(launchId: string): boolean {
    const started = new Set(this.db.listSteps(launchId).map((s) => s.name));
    return this.db
      .listFleetOps(launchId, "active")
      .some((o) => o.kind === "public-grpc" && !started.has(`op${o.id}:public-grpc`));
  }

  /**
   * A launch paused on a federation peer's setup on another chain (a
   * PeerSetup pause) whose chain has moved on since: the peer registered,
   * its policy set, or it went active, through a script or the chain's
   * frontend rather than this panel; or an accepted activation reached its
   * execution time. The monitor then resumes it, so finishing elsewhere
   * needs no trip back to click Resume. True when it should be driven.
   */
  async peerSetupReady(launchId: string): Promise<boolean> {
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status !== "paused") return false;
    const step = this.db.listSteps(launchId).find((st) => st.status === "waiting" && st.wallet_json);
    if (!step) return false;
    let setup: PeerSetup | undefined;
    try {
      setup = (JSON.parse(step.wallet_json!) as { peerSetup?: PeerSetup }).peerSetup;
    } catch {
      return false;
    }
    if (!setup) return false;
    if (setup.resumeAt) return Date.now() / 1000 >= setup.resumeAt;
    if (!setup.rest) return false;
    const now = await peerProgress(this.services.rpc, setup.rest, setup.peerId);
    return now !== undefined && now !== setup.progress;
  }

  queueStaleRelayLink(launchId: string): boolean {
    const launch = this.db.getLaunch(launchId);
    if (!launch || launch.status !== "completed") return false;
    const spec = this.spec(launch);
    if (!spec.topology.components.relayer?.enabled) return false;
    const row = this.db.listFleetComponents(launchId).find((c) => c.key === "relayer");
    if (row?.state !== "active") return false;
    if (!publicRelayFleets(spec).some((id) => publicRelayEndpointStale(this.db, id))) return false;
    if (this.db.listFleetOps(launchId, "active").length > 0) return false;
    this.db.createFleetOp(launchId, "relink", {});
    return true;
  }

  /**
   * Add a service component to a running fleet (or bring back a closed one):
   * enable it in the stored spec, re-validate, and start an add-component op
   * that renders, opens the sentries for it and places it. The component is
   * deployed with the image the spec names — the profile default unless
   * `image` overrides it.
   */
  requestAddComponent(
    launch: LaunchRow,
    key: string,
    opts: {
      domain?: string;
      image?: string;
      paths?: RelayerPath[];
      /** The kind's own settings (its spec toggle's fields: mastodon's owner
       *  and bridge, ...), merged over what the stored spec has. */
      settings?: Record<string, unknown>;
      /** The operator picks the bid for the new deployment. */
      manualBid?: boolean;
    } = {},
  ): number {
    if (!isComponentKey(key)) throw new Error(`${key} is not a component kind this launcher can add`);
    // the launch's own steps must be through: a paused fleet op also takes the
    // launch off "completed", so its status cannot answer this
    if (this.db.getStep(launch.id, "finalize")?.status !== "done") {
      throw new Error("the launch has not finished — add components once it has");
    }
    const row = this.db.listFleetComponents(launch.id).find((c) => c.key === key);
    if (row && row.state !== "closed") throw new Error(`${key} is already deployed in this fleet`);
    if (this.db.listFleetOps(launch.id, "active").some((o) => o.kind === "add-component")) {
      throw new Error("a component is already being added — finish or abort that first");
    }
    const kind = COMPONENT_KINDS[key];
    if (kind.mesh) this.assertMeshAlive(launch, `${key} cannot be added`);
    const spec = this.spec(launch);
    const comps = spec.topology.components as Record<string, Record<string, unknown> | undefined>;
    comps[key] = {
      ...comps[key],
      ...(opts.settings ?? {}),
      enabled: true,
      ...(opts.domain ? { domain: opts.domain } : {}),
      ...(opts.paths ? { paths: opts.paths } : {}),
    };
    // a component deployed now runs the current release, not the one the
    // fleet launched with: an image it runs (its own, and its side services'
    // such as Mastodon's sdap) that is an older tag of the profile default's
    // repository moves up to the default
    const images = spec.images as Record<string, string | undefined>;
    const defaults = profiles[spec.network.type]?.images as Record<string, string | undefined> | undefined;
    for (const k of [key, ...Object.values(descriptorFor(key)?.sideImages ?? {})]) {
      const current = images[k];
      const latest = defaults?.[k];
      const tag = latest ? versionTag(latest) : undefined;
      if (!current || !latest || !tag || imageRepo(current) !== imageRepo(latest)) continue;
      if (imageBefore(current, `v${tag.join(".")}`)) images[k] = latest;
    }
    if (opts.image) spec.images[key] = opts.image;
    // parse through the schema again: fills the relayer's defaults and
    // rejects a malformed path before anything is stored
    const parsed = withDefaults(spec as unknown as LaunchSpecInput);
    Object.assign(spec, parsed);
    // a verifier: its target resolved and its account checked
    const verifier = spec.topology.components.verifier;
    if (key === "verifier" && verifier?.enabled) {
      if (verifier.target) {
        verifier.target.fleet = resolveVerifierTarget(this.db, spec, launch.owner, verifier.target.fleet, launch.id);
      } else {
        checkVerifierAccount(spec, spec);
      }
    }
    // a standalone bridge: its Mastodon fleet resolved, and the domain taken
    const bridge = spec.topology.components.bridge;
    if (key === "bridge" && bridge?.enabled) {
      bridge.target = resolveBridgeTarget(this.db, launch.owner, bridge.target.fleet, launch.id);
    }
    // fleet counterparties become launch ids, checked and routed (mesh or public)
    for (const p of spec.topology.components.relayer?.enabled ? spec.topology.components.relayer.paths : []) {
      if ("fleet" in p.counterparty) {
        resolveRelayCounterparty(this.db, spec, launch.owner, p.counterparty, launch.id);
      }
    }
    const { errors } = validateSpec(spec);
    if (errors.length > 0) {
      throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    }
    if (key === "mastodon") this.assertMastodonDomainFree(launch, spec);
    // secrets never live in the stored spec; one named by source fleet is
    // read from that fleet's store first
    resolveSmtpPasswordSource(this.db, this.workRoot, launch.owner, spec);
    stashSmtpPassword(launchDirs(this.workRoot, launch.id).secrets, spec);
    this.db.setLaunchSpec(launch.id, JSON.stringify(spec));
    const avoid = this.providerPrefs(launch.owner).avoid;
    return this.db.createFleetOp(launch.id, "add-component", {
      key,
      generation: row ? row.generation + 1 : 0,
      // the wallet's avoid list holds for a new placement as for a move
      ...(avoid.length > 0 ? { avoidProviders: avoid } : {}),
      ...(opts.manualBid ? { manualBid: true } : {}),
    } satisfies AddComponentParams);
  }

  /**
   * Record the operator's hand-picked bid for a relaunch parked at its lease
   * step (manualBid). The pick overrides the selection policy outright, so
   * the only checks here are that it names a bid actually on offer for the
   * deployment the op is waiting on.
   */
  chooseBid(launch: LaunchRow, opId: number, provider: string): { key: string } {
    const op = this.db.listFleetOps(launch.id).find((o) => o.id === opId);
    if (!op || op.status !== "active") throw new Error(`operation ${opId} is not active`);
    const params = JSON.parse(op.params_json) as RelaunchParams;
    const offers = params.offeredBids;
    if (!offers) throw new Error(`operation ${opId} is not waiting for a bid to be picked`);
    if (provider === AUTO_BID) {
      // only where the op asked on its own: an up-front manual pick is the
      // operator having already declined the policy's choice
      if (!offers.reason) throw new Error(`operation ${opId} asked for a hand-picked bid`);
    } else if (!offers.bids.some((b) => b.provider === provider)) {
      throw new Error(`${provider} did not bid on deployment ${offers.dseq}`);
    }
    this.db.updateFleetOpParams(opId, {
      ...params,
      bidChoice: { dseq: offers.dseq, provider },
    });
    return { key: params.key };
  }

  /** Abort every still-active relaunch op targeting `key` so a fresh request
   *  starts from one op. Mirrors requestAbortOp's cleanup — drop the op's
   *  steps and unsigned txs so they stop driving the component — but leaves
   *  the deployment the component row currently points to alone: the new op's
   *  own close step tears that one down. Any OTHER dseq a superseded op leased
   *  is orphaned, so close it (best-effort) to refund escrow. */
  private async supersedeRelaunchOps(launch: LaunchRow, key: string): Promise<void> {
    const currentDseq = this.db
      .listFleetComponents(launch.id)
      .find((c) => c.key === key)?.dseq;
    const prior = this.db.listFleetOps(launch.id).filter((o) => {
      if (o.status !== "active" || o.kind !== "relaunch") return false;
      try {
        return JSON.parse(o.params_json).key === key;
      } catch {
        return false;
      }
    });
    for (const op of prior) {
      this.db.setFleetOpStatus(op.id, "aborted");
      this.db.deleteOpSteps(launch.id, op.id);
      this.db.deleteUnsignedPendingTxsLike(launch.id, `op${op.id}:%`);
      const deploy = this.db.stepOutput<{ dseq: string }>(launch.id, `op${op.id}:deploy`);
      if (deploy?.dseq && deploy.dseq !== currentDseq) {
        const info = await this.services.api
          .deploymentInfo(launch.owner, deploy.dseq)
          .catch(() => undefined);
        if (info?.state === "active") {
          this.db.enqueuePendingTx(
            launch.id,
            `fleet:close:${deploy.dseq}`,
            JSON.stringify([closeDeploymentMsg(launch.owner, deploy.dseq)]),
          );
        }
      }
    }
  }

  /**
   * Pre-unjail guard (§5 pre-action guards): a validator that is synced and
   * signing can still be re-jailed if its votes travel too slowly — the
   * origin seals each block ~timeout_commit after the last, so a precommit
   * must cross sentry→validator and back inside that window. Seen live on
   * the first devnet join: a DERP-relayed path at ~400ms RTT against 1s
   * blocks meant every precommit arrived late; each unjail burned another
   * 1% slash. Measure the path from the validator's own sentry and warn
   * BEFORE the op exists. Best-effort: probe failures never block the op.
   */
  async unjailWarnings(launch: LaunchRow, component: FleetComponentRow): Promise<string[]> {
    const warnings: string[] = [];
    try {
      const spec = this.spec(launch);
      const v = Number(component.key.split("-")[1]);
      const sIndex = (resolveTopology(spec).validatorSentries[v] ?? [])[0];
      if (sIndex === undefined || !component.tailnet_ip) return warnings;
      const sentry = this.db
        .listFleetComponents(launch.id)
        .find((c) => c.key === `sentry-${sIndex}` && c.state === "active");
      if (!sentry) return warnings;
      // a validator peered over its sentry's PUBLIC endpoint doesn't ride
      // the mesh for votes — the DERP round trip below would be measuring a
      // path consensus no longer uses
      const peers = await this.services.ssh.exec(
        this.sshTargetFor(launch, component),
        "grep '^persistent_peers[[:space:]]*=' /root/.sparkdream/config/config.toml",
        { quick: true },
      );
      if (/@(?!100\.64\.|127\.0\.0\.1)[^:]+:/.test(peers.stdout)) return warnings;
      const res = await this.services.ssh.exec(
        this.sshTargetFor(launch, sentry),
        `tailscale --socket=${NODE_HOME}/tailscale/tailscaled.sock ping -c 3 --timeout 2s ${component.tailnet_ip} 2>&1 || true`,
      );
      const rtts = [...res.stdout.matchAll(/ in ([\d.]+)ms/g)].map((m) => Number(m[1]));
      if (rtts.length === 0) return warnings;
      const rtt = Math.min(...rtts);
      const relay = /via DERP\(([^)]+)\)/.exec(res.stdout)?.[1];
      const timeoutMs =
        1000 * Number((spec.chainParams.consensus?.timeoutCommit ?? "5s").replace(/s$/, ""));
      // ~2×RTT is the practical floor for proposal-in + precommit-out across
      // the sentry link; a relayed path gets a tighter bar because DERP
      // latency spikes far above its ping-time floor
      if (2 * rtt > timeoutMs || (relay !== undefined && 4 * rtt > timeoutMs)) {
        warnings.push(
          `${component.key}'s vote path from its sentry is ${
            relay ? `relayed via DERP(${relay})` : "direct"
          } at ~${Math.round(rtt)}ms RTT. With ${timeoutMs / 1000}s blocks its precommits will ` +
            "likely arrive after each block is sealed, so it would be downtime-jailed (and " +
            `slashed) again shortly after the unjail. Consider relaunching ${component.key} ` +
            "onto a provider closer to its sentry first.",
        );
      }
    } catch {
      // latency probe is best-effort — never block the unjail on it
    }
    return warnings;
  }

  /**
   * Unjail a downtime-jailed validator: sync-gate → MsgUnjail (conductor
   * keyring for generated operators; the wallet signing loop for external
   * ones) → verify it re-enters the bonded set.
   */
  requestUnjail(launch: LaunchRow, component: FleetComponentRow): number {
    if (!component.key.startsWith("val-")) {
      throw new Error(`unjail applies to validators, not ${component.key}`);
    }
    const running = this.db
      .listFleetOps(launch.id)
      .find((o) => o.kind === "unjail" && o.status === "active");
    if (running) throw new Error(`an unjail op (#${running.id}) is already in progress`);
    return this.db.createFleetOp(launch.id, "unjail", { key: component.key });
  }

  /**
   * "The signer is ready — get the validator signing again" (§5, tmkms
   * fleets): gate on the privval session, restart the process in place,
   * prove signing resumes. No tx and no manifest change, so nothing can
   * drift the on-chain hash (the out-of-band manifest bounce this replaces
   * did exactly that, and 422'd every later manifest send).
   */
  requestResumeSigning(launch: LaunchRow, component: FleetComponentRow): number {
    if (!component.key.startsWith("val-")) {
      throw new Error(`resume-signing applies to validators, not ${component.key}`);
    }
    if (this.spec(launch).security.keyMode !== "tmkms") {
      throw new Error(
        `${component.key} signs locally (softsign): use restart; there is no signer session to gate on`,
      );
    }
    const running = this.db
      .listFleetOps(launch.id)
      .find(
        (o) =>
          o.kind === "resume-signing" &&
          o.status === "active" &&
          JSON.parse(o.params_json).key === component.key,
      );
    if (running) {
      throw new Error(`a resume-signing op (#${running.id}) is already in progress for ${component.key}`);
    }
    return this.db.createFleetOp(launch.id, "resume-signing", { key: component.key });
  }

  /**
   * Pre-restore guard (§5 pre-action guards): the replay needs the node's
   * databases to itself, so sparkdreamd is down for the whole run — hours
   * on a large archive. A validator that stops is a validator missing
   * blocks: on a small fleet the chain stops with it, and long enough
   * offline gets it downtime-jailed (recoverable only through unjail).
   */
  restoreArchiveWarnings(launch: LaunchRow, component: FleetComponentRow): string[] {
    const warnings: string[] = [];
    if (!component.key.startsWith("val-")) return warnings;
    const active = this.db
      .listFleetComponents(launch.id)
      .filter((c) => c.key.startsWith("val-") && c.state === "active").length;
    warnings.push(
      `${component.key} stays stopped for the whole replay (hours on a large archive), so it ` +
        `signs nothing while it runs${
          active <= 1 ? " — it is this fleet's only active validator, so the chain stops with it" : ""
        }, and a long enough absence gets it downtime-jailed. Restore a sentry, or a validator you ` +
        "can afford to have offline, when the chain has to keep producing blocks.",
    );
    return warnings;
  }

  /**
   * Rebuild a node's block history from uploaded archive files (§5): stop
   * the node, run `sparkdreamd replay-from-archive` detached (its output
   * stays in a file on the node — the volume is what kills log viewers),
   * watch it to completion, start the node back up.
   */
  requestRestoreArchive(
    launch: LaunchRow,
    component: FleetComponentRow,
    opts: { archiveDir?: string; validate?: boolean; endHeight?: number } = {},
  ): number {
    if (!/^(val|sentry)-/.test(component.key)) {
      throw new Error(`restore applies to chain nodes, not ${component.key}`);
    }
    const running = this.db
      .listFleetOps(launch.id)
      .find(
        (o) =>
          o.kind === "restore-archive" &&
          o.status === "active" &&
          JSON.parse(o.params_json).key === component.key,
      );
    if (running) {
      throw new Error(`a restore op (#${running.id}) is already in progress for ${component.key}`);
    }
    return this.db.createFleetOp(launch.id, "restore-archive", { key: component.key, ...opts });
  }

  /**
   * Pre-repair guard (§5 pre-action guards). The operator agrees to the whole
   * op, not to one of its passes, so this states the worst any pass can cost
   * — today a restart of the components being corrected, and one signature.
   * A pass added later that can cost more has to be named here too (see
   * {@link repairSteps}); one that cannot be stated this plainly should
   * report the problem instead of acting on it.
   */
  repairWarnings(launch: LaunchRow): string[] {
    return [
      "The launcher's own records are corrected first: where each component answers SSH (re-read " +
        "from its provider), its live mesh address, and the version each chain node reports " +
        "running (both asked of the component itself), so work " +
        "done outside the launcher does not leave it out of step. Components whose links are " +
        "stale are then restarted in place so the " +
        "correction takes effect: a sentry's public RPC and LCD blink, and a validator restarted " +
        "this way misses the few blocks it is down for. Components already pointing at the right " +
        "address are left alone. Nothing is redeployed, no volume is touched, no escrow is spent.",
      "A chain node that has stopped following the chain — one sitting well below the fleet's " +
        "height while still reporting itself caught up, which is how a node whose consensus " +
        "state machine has died looks from outside — is restarted in the same way, since that " +
        "is the only thing that revives it. It block-syncs back up from where it stopped. Nodes " +
        "that are keeping up, and a fleet whose nodes have all halted together, are left alone.",
    ];
  }

  /**
   * Reconcile the fleet against reality and fix what has drifted (§5), in
   * place: re-read SSH endpoints from the providers and live mesh addresses
   * from the components into the launcher's own record, then
   * correct stale tunnel env (deployment update + manifest push) and stale
   * `persistent_peers` (SSH edit + restart). The cure for an address that
   * moved outside a relaunch — a headscale re-key, an aborted op, a relaunch
   * whose dependents were not placed at the time, a container bounced by hand
   * in another console — where the only alternative was relaunching the
   * dependents onto new providers. Later repairs join this op as passes.
   */
  requestRepair(launch: LaunchRow, component: FleetComponentRow): number {
    const running = this.db
      .listFleetOps(launch.id)
      .find((o) => o.kind === "repair" && o.status === "active");
    if (running) {
      throw new Error(`a repair op (#${running.id}) is already in progress for this fleet`);
    }
    return this.db.createFleetOp(launch.id, "repair", { key: component.key });
  }

  /**
   * Force the provider to re-create one component's container (§5). For the
   * case a repair cannot reach: the deployment already carries the right
   * manifest, so every convergent pass correctly does nothing, while the
   * running container still serves env from before the update landed.
   */
  requestForceRedeploy(launch: LaunchRow, component: FleetComponentRow, opts: { auto?: boolean } = {}): number {
    const running = this.db
      .listFleetOps(launch.id)
      .find(
        (o) =>
          o.kind === "force-redeploy" &&
          o.status === "active" &&
          (JSON.parse(o.params_json) as { key?: string }).key === component.key,
      );
    if (running) {
      throw new Error(`a redeploy op (#${running.id}) is already in progress for ${component.key}`);
    }
    return this.db.createFleetOp(launch.id, "force-redeploy", { key: component.key, ...(opts.auto ? { auto: true } : {}) });
  }

  /**
   * Abandon an in-progress op (e.g. a relaunch stuck on a broken provider).
   * Its steps stop running (aborted ops contribute none to buildOpSteps),
   * and its new deployment — if leased — is closed through the signing loop
   * so escrow is refunded. The component stays 'closed', ready to relaunch.
   */
  async requestAbortOp(
    launch: LaunchRow,
    opId: number,
  ): Promise<{ step?: string; warning?: string }> {
    const op = this.db.listFleetOps(launch.id).find((o) => o.id === opId);
    if (!op) throw new Error(`op ${opId} not found`);
    if (op.status === "done") throw new Error(`op ${opId} already completed — nothing to abort`);
    if (op.kind === "node-resize") {
      const busy = HANDOVER_STEPS.find((s) => this.db.getStep(launch.id, `op${opId}:${s}`)?.status === "running");
      if (busy) {
        throw new Error(
          "the resize is handing the node over to the new deployment right now; aborting mid-way could " +
            "leave both nodes or neither signing. Wait a minute for that step to finish or fail, then abort",
        );
      }
    }
    // a SIGNED tx is already broadcast — aborting the op cannot recall it
    // (learned live: an op's close was signed moments before the abort, and
    // the abort's cleanup hid the row while the close landed on-chain)
    const signed = this.db.listSignedPendingTxsLike(launch.id, `op${opId}:%`);
    let warning =
      signed.length > 0
        ? `already-signed transaction(s) for ${signed.map((s) => s.step).join(", ")} were ` +
          "broadcast before the abort and may still take effect on-chain"
        : undefined;
    this.db.setFleetOpStatus(opId, "aborted");
    // an abandoned add leaves its row mid-placement; close it so the
    // component can be added again (requestAddComponent takes closed rows)
    if (op.kind === "add-component") {
      const key = (JSON.parse(op.params_json) as AddComponentParams).key;
      const row = this.db.listFleetComponents(launch.id).find((c) => c.key === key);
      if (row && row.state !== "active") this.db.setComponentState(launch.id, key, "closed");
    }
    if (op.kind === "mesh-backup") {
      const note = undoMeshBackup(
        this.db,
        launchDirs(this.workRoot, launch.id).secrets,
        launch.id,
        opId,
        JSON.parse(op.params_json) as MeshBackupParams,
      );
      if (note) warning = warning ? `${warning}; ${note}` : note;
    }
    // an abandoned add-sentry must not leave the spec counting a sentry
    // that never ran (reads the op's home step, so before the steps go)
    if (op.kind === "add-sentry") {
      const note = await undoAddSentry(
        this.db,
        launchDirs(this.workRoot, launch.id),
        launch.id,
        opId,
        JSON.parse(op.params_json) as AddSentryParams,
      );
      if (note) warning = warning ? `${warning}; ${note}` : note;
    }
    // read the op's deployment BEFORE deleting its steps, then erase the
    // step rows so the abandoned op stops surfacing as the launch's error
    const deploy = this.db.stepOutput<{ dseq: string }>(launch.id, `op${opId}:deploy`);
    this.db.deleteOpSteps(launch.id, opId);
    // and its unsigned txs: the signing queue serves oldest-first, so an
    // abandoned op's dead lease request would shadow the close below forever
    this.db.deleteUnsignedPendingTxsLike(launch.id, `op${opId}:%`);
    let closeDseq = deploy?.dseq;
    if (op.kind === "node-resize") {
      this.db.setFleetOpProgress(opId, null);
      const key = (JSON.parse(op.params_json) as NodeResizeParams).key;
      const row = this.db.listFleetComponents(launch.id).find((c) => c.key === key);
      if (row && deploy?.dseq && row.dseq === deploy.dseq) {
        // past the cutover the new deployment IS the node: keep it, and
        // close the retired old one instead
        const pin = path.join(launchDirs(this.workRoot, launch.id).root, `op${opId}-resize-old.pin`);
        closeDseq = fs.existsSync(pin) ? (JSON.parse(fs.readFileSync(pin, "utf8")) as { dseq: string }).dseq : undefined;
        if (row.state === "relaunching") this.db.setComponentState(launch.id, key, "active");
        const note =
          `the cutover had already happened, so the new deployment stays as ${key}; if the op stopped ` +
          "before the node was started and wired, run restart and repair on it";
        warning = warning ? `${warning}; ${note}` : note;
      } else if (row) {
        // before it, the old node may have been retired by a cutover that
        // could not finish: put it back on its own identity
        try {
          const target = this.sshTargetFor(launch, row);
          const out = await this.services.ssh.exec(target, UNRETIRE_CMD);
          if (out.stdout.includes("restored")) await restartNode(this.services.ssh, target);
        } catch (e) {
          const note =
            `${key} could not be reached to check whether the resize left it retired ` +
            `(${e instanceof Error ? e.message : String(e)}): restart it and check that it signs`;
          warning = warning ? `${warning}; ${note}` : note;
        }
      }
    }
    if (closeDseq) {
      const info = await this.services.api
        .deploymentInfo(launch.owner, closeDseq)
        .catch(() => undefined);
      if (info?.state === "active") {
        const step = `fleet:close:${closeDseq}`;
        this.db.enqueuePendingTx(
          launch.id,
          step,
          JSON.stringify([closeDeploymentMsg(launch.owner, closeDseq)]),
        );
        return { step, ...(warning ? { warning } : {}) };
      }
    }
    return warning ? { warning } : {};
  }

  /** Add/remove a provider on a wallet's global avoid/prefer list (§6). */
  setProviderPref(
    owner: string,
    provider: string,
    kind: "avoid" | "prefer" | "none",
    name?: string | null,
  ): void {
    this.db.setProviderPref(owner, provider, kind, name);
  }

  providerPrefs(owner: string): {
    avoid: string[];
    prefer: string[];
    names: Record<string, string>;
  } {
    return this.db.providerPrefs(owner);
  }

  requestUpgrade(launch: LaunchRow, components: string[], image: string): number {
    const before = this.imagesBefore(launch, (key) => components.includes(key));
    this.recordSpecImage(launch, components, image);
    const params: UpgradeParams = { components, image, ...before };
    return this.db.createFleetOp(launch.id, "upgrade", params);
  }

  /** What the components run now, captured before an upgrade changes
   *  anything: the op rolls nodes back to it when the new release cannot
   *  run there. */
  private imagesBefore(
    launch: LaunchRow,
    include: (key: string) => boolean,
  ): { previous: Record<string, string>; previousSpecImages: Record<string, string> } {
    const previous: Record<string, string> = {};
    for (const c of this.db.listFleetComponents(launch.id)) {
      if (c.state === "active" && include(c.key) && c.image) previous[c.key] = c.image;
    }
    const previousSpecImages = Object.fromEntries(
      Object.entries(this.spec(launch).images as Record<string, string | undefined>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
    return { previous, previousSpecImages };
  }

  /**
   * Keep the stored spec's images truthful when an upgrade op swaps them —
   * relaunches redeploy from the spec, and requestChainReset freezes
   * component images against it (a stale value would reject a reset whose
   * editor merely resolves the current profile default).
   */
  private recordSpecImage(launch: LaunchRow, components: string[], image: string): void {
    const spec = this.spec(launch);
    const images = spec.images as Record<string, string | undefined>;
    for (const key of components) {
      if (/^(val|sentry)-/.test(key)) spec.images.sparkdreamd = image;
      else if (isComponentKey(key)) {
        // an image one of the deployment's side services runs (Mastodon's
        // bridge: sdap) is recorded under that service's key, not the main
        const side = Object.values(descriptorFor(key)?.sideImages ?? {}).find(
          (k) => images[k] && imageRepo(images[k]!) === imageRepo(image),
        );
        images[side ?? key] = image;
      }
    }
    this.db.setLaunchSpec(launch.id, JSON.stringify(spec));
  }

  /**
   * Change component domains / public endpoints after launch: update the
   * stored spec (health checks + relaunches follow it), then a retarget op
   * re-renders the affected SDLs and pushes MsgUpdateDeployment + manifests.
   */
  requestDomainUpdate(
    launch: LaunchRow,
    changes: {
      explorer?: string;
      frontend?: string;
      api?: string;
      rpc?: string;
      /** ping-pub route path under the explorer domain (EXPLORER_URL env). */
      explorerRoute?: string;
    },
  ): number {
    const spec = this.spec(launch);
    if (this.db.listFleetOps(launch.id, "active").some((o) => o.kind === "retarget")) {
      throw new Error("a domain update is already in progress — finish or abort it first");
    }
    const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
    const { explorerRoute, ...domains } = changes;
    for (const [field, value] of Object.entries(domains)) {
      if (value !== undefined && !hostname.test(value)) {
        throw new Error(`${field}: "${value}" is not a valid domain name`);
      }
    }
    const comps = spec.topology.components;
    const affected = new Set<string>();
    if (changes.explorer) {
      if (!comps.explorer.enabled) throw new Error("explorer is not enabled in this launch");
      comps.explorer.domain = changes.explorer;
      affected.add("explorer");
      if (comps.frontend.enabled) affected.add("frontend"); // EXPLORER_URL env
    }
    if (explorerRoute) {
      if (!/^[a-z0-9-]+$/i.test(explorerRoute)) {
        throw new Error(`explorerRoute: "${explorerRoute}" is not a valid path segment`);
      }
      if (!comps.explorer.enabled) throw new Error("explorer is not enabled in this launch");
      comps.explorer.route = explorerRoute;
      // only the frontend's EXPLORER_URL env carries the route — the
      // explorer itself serves whatever its baked config names
      if (comps.frontend.enabled) affected.add("frontend");
    }
    if (changes.frontend) {
      if (!comps.frontend.enabled) throw new Error("frontend is not enabled in this launch");
      comps.frontend.domain = changes.frontend;
      affected.add("frontend");
    }
    if (changes.api || changes.rpc) {
      const pub = spec.topology.publicEndpoints;
      if (changes.api && !pub?.api) {
        // the 1317 expose only exists when api was set at launch; adding one
        // now would add a group endpoint, which MsgUpdateDeployment can't do
        throw new Error(
          "the public api endpoint was not part of this launch — sentry-0 has no LCD ingress to retarget; relaunch sentry-0 (or launch anew) to add one",
        );
      }
      spec.topology.publicEndpoints = {
        ...(pub ?? {}),
        ...(changes.api ? { api: changes.api } : {}),
        ...(changes.rpc ? { rpc: changes.rpc } : {}),
      } as typeof pub;
      affected.add("sentry-0");
      if (comps.frontend.enabled) affected.add("frontend"); // LCD/RPC_ENDPOINT env
    }
    if (affected.size === 0) throw new Error("no domain changes given");
    const components = this.db.listFleetComponents(launch.id);
    for (const key of affected) {
      const row = components.find((c) => c.key === key);
      if (!row || row.state === "closed") {
        throw new Error(`${key} is not active — cannot retarget its deployment`);
      }
    }
    this.db.setLaunchSpec(launch.id, JSON.stringify(spec));
    return this.db.createFleetOp(launch.id, "retarget", {
      components: [...affected].sort(),
    } satisfies RetargetParams);
  }

  /** Consensus-breaking release: coordinated halt at H, swap all, resume (M7). */
  requestHaltUpgrade(launch: LaunchRow, image: string, haltHeight: number): number {
    if (isServicesFleet(this.spec(launch))) throw new Error("a services fleet runs no chain to upgrade");
    const before = this.imagesBefore(launch, (key) => /^(val|sentry)-/.test(key));
    this.recordSpecImage(launch, ["val-0"], image); // halt-upgrade swaps every node
    const params: HaltUpgradeParams = { image, haltHeight, ...before };
    return this.db.createFleetOp(launch.id, "halt-upgrade", params);
  }

  /**
   * Wipe the chain and restart from a rebuilt genesis on the same
   * deployments (state-breaking upgrades). The proposed spec replaces the
   * stored one; genesis-shaping fields (accounts + members, chainParams,
   * token) are free to change and the keyring is rebuilt around them, but
   * anything the deployed fleet embodies — topology, domains, resources —
   * must stay as launched, the chain-id included: a reset restarts the
   * same chain rather than standing up a new one beside it. That makes the
   * signer watermark the thing that has to move, so the op stops for the
   * operator to clear it before any node comes back up.
   */
  requestChainReset(launch: LaunchRow, proposedInput: unknown): number {
    if (isServicesFleet(this.spec(launch))) throw new Error("a services fleet runs no chain to reset");
    const current = this.spec(launch);
    const proposed = withDefaults(proposedInput);
    if (current.join || proposed.join) {
      throw new Error(
        "chain reset is not available for join-mode fleets: the chain belongs to the " +
          "network, not this fleet (to leave it, unbond, then shut down the fleet)",
      );
    }
    // an editor spec that omits an image resolves the profile default,
    // which lags behind what upgrade ops installed (the stored spec tracks
    // those via recordSpecImage) — omission is not a request to change the
    // fleet, so inherit the deployed value; only an image the editor spells
    // out counts as intent (still subject to the frozen-field check below)
    const rawImages =
      ((proposedInput ?? {}) as { images?: Record<string, string | undefined> }).images ?? {};
    const images = proposed.images as Record<string, string | undefined>;
    for (const key of ["sparkdreamd", "headscale", ...COMPONENT_KEYS]) {
      if (rawImages[key] === undefined) {
        const cur = (current.images as Record<string, string | undefined>)[key];
        if (cur === undefined) delete images[key];
        else images[key] = cur;
      }
    }
    if (this.db.listFleetOps(launch.id, "active").length > 0) {
      throw new Error("another fleet op is in progress — finish or abort it first");
    }
    // the launch's validate-spec step is checkpointed and won't re-run for
    // an op — re-validate here so chain-identity violations (denom shapes)
    // are rejected before the spec is stored or any node is touched
    const check = validateSpec(proposed);
    if (!check.ok) {
      throw new Error(
        "spec invalid: " + check.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      );
    }
    // one list, shared with the web UI's reset flow, which projects these
    // same fields off the deployed spec so the editor can never contradict
    // the running fleet; report every violation at once, since fixing them
    // one 409 at a time is the slowest way to learn what a reset can move
    const violations = frozenResetViolations(current, proposed);
    if (violations.length > 0) {
      throw new Error(
        `cannot change in a chain reset: ${violations.join(", ")} (the deployed fleet embodies ` +
          (violations.length === 1 ? "it" : "them") +
          "; use the domain-update or upgrade ops, or shut down and launch anew)",
      );
    }
    const image =
      proposed.images.sparkdreamd !== current.images.sparkdreamd
        ? proposed.images.sparkdreamd
        : undefined;
    this.db.setLaunchSpec(launch.id, JSON.stringify(proposed));
    const opId = this.db.createFleetOp(launch.id, "reset-chain", {
      ...(image ? { image } : {}),
    } satisfies ResetChainParams);
    // a reset wipes every IBC client, connection and channel (and re-keys
    // the relayer's genesis account): relink once the chain is back. Ops run
    // in creation order, so this one starts when the reset is done.
    const relayer = this.db.listFleetComponents(launch.id).find((c) => c.key === "relayer");
    if (relayer?.state === "active" && proposed.topology.components.relayer?.enabled) {
      this.db.createFleetOp(launch.id, "relink", {});
    }
    // the reset wipes what components set up on the chain (Mastodon's peer
    // and its bridge's bond, this fleet's verifier's bond): redo it on the
    // deployments as they are, before the session grants below
    const staying = new Set(
      this.db.listFleetComponents(launch.id).filter((c) => c.state === "active").map((c) => c.key),
    );
    const comps = proposed.topology.components;
    const reconfigure = [
      ...(staying.has("mastodon") && comps.mastodon?.enabled && comps.mastodon.bridge?.enabled ? ["mastodon"] : []),
      ...(staying.has("bridge") && comps.bridge?.enabled ? ["bridge"] : []),
      ...(staying.has("verifier") && comps.verifier?.enabled && !comps.verifier.target ? ["verifier"] : []),
    ];
    if (reconfigure.length > 0) {
      this.db.createFleetOp(launch.id, "reconfigure", { keys: reconfigure } satisfies ReconfigureParams);
    }
    // the reset takes the daemons' session grants with it: grant new ones
    // (a verifier watching this chain from another fleet finds out at the
    // monitor's hourly grant check)
    if (sessionRoles(proposed).length > 0) this.db.createFleetOp(launch.id, "sessions", { force: [] });
    return opId;
  }

  /** Recent provider logs for a component (M5 logs viewer, REST poll). */
  async logs(launch: LaunchRow, component: FleetComponentRow, tail = 100): Promise<string> {
    const dirs = launchDirs(this.workRoot, launch.id);
    const cert = {
      certPem: fs.readFileSync(path.join(dirs.secrets, "akash-cert.pem"), "utf8"),
      keyPem: readSecretFile(path.join(dirs.secrets, "akash-cert-key.pem")),
    };
    return this.services.provider.leaseLogs(cert, component.host_uri, component.dseq, 1, 1, tail);
  }

  /**
   * Join bundle (§5 "Public peering & the join bundle"): the public
   * document a third-party operator pastes into their own launcher's spec
   * `join` block. Computed live from lease status so the peer strings can
   * never carry stale forwarded ports; everything in it is public
   * information. Sentries whose provider forwards no P2P port (or whose
   * lease is unreachable) are skipped rather than failing the export.
   */
  async joinBundle(launch: LaunchRow): Promise<Record<string, unknown>> {
    const spec = this.spec(launch);
    const built = this.db.stepOutput<{ chainId: string }>(launch.id, "build-genesis");
    const keys = this.db.stepOutput<{ nodeIds: Record<string, string> }>(launch.id, "generate-keys");
    if (!built || !keys) throw new Error("chain not built yet: no genesis to join");
    const genesisPath = path.join(
      launchDirs(this.workRoot, launch.id).node("val-0"), "config", "genesis.json",
    );
    if (!fs.existsSync(genesisPath)) throw new Error("genesis file missing from the launch workdir");
    // the on-disk genesis is the authority for both hash and chain id: a
    // chain reset rewrites this file under an op-scoped step, so the
    // original build-genesis output can be stale (same id, new hash)
    const genesisDoc = JSON.parse(fs.readFileSync(genesisPath, "utf8")) as { chain_id?: unknown };
    const genesisSha256 = canonicalGenesisSha256(genesisDoc);
    const bundleChainId =
      typeof genesisDoc.chain_id === "string" ? genesisDoc.chain_id : built.chainId;

    this.materialize(launch.id);
    const sentries = this.db
      .listFleetComponents(launch.id)
      .filter((c) => c.key.startsWith("sentry-") && c.state !== "closed");
    const creds = this.mtlsCreds(launch);
    // the queries are independent and a dead provider costs its full request
    // timeout, so fetch every lease status concurrently
    const leases = await Promise.allSettled(
      sentries.map((c) => this.services.provider.leaseStatus(creds, c.host_uri, c.dseq, 1, 1)),
    );
    const peers: string[] = [];
    const forwardedRpcs: Array<{ sentry: string; url: string }> = [];
    sentries.forEach((c, i) => {
      const settled = leases[i]!;
      if (settled.status !== "fulfilled") return; // provider unreachable: skip this sentry entirely
      const lease = settled.value;
      // P2P and RPC extraction are independent: a provider that forwards
      // only one of the two still contributes that one to the bundle
      try {
        const p2p = extractForwardedPort(lease, 26656);
        const nodeId = keys.nodeIds[c.key];
        if (nodeId) peers.push(`${nodeId}@${p2p.host}:${p2p.port}`);
      } catch {
        // no forwarded P2P port on this sentry
      }
      try {
        const rpc = extractForwardedPort(lease, 26657);
        forwardedRpcs.push({ sentry: c.key, url: `http://${rpc.host}:${rpc.port}` });
      } catch {
        // no forwarded RPC port on this sentry
      }
    });
    if (peers.length === 0) {
      throw new Error(
        "no sentry advertises a public P2P port, so the fleet is not joinable " +
          "(providers must forward 26656; redeploy or relaunch the sentries)",
      );
    }
    // Track which sentry backs each RPC: the joiner cross-checks the trust
    // hash across two endpoints, which is meaningless when both terminate
    // at the same node (publicEndpoints.rpc is served by sentry-0's
    // ingress). Exporting a bundle whose "two" RPCs share one sentry would
    // silently void that check on the other side.
    const publicRpc = spec.topology.publicEndpoints?.rpc;
    const rpcSources = [
      ...(publicRpc ? [{ sentry: "sentry-0", url: `https://${publicRpc}` }] : []),
      ...forwardedRpcs,
    ].slice(0, 4);
    // the joiner's schema and CometBFT's own rpc_servers config both
    // hard-require two RPC URLs, so exporting fewer produces a bundle that
    // fails on the other side with no hint the origin is at fault
    if (rpcSources.length < 2) {
      throw new Error(
        "the join bundle needs at least two state-sync RPC endpoints and this fleet " +
          `exposes ${rpcSources.length}: add a second sentry or set topology.publicEndpoints.rpc`,
      );
    }
    // Distinct backing sentries make the cross-check meaningful against a
    // single compromised node or stale forwarded port. On mainnet that is
    // required; elsewhere a single-sentry fleet exports with a notice (the
    // origin operator is the trust root either way, and joiners can add
    // independent RPCs to join.stateSyncRpcs themselves).
    const distinctSentries = new Set(rpcSources.map((r) => r.sentry));
    const selfReferential = distinctSentries.size < 2;
    if (selfReferential && spec.network.type === "mainnet") {
      throw new Error(
        "a mainnet join bundle needs state-sync RPCs backed by at least two distinct " +
          "sentries (the joiner cross-checks the trust hash across them; endpoints of one " +
          "sentry verify a single node against itself): add a second sentry whose provider " +
          "forwards 26657",
      );
    }
    const stateSyncRpcs = rpcSources.map((r) => r.url);
    const genesisUrl = stateSyncRpcs[0] ? `${stateSyncRpcs[0]}/genesis` : undefined;

    return {
      version: 1,
      chainId: bundleChainId,
      bech32Prefix: spec.network.bech32Prefix,
      token: {
        baseDenom: spec.token.baseDenom,
        displayDenom: spec.token.displayDenom,
        exponent: spec.token.exponent,
        minGasPrice: spec.token.minGasPrice,
        ...(spec.token.bondDenom ? { bondDenom: spec.token.bondDenom } : {}),
        ...(spec.token.dreamDenom ? { dreamDenom: spec.token.dreamDenom } : {}),
        dreamDisplayDenom: spec.token.dreamDisplayDenom,
      },
      image: spec.images.sparkdreamd,
      // /genesis may exceed CometBFT's response cap on grown chains; the
      // origin's "download genesis" file, hosted anywhere, also works
      genesisUrl,
      genesisSha256,
      peers,
      stateSyncRpcs,
      ...(selfReferential
        ? {
            notice:
              "both state-sync RPCs terminate at this fleet's only sentry, so the " +
              "joiner's trust-hash cross-check verifies one node against itself; add a " +
              "second sentry (or have joiners put an independent RPC in join.stateSyncRpcs)",
          }
        : {}),
    };
  }

  /**
   * Fleet bundle export (§5 "Fleet bundle"): spec + secrets + node homes +
   * component records, tar'd and age-encrypted to the launch's recipient.
   * Since v2 the bundle carries the node homes (node_key.json,
   * priv_validator_key.json, the val-0 keyring) so an imported launch can
   * relaunch nodes and serve tmkms setup on the new instance; in tmkms mode
   * that means consensus keys DO enter the bundle now, protected by the
   * owner's age recipient like the mnemonics already were.
   */
  async exportBundle(launch: LaunchRow): Promise<string> {
    const dirs = launchDirs(this.workRoot, launch.id);
    const keys = this.db.stepOutput<{ ageRecipient: string }>(launch.id, "generate-keys");
    if (!keys) throw new Error("launch has no generate-keys output");
    const stage = path.join(dirs.root, "bundle-stage");
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(
      path.join(stage, "metadata.json"),
      JSON.stringify(
        {
          version: 2,
          launchId: launch.id,
          owner: launch.owner,
          spec: JSON.parse(launch.spec_json),
          components: this.db.listFleetComponents(launch.id),
          steps: this.db.listSteps(launch.id).map((s) => ({
            name: s.name,
            status: s.status,
            output_json: s.output_json,
          })),
        },
        null,
        2,
      ),
    );
    // bundle carries plaintext inside its age encryption — portable across
    // instances with different LAUNCHER_SECRETs
    copySecretsDecrypted(dirs.secrets, path.join(stage, "secrets"));
    const nodes = path.join(dirs.root, "nodes");
    if (fs.existsSync(nodes)) {
      fs.cpSync(nodes, path.join(stage, "nodes"), { recursive: true });
    }
    const out = path.join(dirs.root, "fleet-bundle.tar.age");
    await this.services.encryptBackup(stage, keys.ageRecipient, out);
    fs.rmSync(stage, { recursive: true, force: true });
    return out;
  }

  /**
   * Import a (user-decrypted, `age -d`) fleet bundle: this instance takes
   * over management (§5 "Fleet bundle") — launch row, step outputs,
   * components, and secrets are restored; the reconciler and monitor
   * re-attach to the on-chain deployments.
   */
  importBundle(extractedDir: string): { launchId: string } {
    const meta = JSON.parse(fs.readFileSync(path.join(extractedDir, "metadata.json"), "utf8"));
    const launchId: string = meta.launchId;
    if (this.db.getLaunch(launchId)) throw new Error(`launch ${launchId} already exists here`);
    // files first, DB rows last: a launch row must never exist without its
    // secrets (a v1 bundle has no nodes/ dir — the guard keeps it importable)
    const dirs = launchDirs(this.workRoot, launchId);
    fs.mkdirSync(dirs.root, { recursive: true });
    copySecretsEncrypted(path.join(extractedDir, "secrets"), dirs.secrets);
    fs.chmodSync(dirs.secrets, 0o700);
    const nodes = path.join(extractedDir, "nodes");
    if (fs.existsSync(nodes)) {
      fs.cpSync(nodes, path.join(dirs.root, "nodes"), { recursive: true });
    }
    this.db.createLaunch(launchId, JSON.stringify(meta.spec), meta.owner);
    this.db.setLaunchStatus(launchId, "completed");
    for (const step of meta.steps as Array<{ name: string; status: string; output_json: string | null }>) {
      if (step.status !== "done") continue;
      this.db.stepStarted(launchId, step.name);
      this.db.stepDone(launchId, step.name, step.output_json ? JSON.parse(step.output_json) : undefined);
    }
    for (const c of meta.components as Array<Record<string, unknown>>) {
      this.db.upsertFleetComponent({ ...(c as any), launch_id: launchId });
      if (c.state === "closed") this.db.setComponentState(launchId, c.key as string, "closed");
    }
    return { launchId };
  }
}
