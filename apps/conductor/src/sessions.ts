import fs from "node:fs";
import path from "node:path";
import { Secp256k1HdWallet } from "@cosmjs/amino";
import { fleetBridge, sessionDays, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import { BRIDGE_OPERATOR } from "./components/mastodon-secrets.js";
import type { ConductorDb, FleetComponentRow } from "./db.js";
import { AwaitUser, WALLET_SIGNER, type StepCtx } from "./engine.js";
import { sparkdreamd } from "./exec.js";
import { fleetActor, sendTx, walletPause, type ChainActor } from "./peering.js";
import { readSecretFile, writeSecretFile } from "./secrets.js";
import { loadCert, type Assignments, type DeploymentPlan } from "./steps/phase-bcd.js";
import { queryJson } from "./steps/phase-g.js";
import { verifierMember, verifierTargetId } from "./verifier.js";

/**
 * Session keys for the unattended daemons (§5 session keys). sdapverify and
 * sdapbridge run on providers the user does not control, so neither gets its
 * account's key: the verifier's member key holds a DREAM bond, the bridge
 * operator's the service bond. Each daemon instead signs with an x/session
 * SESSION_KEY grant from that account:
 *
 *   scope     one message type (MsgVerifyContent / MsgSubmitFederatedContent)
 *   budget    spend_limit: the account pays the daemon's fees, up to this
 *   lifetime  the component's session.days, capped by the chain's
 *             max_expiration
 *
 * The launcher, which holds the account key, grants the session, writes its
 * key into the daemon's container (SESSION_KEY_FILE, re-read by the daemon
 * before every tx) and revokes the grant it replaces. It rotates to a fresh
 * key when:
 *
 *   - there is none yet, or the chain no longer has the grant (a chain
 *     reset, an outside revoke)
 *   - the daemon moved to another deployment: the provider that held the
 *     old key keeps a copy
 *   - a third of the lifetime, budget or exec cap is left
 *
 * With a launcher-held account every step is local signing, so renewal runs
 * unattended from the monitor (FleetService.sessionsDue → a "sessions" op).
 * The launcher only has to run once per two-thirds of a lifetime.
 *
 * A verifier acting as a member whose key stays in the user's wallet
 * (verifier.wallet) cannot be granted unattended: the grant (with the revoke
 * of the key it replaces) pauses for that member's signature. The new key is
 * recorded, marked pending, before the pause, so the resume finds the grant
 * on chain and delivers that same key rather than minting another.
 */

export type SessionRole = "verifier" | "bridge";

/** Where the key file lives in each daemon's container. Both are on a
 *  persistent volume, so a container restart keeps the key. */
export const SESSION_KEY_FILE = "/data/session-key";

const MSG_TYPES: Record<SessionRole, string[]> = {
  verifier: ["/sparkdream.federation.v1.MsgVerifyContent"],
  bridge: ["/sparkdream.federation.v1.MsgSubmitFederatedContent"],
};

/** The component a role's daemon runs in, and the SDL service inside it. */
function HOST_OF(spec: LaunchSpec, role: SessionRole): { component: string; service: string } {
  if (role === "verifier") return { component: "verifier", service: "verifier" };
  // a fleet's bridge is its Mastodon's sidecar, or a standalone component
  return fleetBridge(spec)?.kind === "standalone"
    ? { component: "bridge", service: "bridge" }
    : { component: "mastodon", service: "bridge" };
}

/** One daemon's session, as last granted (secrets/sessions.json). */
export interface SessionRecord {
  mnemonic: string;
  grantee: string;
  granter: string;
  chainId: string;
  /** Deployment the key was delivered to: another dseq means another holder. */
  dseq: string;
  createdAt: string;
  expiresAt: string;
  spendLimit: string;
  maxExecCount: number;
  /** Grantees this record replaced whose revoke has not landed yet. */
  pendingRevoke?: string[];
  /** Granted by a wallet, whose signature has not landed yet: the grant is
   *  not on chain and the key has not been delivered. */
  pending?: boolean;
}

interface SessionsFile {
  [role: string]: SessionRecord;
}

function sessionsPath(secretsDir: string): string {
  return path.join(secretsDir, "sessions.json");
}

export function readSessions(secretsDir: string): SessionsFile {
  const file = sessionsPath(secretsDir);
  return fs.existsSync(file) ? (JSON.parse(readSecretFile(file)) as SessionsFile) : {};
}

function writeSession(secretsDir: string, role: SessionRole, record: SessionRecord | undefined): void {
  const all = readSessions(secretsDir);
  if (record) all[role] = record;
  else delete all[role];
  writeSecretFile(sessionsPath(secretsDir), JSON.stringify(all, null, 2));
}

/** The roles this spec runs a daemon for. */
export function sessionRoles(spec: LaunchSpec): SessionRole[] {
  const c = spec.topology.components;
  return [
    ...(c.verifier?.enabled ? (["verifier"] as const) : []),
    ...(fleetBridge(spec) ? (["bridge"] as const) : []),
  ];
}

/** The role's session settings from the spec. */
function settings(spec: LaunchSpec, role: SessionRole): { days: number; spendLimit: string } {
  const s =
    role === "verifier"
      ? spec.topology.components.verifier?.session
      : fleetBridge(spec)?.link.session;
  return { days: sessionDays(spec, s), spendLimit: s?.spendLimit ?? "25000000" };
}

/** Gas of the grant tx (account-creating send + MsgCreateSession). */
const GRANT_TX_GAS = 400_000;

/**
 * What the account granting a daemon's session key needs spendable, in the
 * gas denom: 1 unit sent to create the key's auth account, the grant tx's
 * fee, and, on a chain with a gas price, the key's fee budget (the account
 * pays the daemon's fees out of it). Anything bonded does not count.
 */
export function sessionReserve(gasPrice: number, spendLimit: string): bigint {
  const fee = BigInt(Math.ceil(gasPrice * GRANT_TX_GAS));
  return 1n + fee + (gasPrice > 0 ? BigInt(spendLimit) : 0n);
}

/** The role's session settings, for callers sizing a funding request. */
export function sessionSpendLimit(spec: LaunchSpec, role: SessionRole): string {
  return settings(spec, role).spendLimit;
}

/** A third of the lifetime left: time to renew. */
export function renewAt(record: SessionRecord): number {
  const created = Date.parse(record.createdAt);
  const expires = Date.parse(record.expiresAt);
  return expires - (expires - created) / 3;
}

/** Go durations as the CLI prints them ("168h0m0s") or as JSON ("604800s"). */
export function durationMs(value: string): number {
  let ms = 0;
  for (const [, n, unit] of value.matchAll(/([0-9.]+)(h|ms|m|s)/g)) {
    ms += Number(n) * ({ h: 3_600_000, m: 60_000, s: 1_000, ms: 1 } as Record<string, number>)[unit!]!;
  }
  if (!ms) throw new Error(`cannot read duration "${value}"`);
  return ms;
}

/** The lease a component runs under: its fleet row, else the launch's outputs. */
export function componentLease(
  ctx: StepCtx,
  key: string,
): { hostUri: string; dseq: string; gseq: number; oseq: number } {
  const row = (ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[]).find(
    (c) => c.key === key && c.state !== "closed" && c.dseq !== "0",
  );
  if (row) return { hostUri: row.host_uri, dseq: row.dseq, gseq: 1, oseq: 1 };
  const a = ctx.output<Assignments>("collect-bids")?.perNode[key];
  const plan = ctx.output<DeploymentPlan>("create-deployments")?.perNode[key];
  if (a && plan) return { hostUri: a.hostUri, dseq: plan.dseq, gseq: a.gseq, oseq: a.oseq };
  throw new Error(`${key}: no deployment recorded yet`);
}

/**
 * The chain the role's grant lives on and the account granting it. `signer`
 * is set when the launcher holds that account's key; a wallet member's grant
 * has none and pauses for the wallet instead.
 */
async function granterActor(ctx: StepCtx, spec: LaunchSpec, role: SessionRole): Promise<{ chain: ChainActor; granter: string }> {
  if (role === "verifier") {
    const targetId = verifierTargetId(spec, ctx.launchId);
    const chain = await fleetActor(ctx, targetId, targetId === ctx.launchId ? "this fleet" : `fleet ${targetId}`);
    const member = verifierMember(spec, ctx.launchId, ctx.db, ctx.workRoot);
    const { signer: _none, ...unsigned } = chain;
    return member.key
      ? { chain: { ...chain, signer: { ...member.key, address: member.address } }, granter: member.address }
      : { chain: unsigned, granter: member.address };
  }
  const chain = await fleetActor(ctx, ctx.launchId, "this fleet");
  const { stdout } = await sparkdreamd([
    "keys", "show", BRIDGE_OPERATOR, "-a", "--keyring-backend", "test", "--home", ctx.dirs.node("val-0"),
  ]);
  return { chain: { ...chain, signer: { home: ctx.dirs.node("val-0"), key: BRIDGE_OPERATOR, address: stdout.trim() } }, granter: stdout.trim() };
}

/** The grant as the chain has it, or undefined when it has none. */
async function querySession(chain: Pick<ChainActor, "rpc">, granter: string, grantee: string): Promise<any | undefined> {
  try {
    return (await queryJson(["query", "session", "session", granter, grantee], chain.rpc)).session ?? undefined;
  } catch (e) {
    if (/no active session|not found|NotFound/i.test(String(e))) return undefined;
    throw e;
  }
}

/** The monitor's hourly look at a recorded grant: whether it still holds. */
export async function grantHolds(rpc: string, record: SessionRecord): Promise<boolean> {
  const onChain = await querySession({ rpc }, record.granter, record.grantee);
  return Boolean(onChain) && !grantWornOut(onChain, record);
}

/** The launch whose chain holds a role's grant. */
export function sessionChainLaunch(spec: LaunchSpec, launchId: string, role: SessionRole): string {
  return role === "verifier" ? verifierTargetId(spec, launchId) : launchId;
}

/** Why a live grant should be replaced before it runs out, if it should. */
export function grantWornOut(onChain: any, record: SessionRecord): string | undefined {
  const spent = BigInt(onChain.spent?.amount ?? "0");
  const limit = BigInt(onChain.spend_limit?.amount ?? record.spendLimit);
  if (spent * 3n >= limit * 2n) return "two thirds of its fee budget is spent";
  const execs = Number(onChain.exec_count ?? 0);
  if (execs * 3 >= Number(onChain.max_exec_count ?? record.maxExecCount) * 2) return "two thirds of its exec cap is used";
  return undefined;
}

/** Why the recorded session must be replaced, or undefined if it holds. */
async function rotationReason(
  chain: ChainActor,
  record: SessionRecord | undefined,
  dseq: string,
  granter: string,
): Promise<string | undefined> {
  if (!record) return "no session yet";
  if (record.granter !== granter || record.chainId !== chain.chainId) return "the account or chain changed";
  if (record.dseq !== dseq) return "the daemon moved to another deployment";
  if (Date.now() >= renewAt(record)) return "a third of its lifetime is left";
  const onChain = await querySession(chain, granter, record.grantee);
  if (!onChain) return "the chain no longer has the grant";
  return grantWornOut(onChain, record);
}

/** Write the key into the daemon's container, atomically. */
async function deliverKey(ctx: StepCtx, role: SessionRole, mnemonic: string): Promise<void> {
  const host = HOST_OF(ctx.spec, role);
  const lease = componentLease(ctx, host.component);
  // BIP39 words are lowercase ASCII: safe inside single quotes
  if (!/^[a-z ]+$/.test(mnemonic)) throw new Error("session mnemonic has unexpected characters");
  const tmp = `${SESSION_KEY_FILE}.new`;
  let lastError = "";
  // the container is often restarting right now: the bridge's token lands
  // through a deployment update just before this, and lease-shell answers
  // "no active replicas" until the new one is up
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt > 0) await ctx.services.sleep(10_000);
    try {
      await ctx.services.provider.shellExec(
        loadCert(ctx), lease.hostUri, lease.dseq, lease.gseq, lease.oseq, host.service,
        // lease-shell runs as the image's user (root, for the sdap image, whose
        // entrypoint drops the daemon to "sdap"): hand the file to the daemon
        [
          "sh", "-c",
          `umask 077 && printf '%s\\n' '${mnemonic}' > ${tmp} && ` +
            `(chown sdap ${tmp} 2>/dev/null || true) && mv ${tmp} ${SESSION_KEY_FILE}`,
        ],
      );
      return;
    } catch (e) {
      lastError = String(e instanceof Error ? e.message : e).slice(0, 300);
      ctx.log(`${host.component}: session key delivery attempt ${attempt + 1} failed: ${lastError}`);
    }
  }
  throw new Error(`could not deliver the session key to ${host.component}: ${lastError}`);
}

