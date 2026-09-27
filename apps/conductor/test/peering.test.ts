import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { encodedToEncodeObjects } from "@sparkdream/akash-tx";
import { AwaitUser, WALLET_SIGNER, type StepCtx, type WalletRequest } from "../src/engine.js";
import { ensurePeerActive, policyDrift, sparkDreamPeerPolicy, type ChainActor, type PeerTarget } from "../src/peering.js";
import { activityPubPeerPolicy, BRIDGE_AUTHOR_FIELDS } from "../src/steps/mastodon.js";
import { chainStub, withStub } from "./chain-stub.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-peering-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** ensurePeerActive only logs and sleeps through the context. */
function ctx(): StepCtx {
  return { log: () => undefined, services: { sleep: async () => undefined } } as unknown as StepCtx;
}

function actor(signed: boolean): ChainActor {
  return {
    chainId: "phoenix-1",
    rpc: "http://phoenix",
    gasDenom: "uspark",
    gasPrice: 0.025,
    ...(signed ? { signer: { home: "/nowhere", key: "acct-founder", address: "sprkdrm1founder" } } : {}),
    outDir: tmp(),
    label: "this fleet",
  };
}

const target: PeerTarget = {
  id: "aurora-1",
  type: "PEER_TYPE_SPARK_DREAM",
  displayName: "aurora-1",
  ibcChannelId: "channel-1",
  ibcTransferChannelId: "channel-0",
  peerIdentity: { bond_denom: "uspk.aurora", bond_display_symbol: "ASPK" },
  policy: sparkDreamPeerPolicy(),
};

