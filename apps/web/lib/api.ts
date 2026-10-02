import type { Msg } from "@sparkdream/akash-tx";

// kept in sessionStorage so a page reload doesn't force a re-sign; the
// conductor expires sessions after 12h regardless (auth.ts SESSION_TTL_MS)
const AUTH_TOKEN_KEY = "launcher.authToken";
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
  try {
    if (token) sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    else sessionStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // storage unavailable (private mode) — in-memory token still works
  }
}
/** Restore a persisted session token (if any) into memory and return it. */
export function loadAuthToken(): string | null {
  try {
    authToken = sessionStorage.getItem(AUTH_TOKEN_KEY) ?? authToken;
  } catch {
    // storage unavailable — keep whatever is in memory
  }
  return authToken;
}

/** fetch with the wallet-session bearer token attached (M6 §2). */
function afetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set("authorization", `Bearer ${authToken}`);
  return fetch(url, { ...init, headers });
}

export interface AuthMode {
  required: boolean;
}
export async function getAuthMode(): Promise<AuthMode> {
  return json(await fetch("/api/auth/mode"));
}
export async function authNonce(address: string): Promise<string> {
  return (await json<{ nonce: string }>(
    await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    }),
  )).nonce;
}
export async function authVerify(address: string, signature: unknown): Promise<string> {
  return (await json<{ token: string }>(
    await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature }),
    }),
  )).token;
}

export interface TmkmsSetup {
  chainId: string;
  validators: Array<{
    key: string;
    tailnetIp: string;
    tmkmsToml: string;
    /** Exported priv_validator_key.json; null when the spec pins a
     *  pre-existing pubkey (hardware signer holds the key). */
    consensusKey: unknown;
    /** Spec-pinned consensus pubkey the signer must hold, or null. */
    expectedPubkey: string | null;
    commands: string[];
  }>;
}
export async function getTmkmsSetup(id: string): Promise<TmkmsSetup> {
  return json(await afetch(`/api/launches/${id}/tmkms`));
}

export interface TmkmsStatus {
  externalNodes: Array<{ name: string; ip: string; online: boolean }>;
  validators: Array<{
    key: string;
    tailnetIp: string | null;
    /** true: a signer holds a privval session now; false: none; null: probe failed. */
    signerConnected: boolean | null;
    /** Spec-pinned consensus pubkey (hardware signer), or null. */
    expectedPubkey: string | null;
    /** null: unknown/not pinned; otherwise the connected signer's key vs the pin. */
    pubkeyMatches: boolean | null;
    /** Signer machines the validator's own tailscaled sees (read from local
     *  daemon state; nothing probes the signer machine through its firewall). */
    signerPeers: Array<{
      name: string;
      ip: string | null;
      online: boolean;
      /** the session to this validator moved traffic recently. */
      active: boolean;
      /** DERP region the session relays through; null when direct. */
      relay: string | null;
      txBytes: number;
      rxBytes: number;
      lastHandshake: string | null;
    }> | null;
    /** Validator↔relay latency in ms (netcheck, ~60s cache), null when unknown. */
    signerRelayMs: number | null;
    /** Slashing counters read from the chain; null when unknown. The panel
     *  diffs them between polls: 0 new blocks while connected = stalled signer. */
    missedBlocks: number | null;
    indexOffset: number | null;
  }>;
}
export async function getTmkmsStatus(id: string): Promise<TmkmsStatus> {
  return json(await afetch(`/api/launches/${id}/tmkms/status`));
}

export interface StepView {
  name: string;
  status: "pending" | "running" | "waiting" | "done" | "error";
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** A waiting step's transaction for the user's own wallet to sign. */
  wallet?: WalletRequest;
  /** Accounts to send money to before the step can go on (relayer keys). */
  funding?: FundingRequest[];
}

/** How the launcher's Keplr can send to a relayer key: a launcher fleet's
 *  chain (suggested from its public endpoints) or a chain Keplr knows by id. */
export type KeplrRoute =
  | { kind: "fleet"; chain: WalletRequest["chain"] }
  | { kind: "native"; chainId: string; rpc: string; gasPrice: number };

