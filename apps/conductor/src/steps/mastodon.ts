import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import { TypeUrl } from "../akash/messages.js";
import { loadSdl, sdlArtifacts } from "../akash/sdl-groups.js";
import { setServiceEnv } from "../components/index.js";
import { bridgePeerIds } from "../components/mastodon.js";
import {
  BRIDGE_OPERATOR,
  readMastodonSecrets,
  updateMastodonSecrets,
  writeBridgeOperatorAddress,
} from "../components/mastodon-secrets.js";
import { WALLET_SIGNER, type StepCtx, type StepDef } from "../engine.js";
import { sparkdreamd } from "../exec.js";
import { ensurePeerActive, walletPause, fleetActor, sendTx, type ChainActor, type PeerStatus } from "../peering.js";
import { readSecretFile, writeSecretFile } from "../secrets.js";
import { componentLease, ensureSession, sessionReserve, sessionSpendLimit } from "../sessions.js";
import { loadCert } from "./phase-bcd.js";
import { pushManifest } from "./phase-ef.js";
import { queryJson } from "./phase-g.js";

/**
 * The mastodon component, once placed and healthy (§5 mastodon):
 *
 *   configure-mastodon  the Owner account (its password kept for the fleet's
 *                       accounts panel: the only time it is ever shown) and
 *                       the registrations mode
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
  const lease = mastodonLease(ctx);
  let lastError = "";
  // the web container may still be preparing its schema right after a
  // (re)placement: rails runner cannot connect until it is done
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt > 0) await ctx.services.sleep(15_000);
    try {
      const { stdout } = await ctx.services.provider.shellExec(
        loadCert(ctx), lease.hostUri, lease.dseq, lease.gseq, lease.oseq, "mastodon",
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
  return { owner: `@${owner.username}@${m.domain}`, created: res.created === true, registrations: m.registrations };
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
export async function ensureBridgeOperatorKey(secretsDir: string, masterHome: string): Promise<string> {
  const file = path.join(secretsDir, "mnemonics.json");
  const all: Record<string, string> = fs.existsSync(file) ? JSON.parse(readSecretFile(file)) : {};
  const keyring = ["--keyring-backend", "test", "--home", masterHome];
  if (all[BRIDGE_OPERATOR]) {
    const shown = await sparkdreamd(["keys", "show", BRIDGE_OPERATOR, "-a", ...keyring]).catch(() => undefined);
    if (!shown) {
      // the mnemonic on stdin: never in argv, never in an error message
      await sparkdreamd(["keys", "add", BRIDGE_OPERATOR, "--recover", ...keyring, "--output", "json"], {
        input: `${all[BRIDGE_OPERATOR]}\n`,
      });
    }
    const { stdout } = shown ?? (await sparkdreamd(["keys", "show", BRIDGE_OPERATOR, "-a", ...keyring]));
    writeBridgeOperatorAddress(secretsDir, stdout.trim());
    return stdout.trim();
  }
  await sparkdreamd(["keys", "delete", BRIDGE_OPERATOR, "-y", ...keyring]).catch(() => undefined);
  const { stdout } = await sparkdreamd(["keys", "add", BRIDGE_OPERATOR, ...keyring, "--output", "json"]);
  const parsed = JSON.parse(stdout) as { address: string; mnemonic: string };
  all[BRIDGE_OPERATOR] = parsed.mnemonic;
  writeSecretFile(file, JSON.stringify(all, null, 2));
  writeBridgeOperatorAddress(secretsDir, parsed.address);
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

/** Put the issued token and the peer list into the bridge service's env:
 *  one deployment update, after which the bridge leaves its idle loop for
 *  sdapbridge (or restarts with the peers it now watches). */
