"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { launcherRegistry, toEncodeObject } from "@sparkdream/akash-tx";
import yaml from "js-yaml";
import {
  createLaunch,
  getLaunch,
  getPendingTx,
  postTxResult,
  resumeLaunch,
  startLaunch,
  type LaunchView,
  type PendingTx,
} from "../lib/api";
import {
  connectKeplr,
  DEFAULT_CHAIN,
  loadChainConfig,
  saveChainConfig,
  suggestChain,
  type ChainConfig,
  type ConnectedWallet,
} from "../lib/keplr";

const EXAMPLE_SPEC = `version: 1
network:
  name: sparkdream
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

export default function Page() {
  const [chain, setChain] = useState<ChainConfig>(DEFAULT_CHAIN);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [specText, setSpecText] = useState(EXAMPLE_SPEC);
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchView | null>(null);
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ path: string; message: string }[]>([]);

  // localStorage only after mount — the page is statically prerendered
  useEffect(() => {
    setChain(loadChainConfig());
    setLaunchId(localStorage.getItem(LAST_LAUNCH_KEY));
  }, []);

  const updateChain = (patch: Partial<ChainConfig>) => {
    const next = { ...chain, ...patch };
    setChain(next);
    saveChainConfig(next);
  };

  const connect = async () => {
    try {
      setError(null);
      setWallet(await connectKeplr(chain));
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
        setPending(view.status === "completed" ? null : await getPendingTx(launchId));
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
    } catch (e) {
      setError(String(e));
    } finally {
      signingRef.current = false;
      setBusy(null);
    }
  }, [wallet, launchId, pending, chain]);

  const waitingStep = useMemo(
    () => launch?.steps.find((s) => s.status === "waiting" && s.error !== "awaiting signature"),
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
          <button onClick={connect} className="primary">
            {wallet ? `Connected: ${wallet.name}` : "Connect Keplr"}
          </button>
          {wallet && <code>{wallet.address}</code>}
        </div>
      </section>

      <section className="panel">
        <h2>Launch spec</h2>
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          rows={18}
          spellCheck={false}
        />
        <div className="row">
          <button onClick={create} className="primary" disabled={!wallet || busy !== null}>
            Create &amp; start launch
          </button>
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

          {pending && (
            <div className="banner sign">
              Signature needed for <b>{pending.step}</b> ({pending.msgs.length} msg
              {pending.msgs.length > 1 ? "s" : ""})
              <button onClick={sign} className="primary" disabled={busy !== null}>
                Sign with Keplr
              </button>
            </div>
          )}

          {!pending && waitingStep && (
            <div className="banner wait">
              <b>{waitingStep.name}</b> is waiting on you:
              <pre>{waitingStep.error}</pre>
              <button
                onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
              >
                I did it — resume
              </button>
            </div>
          )}

          {failedStep && (
            <div className="banner fail">
              <b>{failedStep.name}</b> failed:
              <pre>{failedStep.error}</pre>
              <button
                onClick={() => launchId && resumeLaunch(launchId).catch((e) => setError(String(e)))}
              >
                Retry
              </button>
            </div>
          )}

          <ol className="steps">
            {launch.steps.map((s) => (
              <li key={s.name} className={s.status}>
                <span className="dot" />
                {s.name}
                <span className="status">{s.status}</span>
              </li>
            ))}
          </ol>
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