/** Revoke grants that were replaced; ones already gone count as done.
 *  Without a launcher-held key nothing is sent: what is still on chain is
 *  left for the next wallet grant to revoke. */
async function revokeGrantees(ctx: StepCtx, chain: ChainActor, granter: string, grantees: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const grantee of grantees) {
    if (!(await querySession(chain, granter, grantee).catch(() => "unknown"))) continue;
    if (!chain.signer) {
      left.push(grantee);
      continue;
    }
    try {
      await sendTx(ctx, chain, `${chain.chainId}-revoke-session-${grantee.slice(-8)}`, [
        { "@type": "/sparkdream.session.v1.MsgRevokeSession", granter, grantee },
      ]);
    } catch (e) {
      ctx.log(`session: revoking ${grantee} failed (${String(e).slice(0, 200)}); retried on the next renewal`);
      left.push(grantee);
    }
  }
  return left;
}

export interface SessionOutcome {
  role: SessionRole;
  grantee: string;
  granter: string;
  expiresAt: string;
  rotated: boolean;
  reason?: string;
}

/** What a new grant asks for: the component's settings within the chain's
 *  ceilings. */
async function grantTerms(
  ctx: StepCtx,
  spec: LaunchSpec,
  role: SessionRole,
  chain: ChainActor,
): Promise<{ expiresAt: Date; spendLimit: string; maxExecCount: number; chainSpec: LaunchSpec }> {
  // the chain's ceilings bound what may be asked for
  const params = (await queryJson(["query", "session", "params"], chain.rpc)).params ?? {};
  const want = settings(spec, role);
  const lifetimeMs = Math.min(want.days * 86_400_000, durationMs(String(params.max_expiration ?? "168h")));
  // block time trails the wall clock by a block or two, and create-session
  // rejects anything past block time + max_expiration: stay a little inside
  const expiresAt = new Date(Date.now() + lifetimeMs - 10 * 60_000);
  const maxSpend = BigInt(params.max_spend_limit_amount ?? want.spendLimit);
  const spendLimit = (BigInt(want.spendLimit) < maxSpend ? BigInt(want.spendLimit) : maxSpend).toString();
  const maxExecCount = Number(params.max_exec_count ?? 10_000);
  // the grant's chain: a verifier may watch another fleet's
  const targetId = sessionChainLaunch(spec, ctx.launchId, role);
  const chainSpec = targetId === ctx.launchId ? spec : withDefaults(JSON.parse(ctx.db.getLaunch(targetId)!.spec_json));
  return { expiresAt, spendLimit, maxExecCount, chainSpec };
}