async function deliverBridgeEnv(ctx: StepCtx, stepName: string, want: Record<string, string>): Promise<boolean> {
  const lease = mastodonLease(ctx);
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

  const sdlPath = path.join(ctx.dirs.sdl, "mastodon.yaml");
  const doc = yaml.load(fs.readFileSync(sdlPath, "utf8")) as any;
  const env = (doc.services?.bridge?.env as string[] | undefined) ?? [];
  if (keys.some((k) => !env.includes(`${k}=${want[k]}`))) {
    setServiceEnv(doc, ["bridge"], want);
    fs.writeFileSync(sdlPath, yaml.dump(doc, { lineWidth: 120 }));
  }
  const artifacts = sdlArtifacts(loadSdl(sdlPath));
  fs.writeFileSync(path.join(ctx.dirs.sdl, "mastodon.manifest.json"), artifacts.manifestJson);
  const owner = ctx.db.getLaunch(ctx.launchId)!.owner;
  const wantHash = Buffer.from(artifacts.hash).toString("base64");
  const onChain = await ctx.services.api.deploymentInfo(owner, lease.dseq);
  if (onChain?.hash !== wantHash) {
    await ctx.requireTx(`${stepName}:update`, [
      { typeUrl: TypeUrl.UpdateDeployment, value: { id: { owner, dseq: lease.dseq }, hash: wantHash } },
    ]);
  }
  await pushManifest(ctx, loadCert(ctx), "mastodon", lease.hostUri, lease.dseq, artifacts.manifestJson);
  return true;
}

export async function linkMastodonBridge(
  ctx: StepCtx,
  stepName: string,
  spec: LaunchSpec,
): Promise<{ peer: PeerStatus; peers: PeerStatus[]; operator: string; bonded: string; tokenDelivered: boolean }> {
  const m = spec.topology.components.mastodon!;
  const domain = m.domain!;
  const chain = await fleetActor(ctx, ctx.launchId, "this fleet");

  // 1. the instance as an ActivityPub peer: its domain is the peer id, so
  //    AS2 ids on that host are this peer's content (no content_hosts needed)
  const peer = await ensurePeerActive(ctx, stepName, chain, {
    id: domain,
    type: "PEER_TYPE_ACTIVITYPUB",
    displayName: domain,
    policy: activityPubPeerPolicy(m.bridge?.authors),
    // only a spec that names its authors keeps them in sync: otherwise the
    // committee's edits in the frontend would be undone on the next run
    ...(m.bridge?.authors ? { syncPolicy: BRIDGE_AUTHOR_FIELDS } : {}),
  });

  // 1b. other servers bridged as peers of their own (bridge.peers): closed
  //     until the community opens them, unless the spec names their authors
  const peers: PeerStatus[] = [];
  for (const other of m.bridge?.peers ?? []) {
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
  const res = await bootstrap(ctx, ["bridge-token", "bridge", `bridge@${domain}`]);
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
  if (!(await bridgeBound(chain, operator, domain))) {
    const balances = await queryJson(["query", "bank", "balances", operator], chain.rpc);
    const have = BigInt(
      (balances.balances ?? []).find((b: { denom: string }) => b.denom === chain.gasDenom)?.amount ?? "0",
    );
    // the bond + its tx fee, what granting the bridge's session key will
    // need spendable once the bond is locked, and a few whole tokens of
    // headroom so renewals do not come back asking for more (one ask, a round
    // amount: 1005 rather than 1000.000001 on a zero-gas-price devnet)
    const headroom = 5n * 10n ** BigInt(spec.token.exponent ?? 6);
    const need =
      BigInt(bond) +
      BigInt(Math.ceil(chain.gasPrice * 400_000)) +
      sessionReserve(chain.gasPrice, sessionSpendLimit(spec, "bridge")) +
      headroom;
    if (have < need) {
      // any funded account may top it up: a wallet send, or the CLI
      throw await walletPause(
        ctx,
        stepName,
        chain,
        `fund the bridge operator ${operator} with ${need - have} ${chain.gasDenom} (bond ${bond}, gas and its session key's reserve; it holds ${have})`,
        [
          {
            "@type": "/cosmos.bank.v1beta1.MsgSend",
            from_address: WALLET_SIGNER,
            to_address: operator,
            amount: [{ denom: chain.gasDenom, amount: (need - have).toString() }],
          },
        ],
        { signerRole: `an account holding ${chain.gasDenom}` },
      );
    }
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
  for (const other of m.bridge?.peers ?? []) {
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
  const tokenDelivered = await deliverBridgeEnv(ctx, stepName, {
    MASTODON_TOKEN: token,
    SDA_PEER_IDS: bridgePeerIds(spec).join(","),
  });
  if (tokenDelivered) ctx.log(`mastodon: bridge env delivered (peers ${bridgePeerIds(spec).join(", ")})`);
  return { peer, peers, operator, bonded: bond, tokenDelivered };
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
