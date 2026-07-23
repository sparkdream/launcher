"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, mintActMsg, toEncodeObject } from "@sparkdream/akash-tx";
import { checkSpec, type SpecCheck } from "@sparkdream/launch-spec";
import yaml from "js-yaml";
import { specPathLine } from "../lib/spec-lines";
import {
  createLaunch,
  exportLauncherBackup,
  getChainAssets,
  getFleet,
  getLaunch,
  getPendingGentx,
  getPendingTx,
  importLauncherBackup,
  postFleetAction,
  postGentxResult,
  postSignedGentxTx,
  postTxResult,
  resumeLaunch,
  startLaunch,
  setChainAssetsMode,
  type AccountView,
  type BackupImportReport,
  type ChainAssetsView,
  type ComponentView,
  type CostEstimate,
  type FeeInfo,
  type FleetSummary,
  type LaunchView,
  type PendingGentx,
  type PendingTx,
} from "../lib/api";
import {
  connectKeplr,
  DEFAULT_CHAIN,
  loadChainConfig,
  saveChainConfig,
  signGentx,
  suggestChain,
  type ChainConfig,
  type ConnectedWallet,
} from "../lib/keplr";
import {
  BME_CANCEL_REASONS,
  fetchAktUsdPrice,
  fetchBalances,
  fetchBmeInfo,
  fetchBmeLedger,
  type BmeInfo,
  type BmeLedgerSummary,
  type Coin,
} from "../lib/lcd";

const EXAMPLE_SPEC = `version: 1
network:
  name: sparkdreamdev
  type: devnet
  bech32Prefix: sprkdrm
token:
  # chain rules: baseDenom u<2-5 letters>.<suffix>; dream prefix is fixed "udream."
  baseDenom: uspark.sparkdreamdev
  displayDenom: SPARK
  # dreamDenom: udream.sparkdreamdev  # udream. + baseDenom's suffix unless set
  # dreamDisplayDenom: DREAM
accounts:
  initial:
    - name: treasury
      generate: true
      amount: "500000000000000"
    # member: seed as an active genesis member (people, not treasury/operators);
    # true → core founder defaults, or pick trustLevel (new|provisional|
    # established|trusted|core) and dreamBalance per account
    # council: seat on the founding governance councils (exactly one sets
    # founder: true). Without council accounts the chain's compiled-in
    # founder addresses must exist in genesis or governance never bootstraps
    - name: alice
      generate: true
      amount: "1000000000000"
      member: true
      council: { founder: true, handles: [alice] }
    - name: bob
      generate: true
      amount: "1000000000000"
      member: { trustLevel: established }
      council: true
    - name: carol
      generate: true
      amount: "1000000000000"
      member: { trustLevel: provisional }
      council: true
    - name: dave
      generate: true
      amount: "1000000000000"
      # member cosmetics seed the season profile (otherwise claimed on-chain)
      member: { trustLevel: provisional, dreamBalance: "5000000000", username: dave, displayName: Dave, achievements: [genesis_founder] }
  validatorSelfDelegation: "1000000000000"
  # genesis community pool in the bond denom (split across the root councils
  # at chain start); adds to total supply on top of the accounts above
  # communityPool: "95000000000000"
topology:
  validators: { count: 1 }
  # per-validator staking monikers (default: <name>-val-<index>)
  # validators: { count: 1, monikers: ["🦢 Svanmøy-01 // ⚡"] }
  # tmkms with a pre-existing consensus key (hardware signer): pin each
  # validator's ed25519 pubkey (base64, from comet show-validator or a gentx);
  # the launcher then exports no key and the setup panel configures your device
  # validators: { count: 1, consensusPubkeys: ["OElT4VJpHCEW//d/q5FjCQ7i8EZURn49PSeB7MHp8ds="] }
  sentries: { count: 1 }
  components:
    # route: the ping-pub path baked into the image, when it differs from network.name
    explorer: { enabled: false, domain: explorer.example.com, route: sparkdream }
    frontend: { enabled: false, domain: app.example.com }
    hub: { enabled: false }
  # required when frontend is enabled — sentry-0 serves these domains:
  # publicEndpoints:
  #   api: api.example.com
  #   rpc: rpc.example.com
  headscale:
    domain: headscale.example.com
    # or share an existing fleet's mesh instead of deploying a headscale
    # (one tailscale login on a tmkms signer reaches every sharing fleet):
    # reuseFleet: <launch id or network name of the owning fleet>
# providers:
#   # fleet-wide: providers on this list may host no component
#   exclude: []
#   components:
#     # per-component exclusions, merged over the fleet-wide list. Entries are
#     # an akash1... owner address (exact match) or a case-insensitive fragment
#     # of the provider's hostname. Example: keep the coordination server off a
#     # provider whose network drops traffic from other providers, while nodes
#     # stay eligible for it:
#     headscale: { exclude: ["provider-hostname-fragment"] }
#     # validators: { exclude: [] }
#     # sentries:   { exclude: [] }
`;

const LAST_LAUNCH_KEY = "launcher.lastLaunchId";
const SPEC_KEY = "launcher.specText";
const MODE_KEY = "launcher.editMode";
const WALLET_CONNECTED_KEY = "launcher.walletConnected";

type EditMode = "guided" | "form" | "yaml";

/** Akash blocks are ~6.098s; used for per-month price and escrow runway. */
const BLOCKS_PER_MONTH = (30.437 * 24 * 60 * 60) / 6.098;
const BLOCKS_PER_DAY = (24 * 60 * 60) / 6.098;

const ROLE_LABELS: Array<[RegExp, string]> = [
  [/^val-/, "Validator"],
  [/^sentry-/, "Sentry node"],
  [/^headscale$/, "VPN mesh"],
  [/^explorer$/, "Block explorer"],
  [/^frontend$/, "Web app"],
  [/^hub$/, "Hub"],
];
const roleLabel = (key: string) =>
  ROLE_LABELS.find(([re]) => re.test(key))?.[1] ?? "Service";

// Nebula background ported from sparkdream-ui's Imaginarium (NebulaField):
// drifting cosmic blobs, cold palette, screen-blended over the black canvas.
const NEBULA_BLOBS = [
  { top: 8,  left: 12, size: 520, color: "99, 102, 241",  duration: 72,  delay: 0,  driftX:  80, driftY: -50, peak: 0.38 }, // violet
  { top: 22, left: 68, size: 480, color: "96, 165, 250",  duration: 88,  delay: 11, driftX: -70, driftY:  60, peak: 0.32 }, // blue
  { top: 55, left: 18, size: 460, color: "52, 211, 153",  duration: 96,  delay: 22, driftX:  90, driftY:  40, peak: 0.26 }, // green
  { top: 68, left: 78, size: 540, color: "168, 85, 247",  duration: 80,  delay: 6,  driftX: -60, driftY: -70, peak: 0.34 }, // purple
  { top: 2,  left: 50, size: 420, color: "34, 211, 238",  duration: 104, delay: 16, driftX:  50, driftY:  80, peak: 0.24 }, // cyan
  { top: 82, left: 38, size: 400, color: "129, 140, 248", duration: 78,  delay: 27, driftX: -80, driftY: -40, peak: 0.30 }, // indigo
  { top: 38, left: 2,  size: 440, color: "217, 70, 239",  duration: 92,  delay: 9,  driftX: 100, driftY:  50, peak: 0.22 }, // magenta
  { top: 48, left: 55, size: 380, color: "45, 212, 191",  duration: 112, delay: 19, driftX: -40, driftY:  70, peak: 0.28 }, // teal
  { top: 15, left: 88, size: 360, color: "139, 92, 246",  duration: 86,  delay: 3,  driftX: -90, driftY:  30, peak: 0.30 }, // deep violet
];

function NebulaField() {
  return (
    <div className="sd-nebula-field" aria-hidden="true">
      {NEBULA_BLOBS.map((b, i) => (
        <span
          key={i}
          className="sd-nebula-blob"
          style={{
            top: `${b.top}%`,
            left: `${b.left}%`,
            width: `${b.size}px`,
            height: `${b.size}px`,
            animationDuration: `${b.duration}s`,
            animationDelay: `-${b.delay}s`,
            ["--sd-blob-color" as string]: b.color,
            ["--sd-blob-peak" as string]: b.peak,
            ["--sd-blob-drift-x" as string]: `${b.driftX}px`,
            ["--sd-blob-drift-y" as string]: `${b.driftY}px`,
          }}
        />
      ))}
    </div>
  );
}

/** Health/state → status dot color class. */
const healthKind = (c: ComponentView): "ok" | "warn" | "err" | "off" => {
  if (c.state !== "active") return "off";
  switch (c.health?.status) {
    case "healthy":
      return "ok";
    case "low-escrow":
    case "catching-up":
      return "warn";
    case undefined:
      return "ok"; // no sweep yet; the lease is active
    default:
      return "err";
  }
};

/** useState persisted to localStorage. Loads after mount (the page is
 *  statically prerendered, so reading storage during render would mismatch
 *  hydration) and saves on every change. */