describe("ensurePeerActive", () => {
  it("registers, sets the policy, and activates through a proposal the founder votes and executes", async () => {
    const stub = chainStub();
    const out = await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), target));
    expect(out).toMatchObject({ chainId: "phoenix-1", peerId: "aurora-1", status: "PEER_STATUS_ACTIVE" });

    const st = stub.state();
    const chain = st.chains["http://phoenix"]!;
    expect(chain.peers["aurora-1"]).toMatchObject({
      ibc_channel_id: "channel-1",
      ibc_transfer_channel_id: "channel-0",
      peer_identity: { bond_display_symbol: "ASPK" },
    });
    expect(chain.policies["aurora-1"]).toMatchObject({ peer_id: "aurora-1", inbound_content_types: expect.arrayContaining(["blog_post"]) });
    expect(Object.values(chain.proposals)).toEqual([expect.objectContaining({ status: "PROPOSAL_STATUS_EXECUTED" })]);
    // every tx signed by the launcher-held founder key, in stage order
    expect(st.log.map((l) => [l.from, l.types[0]!.split(".").pop()])).toEqual([
      ["acct-founder", "MsgRegisterPeer"],
      ["acct-founder", "MsgUpdatePeerPolicy"],
      ["acct-founder", "MsgSubmitProposal"],
      ["acct-founder", "MsgVoteProposal"],
      ["acct-founder", "MsgExecuteProposal"],
    ]);

    // idempotent: an active peer with a policy costs no transactions
    await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), target));
    expect(stub.state().log).toHaveLength(5);
  });

  it("keeps retrying execution while it is too early, on the same proposal", async () => {
    const stub = chainStub();
    stub.edit((s) => (s.earlyExecutions = 2));
    await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), target));
    const types = stub.state().log.map((l) => l.types[0]!.split(".").pop());
    expect(types.filter((t) => t === "MsgSubmitProposal")).toHaveLength(1);
    expect(types.filter((t) => t === "MsgExecuteProposal")).toHaveLength(3);
    expect(stub.state().chains["http://phoenix"]!.peers["aurora-1"]!.status).toBe("PEER_STATUS_ACTIVE");
  });

  it("without a launcher-held key or a public endpoint, pauses with the messages to send, and finishes once the chain shows them done", async () => {
    const stub = chainStub();
    const chain = actor(false);
    const paused = await withStub(stub, () => ensurePeerActive(ctx(), "s", chain, target)).catch((e) => e);
    expect(paused).toBeInstanceOf(AwaitUser);
    expect(paused.reason).toContain("register aurora-1 as a Spark Dream peer");
    expect(paused.wallet).toBeUndefined();
    const file = /Send the messages in (\S+) /.exec(paused.reason)![1]!;
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.messages[0]).toMatchObject({
      "@type": "/sparkdream.federation.v1.MsgRegisterPeer",
      authority: WALLET_SIGNER,
      ibc_transfer_channel_id: "channel-0",
    });
    expect(stub.state().log).toHaveLength(0);

    // the committee acts from its own wallets
    stub.edit((s) => {
      s.chains["http://phoenix"]!.peers["aurora-1"] = { id: "aurora-1", status: "PEER_STATUS_ACTIVE", ibc_channel_id: "channel-1" };
      s.chains["http://phoenix"]!.policies["aurora-1"] = { inbound_content_types: ["blog_post"] };
    });
    const done = await withStub(stub, () => ensurePeerActive(ctx(), "s", chain, target));
    expect(done.status).toBe("PEER_STATUS_ACTIVE");
  });

  it("with a public endpoint, asks the committee's wallet for each stage in turn: register, policy, propose, vote, execute", async () => {
    const stub = chainStub();
    const PUBLIC = "https://rpc.phoenix.example";
    stub.edit((s) => (s.aliases = { [PUBLIC]: "http://phoenix" }));
    const chain: ChainActor = {
      ...actor(false),
      wallet: {
        chainId: "phoenix-1", chainName: "phoenix", rpc: PUBLIC, rest: "https://api.phoenix.example",
        bech32Prefix: "sprkdrm", denom: "uspark", displayDenom: "SPARK", decimals: 6, gasPrice: 0.025,
      },
    };
    const MEMBER = "sprkdrm1member";
    const asked: string[] = [];
    // what the web UI does: fill the wallet's address in, sign, broadcast
    const signInWallet = (req: WalletRequest) => {
      asked.push((req.msgs[0] as any)["@type"].split(".").pop());
      const msgs = JSON.parse(JSON.stringify(req.msgs).split(JSON.stringify(WALLET_SIGNER)).join(JSON.stringify(MEMBER)));
      const doc = path.join(tmp(), "tx.json");
      fs.writeFileSync(doc, JSON.stringify({ body: { messages: msgs }, __from: MEMBER }));
      execFileSync(stub.bin, ["tx", "broadcast", doc, "--node", req.chain.rpc]);
    };

    let done: unknown;
    for (let i = 0; i < 8 && !done; i++) {
      const res = await withStub(stub, () => ensurePeerActive(ctx(), "s", chain, target)).catch((e) => e);
      if (!(res instanceof AwaitUser)) {
        done = res;
        break;
      }
      expect(res.wallet).toBeDefined();
      expect(res.wallet!.chain.rpc).toBe(PUBLIC);
      expect(res.wallet!.signerRole).toMatch(/Operations Committee/);
      expect(res.wallet!.cli).toContain("sparkdreamd tx sign");
      // encoded by the chain binary: what the browser decodes and signs
      const eo = encodedToEncodeObjects(res.wallet!.encoded, MEMBER);
      expect(eo.map((e) => e.typeUrl)).toEqual(res.wallet!.msgs.map((m: any) => m["@type"]));
      if (eo[0]!.typeUrl.endsWith("MsgRegisterPeer")) expect(eo[0]!.value).toMatchObject({ authority: MEMBER, type: 1 });
      if (eo[0]!.typeUrl.endsWith("MsgVoteProposal")) expect(eo[0]!.value).toMatchObject({ voter: MEMBER, option: 1 });
      if ((res.wallet!.msgs[0] as any)["@type"].endsWith("MsgSubmitProposal")) {
        // the chain enforces commons proposal_fee as a fee floor
        expect(res.wallet!.minFee).toEqual({ denom: "uspark", amount: "5000000" });
      }
      signInWallet(res.wallet!);
    }
    expect(done).toMatchObject({ peerId: "aurora-1", status: "PEER_STATUS_ACTIVE" });
    expect(asked).toEqual(["MsgRegisterPeer", "MsgUpdatePeerPolicy", "MsgSubmitProposal", "MsgVoteProposal", "MsgExecuteProposal"]);
    // everything signed by the member's wallet, nothing by the launcher
    expect(stub.state().log.every((l) => l.from === MEMBER)).toBe(true);
    expect(stub.state().chains["http://phoenix"]!.peers["aurora-1"]!.authority ?? MEMBER).toBe(MEMBER);
  });

  it("waits out an accepted proposal's execution time before asking for the execute signature", async () => {
    const stub = chainStub();
    const later = Math.floor(Date.now() / 1000) + 600;
    stub.edit((s) => {
      s.chains["http://phoenix"] = {
        peers: { "aurora-1": { id: "aurora-1", status: "PEER_STATUS_PENDING", ibc_channel_id: "channel-1" } },
        policies: { "aurora-1": { inbound_content_types: ["blog_post"] } },
        proposals: {
          "4": {
            status: "PROPOSAL_STATUS_ACCEPTED",
            policy_address: "sprkdrm1opspolicy",
            execution_time: later,
            messages: [{ "@type": "/sparkdream.federation.v1.MsgResumePeer", authority: "sprkdrm1opspolicy", peer_id: "aurora-1" }],
          },
        },
        identity: {},
      };
    });
    const chain: ChainActor = {
      ...actor(false),
      wallet: { chainId: "phoenix-1", chainName: "phoenix", rpc: "http://phoenix", bech32Prefix: "sprkdrm", denom: "uspark", displayDenom: "SPARK", decimals: 6, gasPrice: 0 },
    };
    const err = await withStub(stub, () => ensurePeerActive(ctx(), "s", chain, target)).catch((e) => e);
    expect(err).toBeInstanceOf(AwaitUser);
    expect(err.wallet).toBeUndefined();
    expect(err.reason).toMatch(/proposal 4 .* can be executed from .* resume then/);
  });

  it("does not overturn a suspension", async () => {
    const stub = chainStub();
    stub.edit((s) => {
      s.chains["http://phoenix"] = {
        peers: { "aurora-1": { id: "aurora-1", status: "PEER_STATUS_SUSPENDED", ibc_channel_id: "channel-1" } },
        policies: { "aurora-1": { inbound_content_types: ["blog_post"] } },
        proposals: {},
        identity: {},
      };
    });
    const err = await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), target)).catch((e) => e);
    expect(err).toBeInstanceOf(AwaitUser);
    expect(err.reason).toContain("SUSPENDED");
    expect(stub.state().log).toHaveLength(0);
  });

  it("keeps the spec's author curation in sync on a policy already set, carrying the rest of it over", async () => {
    const stub = chainStub();
    const peer = (allow: string[], collectionId?: number): PeerTarget => ({
      id: "mastodon.aurora.example",
      type: "PEER_TYPE_ACTIVITYPUB",
      displayName: "mastodon.aurora.example",
      policy: activityPubPeerPolicy({ allow, collectionId }),
      syncPolicy: BRIDGE_AUTHOR_FIELDS,
    });
    // a peer from before author curation: active, policy set, no allow-list
    stub.edit((s) => {
      s.chains["http://phoenix"] = { peers: {}, policies: {}, proposals: {} } as any;
      s.chains["http://phoenix"]!.peers["mastodon.aurora.example"] = { id: "mastodon.aurora.example", status: "PEER_STATUS_ACTIVE" };
      s.chains["http://phoenix"]!.policies["mastodon.aurora.example"] = {
        peer_id: "mastodon.aurora.example",
        inbound_content_types: ["blog_post"],
        inbound_rate_limit_per_epoch: "40",
      };
    });
    await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), peer(["*"])));
    const policies = () => stub.state().chains["http://phoenix"]!.policies;
    expect(policies()["mastodon.aurora.example"]).toEqual({
      peer_id: "mastodon.aurora.example",
      inbound_content_types: ["blog_post"],
      inbound_rate_limit_per_epoch: "40",
      allowed_identities: ["*"],
    });
    expect(stub.state().log.map((l) => l.types[0]!.split(".").pop())).toEqual(["MsgUpdatePeerPolicy"]);

    // in sync: nothing sent
    await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), peer(["*"])));
    expect(stub.state().log).toHaveLength(1);

    // a curation collection added in the spec (id 0 included)
    await withStub(stub, () => ensurePeerActive(ctx(), "s", actor(true), peer(["*"], 0)));
    expect(policies()["mastodon.aurora.example"]).toMatchObject({ inbound_rate_limit_per_epoch: "40", curation: { collection_id: "0" } });
    expect(stub.state().log).toHaveLength(2);
  });
});

