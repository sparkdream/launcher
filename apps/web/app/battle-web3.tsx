"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getBattleWeb3Options, type BattleWeb3Check, type BattleWeb3Options } from "../lib/api";
import { toBase, toDisplay } from "../lib/relayer-funds";

/**
 * The battle game's "onchain…": one dialog for its onchain records, in the
 * resize dialog's design. A switch turns them on or off; on, it takes the
 * chain fleet the game writes to, the game management account and the
 * session grant's lifetime and fee budget, checks that account on that
 * chain as it is typed (membership, balance, the chain's caps), and lists
 * what applying does. Applying is the confirmation: the conductor still
 * refuses what cannot go ahead.
 */

const mono = "'JetBrains Mono', monospace";
const label = { fontSize: 12, fontWeight: 600, color: "#c9cad6" } as const;
const hint = { fontSize: 11.5, lineHeight: 1.45, color: "#9a9bab" } as const;
const field = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,.12)",
  background: "#16161e",
  color: "#ecedf2",
  fontSize: 13,
} as const;

export function BattleWeb3Dialog(props: {
  launchId: string;
  dseq: string;
  /** This fleet has a chain of its own (empty target: write to it). */
  chainFleet: boolean;
  onClose: () => void;
  /** web3 settings, or null to turn the records off. */
  onApply: (web3: Record<string, unknown> | null) => void;
}) {
  const { launchId, dseq, onClose } = props;
  const [opts, setOpts] = useState<BattleWeb3Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [target, setTarget] = useState("");
  const [account, setAccount] = useState("");
  const [days, setDays] = useState("");
  const [spend, setSpend] = useState("");
  const [check, setCheck] = useState<BattleWeb3Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // the stored settings fill the form
  useEffect(() => {
    getBattleWeb3Options(launchId, dseq)
      .then((o) => {
        setOpts(o);
        const t = o.targets.find((x) => x.id === o.current.target) ?? o.targets.find((x) => !x.unusable);
        setEnabled(o.current.enabled);
        setTarget(o.current.target ?? (props.chainFleet ? (o.targets.find((x) => x.self)?.id ?? "") : (t?.id ?? "")));
        setAccount(o.current.wallet ?? o.current.account ?? "");
        setDays(String(o.current.session.days ?? o.defaultDays));
        setSpend(toDisplay(o.current.session.spendLimit, t?.exponent ?? 6));
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchId, dseq]);

  // the account as the chain sees it, once typing pauses
  useEffect(() => {
    setCheck(null);
    setCheckError(null);
    if (!enabled || !target || !account.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      setChecking(true);
      getBattleWeb3Options(launchId, dseq, { target, account: account.trim() })
        .then((o) => live && setCheck(o.check ?? null))
        .catch((e) => live && setCheckError(String(e instanceof Error ? e.message : e)))
        .finally(() => live && setChecking(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [launchId, dseq, enabled, target, account]);

  const t = opts?.targets.find((x) => x.id === target);
  const exp = t?.exponent ?? 6;
  const denom = t?.displayDenom ?? "SPARK";
  const amount = (base: string | null | undefined) => (base == null ? "?" : `${toDisplay(base, exp)} ${denom}`);
  const acct = account.trim();
  const isWallet = Boolean(t && acct.startsWith(`${t.bech32Prefix}1`));
  const daysN = Number(days);
  const spendBase = toBase(spend, exp);
  const cur = opts?.current;

  // what applying would store, and whether it differs from now
  const web3 = enabled && t && acct
    ? {
        ...(t.self ? {} : { target: { fleet: t.id } }),
        ...(isWallet ? { wallet: acct } : { account: acct }),
        session: { days: daysN, spendLimit: spendBase ?? "0" },
      }
    : null;
  const changed =
    !!cur &&
    (enabled !== cur.enabled ||
      (enabled &&
        (target !== (cur.target ?? "") ||
          acct !== (cur.wallet ?? cur.account ?? "") ||
          daysN !== (cur.session.days ?? opts!.defaultDays) ||
          spendBase !== cur.session.spendLimit)));

  // what stops it, and what only warns
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (enabled && opts) {
    if (opts.targets.length === 0) blockers.push("This launcher runs no finished chain fleet for the game to write to.");
    if (!t && opts.targets.length > 0) blockers.push("Pick the chain fleet the game writes to.");
    if (t?.unusable) blockers.push(`${t.name}: ${t.unusable}.`);
    if (!acct) blockers.push("Give the game management account.");
    if (!Number.isInteger(daysN) || daysN < 1 || daysN > 365) blockers.push("The grant lifetime is a whole number of days, 1 to 365.");
    if (!spendBase || spendBase === "0") blockers.push(`The fee budget is an amount of ${denom} above zero.`);
    if (checkError) blockers.push(checkError);
    if (check) {
      if (check.error) warnings.push(`${check.error}. The account could not be checked: the op checks it again before anything is signed.`);
      else if (check.trustLevel === null) blockers.push(`${short(check.address)} is not a member of ${t?.name}: the game management account must be one.`);
      else if (!check.classesReady && !check.canCreateClasses)
        blockers.push(`${short(check.address)} is ${check.trustLevel} on ${t?.name}: setting up the game's tokens needs PROVISIONAL or above.`);
      if (check.sessionMax && spendBase && BigInt(spendBase) > BigInt(check.sessionMax.spendLimit))
        blockers.push(`${t?.name} caps a session's fee budget at ${amount(check.sessionMax.spendLimit)}.`);
      if (check.sessionMax && daysN > check.sessionMax.days) blockers.push(`${t?.name} caps a session at ${check.sessionMax.days} days.`);
      if (check.balance !== null && spendBase) {
        const need = BigInt(check.classCost ?? "0") + BigInt(spendBase);
        if (BigInt(check.balance) < need)
          warnings.push(`${short(check.address)} holds ${amount(check.balance)}; setup and the fee budget need about ${amount(need.toString())}, plus ${amount(check.tokenDeposit)} per token the game mints.`);
      }
    }
  }

  const who = acct ? (isWallet ? short(acct) : acct) : "the account";
  const walletSigns = isWallet;
  const classesToCreate = !check || !check.classesReady;
  const steps: ReactNode[] = enabled
    ? [
        "The game's deployment is updated in place (one signature): it restarts on the same lease and domain and keeps its leaderboard",
        ...(classesToCreate
          ? [
              `${who} sets up the game's token classes on ${t?.name ?? "the chain"}` +
                (check?.classCost ? ` (${amount(check.classCost)} burned)` : ", if it has not already") +
                (walletSigns ? ": you sign it in your wallet" : ""),
            ]
          : []),
        `${who} grants the game a session key that can only mint and update the game's tokens, for ${Number.isInteger(daysN) ? daysN : "?"} days with a ${spend || "?"} ${denom} fee budget` +
          (walletSigns ? ": you sign it in your wallet" : "") +
          "; the launcher renews it before it expires",
        "Players see Connect Keplr once the game reaches the chain (it retries on its own)",
      ]
    : [
        "The game's deployment is updated in place (one signature) and restarts without its chain settings",
        "The leaderboard stays and players play with guest profiles; tokens already minted stay on chain",
        "The session grant is no longer renewed and lapses at its expiry",
      ];
  const signatures = 1 + (enabled && walletSigns ? (classesToCreate ? 2 : 1) : 0);
  const canApply = !!opts && changed && blockers.length === 0 && !checking;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", background: "#101016", border: "1px solid rgba(255,255,255,.1)", borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,.6)", color: "#ecedf2" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "20px 22px 0" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 17 }}>Onchain records</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#9a9bab" }}>
              Battle royale
              {opts?.domain && (
                <>
                  <span style={{ color: "#4a4b56" }}>·</span>
                  <span style={{ fontFamily: mono, fontSize: 11.5, color: "#c9cad6" }}>{opts.domain}</span>
                </>
              )}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close" className="dlg-x">✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "20px 22px" }}>
          {!opts && !error && <div style={{ fontSize: 12.5, color: "#9a9bab" }}>Reading the game's settings…</div>}
          {error && <div style={{ fontSize: 12.5, color: "#fca5a5" }}>{error}</div>}
          {opts && (
            <>
              <button
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, color: "#ecedf2", cursor: "pointer", textAlign: "left" }}
              >
                <span style={{ flex: "none", width: 32, height: 18, borderRadius: 99, background: enabled ? "#6d6af8" : "rgba(255,255,255,.18)", display: "flex", alignItems: "center", padding: 2, boxSizing: "border-box", justifyContent: enabled ? "flex-end" : "flex-start", marginTop: 1 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 99, background: "#fff" }} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Write match results to a chain</span>
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: "#9a9bab" }}>
                    Players connect Keplr with one signature; the game then mints their career and badges, and a record of every match, for the game management account. Off: guest profiles only.
                  </span>
                </span>
              </button>

              {enabled && (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <span style={label}>Chain</span>
                    <select value={target} onChange={(e) => setTarget(e.target.value)} style={field}>
                      {!t && <option value="">Pick a chain fleet…</option>}
                      {opts.targets.map((x) => (
                        <option key={x.id} value={x.id} disabled={!!x.unusable}>
                          {x.name} · {x.chainId}
                          {x.self ? " (this fleet)" : ""}
                          {x.notShared ? " (not shared with this wallet)" : x.unusable ? " (no public endpoints)" : ""}
                        </option>
                      ))}
                    </select>
                    {!props.chainFleet && <span style={hint}>This services fleet has no chain of its own: pick a chain fleet on this launcher.</span>}
                    {opts.targets.some((x) => x.notShared) && (
                      <span style={hint}>
                        A fleet another wallet runs can be picked once it is shared with this one: connect that wallet and use share… on its
                        fleet card.
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <span style={label}>Game management account</span>
                    <input
                      list="battle-web3-accounts"
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                      placeholder={t ? (t.foreign ? `${t.bech32Prefix}1…` : `${t.bech32Prefix}1… or a generated account`) : "member address"}
                      spellCheck={false}
                      style={{ ...field, fontFamily: mono, fontSize: 12 }}
                    />
                    <datalist id="battle-web3-accounts">
                      {t?.accounts.map((a) => (
                        <option key={a} value={a} />
                      ))}
                    </datalist>
                    <span style={hint}>
                      {t?.foreign ? (
                        <>
                          A member of the chain, PROVISIONAL or above, whose key is in your wallet: you sign its setup. Another wallet runs this fleet, so its
                          generated accounts are not offered.
                        </>
                      ) : (
                        <>
                          A member of the chain, PROVISIONAL or above. An address keeps its key in your wallet and you sign its setup; a generated account
                          {t?.accounts.length ? ` (${t.accounts.join(", ")})` : ""} is signed by the launcher.
                        </>
                      )}
                    </span>
                    <AccountLine check={check} checking={checking} amount={amount} />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <span style={label}>Session lifetime</span>
                      <div style={{ position: "relative" }}>
                        <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" style={{ ...field, fontFamily: mono, paddingRight: 46 }} />
                        <span style={{ position: "absolute", right: 11, top: 9, fontSize: 12, color: "#7d7e8c" }}>days</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <span style={label}>Fee budget</span>
                      <div style={{ position: "relative" }}>
                        <input value={spend} onChange={(e) => setSpend(e.target.value)} inputMode="decimal" style={{ ...field, fontFamily: mono, paddingRight: 64 }} />
                        <span style={{ position: "absolute", right: 11, top: 9, fontSize: 12, color: "#7d7e8c" }}>{denom}</span>
                      </div>
                    </div>
                  </div>
                  <span style={{ ...hint, marginTop: -10 }}>
                    The game pays its transaction fees from the grant, never more than the budget per grant
                    {check?.sessionMax ? ` (${t?.name} allows up to ${check.sessionMax.days} days and ${amount(check.sessionMax.spendLimit)})` : ""}.
                  </span>
                </>
              )}

              {blockers.length > 0 && (
                <div className="dlg-warn red">
                  <b>!</b>
                  <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {blockers.map((b) => (
                      <span key={b}>{b}</span>
                    ))}
                  </span>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="dlg-warn">
                  <b>!</b>
                  <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {warnings.map((w) => (
                      <span key={w}>{w}</span>
                    ))}
                  </span>
                </div>
              )}

              {changed && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "#9a9bab" }}>What happens</div>
                  {steps.map((s, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, lineHeight: 1.45, color: "#c9cad6" }}>
                      <span style={{ flex: "none", width: 18, height: 18, borderRadius: 99, background: "rgba(109,106,248,.16)", color: "#b3b1fb", font: `600 10.5px ${mono}`, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{i + 1}</span>
                      <span style={{ textWrap: "pretty" } as React.CSSProperties}>{s}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.02)", borderRadius: "0 0 14px 14px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
            {changed && enabled && check?.classCost && !check.classesReady && (
              <span style={{ fontFamily: mono, fontSize: 13, color: "#ecedf2" }}>{amount(check.classCost)}</span>
            )}
            <span style={{ fontSize: 11.5, color: "#9a9bab" }}>
              {!changed
                ? "no changes"
                : `${enabled && check?.classCost && !check.classesReady ? "burned once · " : ""}${signatures} signature${signatures > 1 ? "s" : ""}`}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{ padding: "9px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,.12)", background: "transparent", color: "#c9cad6", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >
              Cancel
            </button>
            <button
              disabled={!canApply}
              onClick={() => props.onApply(enabled ? web3 : null)}
              style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: canApply ? "#6d6af8" : "#3d3c7a", color: "#fff", fontSize: 13, fontWeight: 600, cursor: canApply ? "pointer" : "default" }}
            >
              {!enabled && cur?.enabled ? "Turn off" : cur?.enabled ? "Apply" : "Turn on"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The picked account as the chain sees it, under its field. */
function AccountLine(props: { check: BattleWeb3Check | null; checking: boolean; amount: (base: string | null | undefined) => string }) {
  const { check, checking, amount } = props;
  if (checking && !check) return <span style={hint}>Checking the account on the chain…</span>;
  if (!check || check.error) return null;
  const ok = check.trustLevel !== null && (check.classesReady || check.canCreateClasses);
  return (
    <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 11.5, color: "#9a9bab" }}>
      <span style={{ fontFamily: mono, color: "#c9cad6" }}>{short(check.address)}</span>
      <span style={{ color: "#4a4b56" }}>·</span>
      <span style={{ color: ok ? "#4ade80" : "#fca5a5" }}>{check.trustLevel ? `member, ${check.trustLevel}` : "not a member"}</span>
      {check.balance !== null && (
        <>
          <span style={{ color: "#4a4b56" }}>·</span>
          <span style={{ fontFamily: mono }}>{amount(check.balance)}</span>
        </>
      )}
    </span>
  );
}

function short(address: string): string {
  return address.length > 20 ? `${address.slice(0, 12)}…${address.slice(-6)}` : address;
}
