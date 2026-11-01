import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A stand-in `sparkdreamd` for the chain-side steps (peer links): answers the
 * federation/commons/identity queries and applies broadcast txs to a JSON
 * state kept per chain, keyed by --node. Enough of x/federation and x/commons
 * to walk a peer from nothing to ACTIVE: register → PENDING, policy, proposal
 * (VOTING → ACCEPTED on a yes vote → EXECUTED, running MsgResumePeer).
 *
 * Point SPARKDREAMD_BIN at `bin`. Knobs live in the state file:
 *   earlyExecutions  executions refused as "too early" before one succeeds
 *   aliases          --node URL -> the chain key it reaches (a moved RPC)
 */
export interface ChainStub {
  bin: string;
  /** The network whose real build (SPARKDREAMD_BIN_<NETWORK>) takes the
   *  commands the stub does not model: since v1.0.56 another network's
   *  build refuses this network's genesis. */
  network: "devnet" | "testnet" | "mainnet";
  dir: string;
  state(): StubState;
  edit(fn: (s: StubState) => void): void;
}

export interface StubChain {
  bindings?: Record<string, Record<string, unknown>>;
  roles?: Record<string, { current_bond: string; signer?: string }>;
  /** x/session grants, keyed "<granter>/<grantee>". */
  sessions?: Record<string, Record<string, any>>;
  /** x/artifact classes, in creation order (the game's). */
  classes?: Array<{ id: string; owner: string; symbol: string; name: string; signer?: string }>;
  peers: Record<string, Record<string, unknown>>;
  policies: Record<string, Record<string, unknown>>;
  proposals: Record<string, { status: string; messages: any[]; policy_address?: string; execution_time?: number }>;
  identity: Record<string, unknown>;
}

export interface StubState {
  chains: Record<string, StubChain>;
  txs: Record<string, { code: number; events: unknown[] }>;
  /** Every broadcast: node, the key that signed it, message types. */
  log: Array<{ node: string; from: string; types: string[] }>;
  earlyExecutions: number;
  aliases?: Record<string, string>;
  /** address -> denom -> amount, for `query bank balances`. */
  balances?: Record<string, Record<string, string>>;
  /** What an address missing from `balances` holds (genesis funding the
   *  stub cannot see); nothing when unset. */
  defaultBalances?: Record<string, string>;
  /** MsgBondRole fails as if the member lacked the DREAM. */
  dreamShort?: boolean;
  /** x/rep members by address, for `query rep get-member` (NotFound otherwise).
   *  MsgAcceptInvitation adds one; a bridge operator must be one (v1.0.56). */
  members?: Record<string, { trust_level?: string; dream_balance?: string; staked_dream?: string; status?: string }>;
  /** x/rep invitations, by id as the chain numbers them. */
  invitations?: Record<string, { id: string; inviter: string; invitee_address: string; staked_dream: string; status?: string; signer?: string }>;
  /** x/session narrow_session_max_expiration as the CLI prints it (default
   *  30 days): the ceiling for the launcher's keys, which are all narrow.
   *  max_expiration (broad keys) stays at 7 days. */
  sessionMaxExpiration?: string;
  /** `query artifact classes-by-owner` fails as sparkdreamd v1.0.55 did:
   *  the chain answers, the CLI cannot print it. */
  classesUnprintable?: boolean;
}

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("fs");
const dir = __dirname;
const file = dir + "/state.json";
const st = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const rawNode = flag("--node") || "local";
// a chain's state does not move when its RPC does (a relaunched sentry has a
// new address): aliases map a new --node onto an existing chain
const node = (st.aliases || {})[rawNode] || rawNode;
const chain = (st.chains[node] ||= { peers: {}, policies: {}, proposals: {},
  identity: { bond_denom: "uspk." + node.replace(/[^a-z0-9]/gi, "").slice(-6), bond_display_symbol: "SPK", bond_display_name: "Spark", bond_display_decimals: 6 } });
const out = (o) => { save(); process.stdout.write(JSON.stringify(o)); process.exit(0); };
const fail = (m) => { save(); process.stderr.write(m); process.exit(1); };
const [a0, a1, a2, a3] = args;