async function spendableOf(chain: ChainActor, address: string): Promise<bigint> {
  const spendable = await queryJson(["query", "bank", "spendable-balances", address], chain.rpc).catch(() => ({ balances: [] }));
  return BigInt(((spendable.balances ?? []) as Array<{ denom: string; amount: string }>).find((b) => b.denom === chain.gasDenom)?.amount ?? "0");
}

/** The grant's messages. MsgCreateSession does not create the grantee's
 *  auth account, and an account that does not exist cannot sign: the send
 *  of one unit creates it. */
function grantMsgs(
  role: SessionRole,
  chain: ChainActor,
  granter: string,
  grantee: string,
  expiresAt: Date,
  spendLimit: string,
  maxExecCount: number,
): unknown[] {
  return [
    {
      "@type": "/cosmos.bank.v1beta1.MsgSend",
      from_address: granter,
      to_address: grantee,
      amount: [{ denom: chain.gasDenom, amount: "1" }],
    },
    {
      "@type": "/sparkdream.session.v1.MsgCreateSession",
      granter,
      grantee,
      allowed_msg_types: MSG_TYPES[role],
      spend_limit: { denom: chain.gasDenom, amount: spendLimit },
      expiration: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      max_exec_count: String(maxExecCount),
    },
  ];
}