/** One relayer key to fund (amounts in base units of `denom`). */
export interface FundingRequest {
  chainId: string;
  address: string;
  denom: string;
  displayDenom: string;
  decimals: number;
  /** Suggested top-up. */
  amount: string;
  cap?: string;
  balance?: string;
  keplr?: KeplrRoute;
}

/** A relayer key with its live balance and what it needs. */
export interface RelayerFunds extends FundingRequest {
  status: "ok" | "low" | "empty" | "over-cap" | "unknown";
  error?: string;
  /** Its paths are configured but unopened (openWhenFunded). */
  waiting: boolean;
  launchId?: string;
}

/** A transaction on a fleet's chain the launcher cannot sign itself (it
 *  holds no key allowed to): the user's wallet signs it in the pause card. */
export interface WalletRequest {
  title: string;
  chain: {
    chainId: string;
    chainName: string;
    rpc: string;
    rest?: string;
    bech32Prefix: string;
    denom: string;
    displayDenom: string;
    decimals: number;
    gasPrice: number;
  };
  signerRole: string;
  /** The one address that must sign, when it matters who. */
  signer?: string;
  /** Proto-JSON, for display; "<signer>" stands for the wallet's address. */
  msgs: Array<Record<string, unknown>>;
  /** The same messages encoded by the chain binary (base64 Any values). */
  encoded: Array<{ typeUrl: string; value: string }>;
  gas?: number;
  minFee?: { denom: string; amount: string };
  cli?: string;
}

export interface LaunchView {
  id: string;
  status: "created" | "running" | "paused" | "completed" | "aborted";
  spec: unknown;
  steps: StepView[];
}

