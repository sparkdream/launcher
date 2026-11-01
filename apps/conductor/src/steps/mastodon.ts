import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  bridgeAccount,
  bridgePeerIds,
  fleetBridge,
  isServicesFleet,
  mastodonLoginDomain,
  withDefaults,
  type LaunchSpec,
} from "@sparkdream/launch-spec";
import { TypeUrl } from "../akash/messages.js";
import { loadSdl, sdlArtifacts } from "../akash/sdl-groups.js";
import { setServiceEnv } from "../components/index.js";
import {
  BRIDGE_OPERATOR,
  readMastodonSecrets,
  updateMastodonSecrets,
  writeBridgeOperatorAddress,
} from "../components/mastodon-secrets.js";
import type { FleetComponentRow } from "../db.js";
import { AwaitUser, launchDirs, WALLET_SIGNER, type StepCtx, type StepDef } from "../engine.js";
import { sparkdreamd } from "../exec.js";
import { ensurePeerActive, walletPause, fleetActor, sendTx, walletChain, type ChainActor, type PeerStatus } from "../peering.js";
import { bridgeDependents } from "../bridge-target.js";
import { readSecretFile, writeSecretFile } from "../secrets.js";
import { componentLease, ensureSession, sessionReserve, sessionSpendLimit } from "../sessions.js";
import { loadCert, loadCertAt } from "./phase-bcd.js";
import { pushManifest } from "./phase-ef.js";
import { queryJson } from "./phase-g.js";

/**
 * The mastodon component, once placed and healthy (§5 mastodon):
 *
 *   configure-mastodon  the Owner account (its password kept for the fleet's
 *                       accounts panel: the only time it is ever shown) and
 *                       the registrations mode
 *                       and, with walletLogin, the chains whose members may
 *                       sign in (its own, and every chain whose standalone
 *                       bridge links it)
 *   link-bridge         with the bridge: the instance as an ActivityPub peer
 *                       of this chain (registered, policy, activated), the
 *                       bridge account and its read-only token, the operator
 *                       bonded, and the token delivered to the bridge
 *                       service (one deployment update)
 *
 * The image runs no sshd; both drive mastodon-bootstrap (in the chain repo's
 * Dockerfile-mastodon) over the provider's lease-shell. Every action is
 * idempotent, so they re-run after a relaunch or a resume unchanged.
 */

/** Where the mastodon deployment runs: its fleet row, else the launch's outputs. */
function mastodonLease(ctx: StepCtx): { hostUri: string; dseq: string; gseq: number; oseq: number } {
  return componentLease(ctx, "mastodon");
}

/** Run mastodon-bootstrap in the instance; returns its JSON result line. */
async function bootstrap(ctx: StepCtx, args: string[]): Promise<Record<string, unknown>> {
  return bootstrapOn(ctx, mastodonLease(ctx), loadCert(ctx), args);
}

/** mastodon-bootstrap on a given Mastodon deployment (another fleet's, for
 *  a standalone bridge), with that deployment's owner certificate. */
async function bootstrapOn(
  ctx: StepCtx,
  lease: { hostUri: string; dseq: string; gseq: number; oseq: number },
  cert: ReturnType<typeof loadCert>,
  args: string[],
): Promise<Record<string, unknown>> {
  let lastError = "";
  // the web container may still be preparing its schema right after a
  // (re)placement: rails runner cannot connect until it is done
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt > 0) await ctx.services.sleep(15_000);
    try {
      const { stdout } = await ctx.services.provider.shellExec(
        cert, lease.hostUri, lease.dseq, lease.gseq, lease.oseq, "mastodon",
        ["mastodon-bootstrap", ...args],
      );
      const line = stdout.trim().split("\n").pop() ?? "";
      return JSON.parse(line) as Record<string, unknown>;
    } catch (e) {
      lastError = String(e).slice(0, 300);
    }
  }
  throw new Error(`mastodon-bootstrap ${args[0]} kept failing: ${lastError}`);
}