/**
 * A grant only the granter's wallet can sign. The key is minted and recorded
 * (pending) before the pause, and the pause re-asks for that same key until
 * it is signed or grows too old to be worth granting; the resume, finding
 * the grant on chain, delivers it (ensureSession's no-rotation path). The
 * grants it replaces are revoked in the same transaction, so the daemon
 * pauses between the signature and the key's delivery, never longer.
 */
async function walletGrant(
  ctx: StepCtx,
  spec: LaunchSpec,
  role: SessionRole,
  chain: ChainActor,
  granter: string,
  dseq: string,
  record: SessionRecord | undefined,
  reason: string,
): Promise<never> {
  const reuse =
    record?.pending &&
    record.granter === granter &&
    record.chainId === chain.chainId &&
    record.dseq === dseq &&
    // two thirds of the asked lifetime left: still worth granting as is
    Date.now() < renewAt(record);
  let next: SessionRecord;
  if (reuse) {
    next = record!;
  } else {
    const { expiresAt, spendLimit, maxExecCount, chainSpec } = await grantTerms(ctx, spec, role, chain);
    const w = await Secp256k1HdWallet.generate(24, { prefix: chainSpec.network.bech32Prefix });
    const [account] = await w.getAccounts();
    // a pending record never reached the chain: nothing of it to revoke
    const previous = record && !record.pending && record.granter === granter && record.chainId === chain.chainId ? [record.grantee] : [];
    next = {
      mnemonic: w.mnemonic,
      grantee: account!.address,
      granter,
      chainId: chain.chainId,
      dseq,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      spendLimit,
      maxExecCount,
      pendingRevoke: [...new Set([...(record?.pendingRevoke ?? []), ...previous])],
      pending: true,
    };
    writeSession(ctx.dirs.secrets, role, next);
  }
  const revoke = await revokeGrantees(ctx, chain, granter, next.pendingRevoke ?? []);
  const msgs = [
    ...grantMsgs(role, chain, granter, next.grantee, new Date(next.expiresAt), next.spendLimit, next.maxExecCount),
    ...revoke.map((grantee) => ({ "@type": "/sparkdream.session.v1.MsgRevokeSession", granter, grantee })),
  ];
  const pause = await walletPause(ctx, `session-${role}`, chain, `grant the ${role}'s session key`, msgs, {
    signerRole: `the ${role} member`,
    signer: granter,
  });
  ctx.log(`session: ${role} needs a new key (${reason}); waiting for ${granter} to sign the grant of ${next.grantee}`);
  // the daemon's fees come out of the member's own balance, up to the limit
  const reserve = sessionReserve(chain.gasPrice, next.spendLimit);
  const have = await spendableOf(chain, granter);
  const note =
    have < reserve
      ? ` Note: ${granter} holds ${have} ${chain.gasDenom} spendable; the daemon's fees, paid from it, may reach ${reserve}.`
      : "";
  throw new AwaitUser(pause.step, pause.reason + note, pause.wallet);
}

