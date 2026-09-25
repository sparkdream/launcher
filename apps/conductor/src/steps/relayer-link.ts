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
import { sshTarget, type SshEndpoints } from "./phase-bcd.js";

/** What linking produced: the relayer's address on each chain and the
 *  channels it opened. Also saved to <launch>/relayer/state.json for the
 *  fleet panel, since the step that last linked may be a launch step or any
 *  op's. */
export interface RelayerLinkOutput {
  chains: Array<{ chainId: string; address: string; launchId?: string }>;
  channels: RelayChannel[];
  linkedAt: string;
}

/** Bringup opens clients, connections and channels one handshake at a time,
 *  each waiting on blocks from both chains. */
const BRINGUP_TIMEOUT_MS = 20 * 60_000;

export function relayerStatePath(workRoot: string, launchId: string): string {
  return path.join(launchDirs(workRoot, launchId).root, "relayer", "state.json");
}

/** The relayer container's SSH target: from its fleet row once materialized,
 *  else from send-manifests (during the launch itself). */
function relayerTarget(ctx: StepCtx): SshTarget {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find((c) => c.key === "relayer");
  if (row?.ssh_host && row.ssh_port) return sshTarget(ctx, row.ssh_host, row.ssh_port);
  const ep = ctx.output<SshEndpoints>("send-manifests")?.perNode.relayer;
  if (!ep) throw new Error("relayer: no SSH endpoint recorded yet");
  return sshTarget(ctx, ep.host, ep.port);
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
  const unready = status.filter((s) => !s.ready);
  if (unready.length > 0) {
    const denomOf = (id: string) => plan.chains.find((c) => c.chainId === id)?.gasDenom ?? "its gas denom";
    throw new AwaitUser(
      stepName,
      "fund the relayer so it can pay gas, then resume: " +
        unready
          .map((s) => {
            const address = s.address || chains.find((c) => c.chainId === s.chain)?.address;
            return `${s.chain}: send ${denomOf(s.chain)} to ${address}` + (s.account === false ? " (account not found yet)" : "");
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
  fs.writeFileSync(relayerStatePath(ctx.workRoot, ctx.launchId), JSON.stringify(out, null, 2));
  for (const ch of channels) {
    ctx.log(`relayer: ${ch.id} open — ${ch.a.chain}/${ch.a.channel} <-> ${ch.b.chain}/${ch.b.channel} (${ch.port})`);
  }
  return out;
}

/** Launch step: link a relayer the spec enables, after the chain is verified. */
export const linkRelayerStep: StepDef = {
  name: "link-relayer",
  async run(ctx) {
    if (!ctx.spec.topology.components.relayer?.enabled) return { skipped: true };
    return linkRelayer(ctx, "link-relayer", ctx.spec);
  },
};