export async function configureMastodon(
  ctx: StepCtx,
  _stepName: string,
  spec: LaunchSpec,
): Promise<{ owner: string; created: boolean; registrations: string }> {
  const m = spec.topology.components.mastodon!;
  const owner = m.owner!;
  const res = await bootstrap(ctx, ["owner", owner.username, owner.email]);
  if (res.created === true && typeof res.password === "string") {
    updateMastodonSecrets(ctx.dirs.secrets, { ownerPassword: res.password });
    ctx.log(`mastodon: owner @${owner.username}@${m.domain} created — its password is in the fleet's accounts panel`);
  }
  await bootstrap(ctx, ["registrations", m.registrations]);
  const loginChains = mastodonLoginDomain(spec)
    ? await syncLoginChains(ctx, ctx.launchId, (args) => bootstrap(ctx, args))
    : undefined;
  return {
    owner: `@${owner.username}@${m.domain}`,
    created: res.created === true,
    registrations: m.registrations,
    ...(loginChains !== undefined ? { loginChains } : {}),
  };
}

// ---------------------------------------------------------------------------
// wallet sign-in

/** A chain whose members may sign in: what the login page suggests to
 *  Keplr, the LCD sdaplogin reads membership from, and the trust floor. */
export type LoginChain = ReturnType<typeof walletChain> & { minTrustLevel: string };

/**
 * The chains fleet `mastodonFleetId`'s instance offers at wallet sign-in,
 * keyed by chain fleet id: its own chain (a chain fleet's), and each chain
 * whose standalone bridge links it. `linking` is a chain being linked right
 * now, counted before its bridge row settles. A chain without public api
 * and rpc domains cannot be offered (membership is read through the api,
 * Keplr needs the rpc). Empty when the instance has sign-in off.
 */
export function loginChains(
  db: StepCtx["db"],
  mastodonFleetId: string,
  linking?: { id: string; spec: LaunchSpec },
): Record<string, LoginChain> {
  const launch = db.getLaunch(mastodonFleetId);
  if (!launch) return {};
  const spec = withDefaults(JSON.parse(launch.spec_json));
  const login = spec.topology.components.mastodon?.walletLogin;
  if (!mastodonLoginDomain(spec) || !login) return {};
  const minTrustLevel = `TRUST_LEVEL_${login.minTrustLevel.toUpperCase()}`;
  const chains: Record<string, LoginChain> = {};
  const add = (id: string, s: LaunchSpec) => {
    const pub = s.topology.publicEndpoints;
    if (isServicesFleet(s) || !pub?.api || !pub.rpc) return;
    chains[id] = { ...walletChain(s), minTrustLevel };
  };
  add(mastodonFleetId, spec);
  for (const l of bridgeDependents(db, mastodonFleetId)) add(l.id, withDefaults(JSON.parse(l.spec_json)));
  if (linking) add(linking.id, linking.spec);
  return chains;
}

/** Store the instance's sign-in chains (replacing the previous list). */
async function syncLoginChains(
  ctx: StepCtx,
  mastodonFleetId: string,
  run: (args: string[]) => Promise<Record<string, unknown>>,
  linking?: { id: string; spec: LaunchSpec },
): Promise<number> {
  const chains = loginChains(ctx.db, mastodonFleetId, linking);
  await run(["login-chain", "sync", JSON.stringify(chains)]);
  ctx.log(`mastodon: wallet sign-in offers ${Object.keys(chains).length} chain(s)`);
  return Object.keys(chains).length;
}

// ---------------------------------------------------------------------------
// bridge

/** Which of the instance's authors the chain anchors (PeerPolicy's author
 *  curation): the spec's allow-list ("*" for any) and optional x/collect
 *  curation collection, both required to pass. */
export function bridgeAuthorPolicy(authors?: { allow?: string[] | undefined; collectionId?: number | undefined }): Record<string, unknown> {
  return {
    allowed_identities: authors?.allow ?? ["*"],
    ...(authors?.collectionId !== undefined ? { curation: { collection_id: String(authors.collectionId) } } : {}),
  };
}

/** The policy fields bridgeAuthorPolicy owns, kept in sync with the spec. */
export const BRIDGE_AUTHOR_FIELDS = ["allowed_identities", "curation"];

