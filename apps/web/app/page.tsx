"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, mintActMsg, toEncodeObject } from "@sparkdream/akash-tx";
import { withDefaults } from "@sparkdream/launch-spec";
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
  type AccountView,
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
    explorer: { enabled: false, domain: explorer.example.com }
    frontend: { enabled: false, domain: app.example.com }
    hub: { enabled: false }
  # required when frontend is enabled — sentry-0 serves these domains:
  # publicEndpoints:
  #   api: api.example.com
  #   rpc: rpc.example.com
  headscale:
    domain: headscale.example.com
`;

const LAST_LAUNCH_KEY = "launcher.lastLaunchId";
const SPEC_KEY = "launcher.specText";
/** Step rows shown while the list is collapsed (the tail holds the action). */
const COLLAPSED_STEPS = 3;

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

  // the Akash network parameters rarely change — they live folded behind a
  // summary line and only unfold on demand or when connecting fails
  const [networkOpen, setNetworkOpen] = useState(false);
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
      const comps = spec?.topology?.components ?? {};
      const componentCount = ["explorer", "frontend"].filter(
        (k) => comps[k]?.enabled,
      ).length;
      return (nodeCount + 1 + componentCount) * DEPOSIT_PER_DEPLOYMENT;
    } catch {
      return null; // spec doesn't parse — validation will complain elsewhere
    }
  }, [specText]);
  const depositShortfall =
    requiredDeposit !== null && balances !== null
      ? Math.max(0, requiredDeposit - Number(balanceOf(chain.denom) ?? "0"))
      : 0;

  // the deployment plan this spec resolves to (profile defaults applied) —
  // one row per role with count + image, joined with the cost estimate in
  // the render. When the spec fails the schema, carry the FIRST issue: a
  // silently missing preview gives no clue what to fix.
  const specPreview = useMemo((): {
    plan: Array<{ role: string; count: number; image: string }> | null;
    error: string | null;
  } => {
    try {
      const spec = withDefaults(yaml.load(specText));
      // role names match the estimator's perRole keys
      const rows: Array<{ role: string; count: number; image: string }> = [
        { role: "validators", count: spec.topology.validators.count, image: spec.images.sparkdreamd },
      ];
      if (spec.topology.sentries.count > 0) {
        rows.push({ role: "sentries", count: spec.topology.sentries.count, image: spec.images.sparkdreamd });
      }
      rows.push({ role: "headscale", count: 1, image: spec.images.headscale });
      if (spec.topology.components.explorer.enabled && spec.images.explorer) {
        rows.push({ role: "explorer", count: 1, image: spec.images.explorer });
      }
      if (spec.topology.components.frontend.enabled && spec.images.frontend) {
        rows.push({ role: "frontend", count: 1, image: spec.images.frontend });
      }
      return { plan: rows, error: null };
    } catch (e: any) {
      // zod puts issues in .issues; yaml throws a plain message
      const issue = Array.isArray(e?.issues) && e.issues[0]
        ? `${e.issues[0].path.join(".")}: ${e.issues[0].message}`
        : String(e?.message ?? e).split("\n")[0]!;
      return { plan: null, error: issue };
    }
  }, [specText]);
  const resolvedImages = specPreview.plan;

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

  // service fee schedule (day-2 dialogs show exact amounts; the fee is
  // always in the Keplr prompt regardless)
  const [fee, setFee] = useState<FeeInfo | null>(null);
  useEffect(() => {
    import("../lib/api").then(({ getFee }) => getFee().then(setFee).catch(() => {}));
  }, []);

  const [logsView, setLogsView] = useState<{ key: string; text: string } | null>(null);
  // shut-down fleets (every component closed) collapse to one line; the
  // record stays for bundle export / genesis download behind this toggle
  const [showClosedFleet, setShowClosedFleet] = useState<Record<string, boolean>>({});
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
      // signature-bearing actions flow through the launch's signing loop —
      // open that launch's panel so the prompt is visible (and survives reload)
      if (action !== "restart") {
        localStorage.setItem(LAST_LAUNCH_KEY, launchId);
        setLaunchId(launchId);
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
        <h2>Wallet</h2>
        <div className="row">
          <button onClick={() => connect()} className="primary">
            {wallet ? `Connected: ${wallet.name}` : "Connect Keplr"}
          </button>
          {wallet && <code>{wallet.address}</code>}
          {wallet && balances && (
            <span>
              Balances: <b>{microToDisplay(balanceOf("uakt"))} AKT</b> ·{" "}
              <b>{microToDisplay(balanceOf("uact"))} ACT</b>
            </span>
          )}
          {wallet && ledger && ledger.pending > 0 && (
            <span className="op-active">
              {ledger.pending} mint{ledger.pending > 1 ? "s" : ""} settling…
            </span>
          )}
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
                title="Minting burns AKT and settles asynchronously via the BME ledger — the ACT arrives after the next settlement epoch."
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
            <p className="dim-note">
              Deployments are paid in ACT; minted ACT arrives after the next settlement epoch,
              so mint before launching.
              {bme.min_mint_uact && ` Minimum mint: ${microToDisplay(bme.min_mint_uact)} ACT.`}
              {requiredDeposit !== null &&
                ` The current spec needs ~${microToDisplay(String(requiredDeposit))} ${denomLabel} in refundable deployment deposits.`}
              {aktPrice === null &&
                " (Price feed unreachable — no output estimate; below-minimum mints will be canceled by the chain.)"}
            </p>
          </>
        )}
        <details
          className="network-config"
          open={networkOpen}
          onToggle={(e) => setNetworkOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Akash network: <code>{chain.chainId}</code> · <code>{chain.denom}</code> ·{" "}
            <code>{rpcHost}</code>
            {chainIsCustom && (
              <b className="warnings" title="One or more values differ from the built-in Akash mainnet defaults">
                {" "}
                custom
              </b>
            )}
          </summary>
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
            <button
              title="Register this network in Keplr (one-time; akashnet-2 is already known to Keplr)"
              onClick={() => suggestChain(chain).catch((e) => setError(String(e)))}
            >
              Suggest chain to Keplr
            </button>
            {chainIsCustom && (
              <button onClick={() => updateChain(DEFAULT_CHAIN)}>Reset to Akash mainnet</button>
            )}
          </div>
        </details>
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
        </div>
        {specPreview.error && (
          <p className="dim-note">
            <span className="warnings">⚠ {specPreview.error}</span> — image and cost previews
            appear once the spec parses.
          </p>
        )}
        {resolvedImages && (
          <>
            <table className="deploy-plan">
              <thead>
                <tr>
                  <th>deployment</th>
                  <th>image</th>
                  <th>est. cost / month</th>
                </tr>
              </thead>
              <tbody>
                {resolvedImages.map((r) => {
                  const cost = costEstimate?.perRole.find((c) => c.role === r.role);
                  return (
                    <tr key={r.role}>
                      <td>
                        {r.role}
                        {r.count > 1 && ` ×${r.count}`}
                      </td>
                      <td>
                        <code>{r.image}</code>
                      </td>
                      <td>
                        {cost
                          ? `${cost.count > 1 ? `${cost.count} × ` : ""}$${cost.unitLowUsd.toFixed(2)}–${cost.unitHighUsd.toFixed(2)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {costEstimate && (
                <tfoot>
                  <tr className="total">
                    <td>{costEstimate.feeBps > 0 ? "deployments" : "total"}</td>
                    <td className="dim-note">
                      + ~{requiredDeposit !== null ? microToDisplay(String(requiredDeposit)) : "?"}{" "}
                      {denomLabel} in refundable deposits
                    </td>
                    <td>
                      {costEstimate.feeBps > 0 ? (
                        <>
                          ${costEstimate.totalLowUsd.toFixed(2)}–{costEstimate.totalHighUsd.toFixed(2)}
                        </>
                      ) : (
                        <b>
                          ${costEstimate.totalLowUsd.toFixed(2)}–{costEstimate.totalHighUsd.toFixed(2)}
                        </b>
                      )}
                    </td>
                  </tr>
                  {costEstimate.feeBps > 0 && (
                    <>
                      <tr>
                        <td>launch fee</td>
                        <td className="dim-note">
                          one-time, {costEstimate.feeBps / 100}% of actual leased monthly rate —
                          paid in AKT at the chain oracle price
                        </td>
                        <td>
                          ${costEstimate.feeLowUsd.toFixed(2)}–{costEstimate.feeHighUsd.toFixed(2)}
                        </td>
                      </tr>
                      <tr>
                        <td>total</td>
                        <td className="dim-note">
                          first month; later months pay only the deployments line
                        </td>
                        <td>
                          <b>
                            $
                            {(costEstimate.totalLowUsd + costEstimate.feeLowUsd).toFixed(2)}–
                            {(costEstimate.totalHighUsd + costEstimate.feeHighUsd).toFixed(2)}
                          </b>
                        </td>
                      </tr>
                    </>
                  )}
                </tfoot>
              )}
            </table>
            <p className="dim-note">
              Cost range: stock provider bid-script rates (high) down to the competitive bids
              the policy engine actually picks (low). Override images via <code>images:</code>{" "}
              in the spec.
            </p>
          </>
        )}
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
              <svg width="16" height="8" viewBox="0 0 32 16" aria-hidden="true">
                <path
                  d={stepsExpanded ? "M2 13 L16 5 L30 13" : "M2 3 L16 11 L30 3"}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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

          {launch.status === "aborted" && (
            <div className="dim-note">
              launch aborted — its deployments are closed (deposits refunded). Start a new
              launch from the spec above.
            </div>
          )}

          {!pending && !pendingGentx && waitingStep && launch.status !== "aborted" && (
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

          {failedStep && launch.status !== "aborted" && (
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
          {fleet.fleets.map((f) => {
            const shutDown =
              f.components.length > 0 && f.components.every((c) => c.state === "closed");
            const collapsed = shutDown && !showClosedFleet[f.launchId];
            return (
            <div key={f.launchId}>
              <h3>
                <code>{f.chainId}</code> — launch <code>{f.launchId.slice(0, 8)}</code> (
                {shutDown ? "shut down" : f.launchStatus})
                {shutDown && (
                  <button
                    title="A shut-down fleet is kept as a record — its bundle and genesis stay downloadable"
                    onClick={() =>
                      setShowClosedFleet((m) => ({ ...m, [f.launchId]: !m[f.launchId] }))
                    }
                  >
                    {collapsed ? "show" : "hide"}
                  </button>
                )}
                {shutDown && (
                  <button
                    title="Permanently delete this launch — all records AND secrets (mnemonics, keys) are erased from the launcher. Export the fleet bundle first if you want an archive."
                    onClick={async () => {
                      const ok = window.confirm(
                        `Delete launch ${f.launchId.slice(0, 8)} (${f.chainId}) permanently?\n\n` +
                          "This erases its records AND secrets (account mnemonics, validator keys) " +
                          "from the launcher. Export the fleet bundle first if you want an archive.",
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
                    }}
                  >
                    delete…
                  </button>
                )}
                {!collapsed &&
                  (f.launchId === launchId ? (
                    <span className="dim-note"> — in the launch panel above</span>
                  ) : (
                    <button
                      title="Open this launch's panel (steps, signature prompts, resume)"
                      onClick={() => {
                        localStorage.setItem(LAST_LAUNCH_KEY, f.launchId);
                        setLaunchId(f.launchId);
                      }}
                    >
                      view launch
                    </button>
                  ))}
              </h3>
              {!collapsed && (<>
              <table className="fleet">
                <thead>
                  <tr>
                    <th>component</th>
                    <th>image</th>
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
                      <td data-label="component">{c.key}</td>
                      <td data-label="image">
                        {c.image ? (
                          <code title={c.image}>{c.image.split(":").pop()}</code>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label="provider">
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
                      <td data-label="price" title={`${c.price} ${c.priceDenom}/block`}>
                        {priceMonthly(c.price, c.priceDenom)}
                        {c.escrow != null && (
                          <span className="escrow-bal" title="deployment escrow balance (funds remaining)">
                            {balanceDisplay(c.escrow, c.priceDenom)} left
                          </span>
                        )}
                      </td>
                      <td data-label="state">{c.state}</td>
                      <td data-label="health" className={`health ${c.health?.status ?? ""}`}>
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
                                const feeNote =
                                  fee && fee.topupBps > 0
                                    ? ` A ${fee.topupBps / 100}% service fee is added (signed together).`
                                    : "";
                                const amount = window.prompt(
                                  `Top-up amount (uact):${feeNote}`,
                                  "5000000",
                                );
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
                        {c.state !== "active" && c.key !== "headscale" && !shutDown && (
                          <button onClick={() => fleetAction(f.launchId, c.dseq, "relaunch")}>
                            relaunch
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <details
                className="accounts"
                onToggle={async (e) => {
                  if (!(e.target as HTMLDetailsElement).open || fleetAccounts[f.launchId]) return;
                  try {
                    const { getFleetAccounts } = await import("../lib/api");
                    const r = await getFleetAccounts(f.launchId);
                    setFleetAccounts((m) => ({ ...m, [f.launchId]: r.accounts }));
                  } catch (err) {
                    setError(String(err));
                  }
                }}
              >
                <summary title="Named accounts generated at launch — operator keys and spec accounts">
                  accounts
                </summary>
                <table className="fleet">
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>address</th>
                      <th>mnemonic</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(fleetAccounts[f.launchId] ?? []).map((a) => {
                      const rkey = `${f.launchId}:${a.name}`;
                      const revealed = revealedMnemonics[rkey];
                      return (
                        // the seed goes on its own full-width row so the
                        // columns never re-flow when it appears
                        <Fragment key={a.name}>
                          <tr>
                            <td data-label="name">{a.name}</td>
                            <td data-label="address">
                              <code>{a.address}</code>
                            </td>
                            <td data-label="mnemonic">
                              {!a.hasMnemonic ? (
                                <span className="dim-note">external key</span>
                              ) : revealed ? (
                                <button
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
                                  reveal
                                </button>
                              )}
                            </td>
                          </tr>
                          {revealed && (
                            <tr className="mnemonic-row">
                              <td colSpan={3}>
                                <code className="mnemonic">{revealed}</code>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </details>
              <div className="row">
                {!shutDown && (<>
                <button
                  onClick={() => {
                    const feeNote =
                      fee && fee.upgradeFlat > 0
                        ? ` A one-time ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added (signed together).`
                        : "";
                    const image = window.prompt(`Rolling upgrade — new sparkdreamd image:${feeNote}`);
                    const first = f.components.find((c) => c.state === "active" && c.key !== "headscale");
                    if (image && first) fleetAction(f.launchId, first.dseq, "upgrade", { image });
                  }}
                >
                  rolling upgrade…
                </button>
                <button
                  onClick={async () => {
                    const feeNote =
                      fee && fee.upgradeFlat > 0
                        ? ` A one-time ${microToDisplay(String(fee.upgradeFlat))} ${denomLabel} service fee is added (signed together).`
                        : "";
                    const image = window.prompt(
                      `Coordinated (consensus-breaking) upgrade — new image:${feeNote}`,
                    );
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
                </>)}
                {!shutDown && (
                  <button
                    title="Apply the domains from the launch-spec editor above to this fleet — one deployment-update signature, then repoint DNS"
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
                            "no domain changes: the spec editor's domains match this fleet — edit the spec above first",
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
                )}
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
                {!shutDown && (
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
                )}
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
              </>)}
            </div>
            );
          })}
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
        <div className="banner fail global-error">
          <pre>{error}</pre>
          <button onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
    </main>
  );
}