if (a0 === "query" && a1 === "federation" && a2 === "get-peer") {
  const p = chain.peers[a3]; if (!p) fail("rpc error: code = NotFound desc = peer not found"); out({ peer: p });
}
if (a0 === "query" && a1 === "federation" && a2 === "get-peer-policy") out({ policy: chain.policies[a3] || { peer_id: a3 } });
if (a0 === "query" && a1 === "identity") out({ identity: chain.identity });
if (a0 === "query" && a1 === "commons" && a2 === "get-group") out({ group: { index: a3, policy_address: "sprkdrm1opspolicy" } });
if (a0 === "query" && a1 === "commons" && a2 === "params") out({ params: { proposal_fee: "5000000uspark" } });
if (a0 === "query" && a1 === "commons" && a2 === "list-proposals") {
  // as the chain renders it: nested messages as {type, value}, and proto3
  // JSON dropping a zero id
  out({ proposals: Object.entries(chain.proposals).map(([id, p]) => ({ ...(id === "0" ? {} : { id }), status: p.status,
    policy_address: p.policy_address || "sprkdrm1opspolicy",
    messages: p.messages.map((m) => { const { "@type": type, ...value } = m; return { type, value }; }),
    execution_time: String(p.execution_time || 0) })) });
}
if (a0 === "query" && a1 === "commons" && a2 === "get-proposal") {
  const p = chain.proposals[a3]; if (!p) fail("proposal not found"); out({ proposal: { id: a3, status: p.status } });
}
if (a0 === "query" && a1 === "tx") { const t = st.txs[a2]; if (!t) fail("tx not found"); out(t); }
// the stub tracks no bonds: everything held is spendable
if (a0 === "query" && a1 === "bank" && (a2 === "balances" || a2 === "spendable-balances")) {
  const held = (st.balances || {})[a3] || st.defaultBalances || {};
  out({ balances: Object.entries(held).map(([denom, amount]) => ({ denom, amount })) });
}
if (a0 === "query" && a1 === "rep" && a2 === "bonded-role") {
  const b = (chain.roles || {})[a3 + "/" + args[4]]; if (!b) fail("rpc error: code = NotFound desc = no bonded role"); out({ bonded_role: b });
}
if (a0 === "query" && a1 === "rep" && a2 === "get-member") {
  const m = (st.members || {})[a3]; if (!m) fail("rpc error: code = NotFound desc = member not found"); out({ member: { address: a3, ...m } });
}
if (a0 === "query" && a1 === "rep" && a2 === "params") out({ params: { min_invitation_stake: "100000000" } });
if (a0 === "query" && a1 === "rep" && a2 === "required-invitation-stake") out({ required_stake: "100000000", base_stake: "100000000" });
if (a0 === "query" && a1 === "rep" && a2 === "list-invitation") {
  // proto3 JSON drops the zero status (PENDING)
  out({ invitation: Object.values(st.invitations || {}).reverse().map(({ signer, ...i }) => i) });
}
if (a0 === "query" && a1 === "service" && a2 === "service-type") out({ config: { service_type: a3, min_bond_amount: "1000000000" } });
if (a0 === "query" && a1 === "artifact" && a2 === "classes-by-owner") {
  if (st.classesUnprintable) fail("cannot marshal response classes:{...}: not supported: dont_omit_empty=true on invalid (nil?) message field: expiry");
  out({ classes: (chain.classes || []).filter((c) => c.owner === a3).map((c) => ({ class: c })) });
}
if (a0 === "query" && a1 === "session" && a2 === "grants-by-grantee") {
  out({ grants: Object.values(chain.grants || {}).filter((g) => g.grantee === a3) });
}
if (a0 === "query" && a1 === "service" && a2 === "operator") {
  const o = (chain.operators || {})[a3 + "/" + args[4]]; if (!o) fail("rpc error: code = NotFound desc = operator not found"); out({ operator: o });
}
if (a0 === "query" && a1 === "federation" && a2 === "get-bridge-binding") {
  const b = (chain.bindings || {})[a3 + "/" + args[4]]; if (!b) fail("rpc error: code = NotFound desc = binding not found"); out({ binding: b });
}
const sessionMaxMs = () => { let ms = 0;
  for (const [, n, u] of (st.sessionMaxExpiration || "720h0m0s").matchAll(/([0-9.]+)(h|m|s)/g)) ms += Number(n) * { h: 3600000, m: 60000, s: 1000 }[u];
  return ms; };