/** What an ActivityPub instance may send this chain: its members' posts and
 *  replies, anchored by the bridge, from the authors the spec admits.
 *  Nothing goes out to it. */
export function activityPubPeerPolicy(authors?: { allow?: string[] | undefined; collectionId?: number | undefined }): Record<string, unknown> {
  return {
    outbound_content_types: [],
    inbound_content_types: ["blog_post", "blog_reply"],
    min_outbound_trust_level: 0,
    inbound_rate_limit_per_epoch: "100",
    outbound_rate_limit_per_epoch: "0",
    allow_reputation_queries: false,
    accept_reputation_attestations: false,
    require_review: false,
    blocked_identities: [],
    content_hosts: [],
    ...bridgeAuthorPolicy(authors),
  };
}

/**
 * The bridge operator's key, in the master keyring and mnemonics.json (so it
 * exports and reveals with the fleet's other generated accounts). Created on
 * first use; a keyring entry left without its mnemonic (an interrupted
 * earlier run) is replaced, since its mnemonic is unrecoverable. A mnemonic
 * without its keyring entry (a chain reset rebuilds the keyring) is imported
 * back: the operator keeps its address, which the running bridge's env and
 * the new genesis both carry.
 */
export function ensureBridgeOperatorKey(secretsDir: string, masterHome: string): Promise<string> {
  return ensureOperatorKey(secretsDir, masterHome, BRIDGE_OPERATOR, (a) => writeBridgeOperatorAddress(secretsDir, a));
}

/**
 * A launcher-held operator key by keyring name (the bridge's, the
 * scanner's), as ensureBridgeOperatorKey describes; `record` keeps the
 * address where the operator's SDL render finds it.
 */
export async function ensureOperatorKey(
  secretsDir: string,
  masterHome: string,
  name: string,
  record: (address: string) => void,
): Promise<string> {
  const file = path.join(secretsDir, "mnemonics.json");
  const all: Record<string, string> = fs.existsSync(file) ? JSON.parse(readSecretFile(file)) : {};
  const keyring = ["--keyring-backend", "test", "--home", masterHome];
  if (all[name]) {
    const shown = await sparkdreamd(["keys", "show", name, "-a", ...keyring]).catch(() => undefined);
    if (!shown) {
      // the mnemonic on stdin: never in argv, never in an error message
      await sparkdreamd(["keys", "add", name, "--recover", ...keyring, "--output", "json"], {
        input: `${all[name]}\n`,
      });
    }
    const { stdout } = shown ?? (await sparkdreamd(["keys", "show", name, "-a", ...keyring]));
    record(stdout.trim());
    return stdout.trim();
  }
  await sparkdreamd(["keys", "delete", name, "-y", ...keyring]).catch(() => undefined);
  const { stdout } = await sparkdreamd(["keys", "add", name, ...keyring, "--output", "json"]);
  const parsed = JSON.parse(stdout) as { address: string; mnemonic: string };
  all[name] = parsed.mnemonic;
  writeSecretFile(file, JSON.stringify(all, null, 2));
  record(parsed.address);
  return parsed.address;
}

async function bridgeBound(chain: ChainActor, operator: string, peerId: string): Promise<boolean> {
  try {
    const out = await queryJson(["query", "federation", "get-bridge-binding", operator, peerId], chain.rpc);
    return Boolean(out.binding ?? out.bridge_binding ?? out.bridge);
  } catch (e) {
    if (/not found|NotFound|code = 5/i.test(String(e))) return false;
    throw e;
  }
}

/** The operator's x/rep standing: "none" when it is not a member. */
async function operatorMembership(chain: ChainActor, operator: string): Promise<"none" | "active" | "inactive" | "zeroed"> {
  try {
    const out = await queryJson(["query", "rep", "get-member", operator], chain.rpc);
    // proto-JSON leaves the zero value (ACTIVE) out
    const status = String(out.member?.status ?? "MEMBER_STATUS_ACTIVE");
    return status === "MEMBER_STATUS_ZEROED" ? "zeroed" : status === "MEMBER_STATUS_INACTIVE" ? "inactive" : "active";
  } catch (e) {
    if (/not found|NotFound|code = 5/i.test(String(e))) return "none";
    throw e;
  }
}

