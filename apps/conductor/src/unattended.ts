import fs from "node:fs";
import path from "node:path";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { calculateFee, GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, toEncodeObject, TypeUrl, UNATTENDED_MSG_TYPES, type Msg } from "@sparkdream/akash-tx";
import type { ConductorDb } from "./db.js";
import { readSecretFile, writeSecretFile } from "./secrets.js";

/**
 * Unattended recovery, signing half (robustness plan step 6). The owner's
 * wallet grants a key the launcher holds (one per wallet) authz for the
 * four msg types a relaunch needs (UNATTENDED_MSG_TYPES) and a fee
 * allowance limited to MsgExec, both expiring. The launcher then signs the
 * pending txs of ops IT started on its own (incident auto-recovery) as
 * MsgExec, the owner paying the fee through the allowance, so deployments
 * stay the owner's and nothing else changes.
 *
 * What bounds the key: the msg types (no bank sends, no escrow deposits to
 * someone else's deployment), the grants' expiry, the fee allowance's cap,
 * and the daily deposit cap enforced here (a create-deployment's deposit
 * is the one amount a grant cannot cap on-chain). The owner wallet is a
 * hot wallet with limited funds by design.
 */

export interface GrantInfo {
  msgType: string;
  expiration: string | null;
}

export interface AllowanceInfo {
  spendLimit: { denom: string; amount: string }[];
  expiration: string | null;
}

/** The chain side, injectable for tests. */
export interface UnattendedChain {
  grants(granter: string, grantee: string): Promise<GrantInfo[]>;
  allowance(granter: string, grantee: string): Promise<AllowanceInfo | null>;
  /** Sign MsgExec(msgs) with the grantee's key, the granter paying the fee; the tx hash. */
  exec(mnemonic: string, granter: string, msgs: Msg[]): Promise<string>;
}

export class AkashUnattendedChain implements UnattendedChain {
  constructor(
    private readonly opts: { lcd: string; rpc: string; gasPrice: string },
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async grants(granter: string, grantee: string): Promise<GrantInfo[]> {
    const res = await this.fetchImpl(
      `${this.opts.lcd}/cosmos/authz/v1beta1/grants?granter=${granter}&grantee=${grantee}&pagination.limit=100`,
    );
    if (!res.ok) throw new Error(`authz grants query: HTTP ${res.status}`);
    const body = (await res.json()) as {
      grants?: { authorization?: { "@type"?: string; msg?: string }; expiration?: string | null }[];
    };
    return (body.grants ?? [])
      .filter((g) => g.authorization?.["@type"] === "/cosmos.authz.v1beta1.GenericAuthorization" && g.authorization.msg)
      .map((g) => ({ msgType: g.authorization!.msg!, expiration: g.expiration ?? null }));
  }

  async allowance(granter: string, grantee: string): Promise<AllowanceInfo | null> {
    const res = await this.fetchImpl(`${this.opts.lcd}/cosmos/feegrant/v1beta1/allowance/${granter}/${grantee}`);
    if (res.status === 404 || res.status === 500) return null; // "fee-grant not found"
    if (!res.ok) throw new Error(`fee allowance query: HTTP ${res.status}`);
    const body = (await res.json()) as {
      allowance?: { allowance?: { allowance?: { spend_limit?: { denom: string; amount: string }[]; expiration?: string | null } } };
    };
    const basic = body.allowance?.allowance?.allowance;
    return basic ? { spendLimit: basic.spend_limit ?? [], expiration: basic.expiration ?? null } : null;
  }

  async exec(mnemonic: string, granter: string, msgs: Msg[]): Promise<string> {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
    const [account] = await wallet.getAccounts();
    const grantee = account!.address;
    const client = await SigningStargateClient.connectWithSigner(this.opts.rpc, wallet, { registry: launcherRegistry() });
    const exec = toEncodeObject({ typeUrl: TypeUrl.Exec, value: { grantee, msgs } });
    const gas = Math.ceil((await client.simulate(grantee, [exec], "")) * 1.4);
    const fee = { ...calculateFee(gas, GasPrice.fromString(this.opts.gasPrice)), granter };
    const result = await client.signAndBroadcast(grantee, [exec], fee, "SparkDream launcher: unattended recovery");
    if (result.code !== 0) throw new Error(`tx failed (code ${result.code}): ${result.rawLog ?? ""}`);
    return result.transactionHash;
  }
}

// --- the launcher's key, one per owner wallet ---

const keyFile = (workRoot: string, owner: string) => {
  // the owner names a file: only an address shape, never a path (with wallet
  // auth off, it comes straight from the request's ?owner=)
  if (!/^akash1[a-z0-9]{1,90}$/.test(owner)) throw new Error(`not an Akash address: ${owner.slice(0, 64)}`);
  return path.join(workRoot, "secrets", `unattended-${owner}.mnemonic`);
};

export async function opsKey(workRoot: string, owner: string): Promise<{ mnemonic: string; address: string }> {
  const file = keyFile(workRoot, owner);
  let mnemonic: string;
  if (fs.existsSync(file)) {
    mnemonic = readSecretFile(file).trim();
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    mnemonic = (await DirectSecp256k1HdWallet.generate(24, { prefix: "akash" })).mnemonic;
    writeSecretFile(file, `${mnemonic}\n`);
  }
  const [account] = await (await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" })).getAccounts();
  return { mnemonic, address: account!.address };
}

// --- per-owner settings and the daily cap ---

export interface UnattendedSettings {
  /** sign auto-recovery ops' txs with the grant (off: they wait for Keplr like any other) */
  enabled: boolean;
  /** most a day's auto-recovery may put into new deployments' escrow, base units */
  dailyCap: { denom: string; amount: string };
}

const DEFAULT_SETTINGS: UnattendedSettings = { enabled: false, dailyCap: { denom: "uact", amount: "20000000" } };

export function unattendedSettings(db: ConductorDb, owner: string): UnattendedSettings {
  const raw = db.getSetting(`unattended:${owner}`);
  return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<UnattendedSettings>) } : DEFAULT_SETTINGS;
}

