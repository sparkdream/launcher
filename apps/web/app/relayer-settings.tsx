"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import yaml from "js-yaml";
import type {
  ChainPreset,
  DetectedChain,
  EndpointCounterparty,
  RelayerPathSpec,
  RelayerSettings,
  SisterFleet,
} from "../lib/api";
import { toBase, toDisplay } from "../lib/relayer-funds";
import {
  cleanEndpoint,
  describeChanges,
  endpointProblems,
  isFleetPath,
  pathStatus,
  pathTarget,
  sisterPaths,
  suggestPathId,
  validPathId,
} from "../lib/relayer-settings";

/**
 * The relayer card's "settings…": the chains the relayer connects this fleet
 * to, edited as a list instead of spec YAML. Adding a connection walks through
 * what to relay (content federation with a Spark Dream sister chain, or token
 * transfers), which chain (a sister fleet on this launcher, a well-known
 * chain, any chain by its endpoints), and its details; Review says in plain
 * words what applying will do before anything is sent.
 */
export function RelayerSettingsModal({
  launchId,
  onClose,
  onApplied,
  onError,
}: {
  launchId: string;
  onClose: () => void;
  /** After the server took the change: an op to watch, or a save without one. */
  onApplied: (result: { status: string; opId?: number }) => void;
  onError: (msg: string) => void;
}) {
  const [data, setData] = useState<RelayerSettings | null>(null);
  const [draft, setDraft] = useState<RelayerPathSpec[]>([]);
  const [cap, setCap] = useState("");
  const [view, setView] = useState<"list" | "add" | "review">("list");
  const [yamlText, setYamlText] = useState<string | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // the parent passes fresh callbacks on every render: read them through a
  // ref, so the draft is loaded once per fleet and never reset under the user
  const callbacks = useRef({ onClose, onError });
  callbacks.current = { onClose, onError };
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { getRelayerSettings } = await import("../lib/api");
        const s = await getRelayerSettings(launchId);
        if (!live) return;
        setData(s);
        setDraft(s.paths);
        setCap(s.maxBalance ? toDisplay(s.maxBalance, s.decimals) : "");
      } catch (e) {
        if (!live) return;
        callbacks.current.onError(String(e));
        callbacks.current.onClose();
      }
    })();
    return () => {
      live = false;
    };
  }, [launchId]);

  const capBase = data && cap.trim() ? toBase(cap.trim(), data.decimals) : null;
  const capChanged = Boolean(data && capBase && capBase !== data.maxBalance);
  const changes = useMemo(
    () =>
      data
        ? describeChanges(data.paths, draft, {
            chainId: data.chainId,
            founderHeld: data.founderHeld,
            sisters: data.sisters,
            presets: data.presets,
            cap: { before: data.maxBalance, after: capBase, symbol: data.symbol, decimals: data.decimals },
          })
        : [],
    [data, draft, capBase],
  );

  if (!data) {
    return (
      <Shell onClose={onClose}>
        <p className="note">Reading the relayer&apos;s settings…</p>
      </Shell>
    );
  }

  const removed = data.paths.filter((p) => !draft.some((d) => d.id === p.id));
  const capInvalid = cap.trim() !== "" && (!capBase || capBase === "0");

  const apply = async () => {
    setApplying(true);
    try {
      const { postRelayerPaths } = await import("../lib/api");
      const result = await postRelayerPaths(launchId, draft, capChanged ? capBase! : undefined);
      onApplied(result);
    } catch (e) {
      onError(String(e));
    } finally {
      setApplying(false);
    }
  };

  if (view === "add") {
    return (
      <Shell onClose={onClose} wide>
        <AddConnection
          data={data}
          taken={draft.map((p) => p.id)}
          onCancel={() => setView("list")}
          onAdd={(paths) => {
            setDraft((d) => [...d, ...paths]);
            setView("list");
          }}
        />
      </Shell>
    );
  }

  if (view === "review") {
    return (
      <Shell onClose={onClose} wide>
        <div className="k">Review relayer changes</div>
        {changes.length === 0 ? (
          <p className="note">Nothing changes.</p>
        ) : (
          <ul className="rs-changes">
            {changes.map((l, i) => (
              <li key={i} className={`rs-${l.tone}`}>
                {l.text}
              </li>
            ))}
          </ul>
        )}
        <p className="note">
          New or dropped paths run as one relayer operation in the Launch panel; anything that needs a
          signature or funding pauses there and says so.
        </p>
        <div className="actions">
          <button className="btn primary small" disabled={applying || changes.length === 0} onClick={apply}>
            {applying ? "Applying…" : "Apply"}
          </button>
          <button className="btn" disabled={applying} onClick={() => setView("list")}>
            Back
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose} wide>
      <div className="k">Relayer settings</div>
      <p className="note">
        The chains this fleet&apos;s relayer connects {data.chainId} to. Content federation links Spark Dream
        sister chains; token transfers work with any IBC chain.
      </p>

      <div className="f-label">Connections</div>
      {draft.length === 0 && <p className="dim-note">No connections yet.</p>}
      <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
        {draft.map((p) => {
          const t = pathTarget(p, data.sisters);
          const isNew = !data.paths.some((x) => x.id === p.id);
          return (
            <div key={p.id} className="rs-row">
              <div style={{ minWidth: 0 }}>
                <div>
                  <b>{p.id}</b> <span className={`rs-chip ${p.kind}`}>{p.kind}</span>
                  {t.route && <span className="rs-chip">{t.route === "public" ? "public route" : "mesh"}</span>}
                  {isNew && <span className="rs-chip new">new</span>}
                </div>
                <div className="dim-note">
                  {t.label}
                  {t.label !== t.chainId ? ` · ${t.chainId}` : ""} · {isNew ? "opens on apply" : pathStatus(p, data.state)}
                </div>
                {!isFleetPath(p) && (
                  <label className="dim-note" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(p.openWhenFunded)}
                      onChange={(e) =>
                        setDraft((d) =>
                          d.map((x) => {
                            if (x.id !== p.id) return x;
                            const { openWhenFunded: _drop, ...rest } = x;
                            return e.target.checked ? { ...rest, openWhenFunded: true } : rest;
                          }),
                        )
                      }
                    />
                    open only once the relayer&apos;s key there is funded
                  </label>
                )}
              </div>
              <button className="btn small" onClick={() => setDraft((d) => d.filter((x) => x.id !== p.id))}>
                Remove
              </button>
            </div>
          );
        })}
        {removed.map((p) => (
          <div key={`removed-${p.id}`} className="rs-row removed">
            <div className="dim-note">
              <s>{p.id}</s> · stops being relayed on apply (its channels stay open on chain)
            </div>
            <button className="btn small" onClick={() => setDraft((d) => [...d, p])}>
              Undo
            </button>
          </div>
        ))}
      </div>
      <button className="btn accent-ghost" onClick={() => setView("add")}>
        + Add connection
      </button>

      <div className="f-label" style={{ marginTop: 18 }}>
        Key cap <span className="hint">most the relayer&apos;s key may hold on any Spark Dream chain</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="field"
          style={{ maxWidth: 180 }}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          aria-invalid={capInvalid}
        />
        <span className="dim-note">{data.symbol}</span>
        {capInvalid && <span className="dim-note" style={{ color: "var(--red-text)" }}>not an amount</span>}
      </div>
      <p className="dim-note" style={{ marginTop: 6 }}>
        The key sits on the relayer&apos;s provider: keep it to gas money. Chains given by endpoints carry their
        own cap.
      </p>

      <div style={{ marginTop: 14 }}>
        <button
          className="btn link"
          onClick={() => {
            if (yamlText === null) {
              setYamlText(yaml.dump(draft, { lineWidth: 120 }));
              setYamlError(null);
            } else {
              setYamlText(null);
            }
          }}
        >
          {yamlText === null ? "▸ Show as YAML" : "▾ Hide YAML"}
        </button>
        {yamlText !== null && (
          <>
            <textarea
              className={`spec${yamlError ? " invalid" : ""}`}
              style={{ marginTop: 8, minHeight: 220 }}
              value={yamlText}
              onChange={(e) => {
                setYamlText(e.target.value);
                try {
                  const parsed = yaml.load(e.target.value);
                  if (!Array.isArray(parsed)) throw new Error("expected a list of paths");
                  setDraft(parsed as RelayerPathSpec[]);
                  setYamlError(null);
                } catch (err) {
                  setYamlError(String(err instanceof Error ? err.message : err));
                }
              }}
            />
            <div className="dim-note">
              {yamlError ?? "topology.components.relayer.paths, as the spec stores it. Edits here update the list."}
            </div>
          </>
        )}
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="btn primary small"
          disabled={capInvalid || yamlError !== null || changes.length === 0}
          onClick={() => setView("review")}
        >
          Review changes
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: wide ? 720 : 480, maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