/** The pending x/rep invitation for `invitee`, newest first (one is recent). */
async function pendingInvitation(chain: ChainActor, invitee: string): Promise<{ id: string } | undefined> {
  const out = await queryJson(["query", "rep", "list-invitation", "--page-reverse", "--page-limit", "1000"], chain.rpc);
  return (out.invitation ?? []).find(
    (i: { invitee_address?: string; status?: string }) =>
      i.invitee_address === invitee && (i.status ?? "INVITATION_STATUS_PENDING") === "INVITATION_STATUS_PENDING",
  );
}

/** The largest stake any of `inviters` needs for its next invitation (the
 *  chain's base floor when none is given). */
async function requiredInvitationStake(chain: ChainActor, inviters: string[]): Promise<string> {
  let stake = BigInt((await queryJson(["query", "rep", "params"], chain.rpc)).params?.min_invitation_stake ?? "0");
  for (const inviter of inviters) {
    const out = await queryJson(["query", "rep", "required-invitation-stake", inviter], chain.rpc).catch(() => undefined);
    const need = BigInt(out?.required_stake ?? "0");
    if (need > stake) stake = need;
  }
  return stake.toString();
}

function inviteMsg(inviter: string, invitee: string, stake: string): unknown {
  return {
    "@type": "/sparkdream.rep.v1.MsgInviteMember",
    inviter,
    invitee_address: invitee,
    staked_dream: stake,
    vouched_tags: [],
  };
}

/** Put the issued token and the peer list into the bridge service's env:
 *  one deployment update, after which the bridge leaves its idle loop for
 *  sdapbridge (or restarts with the peers it now watches). */
async function deliverBridgeEnv(
  ctx: StepCtx,
  stepName: string,
  component: "mastodon" | "bridge",
  want: Record<string, string>,
): Promise<boolean> {
  const lease = componentLease(ctx, component);
  // Delivered means the running bridge has it, not that the SDL file does: a
  // pause for the update signature between writing the SDL and pushing the
  // manifest left the file with the new env and the container without it.
  const keys = Object.keys(want);
  const running = await ctx.services.provider
    .shellExec(loadCert(ctx), lease.hostUri, lease.dseq, lease.gseq, lease.oseq, "bridge", [
      "sh", "-c", keys.map((k) => `printf '%s\\n' "$${k}"`).join("; "),
    ])
    .then((r) => r.stdout.split("\n"))
    .catch(() => [] as string[]);
  if (keys.every((k, i) => running[i] === want[k])) return false;

  const sdlPath = path.join(ctx.dirs.sdl, `${component}.yaml`);
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const env = (doc.services?.bridge?.env as string[] | undefined) ?? [];
  if (keys.some((k) => !env.includes(`${k}=${want[k]}`))) {
    setServiceEnv(doc, ["bridge"], want);
    fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
  }
  const artifacts = sdlArtifacts(loadSdl(sdlPath));
  fs.writeFileSync(path.join(ctx.dirs.sdl, `${component}.manifest.json`), artifacts.manifestJson);
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const wantHash = Buffer.from(artifacts.hash).toString("base64");
  const onChain = await ctx.services.api.deploymentInfo(owner, lease.dseq);
  if (onChain?.hash !== wantHash) {
    await ctx.requireTx(`${stepName}:update`, [
      { typeUrl: TypeUrl.UpdateDeployment, value: { id: { owner, dseq: lease.dseq }, hash: wantHash } },
    ]);
  }
  await pushManifest(ctx, loadCert(ctx), component, lease.hostUri, lease.dseq, artifacts.manifestJson);
  return true;
}

/**
 * Link the fleet's bridge (its Mastodon's sidecar, or a standalone bridge
 * component) to this fleet's chain: the instance and any other servers as
 * ActivityPub peers, the bridge account's token on the instance, the
 * operator's bond and bindings, and the bridge service's env.
 */
