import crypto from "node:crypto";
import type { StdSignDoc } from "@cosmjs/amino";
import { toBase64 } from "@cosmjs/encoding";
import { verifyAminoSignature, type AminoSignature } from "./amino-verify.js";

/**
 * Wallet-session auth (M6, §2): the UI asks Keplr to `signArbitrary` a
 * server nonce (ADR-36); the conductor verifies the signature, checks the
 * address against the OPERATOR_ADDRESSES allowlist, and issues a session
 * token. The session's address is the owner scope for every route — never
 * a client-supplied parameter (§2 scoping rule).
 */

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface NonceEntry {
  nonce: string;
  expires: number;
}

interface SessionEntry {
  address: string;
  expires: number;
}

/** ADR-36 sign doc for arbitrary data — what Keplr signs for signArbitrary. */
export function adr36SignDoc(signer: string, data: string): StdSignDoc {
  return {
    chain_id: "",
    account_number: "0",
    sequence: "0",
    fee: { gas: "0", amount: [] },
    msgs: [
      {
        type: "sign/MsgSignData",
        value: { signer, data: toBase64(Buffer.from(data)) },
      },
    ],
    memo: "",
  };
}

export type AuthSignature = AminoSignature;

export class AuthService {
  private nonces = new Map<string, NonceEntry>();
  private sessions = new Map<string, SessionEntry>();

  constructor(readonly allowlist: readonly string[]) {}

  issueNonce(address: string): string {
    this.prune();
    const nonce = `sparkdream-launcher auth ${crypto.randomBytes(16).toString("hex")}`;
    this.nonces.set(address, { nonce, expires: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  async verify(address: string, signature: AuthSignature): Promise<string> {
    const entry = this.nonces.get(address);
    if (!entry || entry.expires < Date.now()) throw new Error("nonce expired — request a new one");
    this.nonces.delete(address); // single use

    if (this.allowlist.length > 0 && !this.allowlist.includes(address)) {
      throw new Error(`${address} is not in OPERATOR_ADDRESSES`);
    }
    const result = await verifyAminoSignature(adr36SignDoc(address, entry.nonce), address, signature);
    if (!result.ok) throw new Error(result.reason);

    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(token, { address, expires: Date.now() + SESSION_TTL_MS });
    return token;
  }

  /** The authenticated owner address for a bearer token, if valid. */
  ownerFor(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expires < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session.address;
  }

  /** Drop expired entries so the maps stay bounded to live sessions/nonces. */
  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.nonces) if (v.expires < now) this.nonces.delete(k);
    for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k);
  }
}
