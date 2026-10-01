import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { fromBech32 } from "@cosmjs/encoding";
import {
  chainId,
  COMPONENT_KEYS,
  COMPONENT_KINDS,
  frozenResetViolations,
  isComponentKey,
  isServicesFleet,
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
  type RelayerPath,
} from "@sparkdream/launch-spec";
import { descriptorFor } from "./components/index.js";
import { RELAYER_ACCOUNT, relayerTunnels, resolveRelayFleet } from "./relayer.js";
import {
  cosmjsWithdraw,
  lowFundsDetail,
  ownerAddressOn,
  relayerFunds,
  withdrawRelayerFunds,
  type RelayerFunds,
  type WithdrawDeps,
} from "./relayer-funds.js";

/** How often the monitor reads the relayer's balances. */
const RELAYER_FUNDS_EVERY_MS = 15 * 60_000;
import { checkVerifierAccount, resolveVerifierTarget } from "./verifier.js";
import { bridgeDependents, mayUseFleet, resolveBridgeTarget } from "./bridge-target.js";
import { resolveSmtpPasswordSource } from "./services-spec.js";
import { servicesSteps } from "./services-steps.js";
import { readMastodonSecrets, stashSmtpPassword } from "./components/mastodon-secrets.js";

/** The accounts-panel entry for the Mastodon instance's Owner. */
const MASTODON_OWNER = "mastodon-owner";
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
import type { ConductorDb, FleetComponentRow, FleetOpProgress, LaunchRow } from "./db.js";
import { launchDirs } from "./engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import { accountDepositMsg, closeDeploymentMsg } from "./akash/messages.js";
import type { OfferedBid } from "./akash/policy.js";
import { bpsAmount, feeCoin, feeConfig } from "./fee.js";
import { NODE_HOME, restartNode, rpcUrl, stalled } from "./node-ops.js";
import { sparkdreamd } from "./exec.js";
import { resolveChainAssets, runWithAssets } from "./chain-assets/index.js";
import { valoperAddress } from "./gentx.js";
import { PRICING_DENOM } from "./render-sdl.js";
import type { Services } from "./services.js";
import { copySecretsDecrypted, copySecretsEncrypted, readSecretFile } from "./secrets.js";
import { toSsh2CompatiblePrivateKey } from "./keys.js";
import { extractForwardedPort, templateHeadscaleSdl, type Assignments, type DeploymentPlan, type HeadscaleOutput, type SshEndpoints } from "./steps/phase-bcd.js";
import { phaseEFSteps } from "./steps/phase-ef.js";
import { canonicalGenesisSha256 } from "./steps/join.js";
import { dependentFleets } from "./headscale-reuse.js";
import { imageRepo } from "./fleet-ops.js";
import type { AddComponentParams, MastodonResizeParams, ReconfigureParams, RelaunchParams, RelayerPathsParams, ResetChainParams, RetargetParams, UpgradeParams, HaltUpgradeParams } from "./fleet-ops.js";

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

/** CometBFT consensus address (uppercase hex) of a base64 ed25519 pubkey. */
export function consensusAddress(pubkeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(pubkeyBase64, "base64")).digest("hex").slice(0, 40).toUpperCase();
}

/** The Mastodon settings a running instance can change (settings action). */
export interface MastodonSettings {
  registrations?: "open" | "approved" | "none";
  walletLogin?: Record<string, unknown>;
}

