import fs from "node:fs";
import path from "node:path";
import { toBase64, fromBase64 } from "@cosmjs/encoding";
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { chainId, withDefaults, type LaunchSpec } from "@sparkdream/launch-spec";
import type { FleetComponentRow } from "./db.js";
import { AwaitUser, launchDirs, WALLET_SIGNER, type StepCtx, type WalletRequest } from "./engine.js";
import type { RpcProber } from "./services.js";
import { sparkdreamd } from "./exec.js";
import { queryJson, awaitTxIncluded } from "./steps/phase-g.js";
import { loadCertAt, nodeRpcUrl, type DeploymentPlan, type Assignments } from "./steps/phase-bcd.js";
import type { GenerateKeysOutput } from "./steps/phase-a.js";

/**
 * x/federation peer links (§5 peer-link): bring a peer to ACTIVE on one chain,
 * the way deploy/relayer/setup_peers.sh does by hand. Three stages, each
 * skipped when the chain already shows it done, so a link re-runs cheaply:
 *
 *   1. MsgRegisterPeer       one Operations Committee member signs; PENDING
 *   2. MsgUpdatePeerPolicy   one member signs; only when the policy was never
 *                            set (it is stored whole — re-writing it would
 *                            clobber an operator's later edits)
 *   3. MsgResumePeer         the committee POLICY: a proposal, the member's
 *                            vote, then execution once min_execution_period
 *                            has passed (x/commons accepts early on a
 *                            one-founder committee)
 *
 * The launcher signs as the chain's founder when it generated that key
 * (accounts.initial with council.founder and generate). Otherwise the wallet
 * holding it has to act: the step pauses with the exact messages written to a
 * file, and re-checks the chain on resume.
 */

export type PeerType = "PEER_TYPE_SPARK_DREAM" | "PEER_TYPE_ACTIVITYPUB";

/** One chain the launcher acts on. */
export interface ChainActor {
  chainId: string;
  /** CometBFT RPC reachable from the conductor. */
  rpc: string;
  gasDenom: string;
  gasPrice: number;
  /** Launcher-held founder key, or undefined when a wallet must sign. */
  signer?: { home: string; key: string; address: string };
  /** Where unsigned messages for a wallet to sign are written. */
  outDir: string;
  /** How a browser wallet reaches this chain (a launcher fleet with public
   *  endpoints). Without it, a pause can only offer the CLI route. */
  wallet?: WalletRequest["chain"];
  /** For messages: "this fleet's chain", "fleet sparkdreamtwo", ... */
  label: string;
  /** The chain's frontend (sparkdream-ui), when a launcher fleet runs one:
   *  its federation page can finish a peer's setup from prefilled links. */
  frontend?: string;
}

export interface PeerTarget {
  id: string;
  type: PeerType;
  displayName: string;
  ibcChannelId?: string;
  ibcTransferChannelId?: string;
  peerIdentity?: Record<string, unknown>;
  /** PeerPolicy JSON (proto field names), peer_id filled in by ensurePeerActive. */
  policy: Record<string, unknown>;
  /** Policy fields the spec owns: rewritten on a policy already set when
   *  they differ (the rest of the stored policy is kept as the committee
   *  left it). Without it a set policy is never touched. */
  syncPolicy?: string[];
  /** The peer chain's public REST API, for a frontend register link (the
   *  form fetches the peer's chain identity from it). */
  peerApi?: string;
}

/** A PeerPolicy field as the CLI prints it (zero values omitted, uint64 as
 *  strings), reduced to something comparable with the spec's value. */
function policyValue(key: string, v: unknown): string {
  if (key === "curation") {
    return v && typeof v === "object" ? String((v as { collection_id?: unknown }).collection_id ?? "0") : "";
  }
  if (Array.isArray(v) || v === undefined || v === null) return JSON.stringify(v ?? []);
  return JSON.stringify(v);
}

/** The synced fields whose stored value differs from the target's. */
export function policyDrift(current: Record<string, unknown> | undefined, target: PeerTarget): string[] {
  return (target.syncPolicy ?? []).filter((k) => policyValue(k, current?.[k]) !== policyValue(k, target.policy[k]));
}

export interface PeerStatus {
  chainId: string;
  peerId: string;
  status: string;
  ibcChannelId?: string;
}

/** Content a Spark Dream sister chain may send and receive; the same set
 *  deploy/relayer/setup_peers.sh writes. */
export const SPARK_DREAM_CONTENT_TYPES = ["blog_post", "blog_reply", "forum_thread", "forum_reply", "collection"];

export function sparkDreamPeerPolicy(): Record<string, unknown> {
  return {
    outbound_content_types: SPARK_DREAM_CONTENT_TYPES,
    inbound_content_types: SPARK_DREAM_CONTENT_TYPES,
    min_outbound_trust_level: 1,
    inbound_rate_limit_per_epoch: "100",
    outbound_rate_limit_per_epoch: "100",
    allow_reputation_queries: true,
    accept_reputation_attestations: true,
    require_review: false,
    blocked_identities: [],
    content_hosts: [],
  };
}

const TX_GAS = 400_000;
const EXEC_GAS = 2_000_000;
/** How long execution may be refused as "too early" before the step pauses:
 *  devnet/testnet min_execution_period is minutes; mainnet's is a day. */
const EXEC_RETRY_MS = 20 * 60_000;
const EXEC_RETRY_EVERY_MS = 15_000;

async function getPeer(chain: ChainActor, id: string): Promise<any | null> {
  try {
    const out = await queryJson(["query", "federation", "get-peer", id], chain.rpc);
    return out.peer ?? null;
  } catch (e) {
    if (/not found|NotFound|code = 5/i.test(String(e))) return null;
    throw e;
  }
}