export function setUnattendedSettings(db: ConductorDb, owner: string, s: Partial<UnattendedSettings>): UnattendedSettings {
  const next = { ...unattendedSettings(db, owner), ...s };
  if (!/^\d+$/.test(next.dailyCap.amount)) throw new Error("the daily cap is a whole number of base units");
  db.setSetting(`unattended:${owner}`, JSON.stringify(next));
  return next;
}

interface SpendEntry {
  at: string;
  denom: string;
  amount: string;
  step: string;
}

function spendLog(db: ConductorDb, owner: string): SpendEntry[] {
  const raw = db.getSetting(`unattended-spend:${owner}`);
  return raw ? (JSON.parse(raw) as SpendEntry[]) : [];
}

/** Deposits signed unattended in the last 24 hours, in the cap's denom. */
export function spentToday(db: ConductorDb, owner: string, denom: string, now = Date.now()): bigint {
  return spendLog(db, owner)
    .filter((e) => e.denom === denom && now - Date.parse(e.at) < 86_400_000)
    .reduce((sum, e) => sum + BigInt(e.amount), 0n);
}

function recordSpend(db: ConductorDb, owner: string, entries: SpendEntry[], now = Date.now()): void {
  const kept = spendLog(db, owner).filter((e) => now - Date.parse(e.at) < 7 * 86_400_000);
  db.setSetting(`unattended-spend:${owner}`, JSON.stringify([...kept, ...entries]));
}

/** What a tx would put into escrow: create-deployment deposits. */
export function depositsOf(msgs: Msg[]): { denom: string; amount: bigint }[] {
  return msgs
    .filter((m) => m.typeUrl === TypeUrl.CreateDeployment)
    .map((m) => (m.value as { deposit?: { amount?: { denom: string; amount: string } } }).deposit?.amount)
    .filter((c): c is { denom: string; amount: string } => Boolean(c))
    .map((c) => ({ denom: c.denom, amount: BigInt(c.amount) }));
}

/** The msg's owner field, wherever its type keeps it. */
function msgOwner(m: Msg): string | undefined {
  const v = m.value as { id?: { owner?: string }; bidId?: { owner?: string } };
  return v.id?.owner ?? v.bidId?.owner;
}

/**
 * Why a pending tx may not be signed unattended, or null when it may. Pure
 * apart from the grant list, so the rules are testable on their own.
 */
export function unattendedBlocker(args: {
  owner: string;
  msgs: Msg[];
  settings: UnattendedSettings;
  grants: GrantInfo[];
  spent: bigint;
  now?: number;
}): string | null {
  const now = args.now ?? Date.now();
  if (!args.settings.enabled) return "unattended signing is off for this wallet";
  for (const m of args.msgs) {
    if (!(UNATTENDED_MSG_TYPES as readonly string[]).includes(m.typeUrl)) return `${m.typeUrl} is never signed unattended`;
    if (msgOwner(m) !== args.owner) return "a msg acts for another owner";
    const g = args.grants.find((x) => x.msgType === m.typeUrl);
    if (!g) return `no grant for ${m.typeUrl}`;
    if (g.expiration && Date.parse(g.expiration) <= now) return `the grant for ${m.typeUrl} expired`;
  }
  for (const d of depositsOf(args.msgs)) {
    if (d.denom !== args.settings.dailyCap.denom) return `a deposit in ${d.denom}, not the cap's ${args.settings.dailyCap.denom}`;
    if (args.spent + d.amount > BigInt(args.settings.dailyCap.amount)) {
      return `the daily cap (${args.settings.dailyCap.amount}${d.denom}) would be exceeded`;
    }
  }
  return null;
}

export { recordSpend };