export class FleetService {
  /** Last hourly on-chain look at each fleet's session grants. */
  private readonly sessionChecks = new Map<string, number>();
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
            health: h
              ? { status: h.status, detail: h.detail, checked_at: h.checked_at }
              : undefined,
          };
        }),
      );
      fleets.push({
        launchId: launch.id,
        launchStatus: launch.status,
        name: spec.network.name,
        kind: spec.kind ?? "chain",
        // join-aware: a joined fleet runs the LIVE chain, not name-suffix
        chainId: chainId(spec),
        keyMode: spec.security.keyMode,
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
    if (!launch || launch.status !== "completed") return;
    this.materialize(launchId);
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
              this.db.setComponentHealth(launchId, c.key, "unreachable", details.join("; "));
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
        spec.topology.headscale.backup
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
            ? ", and you will be prompted to repoint your tmkms signer to the new node."
            : ", and the launcher waits a safety window before it signs again, so there is no double-sign risk."),
      );
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
    return out;
  }

  mnemonic(launch: LaunchRow, name: string): string {
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
        templateHeadscaleSdl(spec, { ageRecipient: keys?.ageRecipient, ageIdentity }),
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
   *  container, which re-reads its env (tunnels included) at boot. */
  async restart(launch: LaunchRow, component: FleetComponentRow): Promise<void> {
    if (component.key === "headscale" || descriptorFor(component.key)) {
      await this.services.provider
        .shellExec(
          this.mtlsCreds(launch), component.host_uri, component.dseq, 1, 1, leaseServiceName(component.key),
          ["sh", "-c", "kill 1"],
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
    const services = servicesSteps().map((s) => s.name);
    const from = isServicesFleet(this.spec(launch))
      ? services.slice(services.indexOf("send-manifests") + 1)
      : ["upload-node-data", ...phaseEFSteps().map((s) => s.name)];
    for (const name of ["send-manifests", ...from]) {
      this.db.resetStep(launch.id, name);
    }
    return { ...(step ? { step } : {}), closing: info?.state === "active" };
  }

  /** Relaunch / rolling upgrade → fleet_ops rows; steps composed by buildOpSteps. */
  async requestRelaunch(
    launch: LaunchRow,
    component: FleetComponentRow,
    opts: { manualBid?: boolean } = {},
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
   * Set the wallets a services fleet is shared with (sharing.wallets): their
   * chain fleets may link bridges to its Mastodon. Owner only (the route
   * checks); a chain fleet has nothing to share this way. Removing a wallet
   * does not undo bridges already linked; it stops new links and re-links.
   */
  setSharing(launch: LaunchRow, wallets: string[]): string[] {
    if (!isServicesFleet(this.spec(launch))) throw new Error("only a services fleet is shared with other wallets");
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
  requestRelayerPaths(launch: LaunchRow, paths: RelayerPath[]): number {
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
    spec.topology.components.relayer = { ...spec.topology.components.relayer!, paths };
    Object.assign(spec, withDefaults(spec as unknown as LaunchSpecInput));
    for (const p of spec.topology.components.relayer!.paths) {
      if ("fleet" in p.counterparty) {
        p.counterparty.fleet = resolveRelayFleet(this.db, spec, launch.owner, p.counterparty.fleet, launch.id);
      }
    }
    const { errors } = validateSpec(spec);
    if (errors.length > 0) {
      throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join("; "));
    }
    const retunnel = JSON.stringify(relayerTunnels(current)) !== JSON.stringify(relayerTunnels(spec));
    this.db.setLaunchSpec(launch.id, JSON.stringify(spec));
    return this.db.createFleetOp(launch.id, "relayer-paths", { retunnel } satisfies RelayerPathsParams);
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
    // fleet counterparties become launch ids, checked for reachability
    for (const p of spec.topology.components.relayer?.enabled ? spec.topology.components.relayer.paths : []) {
      if ("fleet" in p.counterparty) {
        p.counterparty.fleet = resolveRelayFleet(this.db, spec, launch.owner, p.counterparty.fleet, launch.id);
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
    return this.db.createFleetOp(launch.id, "add-component", {
      key,
      generation: row ? row.generation + 1 : 0,
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
    if (!offers.bids.some((b) => b.provider === provider)) {
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
  requestForceRedeploy(launch: LaunchRow, component: FleetComponentRow): number {
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
    return this.db.createFleetOp(launch.id, "force-redeploy", { key: component.key });
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
    // a SIGNED tx is already broadcast — aborting the op cannot recall it
    // (learned live: an op's close was signed moments before the abort, and
    // the abort's cleanup hid the row while the close landed on-chain)
    const signed = this.db.listSignedPendingTxsLike(launch.id, `op${opId}:%`);
    const warning =
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
    // read the op's deployment BEFORE deleting its steps, then erase the
    // step rows so the abandoned op stops surfacing as the launch's error
    const deploy = this.db.stepOutput<{ dseq: string }>(launch.id, `op${opId}:deploy`);
    this.db.deleteOpSteps(launch.id, opId);
    // and its unsigned txs: the signing queue serves oldest-first, so an
    // abandoned op's dead lease request would shadow the close below forever
    this.db.deleteUnsignedPendingTxsLike(launch.id, `op${opId}:%`);
    if (deploy?.dseq) {
      const info = await this.services.api
        .deploymentInfo(launch.owner, deploy.dseq)
        .catch(() => undefined);
      if (info?.state === "active") {
        const step = `fleet:close:${deploy.dseq}`;
        this.db.enqueuePendingTx(
          launch.id,
          step,
          JSON.stringify([closeDeploymentMsg(launch.owner, deploy.dseq)]),
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