function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      // unreadable stored value — keep the default
    }
    loaded.current = true;
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode) — state still works in-memory
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export default function Page() {
  const [chain, setChain] = useState<ChainConfig>(DEFAULT_CHAIN);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [specText, setSpecText] = useState(EXAMPLE_SPEC);
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [pendingGentx, setPendingGentx] = useState<PendingGentx | null>(null);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [fleetAccounts, setFleetAccounts] = useState<Record<string, AccountView[]>>({});
  const [revealedMnemonics, setRevealedMnemonics] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Coin[] | null>(null);
  const [bme, setBme] = useState<BmeInfo | null>(null);
  const [ledger, setLedger] = useState<BmeLedgerSummary | null>(null);
  const [aktPrice, setAktPrice] = useState<number | null>(null);
  const [mintAmount, setMintAmount] = useState("");
  const [warnings, setWarnings] = useState<{ path: string; message: string }[]>([]);

  // mission-control UI state
  const [mode, setMode] = useState<EditMode>("guided");
  const [wizStep, setWizStep] = useState(0);
  const [wizMax, setWizMax] = useState(0);
  const [advOpen, setAdvOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = usePersistedState("launcher.panel.network", false);
  const [fleetActsOpen, setFleetActsOpen] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.fleetActs",
    {},
  );
  // fleet cards collapse by clicking the header, like the accounts card
  // (undefined = open, the useful default for a live fleet)
  const [fleetBodyOpen, setFleetBodyOpen] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.fleetBody",
    {},
  );
  const [openComponent, setOpenComponent] = useState<string | null>(null);
  const [acctsOpen, setAcctsOpen] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.accounts",
    {},
  );
  // lazy account fetch, driven by the open state so a persisted-open panel
  // loads its rows after a reload too
  const acctsFetching = useRef(new Set<string>());
  useEffect(() => {
    for (const fl of fleet?.fleets ?? []) {
      const id = fl.launchId;
      if (!acctsOpen[id] || fleetAccounts[id] || acctsFetching.current.has(id)) continue;
      acctsFetching.current.add(id);
      import("../lib/api").then(({ getFleetAccounts }) =>
        getFleetAccounts(id)
          .then((r) => setFleetAccounts((m) => ({ ...m, [id]: r.accounts })))
          .catch((e) => setError(String(e)))
          .finally(() => acctsFetching.current.delete(id)),
      );
    }
  }, [fleet, acctsOpen, fleetAccounts]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(""), 2400);
  }, []);

  // localStorage only after mount — the page is statically prerendered
  useEffect(() => {
    setChain(loadChainConfig());
    setLaunchId(localStorage.getItem(LAST_LAUNCH_KEY));
    const savedSpec = localStorage.getItem(SPEC_KEY);
    if (savedSpec) setSpecText(savedSpec);
    const savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode === "guided" || savedMode === "form" || savedMode === "yaml") {
      setMode(savedMode);
    }
  }, []);

  const switchMode = (m: EditMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
  };

  const updateSpec = (text: string) => {
    setSpecText(text);
    localStorage.setItem(SPEC_KEY, text);
  };

  // "Prefill from genesis.json": reverse-map an uploaded genesis into a
  // spec draft; unmappable facts arrive as notes and lead the YAML as
  // comments so they are read before Review
  const prefillFromGenesisFile = async (file: File) => {
    setBusy("prefilling spec from genesis…");
    setError(null);
    try {
      const genesis = JSON.parse(await file.text());
      const { postSpecPrefill } = await import("../lib/api");
      const result = await postSpecPrefill(genesis);
      const noteLines = [
        `# Prefilled from ${file.name} — review before launching:`,
        ...result.notes.map((n) => `#  - ${n}`),
        ...result.issues.map(
          (i) => `#  ${i.warning ? "warning" : "ERROR"} ${i.path}: ${i.message}`,
        ),
      ];
      updateSpec(`${noteLines.join("\n")}\n${yaml.dump(result.spec, { lineWidth: 100 })}`);
      setAdvOpen(true);
    } catch (e) {
      setError(`genesis prefill: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(null);
    }
  };

  const updateChain = (patch: Partial<ChainConfig>) => {
    const next = { ...chain, ...patch };
    setChain(next);
    saveChainConfig(next);
  };

  const chainIsCustom = (Object.keys(DEFAULT_CHAIN) as (keyof ChainConfig)[]).some(
    (k) => chain[k] !== DEFAULT_CHAIN[k],
  );
  const rpcHost = useMemo(() => {
    try {
      return new URL(chain.rpc).hostname;
    } catch {
      return chain.rpc;
    }
  }, [chain.rpc]);

  const connect = useCallback(
    async (config?: ChainConfig, silent = false) => {
      const cfg = config ?? chain;
      try {
        if (!silent) setError(null);
        const w = await connectKeplr(cfg);
        // wallet-session auth when the conductor requires it (Akash mode, M6 §2)
        const { getAuthMode, authNonce, authVerify, setAuthToken, loadAuthToken } =
          await import("../lib/api");
        const authMode = await getAuthMode();
        // a persisted session token (12h server TTL) skips the re-sign
        if (authMode.required && !loadAuthToken()) {
          if (silent) return; // never pop a signature request on page load
          const { signAuthNonce } = await import("../lib/keplr");
          const nonce = await authNonce(w.address);
          const signature = await signAuthNonce(cfg, w.address, nonce);
          setAuthToken(await authVerify(w.address, signature));
        }
        setWallet(w);
        localStorage.setItem(WALLET_CONNECTED_KEY, "1");
      } catch (e) {
        // silent = auto-reconnect: site approval was likely revoked, so
        // stop trying on future loads rather than surfacing an error
        if (silent) localStorage.removeItem(WALLET_CONNECTED_KEY);
        else {
          setError(String(e));
          // a failed connect is the one moment the network fields matter
          setNetworkOpen(true);
        }
      }
    },
    [chain],
  );

  // reconnect on reload: Keplr's enable() resolves without a prompt once the
  // site is approved, so a previously connected wallet comes back silently
  const autoConnectTried = useRef(false);
  useEffect(() => {
    if (autoConnectTried.current || !localStorage.getItem(WALLET_CONNECTED_KEY)) return;
    autoConnectTried.current = true;
    const cfg = loadChainConfig(); // chain state may not have hydrated yet
    (async () => {
      const { waitForKeplr } = await import("../lib/keplr");
      if (await waitForKeplr()) await connect(cfg, true);
    })();
  }, [connect]);

  // account switched in Keplr → the session token and wallet-scoped views
  // belong to the old address; drop them and reconnect as the new account
  useEffect(() => {
    if (!wallet) return;
    const onKeystoreChange = async () => {
      const { setAuthToken } = await import("../lib/api");
      setAuthToken(null);
      setWallet(null);
      setBalances(null);
      setLedger(null);
      setFleet(null);
      await connect(undefined, true);
    };
    window.addEventListener("keplr_keystorechange", onKeystoreChange);
    return () => window.removeEventListener("keplr_keystorechange", onKeystoreChange);
  }, [wallet, connect]);

  const importSpec = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => updateSpec(String(reader.result));
    reader.readAsText(file);
  };

  const exportSpec = () => {
    const blob = new Blob([specText], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "launch.yaml";
    a.click();
    URL.revokeObjectURL(url);
  };

  // launcher backup (machine migration): a passphrase modal drives both the
  // encrypted export and the merge-import
  const [backupPrompt, setBackupPrompt] = useState<
    null | { mode: "export" } | { mode: "import"; file: File }
  >(null);
  const [backupPass, setBackupPass] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupReport, setBackupReport] = useState<BackupImportReport | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  // settings cog: menu items open the System panel above the Launch panel
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [systemOpen, setSystemOpen] = usePersistedState("launcher.panel.system", false);
  const [sysFocus, setSysFocus] = useState<"backup" | "assets" | null>(null);
  const openSystem = (section: "backup" | "assets") => {
    setSettingsOpen(false);
    setSystemOpen(true);
    setSysFocus(section);
  };
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  const runBackup = async () => {
    if (!backupPrompt || !backupPass) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      if (backupPrompt.mode === "export") {
        await exportLauncherBackup(backupPass);
      } else {
        setBackupReport(await importLauncherBackup(backupPrompt.file, backupPass));
      }
      setBackupPrompt(null);
      setBackupPass("");
      // pull the restored fleets in now rather than waiting for the 5s poll
      if (backupPrompt.mode === "import" && wallet) setFleet(await getFleet(wallet.address));
    } catch (e) {
      // surfaced in the System panel's backup block, next to the buttons
      setBackupError(e instanceof Error ? e.message : String(e));
      setBackupPrompt(null);
    } finally {
      setBackupBusy(false);
    }
  };

  const [tmkms, setTmkms] = useState<import("../lib/api").TmkmsSetup | null>(null);
  const [tmkmsId, setTmkmsId] = useState<string | null>(null);
  const [tmkmsStatus, setTmkmsStatus] = useState<import("../lib/api").TmkmsStatus | null>(null);
  // per-validator signing deltas, diffed between status polls: the stall
  // signal (0 new blocks while connected) lives in the delta, not the counters
  const [tmkmsSignDeltas, setTmkmsSignDeltas] = useState<Record<string, { seen: number; missed: number } | null>>({});
  const tmkmsPrevCounters = useRef<Record<string, { missed: number; offset: number }>>({});
  const showTmkms = async (id: string) => {
    setError(null);
    try {
      const { getTmkmsSetup } = await import("../lib/api");
      setTmkms(await getTmkmsSetup(id));
      setTmkmsId(id);
    } catch (e) {
      setError(String(e));
    }
  };
  const closeTmkms = () => {
    setTmkms(null);
    setTmkmsId(null);
    setTmkmsStatus(null);
    setTmkmsSignDeltas({});
    tmkmsPrevCounters.current = {};
  };


  // wallet-scoped fleet view (§2): connect wallet → see your fleets
  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    const tick = () =>
      getFleet(wallet.address)
        .then((f) => {
          if (stop) return;
          setFleet(f);
          for (const fl of f.fleets) refreshProviderPrefs(fl.launchId);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [wallet]);

  // never orphan a launch that needs attention: if no launch board is open
  // (fresh browser, or "New launch" clicked) and some launch is not
  // completed — running, paused on a signature, failed — reattach to the
  // most recent one so its banners stay reachable
  useEffect(() => {
    if (launchId || !fleet) return;
    const active = [...fleet.fleets].reverse().find((f) => f.launchStatus !== "completed");
    if (active) {
      localStorage.setItem(LAST_LAUNCH_KEY, active.launchId);
      setLaunchId(active.launchId);
    }
  }, [fleet, launchId]);

  // real-time block height for active nodes (validators + sentries; not
  // headscale/explorer/frontend — they have no RPC). Lighter + faster than
  // the 45s health sweep; re-derives its target list from the current fleet.
  const heightTargets = useMemo(
    () =>
      (fleet?.fleets ?? []).flatMap((f) =>
        f.components
          .filter((c) => /^(val|sentry)-/.test(c.key) && c.state === "active")
          .map((c) => ({ launchId: f.launchId, dseq: c.dseq })),
      ),
    [fleet],
  );
  useEffect(() => {
    if (heightTargets.length === 0) return;
    let stop = false;
    const tick = async () => {
      const { getComponentHeight } = await import("../lib/api");
      await Promise.all(
        heightTargets.map(async ({ launchId, dseq }) => {
          const h = await getComponentHeight(launchId, dseq).catch(() => null);
          if (h && !stop) setLiveHeights((m) => ({ ...m, [dseq]: h }));
        }),
      );
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [heightTargets]);

  // compute-network balances + BME mint state (console-air's mint & burn
  // flow, §mint): deployments on mainnet are paid in uact, acquired by
  // burning uakt via MsgMintACT — settled asynchronously by the BME ledger
  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    fetchBmeInfo(chain.rest)
      .then((b) => !stop && setBme(b))
      .catch(() => {});
    const tick = async () => {
      try {
        const b = await fetchBalances(chain.rest, wallet.address);
        if (stop) return;
        setBalances(b);
        setLedger(await fetchBmeLedger(chain.rest, wallet.address).catch(() => null));
      } catch {
        // LCD hiccups are non-fatal; keep the last known balances
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    // AKT price feeds the ACT-output estimate only — refreshed sparingly
    // (coingecko rate limits), the chain applies the real oracle rate
    const priceTick = () => fetchAktUsdPrice().then((p) => !stop && p && setAktPrice(p));
    priceTick();
    const pt = setInterval(priceTick, 60000);
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(pt);
    };
  }, [wallet, chain.rest]);

  const mint = async () => {
    if (!wallet) return;
    const akt = Number(mintAmount);
    if (!Number.isFinite(akt) || akt <= 0) return setError("enter a positive AKT amount to mint");
    if (belowMinMint && bme?.min_mint_uact) {
      return setError(
        `estimated output is below the network minimum of ${Number(bme.min_mint_uact) / 1e6} ACT: the chain would cancel this mint at settlement`,
      );
    }
    setBusy("minting ACT in Keplr…");
    setError(null);
    try {
      const client = await SigningStargateClient.connectWithSigner(chain.rpc, wallet.signer, {
        registry: launcherRegistry(),
        gasPrice: GasPrice.fromString(`${chain.gasPrice}${chain.denom}`),
      });
      const msg = mintActMsg(wallet.address, {
        denom: "uakt",
        amount: String(Math.round(akt * 1e6)),
      });
      const result = await client.signAndBroadcast(wallet.address, [toEncodeObject(msg)], "auto");
      if (result.code !== 0) {
        throw new Error(`tx rejected on-chain (code ${result.code}): ${result.rawLog ?? ""}`);
      }
      setMintAmount("");
      // optimistic until the next ledger poll — settlement is asynchronous
      setLedger((s) => (s ? { ...s, pending: s.pending + 1 } : s));
      showToast("mint broadcast, the ACT arrives after the next settlement epoch");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const microToDisplay = (amount: string | null | undefined) =>
    amount == null
      ? "—"
      : (Number(amount) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const balanceOf = (denom: string) => balances?.find((c) => c.denom === denom)?.amount ?? null;
  const denomLabel = chain.denom.replace(/^u/, "").toUpperCase();

  // Akash lease price is micro-denom PER BLOCK (DecCoin). Convert to
  // whole-denom PER MONTH the way console-air does.
  const monthlyNum = (microPerBlock: string) => {
    const perBlock = Number(microPerBlock);
    return Number.isFinite(perBlock) ? (perBlock / 1e6) * BLOCKS_PER_MONTH : null;
  };
  const priceMonthly = (microPerBlock: string, microDenom: string) => {
    const monthly = monthlyNum(microPerBlock);
    if (monthly === null) return "—";
    const denom = microDenom.replace(/^u/, "").toUpperCase(); // uact → ACT
    // ACT is USD-pegged 1:1 → show dollars like console-air; other denoms
    // (e.g. sandbox AKT) aren't USD, so label them with the token
    return denom === "ACT" ? `$${monthly.toFixed(2)}/mo` : `${monthly.toFixed(2)} ${denom}/mo`;
  };

  // escrow balance: micro-denom amount → whole tokens ($ for ACT)
  const balanceDisplay = (microAmount: string, microDenom: string) => {
    const whole = Number(microAmount) / 1e6;
    if (!Number.isFinite(whole)) return "—";
    const denom = microDenom.replace(/^u/, "").toUpperCase();
    return denom === "ACT" ? `$${whole.toFixed(2)}` : `${whole.toFixed(2)} ${denom}`;
  };

  // escrow runway in days at the current lease price
  const runwayDays = (c: ComponentView): number | null => {
    if (c.escrow == null) return null;
    const perBlock = Number(c.price);
    const escrow = Number(c.escrow);
    if (!Number.isFinite(perBlock) || perBlock <= 0 || !Number.isFinite(escrow)) return null;
    return escrow / (perBlock * BLOCKS_PER_DAY);
  };
  const runwayClass = (d: number) => (d < 7 ? "err" : d < 14 ? "warn" : "ok");

  // UI estimate of the mint output (ACT is USD-pegged, so ACT ≈ AKT × price,
  // less the on-chain spread). Mints whose estimated output is below
  // params.min_mint are CANCELED at settlement, not rejected at broadcast —
  // so gate here, like console-air, instead of letting them fail silently.
  const mintAkt = Number(mintAmount);
  const estimatedMintUact =
    aktPrice !== null && Number.isFinite(mintAkt) && mintAkt > 0
      ? Math.floor(mintAkt * aktPrice * 1e6 * (1 - (bme?.mint_spread_bps ?? 0) / 10000))
      : null;
  const belowMinMint =
    estimatedMintUact !== null &&
    bme?.min_mint_uact != null &&
    estimatedMintUact < Number(bme.min_mint_uact);

  // pre-launch deposit estimate so the user can mint ACT in advance: one
  // deployment per node plus headscale, 5 ACT/AKT escrow each (the
  // conductor's DEFAULT_DEPOSIT; estimate-costs refines). Gas fees come on
  // top but are small next to the deposits.
  const DEPOSIT_PER_DEPLOYMENT = 5_000_000;
  const requiredDeposit = useMemo(() => {
    try {
      const spec = yaml.load(specText) as any;
      const nodeCount =
        (spec?.topology?.validators?.count ?? 0) + (spec?.topology?.sentries?.count ?? 0);
      if (nodeCount <= 0) return null;
      const comps = spec?.topology?.components ?? {};
      const componentCount = ["explorer", "frontend"].filter((k) => comps[k]?.enabled).length;
      return (nodeCount + 1 + componentCount) * DEPOSIT_PER_DEPLOYMENT;
    } catch {
      return null; // spec doesn't parse — validation will complain elsewhere
    }
  }, [specText]);
  const depositShortfall =
    requiredDeposit !== null && balances !== null
      ? Math.max(0, requiredDeposit - Number(balanceOf(chain.denom) ?? "0"))
      : 0;
  const walletReady = wallet !== null && balances !== null && depositShortfall === 0;
  const depositActStr =
    requiredDeposit !== null ? `~${microToDisplay(String(requiredDeposit))} ${denomLabel}` : "—";
  const haveAct = Number(balanceOf(chain.denom) ?? "0");
  const actPct =
    requiredDeposit !== null && balances !== null
      ? Math.min(100, (haveAct / requiredDeposit) * 100)
      : 0;

  // complete validation on every keystroke: YAML parse, then the same
  // pipeline the conductor runs on submit (profile defaults + schema with
  // every issue collected + cross-field checks)
  const specCheck = useMemo((): SpecCheck => {
    let doc: unknown;
    try {
      doc = yaml.load(specText);
    } catch (e: any) {
      const line = typeof e?.mark?.line === "number" ? `line ${e.mark.line + 1}: ` : "";
      const reason = String(e?.reason ?? e?.message ?? e).split("\n")[0]!;
      return {
        spec: null,
        errors: [{ path: "", message: `${line}${reason} (YAML syntax)` }],
        warnings: [],
        ok: false,
      };
    }
    if (doc == null || typeof doc !== "object") {
      return {
        spec: null,
        errors: [{ path: "", message: "spec is empty" }],
        warnings: [],
        ok: false,
      };
    }
    return checkSpec(doc);
  }, [specText]);

  // ---- guided/form binding: the YAML spec stays the single source of truth;
  // form fields read the parsed document and write back targeted patches.
  // (A form edit re-serializes the YAML, so hand-written comments are lost
  // the first time a field is touched — the values themselves survive.)
  const specDoc = useMemo(() => {
    try {
      const d = yaml.load(specText);
      return d && typeof d === "object" ? (d as any) : null;
    } catch {
      return null;
    }
  }, [specText]);

  const patchSpec = (fn: (doc: any) => void) => {
    let doc: any;
    try {
      doc = yaml.load(specText) ?? {};
    } catch {
      return; // broken YAML can only be fixed in YAML mode
    }
    if (typeof doc !== "object") doc = {};
    fn(doc);
    updateSpec(yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  };

  // ---- §13 chain assets: ask the conductor what the spec's chain version
  // resolves to (baked/cache/tag/pin), or whether it needs a commit prompt
  // (no matching chain-repo tag) or is unavailable (baked mode, not local).
  const specImage: string | undefined = (specCheck.spec as any)?.images?.sparkdreamd;
  const specRepoPin: string | undefined = (specCheck.spec as any)?.images?.chainRepoCommit;
  const [chainAssets, setChainAssets] = useState<ChainAssetsView | null>(null);
  const [assetsNonce, setAssetsNonce] = useState(0);
  useEffect(() => {
    // without a spec image there is no resolution preview, but mode/locked
    // still power the settings-menu Offline/Online toggle
    let stale = false;
    const t = setTimeout(() => {
      getChainAssets(specImage, specImage ? specRepoPin : undefined)
        .then((v) => !stale && setChainAssets(v))
        .catch(() => !stale && setChainAssets(null));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [specImage, specRepoPin, assetsNonce]);
  const toggleAssetsMode = async (mode: "baked" | "fetch") => {
    try {
      await setChainAssetsMode(mode);
    } catch {
      // locked or unreachable — the refresh below re-syncs the display
    }
    setAssetsNonce((n) => n + 1);
  };
  const assetsNeedCommit = chainAssets?.resolution === "prompt";
  const assetsUnavailable = chainAssets?.resolution === "unavailable";
  const assetsUnknown = chainAssets?.resolution === "unknown";
  const [repoCommitDraft, setRepoCommitDraft] = useState("");
  useEffect(() => {
    if (assetsNeedCommit) setRepoCommitDraft(chainAssets?.headCommit ?? "");
  }, [assetsNeedCommit, chainAssets?.headCommit]);
  const repoCommitValid = /^[0-9a-f]{7,40}$/.test(repoCommitDraft.trim());
  const pinRepoCommit = () => {
    if (!repoCommitValid) return;
    patchSpec((doc) => {
      doc.images = { ...(doc.images ?? {}), chainRepoCommit: repoCommitDraft.trim() };
    });
  };

  const specName: string = specDoc?.network?.name ?? "";
  const specType: string = specDoc?.network?.type ?? "devnet";
  const specSym: string = specDoc?.token?.displayDenom ?? "";
  const specDream: string = specDoc?.token?.dreamDisplayDenom ?? "DREAM";
  const specVals: number = specDoc?.topology?.validators?.count ?? 1;
  const specSents: number = specDoc?.topology?.sentries?.count ?? 0;
  const specAccounts: string[] = Array.isArray(specDoc?.accounts?.initial)
    ? specDoc.accounts.initial.map((a: any) => String(a?.name ?? "?"))
    : [];

  const setSpecName = (v: string) =>
    patchSpec((doc) => {
      doc.network = { ...(doc.network ?? {}), name: v };
      // denom suffixes follow the network name by convention — keep them in step
      const base: string | undefined = doc.token?.baseDenom;
      const m = typeof base === "string" ? base.match(/^(u[a-z]{2,5})\.(.+)$/) : null;
      if (m && v) doc.token.baseDenom = `${m[1]}.${v}`;
      const dream: string | undefined = doc.token?.dreamDenom;
      if (typeof dream === "string" && /^udream\./.test(dream) && v) {
        doc.token.dreamDenom = `udream.${v}`;
      }
    });
  const setSpecType = (v: string) =>
    patchSpec((doc) => {
      doc.network = { ...(doc.network ?? {}), type: v };
    });
  const setSpecSym = (v: string) =>
    patchSpec((doc) => {
      doc.token = { ...(doc.token ?? {}), displayDenom: v };
      const base: string | undefined = doc.token.baseDenom;
      const m = typeof base === "string" ? base.match(/^u[a-z]{2,5}\.(.+)$/) : null;
      if (m && /^[A-Za-z]{2,5}$/.test(v)) doc.token.baseDenom = `u${v.toLowerCase()}.${m[1]}`;
    });
  const setSpecDream = (v: string) =>
    patchSpec((doc) => {
      doc.token = { ...(doc.token ?? {}), dreamDisplayDenom: v };
    });
  const setSpecCount = (kind: "validators" | "sentries", delta: number) =>
    patchSpec((doc) => {
      doc.topology = doc.topology ?? {};
      const cur = doc.topology[kind]?.count ?? (kind === "validators" ? 1 : 0);
      const min = kind === "validators" ? 1 : 0;
      const next = Math.max(min, Math.min(9, cur + delta));
      doc.topology[kind] = { ...(doc.topology[kind] ?? {}), count: next };
    });
  const addSpecAccount = () =>
    patchSpec((doc) => {
      doc.accounts = doc.accounts ?? {};
      const list: any[] = Array.isArray(doc.accounts.initial) ? doc.accounts.initial : [];
      let i = list.length;
      while (list.some((a) => a?.name === `account-${i}`)) i++;
      list.push({ name: `account-${i}`, generate: true, amount: "1000000000000" });
      doc.accounts.initial = list;
    });

  // issue paths are semantic; point them back into the textarea where we can
  const issueLine = useCallback(
    (path: string) => (path ? specPathLine(specText, path) : null),
    [specText],
  );
  const specRef = useRef<HTMLTextAreaElement>(null);
  const jumpToLine = (line: number) => {
    const ta = specRef.current;
    if (!ta) return;
    const start = specText.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    const end = specText.indexOf("\n", start);
    ta.focus();
    ta.setSelectionRange(start, end < 0 ? specText.length : end);
  };

  // the deployment plan this spec resolves to (profile defaults applied) —
  // one row per role with count + image, joined with the cost estimate in
  // the render. Shown whenever the schema parses, even with cross-field
  // errors outstanding.
  const resolvedImages = useMemo(() => {
    const spec = specCheck.spec;
    if (!spec) return null;
    // role names match the estimator's perRole keys
    const rows: Array<{ role: string; count: number; image: string }> = [
      { role: "validators", count: spec.topology.validators.count, image: spec.images.sparkdreamd },
    ];
    if (spec.topology.sentries.count > 0) {
      rows.push({ role: "sentries", count: spec.topology.sentries.count, image: spec.images.sparkdreamd });
    }
    // a shared mesh (reuseFleet) is deployed and billed by its owning fleet
    if (!spec.topology.headscale.reuseFleet) {
      rows.push({ role: "headscale", count: 1, image: spec.images.headscale });
    }
    if (spec.topology.components.explorer.enabled && spec.images.explorer) {
      rows.push({ role: "explorer", count: 1, image: spec.images.explorer });
    }
    if (spec.topology.components.frontend.enabled && spec.images.frontend) {
      rows.push({ role: "frontend", count: 1, image: spec.images.frontend });
    }
    return rows;
  }, [specCheck]);

  // market-based running-cost estimate for the current spec (conductor →
  // console pricing API), debounced so we only price a settled spec
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  useEffect(() => {
    if (!resolvedImages) {
      setCostEstimate(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const { postEstimate } = await import("../lib/api");
        const est = await postEstimate(yaml.load(specText));
        if (!stale) setCostEstimate(est);
      } catch {
        if (!stale) setCostEstimate(null); // estimate is best-effort
      }
    }, 700);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [specText, resolvedImages]);

  // service fee schedule (upgrade/top-up dialogs show exact amounts; the fee
  // is always in the Keplr prompt regardless)
  const [fee, setFee] = useState<FeeInfo | null>(null);
  useEffect(() => {
    import("../lib/api").then(({ getFee }) => getFee().then(setFee).catch(() => {}));
  }, []);

  const [logsView, setLogsView] = useState<{ key: string; text: string } | null>(null);
  // shut-down fleets (every component closed) collapse to one line; the
  // record stays for bundle export / genesis download behind this toggle
  const [showClosedFleet, setShowClosedFleet] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.closedFleets",
    {},
  );
  // live sentry block heights, keyed by dseq, polled every 3s
  const [liveHeights, setLiveHeights] = useState<
    Record<string, { height: number; catchingUp: boolean }>
  >({});
  // per-launch provider avoid/prefer lists, keyed by launchId
  const [providerPrefs, setProviderPrefs] = useState<
    Record<string, { avoid: string[]; prefer: string[]; names: Record<string, string> }>
  >({});

  const refreshProviderPrefs = useCallback(async (launchId: string) => {
    const { getProviderPrefs } = await import("../lib/api");
    const prefs = await getProviderPrefs(launchId).catch(() => null);
    if (prefs) setProviderPrefs((m) => ({ ...m, [launchId]: prefs }));
  }, []);

  const cycleProviderPref = async (
    launchId: string,
    provider: string,
    current: "avoid" | "prefer" | "none",
    name?: string,
  ) => {
    // none → avoid → prefer → none
    const next = current === "none" ? "avoid" : current === "avoid" ? "prefer" : "none";
    const { setProviderPref } = await import("../lib/api");
    const prefs = await setProviderPref(launchId, provider, next, name).catch((e) => {
      setError(String(e));
      return null;
    });
    if (prefs) setProviderPrefs((m) => ({ ...m, [launchId]: prefs }));
  };

  const providerPrefOf = (launchId: string, provider: string): "avoid" | "prefer" | "none" => {
    const p = providerPrefs[launchId];
    if (p?.avoid.includes(provider)) return "avoid";
    if (p?.prefer.includes(provider)) return "prefer";
    return "none";
  };

  const fleetAction = async (
    launchId: string,
    dseq: string,
    action: "close" | "restart" | "relaunch" | "upgrade" | "topup" | "unjail" | "resume-signing",
    extra: { image?: string; components?: string[]; amount?: string; haltHeight?: number } = {},
  ) => {
    setError(null);
    try {
      const first = await postFleetAction(launchId, dseq, action, extra);
      if (first.error) {
        setError(first.error);
        return;
      }
      if (first.warnings?.length) {
        const ok = window.confirm(
          `${first.warnings.join("\n")}\n\n${first.confirmPrompt ?? "Proceed anyway?"}`,
        );
        if (!ok) return;
        await postFleetAction(launchId, dseq, action, { ...extra, confirm: true });
      }
      // signature-bearing actions flow through the launch's signing loop —
      // open that launch's panel so the prompt is visible (and survives reload)
      // a mid-launch re-placement may have to wait for the running step, so
      // surface what the conductor said instead of looking like a no-op
      if (first.note) showToast(first.note);
      if (action !== "restart") {
        localStorage.setItem(LAST_LAUNCH_KEY, launchId);
        setLaunchId(launchId);
      } else {
        showToast(`restart requested (${dseq})`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const showLogs = async (launchId: string, dseq: string, key: string) => {
    setError(null);
    try {
      const { getComponentLogs } = await import("../lib/api");
      setLogsView({ key, text: await getComponentLogs(launchId, dseq) });
    } catch (e) {
      setError(String(e));
    }
  };

  // poll launch status + pending tx while a launch is active
  useEffect(() => {
    // drop the previous launch's state immediately on switch — a stale
    // pending tx must never be signable against the new launch id
    setLaunch(null);
    setPending(null);
    setPendingGentx(null);
    setStepsExpanded(false);
    if (!launchId) return;
    let stop = false;
    const tick = async () => {
      try {
        const view = await getLaunch(launchId);
        if (stop) return;
        setLaunch(view);
        // fleet close/top-up enqueue txs on completed launches too, so
        // always ask — the endpoints return 204 when nothing is pending
        setPending(await getPendingTx(launchId));
        setPendingGentx(await getPendingGentx(launchId));
      } catch (e) {
        if (!stop) setError(String(e));
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [launchId]);

  const create = async () => {
    if (!wallet) return setError("connect Keplr first");
    setBusy("creating launch…");
    setError(null);
    try {
      const spec = yaml.load(specText);
      const created = await createLaunch(spec, wallet.address);
      setWarnings(created.warnings);
      localStorage.setItem(LAST_LAUNCH_KEY, created.id);
      setLaunchId(created.id);
      await startLaunch(created.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // step whose last sign attempt failed — unlocks the "rebuild tx" escape
  // hatch for that step only, so the everyday UI stays minimal
  const [signFailedStep, setSignFailedStep] = useState<string | null>(null);
  const signingRef = useRef(false);
  const sign = useCallback(async () => {
    if (!wallet || !launchId || !pending || signingRef.current) return;
    signingRef.current = true;
    setBusy(`signing ${pending.step} in Keplr…`);
    setError(null);
    try {
      const client = await SigningStargateClient.connectWithSigner(chain.rpc, wallet.signer, {
        registry: launcherRegistry(),
        gasPrice: GasPrice.fromString(`${chain.gasPrice}${chain.denom}`),
      });
      const result = await client.signAndBroadcast(
        wallet.address,
        pending.msgs.map(toEncodeObject),
        "auto",
      );
      if (result.code !== 0) {
        throw new Error(`tx rejected on-chain (code ${result.code}): ${result.rawLog ?? ""}`);
      }
      await postTxResult(launchId, result.transactionHash);
      setPending(null);
      setSignFailedStep(null);
    } catch (e) {
      setSignFailedStep(pending.step);
      setError(String(e));
    } finally {
      signingRef.current = false;
      setBusy(null);
    }
  }, [wallet, launchId, pending, chain]);

  // the signing queue serves oldest-first, so an unwanted head blocks every
  // later fleet action — dismissing it is the only way out short of signing
  const dismissPendingTx = useCallback(async () => {
    if (!launchId || !pending) return;
    const ok = window.confirm(
      pending.kind === "fleet-action"
        ? `Cancel ${pending.origin}? Nothing is signed or broadcast, so the action simply does not happen.`
        : `Clear the signature request from ${pending.origin}? Nothing is broadcast, but the step re-creates this transaction the next time the launch resumes, so abort the operation itself to stop it for good.`,
    );
    if (!ok) return;
    setError(null);
    try {
      const { discardPendingTx } = await import("../lib/api");
      await discardPendingTx(launchId, pending.step);
      setPending(null);
      setSignFailedStep(null);
    } catch (e) {
      setError(String(e));
    }
  }, [launchId, pending]);

  const signingGentxRef = useRef(false);
  const signGentxNow = useCallback(async () => {
    if (!launchId || !launch || !pendingGentx || signingGentxRef.current) return;
    signingGentxRef.current = true;
    setBusy(`signing gentx for validator ${pendingGentx.valIndex} in Keplr…`);
    setError(null);
    try {
      // signs against the NEW chain (suggested to Keplr on the fly), offline,
      // amino mode — works with Ledger-backed accounts
      const response = await signGentx(launch.spec, pendingGentx.address, pendingGentx.signDoc);
      await postGentxResult(launchId, pendingGentx.valIndex, response);
      setPendingGentx(null);
    } catch (e) {
      setError(String(e));
    } finally {
      signingGentxRef.current = false;
      setBusy(null);
    }
  }, [launchId, launch, pendingGentx]);

  // offline signing (airgapped operator keys): pasted `tx sign --offline`
  // output goes to the same endpoint; the conductor converts and verifies
  const [offlineGentxText, setOfflineGentxText] = useState("");
  const submitOfflineGentx = useCallback(async () => {
    if (!launchId || !pendingGentx || !offlineGentxText.trim()) return;
    setBusy(`verifying offline signature for validator ${pendingGentx.valIndex}…`);
    setError(null);
    try {
      const parsed = JSON.parse(offlineGentxText);
      await postSignedGentxTx(launchId, pendingGentx.valIndex, parsed);
      setOfflineGentxText("");
      setPendingGentx(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [launchId, pendingGentx, offlineGentxText]);

  // banner honesty: step messages persist across conductor restarts, so a
  // banner may describe a PREVIOUS attempt — show how old the report is
  const reportedAgo = (s: { started_at: string | null; finished_at: string | null }) => {
    const t = s.finished_at ?? s.started_at;
    if (!t) return null;
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(t)) / 1000));
    if (secs < 90) return `${secs}s ago`;
    if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
    return `${Math.round(secs / 3600)}h ago`;
  };

  const waitingStep = useMemo(
    () =>
      launch?.steps.find(
        (s) =>
          s.status === "waiting" &&
          s.error !== "awaiting signature" &&
          !s.error?.startsWith("awaiting gentx"),
      ),
    [launch],
  );
  const failedStep = useMemo(() => launch?.steps.find((s) => s.status === "error"), [launch]);

  const isTmkms = (launch?.spec as any)?.security?.keyMode === "tmkms";

  // the launch's await-signer step and any op's *:await-signer gate both
  // mean "the signer needs you" — the setup panel opens on its own (§5 step 19)
  const awaitingSigner = (name?: string) => name === "await-signer" || name?.endsWith(":await-signer");
  useEffect(() => {
    if (awaitingSigner(waitingStep?.name) && launchId) void showTmkms(launchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingStep?.name, launchId]);

  // live status while the panel is open: mesh join + per-validator connection
  useEffect(() => {
    if (!tmkms || !tmkmsId) return;
    let stop = false;
    const tick = () =>
      import("../lib/api").then(({ getTmkmsStatus }) =>
        getTmkmsStatus(tmkmsId)
          .then((s) => {
            if (stop) return;
            setTmkmsStatus(s);
            // diff the slashing counters against the previous sample: "no new
            // blocks while connected" is the live stall signal; a backward
            // jump (state re-sync) hides the row rather than lying
            const prev = tmkmsPrevCounters.current;
            const deltas: Record<string, { seen: number; missed: number } | null> = {};
            for (const v of s.validators) {
              if (v.indexOffset === null || v.missedBlocks === null) continue;
              const p = prev[v.key];
              if (p) {
                const seen = v.indexOffset - p.offset;
                deltas[v.key] =
                  seen >= 0 ? { seen, missed: Math.max(0, v.missedBlocks - p.missed) } : null;
              }
              prev[v.key] = { missed: v.missedBlocks, offset: v.indexOffset };
            }
            setTmkmsSignDeltas(deltas);
          })
          .catch(() => {}),
      );
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [tmkms, tmkmsId]);

  // ---- derived view state for the mission-control layout ----
  // a selected launch whose first poll hasn't answered yet: render a quiet
  // loading header instead of flashing the idle wizard during the switch
  const loadingLaunch = launchId !== null && launch === null;
  const launching =
    launch !== null && ["created", "running", "paused"].includes(launch.status);
  const launched = launch?.status === "completed";
  const idle = !launching && !launched && !loadingLaunch;
  const doneSteps = launch?.steps.filter((s) => s.status === "done").length ?? 0;
  const totalSteps = launch?.steps.length ?? 0;
  const launchPct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
  const launchSpec = launch?.spec as any;
  const launchName: string = launchSpec?.network?.name ?? specName ?? "chain";

  // a running launch that has active fleet ops is a day-2 operation on a live
  // chain (relaunch, upgrade, domain update, …), not the first launch — the
  // progress header should say so
  const activeOpKinds = (fleet?.fleets ?? [])
    .filter((f) => f.launchId === launchId)
    .flatMap((f) => f.ops.filter((o) => o.status === "active").map((o) => o.kind));

  // the step list accumulates every past op's steps; collapse the leading
  // run of already-done steps so the current work stays in view
  const [stepsExpanded, setStepsExpanded] = useState(false);
  // completed launch: clicking the "is live" header shows/hides the step log
  // (remembered per launch)
  const [logOpenMap, setLogOpenMap] = usePersistedState<Record<string, boolean>>(
    "launcher.panel.launchLog",
    {},
  );
  const logOpen = launchId !== null && (logOpenMap[launchId] ?? false);
  const toggleLog = () => {
    if (launchId) setLogOpenMap((m) => ({ ...m, [launchId]: !logOpen }));
  };
  const firstOpenStep = launch?.steps.findIndex((s) => s.status !== "done") ?? -1;
  // when everything is done (status still running between polls), keep the tail
  const collapseCount = Math.max(
    0,
    (firstOpenStep < 0 ? totalSteps - 1 : firstOpenStep) - 1,
  );
  const collapseSteps = !stepsExpanded && collapseCount > 2;
  const visibleSteps = collapseSteps ? launch?.steps.slice(collapseCount) ?? [] : launch?.steps ?? [];

  // headline fleet for the status pill: the open launch's fleet, else the
  // most recent fleet that still has live components
  const aliveFleets = (fleet?.fleets ?? []).filter((f) =>
    f.components.some((c) => c.state !== "closed"),
  );
  const headlineFleet =
    aliveFleets.find((f) => f.launchId === launchId) ?? aliveFleets[aliveFleets.length - 1];
  const headlineHeight = headlineFleet
    ? Math.max(
        0,
        ...headlineFleet.components.map((c) => liveHeights[c.dseq]?.height ?? 0),
      )
    : 0;

  // the idle wizard can be dismissed when there is a completed launch to
  // return to (e.g. after clicking "new launch", or when the launcher opened
  // on the editor with a chain already running)
  const completedFleets = (fleet?.fleets ?? []).filter((f) => f.launchStatus === "completed");
  const cancelTargetId = completedFleets
    .map((f) => f.launchId)
    .filter((id) => id !== launchId)
    .pop();

  const fleetMonthlyUsd = (comps: ComponentView[]) => {
    let total = 0;
    for (const c of comps) {
      if (c.state !== "active") continue;
      if (c.priceDenom.replace(/^u/, "").toUpperCase() !== "ACT") return null;
      const m = monthlyNum(c.price);
      if (m === null) return null;
      total += m;
    }
    return total;
  };

  const copyAddress = (address: string, name: string) => {
    try {
      navigator.clipboard.writeText(address);
    } catch {
      // clipboard unavailable (http origin) — the toast still confirms intent
    }
    showToast(`address copied (${name})`);
  };

  const costRange = costEstimate
    ? `$${(costEstimate.totalLowUsd + costEstimate.feeLowUsd).toFixed(2)}–${(
        costEstimate.totalHighUsd + costEstimate.feeHighUsd
      ).toFixed(2)}`
    : null;
  const monthlyRange = costEstimate
    ? `$${costEstimate.totalLowUsd.toFixed(2)}–${costEstimate.totalHighUsd.toFixed(2)}`
    : null;

  const launchDisabled =
    !wallet ||
    busy !== null ||
    !specCheck.ok ||
    depositShortfall > 0 ||
    assetsNeedCommit ||
    assetsUnavailable ||
    assetsUnknown;
  const launchDisabledWhy = !wallet
    ? "connect Keplr first"
    : !specCheck.ok
      ? "fix the spec errors first"
      : assetsNeedCommit
        ? "pin the chain-repo commit for this chain version first"
        : assetsUnavailable || assetsUnknown
          ? "this launcher cannot serve the spec's chain version (see the chain-assets note)"
          : depositShortfall > 0
            ? `the wallet is short ${microToDisplay(String(depositShortfall))} ${denomLabel} for deposits`
            : undefined;

  const wizardGo = (i: number) => {
    if (i <= wizMax) setWizStep(i);
  };
  const wizardNext = () => {
    const n = Math.min(2, wizStep + 1);
    setWizStep(n);
    setWizMax((m) => Math.max(m, n));
  };

  // ---- shared render pieces ----

  const specIssueList = (compact = false) =>
    specCheck.errors.length > 0 || specCheck.warnings.length > 0 ? (
      <ul className="issues">
        {specCheck.errors.map((iss, i) => {
          const line = issueLine(iss.path);
          return (
            <li
              key={`e-${iss.path}-${i}`}
              className={line && !compact ? "err jump" : "err"}
              onClick={line && !compact ? () => jumpToLine(line) : undefined}
              title={line && !compact ? "click to jump to the line" : undefined}
            >
              ✕ {line ? `line ${line}, ` : ""}
              {iss.path ? `${iss.path}: ` : ""}
              {iss.message}
            </li>
          );
        })}
        {specCheck.warnings.map((iss, i) => {
          const line = issueLine(iss.path);
          return (
            <li
              key={`w-${iss.path}-${i}`}
              className={line && !compact ? "warn jump" : "warn"}
              onClick={line && !compact ? () => jumpToLine(line) : undefined}
              title={line && !compact ? "click to jump to the line" : undefined}
            >
              ⚠ {line ? `line ${line}, ` : ""}
              {iss.path ? `${iss.path}: ` : ""}
              {iss.message}
            </li>
          );
        })}
      </ul>
    ) : null;

  // §13: chain-asset banners — the plain Offline/Online toggle lives in the
  // settings cog menu; these are the spec-scoped states: the commit prompt
  // when nothing else resolves, escalation for unknown versions, remediation
  // for known ones, a quiet confirmation otherwise
  const assetsBanner = () => {
    if (assetsUnknown) {
      const known = chainAssets?.knownVersions ?? [];
      return (
        <div className="ready-banner warn">
          <span className="grow">
            {specImage} is unknown to this launcher: a typo, or a release newer than this
            build. Known versions: {known.slice(0, 5).join(", ")}
            {known.length > 5 ? ", …" : ""}. Fix the version, seed the cache (pnpm
            seed-chain-assets {specImage}){chainAssets?.locked ? "" : ", or go online"}.
          </span>
          {!chainAssets?.locked && (
            <button
              className="btn amber"
              style={{ flex: "none" }}
              onClick={() => toggleAssetsMode("fetch")}
            >
              Switch to Online
            </button>
          )}
        </div>
      );
    }
    if (assetsUnavailable)
      return (
        <div className="ready-banner warn">
          <span className="grow">
            {specImage} is a known release, but this launcher is in Offline mode with no
            local assets for it (baked: {chainAssets?.bakedVersion}). Seed the cache (pnpm
            seed-chain-assets {specImage}), rebuild for that version
            {chainAssets?.locked ? "." : ", or go online."}
          </span>
          {!chainAssets?.locked && (
            <button
              className="btn amber"
              style={{ flex: "none" }}
              onClick={() => toggleAssetsMode("fetch")}
            >
              Switch to Online
            </button>
          )}
        </div>
      );
    if (assetsNeedCommit)
      return (
        <div className="ready-banner warn">
          <span className="grow">
            No chain release or repo tag matches {specImage}. Pin the commit to pair its
            deploy data with{chainAssets?.headCommit ? " (repo HEAD proposed)" : ""}:
          </span>
          <input
            className="field"
            style={{ flex: "1 1 300px", fontFamily: "var(--mono, monospace)" }}
            value={repoCommitDraft}
            onChange={(e) => setRepoCommitDraft(e.target.value)}
            placeholder="chain-repo commit hash"
          />
          <button
            className="btn amber"
            style={{ flex: "none" }}
            onClick={pinRepoCommit}
            disabled={!repoCommitValid}
          >
            Pin commit
          </button>
        </div>
      );
    if (
      chainAssets &&
      (chainAssets.resolution === "release" ||
        chainAssets.resolution === "tag" ||
        chainAssets.resolution === "pin" ||
        chainAssets.resolution === "cache")
    )
      return (
        <div className="ready-banner ok">
          <span className="grow">
            ✓ Chain assets{" "}
            {chainAssets.resolution === "cache"
              ? "are cached locally"
              : `will be fetched (deploy data via ${
                  chainAssets.resolution === "release"
                    ? "the release manifest"
                    : chainAssets.resolution === "tag"
                      ? "matching tag"
                      : "pinned commit"
                }${chainAssets.commit ? ` @ ${chainAssets.commit.slice(0, 12)}` : ""})`}
            .
          </span>
        </div>
      );
    return null;
  };

  const costBreakdownRows = (short: boolean) => {
    if (!resolvedImages) return null;
    const rows = resolvedImages.map((r) => {
      const cost = costEstimate?.perRole.find((c) => c.role === r.role);
      const v = cost
        ? `${cost.count > 1 ? `${cost.count} × ` : ""}$${cost.unitLowUsd.toFixed(2)}–${cost.unitHighUsd.toFixed(2)}`
        : "—";
      return { k: r.role + (r.count > 1 ? ` ×${r.count}` : ""), d: r.image, v };
    });
    rows.push({
      k: "deposits",
      d: `${depositActStr} refundable when you shut down`,
      v: "—",
    });
    if (costEstimate && costEstimate.feeBps > 0) {
      rows.push({
        k: "launch fee",
        d: `one-time, ${costEstimate.feeBps / 100}% of the leased monthly rate, paid in AKT`,
        v: `$${costEstimate.feeLowUsd.toFixed(2)}–${costEstimate.feeHighUsd.toFixed(2)}`,
      });
    }
    return (
      <div style={{ marginTop: short ? 10 : 14 }}>
        {rows.map((r) =>
          short ? (
            <div key={r.k} className="rail-row" title={r.d}>
              <span className="k">{r.k}</span>
              <span className="v">{r.v}</span>
            </div>
          ) : (
            <div key={r.k} className="cost-row">
              <div className="k">{r.k}</div>
              <div className="d">{r.d}</div>
              <div className="v">{r.v}</div>
            </div>
          ),
        )}
        {costRange && !short && (
          <div className="cost-total">
            <div>total, first month</div>
            <div className="v">{costRange}</div>
          </div>
        )}
      </div>
    );
  };

  const mintBlock = (compact: boolean) => (
    <>
      {ledger?.last_status === "canceled" && (
        <div className="banner fail" style={{ marginTop: 12 }}>
          Your last mint was canceled at settlement
          {ledger.last_cancel_reason
            ? `: ${BME_CANCEL_REASONS[ledger.last_cancel_reason] ?? ledger.last_cancel_reason}`
            : ""}
          . The burned AKT is refunded to your wallet.
        </div>
      )}
      <div className={compact ? "mint-row" : "sub-card mint-row"} style={{ marginTop: 14 }}>
        <div className="grow">
          <div className="title">Mint ACT from AKT</div>
          <div className="sub">
            Arrives after the next settlement epoch.
            {bme?.min_mint_uact && ` Minimum ${microToDisplay(bme.min_mint_uact)} ACT.`}
            {estimatedMintUact !== null && (
              <span className={belowMinMint ? " " : undefined}>
                {" "}
                ≈ {microToDisplay(String(estimatedMintUact))} ACT out
                {belowMinMint && " (below the minimum, the chain would cancel it)"}
              </span>
            )}
          </div>
        </div>
        <input
          className="mint-amt"
          value={mintAmount}
          onChange={(e) => setMintAmount(e.target.value)}
          placeholder="AKT"
          inputMode="decimal"
        />
        <button
          className="btn primary small"
          onClick={mint}
          disabled={busy !== null || !mintAmount || belowMinMint || !bme?.mints_allowed}
          title="Minting burns AKT and settles asynchronously via the BME ledger"
        >
          Mint ACT
        </button>
      </div>
      {bme && !bme.mints_allowed && (
        <div className="banner fail">
          The BME circuit breaker has halted ACT mints on this network. Try again later.
        </div>
      )}
      {ledger && ledger.pending > 0 && (
        <div className="mint-note pending">
          ⟳ {ledger.pending} mint{ledger.pending > 1 ? "s" : ""} settling, the ACT arrives after
          the next settlement epoch…
        </div>
      )}
      {aktPrice === null && wallet && (
        <div className="dim-note" style={{ marginTop: 8 }}>
          Price feed unreachable: no output estimate; below-minimum mints are canceled by the
          chain.
        </div>
      )}
    </>
  );

  const readyRailCard = (
    <div className={`ready-card ${walletReady ? "ok" : "warn"}`}>
      <div className="head">
        <span className={`t ${walletReady ? "ok" : "warn"}`}>
          {walletReady ? "✓ Wallet ready" : wallet ? `Needs more ${denomLabel}` : "No wallet"}
        </span>
        <span className="have">
          {balances ? microToDisplay(balanceOf(chain.denom) ?? "0") : "—"} / {depositActStr}
        </span>
      </div>
      <div className="meter">
        <i className={walletReady ? "ok" : "warn"} style={{ width: `${actPct}%` }} />
      </div>
      {!wallet && (
        <button className="btn wide" onClick={() => connect()}>
          Connect Keplr
        </button>
      )}
      {wallet && !walletReady && (
        <button
          className="btn amber wide"
          onClick={() => {
            switchMode("guided");
            setWizStep(0);
          }}
        >
          Mint ACT from AKT
        </button>
      )}
    </div>
  );

  const editorRail = (
    <div className="rail">
      <div className="rail-card">
        <div className="head">
          <span className="stat-k">EST. FIRST MONTH</span>
          <button className="btn link" style={{ fontSize: 11.5 }} onClick={() => setCostOpen((v) => !v)}>
            {costOpen ? "hide ▴" : "breakdown ▾"}
          </button>
        </div>
        <div className="big">{costRange ?? "—"}</div>
        <div className="sub">
          then {monthlyRange ?? "—"}/mo · +{depositActStr} deposit, refundable
        </div>
        {costOpen && costBreakdownRows(true)}
      </div>
      {readyRailCard}
      <button
        className="btn primary wide"
        onClick={create}
        disabled={launchDisabled}
        title={launchDisabledWhy}
      >
        Launch {specName || "chain"} →
      </button>
    </div>
  );

  const typeSeg = (
    <div className="seg fill">
      {["devnet", "testnet", "mainnet"].map((t) => (
        <button key={t} className={specType === t ? "on" : ""} onClick={() => setSpecType(t)}>
          {t}
        </button>
      ))}
    </div>
  );

  const counter = (value: number, kind: "validators" | "sentries") => (
    <div className="counter">
      <button onClick={() => setSpecCount(kind, -1)}>−</button>
      <div className="n">{value}</div>
      <button onClick={() => setSpecCount(kind, +1)}>+</button>
    </div>
  );

  const specTextarea = (height: number) => (
    <textarea
      ref={specRef}
      className={`spec${specCheck.errors.length > 0 ? " invalid" : ""}`}
      value={specText}
      onChange={(e) => updateSpec(e.target.value)}
      style={{ height }}
      spellCheck={false}
    />
  );

  // step rows for the launching view, mapped from the conductor's real steps
  const stepRow = (s: LaunchView["steps"][number]) => {
    const cls =
      s.status === "done"
        ? "done"
        : s.status === "running"
          ? "active"
          : s.status === "error"
            ? "err"
            : s.status === "waiting"
              ? "waiting"
              : "";
    return (
      <div key={s.name} className={`launch-row ${cls}`}>
        {s.status === "running" ? (
          <span className="spin" />
        ) : (
          <span className="mark">
            {s.status === "done" ? "✓" : s.status === "error" ? "✕" : s.status === "waiting" ? "!" : "·"}
          </span>
        )}
        <span className="lbl">{s.name}</span>
        <span className="op">{s.status}</span>
      </div>
    );
  };

  // action banners: signature prompts, gentx, waiting-on-you, failures —
  // they follow the launch card whatever state the card itself is in
  const launchBanners = launch && (
    <>
      {pending && (
        <div className="banner sign">
          <span>
            Signature needed for <b>{pending.step}</b>{" "}
            {/* name the messages, not just a count: a user mid-task once
                signed another op's MsgCloseDeployment believing it was part
                of their own flow */}
            ({[...new Set(pending.msgs.map((m) => m.typeUrl.split(".").pop() ?? m.typeUrl))].join(", ")}
            {pending.msgs.length > 1 ? ` × ${pending.msgs.length}` : ""})
            {/* a request read minutes after the click needs to say what it
                came from, or the only safe move looks like signing it */}
            {pending.origin && <span className="dim-note"> · {pending.origin}</span>}
          </span>
          <button onClick={sign} className="btn primary small" disabled={busy !== null}>
            Sign with Keplr
          </button>
          <button
            className="btn"
            title={
              pending.kind === "fleet-action"
                ? "Cancel this request without signing. Nothing is broadcast and the action does not happen."
                : "Clear this request without signing. The step re-creates it the next time the launch resumes."
            }
            onClick={() => dismissPendingTx()}
            disabled={busy !== null}
          >
            {pending.kind === "fleet-action" ? "cancel request" : "dismiss"}
          </button>
          {signFailedStep === pending.step && (
            <button
              className="btn"
              title="Re-run the step to regenerate this transaction (use after a conductor fix or if signing keeps failing)"
              onClick={() => {
                setSignFailedStep(null);
                if (launchId) resumeLaunch(launchId).catch((e) => setError(String(e)));
              }}
              disabled={busy !== null}
            >
              rebuild tx
            </button>
          )}
        </div>
      )}
      {pendingGentx &&
        (() => {
          const msgType = (pendingGentx.signDoc as { msgs?: Array<{ type?: string }> })?.msgs?.[0]?.type;
          const isUnjail = msgType === "cosmos-sdk/MsgUnjail";
          return (
            <div className="banner sign">
              <span>
                {isUnjail ? (
                  <>
                    Unjail signature needed for <b>validator {pendingGentx.valIndex}</b>, operator{" "}
                    <code>{pendingGentx.address}</code> (live tx on the chain; select the matching
                    account in Keplr)
                  </>
                ) : (
                  <>
                    Gentx signature needed for <b>validator {pendingGentx.valIndex}</b>, operator{" "}
                    <code>{pendingGentx.address}</code> (offline, on the new chain; select the
                    matching account in Keplr)
                  </>
                )}
              </span>
              <button onClick={signGentxNow} className="btn primary small" disabled={busy !== null}>
                {isUnjail ? "Sign unjail with Keplr" : "Sign gentx with Keplr"}
              </button>
              {pendingGentx.unsignedTx !== undefined && (
                <details style={{ width: "100%", marginTop: 8 }}>
                  <summary style={{ cursor: "pointer" }}>
                    Sign offline instead (operator key on another machine)
                  </summary>
                  <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                    <span>
                      1. Save this unsigned tx as <code>unsigned-tx.json</code> on the signing
                      machine:{" "}
                      <button
                        className="btn small"
                        onClick={() =>
                          navigator.clipboard.writeText(
                            JSON.stringify(pendingGentx.unsignedTx, null, 2),
                          )
                        }
                      >
                        copy unsigned tx
                      </button>
                    </span>
                    <span>2. Sign it there with the operator key:</span>
                    <pre style={{ overflowX: "auto", margin: 0 }}>
                      <code>{pendingGentx.signCommand}</code>
                    </pre>
                    <span>
                      3. Paste the contents of <code>signed-tx.json</code>:
                    </span>
                    <textarea
                      rows={5}
                      value={offlineGentxText}
                      onChange={(e) => setOfflineGentxText(e.target.value)}
                      placeholder='{"body": ..., "auth_info": ..., "signatures": [...]}'
                      style={{ fontFamily: "monospace", width: "100%" }}
                    />
                    <button
                      className="btn primary small"
                      onClick={submitOfflineGentx}
                      disabled={busy !== null || !offlineGentxText.trim()}
                      style={{ justifySelf: "start" }}
                    >
                      Submit offline signature
                    </button>
                  </div>
                </details>
              )}
            </div>
          );
        })()}
      {launch.status === "aborted" && (
        <div className="banner wait">
          This launch was aborted: its deployments are closed (deposits refunded). Adjust the
          spec and launch again.
        </div>
      )}
      {!pending && !pendingGentx && waitingStep && launch.status !== "aborted" && (
        <div className="banner wait">
          <span>
            <b>{waitingStep.name}</b> is waiting on you
            {reportedAgo(waitingStep) && (
              <span className="dim-note"> (reported {reportedAgo(waitingStep)})</span>
            )}
            :
          </span>
          <pre>{waitingStep.error}</pre>
          {awaitingSigner(waitingStep.name) && (
            <button className="btn" onClick={() => launchId && showTmkms(launchId)}>
              Show tmkms signer setup
            </button>
          )}
          <button
            className="btn"
            onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
          >
            I did it, resume
          </button>
        </div>
      )}
      {failedStep && launch.status !== "aborted" && (
        <div className="banner fail">
          <span>
            <b>{failedStep.name}</b> failed
            {reportedAgo(failedStep) && (
              <span className="dim-note"> ({reportedAgo(failedStep)})</span>
            )}
            :
          </span>
          <pre>{failedStep.error}</pre>
          <button
            className="btn"
            onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );

  return (
    <main className="shell">
      <NebulaField />
      {/* ---------- top bar ---------- */}
      <header className="topbar">
        <div className="logo">
          <span className="logo-glyph" aria-hidden="true" />
          <h1>
            Spark Dream <span>Launcher</span>
          </h1>
        </div>
        {headlineFleet ? (
          launching && headlineFleet.launchId === launchId ? (
            <div className="pill busy-pill">
              <span className="dot" />
              <span className="chain-name" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {headlineFleet.chainId}
              </span>
              <span className="state">{activeOpKinds.length > 0 ? "working" : "launching"}</span>
            </div>
          ) : (
            <div className="pill live">
              <span className="dot" />
              <span className="chain-name">{headlineFleet.chainId}</span>
              <span className="state">running</span>
              {headlineHeight > 0 && (
                <span className="mono">block {headlineHeight.toLocaleString()}</span>
              )}
            </div>
          )
        ) : (
          <div className="pill none">
            <span className="dot" />
            <span>no chain yet</span>
          </div>
        )}
        {!wallet && (
          <button className="btn primary small" style={{ marginLeft: "auto" }} onClick={() => connect()}>
            Connect Keplr
          </button>
        )}
        <div
          className="net-pill"
          style={wallet ? undefined : { marginLeft: 0 }}
          onClick={() => setNetworkOpen((v) => !v)}
          title="Akash network settings and wallet balances"
        >
          <span className={`dot ${wallet ? "on" : "off"}`} />
          <span>{chain.chainName}</span>
          {wallet && balances && (
            <span className="bal">
              {microToDisplay(balanceOf("uakt"))} AKT · {microToDisplay(balanceOf("uact"))} ACT
            </span>
          )}
          {ledger && ledger.pending > 0 && <span className="bal">⟳ {ledger.pending} settling</span>}
          <span className="chev">{networkOpen ? "▴" : "▾"}</span>
        </div>
        <div className="settings-wrap" ref={settingsRef}>
          <button
            className="settings-cog"
            title="Launcher settings"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙
          </button>
          {settingsOpen && (
            <div className="settings-menu" role="menu">
              <button className="menu-item" role="menuitem" onClick={() => openSystem("backup")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="5" rx="1" />
                  <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                  <path d="M10 12h4" />
                </svg>
                <span className="mi-text">
                  <span className="mi-title">Backup</span>
                  <span className="mi-sub">Export or import launcher data</span>
                </span>
              </button>
              <button className="menu-item" role="menuitem" onClick={() => openSystem("assets")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7.5 4.27 9 5.15" />
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="M3.3 7 12 12l8.7-5" />
                  <path d="M12 22V12" />
                </svg>
                <span className="mi-text">
                  <span className="mi-title">Chain asset source</span>
                  <span className={`mi-sub${chainAssets?.mode === "fetch" ? " on" : ""}`}>
                    {chainAssets
                      ? `${chainAssets.mode === "baked" ? "Offline" : "Online"}${chainAssets.locked ? " (locked)" : ""}`
                      : "Offline or Online chain versions"}
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ---------- network settings ---------- */}
      {networkOpen && (
        <section className="net-panel">
          <div className="head">
            <span className="k">AKASH NETWORK</span>
            <span className="v">
              {chain.chainId} · {chain.denom} · {rpcHost}
            </span>
            {chainIsCustom && (
              <span
                className="v"
                style={{ color: "var(--amber-text)" }}
                title="One or more values differ from the built-in Akash mainnet defaults"
              >
                custom
              </span>
            )}
            <span className="note">deployments and the launch fee settle here</span>
            {wallet && (
              <span className="v" title={wallet.address}>
                connected: {wallet.name} ({wallet.address.slice(0, 14)}…)
              </span>
            )}
          </div>
          <div className="net-grid">
            {(
              [
                ["chainId", "chain id"],
                ["chainName", "name"],
                ["rpc", "rpc"],
                ["rest", "rest (lcd)"],
                ["denom", "denom"],
                ["bech32Prefix", "prefix"],
                ["gasPrice", "gas price"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <div className="f-label">{label}</div>
                <input
                  className="field"
                  value={chain[key]}
                  onChange={(e) => updateChain({ [key]: e.target.value })}
                />
              </div>
            ))}
            <div className="actions">
              <button
                className="btn accent-ghost"
                title="Register this network in Keplr (one-time; akashnet-2 is already known to Keplr)"
                onClick={() => suggestChain(chain).catch((e) => setError(String(e)))}
              >
                Suggest chain to Keplr
              </button>
              {chainIsCustom && (
                <button className="btn" onClick={() => updateChain(DEFAULT_CHAIN)}>
                  Reset to Akash mainnet
                </button>
              )}
            </div>
          </div>
          {wallet && bme && <div className="net-mint">{mintBlock(true)}</div>}
        </section>
      )}

      {backupPrompt && (
        <div className="modal-scrim" onClick={() => !backupBusy && setBackupPrompt(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="k">
              {backupPrompt.mode === "export" ? "Create launcher backup" : "Restore launcher backup"}
            </div>
            <p className="note">
              {backupPrompt.mode === "export"
                ? "Choose a passphrase to encrypt the archive. You will need the same passphrase to restore it, and it cannot be recovered if lost."
                : "Enter the passphrase this backup was encrypted with. Launches already present here are left untouched."}
            </p>
            <input
              className="field"
              type="password"
              autoFocus
              placeholder="passphrase"
              value={backupPass}
              onChange={(e) => setBackupPass(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && backupPass && !backupBusy) runBackup();
              }}
            />
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn primary small"
                disabled={!backupPass || backupBusy}
                onClick={runBackup}
              >
                {backupBusy
                  ? "Working…"
                  : backupPrompt.mode === "export"
                    ? "Create"
                    : "Restore"}
              </button>
              <button className="btn" disabled={backupBusy} onClick={() => setBackupPrompt(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="content">
        {/* ---------- system panel (opened from the settings cog) ---------- */}
        {systemOpen && (
          <section className="card sys-panel">
            <div className="card-head">
              <div>
                <div className="card-title">System</div>
                <div className="card-sub">launcher-wide tools and settings</div>
              </div>
              <button className="btn" onClick={() => setSystemOpen(false)}>
                Close
              </button>
            </div>
            <div className="card-body sys-blocks">
              <div className={`sys-block${sysFocus === "backup" ? " focus" : ""}`}>
                <div className="f-label">Backup</div>
                <div className="sys-desc">
                  One encrypted archive of every fleet: keys, deployment records and settings.
                  Create one to move this launcher to another machine, or restore one here
                  (launches already present are left untouched).
                </div>
                <div className="sys-actions">
                  <button
                    className="btn accent-ghost"
                    title="Best done while no launch is running"
                    onClick={() => {
                      setBackupReport(null);
                      setBackupError(null);
                      setBackupPass("");
                      setBackupPrompt({ mode: "export" });
                    }}
                  >
                    Create backup
                  </button>
                  <label className="btn">
                    Restore backup
                    <input
                      ref={backupInputRef}
                      type="file"
                      accept=".enc"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setBackupReport(null);
                        setBackupError(null);
                        setBackupPass("");
                        setBackupPrompt({ mode: "import", file });
                        e.target.value = ""; // allow re-selecting the same file
                      }}
                    />
                  </label>
                </div>
                {backupReport && (
                  <div className="ready-banner ok">
                    <span className="grow">
                      Restored {backupReport.restored.length} launch(es)
                      {backupReport.restored.length > 0 && `: ${backupReport.restored.join(", ")}`}.
                      {backupReport.skipped.length > 0 &&
                        ` Skipped ${backupReport.skipped.length} already present: ${backupReport.skipped.join(", ")}.`}
                      {backupReport.settingsAdded.length > 0 &&
                        ` Filled ${backupReport.settingsAdded.length} setting(s).`}
                    </span>
                    <button className="btn" style={{ flex: "none" }} onClick={() => setBackupReport(null)}>
                      Dismiss
                    </button>
                  </div>
                )}
                {backupError && (
                  <div className="ready-banner warn">
                    <span className="grow">{backupError}</span>
                    <button className="btn" style={{ flex: "none" }} onClick={() => setBackupError(null)}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
              <div className={`sys-block${sysFocus === "assets" ? " focus" : ""}`}>
                <div className="f-label">Chain asset source</div>
                <div className="sys-desc">
                  Where the chain node binary and its deploy config come from when a launch
                  needs a version. Offline uses only locally cached versions with zero
                  network; Online fetches and verifies them as needed. Service images
                  (frontend, explorer, ...) are unaffected: providers pull those directly.
                </div>
                {chainAssets ? (
                  <div className="sys-actions">
                    <span className={`sys-mode${chainAssets.mode === "fetch" ? " on" : ""}`}>
                      {chainAssets.mode === "baked" ? "Offline" : "Online"}
                      {chainAssets.locked ? " (set by the operator)" : ""}
                    </span>
                    {!chainAssets.locked && (
                      <button
                        className="btn"
                        onClick={() =>
                          toggleAssetsMode(chainAssets.mode === "baked" ? "fetch" : "baked")
                        }
                      >
                        Switch to {chainAssets.mode === "baked" ? "Online" : "Offline"}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="sys-desc">mode unavailable (conductor unreachable)</div>
                )}
              </div>
            </div>
          </section>
        )}
        {/* ---------- launch card ---------- */}
        {/* the accent border matches the selected fleet pair below, tying the
            step log to the fleet it belongs to */}
        <section className={`card${loadingLaunch || launching || launched ? " viewing" : ""}`}>
          <div
            className={`card-head${launched ? " clickable" : ""}`}
            title={launched ? "show / hide the launch step log" : undefined}
            onClick={launched ? toggleLog : undefined}
          >
            {idle && (
              <>
                <div>
                  <div className="card-title">Launch your chain</div>
                  <div className="card-sub">
                    Guided setup, or switch to the form or raw YAML.
                    {costRange && ` Est. ${costRange} first month.`}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                  <div className="seg tight">
                    {(
                      [
                        ["guided", "Guided"],
                        ["form", "Form"],
                        ["yaml", "YAML"],
                      ] as const
                    ).map(([m, label]) => (
                      <button key={m} className={mode === m ? "on" : ""} onClick={() => switchMode(m)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {cancelTargetId && (
                    <button
                      className="btn"
                      title="Close the launch editor and go back to your running chain (nothing is discarded; the spec stays as edited)"
                      onClick={() => {
                        localStorage.setItem(LAST_LAUNCH_KEY, cancelTargetId);
                        setLaunchId(cancelTargetId);
                        setWizStep(0);
                        setWizMax(0);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
            {loadingLaunch && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div className="card-title">Launch</div>
                {(() => {
                  const name = fleet?.fleets.find((f) => f.launchId === launchId)?.name;
                  return name ? <span className="tag name">{name}</span> : null;
                })()}
                <span className="spinner" />
                {/* invisible twin of the launched header's button keeps the
                    row height identical, so the card doesn't jump while the
                    launch view loads */}
                <button className="btn" style={{ visibility: "hidden" }} aria-hidden tabIndex={-1}>
                  new launch
                </button>
              </div>
            )}
            {launching && (
              <>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div className="card-title">Launch</div>
                    <span className="tag name">{launchName}</span>
                    <span className="card-title" style={{ fontWeight: 500 }}>
                      {activeOpKinds.length > 0
                        ? `working: ${activeOpKinds.join(", ")}…`
                        : "launching…"}
                    </span>
                  </div>
                  <div className="card-sub">
                    {activeOpKinds.length > 0
                      ? "This operation runs through the same steps and signatures as a launch."
                      : "Leases, genesis and services. Deposits stay refundable."}
                  </div>
                </div>
                <span className="mono-dim" style={{ flex: "none", fontSize: 12 }}>
                  {launchPct}% · step {Math.min(totalSteps, doneSteps + 1)} of {totalSteps}
                </span>
                {isTmkms && (
                  <button
                    className="btn"
                    title="Signer machine setup: mesh join command, consensus key, tmkms.toml"
                    onClick={() => launchId && showTmkms(launchId)}
                  >
                    tmkms setup
                  </button>
                )}
              </>
            )}
            {launched && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div className="card-title">Launch</div>
                  <span className="tag name">{launchName}</span>
                  <span className="card-title" style={{ fontWeight: 500 }}>
                    is live
                  </span>
                  <span className="badge-ok">
                    completed · {doneSteps}/{totalSteps}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}>
                  <span className="mono-dim">spec {launch!.id.slice(0, 8)}</span>
                  {isTmkms && (
                    <button
                      className="btn"
                      title="Signer machine setup: mesh join command, consensus key, tmkms.toml"
                      onClick={(e) => {
                        e.stopPropagation();
                        launchId && showTmkms(launchId);
                      }}
                    >
                      tmkms setup
                    </button>
                  )}
                  <button
                    className="btn"
                    title="Start a fresh launch from the spec editor (this chain keeps running)"
                    onClick={(e) => {
                      e.stopPropagation();
                      localStorage.removeItem(LAST_LAUNCH_KEY);
                      setLaunchId(null);
                    }}
                  >
                    new launch
                  </button>
                  <span style={{ color: "var(--dim2)", fontSize: 13 }}>{logOpen ? "▴" : "▾"}</span>
                </div>
              </>
            )}
          </div>

          {/* guided wizard */}
          {idle && mode === "guided" && (
            <div className="card-body">
              <div className="wiz-tabs">
                {["Wallet", "Configure", "Review"].map((label, i) => {
                  const done = i < wizStep;
                  const active = i === wizStep;
                  return (
                    <button
                      key={label}
                      className={`wiz-tab${active ? " active" : done ? " done" : ""}${i <= wizMax ? " reachable" : ""}`}
                      onClick={() => wizardGo(i)}
                    >
                      <span className="wiz-num">{done ? "✓" : i + 1}</span>
                      {label}
                    </button>
                  );
                })}
              </div>

              {wizStep === 0 && (
                <div className="wiz-body">
                  <div className="wiz-intro">
                    Deployments are paid in ACT. This launch needs about{" "}
                    <b>{depositActStr}</b> in refundable deposits: mint it from your AKT balance
                    first.
                  </div>
                  <div className="dim-note" style={{ marginTop: 9, fontSize: 12 }}>
                    Paying on{" "}
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--dim)" }}>
                      {chain.chainId} · {chain.denom} · {rpcHost}
                    </span>{" "}
                    ·{" "}
                    <button className="btn link" onClick={() => setNetworkOpen(true)}>
                      network settings
                    </button>
                  </div>
                  {!wallet ? (
                    <div className="sub-card" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Connect your wallet</div>
                        <div className="stat-sub">
                          Keplr signs every transaction; the launcher never holds your keys.
                        </div>
                      </div>
                      <button className="btn primary small" onClick={() => connect()}>
                        Connect Keplr
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="two-col" style={{ marginTop: 16 }}>
                        <div className="sub-card">
                          <div className="stat-k">AKT · AKASH</div>
                          <div className="stat-v">
                            {balances ? microToDisplay(balanceOf("uakt")) : "—"}
                          </div>
                          <div className="stat-sub">available to convert</div>
                        </div>
                        <div className="sub-card">
                          <div className="stat-k">{denomLabel} · DEPLOYMENT CREDIT</div>
                          <div className="stat-v">
                            {balances ? microToDisplay(balanceOf(chain.denom)) : "—"}
                          </div>
                          <div className="meter" style={{ marginTop: 9 }}>
                            <i
                              className={walletReady ? "ok" : "warn"}
                              style={{ width: `${actPct}%` }}
                            />
                          </div>
                          <div
                            className="stat-sub"
                            style={{
                              marginTop: 6,
                              color: walletReady ? "var(--ok)" : "var(--amber)",
                            }}
                          >
                            {walletReady
                              ? "✓ enough for this launch"
                              : `${microToDisplay(balanceOf(chain.denom) ?? "0")} of ${depositActStr} needed`}
                          </div>
                        </div>
                      </div>
                      {bme && mintBlock(false)}
                    </>
                  )}
                  <div className="wiz-nav end">
                    <button className="btn primary" onClick={wizardNext}>
                      Continue →
                    </button>
                  </div>
                </div>
              )}

              {wizStep === 1 && (
                <div className="wiz-body">
                  <div className="two-col narrow">
                    <div>
                      <div className="f-label">Chain name</div>
                      <input
                        className="field"
                        value={specName}
                        onChange={(e) => setSpecName(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="f-label">Network type</div>
                      {typeSeg}
                    </div>
                    <div>
                      <div className="f-label">Token symbol</div>
                      <input
                        className="field"
                        value={specSym}
                        onChange={(e) => setSpecSym(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="f-label">Dream token</div>
                      <input
                        className="field"
                        value={specDream}
                        onChange={(e) => setSpecDream(e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="f-label">
                        Validators <span className="hint">· the nodes that sign blocks</span>
                      </div>
                      {counter(specVals, "validators")}
                    </div>
                    <div>
                      <div className="f-label">
                        Sentries <span className="hint">· shield your validators</span>
                      </div>
                      {counter(specSents, "sentries")}
                    </div>
                  </div>
                  <div style={{ marginTop: 18 }}>
                    <div className="f-label" style={{ marginBottom: 9 }}>
                      Genesis accounts
                    </div>
                    <div className="chips">
                      {specAccounts.map((a) => (
                        <span key={a} className="chip">
                          {a}
                        </span>
                      ))}
                      <button className="chip-add" onClick={addSpecAccount}>
                        + add
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: 18, display: "flex", gap: 12, alignItems: "center" }}>
                    <button className="btn link" onClick={() => setAdvOpen((v) => !v)}>
                      {advOpen ? "▾" : "▸"} Advanced: edit the raw spec (YAML)
                    </button>
                    <label className="btn link" style={{ cursor: "pointer" }}>
                      Prefill from genesis.json…
                      <input
                        type="file"
                        accept=".json,application/json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void prefillFromGenesisFile(file);
                        }}
                      />
                    </label>
                  </div>
                  {advOpen && <div style={{ marginTop: 10 }}>{specTextarea(220)}</div>}
                  {specIssueList(!advOpen)}
                  <div className="wiz-nav">
                    <button className="btn" onClick={() => setWizStep(0)}>
                      ← Back
                    </button>
                    <button className="btn primary" onClick={wizardNext}>
                      Review →
                    </button>
                  </div>
                </div>
              )}

              {wizStep === 2 && (
                <div className="wiz-body">
                  <div className="chips">
                    <span className="chip plain">{specName || "unnamed"}</span>
                    <span className="chip plain">{specType}</span>
                    <span className="chip plain">
                      {specSym || "?"} / {specDream}
                    </span>
                    <span className="chip plain">
                      {specVals} validator{specVals === 1 ? "" : "s"} · {specSents}{" "}
                      {specSents === 1 ? "sentry" : "sentries"} · {specAccounts.length} accounts
                    </span>
                  </div>
                  <div className="sub-card" style={{ marginTop: 16, padding: "18px 20px" }}>
                    <div className="cost-head">
                      <div>
                        <div className="stat-k">EST. FIRST MONTH</div>
                        <div className="cost-big">{costRange ?? "—"}</div>
                        <div className="stat-sub">
                          then {monthlyRange ?? "—"} / month · plus {depositActStr} refundable
                          deposit
                        </div>
                      </div>
                      <button className="btn" style={{ flex: "none" }} onClick={() => setCostOpen((v) => !v)}>
                        {costOpen ? "Hide breakdown ▴" : "See breakdown ▾"}
                      </button>
                    </div>
                    {costOpen && costBreakdownRows(false)}
                  </div>
                  <div className={`ready-banner ${walletReady ? "ok" : "warn"}`}>
                    <span className="grow">
                      {walletReady
                        ? `✓ Wallet ready: ${microToDisplay(balanceOf(chain.denom) ?? "0")} ${denomLabel} covers the ${depositActStr} deposit.`
                        : wallet
                          ? `This launch needs ${depositActStr} in deposits; you have ${
                              balances ? microToDisplay(balanceOf(chain.denom) ?? "0") : "?"
                            }.`
                          : "Connect your Keplr wallet on the Wallet step first."}
                    </span>
                    {!walletReady && (
                      <button className="btn amber" style={{ flex: "none" }} onClick={() => setWizStep(0)}>
                        {wallet ? "Go mint ACT" : "Go to Wallet"}
                      </button>
                    )}
                  </div>
                  {assetsBanner()}
                  {specIssueList(true)}
                  <div className="wiz-nav">
                    <button className="btn" onClick={() => setWizStep(1)}>
                      ← Back
                    </button>
                    <button
                      className="btn primary"
                      onClick={create}
                      disabled={launchDisabled}
                      title={launchDisabledWhy}
                    >
                      Launch {specName || "chain"} →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* form / yaml modes */}
          {idle && mode !== "guided" && (
            <div className="card-body">
              <div className="editor-grid">
                <div>
                  {mode === "form" && (
                    <>
                      <div className="two-col">
                        <div>
                          <div className="f-label">Chain name</div>
                          <input
                            className="field"
                            value={specName}
                            onChange={(e) => setSpecName(e.target.value)}
                          />
                        </div>
                        <div>
                          <div className="f-label">Network type</div>
                          {typeSeg}
                        </div>
                        <div>
                          <div className="f-label">Validators</div>
                          {counter(specVals, "validators")}
                        </div>
                        <div>
                          <div className="f-label">Sentries</div>
                          {counter(specSents, "sentries")}
                        </div>
                      </div>
                      <div className="dim-note" style={{ marginTop: 12 }}>
                        Tokens, accounts and service images keep the spec's current values.
                        Switch to YAML for full control.
                      </div>
                    </>
                  )}
                  {mode === "yaml" && (
                    <>
                      {specTextarea(280)}
                      <div className="spec-btns">
                        <label className="btn">
                          Import spec
                          <input
                            type="file"
                            accept=".yaml,.yml"
                            onChange={(e) => e.target.files?.[0] && importSpec(e.target.files[0])}
                          />
                        </label>
                        <button className="btn" onClick={exportSpec}>
                          Export spec
                        </button>
                        <button
                          className="btn"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Replace the spec with the built-in example? Your edits will be lost.",
                              )
                            ) {
                              updateSpec(EXAMPLE_SPEC);
                            }
                          }}
                        >
                          Reset to example
                        </button>
                      </div>
                    </>
                  )}
                  {assetsBanner()}
                  {specIssueList(mode !== "yaml")}
                </div>
                {editorRail}
              </div>
            </div>
          )}

          {/* launch progress (live) and the completed-launch step log */}
          {(launching || (launched && logOpen)) && (
            <div className="card-body">
              {launching && (
                <div className="progress-track">
                  <i style={{ width: `${launchPct}%` }} />
                </div>
              )}
              <div className="launch-rows">
                {collapseSteps && (
                  <button
                    className="launch-row done summary"
                    title="Show the completed steps"
                    onClick={() => setStepsExpanded(true)}
                  >
                    <span className="mark">✓</span>
                    <span className="lbl">{collapseCount} completed steps</span>
                    <span className="op">show ▾</span>
                  </button>
                )}
                {stepsExpanded && collapseCount > 2 && (
                  <button
                    className="launch-row done summary"
                    title="Collapse the completed steps"
                    onClick={() => setStepsExpanded(false)}
                  >
                    <span className="mark">✓</span>
                    <span className="lbl">hide completed steps</span>
                    <span className="op">hide ▴</span>
                  </button>
                )}
                {visibleSteps.map(stepRow)}
              </div>
            </div>
          )}

          {/* banners follow the card in every state */}
          {(pending || pendingGentx || waitingStep || failedStep || launch?.status === "aborted") && (
            <div className="card-body" style={{ paddingTop: launching || launched ? 0 : undefined }}>
              {launchBanners}
            </div>
          )}

          {/* server-side extras only (e.g. the launcher-on-Akash notice) — the
              shared validateSpec warnings already show live above */}
          {warnings.filter(
            (w) => !specCheck.warnings.some((l) => l.path === w.path && l.message === w.message),
          ).length > 0 && (
            <ul className="issues">
              {warnings
                .filter(
                  (w) =>
                    !specCheck.warnings.some((l) => l.path === w.path && l.message === w.message),
                )
                .map((w) => (
                  <li key={w.path} className="warn">
                    ⚠ {w.path}: {w.message}
                  </li>
                ))}
            </ul>
          )}
        </section>

        {/* ---------- empty fleet placeholder ---------- */}
        {wallet && (!fleet || fleet.fleets.length === 0) && (
          <div className="placeholder">
            Your fleet appears here once the chain is live: validator, sentry, headscale,
            explorer and frontend.
          </div>
        )}

        {/* ---------- fleet + accounts cards, one pair per launch ---------- */}
        {(fleet?.fleets ?? []).map((f) => {
          const shutDown =
            f.components.length > 0 && f.components.every((c) => c.state === "closed");
          const collapsed = shutDown && !showClosedFleet[f.launchId];
          // delete is offered on shut-down fleets (collapsed or not) and on
          // stale records that never placed anything (failed/aborted
          // attempts). A live draft ("created") or driving launch ("running")
          // gets no button; the server 409s a delete raced against the driver
          const deletable =
            shutDown ||
            (f.components.length === 0 &&
              (f.launchStatus === "aborted" || f.launchStatus === "paused"));
          const active = f.components.filter((c) => c.state === "active");
          const unhealthy = active.filter((c) => healthKind(c) !== "ok");
          const monthly = fleetMonthlyUsd(f.components);
          const prefs = providerPrefs[f.launchId];
          const actsOpen = fleetActsOpen[f.launchId] ?? false;
          const bodyOpen = fleetBodyOpen[f.launchId] ?? true;
          const deleteFleet = async () => {
            const ok = window.confirm(
              `Delete launch ${f.launchId.slice(0, 8)} (${f.chainId}) permanently?\n\n` +
                "This erases its records AND secrets (account mnemonics, validator keys) " +
                "from the launcher." +
                (f.components.length > 0
                  ? " Export the fleet bundle first if you want an archive."
                  : ""),
            );
            if (!ok) return;
            try {
              const { deleteLaunch } = await import("../lib/api");
              await deleteLaunch(f.launchId);
              if (launchId === f.launchId) {
                localStorage.removeItem(LAST_LAUNCH_KEY);
                setLaunchId(null);
              }
              setFleet((cur) =>
                cur
                  ? { ...cur, fleets: cur.fleets.filter((x) => x.launchId !== f.launchId) }
                  : cur,
              );
            } catch (e) {
              setError(String(e));
            }
          };
          const viewing = f.launchId === launchId;
          return (
            <Fragment key={f.launchId}>
              <section className={`card${viewing ? " viewing" : ""}`}>
                <div
                  className="card-head row-gap clickable"
                  title={
                    viewing
                      ? "show / hide the fleet components"
                      : "open this fleet's launch in the Launch panel at the top"
                  }
                  onClick={() => {
                    // first click selects the fleet (same as the old "view
                    // launch" button); expand/collapse only once selected
                    if (!viewing) {
                      localStorage.setItem(LAST_LAUNCH_KEY, f.launchId);
                      setLaunchId(f.launchId);
                      return;
                    }
                    if (shutDown) {
                      setShowClosedFleet((m) => ({ ...m, [f.launchId]: !m[f.launchId] }));
                    } else {
                      setFleetBodyOpen((m) => ({ ...m, [f.launchId]: !bodyOpen }));
                    }
                  }}
                >
                  <div className="card-title">Fleet</div>
                  {f.name && <span className="tag name">{f.name}</span>}
                  <span className="tag">{f.chainId}</span>
                  {viewing && (
                    <span
                      className="tag viewing-chip"
                      title="This fleet's launch is open in the Launch panel at the top of the page"
                    >
                      ▲ in Launch panel
                    </span>
                  )}
                  {shutDown ? (
                    <span className="dim-note">shut down · record kept</span>
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        color: unhealthy.length === 0 ? "var(--ok)" : "var(--amber-text)",
                      }}
                    >
                      {active.length} component{active.length === 1 ? "" : "s"} ·{" "}
                      {unhealthy.length === 0
                        ? "all healthy"
                        : `${unhealthy.length} need${unhealthy.length === 1 ? "s" : ""} attention`}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {monthly !== null && monthly > 0 && (
                      <span className="mono-dim" style={{ color: "var(--dim)", fontSize: 12 }}>
                        ${monthly.toFixed(2)}/mo
                      </span>
                    )}
                    <button
                      // always visible, even on a collapsed shut-down card
                      // (keeps the header height constant); toggles only the
                      // actions row
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFleetActsOpen((m) => ({ ...m, [f.launchId]: !actsOpen }));
                      }}
                    >
                      Fleet actions {actsOpen ? "▴" : "▾"}
                    </button>
                    <span style={{ color: "var(--dim2)", fontSize: 13 }}>
                      {collapsed || !bodyOpen ? "▾" : "▴"}
                    </span>
                  </span>
                </div>

                {actsOpen && (
                  <div className="fleet-acts">
                    {!shutDown && (
                      <>
                        <button
                          className="btn"
                          onClick={() => {
                            const feeNote =
                              fee && fee.upgradeFlat > 0
                                ? ` A ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added per upgrade (signed together).`
                                : "";
                            // node fleet only — prefill with a current node image so
                            // the expected ns/repo:tag format is obvious
                            const nodes = f.components.filter(
                              (c) => c.state === "active" && /^(val|sentry)-/.test(c.key),
                            );
                            const node = nodes[0];
                            const image = window.prompt(
                              `New sparkdreamd image for validators + sentries:${feeNote}`,
                              node?.image ?? undefined,
                            );
                            // skip only when the whole node fleet already runs the
                            // image — after an aborted mid-upgrade the fleet is mixed
                            // and re-running with the same tag is the retry path
                            if (image && node && nodes.some((c) => c.image !== image))
                              fleetAction(f.launchId, node.dseq, "upgrade", { image });
                          }}
                        >
                          rolling upgrade…
                        </button>
                        <button
                          className="btn"
                          onClick={async () => {
                            const feeNote =
                              fee && fee.upgradeFlat > 0
                                ? ` A ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added per upgrade (signed together).`
                                : "";
                            const image = window.prompt(
                              `New image for a coordinated (consensus-breaking) upgrade:${feeNote}`,
                            );
                            if (!image) return;
                            const h = window.prompt("Halt height:");
                            const first = f.components.find(
                              (c) => c.state === "active" && c.key !== "headscale",
                            );
                            if (h && first) {
                              const { postFleetAction: post } = await import("../lib/api");
                              await post(f.launchId, first.dseq, "halt-upgrade", {
                                image,
                                haltHeight: Number(h),
                              }).catch((e) => setError(String(e)));
                              setLaunchId(f.launchId);
                            }
                          }}
                        >
                          halt-height upgrade…
                        </button>
                        <button
                          className="btn"
                          title="Apply the domains from the spec editor to this fleet: one deployment-update signature, then repoint DNS"
                          onClick={async () => {
                            try {
                              // the spec editor is the source of truth: diff its
                              // domains against the fleet's stored spec and apply
                              const edited = yaml.load(specText) as any;
                              const ec = edited?.topology?.components ?? {};
                              const ep = edited?.topology?.publicEndpoints ?? {};
                              const cur = (await getLaunch(f.launchId)).spec as any;
                              const cc = cur?.topology?.components ?? {};
                              const cp = cur?.topology?.publicEndpoints ?? {};
                              const changes: Record<string, string> = {};
                              if (ec.explorer?.domain && ec.explorer.domain !== cc.explorer?.domain)
                                changes.explorer = ec.explorer.domain;
                              if (ec.explorer?.route && ec.explorer.route !== cc.explorer?.route)
                                changes.explorerRoute = ec.explorer.route;
                              if (ec.frontend?.domain && ec.frontend.domain !== cc.frontend?.domain)
                                changes.frontend = ec.frontend.domain;
                              if (ep?.api && ep.api !== cp?.api) changes.api = ep.api;
                              if (ep?.rpc && ep.rpc !== cp?.rpc) changes.rpc = ep.rpc;
                              if (Object.keys(changes).length === 0) {
                                setError(
                                  "no domain changes: the spec editor's domains match this fleet, edit the spec first",
                                );
                                return;
                              }
                              const { postDomainUpdate } = await import("../lib/api");
                              await postDomainUpdate(f.launchId, changes);
                              setLaunchId(f.launchId); // surfaces the signing banner
                            } catch (e) {
                              setError(String(e));
                            }
                          }}
                        >
                          update domains…
                        </button>
                      </>
                    )}
                    <button
                      className="btn"
                      onClick={async () => {
                        const { downloadFleetBundle } = await import("../lib/api");
                        await downloadFleetBundle(f.launchId).catch((e) => setError(String(e)));
                      }}
                    >
                      export fleet bundle
                    </button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const { downloadGenesis } = await import("../lib/api");
                        await downloadGenesis(f.launchId, f.chainId).catch((e) =>
                          setError(String(e)),
                        );
                      }}
                    >
                      download genesis
                    </button>
                    <button
                      className="btn"
                      title="Public join document for third-party operators (genesis sha256, sentry peer strings, state-sync RPCs); they paste it into their own launcher's spec join block"
                      onClick={async () => {
                        const { downloadJoinBundle } = await import("../lib/api");
                        await downloadJoinBundle(f.launchId, f.chainId).catch((e) =>
                          setError(String(e)),
                        );
                      }}
                    >
                      join bundle
                    </button>
                    {!shutDown && (
                      <>
                        <button
                          className="btn amber"
                          title="Wipe all chain state and restart from a genesis rebuilt from the spec editor: accounts and members are re-seeded (fresh mnemonics!), the chain-id suffix bumps, deployments stay"
                          onClick={async () => {
                            try {
                              const edited = yaml.load(specText) as any;
                              const ok = window.confirm(
                                `Reset the chain? ALL on-chain state is wiped and the fleet restarts from a new genesis built from the spec editor (chain-id moves past ${f.chainId}). ` +
                                  "The account keyring is rebuilt: generated accounts get FRESH mnemonics. Export the fleet bundle first if you need the old ones." +
                                  (edited?.images?.sparkdreamd
                                    ? ` Node image: ${edited.images.sparkdreamd}.`
                                    : ""),
                              );
                              if (!ok) return;
                              const { postChainReset } = await import("../lib/api");
                              await postChainReset(f.launchId, edited);
                              setLaunchId(f.launchId); // surfaces the signing banner
                            } catch (e) {
                              setError(String(e));
                            }
                          }}
                        >
                          reset chain…
                        </button>
                        <button
                          className="btn red"
                          onClick={async () => {
                            const activeKeys = active.map((c) => c.key);
                            const ok = window.confirm(
                              `Shut down the whole fleet? This closes ${activeKeys.length} deployment${activeKeys.length === 1 ? "" : "s"} (${activeKeys.join(", ")}). The chain STOPS and escrow is refunded. One signature.`,
                            );
                            if (!ok) return;
                            const { postFleetShutdown } = await import("../lib/api");
                            try {
                              await postFleetShutdown(f.launchId);
                              setLaunchId(f.launchId); // surfaces the signing banner
                            } catch (e) {
                              setError(String(e));
                            }
                          }}
                        >
                          shut down fleet…
                        </button>
                      </>
                    )}
                    {deletable && (
                      <button
                        className="btn red"
                        title="Permanently delete this launch's records and secrets (account mnemonics, validator keys) from the launcher"
                        onClick={() => deleteFleet()}
                      >
                        delete…
                      </button>
                    )}
                    {f.ops
                      .filter((o) => o.status === "active")
                      .map((o) => (
                        <span key={o.id} className="op-active">
                          {o.kind} in progress…
                          <button
                            className="btn"
                            title="Abandon this operation (e.g. if it's stuck on a broken provider). Closes its new deployment; the component can then be relaunched."
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Abandon the in-progress ${o.kind}? Its new deployment is closed (escrow refunded) and you can relaunch fresh.`,
                                )
                              )
                                return;
                              const { postAbortOp } = await import("../lib/api");
                              try {
                                const r = await postAbortOp(f.launchId, o.id);
                                if (r.warning) setError(`Abandoned, but: ${r.warning}`);
                                if (r.step) setLaunchId(f.launchId); // sign the close
                              } catch (e) {
                                setError(String(e));
                              }
                            }}
                          >
                            abort
                          </button>
                        </span>
                      ))}
                    {prefs && (prefs.avoid.length > 0 || prefs.prefer.length > 0) && (
                      <span
                        className="pref-summary"
                        title="These lists apply to every launch on this wallet"
                      >
                        relaunch policy:
                        {prefs.prefer.map((p) => (
                          <button
                            key={p}
                            className="pref-tag prefer"
                            title={`${p} (click to remove)`}
                            onClick={() => cycleProviderPref(f.launchId, p, "prefer")}
                          >
                            ⭐ {prefs.names[p] ?? `${p.slice(0, 14)}…`} ✕
                          </button>
                        ))}
                        {prefs.avoid.map((p) => (
                          <button
                            key={p}
                            className="pref-tag avoid"
                            title={`${p} (click to remove)`}
                            onClick={() =>
                              // avoid → prefer → none needs two clicks; jump straight to none
                              import("../lib/api").then(({ setProviderPref }) =>
                                setProviderPref(f.launchId, p, "none")
                                  .then((next) =>
                                    setProviderPrefs((m) => ({ ...m, [f.launchId]: next })),
                                  )
                                  .catch((e) => setError(String(e))),
                              )
                            }
                          >
                            ⛔ {prefs.names[p] ?? `${p.slice(0, 14)}…`} ✕
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                )}

                {!collapsed &&
                  bodyOpen &&
                  f.components.map((c) => {
                    const rowKey = `${f.launchId}:${c.dseq}`;
                    const open = openComponent === rowKey;
                    const kind = healthKind(c);
                    const days = runwayDays(c);
                    const version = c.image?.split(":").pop();
                    const pref = providerPrefOf(f.launchId, c.provider);
                    const height = liveHeights[c.dseq];
                    return (
                      <div key={rowKey} className="fleet-comp">
                        <div
                          className={`fleet-row${c.state === "closed" ? " closed" : ""}`}
                          onClick={() => setOpenComponent(open ? null : rowKey)}
                        >
                          <span className={`dot ${kind}`} />
                          <div>
                            <div className="name">{c.key}</div>
                            <div className="role">
                              {roleLabel(c.key)}
                              {version ? ` · ${version}` : ""}
                              {c.state !== "active" ? ` · ${c.state}` : ""}
                            </div>
                          </div>
                          <div className="provider" title={c.provider}>
                            {c.providerName || c.provider}
                          </div>
                          <div className="runway">
                            {days !== null && c.state === "active" ? (
                              <>
                                <div className="meter">
                                  <i
                                    className={runwayClass(days) === "err" ? "red" : runwayClass(days) === "warn" ? "warn" : "ok"}
                                    style={{
                                      width: `${Math.min(100, Math.round((days / 90) * 100))}%`,
                                    }}
                                  />
                                </div>
                                <span className={`runway-days ${runwayClass(days)}`}>
                                  {days.toFixed(1)}d
                                </span>
                              </>
                            ) : (
                              <span className="runway-days off">—</span>
                            )}
                          </div>
                          <div className="price" title={`${c.price} ${c.priceDenom}/block`}>
                            {c.state === "active" ? priceMonthly(c.price, c.priceDenom) : "—"}
                          </div>
                          <span className="chev">{open ? "▴" : "▾"}</span>
                        </div>
                        {open && (
                          <div className="fleet-detail">
                            <div className="facts">
                              {/* dseq first: it is what every provider/chain
                                  lookup keys on when something goes wrong */}
                              <span>
                                dseq{" "}
                                <span
                                  className="v"
                                  title="click to copy"
                                  style={{ cursor: "pointer" }}
                                  onClick={() => void navigator.clipboard.writeText(c.dseq)}
                                >
                                  {c.dseq}
                                </span>
                              </span>
                              {c.image && (
                                <span>
                                  image <span className="v">{c.image}</span>
                                </span>
                              )}
                              {c.escrow != null && (
                                <span>
                                  escrow left{" "}
                                  <span className="v">{balanceDisplay(c.escrow, c.priceDenom)}</span>
                                </span>
                              )}
                              {height && (
                                <span>
                                  block height{" "}
                                  <span className="v">
                                    {height.height.toLocaleString()}
                                    {height.catchingUp ? " (syncing)" : ""}
                                  </span>
                                </span>
                              )}
                              {c.health && (
                                <span>
                                  health{" "}
                                  <span className="v">
                                    {c.health.status}
                                    {c.health.detail ? ` (${c.health.detail})` : ""}
                                  </span>
                                </span>
                              )}
                              <span>
                                provider <span className="v">{c.provider}</span>{" "}
                                <button
                                  className={`pref-tag ${pref}`}
                                  title="Cycle this provider (wallet-wide): none → avoid → prefer. Relaunch avoids ⛔ and prefers ⭐ across all your launches."
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    cycleProviderPref(f.launchId, c.provider, pref, c.providerName);
                                  }}
                                >
                                  {pref === "avoid" ? "⛔ avoid" : pref === "prefer" ? "⭐ prefer" : "＋ list"}
                                </button>
                              </span>
                            </div>
                            <div className="acts">
                              {c.state === "active" && (
                                <>
                                  {c.key.startsWith("val-") && c.health?.status === "jailed" && (
                                    <button
                                      className="btn amber"
                                      title="Broadcast an unjail tx from the operator key. Waits until the node is back at the chain head first, so the validator doesn't get re-jailed."
                                      onClick={() => fleetAction(f.launchId, c.dseq, "unjail")}
                                    >
                                      unjail
                                    </button>
                                  )}
                                  {f.keyMode === "tmkms" && c.key.startsWith("val-") && (
                                    <button
                                      className="btn amber"
                                      title="Signer stalled the chain? Bring the tmkms signer up first, then run this: it waits for the signer session, restarts the validator process in place (no redeploy, no manifest change), and watches it sign blocks again."
                                      onClick={() => fleetAction(f.launchId, c.dseq, "resume-signing")}
                                    >
                                      resume signing
                                    </button>
                                  )}
                                  <button
                                    className="btn"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "restart")}
                                  >
                                    restart
                                  </button>
                                  <button
                                    className="btn"
                                    onClick={() => showLogs(f.launchId, c.dseq, c.key)}
                                  >
                                    logs
                                  </button>
                                  <button
                                    className="btn"
                                    title="Download the rendered SDL this component was deployed with"
                                    onClick={async () => {
                                      const { downloadComponentSdl } = await import("../lib/api");
                                      await downloadComponentSdl(f.launchId, c.dseq, c.key).catch(
                                        (e) => setError(String(e)),
                                      );
                                    }}
                                  >
                                    sdl
                                  </button>
                                  <button
                                    className="btn"
                                    onClick={() => {
                                      const feeNote =
                                        fee && fee.topupBps > 0
                                          ? ` A ${fee.topupBps / 100}% service fee is added (signed together).`
                                          : "";
                                      const amount = window.prompt(
                                        `Top-up amount (uact):${feeNote}`,
                                        "5000000",
                                      );
                                      if (amount)
                                        fleetAction(f.launchId, c.dseq, "topup", { amount });
                                    }}
                                  >
                                    top-up
                                  </button>
                                  {(c.key === "explorer" || c.key === "frontend") && (
                                    <button
                                      className="btn"
                                      title={`Swap just this component's image (current: ${c.image}). One deployment update; the service fee is added.`}
                                      onClick={() => {
                                        const feeNote =
                                          fee && fee.upgradeFlat > 0
                                            ? ` A ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added per upgrade (signed together).`
                                            : "";
                                        const image = window.prompt(
                                          `Upgrade ${c.key}:${feeNote}`,
                                          c.image ?? undefined,
                                        );
                                        if (image && image !== c.image)
                                          fleetAction(f.launchId, c.dseq, "upgrade", {
                                            image,
                                            components: [c.key],
                                          });
                                      }}
                                    >
                                      upgrade…
                                    </button>
                                  )}
                                  <button
                                    className="btn amber"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}
                                  >
                                    relaunch
                                  </button>
                                  <button
                                    className="btn red"
                                    onClick={() => fleetAction(f.launchId, c.dseq, "close")}
                                  >
                                    close…
                                  </button>
                                </>
                              )}
                              {/* a closed/relaunching node can still be relaunched
                                  (redeploy fresh) — the only action that applies */}
                              {c.state !== "active" && !shutDown && (
                                <button
                                  className="btn amber"
                                  onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}
                                >
                                  relaunch
                                </button>
                              )}
                            </div>
                            {logsView?.key === c.key && (
                              <>
                                <pre className="logs">{logsView.text}</pre>
                                <button
                                  className="btn"
                                  style={{ marginTop: 8 }}
                                  onClick={() => setLogsView(null)}
                                >
                                  close logs
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                {/* accounts live inside the fleet card as its last section */}
                {!collapsed && bodyOpen && (
                  <div className="fleet-comp">
                    <div
                      className="acct-head"
                      title="show / hide the accounts"
                      onClick={() =>
                        // the acctsOpen effect fetches the rows on first open
                        setAcctsOpen((m) => ({ ...m, [f.launchId]: !(m[f.launchId] ?? false) }))
                      }
                    >
                      <div className="acct-title">Accounts</div>
                      {fleetAccounts[f.launchId] && (
                        <span className="tag">{fleetAccounts[f.launchId]!.length}</span>
                      )}
                      <span className="dim-note" style={{ fontSize: 12 }}>
                        genesis &amp; operator keys, click an address to copy
                      </span>
                      <span style={{ marginLeft: "auto", color: "var(--dim2)", fontSize: 13 }}>
                        {acctsOpen[f.launchId] ? "▴" : "▾"}
                      </span>
                    </div>
                    {acctsOpen[f.launchId] &&
                    (fleetAccounts[f.launchId] ?? []).map((a) => {
                      const rkey = `${f.launchId}:${a.name}`;
                      const revealed = revealedMnemonics[rkey];
                      return (
                        <div key={a.name} className="acct-row">
                          <div className="name">{a.name}</div>
                          <button
                            className="addr"
                            title="copy address"
                            onClick={() => copyAddress(a.address, a.name)}
                          >
                            {a.address}
                          </button>
                          <div className="tail">
                            {!a.hasMnemonic ? (
                              <span className="dim-note">external key</span>
                            ) : revealed ? (
                              <button
                                className="btn"
                                onClick={() =>
                                  setRevealedMnemonics((m) => {
                                    const next = { ...m };
                                    delete next[rkey];
                                    return next;
                                  })
                                }
                              >
                                hide
                              </button>
                            ) : (
                              <button
                                className="btn"
                                title="Show this account's seed phrase (import into Keplr to act as it)"
                                onClick={async () => {
                                  try {
                                    const { getAccountMnemonic } = await import("../lib/api");
                                    const r = await getAccountMnemonic(f.launchId, a.name);
                                    setRevealedMnemonics((m) => ({ ...m, [rkey]: r.mnemonic }));
                                  } catch (err) {
                                    setError(String(err));
                                  }
                                }}
                              >
                                reveal mnemonic
                              </button>
                            )}
                          </div>
                          {revealed && <span className="mnemonic">{revealed}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </Fragment>
          );
        })}

        {fleet && fleet.unmanaged.length > 0 && (
          <div className="placeholder" style={{ textAlign: "left" }}>
            Unmanaged deployments on this wallet (on-chain, not created here):{" "}
            {fleet.unmanaged.map((d) => `dseq ${d.dseq} (${d.state})`).join(" · ")}
          </div>
        )}

        {/* ---------- tmkms signer setup ---------- */}
        {tmkms && (
          <section className="card">
            <div className="card-head row-gap">
              <div className="card-title">tmkms signer setup</div>
              <span className="tag">{tmkms.chainId}</span>
              <span className="dim-note" style={{ fontSize: 12 }}>
                run these on your signer machine, the launcher never touches it
              </span>
              <button className="btn" style={{ marginLeft: "auto" }} onClick={closeTmkms}>
                close
              </button>
            </div>
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div className="dim-note">
                Work the numbered steps on your signer machine, top to bottom. The status
                lines below update on their own; when every validator reports its signer
                connected, resume the launch.
              </div>
              {tmkmsStatus && (
                <div style={{ display: "grid", gap: 4, fontSize: 13, marginTop: 8 }}>
                  <div>
                    signer machine on the mesh:{" "}
                    {tmkmsStatus.externalNodes.length === 0 ? (
                      <span style={{ color: "var(--amber-text)" }}>none seen yet</span>
                    ) : (
                      tmkmsStatus.externalNodes.map((n, i) => (
                        <span key={n.name}>
                          {i > 0 && ", "}
                          <span style={{ color: n.online ? "var(--ok)" : "var(--dim)" }}>
                            {n.name}
                            {n.ip ? ` (${n.ip})` : ""}
                            {n.online ? "" : " (offline)"}
                          </span>
                        </span>
                      ))
                    )}
                  </div>
                  {tmkmsStatus.validators.map((v) => {
                    const delta = tmkmsSignDeltas[v.key];
                    const peer = v.signerPeers?.[0];
                    return (
                      <div key={v.key}>
                        {v.key}:{" "}
                        {v.signerConnected === null ? (
                          <span style={{ color: "var(--dim)" }}>probe unreachable</span>
                        ) : !v.signerConnected ? (
                          <span style={{ color: "var(--amber-text)" }}>waiting for signer</span>
                        ) : v.pubkeyMatches === false ? (
                          <span style={{ color: "var(--red-text)" }}>
                            connected, but the signer holds the wrong consensus key (expected{" "}
                            {v.expectedPubkey})
                          </span>
                        ) : v.pubkeyMatches === true ? (
                          <span style={{ color: "var(--ok)" }}>signer connected, key matches the spec</span>
                        ) : (
                          <span style={{ color: "var(--ok)" }}>signer connected</span>
                        )}
                        {peer && (
                          <span className="dim-note">
                            {" · "}
                            {peer.relay ? `path relayed via ${peer.relay}` : "path direct"}
                          </span>
                        )}
                        {v.signerRelayMs !== null && (
                          <span className="dim-note">
                            {" · "}
                            {Math.round(v.signerRelayMs)}ms to the relay
                          </span>
                        )}
                        {v.signerRelayMs !== null && v.signerRelayMs > 1000 && (
                          <span style={{ color: "var(--amber-text)" }}>
                            {" "}
                            (high: a stall over 5s interrupts signing)
                          </span>
                        )}
                        {delta && delta.seen > 0 && delta.missed === 0 && (
                          <span className="dim-note">
                            {" · "}signed the last {delta.seen} block{delta.seen === 1 ? "" : "s"}
                          </span>
                        )}
                        {delta && delta.seen > 0 && delta.missed > 0 && (
                          <span style={{ color: "var(--amber-text)" }}>
                            {" · "}missed {delta.missed} of the last {delta.seen} blocks
                          </span>
                        )}
                        {delta && delta.seen === 0 && v.signerConnected === true && (
                          <span style={{ color: "var(--amber-text)" }}>
                            {" · "}no new blocks since the last check: the signer path may be
                            stalling
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {tmkmsStatus.validators.length > 0 &&
                    tmkmsStatus.validators.every(
                      (v) => v.signerConnected === true && v.pubkeyMatches !== false,
                    ) && (
                      <div style={{ color: "var(--ok)", fontWeight: 600 }}>
                        all signers connected: resume the launch
                      </div>
                    )}
                </div>
              )}
            </div>
            {tmkms.validators.map((v) => (
              <div key={v.key} className="tmkms-val">
                <h3>
                  {v.key} · signer target <code>{v.tailnetIp}:26659</code>
                </h3>
                <details>
                  <summary>tmkms-{v.key}.toml</summary>
                  <pre>{v.tmkmsToml}</pre>
                </details>
                {v.expectedPubkey ? (
                  <details open>
                    <summary>consensus pubkey (must match the key in your hardware signer)</summary>
                    <pre>{v.expectedPubkey}</pre>
                  </details>
                ) : (
                  <details>
                    <summary>{v.key}-priv_validator_key.json (consensus key, handle offline)</summary>
                    <pre>{JSON.stringify(v.consensusKey, null, 2)}</pre>
                    <button
                      className="btn"
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(v.consensusKey, null, 2)], {
                          type: "application/json",
                        });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `${v.key}-priv_validator_key.json`;
                        a.click();
                      }}
                    >
                      download key
                    </button>
                  </details>
                )}
                <pre>{v.commands.join("\n")}</pre>
              </div>
            ))}
          </section>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {busy && <div className="busy">{busy}</div>}
      {error && (
        <div className="banner fail global-error">
          <pre>{error}</pre>
          <button className="btn" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
    </main>
  );
}
