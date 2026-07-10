import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveTopology, statelessComponents, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { ConductorDb, FleetComponentRow, LaunchRow } from "./db.js";
import { launchDirs } from "./engine.js";
import { sendMsg } from "@sparkdream/akash-tx";
import { accountDepositMsg, closeDeploymentMsg } from "./akash/messages.js";
import { bpsAmount, feeCoin, feeConfig } from "./fee.js";
import { restartNode, rpcUrl } from "./node-ops.js";
import { PRICING_DENOM } from "./render-sdl.js";
import type { Services } from "./services.js";
import { copySecretsDecrypted, copySecretsEncrypted, readSecretFile } from "./secrets.js";
import { toSsh2CompatiblePrivateKey } from "./keys.js";
import { extractForwardedPort, templateHeadscaleSdl, type Assignments, type HeadscaleOutput, type SshEndpoints } from "./steps/phase-bcd.js";
import type { RetargetParams } from "./fleet-ops.js";

/**
 * Fleet layer (M5, §5 day-2): wallet-scoped read-model reconciled against
 * the chain, background health monitor, and per-component actions. Owner
 * scoping note: until wallet-session auth lands (M6), the owner address
 * arrives as a request parameter — the §2 session rule replaces that.
 */

/**
 * Blocks per day for escrow runway estimation: the spec's commit timeout
 * plus ~2s of propose/vote overhead per block (~6s blocks when unset).
 */
function blocksPerDay(spec: LaunchSpec): number {
  const timeout = spec.chainParams.consensus?.timeoutCommit;
  const blockSeconds = timeout ? Number(timeout.replace(/s$/, "")) + 2 : 6;
  return Math.round(86_400 / blockSeconds);
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
  health?: { status: string; detail: string | null; checked_at: string } | undefined;
}

export interface FleetView {
  launchId: string;
  launchStatus: string;
  chainId: string;
  components: ComponentView[];
  ops: Array<{ id: number; kind: string; status: string; params: unknown }>;
}

export interface FleetSummary {
  fleets: FleetView[];
  /** On-chain deployments this launcher has no record of (§2). */
  unmanaged: Array<{ dseq: string; state: string }>;
}