export interface PendingTx {
  step: string;
  msgs: Msg[];
  /** What enqueued this request, in plain language (the step name alone
   *  does not say which button produced it). */
  origin: string;
  /** fleet-action: dismissing cancels it. launch-step: the step re-enqueues
   *  an equivalent tx on the next resume. */
  kind: "fleet-action" | "launch-step";
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

export interface CostEstimate {
  /** Per single deployment of the role, USD/month. */
  perRole: Array<{ role: string; count: number; unitLowUsd: number; unitHighUsd: number }>;
  /** low = competitive bids (observed); high = stock provider bid script. */
  totalLowUsd: number;
  totalHighUsd: number;
  /** One-time launch service fee (feeBps of the leased monthly rate). */
  feeBps: number;
  feeLowUsd: number;
  feeHighUsd: number;
}

export interface FeeInfo {
  address: string;
  /** launch fee: basis points of the leased monthly rate. */
  launchBps: number;
  /** upgrade fee: flat micro-denom per upgrade op. */
  upgradeFlat: number;
  /** top-up fee: basis points of the deposit amount. */
  topupBps: number;
}

/** The service fee schedule (so day-2 dialogs show exact amounts). */
export async function getFee(): Promise<FeeInfo> {
  return json(await afetch("/api/fee"));
}

/** §13 chain-asset visibility + resolution preview for the launch panel. */
export interface ChainAssetsView {
  /** baked = Offline, fetch = Online. */
  mode: "baked" | "fetch";
  /** True when CHAIN_ASSET_MODE env pins the mode — the toggle renders locked. */
  locked: boolean;
  bakedVersion: string;
  /** Release-manifest versions this launcher build knows, newest first. */
  knownVersions: string[];
  cached: {
    image: string;
    commit?: string;
    via: string;
    dirty: boolean;
    lastUsedAt: string;
    complete: boolean;
  }[];
  /** Only with ?image=: what prepare-chain-assets would do for it. */
  resolution?:
    | "baked"
    | "cache"
    | "release"
    | "tag"
    | "pin"
    | "prompt"
    | "unavailable"
    | "unknown";
  commit?: string;
  headCommit?: string | null;
}

export async function getChainAssets(image?: string, pin?: string): Promise<ChainAssetsView> {
  const q = new URLSearchParams();
  if (image) q.set("image", image);
  if (pin) q.set("pin", pin);
  const qs = q.toString();
  return json(await afetch(`/api/chain-assets${qs ? `?${qs}` : ""}`));
}

/** Flip the Offline/Online toggle (409 when env-locked). */
export async function setChainAssetsMode(mode: "baked" | "fetch"): Promise<void> {
  await json(
    await afetch("/api/chain-assets/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  );
}

/** Market-based running-cost estimate for a spec (pre-launch, no wallet). */
export async function postEstimate(spec: unknown): Promise<CostEstimate> {
  return json(
    await afetch("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec }),
    }),
  );
}

export async function createLaunch(spec: unknown, owner: string): Promise<{ id: string; warnings: { path: string; message: string }[] }> {
  return json(
    await afetch("/api/launches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, owner }),
    }),
  );
}

export async function getLaunch(id: string): Promise<LaunchView> {
  return json(await afetch(`/api/launches/${id}`));
}

export async function startLaunch(id: string): Promise<void> {
  await json(await afetch(`/api/launches/${id}/start`, { method: "POST" }));
}

export async function resumeLaunch(id: string): Promise<void> {
  await json(await afetch(`/api/launches/${id}/resume`, { method: "POST" }));
}

export async function getPendingTx(id: string): Promise<PendingTx | null> {
  const res = await afetch(`/api/launches/${id}/pending-tx`);
  if (res.status === 204) return null;
  return json(res);
}

/** Drop the queued signature request without signing it. `step` is the one
 *  the banner displayed: the server refuses if the queue has moved on. */
export async function discardPendingTx(
  id: string,
  step: string,
): Promise<{ status: string; step: string; kind: PendingTx["kind"] }> {
  return json(
    await afetch(`/api/launches/${id}/pending-tx?step=${encodeURIComponent(step)}`, {
      method: "DELETE",
    }),
  );
}

export async function postTxResult(id: string, txHash: string): Promise<void> {
  await json(
    await afetch(`/api/launches/${id}/tx-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    }),
  );
}

export interface PendingGentx {
  valIndex: number;
  address: string;
  signDoc: unknown;
  /** The same doc as an unsigned tx file for airgapped `tx sign --offline`. */
  unsignedTx?: unknown;
  /** The exact offline signing command (chain id / account number / sequence filled in). */
  signCommand?: string;
}

export async function getPendingGentx(id: string): Promise<PendingGentx | null> {
  const res = await afetch(`/api/launches/${id}/pending-gentx`);
  if (res.status === 204) return null;
  return json(res);
}

export interface ComponentView {
  key: string;
  dseq: string;
  provider: string;
  providerName: string;
  priceDenom: string;
  escrow?: string | null;
  price: string;
  state: string;
  /** Deployed image reference (upgrades update it). */
  image?: string | null;
  /** Address on the headscale mesh (100.x), when the component joined it. */
  tailnetIp?: string | null;
  /** True when the component runs sshd with a recorded endpoint — eligible
   *  for the upload-file action (nodes + explorer). */
  ssh?: boolean;
  health?: { status: string; detail: string | null; checked_at: string };
}

export interface FleetSummary {
  fleets: Array<{
    launchId: string;
    launchStatus: string;
    /** The spec's network name (distinguishes fleets sharing a chain id). */
    name: string;
    /** "services": a fleet of shared components with no chain of its own. */
    kind?: "chain" | "services";
    chainId: string;
    /** softsign | tmkms — signer-related actions are gated on this. */
    keyMode: string;
    components: ComponentView[];
    ops: Array<{
      id: number;
      kind: string;
      status: string;
      params: OpParams;
      progress?: OpProgress;
    }>;
    /** Placements the launch itself is holding for a manual bid pick. */
    bidPicks: Array<{ key: string; dseq: string; bids: OfferedBid[] }>;
    /** The daemons' session keys: what was granted, never the key. */
    sessions?: SessionView[];
  }>;
  unmanaged: Array<{ dseq: string; state: string }>;
}

/** A bid offered to the manual picker of a parked relaunch. */
export interface OfferedBid {
  provider: string;
  hostUri: string;
  /** Micro-denom per block, as the chain quotes lease prices. */
  price: string;
  priceDenom: string;
  audited: boolean;
  uptime7d: number;
  /** Why the selection policy passed it over; absent if the policy accepted it. */
  rejected?: string;
  /** The bid the policy would have leased on its own. */
  autoPick?: boolean;
}

/** Op params, as far as the UI reads them (manual bid selection). */
export interface OpParams {
  key?: string;
  manualBid?: boolean;
  bidChoice?: { dseq: string; provider: string };
  offeredBids?: { dseq: string; bids: OfferedBid[] };
}

/** Live position of a long-running op (the archive replay reports one). */
export interface OpProgress {
  label: string;
  current?: number;
  target?: number;
  percent?: number;
  /** Units per second (blocks/s for a replay). */
  rate?: number;
  etaSeconds?: number;
  elapsedSeconds?: number;
  updatedAt: string;
}

export async function getFleet(owner: string): Promise<FleetSummary> {
  return json(await afetch(`/api/fleet?owner=${encodeURIComponent(owner)}`));
}

export type FleetAction =
  | "close"
  | "restart"
  /** Move to another provider: a fleet op once the launch has finished, or a
   *  re-placement through the launch itself while it is still running. */
  | "relaunch"
  | "upgrade"
  | "halt-upgrade"
  | "topup"
  | "unjail"
  /** tmkms validator whose signer stalled it: gate on the session, restart
   *  the process in place, watch it sign again. */
  | "resume-signing"
  /** Rebuild block history from uploaded archive files: stop the node, run
   *  replay-from-archive detached, watch it, start the node again. */
  | "restore-archive"
  /** Re-aim stale mesh links (tunnel env, persistent_peers) at the fleet's
   *  current tailnet addresses, in place — no redeploy. */
  | "repair"
  /** Make the provider re-create a component's container from its current
   *  manifest (nonce-bumped so the manifest is genuinely new). For a
   *  deployment that is already correct while the container never was. */
  | "force-redeploy"
  /** Reset halt-height to 0 across the chain nodes: the recovery path for a
   *  halt-height upgrade abandoned before it cleared the setting itself. */
  | "clear-halt-height"
  /** Wipe a node's chain data and leave it stopped (the empty database a
   *  from-genesis restore replays into). */
  | "reset-data"
  /** Mastodon: move to a deployment of another size, data and all. */
  | "resize"
  /** Mastodon: registrations and wallet sign-in (turning sign-in on or off
   *  moves the instance, as a resize does). */
  | "mastodon-settings"
  /** Mastodon: the other servers its bridge anchors for as their own peers. */
  | "bridge-peers"
  /** A closed service component: drop it from the fleet and the spec. */
  | "remove";

export async function postFleetAction(
  launchId: string,
  dseq: string,
  action: FleetAction,
  extra: {
    confirm?: boolean;
    image?: string;
    components?: string[];
    amount?: string;
    haltHeight?: number;
    manualBid?: boolean;
    archiveDir?: string;
    validate?: boolean;
    endHeight?: number;
    size?: "small" | "standard";
    peers?: string[];
    registrations?: "open" | "approved" | "none";
    walletLogin?: { enabled: boolean; minTrustLevel?: string; domain?: string };
  } = {},
): Promise<{ status?: string; note?: string; warnings?: string[]; confirmPrompt?: string; error?: string }> {
  const res = await afetch(`/api/fleet/${launchId}/${dseq}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  // 409 carries either pre-action warnings (confirmable) or a refusal error
  if (res.status === 409) {
    return res.json() as Promise<{ warnings?: string[]; confirmPrompt?: string; error?: string }>;
  }
  return json(res);
}

export async function getComponentLogs(
  launchId: string,
  dseq: string,
  tail = 100,
): Promise<string> {
  const res = await afetch(`/api/fleet/${launchId}/${dseq}/logs?tail=${tail}`);
  if (!res.ok) throw new Error(`logs: HTTP ${res.status}`);
  return res.text();
}

async function downloadBlob(res: Response, filename: string): Promise<void> {
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The rendered SDL a component was deployed with (paste into Console). */
export async function downloadComponentSdl(
  launchId: string,
  dseq: string,
  key: string,
): Promise<void> {
  const res = await afetch(`/api/fleet/${launchId}/${dseq}/sdl`);
  if (!res.ok) throw new Error(`sdl: HTTP ${res.status}`);
  await downloadBlob(res, `${key}.sdl.yaml`);
}

/** The chain's genesis.json (identical for every node). */
export async function downloadGenesis(launchId: string, chainId: string): Promise<void> {
  const res = await afetch(`/api/launches/${launchId}/genesis`);
  if (!res.ok) throw new Error(`genesis: HTTP ${res.status}`);
  await downloadBlob(res, `${chainId}-genesis.json`);
}

/**
 * The public join bundle (§5): chain identity, genesis sha256, sentry peer
 * strings, and state-sync RPCs — what a third-party operator pastes into
 * their own launcher's spec `join` block.
 */
export async function downloadJoinBundle(launchId: string, chainId: string): Promise<void> {
  const res = await afetch(`/api/fleet/${launchId}/join-bundle`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `join bundle: HTTP ${res.status}`);
  }
  await downloadBlob(res, `${chainId}-join-bundle.json`);
}

/** Shut the whole fleet down — one batched close tx via the signing loop. */
export async function postFleetShutdown(
  launchId: string,
): Promise<{ step: string; closing: string[] }> {
  return json(await afetch(`/api/fleet/${launchId}/shutdown`, { method: "POST" }));
}

export interface AccountView {
  name: string;
  address: string;
  hasMnemonic: boolean;
}

/** Named accounts generated at launch (addresses only — no seeds). */
export async function getFleetAccounts(launchId: string): Promise<{ accounts: AccountView[] }> {
  return json(await afetch(`/api/fleet/${launchId}/accounts`));
}

/** Reveal one account's mnemonic (launch-scoped, per-account). */
export async function getAccountMnemonic(
  launchId: string,
  name: string,
): Promise<{ mnemonic: string }> {
  return json(await afetch(`/api/fleet/${launchId}/accounts/${encodeURIComponent(name)}/mnemonic`));
}

/** Permanently delete a shut-down launch (records + secrets on the conductor). */
export async function deleteLaunch(id: string): Promise<{ status: string }> {
  return json(await afetch(`/api/launches/${id}`, { method: "DELETE" }));
}

/** Change component domains / public endpoints after launch (retarget op). */
export async function postDomainUpdate(
  launchId: string,
  changes: {
    explorer?: string;
    frontend?: string;
    api?: string;
    rpc?: string;
    explorerRoute?: string;
  },
): Promise<{ status: string; opId: number }> {
  return json(
    await afetch(`/api/fleet/${launchId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    }),
  );
}

/** Add a service component to a running fleet (add-component op). */
export async function postAddComponent(
  launchId: string,
  body: { key: string; domain?: string; image?: string; paths?: unknown[]; settings?: Record<string, unknown> },
): Promise<{ status: string; opId: number }> {
  return json(
    await afetch(`/api/fleet/${launchId}/components`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The relayer's address per chain and the channels its last link opened. */
export interface RelayerState {
  /** balance/cap: the key's gas balance at the last link, and the most it
   *  should hold (the key sits on the relayer's provider). */
  chains: Array<{ chainId: string; address: string; launchId?: string; balance?: string; denom?: string; cap?: string }>;
  channels: Array<{
    id: string;
    port: string;
    version: string;
    a: { chain: string; channel: string };
    b: { chain: string; channel: string };
  }>;
  linkedAt: string;
  /** openWhenFunded paths left unopened because the relayer's key on their
   *  chain held nothing at the last link: fund it, then relink. */
  waiting?: Array<{ chainId: string; paths: string[]; address: string; denom: string; amount: string; cap?: string }>;
  /** Federation peers' status on each chain (x/federation), once linked. */
  peers?: Array<{ chainId: string; peerId: string; status: string; ibcChannelId?: string }>;
}

export async function getRelayerState(launchId: string): Promise<RelayerState> {
  return json(await afetch(`/api/fleet/${launchId}/relayer`));
}

/** A daemon's session grant (§5 session keys). */
export interface SessionView {
  role: "verifier" | "bridge" | string;
  grantee: string;
  granter: string;
  chainId: string;
  dseq: string;
  createdAt: string;
  expiresAt: string;
  renewAt: string;
  spendLimit: string;
  maxExecCount: number;
  pendingRevoke?: string[];
}

/** Rotate a daemon's session key now (sessions op); every one when no role. */
export async function postRotateSessions(
  launchId: string,
  role?: "verifier" | "bridge",
): Promise<{ status: string; opId: number }> {
  return json(
    await afetch(`/api/fleet/${launchId}/sessions/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(role ? { role } : {}),
    }),
  );
}

/** Every relayer key with its live balance (funds panel). */
export async function getRelayerFunds(launchId: string): Promise<RelayerFunds[]> {
  return (await json<{ funds: RelayerFunds[] }>(await afetch(`/api/fleet/${launchId}/relayer/funds`))).funds;
}

/** Send a relayer key's balance on one chain, less the fee, to `to` (the
 *  owner's own address there when omitted). */
export async function postRelayerWithdraw(
  launchId: string,
  chainId: string,
  to?: string,
): Promise<{ txHash: string; amount: string; denom: string; to: string }> {
  return json(
    await afetch(`/api/fleet/${launchId}/relayer/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, ...(to ? { to } : {}) }),
    }),
  );
}

/** Re-link the relayer (relink op), after a chain reset on either end. */
export async function postRelink(launchId: string): Promise<{ status: string; opId: number }> {
  return json(await afetch(`/api/fleet/${launchId}/relink`, { method: "POST" }));
}

/** Replace a running relayer's paths (relayer-paths op): add or drop chains.
 *  With maxBalance, the Spark Dream key cap too; a cap change alone saves
 *  without an op (status "relayer-settings-saved", no opId). */
export async function postRelayerPaths(
  launchId: string,
  paths: unknown[],
  maxBalance?: string,
): Promise<{ status: string; opId?: number }> {
  return json(
    await afetch(`/api/fleet/${launchId}/relayer/paths`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(maxBalance !== undefined ? { paths, maxBalance } : { paths }),
    }),
  );
}

/** A path's far end given by endpoints (the spec's endpoint counterparty). */
export interface EndpointCounterparty {
  chainId: string;
  rpc: string;
  grpc: string;
  ws?: string;
  lcd?: string;
  bech32Prefix: string;
  gasDenom: string;
  gasPrice: number;
  dynamicGasPrice?: { multiplier: number; max: number };
  gasMultiplier?: number;
  eventSource?: "push" | "pull";
  hdPath?: string;
  trustingPeriod?: string;
  maxBalance?: string;
}

/** One relayer path as the spec holds it. */
export interface RelayerPathSpec {
  id: string;
  kind: "transfer" | "federation";
  counterparty: { fleet: string; via?: "mesh" | "public" } | EndpointCounterparty;
  openWhenFunded?: boolean;
}

/** A fleet on this launcher a path could lead to. */
export interface SisterFleet {
  launchId: string;
  name: string;
  displayName: string;
  chainId: string;
  networkType: string;
  /** mesh: over the shared tailnet; public: over its sentry's forwarded
   *  ports, opened by the first link (one signature). */
  route: "mesh" | "public";
  eligible: boolean;
  reason?: string;
  /** The launcher holds its founder key (signs its end of a federation peer). */
  founderHeld: boolean;
  /** Its wallet, when not this fleet's (it shared with this one): that wallet
   *  signs opening its gRPC, in its own panel. */
  otherWallet?: string;
}

export interface ChainPreset {
  id: string;
  label: string;
  /** Real money pays this chain's gas. */
  paid: boolean;
  symbol: string;
  counterparty: EndpointCounterparty;
}

/** Everything the relayer settings editor starts from. */
export interface RelayerSettings {
  chainId: string;
  /** The launcher holds this chain's founder key (signs its federation peer). */
  founderHeld: boolean;
  symbol: string;
  decimals: number;
  paths: RelayerPathSpec[];
  maxBalance: string | null;
  genesisBalance: string | null;
  state: RelayerState | null;
  sisters: SisterFleet[];
  presets: ChainPreset[];
  peerPolicy: { contentTypes: string[]; ratePerEpoch: number; reputation: boolean; requireReview: boolean };
}

export async function getRelayerSettings(launchId: string): Promise<RelayerSettings> {
  return json(await afetch(`/api/fleet/${launchId}/relayer/settings`));
}

/** What a chain's endpoints say about it (the settings editor's Detect). */
export interface DetectedChain {
  chainId: string;
  bech32Prefix?: string;
  gasDenom?: string;
  gasPrice?: number;
  /** Runs x/federation: a Spark Dream chain. */
  federation: boolean;
  identity?: string;
  notes: string[];
}

export async function detectChain(rpc: string, lcd?: string): Promise<DetectedChain> {
  return json(
    await afetch("/api/relayer/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lcd ? { rpc, lcd } : { rpc }),
    }),
  );
}

/** Wipe the chain and restart from a rebuilt genesis on the same
 *  deployments (reset-chain op): the posted spec replaces the stored one. */
export async function postChainReset(
  launchId: string,
  spec: unknown,
): Promise<{ status: string; opId: number }> {
  return json(
    await afetch(`/api/fleet/${launchId}/reset-chain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec }),
    }),
  );
}