/**
 * Bring the role's daemon to a working session key: keep the current one if
 * it holds, else grant a new one, deliver it, and revoke the old. Idempotent;
 * `force` rotates regardless (the UI's "rotate now").
 */
export async function ensureSession(
  ctx: StepCtx,
  spec: LaunchSpec,
  role: SessionRole,
  opts: { force?: boolean } = {},
): Promise<SessionOutcome> {
  const { chain, granter } = await granterActor(ctx, spec, role);
  const dseq = componentLease(ctx, HOST_OF(spec, role).component).dseq;
  const record = readSessions(ctx.dirs.secrets)[role];
  // a wallet grant signed since the pause: rotationReason sees it hold
  const forced = opts.force && !record?.pending;
  const reason = forced ? "rotation requested" : await rotationReason(chain, record, dseq, granter);

  if (!reason) {
    // same key, same deployment: re-deliver anyway (cheap), in case the
    // volume was replaced under the same lease
    await deliverKey(ctx, role, record!.mnemonic);
    const left = await revokeGrantees(ctx, chain, granter, record!.pendingRevoke ?? []);
    if ((record!.pendingRevoke?.length ?? 0) !== left.length || record!.pending) {
      writeSession(ctx.dirs.secrets, role, { ...record!, pendingRevoke: left, pending: false });
    }
    if (record!.pending) {
      ctx.log(`session: ${role} key ${record!.grantee} granted by ${granter} until ${record!.expiresAt} (signed in the wallet)`);
      return { role, grantee: record!.grantee, granter, expiresAt: record!.expiresAt, rotated: true, reason: "signed in the wallet" };
    }
    return { role, grantee: record!.grantee, granter, expiresAt: record!.expiresAt, rotated: false };
  }

  if (!chain.signer) return walletGrant(ctx, spec, role, chain, granter, dseq, record, reason);

  const { expiresAt, spendLimit, maxExecCount, chainSpec } = await grantTerms(ctx, spec, role, chain);
  // the grant sends 1 unit and pays a fee: bonded funds do not count, so a
  // freshly bonded account can be short; ask for a top-up rather than fail
  const have = await spendableOf(chain, granter);
  const need = sessionReserve(chain.gasPrice, spendLimit);
  if (have < need) {
    // a few whole tokens over the exact shortfall, so renewals do not ask again
    const topUp = need - have + 5n * 10n ** BigInt(chainSpec.token.exponent ?? 6);
    throw await walletPause(
      ctx,
      `session-${role}`,
      chain,
      `fund ${role === "bridge" ? "the bridge operator" : "the verifier account"} ${granter} with ${topUp} ${chain.gasDenom} ` +
        `so it can grant its daemon's session key (it has ${have} spendable)`,
      [{ "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: WALLET_SIGNER, to_address: granter, amount: [{ denom: chain.gasDenom, amount: topUp.toString() }] }],
      { signerRole: `an account holding ${chain.gasDenom}` },
    );
  }

  const w = await Secp256k1HdWallet.generate(24, { prefix: chainSpec.network.bech32Prefix });
  {
    const [account] = await w.getAccounts();
    const grantee = account!.address;
    await sendTx(ctx, chain, `${chain.chainId}-session-${role}`, grantMsgs(role, chain, granter, grantee, expiresAt, spendLimit, maxExecCount));
    const replaced = [
      ...(record?.pendingRevoke ?? []),
      ...(record && record.granter === granter && record.chainId === chain.chainId ? [record.grantee] : []),
    ];
    const next: SessionRecord = {
      mnemonic: w.mnemonic,
      grantee,
      granter,
      chainId: chain.chainId,
      dseq,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      spendLimit,
      maxExecCount,
      pendingRevoke: replaced,
    };
    // recorded before delivery: a failure from here on retries with this key
    writeSession(ctx.dirs.secrets, role, next);
    await deliverKey(ctx, role, w.mnemonic);
    // the old key stops only once the new one is in place
    const left = await revokeGrantees(ctx, chain, granter, replaced);
    writeSession(ctx.dirs.secrets, role, { ...next, pendingRevoke: left });
    ctx.log(`session: ${role} key ${grantee} granted by ${granter} until ${next.expiresAt} (${reason})`);
    return { role, grantee, granter, expiresAt: next.expiresAt, rotated: true, reason };
  }
}

/** Revoke a role's session and forget it (component closed or disabled). */
export async function retireSession(ctx: StepCtx, spec: LaunchSpec, role: SessionRole): Promise<void> {
  const record = readSessions(ctx.dirs.secrets)[role];
  if (!record) return;
  const actor = await granterActor(ctx, spec, role).catch(() => undefined);
  const grantees = [...(record.pending ? [] : [record.grantee]), ...(record.pendingRevoke ?? [])];
  const left = actor && actor.granter === record.granter ? await revokeGrantees(ctx, actor.chain, actor.granter, grantees) : grantees;
  if (left.length > 0 && actor && !actor.chain.signer) {
    // a wallet's grants cannot be revoked unattended, and closing the
    // daemon must not wait on a signature: they lapse at their expiry
    ctx.log(
      `session: ${role} grants ${left.join(", ")} from ${record.granter} stay until they expire ` +
        `(${record.expiresAt}); revoke them from that wallet (tx session revoke-session) to end them sooner`,
    );
    writeSession(ctx.dirs.secrets, role, undefined);
    return;
  }
  if (left.length === 0) writeSession(ctx.dirs.secrets, role, undefined);
  else writeSession(ctx.dirs.secrets, role, { ...record, pendingRevoke: left });
}

/**
 * Whether the monitor should start a "sessions" op: a role whose daemon runs
 * but whose key is missing, stale or due, or a recorded session whose daemon
 * is gone. Reads local records only; the op checks the chain.
 */
export function sessionsDue(db: ConductorDb, launchId: string, secretsDir: string, spec: LaunchSpec): boolean {
  const records = readSessions(secretsDir);
  const rows = db.listFleetComponents(launchId) as FleetComponentRow[];
  const roles = sessionRoles(spec);
  for (const role of roles) {
    const row = rows.find((c) => c.key === HOST_OF(spec, role).component && c.state === "active");
    if (!row) continue;
    const record = records[role];
    // a revoke that failed is retried by the next renewal, not by its own op
    if (!record || record.dseq !== row.dseq || Date.now() >= renewAt(record)) return true;
  }
  for (const role of Object.keys(records) as SessionRole[]) {
    const running = rows.some((c) => c.key === HOST_OF(spec, role).component && c.state !== "closed");
    if (!roles.includes(role) || !running) return true;
  }
  return false;
}

/**
 * The "sessions" op body: renew every running daemon's key, and retire the
 * sessions of daemons that are gone.
 */
export async function reconcileSessions(ctx: StepCtx, spec: LaunchSpec, force: SessionRole[] = []): Promise<SessionOutcome[]> {
  const rows = ctx.db.listFleetComponents(ctx.launchId) as FleetComponentRow[];
  const roles = sessionRoles(spec);
  const out: SessionOutcome[] = [];
  for (const role of roles) {
    if (!rows.some((c) => c.key === HOST_OF(spec, role).component && c.state === "active")) continue;
    out.push(await ensureSession(ctx, spec, role, { force: force.includes(role) }));
  }
  for (const role of Object.keys(readSessions(ctx.dirs.secrets)) as SessionRole[]) {
    const running = rows.some((c) => c.key === HOST_OF(spec, role).component && c.state !== "closed");
    if (!roles.includes(role) || !running) await retireSession(ctx, spec, role);
  }
  return out;
}

/** What the fleet panel shows per session: never the key itself. */
export function sessionSummary(secretsDir: string): Array<Omit<SessionRecord, "mnemonic"> & { role: string; renewAt: string }> {
  return Object.entries(readSessions(secretsDir)).map(([role, r]) => {
    const { mnemonic: _secret, ...rest } = r;
    return { role, ...rest, renewAt: new Date(renewAt(r)).toISOString() };
  });
}
