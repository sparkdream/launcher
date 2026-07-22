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
  health?: { status: string; detail: string | null; checked_at: string };
}

export interface FleetSummary {
  fleets: Array<{
    launchId: string;
    launchStatus: string;
    /** The spec's network name (distinguishes fleets sharing a chain id). */
    name: string;
    chainId: string;
    /** softsign | tmkms — signer-related actions are gated on this. */
    keyMode: string;
    components: ComponentView[];
    ops: Array<{ id: number; kind: string; status: string; params: unknown }>;
  }>;
  unmanaged: Array<{ dseq: string; state: string }>;
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
  | "resume-signing";

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
export async function getComponentHeight(
  launchId: string,
  dseq: string,
): Promise<{ height: number; catchingUp: boolean }> {
  return json(await afetch(`/api/fleet/${launchId}/${dseq}/height`));
}

/** Abandon a stuck op (e.g. relaunch on a broken provider). */
export async function postAbortOp(
  launchId: string,
  opId: number,
): Promise<{ status: string; step?: string; warning?: string }> {
  return json(await afetch(`/api/fleet/${launchId}/ops/${opId}/abort`, { method: "POST" }));
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