/** Live block height of a node's RPC (for a real-time indicator). */
/** A chain node's height: its own RPC (`source: "node"`), or, for a
 *  validator whose provider could not be reached, the chain's latest commit
 *  read through a sentry, with whether the validator signed it. */
export interface NodeHeight {
  height: number;
  catchingUp: boolean;
  source?: "node" | "chain";
  signed?: boolean;
  providerError?: string;
}

export async function getComponentHeight(
  launchId: string,
  dseq: string,
): Promise<NodeHeight> {
  return json(await afetch(`/api/fleet/${launchId}/${dseq}/height`));
}

/** Abandon a stuck op (e.g. relaunch on a broken provider). */
export async function postAbortOp(
  launchId: string,
  opId: number,
): Promise<{ status: string; step?: string; warning?: string }> {
  return json(await afetch(`/api/fleet/${launchId}/ops/${opId}/abort`, { method: "POST" }));
}

/** Name the bid the launch's own re-place step should lease. */
export async function postChooseLaunchBid(
  launchId: string,
  key: string,
  provider: string,
): Promise<{ status: string; key: string; provider: string }> {
  return json(
    await afetch(`/api/fleet/${launchId}/bid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, provider }),
    }),
  );
}

/** Name the bid a relaunch parked on manual selection should lease. */
export async function postChooseBid(
  launchId: string,
  opId: number,
  provider: string,
): Promise<{ status: string; key: string; provider: string }> {
  return json(
    await afetch(`/api/fleet/${launchId}/ops/${opId}/bid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    }),
  );
}