type Source =
  | { kind: "sister"; launchId: string }
  | { kind: "preset"; id: string }
  | { kind: "url" }
  | { kind: "custom" };

/** The three-step "Add connection" flow: what, which chain, details. */
function AddConnection({
  data,
  taken,
  onAdd,
  onCancel,
}: {
  data: RelayerSettings;
  taken: string[];
  onAdd: (paths: RelayerPathSpec[]) => void;
  onCancel: () => void;
}) {
  const [what, setWhat] = useState<"federation" | "transfer">("federation");
  const [alsoTransfer, setAlsoTransfer] = useState(true);
  const [source, setSource] = useState<Source | null>(null);
  const [endpoint, setEndpoint] = useState<Partial<EndpointCounterparty>>({});
  const [pathId, setPathId] = useState("");
  const [openWhenFunded, setOpenWhenFunded] = useState(false);
  const [detect, setDetect] = useState<{ busy: boolean; result?: DetectedChain; error?: string }>({ busy: false });

  const federation = what === "federation";
  const sisters = data.sisters;
  const presets = data.presets;

  const pickSister = (s: SisterFleet) => setSource({ kind: "sister", launchId: s.launchId });
  const pickPreset = (p: ChainPreset) => {
    setSource({ kind: "preset", id: p.id });
    setEndpoint(p.counterparty);
    setPathId(suggestPathId(p.id, taken));
    setOpenWhenFunded(p.paid);
  };
  const pickBlank = (kind: "url" | "custom") => {
    setSource({ kind });
    setEndpoint({});
    setPathId("");
    setOpenWhenFunded(false);
    setDetect({ busy: false });
  };

  const runDetect = async () => {
    if (!endpoint.rpc) return;
    setDetect({ busy: true });
    try {
      const { detectChain } = await import("../lib/api");
      const result = await detectChain(endpoint.rpc.trim(), endpoint.lcd?.trim() || undefined);
      setDetect({ busy: false, result });
      setEndpoint((e) => ({
        ...e,
        chainId: result.chainId,
        ...(result.bech32Prefix ? { bech32Prefix: result.bech32Prefix } : {}),
        ...(result.gasDenom ? { gasDenom: result.gasDenom } : {}),
        ...(result.gasPrice !== undefined ? { gasPrice: result.gasPrice } : {}),
      }));
      if (!pathId) setPathId(suggestPathId(result.chainId.replace(/-\d+$/, ""), taken));
    } catch (e) {
      setDetect({ busy: false, error: String(e instanceof Error ? e.message : e) });
    }
  };

  const sister = source?.kind === "sister" ? sisters.find((s) => s.launchId === source.launchId) : undefined;
  const sisterDraft = sister ? sisterPaths(sister, { federation, alsoTransfer, taken }) : [];

  // federation needs a Spark Dream chain: a sister fleet, or an endpoint
  // chain whose LCD answered for x/federation
  const endpointFederationOk = !federation || detect.result?.federation === true;
  const problems = source && source.kind !== "sister" ? endpointProblems(endpoint) : [];
  const idProblem =
    source && source.kind !== "sister"
      ? !validPathId(pathId)
        ? "a path name: lowercase letters, digits and dashes"
        : taken.includes(pathId)
          ? `${pathId} is already a path`
          : null
      : null;

  const addEndpoint = () => {
    const cp = cleanEndpoint(endpoint);
    const paths: RelayerPathSpec[] = [
      { id: pathId, kind: what, counterparty: cp, ...(openWhenFunded ? { openWhenFunded: true } : {}) },
    ];
    if (federation && alsoTransfer) {
      paths.push({
        id: suggestPathId(`${pathId}-transfer`, [...taken, pathId]),
        kind: "transfer",
        counterparty: cp,
        ...(openWhenFunded ? { openWhenFunded: true } : {}),
      });
    }
    onAdd(paths);
  };

  const set = (k: keyof EndpointCounterparty) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setEndpoint((x) => ({ ...x, [k]: k === "gasPrice" ? Number(e.target.value) : e.target.value }));

  return (
    <>
      <div className="k">Add connection</div>

      <div className="f-label">1 · What to relay</div>
      <div className="seg tight" style={{ marginBottom: 8 }}>
        <button className={federation ? "on" : ""} onClick={() => setWhat("federation")}>
          Content federation
        </button>
        <button className={!federation ? "on" : ""} onClick={() => setWhat("transfer")}>
          Token transfers
        </button>
      </div>
      {federation ? (
        <>
          <p className="dim-note">
            Blog posts, replies, forum threads and collections flow between Spark Dream sister chains once both
            have registered and activated each other as peers.
          </p>
          <label className="dim-note" style={{ display: "flex", gap: 6, alignItems: "center", margin: "6px 0 0" }}>
            <input type="checkbox" checked={alsoTransfer} onChange={(e) => setAlsoTransfer(e.target.checked)} />
            also token transfers (recommended: federated vouchers reference this channel)
          </label>
        </>
      ) : (
        <p className="dim-note">ICS-20 token transfers with any IBC chain.</p>
      )}

      <div className="f-label" style={{ marginTop: 16 }}>
        2 · Which chain
      </div>
      <div className="dim-note" style={{ marginBottom: 4 }}>
        Sister chains on this launcher
      </div>
      {sisters.length === 0 && <p className="dim-note">No other chain fleets for this wallet yet.</p>}
      <div style={{ display: "grid", gap: 6 }}>
        {sisters.map((s) => (
          <button
            key={s.launchId}
            className={`rs-choice${source?.kind === "sister" && source.launchId === s.launchId ? " on" : ""}`}
            disabled={!s.eligible}
            title={s.reason ?? ""}
            onClick={() => pickSister(s)}
          >
            <span className="mono">{s.chainId}</span> <span>{s.displayName}</span>{" "}
            <span className="dim-note">
              {s.networkType} ·{" "}
              {!s.eligible
                ? s.reason
                : s.route === "mesh"
                  ? "same mesh"
                  : "different mesh: via its sentry's public ports"}
            </span>
          </button>
        ))}
      </div>

      <p className="dim-note" style={{ margin: "6px 0 0" }}>
        A fleet of another of your wallets shows here once that fleet shares with this wallet (share… on its card).
      </p>
      <div className="dim-note" style={{ margin: "10px 0 4px" }}>
        {federation ? "Another Spark Dream chain" : "Other chains"}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {!federation &&
          presets.map((p) => (
            <button
              key={p.id}
              className={`rs-choice inline${source?.kind === "preset" && source.id === p.id ? " on" : ""}`}
              onClick={() => pickPreset(p)}
            >
              {p.label}
              {p.paid ? "" : " (testnet)"}
            </button>
          ))}
        <button
          className={`rs-choice inline${source?.kind === "url" ? " on" : ""}`}
          onClick={() => pickBlank("url")}
        >
          {federation ? "Spark Dream chain by URL…" : "Detect from URL…"}
        </button>
        {!federation && (
          <button
            className={`rs-choice inline${source?.kind === "custom" ? " on" : ""}`}
            onClick={() => pickBlank("custom")}
          >
            Custom chain…
          </button>
        )}
      </div>

      {source && (
        <>
          <div className="f-label" style={{ marginTop: 16 }}>
            3 · Details
          </div>
          {sister ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div className="dim-note">
                Adds {sisterDraft.map((p) => `${p.id} (${p.kind})`).join(" and ")}.
              </div>
              {sister.route === "public" && (
                <div className="dim-note">
                  {sister.name} is on another mesh: the relayer reaches it over its sentry-0&apos;s public ports.
                  A deployment only gets a new port when it is created, so unless that sentry already forwards
                  gRPC, the link pauses until you relaunch it
                  {sister.otherWallet ? ` with its own wallet (${sister.otherWallet})` : ""} (it syncs from its
                  validator on the new provider).
                </div>
              )}
              {federation && (
                <>
                  <div className="dim-note">
                    Peer policy: {data.peerPolicy.contentTypes.join(", ")}; {data.peerPolicy.ratePerEpoch} per epoch
                    each way; reputation {data.peerPolicy.reputation ? "on" : "off"}. Set once when the peer is
                    registered; after that it is the community&apos;s to change.
                  </div>
                  <div className="dim-note">
                    Who signs: {data.chainId}, {data.founderHeld ? "your founder key" : "your Operations Committee"};{" "}
                    {sister.chainId}, {sister.founderHeld ? "your founder key" : "its Operations Committee"}.
                  </div>
                </>
              )}
              <div className="dim-note">
                Relay fees between sister chains come back once the peers are active: the key there needs only a
                small float.
              </div>
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="btn primary small" onClick={() => onAdd(sisterDraft)}>
                  Add
                </button>
                <button className="btn" onClick={onCancel}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <Field label="RPC" value={endpoint.rpc ?? ""} onChange={set("rpc")} placeholder="https://rpc.example.org" />
              <Field
                label="LCD"
                hint="optional; lets the launcher check the key's balance and detect the chain"
                value={endpoint.lcd ?? ""}
                onChange={set("lcd")}
                placeholder="https://lcd.example.org"
              />
              {source.kind !== "custom" && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn small" disabled={!endpoint.rpc || detect.busy} onClick={runDetect}>
                    {detect.busy ? "Detecting…" : "Detect"}
                  </button>
                  {detect.result && (
                    <span className="dim-note">
                      {detect.result.chainId}
                      {detect.result.identity ? ` (${detect.result.identity})` : ""}
                      {detect.result.federation ? " · Spark Dream chain" : " · not a Spark Dream chain"}
                      {detect.result.notes.length ? ` · ${detect.result.notes.join("; ")}` : ""}
                    </span>
                  )}
                  {detect.error && (
                    <span className="dim-note" style={{ color: "var(--red-text)" }}>
                      {detect.error}
                    </span>
                  )}
                </div>
              )}
              {federation && detect.result && !detect.result.federation && (
                <p className="dim-note" style={{ color: "var(--red-text)" }}>
                  Content federation needs a Spark Dream chain: this one does not run x/federation. Pick token
                  transfers instead.
                </p>
              )}
              <Field
                label="gRPC"
                hint="publicly reachable"
                value={endpoint.grpc ?? ""}
                onChange={set("grpc")}
                placeholder="https://grpc.example.org:443"
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field label="Chain id" value={endpoint.chainId ?? ""} onChange={set("chainId")} />
                <Field label="Address prefix" value={endpoint.bech32Prefix ?? ""} onChange={set("bech32Prefix")} />
                <Field label="Gas denom" value={endpoint.gasDenom ?? ""} onChange={set("gasDenom")} />
                <Field
                  label="Gas price"
                  value={endpoint.gasPrice === undefined || Number.isNaN(endpoint.gasPrice) ? "" : String(endpoint.gasPrice)}
                  onChange={set("gasPrice")}
                />
                <Field
                  label="Cap"
                  hint="base units of the gas denom"
                  value={endpoint.maxBalance ?? ""}
                  onChange={set("maxBalance")}
                />
                <Field label="Path name" value={pathId} onChange={(e) => setPathId(e.target.value)} />
              </div>
              {endpoint.dynamicGasPrice && (
                <div className="dim-note">
                  Follows the chain&apos;s fee market (×{endpoint.dynamicGasPrice.multiplier}, never above{" "}
                  {endpoint.dynamicGasPrice.max} {endpoint.gasDenom}).
                </div>
              )}
              <label className="dim-note" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={openWhenFunded} onChange={(e) => setOpenWhenFunded(e.target.checked)} />
                open only once the relayer&apos;s key there is funded (for chains whose gas costs real money)
              </label>
              {federation && (
                <div className="dim-note">
                  This chain is not run by this launcher: its Operations Committee must register and activate its
                  end of the peer. The launcher writes those messages for them and waits.
                </div>
              )}
              {(problems.length > 0 || idProblem) && (
                <div className="dim-note">Still needed: {[...problems, ...(idProblem ? [idProblem] : [])].join(", ")}</div>
              )}
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  className="btn primary small"
                  disabled={problems.length > 0 || Boolean(idProblem) || !endpointFederationOk}
                  onClick={addEndpoint}
                >
                  Add
                </button>
                <button className="btn" onClick={onCancel}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {!source && (
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span className="f-label" style={{ margin: 0 }}>
        {label} {hint && <span className="hint">{hint}</span>}
      </span>
      <input className="field" value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  );
}