function fee(chain: ChainActor, gas: number, min?: { denom: string; amount: bigint }): Array<{ denom: string; amount: string }> {
  let amount = BigInt(Math.ceil(chain.gasPrice * gas));
  if (min && min.denom === chain.gasDenom && min.amount > amount) amount = min.amount;
  return amount > 0n ? [{ denom: chain.gasDenom, amount: amount.toString() }] : [];
}

/** Sign (launcher-held key) and broadcast `msgs`; returns the included tx. */
export async function sendTx(
  ctx: StepCtx,
  chain: ChainActor,
  name: string,
  msgs: unknown[],
  opts: { gas?: number; minFee?: { denom: string; amount: bigint } } = {},
): Promise<any> {
  const signer = chain.signer!;
  const gas = opts.gas ?? TX_GAS;
  fs.mkdirSync(chain.outDir, { recursive: true });
  const unsigned = path.join(chain.outDir, `${name}.unsigned.json`);
  const signed = path.join(chain.outDir, `${name}.signed.json`);
  fs.writeFileSync(
    unsigned,
    JSON.stringify({
      body: { messages: msgs, memo: "sparkdream-launcher", timeout_height: "0", extension_options: [], non_critical_extension_options: [] },
      auth_info: { signer_infos: [], fee: { amount: fee(chain, gas, opts.minFee), gas_limit: String(gas), payer: "", granter: "" } },
      signatures: [],
    }),
  );
  await sparkdreamd([
    "tx", "sign", unsigned,
    "--from", signer.key, "--keyring-backend", "test", "--home", signer.home,
    "--chain-id", chain.chainId, "--node", chain.rpc, "--output-document", signed,
  ]);
  const { stdout } = await sparkdreamd(["tx", "broadcast", signed, "--node", chain.rpc, "--output", "json"]);
  const res = JSON.parse(stdout) as { txhash: string; code?: number; raw_log?: string };
  if (res.code) throw new Error(`${name} rejected at broadcast (code ${res.code}): ${res.raw_log ?? ""}`);
  await awaitTxIncluded(ctx, chain.rpc, res.txhash);
  return queryJson(["query", "tx", res.txhash], chain.rpc);
}