export class FleetService {
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
    if (hs) {
      // adopt a redeployed headscale the same way as the node batch below
      const hsRow = this.db.listFleetComponents(launchId).find((c) => c.key === "headscale");
      if (hsRow && hsRow.generation === 0 && hsRow.dseq !== hs.dseq) {
        this.db.updateComponentPlacement(launchId, "headscale", {
          dseq: hs.dseq,
          provider: hs.provider,
          host_uri: hs.hostUri,
          price: hs.price,
          generation: 0,
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
        spec ? statelessComponents(spec).map((c) => [c.key, c.image]) : [],
      );
      const existing = new Map(
        this.db.listFleetComponents(launchId).map((c) => [c.key, c]),
      );
      for (const [key, entry] of Object.entries(plan.perNode)) {
        const a = assignments.perNode[key];
        if (!a) continue;
        // stale-bid recovery redeploys the whole node batch inside the
        // launch: the step outputs then carry NEW dseqs while the rows hold
        // the closed old generation (upsert is DO NOTHING). Adopt the new
        // identity — but only for generation-0 rows, so a relaunch op's
        // placement (row ahead of the outputs, generation ≥ 1) is never
        // clobbered.
        const row = existing.get(key);
        if (row && row.generation === 0 && row.dseq !== entry.dseq) {
          this.db.updateComponentPlacement(launchId, key, {
            dseq: entry.dseq,
            provider: a.provider,
            host_uri: a.hostUri,
            price: a.price,
            generation: 0,
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
  async componentHeight(
    launch: LaunchRow,
    component: FleetComponentRow,
  ): Promise<{ height: number; catchingUp: boolean } | null> {
    // only chain nodes have an RPC; headscale/explorer/frontend do not
    if (!/^(val|sentry)-/.test(component.key)) return null;
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
        return { height: s.latestBlockHeight, catchingUp: s.catchingUp };
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
      return Number.isFinite(height) ? { height, catchingUp } : null;
    } catch {
      this.rpcUrlCache.delete(component.dseq); // forwarded port / endpoint moved
      return null;
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
            health: h
              ? { status: h.status, detail: h.detail, checked_at: h.checked_at }
              : undefined,
          };
        }),
      );
      fleets.push({
        launchId: launch.id,
        launchStatus: launch.status,
        chainId: `${spec.network.name}-${spec.network.chainIdSuffix}`,
        components,
        ops: this.db.listFleetOps(launch.id).map((o) => ({
          id: o.id,
          kind: o.kind,
          status: o.status,
          params: JSON.parse(o.params_json),
        })),
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
    const componentDomains = new Map<string, string>(
      statelessComponents(spec).map((c) => [c.key, c.domain]),
    );

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
            // RPC is on a provider-assigned forwarded port, not :26657
            const lease = await this.services.provider.leaseStatus(
              this.mtlsCreds(launch), c.host_uri, c.dseq, 1, 1,
            );
            const ep = extractForwardedPort(lease, 26657);
            const status = await this.services.rpc.status(`http://${ep.host}:${ep.port}`);
            // height is shown by the live per-second indicator, not here —
            // this check only flags a stalled/catching-up sentry
            if (status.catchingUp) {
              this.db.setComponentHealth(launchId, c.key, "catching-up", details.join("; "));
              return;
            }
          } else if (componentDomains.has(c.key)) {
            // stateless components: HTTP 200 on the public domain (§5 step 21)
            const url = `https://${componentDomains.get(c.key)}/`;
            if (!(await this.services.rpc.httpOk(url))) {
              this.db.setComponentHealth(
                launchId, c.key, "unreachable", `${url} not answering`,
              );
              return;
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
  closeWarnings(launch: LaunchRow, component: FleetComponentRow): string[] {
    const warnings: string[] = [];
    const spec = this.spec(launch);
    if (component.key.startsWith("sentry-")) {
      const s = Number(component.key.split("-")[1]);
      const topo = resolveTopology(spec);
      for (const v of topo.sentryValidators[s] ?? []) {
        const others = (topo.validatorSentries[v] ?? []).filter((x) => x !== s);
        if (others.length === 0) {
          warnings.push(
            `sentry-${s} is validator ${v}'s only peer path — the validator will miss blocks ` +
              `and risks downtime-jailing while it has no sentry`,
          );
        }
      }
    }
    if (component.key === "headscale") {
      warnings.push("closing headscale severs the mesh: nodes keep running but cannot re-wire");
    }
    if (component.key.startsWith("val-")) {
      warnings.push(
        `closing ${component.key} destroys its lease-scoped volume; consensus key custody per §3 still applies`,
      );
    }
    return warnings;
  }

  /** Enqueue MsgCloseDeployment into the launch's signing loop. */
  requestClose(launch: LaunchRow, component: FleetComponentRow): { step: string } {
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
    return Object.entries(keys.accounts).map(([name, address]) => ({
      name,
      address,
      hasMnemonic: name in mnemonics,
    }));
  }

  mnemonic(launch: LaunchRow, name: string): string {
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
   */
  async settleFleetTxs(launchId: string): Promise<void> {
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
      }
      if (action === "shutdown") {
        for (const c of this.db.listFleetComponents(launchId)) {
          if (c.state !== "closed") this.db.setComponentState(launchId, c.key, "closed");
        }
        // shutting down an in-flight launch ends it — otherwise it lingers
        // "paused" on whatever step it died at, error banner and all
        const launch = this.db.getLaunch(launchId);
        if (launch && launch.status !== "completed") {
          this.db.setLaunchStatus(launchId, "aborted");
        }
      }
    }
  }

  /** Restart the component (no signature — §2 scoping rule). Nodes restart
   *  over SSH; headscale (no sshd) and the stateless components restart via
   *  provider lease-shell — killing PID 1 makes the provider recreate the
   *  container, which re-reads its env (tunnels included) at boot. */
  async restart(launch: LaunchRow, component: FleetComponentRow): Promise<void> {
    if (["headscale", "explorer", "frontend"].includes(component.key)) {
      await this.services.provider
        .shellExec(
          this.mtlsCreds(launch), component.host_uri, component.dseq, 1, 1, component.key,
          ["sh", "-c", "kill 1"],
        )
        .catch(() => {
          // killing PID 1 drops the shell connection — expected
        });
      return;
    }
    await restartNode(this.services.ssh, this.sshTargetFor(launch, component));
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
        service: "sparkdreamd",
      },
    };
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

  /** Relaunch / rolling upgrade → fleet_ops rows; steps composed by buildOpSteps. */
  requestRelaunch(launch: LaunchRow, component: FleetComponentRow): number {
    if (component.key === "headscale") {
      throw new Error("headscale relaunch is not supported (it re-keys the whole mesh)");
    }
    // everything except the frontend joins the mesh, and a relaunch mints its
    // preauth key via headscale — impossible once the fleet is shut down
    if (component.key !== "frontend") {
      const hs = this.db
        .listFleetComponents(launch.id)
        .find((c) => c.key === "headscale");
      if (hs?.state === "closed") {
        throw new Error(
          `${component.key} cannot relaunch: headscale is closed (fleet shut down) — a relaunch needs the mesh to mint a preauth key`,
        );
      }
    }
    const prefs = this.db.providerPrefs(launch.owner);
    // always move OFF the current provider (that's the point of a relaunch),
    // plus the wallet's global avoid list
    const avoidProviders = [...new Set([component.provider, ...prefs.avoid])];
    return this.db.createFleetOp(launch.id, "relaunch", {
      key: component.key,
      generation: component.generation + 1,
      avoidProviders,
      preferProviders: prefs.prefer,
    });
  }

  /**
   * Abandon an in-progress op (e.g. a relaunch stuck on a broken provider).
   * Its steps stop running (aborted ops contribute none to buildOpSteps),
   * and its new deployment — if leased — is closed through the signing loop
   * so escrow is refunded. The component stays 'closed', ready to relaunch.
   */
  async requestAbortOp(launch: LaunchRow, opId: number): Promise<{ step?: string }> {
    const op = this.db.listFleetOps(launch.id).find((o) => o.id === opId);
    if (!op) throw new Error(`op ${opId} not found`);
    if (op.status === "done") throw new Error(`op ${opId} already completed — nothing to abort`);
    this.db.setFleetOpStatus(opId, "aborted");
    // read the op's deployment BEFORE deleting its steps, then erase the
    // step rows so the abandoned op stops surfacing as the launch's error
    const deploy = this.db.stepOutput<{ dseq: string }>(launch.id, `op${opId}:deploy`);
    this.db.deleteOpSteps(launch.id, opId);
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
        return { step };
      }
    }
    return {};
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
    return this.db.createFleetOp(launch.id, "upgrade", { components, image });
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
    return this.db.createFleetOp(launch.id, "halt-upgrade", { image, haltHeight });
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
   * Fleet bundle export (§5 "Fleet bundle"): spec + secrets + component
   * records, tar'd and age-encrypted to the launch's recipient. Consensus
   * keys never enter it in tmkms mode (they were never uploaded and the
   * bundle only includes config the nodes already have in softsign mode).
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
          version: 1,
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
    const dirs = launchDirs(this.workRoot, launchId);
    fs.mkdirSync(dirs.root, { recursive: true });
    copySecretsEncrypted(path.join(extractedDir, "secrets"), dirs.secrets);
    fs.chmodSync(dirs.secrets, 0o700);
    return { launchId };
  }
}