export interface ProviderPrefs {
  avoid: string[];
  prefer: string[];
  /** provider address → human-readable name, for display. */
  names: Record<string, string>;
}
export async function getProviderPrefs(launchId: string): Promise<ProviderPrefs> {
  return json(await afetch(`/api/fleet/${launchId}/provider-prefs`));
}
/** Add/remove a provider on this fleet's avoid or prefer list. */
export async function setProviderPref(
  launchId: string,
  provider: string,
  kind: "avoid" | "prefer" | "none",
  name?: string,
): Promise<ProviderPrefs> {
  return json(
    await afetch(`/api/fleet/${launchId}/provider-prefs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, kind, name }),
    }),
  );
}

/** Bundle export needs the bearer token, so it can't be a plain link. */
export async function downloadFleetBundle(launchId: string): Promise<void> {
  const res = await afetch(`/api/fleet/${launchId}/bundle`);
  if (!res.ok) throw new Error(`bundle: HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `fleet-${launchId.slice(0, 8)}.tar.age`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Download a passphrase-encrypted backup of the whole launcher. */
export async function exportLauncherBackup(passphrase: string): Promise<void> {
  const res = await afetch("/api/backup/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `backup: HTTP ${res.status}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `launcher-backup-${stamp}.tar.gz.enc`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface BackupImportReport {
  restored: string[];
  skipped: string[];
  settingsAdded: string[];
  prefsAdded: number;
}

/** Restore launches from a backup file; existing launches are left alone. */
export async function importLauncherBackup(
  file: File,
  passphrase: string,
): Promise<BackupImportReport> {
  const res = await afetch("/api/backup/import", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-backup-passphrase": passphrase },
    body: file,
  });
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({})))?.error ?? `restore: HTTP ${res.status}`);
  }
  return res.json();
}