function eventAttr(tx: any, type: string, key: string): string | undefined {
  for (const ev of tx.events ?? []) {
    if (ev.type !== type) continue;
    for (const a of ev.attributes ?? []) if (a.key === key) return String(a.value).replace(/"/g, "");
  }
  return undefined;
}

/**
 * Proto-JSON messages → protobuf Anys, through the chain binary's own JSON
 * parser (`tx encode`): enums by name, nested messages and addresses come out
 * exactly as the chain reads them, which no client-side conversion of the
 * generated types matches (their amino decoders keep enum names as strings).
 */
async function encodeForWallet(msgs: unknown[], jsonFile: string): Promise<Array<{ typeUrl: string; value: string }>> {
  const txFile = jsonFile.replace(/\.json$/, "") + ".encode.json";
  fs.writeFileSync(
    txFile,
    JSON.stringify({
      body: { messages: msgs, memo: "", timeout_height: "0", extension_options: [], non_critical_extension_options: [] },
      auth_info: { signer_infos: [], fee: { amount: [], gas_limit: "0", payer: "", granter: "" } },
      signatures: [],
    }),
  );
  const { stdout } = await sparkdreamd(["tx", "encode", txFile]);
  const tx = decodeTxRaw(fromBase64(stdout.trim()));
  return tx.body.messages.map((m) => ({ typeUrl: m.typeUrl, value: toBase64(m.value) }));
}

/** Fee (gas × price, raised to a chain-enforced floor) as proto-JSON coins. */
function walletFee(chain: ChainActor, gas: number, minFee?: { denom: string; amount: bigint }): Array<{ denom: string; amount: string }> {
  let amount = BigInt(Math.ceil(chain.gasPrice * gas));
  if (minFee && minFee.denom === chain.gasDenom && minFee.amount > amount) amount = minFee.amount;
  return amount > 0n ? [{ denom: chain.gasDenom, amount: amount.toString() }] : [];
}

/**
 * A wallet has to act on `chain` (the launcher holds no key allowed to).
 * Writes the messages to a file, then pauses with a WalletRequest the web UI
 * signs in the user's wallet, plus the equivalent CLI commands for a key
 * kept elsewhere. Every WALLET_SIGNER in `msgs` becomes the signer's address.
 */
export async function walletPause(
  ctx: StepCtx,
  stepName: string,
  chain: ChainActor,
  what: string,
  msgs: unknown[],
  opts: {
    signerRole?: string;
    signer?: string;
    gas?: number;
    minFee?: { denom: string; amount: bigint };
    peerSetup?: PeerSetup;
  } = {},
): Promise<AwaitUser> {
  const signerRole = opts.signerRole ?? "an Operations Committee member";
  const gas = opts.gas ?? TX_GAS;
  fs.mkdirSync(chain.outDir, { recursive: true });
  const file = path.join(chain.outDir, `${chain.chainId}-${what.replace(/[^a-z0-9]+/gi, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ chain_id: chain.chainId, rpc: chain.rpc, messages: msgs }, null, 2));
  const fee = walletFee(chain, gas, opts.minFee);
  const rpc = chain.wallet?.rpc ?? chain.rpc;
  const cli = [
    `# sign as ${signerRole}; KEY is its name in your sparkdreamd keyring`,
    `F=${file}`,
    `KEY=<key name>; ADDR=$(sparkdreamd keys show "$KEY" -a)`,
    `jq --arg a "$ADDR" '{body:{messages:[.messages[] | walk(if . == "${WALLET_SIGNER}" then $a else . end)],` +
      `memo:"",timeout_height:"0",extension_options:[],non_critical_extension_options:[]},` +
      `auth_info:{signer_infos:[],fee:{amount:${JSON.stringify(fee)},gas_limit:"${gas}",payer:"",granter:""}},signatures:[]}' "$F" > /tmp/wallet.unsigned.json`,
    `sparkdreamd tx sign /tmp/wallet.unsigned.json --from "$KEY" --chain-id ${chain.chainId} --node ${rpc} --output-document /tmp/wallet.signed.json`,
    `sparkdreamd tx broadcast /tmp/wallet.signed.json --node ${rpc}`,
  ].join("\n");
  const title = `${what} on ${chain.label} (${chain.chainId})`;
  if (!chain.wallet) {
    return new AwaitUser(
      stepName,
      `${title} needs ${signerRole}'s signature — the launcher holds no key allowed to send it. ` +
        `Send the messages in ${file} (placeholder ${WALLET_SIGNER} = your address), then resume`,
      undefined,
      undefined,
      opts.peerSetup,
    );
  }
  const encoded = await encodeForWallet(msgs, file);
  return new AwaitUser(
    stepName,
    `${title} needs ${signerRole}'s signature — the launcher holds no key allowed to send it. ` +
      "Sign it with your wallet below, then the launcher carries on",
    {
      title: what.charAt(0).toUpperCase() + what.slice(1),
      chain: chain.wallet,
      signerRole,
      ...(opts.signer ? { signer: opts.signer } : {}),
      msgs,
      encoded,
      gas,
      ...(opts.minFee ? { minFee: { denom: opts.minFee.denom, amount: opts.minFee.amount.toString() } } : {}),
      cli,
    },
    undefined,
    opts.peerSetup,
  );
}

/**
 * A federation peer's remaining setup on a chain whose Operations Committee
 * key the launcher does not hold, as the pause card offers it: sign each
 * transaction here with Keplr (the pause's WalletRequest), run one script on
 * the computer that holds the key, or finish it in that chain's frontend.
 * Whichever is used, the launcher reads the chain when it resumes, and the
 * monitor resumes it by itself once the chain shows progress.
 */
export interface PeerSetup {
  chainId: string;
  chainLabel: string;
  peerId: string;
  /** What is left, in order, in plain words. */
  remaining: string[];
  /** Self-contained bash that finishes every remaining step on a computer
   *  whose sparkdreamd keyring holds a committee member's key. */
  script: string;
  /** That chain's frontend, prefilled, when a launcher fleet runs one. */
  links?: { register?: string; policy?: string; activate?: string };
  /** The register form's values, spelled out (for an older frontend whose
   *  form has no prefill, or anyone entering them by hand). */
  registerHint?: string;
  /** Values to enter where a link cannot prefill them (the policy form). */
  policyHint?: string;
  /** For the monitor: the chain's REST API and peerProgress at pause time. */
  rest?: string;
  progress: string;
  /** Resume no earlier than this (unix seconds): an accepted activation
   *  proposal's execution time. */
  resumeAt?: number;
}

/**
 * registered|policySet|status of a peer, the same whether read through the
 * CLI or the REST API, so the monitor can tell when a chain moved on.
 */
function progressOf(peer: any | null, policy: any | undefined): string {
  const registered = Boolean(peer) && peer.status !== "PEER_STATUS_REMOVED";
  const policySet =
    (policy?.inbound_content_types ?? []).length > 0 || (policy?.outbound_content_types ?? []).length > 0;
  return `${registered ? 1 : 0}|${policySet ? 1 : 0}|${registered ? String(peer.status) : "none"}`;
}

/** peerProgress through a chain's public REST API (the monitor's check);
 *  undefined when the API does not answer. */
export async function peerProgress(rpc: RpcProber, rest: string, peerId: string): Promise<string | undefined> {
  const base = rest.replace(/\/+$/, "");
  const read = async (route: string): Promise<any | null | undefined> => {
    try {
      return JSON.parse(await rpc.getText(`${base}${route}`));
    } catch (e) {
      // a peer that does not exist is an answer, not an outage
      return /404|not ?found/i.test(String(e)) ? null : undefined;
    }
  };
  const peer = await read(`/sparkdream/federation/v1/get_peer/${encodeURIComponent(peerId)}`);
  if (peer === undefined) return undefined;
  const policy = peer?.peer ? await read(`/sparkdream/federation/v1/get_peer_policy/${encodeURIComponent(peerId)}`) : null;
  if (policy === undefined) return undefined;
  return progressOf(peer?.peer ?? null, policy?.policy);
}

function registerMsg(target: PeerTarget, authority: string): Record<string, unknown> {
  return {
    "@type": "/sparkdream.federation.v1.MsgRegisterPeer",
    authority,
    peer_id: target.id,
    display_name: target.displayName,
    type: target.type,
    ibc_channel_id: target.ibcChannelId ?? "",
    metadata: "registered by the SparkDream launcher",
    controller_group: "",
    ...(target.peerIdentity ? { peer_identity: target.peerIdentity } : {}),
    ...(target.ibcTransferChannelId ? { ibc_transfer_channel_id: target.ibcTransferChannelId } : {}),
  };
}

function policyMsg(target: PeerTarget, current: any | undefined, authority: string): Record<string, unknown> {
  const policySet =
    (current?.inbound_content_types ?? []).length > 0 || (current?.outbound_content_types ?? []).length > 0;
  const drift = policySet ? policyDrift(current, target) : [];
  const policy: Record<string, unknown> = policySet
    ? { ...current, ...Object.fromEntries(drift.map((k) => [k, target.policy[k]])), peer_id: target.id }
    : { peer_id: target.id, ...target.policy };
  if (policy.curation === undefined || policy.curation === null) delete policy.curation;
  return { "@type": "/sparkdream.federation.v1.MsgUpdatePeerPolicy", authority, peer_id: target.id, policy };
}

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * The script for `stages` (in order) on `chain`. Messages are inline, so it
 * runs as is on another computer; only KEY needs editing. Proposal ids are
 * looked up on the chain, and execution retries until the committee's
 * minimum execution period has passed.
 */
function peerScript(
  chain: ChainActor,
  target: PeerTarget,
  stages: Array<"setup" | "policy" | "propose" | "vote" | "execute">,
  msgs: { setup?: unknown[]; policy?: unknown[]; propose?: unknown[] },
  committeePolicy: string | undefined,
  proposalFee: { denom: string; amount: bigint } | undefined,
  knownProposal?: string,
): string {
  const rpc = chain.wallet?.rpc ?? chain.rpc;
  const fee = (gas: number, min?: { denom: string; amount: bigint }) => JSON.stringify(walletFee(chain, gas, min));
  const lines = [
    "#!/usr/bin/env bash",
    `# Federation peer ${target.id} on ${chain.chainId}: run on the computer whose sparkdreamd keyring`,
    "# holds a Commons Operations Committee member's key. Needs sparkdreamd and jq.",
    "set -euo pipefail",
    'KEY="<key name>"   # the committee member\'s key in your keyring: edit this',
    `RPC=${shellQuote(rpc)}`,
    `CHAIN=${shellQuote(chain.chainId)}`,
    `PEER=${shellQuote(target.id)}`,
    'ADDR=$(sparkdreamd keys show "$KEY" -a)',
    "",
    "# sign and broadcast a JSON array of messages (\"<signer>\" becomes your address)",
    "send() {",
    `  jq --arg a "$ADDR" --argjson fee "$3" --arg gas "$2" '{body:{messages:[.[] | walk(if . == "${WALLET_SIGNER}" then $a else . end)],memo:"",timeout_height:"0",extension_options:[],non_critical_extension_options:[]},auth_info:{signer_infos:[],fee:{amount:$fee,gas_limit:$gas,payer:"",granter:""}},signatures:[]}' <<<"$1" > /tmp/peer.unsigned.json`,
    '  sparkdreamd tx sign /tmp/peer.unsigned.json --from "$KEY" --chain-id "$CHAIN" --node "$RPC" --output-document /tmp/peer.signed.json',
    '  sparkdreamd tx broadcast /tmp/peer.signed.json --node "$RPC" -o json | tee /tmp/peer.result.json | jq -e \'.code == 0\' >/dev/null',
    "  sleep 8   # let the block land before the next step reads it",
    "}",
  ];
  const n = (() => {
    let i = 0;
    return () => ++i;
  })();
  if (stages.includes("setup")) {
    lines.push("", `# ${n()}. register the peer and set its policy (one transaction)`);
    lines.push(`send ${shellQuote(JSON.stringify(msgs.setup))} 600000 ${shellQuote(fee(600_000))}`);
  }
  if (stages.includes("policy")) {
    lines.push("", `# ${n()}. set the peer's federation policy`);
    lines.push(`send ${shellQuote(JSON.stringify(msgs.policy))} ${TX_GAS} ${shellQuote(fee(TX_GAS))}`);
  }
  if (stages.includes("propose")) {
    lines.push("", `# ${n()}. propose activating it to the Operations Committee (carries the proposal fee)`);
    lines.push(`send ${shellQuote(JSON.stringify(msgs.propose))} ${TX_GAS} ${shellQuote(fee(TX_GAS, proposalFee))}`);
  }
  if (stages.includes("vote") || stages.includes("execute")) {
    if (knownProposal && !stages.includes("propose")) {
      lines.push("", `ID=${shellQuote(knownProposal)}`);
    } else {
      lines.push(
        "",
        "# the activation proposal's id",
        `ID=$(sparkdreamd query commons list-proposals --node "$RPC" -o json | jq -r --arg p "$PEER" --arg pol ${shellQuote(committeePolicy ?? "")} '[.proposals[] | select(.policy_address == $pol) | select([.messages[]? | (.value // .) | .peer_id] | index($p))] | sort_by(.id // "0" | tonumber) | last | .id // "0"')`,
      );
    }
  }
  if (stages.includes("vote")) {
    lines.push("", `# ${n()}. vote yes (each committee member who has not voted)`);
    lines.push(
      `send "[{\\"@type\\":\\"/sparkdream.commons.v1.MsgVoteProposal\\",\\"voter\\":\\"${WALLET_SIGNER}\\",\\"proposal_id\\":\\"$ID\\",\\"option\\":\\"VOTE_OPTION_YES\\",\\"metadata\\":\\"\\"}]" ${TX_GAS} ${shellQuote(fee(TX_GAS))}`,
    );
  }
  if (stages.includes("execute")) {
    lines.push(
      "",
      `# ${n()}. execute once the committee's minimum execution period has passed (retries every 30 s)`,
      'until [ "$(sparkdreamd query commons get-proposal "$ID" --node "$RPC" -o json | jq -r .proposal.status)" = "PROPOSAL_STATUS_EXECUTED" ]; do',
      `  send "[{\\"@type\\":\\"/sparkdream.commons.v1.MsgExecuteProposal\\",\\"executor\\":\\"${WALLET_SIGNER}\\",\\"proposal_id\\":\\"$ID\\"}]" ${EXEC_GAS} ${shellQuote(fee(EXEC_GAS))} || sleep 30`,
      "done",
      'echo "peer $PEER is active on $CHAIN"',
    );
  }
  return lines.join("\n");
}

/** Prefilled links into `chain`'s frontend for the peer's remaining setup. */
function peerLinks(
  chain: ChainActor,
  target: PeerTarget,
  stages: string[],
): PeerSetup["links"] | undefined {
  if (!chain.frontend) return undefined;
  const page = `${chain.frontend.replace(/\/+$/, "")}/federation`;
  const links: NonNullable<PeerSetup["links"]> = {};
  if (stages.includes("setup")) {
    const q = new URLSearchParams({ register: "1", peer_id: target.id, display_name: target.displayName });
    if (target.ibcChannelId) q.set("channel", target.ibcChannelId);
    if (target.ibcTransferChannelId) q.set("transfer_channel", target.ibcTransferChannelId);
    if (target.peerApi) q.set("peer_api", target.peerApi);
    if (target.peerIdentity) q.set("identity", Buffer.from(JSON.stringify(target.peerIdentity)).toString("base64url"));
    links.register = `${page}?${q}`;
  }
  if (stages.includes("setup") || stages.includes("policy")) links.policy = `${page}?policy=${encodeURIComponent(target.id)}`;
  if (stages.some((st) => st === "propose" || st === "vote" || st === "execute")) {
    links.activate = `${page}?activate=${encodeURIComponent(target.id)}`;
  }
  return links;
}

/**
 * ensurePeerActive for a chain the launcher holds no committee key for: read
 * where the peer stands, then pause once with everything left (the next
 * transaction for Keplr here, the whole remainder as a script, the frontend
 * links). Register and policy go out as one transaction, since a committee
 * member may sign both directly.
 */
async function ensurePeerByWallet(
  ctx: StepCtx,
  stepName: string,
  chain: ChainActor,
  target: PeerTarget,
): Promise<PeerStatus> {
  const peer = await getPeer(chain, target.id);
  const registered = Boolean(peer) && peer.status !== "PEER_STATUS_REMOVED";
  const current = registered
    ? ((await queryJson(["query", "federation", "get-peer-policy", target.id], chain.rpc).catch(() => ({}))) as any).policy
    : undefined;
  const policySet =
    (current?.inbound_content_types ?? []).length > 0 || (current?.outbound_content_types ?? []).length > 0;
  const drift = policySet ? policyDrift(current, target) : [];
  if (registered && target.ibcChannelId && peer.ibc_channel_id && peer.ibc_channel_id !== target.ibcChannelId) {
    ctx.log(
      `${chain.chainId}: peer ${target.id} is bound to ${peer.ibc_channel_id}, not the relayer's ` +
        `${target.ibcChannelId} — leaving it; packets on ${target.ibcChannelId} will not match this peer`,
    );
  }
  if (registered && peer.status === "PEER_STATUS_SUSPENDED") {
    throw new AwaitUser(
      stepName,
      `${chain.label} (${chain.chainId}): peer ${target.id} is SUSPENDED — the launcher does not overturn a ` +
        "suspension; resume it deliberately through the Operations Committee, then resume",
    );
  }
  const needPolicy = !policySet || drift.length > 0;
  if (registered && !needPolicy && peer.status === "PEER_STATUS_ACTIVE") {
    return { chainId: chain.chainId, peerId: target.id, status: peer.status, ...(peer.ibc_channel_id ? { ibcChannelId: peer.ibc_channel_id } : {}) };
  }

  // activation needs the committee's policy address and proposal fee, and
  // where an earlier proposal stands
  const group = await queryJson(["query", "commons", "get-group", "Commons Operations Committee"], chain.rpc);
  const committee: string | undefined = group.group?.policy_address;
  if (!committee) throw new Error(`${chain.chainId}: no Commons Operations Committee`);
  const params = await queryJson(["query", "commons", "params"], chain.rpc).catch(() => ({}));
  const m = /^(\d+)(.+)$/.exec(String((params as any).params?.proposal_fee ?? ""));
  const proposalFee = m ? { amount: BigInt(m[1]!), denom: m[2]! } : undefined;
  const found = registered ? await findActivation(chain, committee, target.id) : undefined;

  const setupMsgs = [registerMsg(target, WALLET_SIGNER), policyMsg(target, undefined, WALLET_SIGNER)];
  const policyMsgs = [policyMsg(target, current, WALLET_SIGNER)];
  const proposeMsgs = [
    {
      "@type": "/sparkdream.commons.v1.MsgSubmitProposal",
      proposer: WALLET_SIGNER,
      policy_address: committee,
      messages: [{ "@type": "/sparkdream.federation.v1.MsgResumePeer", authority: committee, peer_id: target.id }],
      metadata: `Activate federation peer ${target.id}`,
    },
  ];

  type Stage = "setup" | "policy" | "propose" | "vote" | "execute";
  const stages: Stage[] = [];
  if (!registered) stages.push("setup", "propose", "vote", "execute");
  else {
    if (needPolicy) stages.push("policy");
    if (peer.status !== "PEER_STATUS_ACTIVE") {
      const s = found?.status ?? "";
      if (!found) stages.push("propose", "vote", "execute");
      else if (/SUBMITTED|VOTING/.test(s)) stages.push("vote", "execute");
      else if (/ACCEPTED/.test(s)) stages.push("execute");
      else if (!/EXECUTED/.test(s)) throw new Error(`${chain.chainId}: activation proposal ${found.id} for peer ${target.id} is ${s}`);
    }
  }
  const words: Record<Stage, string> = {
    setup: `register ${target.id} as a ${peerKind(target.type)} peer and set its federation policy`,
    policy: needPolicy && policySet ? `update ${drift.join(", ")} in the policy for peer ${target.id}` : `set the federation policy for peer ${target.id}`,
    propose: `propose activating peer ${target.id} to the Operations Committee`,
    vote: `vote yes on the activation${found ? ` (proposal ${found.id})` : ""}`,
    execute: "execute the activation once its minimum execution period has passed",
  };
  const contentTypes = (target.policy.inbound_content_types as string[] | undefined) ?? [];
  const setup: PeerSetup = {
    chainId: chain.chainId,
    chainLabel: chain.label,
    peerId: target.id,
    remaining: stages.map((st) => words[st]),
    script: peerScript(chain, target, stages, { setup: setupMsgs, policy: policyMsgs, propose: proposeMsgs }, committee, proposalFee, found?.id),
    progress: progressOf(registered ? peer : null, current),
    ...(chain.wallet?.rest ? { rest: chain.wallet.rest } : {}),
    ...(peerLinks(chain, target, stages) ? { links: peerLinks(chain, target, stages)! } : {}),
    ...(stages.includes("setup")
      ? {
          registerHint: [
            `peer id ${target.id}`,
            `type Spark Dream`,
            ...(target.ibcChannelId ? [`IBC channel ${target.ibcChannelId} (this chain's end of the federation channel to ${target.id})`] : []),
            ...(target.ibcTransferChannelId ? [`transfer channel ${target.ibcTransferChannelId}`] : []),
            ...(target.peerApi ? [`peer chain API ${target.peerApi}`] : []),
          ].join(", "),
        }
      : {}),
    ...(contentTypes.length
      ? {
          policyHint:
            `content types ${contentTypes.join(", ")} both ways, ${String(target.policy.inbound_rate_limit_per_epoch ?? "100")} ` +
            "per epoch each way, reputation queries and attestations on",
        }
      : {}),
  };

  // the next transaction, for Keplr here
  const first = stages[0];
  if (first === "setup") {
    throw await walletPause(ctx, stepName, chain, words.setup, setupMsgs, { gas: 600_000, peerSetup: setup });
  }
  if (first === "policy") {
    throw await walletPause(ctx, stepName, chain, words.policy, policyMsgs, { peerSetup: setup });
  }
  if (first === "propose") {
    throw await walletPause(ctx, stepName, chain, words.propose, proposeMsgs, {
      ...(proposalFee ? { minFee: proposalFee } : {}),
      peerSetup: setup,
    });
  }
  if (first === "vote") {
    throw await walletPause(
      ctx,
      stepName,
      chain,
      `vote yes on proposal ${found!.id} activating peer ${target.id} (each committee member who has not voted signs this)`,
      [{ "@type": "/sparkdream.commons.v1.MsgVoteProposal", voter: WALLET_SIGNER, proposal_id: found!.id, option: "VOTE_OPTION_YES", metadata: "" }],
      { peerSetup: setup },
    );
  }
  if (first === "execute") {
    const now = Math.floor(Date.now() / 1000);
    if (found!.executionTime > now) {
      throw new AwaitUser(
        stepName,
        `${chain.chainId}: proposal ${found!.id} activating peer ${target.id} is accepted and can be executed from ` +
          `${new Date(found!.executionTime * 1000).toISOString()} (about ${Math.ceil((found!.executionTime - now) / 60)} min); ` +
          "the launcher resumes then by itself",
        undefined,
        undefined,
        { ...setup, resumeAt: found!.executionTime },
      );
    }
    throw await walletPause(
      ctx,
      stepName,
      chain,
      `execute proposal ${found!.id} activating peer ${target.id}`,
      [{ "@type": "/sparkdream.commons.v1.MsgExecuteProposal", executor: WALLET_SIGNER, proposal_id: found!.id }],
      { gas: EXEC_GAS, peerSetup: setup },
    );
  }
  // registered, policy set, activation executed: read the peer once more
  const after = await getPeer(chain, target.id);
  if (after?.status !== "PEER_STATUS_ACTIVE") {
    throw new Error(`${chain.chainId}: peer ${target.id} is ${after?.status ?? "missing"} after activation`);
  }
  return { chainId: chain.chainId, peerId: target.id, status: after.status, ...(after.ibc_channel_id ? { ibcChannelId: after.ibc_channel_id } : {}) };
}

/**
 * Bring `target` to ACTIVE as a peer on `chain`. Idempotent; see the module
 * comment for the stages. Returns the peer's final status.
 */
export async function ensurePeerActive(
  ctx: StepCtx,
  stepName: string,
  chain: ChainActor,
  target: PeerTarget,
): Promise<PeerStatus> {
  const tag = `${chain.chainId}:${target.id}`.replace(/[^a-z0-9.-]+/gi, "_");
  if (!chain.signer) return ensurePeerByWallet(ctx, stepName, chain, target);
  let peer = await getPeer(chain, target.id);

  // 1. register
  if (!peer || peer.status === "PEER_STATUS_REMOVED") {
    const register = (authority: string) => ({
      "@type": "/sparkdream.federation.v1.MsgRegisterPeer",
      authority,
      peer_id: target.id,
      display_name: target.displayName,
      type: target.type,
      ibc_channel_id: target.ibcChannelId ?? "",
      metadata: "registered by the SparkDream launcher",
      controller_group: "",
      ...(target.peerIdentity ? { peer_identity: target.peerIdentity } : {}),
      ...(target.ibcTransferChannelId ? { ibc_transfer_channel_id: target.ibcTransferChannelId } : {}),
    });
    await sendTx(ctx, chain, `${tag}-register`, [register(chain.signer.address)]);
    ctx.log(`${chain.chainId}: registered peer ${target.id} (PENDING)`);
    peer = await getPeer(chain, target.id);
    if (!peer) throw new Error(`${chain.chainId}: peer ${target.id} missing right after registration`);
  } else if (target.ibcChannelId && peer.ibc_channel_id && peer.ibc_channel_id !== target.ibcChannelId) {
    // rebinding is remove + re-register, a governance decision this step does not take
    ctx.log(
      `${chain.chainId}: peer ${target.id} is bound to ${peer.ibc_channel_id}, not the relayer's ` +
        `${target.ibcChannelId} — leaving it; packets on ${target.ibcChannelId} will not match this peer`,
    );
  }

  // 2. policy, when never set (an empty default policy federates nothing)
  const current = (await queryJson(["query", "federation", "get-peer-policy", target.id], chain.rpc).catch(() => ({}))) as any;
  const policySet = (current.policy?.inbound_content_types ?? []).length > 0 || (current.policy?.outbound_content_types ?? []).length > 0;
  const drift = policySet ? policyDrift(current.policy, target) : [];
  if (!policySet || drift.length > 0) {
    // the policy is stored whole: a sync carries the rest of it over
    const policy = policySet
      ? { ...current.policy, ...Object.fromEntries(drift.map((k) => [k, target.policy[k]])), peer_id: target.id }
      : { peer_id: target.id, ...target.policy };
    if (policy.curation === undefined || policy.curation === null) delete policy.curation;
    const update = (authority: string) => ({
      "@type": "/sparkdream.federation.v1.MsgUpdatePeerPolicy",
      authority,
      peer_id: target.id,
      policy,
    });
    const what = policySet ? `update ${drift.join(", ")} in the federation policy for peer ${target.id}` : `set the federation policy for peer ${target.id}`;
    await sendTx(ctx, chain, `${tag}-policy${policySet ? "-sync" : ""}`, [update(chain.signer.address)]);
    ctx.log(`${chain.chainId}: peer ${target.id} policy ${policySet ? `updated (${drift.join(", ")})` : "set"}`);
  }

  // 3. activation by the Operations Committee policy
  if (peer.status === "PEER_STATUS_SUSPENDED") {
    throw new AwaitUser(
      stepName,
      `${chain.label} (${chain.chainId}): peer ${target.id} is SUSPENDED — the launcher does not overturn a ` +
        "suspension; resume it deliberately through the Operations Committee, then resume",
    );
  }
  if (peer.status !== "PEER_STATUS_ACTIVE") {
    await activate(ctx, stepName, chain, target.id, tag);
    peer = await getPeer(chain, target.id);
  }
  if (peer?.status !== "PEER_STATUS_ACTIVE") {
    throw new Error(`${chain.chainId}: peer ${target.id} is ${peer?.status ?? "missing"} after activation`);
  }
  return { chainId: chain.chainId, peerId: target.id, status: peer.status, ...(peer.ibc_channel_id ? { ibcChannelId: peer.ibc_channel_id } : {}) };
}

async function activate(ctx: StepCtx, stepName: string, chain: ChainActor, peerId: string, tag: string): Promise<void> {
  const group = await queryJson(["query", "commons", "get-group", "Commons Operations Committee"], chain.rpc);
  const policy: string | undefined = group.group?.policy_address;
  if (!policy) throw new Error(`${chain.chainId}: no Commons Operations Committee`);
  const resume = { "@type": "/sparkdream.federation.v1.MsgResumePeer", authority: policy, peer_id: peerId };
  const submit = (proposer: string) => ({
    "@type": "/sparkdream.commons.v1.MsgSubmitProposal",
    proposer,
    policy_address: policy,
    messages: [resume],
    metadata: `Activate federation peer ${peerId}`,
  });
  const params = await queryJson(["query", "commons", "params"], chain.rpc);
  const m = /^(\d+)(.+)$/.exec(String(params.params?.proposal_fee ?? ""));
  const minFee = m ? { amount: BigInt(m[1]!), denom: m[2]! } : undefined;
  const signer = chain.signer;
  // a chain without a launcher-held key takes ensurePeerByWallet's route
  if (!signer) throw new Error(`${chain.chainId}: no launcher-held committee key to activate peer ${peerId} with`);

  // one proposal per activation, remembered across pauses and restarts
  const pin = path.join(chain.outDir, `${tag}-activation.proposal`);
  let id = fs.existsSync(pin) ? fs.readFileSync(pin, "utf8").trim() : "";
  const statusOf = async () =>
    (await queryJson(["query", "commons", "get-proposal", id], chain.rpc)).proposal?.status as string | undefined;
  if (id) {
    const s = await statusOf().catch(() => undefined);
    // a proposal that failed or expired cannot activate anything: start over
    if (!s || /REJECTED|FAILED|EXPIRED|ABORTED|WITHDRAWN/.test(s)) id = "";
  }
  if (!id) {
    const tx = await sendTx(ctx, chain, `${tag}-propose`, [submit(signer.address)], minFee ? { minFee } : {});
    id = eventAttr(tx, "submit_proposal", "proposal_id") ?? "";
    if (!id) throw new Error(`${chain.chainId}: submitted the activation proposal but found no proposal_id event`);
    fs.writeFileSync(pin, id);
    ctx.log(`${chain.chainId}: activation proposal ${id} for peer ${peerId}`);
  }

  if (/SUBMITTED|VOTING/.test((await statusOf()) ?? "")) {
    await sendTx(ctx, chain, `${tag}-vote-${id}`, [
      { "@type": "/sparkdream.commons.v1.MsgVoteProposal", voter: signer.address, proposal_id: id, option: "VOTE_OPTION_YES", metadata: "" },
    ]).catch((e) => ctx.log(`${chain.chainId}: vote on ${id}: ${String(e).slice(0, 200)}`));
  }

  // execute once accepted and past min_execution_period
  const deadline = Date.now() + EXEC_RETRY_MS;
  for (;;) {
    const s = (await statusOf()) ?? "";
    if (/EXECUTED/.test(s)) return;
    if (/SUBMITTED|VOTING/.test(s)) {
      throw new AwaitUser(
        stepName,
        `${chain.chainId}: activation proposal ${id} for peer ${peerId} still needs votes from other ` +
          "Operations Committee members — resume once it is accepted",
      );
    }
    if (/ACCEPTED/.test(s)) {
      try {
        await sendTx(ctx, chain, `${tag}-execute-${id}`, [
          { "@type": "/sparkdream.commons.v1.MsgExecuteProposal", executor: signer.address, proposal_id: id },
        ], { gas: EXEC_GAS });
        continue;
      } catch (e) {
        ctx.log(`${chain.chainId}: executing proposal ${id} not yet possible: ${String(e).slice(0, 160)}`);
      }
    } else if (!/EXECUTED/.test(s)) {
      throw new Error(`${chain.chainId}: activation proposal ${id} ended ${s || "in an unknown state"}`);
    }
    if (Date.now() > deadline) {
      throw new AwaitUser(
        stepName,
        `${chain.chainId}: activation proposal ${id} is accepted but cannot execute yet (min_execution_period) — resume later`,
      );
    }
    await ctx.services.sleep(EXEC_RETRY_EVERY_MS);
  }
}

function peerKind(type: PeerType): string {
  return type === "PEER_TYPE_ACTIVITYPUB" ? "ActivityPub" : "Spark Dream";
}

/** The newest proposal of `policy` that activates `peerId` and has not
 *  failed, as the chain reports it. */
async function findActivation(
  chain: ChainActor,
  policy: string,
  peerId: string,
): Promise<{ id: string; status: string; executionTime: number } | undefined> {
  const out = await queryJson(["query", "commons", "list-proposals"], chain.rpc).catch(() => ({ proposals: [] }));
  // the query renders a nested message as {type, value: {...fields}}; accept
  // the proto-JSON {"@type", ...fields} shape too
  const resumes = (msg: any): boolean => {
    const type = msg?.["@type"] ?? msg?.type;
    const fields = msg?.value && typeof msg.value === "object" ? msg.value : msg;
    return type === "/sparkdream.federation.v1.MsgResumePeer" && fields?.peer_id === peerId;
  };
  const matches = ((out.proposals ?? []) as any[])
    // proto3 JSON drops a zero id: proposal 0 arrives without one
    .map((p) => ({ ...p, id: String(p.id ?? "0") }))
    .filter(
      (p) =>
        p.policy_address === policy &&
        !/REJECTED|FAILED|EXPIRED|ABORTED|WITHDRAWN/.test(String(p.status)) &&
        (p.messages ?? []).some(resumes),
    );
  const latest = matches.sort((a, b) => Number(b.id) - Number(a.id))[0];
  return latest
    ? { id: latest.id, status: String(latest.status), executionTime: Number(latest.execution_time ?? 0) }
    : undefined;
}

/**
 * Activation when a wallet signs (no launcher-held committee key): each
 * resume reads the proposal's state on chain and asks for the one signature
 * that moves it on: submit, vote, or execute once executable.
 */

// ---------------------------------------------------------------------------
// Actors for launcher fleets

/** The founder account the launcher generated (it holds the key), if any. */
export function founderAccount(spec: LaunchSpec): string | undefined {
  const founder = spec.accounts.initial.find(
    (a) => a.generate && typeof a.council === "object" && a.council.founder,
  );
  return founder ? `acct-${founder.name}` : undefined;
}

/** CometBFT RPC of a fleet's sentry, reachable from the conductor. */
export async function fleetRpc(ctx: StepCtx, launchId: string): Promise<string> {
  const rows = ctx.db.listFleetComponents(launchId) as FleetComponentRow[];
  const sentry = rows.find((c) => c.key.startsWith("sentry-") && c.state === "active");
  // another fleet's lease answers only to that fleet's certificate: its
  // wallet may not be this one (a sister chain shared with this wallet;
  // seen live 2026-10-02 as "provider GET /lease/.../status: HTTP 404")
  if (sentry) {
    const cert = launchId === ctx.launchId ? undefined : loadCertAt(launchDirs(ctx.workRoot, launchId).secrets);
    return cert ? nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq, 1, 1, cert) : nodeRpcUrl(ctx, sentry.host_uri, sentry.dseq);
  }
  if (launchId === ctx.launchId) {
    // during the launch itself the fleet rows are not materialized yet
    const a = ctx.output<Assignments>("collect-bids")?.perNode["sentry-0"];
    const plan = ctx.output<DeploymentPlan>("create-deployments");
    if (a && plan) return nodeRpcUrl(ctx, a.hostUri, plan.perNode["sentry-0"]!.dseq, a.gseq, a.oseq);
  }
  throw new Error(`fleet ${launchId} has no active sentry to reach its chain through`);
}