export async function linkBridge(
  ctx: StepCtx,
  stepName: string,
  spec: LaunchSpec,
  access: BridgeAccess,
): Promise<{ peer: PeerStatus; peers: PeerStatus[]; operator: string; account: string; bonded: string; tokenDelivered: boolean }> {
  const link = fleetBridge(spec)!.link;
  const domain = access.domain;
  const account = bridgeAccount(spec);
  const chain = await fleetActor(ctx, ctx.launchId, "this fleet");

  // 1. the instance as an ActivityPub peer: its domain is the peer id, so
  //    AS2 ids on that host are this peer's content (no content_hosts needed)
  const peer = await ensurePeerActive(ctx, stepName, chain, {
    id: domain,
    type: "PEER_TYPE_ACTIVITYPUB",
    displayName: domain,
    policy: activityPubPeerPolicy(link.authors),
    // only a spec that names its authors keeps them in sync: otherwise the
    // committee's edits in the frontend would be undone on the next run
    ...(link.authors ? { syncPolicy: BRIDGE_AUTHOR_FIELDS } : {}),
  });

  // 1b. other servers bridged as peers of their own (bridge.peers): closed
  //     until the community opens them, unless the spec names their authors
  const peers: PeerStatus[] = [];
  for (const other of link.peers ?? []) {
    peers.push(
      await ensurePeerActive(ctx, stepName, chain, {
        id: other.id,
        type: "PEER_TYPE_ACTIVITYPUB",
        displayName: other.id,
        policy: activityPubPeerPolicy(other.authors ?? { allow: [] }),
        ...(other.authors ? { syncPolicy: BRIDGE_AUTHOR_FIELDS } : {}),
      }),
    );
  }

  // 2. the bridge account and its read-only token, asked of the running
  //    instance every time: the same token while its database lives, a new
  //    one after the instance started over (a close and re-add, a resize)
  const res = await access.bootstrap(["bridge-token", account, `${account}@${domain}`]);
  if (typeof res.token !== "string" || !res.token) throw new Error("mastodon-bootstrap issued no bridge token");
  const token = res.token;
  if (readMastodonSecrets(ctx.dirs.secrets)?.bridgeToken !== token) {
    updateMastodonSecrets(ctx.dirs.secrets, { bridgeToken: token });
  }

  // 3. the operator bonds for the peer (self-signed; its own key, not the founder's)
  const operator = await ensureBridgeOperatorKey(ctx.dirs.secrets, ctx.dirs.node("val-0"));
  const serviceType = await queryJson(["query", "service", "service-type", "federation-bridge-activitypub"], chain.rpc);
  const bond = String(serviceType.config?.min_bond_amount ?? "0");
  const operatorSigner: ChainActor = {
    ...chain,
    signer: { home: ctx.dirs.node("val-0"), key: BRIDGE_OPERATOR, address: operator },
  };
  const unbound = !(await bridgeBound(chain, operator, domain));
  // a bridge operator must be an active x/rep member (chain v1.0.56), so the
  // self-dealing checks see the person behind the bridge: a member invites
  // it and the operator accepts with its own key. An operator bonded on an
  // older chain joins too: without membership its submissions are refused
  const membership = await operatorMembership(chain, operator);
  if (membership !== "none" && membership !== "active") {
    throw new AwaitUser(
      stepName,
      `the bridge operator ${operator} is an ${membership} x/rep member on ${chain.chainId}: a bridge operator ` +
        "must be active. Restore its membership on the chain, then resume",
    );
  }
  const joining = membership === "none";
  if (unbound || joining) {
    const walletMsgs: unknown[] = [];
    let inviteStake: string | undefined;
    if (joining && !(await pendingInvitation(chain, operator))) {
      if (chain.signer) {
        // the launcher-held founder vouches for it
        const stake = await requiredInvitationStake(chain, [chain.signer.address]);
        await sendTx(ctx, chain, `${chain.chainId}-invite-bridge-operator`, [inviteMsg(chain.signer.address, operator, stake)]);
        ctx.log(`mastodon: founder invited bridge operator ${operator} into x/rep (staked ${stake} micro-DREAM)`);
      } else {
        // the wallet member's floor is unknown until it signs: stake what the
        // spec's members would each need (an escalated inviter needs more)
        const members = spec.accounts.initial.filter((a) => a.member && a.address).map((a) => a.address!);
        inviteStake = await requiredInvitationStake(chain, members);
        walletMsgs.push(inviteMsg(WALLET_SIGNER, operator, inviteStake));
      }
    }
    const balances = await queryJson(["query", "bank", "balances", operator], chain.rpc);
    const have = BigInt(
      (balances.balances ?? []).find((b: { denom: string }) => b.denom === chain.gasDenom)?.amount ?? "0",
    );
    // the bond + its tx fee, what granting the bridge's session key will
    // need spendable once the bond is locked, and a few whole tokens of
    // headroom so renewals do not come back asking for more (one ask, a round
    // amount: 1005 rather than 1000.000001 on a zero-gas-price devnet), plus
    // accepting its invitation's fee when it still has to join
    const headroom = 5n * 10n ** BigInt(spec.token.exponent ?? 6);
    const txFee = BigInt(Math.ceil(chain.gasPrice * 400_000));
    const need =
      (unbound
        ? BigInt(bond) + txFee + sessionReserve(chain.gasPrice, sessionSpendLimit(spec, "bridge")) + headroom
        : 0n) + (joining ? txFee : 0n);
    if (have < need) {
      walletMsgs.unshift({
        "@type": "/cosmos.bank.v1beta1.MsgSend",
        from_address: WALLET_SIGNER,
        to_address: operator,
        amount: [{ denom: chain.gasDenom, amount: (need - have).toString() }],
      });
    }
    if (walletMsgs.length > 0) {
      // one signature for both asks: any funded account may top it up, only
      // a member with an invitation credit may invite (or the CLI for either)
      const asks = [
        ...(have < need
          ? [`fund the bridge operator ${operator} with ${need - have} ${chain.gasDenom} (bond ${bond}, gas and its session key's reserve; it holds ${have})`]
          : []),
        ...(inviteStake ? [`invite the bridge operator ${operator} into x/rep (staking ${inviteStake} micro-DREAM)`] : []),
      ];
      throw await walletPause(ctx, stepName, chain, asks.join(", and "), walletMsgs, {
        signerRole: inviteStake
          ? `an active x/rep member with an invitation credit and ${inviteStake} micro-DREAM unlocked${have < need ? `, holding ${chain.gasDenom}` : ""}`
          : `an account holding ${chain.gasDenom}`,
        gas: 400_000 * walletMsgs.length,
      });
    }
  }
  if (joining) {
    const invitation = await pendingInvitation(chain, operator);
    if (!invitation) throw new Error(`no pending x/rep invitation for the bridge operator ${operator} on ${chain.chainId}`);
    await sendTx(ctx, operatorSigner, `${chain.chainId}-bridge-operator-join`, [
      {
        "@type": "/sparkdream.rep.v1.MsgAcceptInvitation",
        invitee: operator,
        invitation_id: String(invitation.id),
        // joining dedicates what the member publishes to the public domain
        accepted_content_license: "CC0-1.0",
      },
    ]);
    ctx.log(`mastodon: bridge operator ${operator} joined x/rep (invitation ${invitation.id})`);
  }
  if (unbound) {
    await sendAsOperator(ctx, operatorSigner, [
      {
        "@type": "/sparkdream.federation.v1.MsgRegisterBridge",
        operator,
        peer_id: domain,
        protocol: "activitypub",
        endpoint: `https://${domain}`,
        stake_amount: bond,
      },
    ]);
    ctx.log(`mastodon: bridge operator ${operator} bonded ${bond} for peer ${domain}`);
  }

  // 3b. the same operator for every other server: one binding each, on the
  //     bond it already holds (an existing operator binds with no new stake)
  for (const other of link.peers ?? []) {
    if (await bridgeBound(chain, operator, other.id)) continue;
    await sendAsOperator(ctx, operatorSigner, [
      {
        "@type": "/sparkdream.federation.v1.MsgRegisterBridge",
        operator,
        peer_id: other.id,
        protocol: "activitypub",
        endpoint: `https://${domain}`,
        stake_amount: "0",
      },
    ]);
    ctx.log(`mastodon: bridge operator ${operator} bound to peer ${other.id} on its existing bond`);
  }

  // 4. the bridge service gets its token and the peers it anchors for
  const tokenDelivered = await deliverBridgeEnv(ctx, stepName, access.component, {
    MASTODON_TOKEN: token,
    SDA_PEER_IDS: bridgePeerIds(spec).join(","),
  });
  if (tokenDelivered) ctx.log(`mastodon: bridge env delivered (peers ${bridgePeerIds(spec).join(", ")})`);
  return { peer, peers, operator, account, bonded: bond, tokenDelivered };
}