/** Push a file into a component's container. The bytes are written verbatim
 *  into the component's upload directory (/root/.sparkdream for nodes, /data
 *  for the explorer); returns the remote path. */
export async function uploadToComponent(
  launchId: string,
  key: string,
  file: File,
): Promise<{ remotePath: string }> {
  const res = await afetch(`/api/fleet/${launchId}/components/${encodeURIComponent(key)}/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-filename": file.name },
    body: file,
  });
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({})))?.error ?? `upload: HTTP ${res.status}`);
  }
  return res.json();
}

export async function postGentxResult(
  id: string,
  valIndex: number,
  response: unknown,
): Promise<void> {
  await json(
    await afetch(`/api/launches/${id}/gentx-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ valIndex, response }),
    }),
  );
}

export interface SpecPrefill {
  spec: unknown;
  notes: string[];
  issues: Array<{ path: string; message: string; warning?: boolean }>;
}

/** Reverse-map a genesis.json into a spec draft + caveat notes (editor helper). */
export async function postSpecPrefill(genesis: unknown): Promise<SpecPrefill> {
  return json(
    await afetch(`/api/spec-prefill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ genesis }),
    }),
  );
}

/**
 * "Prefill spec from join bundle" (§5): fan a published join bundle out
 * into the four places its fields live in a spec, as a reviewable draft.
 */
export async function postJoinPrefill(bundle: unknown): Promise<SpecPrefill> {
  return json(
    await afetch(`/api/join-prefill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle }),
    }),
  );
}