/** How the launcher acts on a fleet's chain (this one or another). */
export async function fleetActor(ctx: StepCtx, launchId: string, label: string): Promise<ChainActor> {
  const launch = ctx.db.getLaunch(launchId);
  if (!launch) throw new Error(`fleet ${launchId} is gone from this launcher`);
  const spec = launchId === ctx.launchId ? ctx.spec : withDefaults(JSON.parse(launch.spec_json));
  const key = founderAccount(spec);
  const keys = ctx.db.stepOutput<GenerateKeysOutput>(launchId, "generate-keys");
  const address = key ? keys?.accounts[key] : undefined;
  return {
    chainId: chainId(spec),
    rpc: await fleetRpc(ctx, launchId),
    gasDenom: spec.token.baseDenom,
    gasPrice: Number(spec.token.minGasPrice),
    ...(key && address ? { signer: { home: launchDirs(ctx.workRoot, launchId).node("val-0"), key, address } } : {}),
    outDir: path.join(ctx.dirs.root, "peering"),
    label,
    ...(spec.topology.publicEndpoints?.rpc ? { wallet: walletChain(spec) } : {}),
    ...(spec.topology.components.frontend?.enabled && spec.topology.components.frontend.domain
      ? { frontend: `https://${spec.topology.components.frontend.domain}` }
      : {}),
  };
}

/** How a browser wallet reaches a fleet's chain: its public endpoints. */
export function walletChain(spec: LaunchSpec): WalletRequest["chain"] {
  const pub = spec.topology.publicEndpoints!;
  return {
    chainId: chainId(spec),
    chainName: spec.network.displayName ?? spec.network.name,
    rpc: `https://${pub.rpc}`,
    ...(pub.api ? { rest: `https://${pub.api}` } : {}),
    bech32Prefix: spec.network.bech32Prefix,
    denom: spec.token.baseDenom,
    displayDenom: spec.token.displayDenom,
    decimals: spec.token.exponent ?? 6,
    gasPrice: Number(spec.token.minGasPrice),
  };
}

/** A chain's identity (x/identity), as MsgRegisterPeer.peer_identity wants it. */
export async function chainIdentity(rpc: string): Promise<Record<string, unknown> | undefined> {
  try {
    const out = await queryJson(["query", "identity", "chain-identity"], rpc);
    return out.identity ?? undefined;
  } catch {
    return undefined; // a chain without x/identity: register without it
  }
}
