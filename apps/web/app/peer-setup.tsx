"use client";

import type { PeerSetup } from "../lib/api";

/**
 * The other two ways to finish a federation peer's setup on a chain whose
 * committee key the launcher does not hold, beside signing each transaction
 * here with Keplr: one script for the computer that holds the key, or that
 * chain's frontend, prefilled. The launcher resumes by itself once the chain
 * shows the work done.
 */
export function PeerSetupRoutes({ setup, toast }: { setup: PeerSetup; toast: (msg: string) => void }) {
  const copy = (text: string, what: string) => {
    try {
      void navigator.clipboard.writeText(text);
      toast(`copied ${what}`);
    } catch {
      toast(`select the ${what} and copy it by hand`);
    }
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div>
        <b>
          Federation peer {setup.peerId} on {setup.chainId}
        </b>
        <div className="dim-note">Left to do, in order:</div>
        <ol style={{ margin: "4px 0 0 18px" }}>
          {setup.remaining.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
        <div className="dim-note" style={{ marginTop: 4 }}>
          Finish it any of three ways: sign each step below with Keplr (when this browser&apos;s Keplr holds an
          Operations Committee member of {setup.chainId}), run the script on the computer that holds the key, or
          use {setup.chainId}&apos;s frontend. The launcher checks the chain and carries on by itself once it shows the
          work done.
        </div>
      </div>
      <details>
        <summary className="dim-note">On another computer: one script for every remaining step</summary>
        <div className="dim-note" style={{ margin: "6px 0" }}>
          Needs sparkdreamd and jq there. Edit KEY to the committee member&apos;s key name, then run it: it signs each
          transaction in turn and waits out the committee&apos;s execution period before activating.
        </div>
        <button className="btn small" onClick={() => copy(setup.script, "the script")}>
          Copy script
        </button>
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 320, overflow: "auto" }}>
          {setup.script}
        </pre>
      </details>
      {setup.links && (
        <details>
          <summary className="dim-note">In {setup.chainId}&apos;s frontend</summary>
          <div className="dim-note" style={{ margin: "6px 0" }}>
            Connect the committee member&apos;s wallet there, then:
          </div>
          <ol style={{ margin: "0 0 0 18px", display: "grid", gap: 4 }}>
            {setup.links.register && (
              <li>
                <a href={setup.links.register} target="_blank" rel="noreferrer">
                  Register the peer
                </a>{" "}
                <span className="dim-note">
                  (prefilled on a frontend from v1.0.77
                  {setup.registerHint ? `; otherwise enter ${setup.registerHint}` : ""})
                </span>
              </li>
            )}
            {setup.links.policy && (
              <li>
                <a href={setup.links.policy} target="_blank" rel="noreferrer">
                  Set its federation policy
                </a>
                {setup.policyHint && <span className="dim-note"> ({setup.policyHint})</span>}
              </li>
            )}
            {setup.links.activate && (
              <li>
                <a href={setup.links.activate} target="_blank" rel="noreferrer">
                  Propose activating it
                </a>
                <span className="dim-note">, vote yes, and execute it once the execution period has passed</span>
              </li>
            )}
          </ol>
        </details>
      )}
    </div>
  );
}