/** Set the wallets a services fleet is shared with (its card's "share…"). */
export async function postFleetSharing(launchId: string, wallets: string[]): Promise<{ wallets: string[] }> {
  const res = await afetch(`/api/fleet/${launchId}/sharing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallets }),
  });
  const body = (await res.json().catch(() => null)) as { wallets?: string[]; error?: string } | null;
  if (!res.ok || !body?.wallets) throw new Error(body?.error ?? `sharing: HTTP ${res.status}`);
  return { wallets: body.wallets };
}

/** A services fleet spec draft from scratch (the launch card's action). */
export async function postServicesSpec(draft: {
  name: string;
  domain: string;
  streamingDomain?: string;
  owner: { username: string; email: string };
  size?: "small" | "standard";
  type?: "devnet" | "testnet" | "mainnet";
  sharing?: string[];
}): Promise<SpecPrefill> {
  const res = await afetch(`/api/services-spec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `services spec: HTTP ${res.status}`);
  }
  return res.json() as Promise<SpecPrefill>;
}

/**
 * A services fleet spec draft (kind: services) from THIS fleet's Mastodon
 * settings, under a new fleet name and domain. The SMTP password is named
 * by source fleet and copied server-side, never sent to the browser.
 */
export async function getServicesSpec(
  launchId: string,
  opts: { name: string; domain: string; streamingDomain?: string; sharing?: string[] },
): Promise<SpecPrefill> {
  const q = new URLSearchParams({
    name: opts.name,
    domain: opts.domain,
    ...(opts.streamingDomain ? { streamingDomain: opts.streamingDomain } : {}),
    ...(opts.sharing?.length ? { sharing: opts.sharing.join(",") } : {}),
  });
  const res = await afetch(`/api/fleet/${launchId}/services-spec?${q}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `services spec: HTTP ${res.status}`);
  }
  return res.json() as Promise<SpecPrefill>;
}

/**
 * A join spec draft for expanding THIS fleet's chain: its own spec minus
 * everything the running fleet already holds, plus the live join block.
 */
export async function getFleetJoinSpec(launchId: string): Promise<SpecPrefill> {
  const res = await afetch(`/api/fleet/${launchId}/join-spec`);
  if (!res.ok) {
    // the 409 here is the bundle's own refusal (no public p2p port, one
    // RPC), which reads as guidance, not as an HTTP failure
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `join spec: HTTP ${res.status}`);
  }
  return res.json() as Promise<SpecPrefill>;
}

/** Offline path: submit a pasted `tx sign --offline` output instead of a wallet response. */
export async function postSignedGentxTx(
  id: string,
  valIndex: number,
  signedTx: unknown,
): Promise<void> {
  await json(
    await afetch(`/api/launches/${id}/gentx-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ valIndex, signedTx }),
    }),
  );
}