/** Where a bridge reaches its Mastodon instance, and which deployment runs it. */
export interface BridgeAccess {
  domain: string;
  /** mastodon-bootstrap on the instance's deployment. */
  bootstrap: (args: string[]) => Promise<Record<string, unknown>>;
  /** The component whose deployment runs the bridge service. */
  component: "mastodon" | "bridge";
}

/** The Mastodon component's own bridge (its sidecar). */
export function linkMastodonBridge(ctx: StepCtx, stepName: string, spec: LaunchSpec) {
  const domain = spec.topology.components.mastodon!.domain!;
  return linkBridge(ctx, stepName, spec, { domain, bootstrap: (args) => bootstrap(ctx, args), component: "mastodon" });
}

/**
 * A standalone bridge component: its Mastodon runs in another fleet of this
 * launcher (same wallet), reached through that fleet's deployment and
 * certificate; everything on chain is this fleet's.
 */
export async function linkStandaloneBridge(ctx: StepCtx, stepName: string, spec: LaunchSpec) {
  const target = spec.topology.components.bridge!.target;
  const launch = ctx.db.getLaunch(target.fleet);
  if (!launch) throw new Error(`the bridge's Mastodon fleet ${target.fleet} is not on this launcher`);
  const targetSpec = withDefaults(JSON.parse(launch.spec_json));
  const domain = targetSpec.topology.components.mastodon?.domain;
  if (!targetSpec.topology.components.mastodon?.enabled || !domain) {
    throw new Error(`fleet ${targetSpec.network.name} runs no Mastodon for the bridge to link`);
  }
  const row = (ctx.db.listFleetComponents(target.fleet) as FleetComponentRow[]).find(
    (c) => c.key === "mastodon" && c.state === "active",
  );
  if (!row) throw new Error(`fleet ${targetSpec.network.name}'s Mastodon is not running`);
  const lease = { hostUri: row.host_uri, dseq: row.dseq, gseq: 1, oseq: 1 };
  const cert = loadCertAt(launchDirs(ctx.workRoot, target.fleet).secrets);
  const run = (args: string[]) => bootstrapOn(ctx, lease, cert, args);
  const linked = await linkBridge(ctx, stepName, spec, { domain, bootstrap: run, component: "bridge" });
  // the instance's wallet sign-in now offers this chain too
  if (mastodonLoginDomain(targetSpec)) {
    await syncLoginChains(ctx, target.fleet, run, { id: ctx.launchId, spec });
  }
  return linked;
}

/** Sign and broadcast as the bridge operator (its own key). */
async function sendAsOperator(ctx: StepCtx, chain: ChainActor, msgs: unknown[]): Promise<void> {
  await sendTx(ctx, chain, `${chain.chainId}-register-bridge`, msgs);
}

/** Launch step: configure an enabled Mastodon (and link its bridge). */
export const configureMastodonStep: StepDef = {
  name: "configure-mastodon",
  async run(ctx) {
    const m = ctx.spec.topology.components.mastodon;
    if (!m?.enabled) return { skipped: true };
    const configured = await configureMastodon(ctx, "configure-mastodon", ctx.spec);
    const bridge = m.bridge?.enabled ? await linkMastodonBridge(ctx, "configure-mastodon", ctx.spec) : undefined;
    const session = bridge ? await ensureSession(ctx, ctx.spec, "bridge") : undefined;
    return { ...configured, ...(bridge ? { bridge: { ...bridge, session } } : {}) };
  },
};