describe("policyDrift", () => {
  const target = (collectionId?: number): PeerTarget => ({
    id: "p", type: "PEER_TYPE_ACTIVITYPUB", displayName: "p",
    policy: activityPubPeerPolicy({ allow: ["*"], collectionId }), syncPolicy: BRIDGE_AUTHOR_FIELDS,
  });
  it("reads the CLI's omitted zero values as the spec writes them", () => {
    // collection 0 prints as an empty object; no curation as no field at all
    expect(policyDrift({ allowed_identities: ["*"], curation: {} }, target(0))).toEqual([]);
    expect(policyDrift({ allowed_identities: ["*"] }, target())).toEqual([]);
    expect(policyDrift({ allowed_identities: ["*"], curation: { collection_id: "3" } }, target(3))).toEqual([]);
  });
  it("leaves a policy alone when the spec does not own its authors", () => {
    // the frontend's edits stand: no syncPolicy, no drift, whatever is stored
    const unowned: PeerTarget = { id: "p", type: "PEER_TYPE_ACTIVITYPUB", displayName: "p", policy: activityPubPeerPolicy() };
    expect(policyDrift({ allowed_identities: ["@phoenix@p"], curation: { collection_id: "4" } }, unowned)).toEqual([]);
  });

  it("names the fields that differ", () => {
    expect(policyDrift({}, target())).toEqual(["allowed_identities"]);
    expect(policyDrift({ allowed_identities: ["*"], curation: { collection_id: "3" } }, target())).toEqual(["curation"]);
    expect(policyDrift({ allowed_identities: ["*"] }, target(0))).toEqual(["curation"]);
  });
});