if (a0 === "query" && a1 === "session" && a2 === "session") {
  const g = (chain.sessions || {})[a3 + "/" + args[4]];
  if (!g) fail("rpc error: code = Unknown desc = no active session for (granter, grantee) pair: unknown request");
  out({ session: g });
}
if (a0 === "query" && a1 === "session" && a2 === "params") {
  out({ params: { max_expiration: "168h0m0s", narrow_session_max_expiration: st.sessionMaxExpiration || "720h0m0s", max_spend_limit_amount: "100000000", max_exec_count: "10000" } });
}
if (a0 === "tx" && a1 === "sign") {
  const doc = JSON.parse(fs.readFileSync(a2, "utf8"));
  doc.__from = flag("--from");
  fs.writeFileSync(flag("--output-document"), JSON.stringify(doc));
  out({});
}
if (a0 === "tx" && a1 === "broadcast") {
  const doc = JSON.parse(fs.readFileSync(a2, "utf8"));
  const msgs = doc.body.messages;
  const hash = "H" + (Object.keys(st.txs).length + 1);
  const events = [];
  st.log.push({ node, from: doc.__from, types: msgs.map((m) => m["@type"]) });
  const run = (m) => {
    const t = m["@type"].split(".").pop();
    if (t === "MsgRegisterPeer") {
      chain.peers[m.peer_id] = { id: m.peer_id, type: m.type, status: "PEER_STATUS_PENDING",
        ibc_channel_id: m.ibc_channel_id, ibc_transfer_channel_id: m.ibc_transfer_channel_id || "",
        peer_identity: m.peer_identity };
    } else if (t === "MsgRegisterBridge") {
      const p = chain.peers[m.peer_id];
      if (!p || p.status !== "PEER_STATUS_ACTIVE") throw new Error("peer not active");
      const op = (st.members || {})[m.operator];
      if (!op || (op.status && op.status !== "MEMBER_STATUS_ACTIVE")) throw new Error("bridge operator must be an active x/rep member");
      chain.bindings ||= {};
      chain.bindings[m.operator + "/" + m.peer_id] = { operator: m.operator, peer_id: m.peer_id, endpoint: m.endpoint, stake: m.stake_amount, signer: doc.__from };
    } else if (t === "MsgRegisterOperator") {
      chain.operators ||= {};
      const k = m.creator + "/" + m.service_type;
      if (chain.operators[k]) throw new Error("operator already registered");
      chain.operators[k] = { address: m.creator, service_type: m.service_type, controller: m.controller,
        bond_amount: m.bond_amount, metadata: m.metadata, status: "OPERATOR_STATUS_ACTIVE", signer: doc.__from };
    } else if (t === "MsgClaimRecurringPull") {
      const g = (chain.grants || {})[m.grant_id];
      if (!g || g.grantee !== m.grantee) throw new Error("grant not found");
      if (g.refuse) throw new Error(g.refuse);
      const rp = g.recurring_pull;
      const next = Number(rp.last_claim_advance) + Number(rp.period_seconds);
      if (next > Date.now() / 1000) throw new Error("next claim not yet eligible");
      rp.last_claim_advance = String(next);
      rp.claims_made = String(Number(rp.claims_made || 0) + 1);
      st.balances ||= {};
      const to = (st.balances[m.grantee] ||= {});
      const c = rp.amount_per_period;
      to[c.denom] = String(BigInt(to[c.denom] || "0") + BigInt(c.amount));
    } else if (t === "MsgUpdateMetadata") {
      const o = (chain.operators || {})[m.operator + "/" + m.service_type];
      if (!o) throw new Error("operator not found");
      o.metadata = m.new_metadata;
    } else if (t === "MsgBondRole") {
      if (st.dreamShort) throw new Error("insufficient DREAM balance to bond");
      const role = m.role_type === "ROLE_TYPE_FEDERATION_VERIFIER" ? "federation-verifier" : m.role_type;
      chain.roles ||= {};
      const prev = chain.roles[role + "/" + m.creator];
      chain.roles[role + "/" + m.creator] = { current_bond: String(BigInt(prev ? prev.current_bond : "0") + BigInt(m.amount)), signer: doc.__from };
    } else if (t === "MsgCreateClass") {
      chain.classes ||= [];
      if (chain.classes.some((c) => c.owner === m.creator && c.symbol === m.symbol)) throw new Error("class symbol already used by this owner");
      chain.classes.push({ id: String(chain.classes.length + 1), owner: m.creator, symbol: m.symbol, name: m.name, signer: doc.__from });
    } else if (t === "MsgInviteMember") {
      if ((st.members || {})[m.invitee_address]) throw new Error("member already exists");
      st.invitations ||= {};
      if (Object.values(st.invitations).some((i) => i.invitee_address === m.invitee_address && !i.status)) throw new Error("invitation already exists");
      const id = String(Object.keys(st.invitations).length + 1);
      st.invitations[id] = { id, inviter: m.inviter, invitee_address: m.invitee_address, staked_dream: m.staked_dream, signer: doc.__from };
    } else if (t === "MsgAcceptInvitation") {
      const i = (st.invitations || {})[m.invitation_id];
      if (!i || i.status || i.invitee_address !== m.invitee) throw new Error("invitation not found");
      if (m.accepted_content_license !== "CC0-1.0") throw new Error("content license not accepted");
      i.status = "INVITATION_STATUS_ACCEPTED";
      st.members ||= {};
      st.members[m.invitee] = { trust_level: "TRUST_LEVEL_NEW", dream_balance: "0", staked_dream: "0" };
    } else if (t === "MsgSend") {
      st.balances ||= {};
      const to = (st.balances[m.to_address] ||= {});
      for (const c of m.amount) to[c.denom] = String(BigInt(to[c.denom] || "0") + BigInt(c.amount));
    } else if (t === "MsgCreateSession") {
      chain.sessions ||= {};
      const k = m.granter + "/" + m.grantee;
      if (chain.sessions[k]) throw new Error("session already exists for (granter, grantee) pair");
      if (Date.parse(m.expiration) > Date.now() + sessionMaxMs()) throw new Error("requested expiration exceeds max_expiration");
      if (BigInt(m.spend_limit.amount) > 100000000n) throw new Error("requested spend limit exceeds max_spend_limit_amount");
      chain.sessions[k] = { granter: m.granter, grantee: m.grantee, allowed_msg_types: m.allowed_msg_types,
        spend_limit: m.spend_limit, spent: { denom: m.spend_limit.denom, amount: "0" }, expiration: m.expiration,
        max_exec_count: m.max_exec_count, signer: doc.__from };
    } else if (t === "MsgRevokeSession") {
      const k = m.granter + "/" + m.grantee;
      if (!chain.sessions || !chain.sessions[k]) throw new Error("no active session for (granter, grantee) pair");
      delete chain.sessions[k];
    } else if (t === "MsgUpdatePeerPolicy") {
      chain.policies[m.peer_id] = m.policy;
    } else if (t === "MsgResumePeer") {
      if (!chain.peers[m.peer_id]) throw new Error("no peer");
      chain.peers[m.peer_id].status = "PEER_STATUS_ACTIVE";
    } else if (t === "MsgSubmitProposal") {
      const id = String(Object.keys(chain.proposals).length);
      chain.proposals[id] = { status: "PROPOSAL_STATUS_VOTING", messages: m.messages, policy_address: m.policy_address };
      events.push({ type: "submit_proposal", attributes: [{ key: "proposal_id", value: id }] });
    } else if (t === "MsgVoteProposal") {
      const p = chain.proposals[m.proposal_id];
      if (p.status !== "PROPOSAL_STATUS_VOTING") throw new Error("proposal not open for voting");
      p.status = "PROPOSAL_STATUS_ACCEPTED";
    } else if (t === "MsgExecuteProposal") {
      const p = chain.proposals[m.proposal_id];
      if (st.earlyExecutions > 0) { st.earlyExecutions--; throw new Error("min execution period not reached"); }
      for (const inner of p.messages) run(inner);
      p.status = "PROPOSAL_STATUS_EXECUTED";
    }
  };
  try { msgs.forEach(run); } catch (e) { out({ txhash: hash, code: 7, raw_log: String(e.message) }); }
  st.txs[hash] = { code: 0, events };
  out({ txhash: hash, code: 0 });
}
// anything else (keys, genesis, init...) is the real binary's job
if (process.env.CHAIN_STUB_REAL) {
  const r = require("child_process").spawnSync(process.env.CHAIN_STUB_REAL, args, { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
out({});
`;

export function chainStub(network: ChainStub["network"] = "testnet"): ChainStub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-stub-"));
  const bin = path.join(dir, "sparkdreamd");
  fs.writeFileSync(bin, SCRIPT, { mode: 0o755 });
  const file = path.join(dir, "state.json");
  const initial: StubState = { chains: {}, txs: {}, log: [], earlyExecutions: 0 };
  fs.writeFileSync(file, JSON.stringify(initial));
  const state = () => JSON.parse(fs.readFileSync(file, "utf8")) as StubState;
  return {
    bin,
    network,
    dir,
    state,
    edit(fn) {
      const s = state();
      fn(s);
      fs.writeFileSync(file, JSON.stringify(s));
    },
  };
}

/** Run `fn` with SPARKDREAMD_BIN pointed at the stub; commands the stub does
 *  not model (keys, genesis, ...) go on to the real binary. */
export async function withStub<T>(stub: ChainStub, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SPARKDREAMD_BIN;
  const prevReal = process.env.CHAIN_STUB_REAL;
  process.env.CHAIN_STUB_REAL =
    prev ??
    process.env[`SPARKDREAMD_BIN_${stub.network.toUpperCase()}`] ??
    execFileSync("sh", ["-c", "command -v sparkdreamd || true"], { encoding: "utf8" }).trim();
  process.env.SPARKDREAMD_BIN = stub.bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SPARKDREAMD_BIN;
    else process.env.SPARKDREAMD_BIN = prev;
    if (prevReal === undefined) delete process.env.CHAIN_STUB_REAL;
    else process.env.CHAIN_STUB_REAL = prevReal;
  }
}
