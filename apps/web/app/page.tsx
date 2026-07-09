"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, mintActMsg, toEncodeObject } from "@sparkdream/akash-tx";
import yaml from "js-yaml";
import {
  createLaunch,
  getFleet,
  getLaunch,
  getPendingGentx,
  getPendingTx,
  postFleetAction,
  postGentxResult,
  postTxResult,
  resumeLaunch,
  startLaunch,
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
  name: sparkdream-dev-1
  type: devnet
  bech32Prefix: sprkdrm
token:
  baseDenom: uspark.sparkdreamdev
  displayDenom: SPARK
accounts:
  initial:
    - name: treasury
      generate: true
      amount: "500000000000000"
    - name: alice
      generate: true
      amount: "1000000000000"
    - name: bob
      generate: true
      amount: "1000000000000"
    - name: carol
      generate: true
      amount: "1000000000000"
    - name: dave
      generate: true
      amount: "1000000000000"
  validatorSelfDelegation: "1000000000000"
topology:
  validators: { count: 1 }
  sentries: { count: 1 }
  components:
    explorer: { enabled: false }
    frontend: { enabled: false }
    hub: { enabled: false }
  headscale:
    domain: headscale.example.com
`;

const LAST_LAUNCH_KEY = "launcher.lastLaunchId";
const SPEC_KEY = "launcher.specText";
/** Step rows shown while the list is collapsed (the tail holds the action). */
const COLLAPSED_STEPS = 6;

export default function Page() {
  const [chain, setChain] = useState<ChainConfig>(DEFAULT_CHAIN);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [specText, setSpecText] = useState(EXAMPLE_SPEC);
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [pendingGentx, setPendingGentx] = useState<PendingGentx | null>(null);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [balances, setBalances] = useState<Coin[] | null>(null);
  const [bme, setBme] = useState<BmeInfo | null>(null);
  const [ledger, setLedger] = useState<BmeLedgerSummary | null>(null);
  const [aktPrice, setAktPrice] = useState<number | null>(null);
  const [mintAmount, setMintAmount] = useState("");
  const [warnings, setWarnings] = useState<{ path: string; message: string }[]>([]);

  // localStorage only after mount — the page is statically prerendered
  useEffect(() => {
    setChain(loadChainConfig());
    setLaunchId(localStorage.getItem(LAST_LAUNCH_KEY));
    const savedSpec = localStorage.getItem(SPEC_KEY);
    if (savedSpec) setSpecText(savedSpec);
  }, []);

  const updateSpec = (text: string) => {
    setSpecText(text);
    localStorage.setItem(SPEC_KEY, text);
  };

  const updateChain = (patch: Partial<ChainConfig>) => {
    const next = { ...chain, ...patch };
    setChain(next);
    saveChainConfig(next);
  };

  const WALLET_CONNECTED_KEY = "launcher.walletConnected";

  const connect = useCallback(
    async (config?: ChainConfig, silent = false) => {
      const cfg = config ?? chain;
      try {
        if (!silent) setError(null);
        const w = await connectKeplr(cfg);
        // wallet-session auth when the conductor requires it (Akash mode, M6 §2)
        const { getAuthMode, authNonce, authVerify, setAuthToken, loadAuthToken } =
          await import("../lib/api");
        const mode = await getAuthMode();
        // a persisted session token (12h server TTL) skips the re-sign
        if (mode.required && !loadAuthToken()) {
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
        else setError(String(e));
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

  const [tmkms, setTmkms] = useState<import("../lib/api").TmkmsSetup | null>(null);
  const showTmkms = async (id: string) => {
    setError(null);
    try {
      const { getTmkmsSetup } = await import("../lib/api");
      setTmkms(await getTmkmsSetup(id));
    } catch (e) {
      setError(String(e));
    }
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

  // real-time block height for active nodes (validators + sentries; not
  // headscale). Lighter + faster than the 45s health sweep; re-derives its
  // target list from the current fleet.
  const heightTargets = useMemo(
    () =>
      (fleet?.fleets ?? []).flatMap((f) =>
        f.components
          .filter((c) => c.key !== "headscale" && c.state === "active")
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
        `estimated output is below the network minimum of ${Number(bme.min_mint_uact) / 1e6} ACT — the chain would cancel this mint at settlement`,
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
  // whole-denom PER MONTH the way console-air does: ~6.098s blocks,
  // 30.437 days/month.
  const priceMonthly = (microPerBlock: string, microDenom: string) => {
    const perBlock = Number(microPerBlock);
    if (!Number.isFinite(perBlock)) return "—";
    const denom = microDenom.replace(/^u/, "").toUpperCase(); // uact → ACT
    const monthly = (perBlock / 1e6) * ((30.437 * 24 * 60 * 60) / 6.098);
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
  // conductor's DEFAULT_DEPOSIT; M2 estimate-costs will refine). Gas fees
  // come on top but are small next to the deposits.
  const DEPOSIT_PER_DEPLOYMENT = 5_000_000;
  const requiredDeposit = useMemo(() => {
    try {
      const spec = yaml.load(specText) as any;
      const nodeCount =
        (spec?.topology?.validators?.count ?? 0) + (spec?.topology?.sentries?.count ?? 0);
      if (nodeCount <= 0) return null;
      return (nodeCount + 1) * DEPOSIT_PER_DEPLOYMENT;
    } catch {
      return null; // spec doesn't parse — validation will complain elsewhere
    }
  }, [specText]);
  const depositShortfall =
    requiredDeposit !== null && balances !== null
      ? Math.max(0, requiredDeposit - Number(balanceOf(chain.denom) ?? "0"))
      : 0;

  const [logsView, setLogsView] = useState<{ key: string; text: string } | null>(null);
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
    action: "close" | "restart" | "relaunch" | "upgrade" | "topup",
    extra: { image?: string; amount?: string; haltHeight?: number } = {},
  ) => {
    setError(null);
    try {
      const first = await postFleetAction(launchId, dseq, action, extra);
      if (first.warnings?.length) {
        const ok = window.confirm(`${first.warnings.join("\n")}\n\nProceed?`);
        if (!ok) return;
        await postFleetAction(launchId, dseq, action, { ...extra, confirm: true });
      }
      // signature-bearing actions flow through the launch's signing loop
      if (action !== "restart") setLaunchId(launchId);
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

  return (
    <main>
      <h1>SPARK·DREAM chain launcher</h1>

      <section className="panel">
        <h2>Compute network</h2>
        <div className="grid">
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
            <label key={key}>
              {label}
              <input value={chain[key]} onChange={(e) => updateChain({ [key]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="row">
          <button onClick={() => suggestChain(chain).catch((e) => setError(String(e)))}>
            Suggest chain to Keplr
          </button>
          <button onClick={() => connect()} className="primary">
            {wallet ? `Connected: ${wallet.name}` : "Connect Keplr"}
          </button>
          {wallet && <code>{wallet.address}</code>}
        </div>
        {wallet && ledger?.last_status === "canceled" && (
          <div className="banner fail">
            Your last mint was canceled at settlement
            {ledger.last_cancel_reason
              ? `: ${BME_CANCEL_REASONS[ledger.last_cancel_reason] ?? ledger.last_cancel_reason}`
              : ""}
            . The burned AKT is refunded to your wallet.
          </div>
        )}
        {wallet && bme && (
          <>
            <div className="row">
              <label>
                AKT to convert
                <input
                  value={mintAmount}
                  onChange={(e) => setMintAmount(e.target.value)}
                  placeholder="10"
                  inputMode="decimal"
                />
              </label>
              <button
                onClick={mint}
                disabled={busy !== null || !mintAmount || belowMinMint || !bme.mints_allowed}
              >
                Mint ACT from AKT
              </button>
              {estimatedMintUact !== null && (
                <span className={belowMinMint ? "warnings" : "dim-note"}>
                  ≈ {microToDisplay(String(estimatedMintUact))} ACT
                  {belowMinMint && ` — below the ${microToDisplay(bme.min_mint_uact)} ACT minimum`}
                </span>
              )}
            </div>
            {!bme.mints_allowed && (
              <div className="banner fail">
                The BME circuit breaker has halted ACT mints on this network — try again later.
              </div>
            )}
          </>
        )}
        {wallet && balances && (
          <div className="row">
            <span>
              Balances: <b>{microToDisplay(balanceOf("uakt"))} AKT</b> ·{" "}
              <b>{microToDisplay(balanceOf("uact"))} ACT</b>
            </span>
            {ledger && ledger.pending > 0 && (
              <span className="op-active">
                {ledger.pending} mint{ledger.pending > 1 ? "s" : ""} settling…
              </span>
            )}
          </div>
        )}
        {wallet && bme && (
          <p className="dim-note">
            Deployments are paid in ACT. Minting burns AKT and settles asynchronously via the
            BME ledger — the ACT arrives after the next settlement epoch, so mint before
            launching.
            {bme.min_mint_uact && ` Minimum mint: ${microToDisplay(bme.min_mint_uact)} ACT.`}
            {requiredDeposit !== null &&
              ` The current spec needs ~${microToDisplay(String(requiredDeposit))} ${denomLabel} in deployment deposits that are refundable minus usage when the deployments are closed.`}
            {aktPrice === null &&
              " (Price feed unreachable — no output estimate; below-minimum mints will be canceled by the chain.)"}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Launch spec</h2>
        <textarea
          value={specText}
          onChange={(e) => updateSpec(e.target.value)}
          rows={18}
          spellCheck={false}
        />
        <div className="row">
          <button onClick={create} className="primary" disabled={!wallet || busy !== null}>
            Create &amp; start launch
          </button>
          <button onClick={exportSpec}>Export spec</button>
          <button
            onClick={() => {
              if (window.confirm("Replace the spec with the built-in example? Your edits will be lost.")) {
                updateSpec(EXAMPLE_SPEC);
              }
            }}
          >
            Reset to example
          </button>
          <label className="import-btn">
            Import spec
            <input
              type="file"
              accept=".yaml,.yml"
              onChange={(e) => e.target.files?.[0] && importSpec(e.target.files[0])}
              hidden
            />
          </label>
          {launchId && (
            <button
              onClick={() => {
                localStorage.removeItem(LAST_LAUNCH_KEY);
                setLaunchId(null);
                setLaunch(null);
                setPending(null);
              }}
            >
              New launch
            </button>
          )}
        </div>
        {wallet && depositShortfall > 0 && (
          <div className="banner wait">
            This launch needs ~{microToDisplay(String(requiredDeposit))} {denomLabel} in
            deployment deposits, but the wallet holds{" "}
            {microToDisplay(balanceOf(chain.denom) ?? "0")} {denomLabel} — short{" "}
            {microToDisplay(String(depositShortfall))} {denomLabel}
            {bme
              ? `. Mint ACT above first (settlement takes an epoch${
                  ledger && ledger.pending > 0
                    ? `; ${ledger.pending} mint${ledger.pending > 1 ? "s" : ""} settling now`
                    : ""
                }).`
              : "."}
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="warnings">
            {warnings.map((w) => (
              <li key={w.path}>
                ⚠ {w.path}: {w.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {launch && (
        <section className="panel">
          <h2>
            Launch <code>{launch.id.slice(0, 8)}</code> — {launch.status}
          </h2>

          <ol className="steps">
            {(stepsExpanded ? launch.steps : launch.steps.slice(-COLLAPSED_STEPS)).map((s) => (
              <li key={s.name} className={s.status}>
                <span className="dot" />
                {s.name}
                <span className="status">{s.status}</span>
              </li>
            ))}
          </ol>
          {launch.steps.length > COLLAPSED_STEPS && (
            <button
              className="steps-toggle"
              title={
                stepsExpanded
                  ? "collapse to the latest steps"
                  : `show all ${launch.steps.length} steps (${launch.steps.length - COLLAPSED_STEPS} hidden)`
              }
              onClick={() => setStepsExpanded((v) => !v)}
            >
              {stepsExpanded ? "⌃" : "⌄"}
            </button>
          )}

          {/* action banners live BELOW the steps — that's where the eye is
              while following progress, no scrolling up to find the button */}
          {pending && (
            <div className="banner sign">
              Signature needed for <b>{pending.step}</b> ({pending.msgs.length} msg
              {pending.msgs.length > 1 ? "s" : ""})
              <button onClick={sign} className="primary" disabled={busy !== null}>
                Sign with Keplr
              </button>
              {signFailedStep === pending.step && (
                <button
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

          {pendingGentx && (
            <div className="banner sign">
              Gentx signature needed for <b>validator {pendingGentx.valIndex}</b> — operator{" "}
              <code>{pendingGentx.address}</code> (offline, on the new chain; select the
              matching account in Keplr)
              <button onClick={signGentxNow} className="primary" disabled={busy !== null}>
                Sign gentx with Keplr
              </button>
            </div>
          )}

          {!pending && !pendingGentx && waitingStep && (
            <div className="banner wait">
              <b>{waitingStep.name}</b> is waiting on you
              {reportedAgo(waitingStep) && (
                <span className="dim-note"> (reported {reportedAgo(waitingStep)})</span>
              )}
              :
              <pre>{waitingStep.error}</pre>
              {waitingStep.name === "await-signer" && (
                <button onClick={() => launchId && showTmkms(launchId)}>
                  Show tmkms signer setup
                </button>
              )}
              <button
                onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
              >
                I did it — resume
              </button>
            </div>
          )}

          {failedStep && (
            <div className="banner fail">
              <b>{failedStep.name}</b> failed
              {reportedAgo(failedStep) && (
                <span className="dim-note"> ({reportedAgo(failedStep)})</span>
              )}
              :
              <pre>{failedStep.error}</pre>
              <button
                onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
              >
                Retry
              </button>
            </div>
          )}
        </section>
      )}

      {fleet && fleet.fleets.length > 0 && (
        <section className="panel">
          <h2>Fleet</h2>
          {fleet.fleets.map((f) => (
            <div key={f.launchId}>
              <h3>
                <code>{f.chainId}</code> — launch <code>{f.launchId.slice(0, 8)}</code> (
                {f.launchStatus})
              </h3>
              <table className="fleet">
                <thead>
                  <tr>
                    <th>component</th>
                    <th>provider</th>
                    <th>price</th>
                    <th>state</th>
                    <th>health</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {f.components.map((c) => (
                    <tr key={c.key} className={c.state}>
                      <td>{c.key}</td>
                      <td>
                        <code title={c.provider}>{c.providerName || `${c.provider.slice(0, 16)}…`}</code>
                        {(() => {
                          const pref = providerPrefOf(f.launchId, c.provider);
                          const label = pref === "avoid" ? "⛔ avoid" : pref === "prefer" ? "⭐ prefer" : "＋ list";
                          return (
                            <button
                              className={`pref-tag ${pref}`}
                              title="Cycle this provider (wallet-wide): none → avoid → prefer. Relaunch avoids ⛔ and prefers ⭐ across all your launches."
                              onClick={() => cycleProviderPref(f.launchId, c.provider, pref, c.providerName)}
                            >
                              {label}
                            </button>
                          );
                        })()}
                      </td>
                      <td title={`${c.price} ${c.priceDenom}/block`}>
                        {priceMonthly(c.price, c.priceDenom)}
                        {c.escrow != null && (
                          <span className="escrow-bal" title="deployment escrow balance (funds remaining)">
                            {balanceDisplay(c.escrow, c.priceDenom)} left
                          </span>
                        )}
                      </td>
                      <td>{c.state}</td>
                      <td className={`health ${c.health?.status ?? ""}`}>
                        {c.health ? `${c.health.status}${c.health.detail ? ` (${c.health.detail})` : ""}` : "—"}
                        {liveHeights[c.dseq] && (
                          <span className="live-height" title="live block height (updates every 3s)">
                            ▲ {liveHeights[c.dseq]!.height.toLocaleString()}
                            {liveHeights[c.dseq]!.catchingUp ? " (syncing)" : ""}
                          </span>
                        )}
                      </td>
                      <td className="actions">
                        {c.state === "active" && (
                          <>
                            <button onClick={() => fleetAction(f.launchId, c.dseq, "restart")}>
                              restart
                            </button>
                            <button onClick={() => showLogs(f.launchId, c.dseq, c.key)}>
                              logs
                            </button>
                            <button
                              title="Download the rendered SDL this component was deployed with"
                              onClick={async () => {
                                const { downloadComponentSdl } = await import("../lib/api");
                                await downloadComponentSdl(f.launchId, c.dseq, c.key).catch((e) =>
                                  setError(String(e)),
                                );
                              }}
                            >
                              sdl
                            </button>
                            <button
                              onClick={() => {
                                const amount = window.prompt("Top-up amount (uact):", "5000000");
                                if (amount) fleetAction(f.launchId, c.dseq, "topup", { amount });
                              }}
                            >
                              top-up
                            </button>
                            {c.key !== "headscale" && (
                              <button onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}>
                                relaunch
                              </button>
                            )}
                            <button onClick={() => fleetAction(f.launchId, c.dseq, "close")}>
                              close
                            </button>
                          </>
                        )}
                        {/* a closed/relaunching node can still be relaunched
                            (redeploy fresh) — the only action that applies */}
                        {c.state !== "active" && c.key !== "headscale" && (
                          <button onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}>
                            relaunch
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <button
                  onClick={() => {
                    const image = window.prompt("Rolling upgrade — new sparkdreamd image:");
                    const first = f.components.find((c) => c.state === "active" && c.key !== "headscale");
                    if (image && first) fleetAction(f.launchId, first.dseq, "upgrade", { image });
                  }}
                >
                  rolling upgrade…
                </button>
                <button
                  onClick={async () => {
                    const image = window.prompt("Coordinated (consensus-breaking) upgrade — new image:");
                    if (!image) return;
                    const h = window.prompt("Halt height:");
                    const first = f.components.find((c) => c.state === "active" && c.key !== "headscale");
                    if (h && first) {
                      const { postFleetAction } = await import("../lib/api");
                      await postFleetAction(f.launchId, first.dseq, "halt-upgrade", {
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
                  onClick={async () => {
                    const { downloadFleetBundle } = await import("../lib/api");
                    await downloadFleetBundle(f.launchId).catch((e) => setError(String(e)));
                  }}
                >
                  export fleet bundle
                </button>
                <button
                  onClick={async () => {
                    const { downloadGenesis } = await import("../lib/api");
                    await downloadGenesis(f.launchId, f.chainId).catch((e) => setError(String(e)));
                  }}
                >
                  download genesis
                </button>
                <button
                  onClick={async () => {
                    const active = f.components.filter((c) => c.state === "active").map((c) => c.key);
                    const ok = window.confirm(
                      `Shut down the whole fleet? This closes ${active.length} deployment${active.length === 1 ? "" : "s"} (${active.join(", ")}) — the chain STOPS and escrow is refunded. One signature.`,
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
                {f.ops
                  .filter((o) => o.status === "active")
                  .map((o) => (
                    <span key={o.id} className="op-active">
                      {o.kind} in progress…
                      <button
                        title="Abandon this operation (e.g. if it's stuck on a broken provider). Closes its new deployment; the component can then be relaunched."
                        onClick={async () => {
                          if (!window.confirm(`Abandon the in-progress ${o.kind}? Its new deployment is closed (escrow refunded) and you can relaunch fresh.`)) return;
                          const { postAbortOp } = await import("../lib/api");
                          try {
                            const r = await postAbortOp(f.launchId, o.id);
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
              </div>
              {(() => {
                const prefs = providerPrefs[f.launchId];
                if (!prefs || (!prefs.avoid.length && !prefs.prefer.length)) return null;
                const removePref = async (provider: string) => {
                  const { setProviderPref } = await import("../lib/api");
                  const next = await setProviderPref(f.launchId, provider, "none").catch((e) => {
                    setError(String(e));
                    return null;
                  });
                  if (next) setProviderPrefs((m) => ({ ...m, [f.launchId]: next }));
                };
                const chip = (provider: string, kind: "avoid" | "prefer") => {
                  const display = prefs.names[provider] ?? `${provider.slice(0, 14)}…`;
                  return (
                    <button
                      key={provider}
                      className={`pref-tag ${kind}`}
                      title={`${provider} — click to remove`}
                      onClick={() => removePref(provider)}
                    >
                      {kind === "avoid" ? "⛔" : "⭐"} {display} ✕
                    </button>
                  );
                };
                return (
                  <p className="dim-note pref-summary" title="These lists apply to every launch on this wallet">
                    Relaunch policy (wallet-wide) —{" "}
                    {prefs.prefer.length > 0 && <>prefer: {prefs.prefer.map((p) => chip(p, "prefer"))} </>}
                    {prefs.avoid.length > 0 && <>avoid: {prefs.avoid.map((p) => chip(p, "avoid"))}</>}
                  </p>
                );
              })()}
            </div>
          ))}
          {logsView && (
            <div className="banner wait">
              <b>{logsView.key} logs</b>
              <button onClick={() => setLogsView(null)}>close</button>
              <pre>{logsView.text}</pre>
            </div>
          )}
          {fleet.unmanaged.length > 0 && (
            <>
              <h3>Unmanaged deployments (on-chain, not created here)</h3>
              <ul>
                {fleet.unmanaged.map((d) => (
                  <li key={d.dseq}>
                    <code>dseq {d.dseq}</code> — {d.state}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {tmkms && (
        <section className="panel">
          <h2>
            tmkms signer setup — <code>{tmkms.chainId}</code>
            <button onClick={() => setTmkms(null)} style={{ float: "right" }}>
              close
            </button>
          </h2>
          <p className="dim-note">
            Run these on your signer machine — the launcher never touches it (§3). Save each
            consensus key, join the mesh, import, start; then resume the launch.
          </p>
          {tmkms.validators.map((v) => (
            <div key={v.key} className="tmkms-val">
              <h3>
                {v.key} — signer target <code>{v.tailnetIp}:26659</code>
              </h3>
              <details>
                <summary>tmkms-{v.key}.toml</summary>
                <pre>{v.tmkmsToml}</pre>
              </details>
              <details>
                <summary>{v.key}-priv_validator_key.json (consensus key — handle offline)</summary>
                <pre>{JSON.stringify(v.consensusKey, null, 2)}</pre>
                <button
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
              <pre className="commands">{v.commands.join("\n")}</pre>
            </div>
          ))}
        </section>
      )}

      {busy && <div className="busy">{busy}</div>}
      {error && (
        <div className="banner fail">
          <pre>{error}</pre>
          <button onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
    </main>
  );
}
