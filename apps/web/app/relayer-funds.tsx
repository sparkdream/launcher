"use client";

import { useCallback, useEffect, useState } from "react";
import type { FundingRequest, RelayerFunds } from "../lib/api";
import { toBase, toDisplay } from "../lib/relayer-funds";

const STATUS_NOTE: Record<RelayerFunds["status"], string> = {
  ok: "",
  low: "low: top up soon",
  empty: "empty: relays nothing here",
  "over-cap": "above its cap: move the excess out",
  unknown: "balance unknown",
};

/** How often a pause's funding rows re-read the keys' balances. */
const LIVE_POLL_MS = 10_000;

/**
 * One row per relayer key: the chain, the address (with a copy button), what
 * it holds against its cap, and the ways to change that: a send from the
 * user's Keplr, and (in the funds panel) a withdrawal back out. Used by the
 * funding pause and by the relayer card's funds panel.
 */
export function FundingRows({
  rows,
  toast,
  onError,
  onChanged,
  withdraw,
  liveFrom,
}: {
  rows: Array<FundingRequest | RelayerFunds>;
  toast: (msg: string) => void;
  onError: (msg: string) => void;
  /** After a send or withdrawal landed (refresh balances). */
  onChanged?: () => void;
  /** Withdrawal back out; the funds panel offers it, the pause does not. */
  withdraw?: (chainId: string, to?: string) => Promise<{ txHash: string; amount: string; to: string }>;
  /** Launch whose relayer balances to poll, so a pause's rows (a snapshot
   *  from when the step reported) follow the keys as they are funded. */
  liveFrom?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState<Map<string, string>>(new Map());

  const poll = useCallback(async () => {
    if (!liveFrom) return;
    try {
      const { getRelayerFunds } = await import("../lib/api");
      const funds = await getRelayerFunds(liveFrom);
      setLive(new Map(funds.filter((f) => f.balance !== undefined).map((f) => [`${f.chainId}/${f.address}`, f.balance!])));
    } catch {
      // keep the last balances; the next poll may reach the chain
    }
  }, [liveFrom]);

  useEffect(() => {
    if (!liveFrom) return;
    poll();
    const t = setInterval(poll, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [liveFrom, poll]);

  const changed = () => {
    onChanged?.();
    poll();
  };

  const send = async (row: FundingRequest) => {
    const shown = window.prompt(
      `Send ${row.displayDenom} to the relayer's key on ${row.chainId} from your Keplr wallet.\n\n` +
        `The key sits on the relayer's provider: send gas money only` +
        (row.cap ? ` (cap ${toDisplay(row.cap, row.decimals)} ${row.displayDenom})` : "") +
        `.\n\nAmount in ${row.displayDenom}:`,
      toDisplay(row.amount, row.decimals),
    );
    if (shown === null) return;
    const amount = toBase(shown, row.decimals);
    if (!amount || amount === "0") return onError(`"${shown}" is not an amount of ${row.displayDenom}`);
    const after = BigInt(row.balance ?? "0") + BigInt(amount);
    if (row.cap && after > BigInt(row.cap)) {
      const ok = window.confirm(
        `That leaves ${toDisplay(after.toString(), row.decimals)} ${row.displayDenom} on the key, above its cap of ` +
          `${toDisplay(row.cap, row.decimals)}. Whatever it holds is at the relayer provider's mercy. Send anyway?`,
      );
      if (!ok) return;
    }
    setBusy(`send:${row.chainId}`);
    try {
      const { sendToRelayerKey } = await import("../lib/relayer-funds");
      const { txHash } = await sendToRelayerKey(row, amount);
      toast(`sent ${shown} ${row.displayDenom} to the relayer on ${row.chainId}, tx ${txHash.slice(0, 10)}…`);
      changed();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const takeOut = async (row: FundingRequest) => {
    if (!withdraw) return;
    const to = window.prompt(
      `Withdraw everything the relayer's key holds on ${row.chainId} (less the fee).\n\n` +
        "Hermes signs with this key: relaying on this chain stops until it is funded again.\n\n" +
        `Send to (an address on ${row.chainId}; leave empty for your own wallet's address there):`,
      "",
    );
    if (to === null) return;
    setBusy(`withdraw:${row.chainId}`);
    try {
      const out = await withdraw(row.chainId, to.trim() || undefined);
      toast(`withdrew ${toDisplay(out.amount, row.decimals)} ${row.displayDenom} to ${out.to}, tx ${out.txHash.slice(0, 10)}…`);
      changed();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fund-rows">
      {rows.map((snapshot) => {
        const balance = live.get(`${snapshot.chainId}/${snapshot.address}`);
        const row = balance !== undefined ? { ...snapshot, balance } : snapshot;
        const f = row as Partial<RelayerFunds>;
        const note = f.waiting ? "waiting for funds: relink after funding" : f.status ? STATUS_NOTE[f.status] : "";
        const held = row.balance !== undefined ? BigInt(row.balance) : undefined;
        const fill =
          held !== undefined && row.cap && BigInt(row.cap) > 0n
            ? Math.min(100, Number((held * 1000n) / BigInt(row.cap)) / 10)
            : undefined;
        const tone = held === undefined ? "" : held === 0n ? "empty" : f.status === "over-cap" ? "over" : "";
        return (
          <div key={row.chainId} className="fund-row">
            <div className="fund-head">
              <b>{row.chainId}</b>
              {note && <span className="dim-note">{note}</span>}
            </div>
            <div className="fund-addr">
              <span className="mono">{row.address}</span>
              <button
                className="btn small"
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(row.address);
                  } catch {
                    // clipboard unavailable (http origin): the toast still says what to copy
                  }
                  toast(`copied ${row.address}`);
                }}
              >
                copy
              </button>
            </div>
            <div className="fund-balance">
              {held !== undefined ? (
                <span>
                  holds <b className={tone}>{toDisplay(row.balance!, row.decimals)}</b> {row.displayDenom}
                  {row.cap && <span className="dim-note"> of {toDisplay(row.cap, row.decimals)} cap</span>}
                  {liveFrom && <span className="fund-live" title="re-read every few seconds" />}
                </span>
              ) : (
                <span className="dim-note">{f.error ?? "balance unknown"}</span>
              )}
              {fill !== undefined && (
                <div className={`fund-meter ${tone}`}>
                  <i style={{ width: `${fill}%` }} />
                </div>
              )}
            </div>
            <div className="fund-acts">
              <button
                className="btn primary small"
                disabled={busy !== null || !row.keplr}
                title={row.keplr ? "" : "no public RPC known for this chain: send from another wallet"}
                onClick={() => send(row)}
              >
                {busy === `send:${row.chainId}`
                  ? "Sending…"
                  : `Send ${toDisplay(row.amount, row.decimals)} ${row.displayDenom} with Keplr…`}
              </button>
              {withdraw && (
                <button
                  className="btn small"
                  disabled={busy !== null || BigInt(row.balance ?? "0") === 0n}
                  onClick={() => takeOut(row)}
                >
                  {busy === `withdraw:${row.chainId}` ? "Withdrawing…" : "Withdraw…"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
