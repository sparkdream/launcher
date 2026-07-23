import { makeSignDoc, type AminoMsg, type StdFee, type StdSignDoc } from "@cosmjs/amino";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { Decimal } from "@cosmjs/math";
import { encodePubkey } from "@cosmjs/proto-signing";
import { AminoTypes, createDefaultAminoConverters } from "@cosmjs/stargate";
import { validatorMoniker, type LaunchSpec } from "@sparkdream/launch-spec";
import { verifyAminoSignature } from "./amino-verify.js";
import { commissionFlags } from "./genesis-params.js";

/**
 * External-operator gentx flow (§5 step 3b): the conductor builds the sign
 * doc, the user's wallet signs it offline (amino mode — Ledger-compatible),
 * the conductor verifies and assembles the gentx file. The sign-doc account
 * number is PINNED to 0: the SDK verifies all height-0 signatures against
 * account number 0 (x/auth/ante/sigverify.go) — any other value bricks the
 * chain at block 1.
 *
 * Serialization fidelity note: amino sign bytes are reproduced by the chain
 * at InitChain from the decoded tx. We build both the sign doc and the tx
 * from the same source values through cosmjs's default amino converters —
 * the same path Keplr+Ledger use for MsgCreateValidator on live chains.
 * The M3 devnet launch is the end-to-end proof.
 */

const CREATE_VALIDATOR_TYPE_URL = "/cosmos.staking.v1beta1.MsgCreateValidator";
const GENTX_FEE: StdFee = { amount: [], gas: "200000" };

const aminoTypes = new AminoTypes(createDefaultAminoConverters());

export interface GentxInputs {
  spec: LaunchSpec;
  valIndex: number;
  operatorAddress: string;
  /** base64 ed25519 consensus pubkey (from `comet show-validator`). */
  consensusPubkey: string;
  nodeId: string;
  chainId: string;
}

export function valoperAddress(operatorAddress: string): string {
  const { prefix, data } = fromBech32(operatorAddress);
  return toBech32(`${prefix}valoper`, data);
}

/**
 * The proto-runtime msg both the sign doc and the gentx file derive from.
 * Commission rates here are proto WIRE decimals (atomics, 10^18-scaled) —
 * what cosmjs's amino converter expects; the gentx file uses the protojson
 * decimal form from commissionFlags directly.
 */
function createValidatorMsg(input: GentxInputs) {
  const commission = commissionFlags(input.spec);
  const atomics = (dec: string) => Decimal.fromUserInput(dec, 18).atomics;
  return {
    typeUrl: CREATE_VALIDATOR_TYPE_URL,
    value: {
      description: {
        moniker: validatorMoniker(input.spec, input.valIndex),
        identity: "",
        website: "",
        securityContact: "",
        details: "",
      },
      commission: {
        rate: atomics(commission.rate),
        maxRate: atomics(commission.maxRate),
        maxChangeRate: atomics(commission.maxChangeRate),
      },
      minSelfDelegation: "1",
      delegatorAddress: input.operatorAddress,
      validatorAddress: valoperAddress(input.operatorAddress),
      pubkey: encodePubkey({ type: "tendermint/PubKeyEd25519", value: input.consensusPubkey }),
      value: {
        denom: input.spec.token.bondDenom ?? input.spec.token.baseDenom,
        amount: input.spec.accounts.validatorSelfDelegation,
      },
    },
  };
}

/**
 * Match the SDK's amino-json rendering: fields without amino.dont_omitempty
 * are omitted when empty, and cosmjs's converters keep empty strings
 * (description.identity/website/..., the deprecated delegator_address). The
 * chain regenerates sign bytes with the omit-empty form, so a doc that
 * differs by even one "" fails signature verification — proven against the
 * manual sparkdream-test-1 gentx, whose signature verifies only over the
 * omit-empty rendering. `sparkdreamd tx sign` (the offline signing path)
 * produces the same omit-empty bytes.
 */
function omitEmptyStrings<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitEmptyStrings) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === "") continue;
      out[k] = omitEmptyStrings(v);
    }
    return out as T;
  }
  return value;
}

export function buildGentxSignDoc(input: GentxInputs): StdSignDoc {
  const aminoMsg: AminoMsg = omitEmptyStrings(aminoTypes.toAmino(createValidatorMsg(input)));
  const memo = `${input.nodeId}@127.0.0.1:26656`;
  // account number 0 / sequence 0 — see module doc, do not parameterize
  return makeSignDoc([aminoMsg], GENTX_FEE, input.chainId, memo, 0, 0);
}

/** Real account coordinates + fee for an ONLINE MsgCreateValidator (join mode). */
export interface OnlineTxParams {
  accountNumber: number;
  sequence: number;
  fee: StdFee;
}

/**
 * Sign doc for promote-validator (§5 "Join mode" Phase G): the same
 * MsgCreateValidator as a gentx, but a live on-chain tx — real account
 * number and sequence, a real fee, and no node-id memo (peer discovery is
 * long past by the time the validator bonds).
 */
export function buildCreateValidatorSignDoc(input: GentxInputs, online: OnlineTxParams): StdSignDoc {
  const aminoMsg: AminoMsg = omitEmptyStrings(aminoTypes.toAmino(createValidatorMsg(input)));
  return makeSignDoc([aminoMsg], online.fee, input.chainId, "", online.accountNumber, online.sequence);
}

/** Keplr's AminoSignResponse shape. */
export interface GentxSignResponse {
  signed: StdSignDoc;
  signature: {
    pub_key: { type: string; value: string };
    signature: string;
  };
}

export interface GentxVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Keplr's background sign handler returns the signed doc after a recursive
 * alphabetical key sort (keyring-cosmos/service.ts → common/json/sort.ts),
 * so raw key order in the wallet's doc is never the conductor's. Amino sign
 * bytes are themselves sorted JSON — order carries no consensus meaning —
 * which is why the signature still verifies. Drift checks compare the
 * canonical (sorted) form; any value-level tampering still fails here or
 * under verifyAminoSignature.
 */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value;
}

/**
 * Where two JSON-shaped values first differ, for a drift reason the
 * operator can act on ("msgs[0].value.commission.rate") — "msgs differ"
 * alone sent operators hunting blind. Inputs must be key-sorted already
 * (sortKeysDeep) so ordering doesn't read as a difference.
 */
function firstDiffPath(expected: unknown, actual: unknown, at: string): string {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return at;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${at} (signed ${actual.length}, expected ${expected.length})`;
    }
    for (let i = 0; i < expected.length; i++) {
      if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
        return firstDiffPath(expected[i], actual[i], `${at}[${i}]`);
      }
    }
    return at;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in a)) return `${at}.${k} (missing from the signed doc)`;
      if (JSON.stringify(e[k]) !== JSON.stringify(a[k])) {
        return firstDiffPath(e[k], a[k], `${at}.${k}`);
      }
    }
    for (const k of Object.keys(a)) {
      if (!(k in e)) return `${at}.${k} (not in the conductor's doc)`;
    }
    return at;
  }
  return at;
}

/**
 * Verify a wallet's amino sign response against the doc the conductor
 * built, before the tx is assembled (§5 step 3b, and Phase G's
 * promote-validator): the signature must be valid over the doc the wallet
 * actually signed, the signer must be the declared operator, and the
 * signed doc must not have drifted from ours in any consensus-relevant
 * way. Every expectation, including the gentx path's pinned zero
 * account_number/sequence and the promote path's live coordinates, lives
 * in `expected`, so both flows share one set of drift rules.
 *
 * The wallet may adjust gas, but memo and fee amount must not drift: both
 * are copied from the signed doc into the assembled tx, where a changed
 * fee fails at InitChain / broadcast (too low) or spends past the balance
 * the conductor verified (too high), with a far less useful error.
 *
 * Drift is compared on canonical (key-sorted) forms: Keplr's background
 * returns the signed doc with every object's keys re-sorted alphabetically,
 * so a key-order-naive comparison rejects every genuine Keplr signature
 * (the 2026-07-22 sparkdream-dev gentx rejection).
 */
export async function verifySignedDoc(
  expected: StdSignDoc,
  response: GentxSignResponse,
  operatorAddress: string,
): Promise<GentxVerifyResult> {
  const { signed, signature } = response;
  if (signed.chain_id !== expected.chain_id) return { ok: false, reason: "chain_id mismatch" };
  if (signed.account_number !== expected.account_number) {
    return { ok: false, reason: `account_number must be ${expected.account_number}` };
  }
  if (signed.sequence !== expected.sequence) {
    return { ok: false, reason: `sequence must be ${expected.sequence}` };
  }
  // msgs and fee.amount compare canonical (key-sorted) forms — Keplr
  // returns the doc with keys recursively sorted, so a raw JSON.stringify
  // rejects every genuine Keplr signature (see sortKeysDeep)
  const expectedMsgs = sortKeysDeep(expected.msgs);
  const signedMsgs = sortKeysDeep(signed.msgs);
  if (JSON.stringify(signedMsgs) !== JSON.stringify(expectedMsgs)) {
    return {
      ok: false,
      reason: `msgs differ from the conductor-built sign doc (${firstDiffPath(expectedMsgs, signedMsgs, "msgs")})`,
    };
  }
  if (signed.memo !== expected.memo) {
    return { ok: false, reason: "memo differs from the conductor-built sign doc" };
  }
  const expectedAmount = sortKeysDeep(expected.fee.amount);
  const signedAmount = sortKeysDeep(signed.fee.amount);
  if (JSON.stringify(signedAmount) !== JSON.stringify(expectedAmount)) {
    return {
      ok: false,
      reason: `fee amount differs from the conductor-built sign doc (${firstDiffPath(expectedAmount, signedAmount, "fee.amount")})`,
    };
  }
  return verifyAminoSignature(signed, operatorAddress, signature);
}

/**
 * Wrap proto-JSON messages and a wallet's amino sign response into a
 * broadcastable Tx (also the format `collect-gentxs` reads). Fee and memo
 * come from the doc the wallet signed (Keplr may adjust gas).
 */
function assembleSignedTxJson(messages: unknown[], response: GentxSignResponse): string {
  const signed = response.signed;
  return JSON.stringify(
    {
      body: {
        messages,
        memo: signed.memo,
        timeout_height: "0",
        extension_options: [],
        non_critical_extension_options: [],
      },
      auth_info: {
        signer_infos: [
          {
            public_key: {
              "@type": "/cosmos.crypto.secp256k1.PubKey",
              key: response.signature.pub_key.value,
            },
            mode_info: { single: { mode: "SIGN_MODE_LEGACY_AMINO_JSON" } },
            // "0" for gentxs; the live sequence for online txs
            sequence: String(signed.sequence),
          },
        ],
        fee: {
          amount: signed.fee.amount,
          gas_limit: signed.fee.gas,
          payer: "",
          granter: "",
        },
        tip: null,
      },
      signatures: [response.signature.signature],
    },
    null,
    2,
  );
}

/**
 * Assemble the gentx file. Message fields come from the same source as the
 * sign doc.
 */
export function assembleGentxJson(input: GentxInputs, response: GentxSignResponse): string {
  const msg = createValidatorMsg(input).value;
  const commission = commissionFlags(input.spec); // protojson decimal form
  return assembleSignedTxJson(
    [
      {
        "@type": CREATE_VALIDATOR_TYPE_URL,
        description: {
          moniker: msg.description.moniker,
          identity: "",
          website: "",
          security_contact: "",
          details: "",
        },
        commission: {
          rate: commission.rate,
          max_rate: commission.maxRate,
          max_change_rate: commission.maxChangeRate,
        },
        min_self_delegation: msg.minSelfDelegation,
        delegator_address: msg.delegatorAddress,
        validator_address: msg.validatorAddress,
        pubkey: {
          "@type": "/cosmos.crypto.ed25519.PubKey",
          key: input.consensusPubkey,
        },
        value: msg.value,
      },
    ],
    response,
  );
}

/**
 * Offline signing (§5 step 3b variant): the operator key lives on an
 * airgapped machine with sparkdreamd, not in a browser wallet. The
 * conductor exports the sign doc as an UNSIGNED proto-JSON tx (`tx sign
 * --offline --sign-mode amino-json` input), the machine signs it, and the
 * pasted signed tx converts back into the amino sign-response shape the
 * existing verification path consumes. Security is unchanged: the
 * signature only verifies over the doc the conductor built, so a tx whose
 * messages were tampered with fails verifySignedDoc like any bad browser
 * signature.
 */

/** Amino msg → proto-JSON message (the tx-file encoding). */
function aminoMsgToProtoJson(msg: AminoMsg): Record<string, unknown> {
  if (msg.type === "cosmos-sdk/MsgCreateValidator") {
    const v = msg.value as Record<string, any>;
    return {
      "@type": CREATE_VALIDATOR_TYPE_URL,
      ...v,
      pubkey: { "@type": "/cosmos.crypto.ed25519.PubKey", key: v.pubkey.value },
    };
  }
  if (msg.type === "cosmos-sdk/MsgUnjail") {
    // proto field name (validator_addr), not the amino field name (address)
    return { "@type": UNJAIL_TYPE_URL, validator_addr: (msg.value as any).address };
  }
  throw new Error(`no proto-JSON conversion for amino msg type ${msg.type}`);
}

/** The unsigned tx file an airgapped `sparkdreamd tx sign --offline` takes. */
export function unsignedTxJsonFromSignDoc(doc: StdSignDoc): string {
  return JSON.stringify(
    {
      body: {
        messages: doc.msgs.map(aminoMsgToProtoJson),
        memo: doc.memo,
        timeout_height: "0",
        extension_options: [],
        non_critical_extension_options: [],
      },
      auth_info: {
        signer_infos: [],
        fee: { amount: doc.fee.amount, gas_limit: doc.fee.gas, payer: "", granter: "" },
        tip: null,
      },
      signatures: [],
    },
    null,
    2,
  );
}

/**
 * Signed tx file → the amino sign-response shape verifySignedDoc consumes.
 * The response's signed doc is reconstructed as "expected doc + the
 * signer's fee/memo": if the signer changed anything else, the signature
 * fails verification (drift in fee/memo is caught by verifySignedDoc's own
 * rules). Throws with a user-facing reason on shape problems.
 */
export function gentxResponseFromSignedTx(
  signedTx: unknown,
  expected: StdSignDoc,
): GentxSignResponse {
  const tx = (typeof signedTx === "string" ? JSON.parse(signedTx) : signedTx) as Record<string, any>;
  const body = tx?.body;
  const authInfo = tx?.auth_info;
  const signatures = tx?.signatures;
  if (!body || !authInfo || !Array.isArray(signatures)) {
    throw new Error("not a signed tx file: expected body / auth_info / signatures");
  }
  if (signatures.length !== 1 || typeof signatures[0] !== "string" || !signatures[0]) {
    throw new Error("expected exactly one signature (run `tx sign`, not the unsigned file)");
  }
  const signers = authInfo.signer_infos;
  if (!Array.isArray(signers) || signers.length !== 1) {
    throw new Error("expected exactly one signer_info");
  }
  const signer = signers[0] as Record<string, any>;
  const mode = signer.mode_info?.single?.mode;
  if (mode !== "SIGN_MODE_LEGACY_AMINO_JSON") {
    throw new Error(
      `sign mode is ${mode ?? "unknown"} — re-sign with --sign-mode amino-json (gentx signatures are verified as amino)`,
    );
  }
  if (String(signer.sequence ?? "") !== String(expected.sequence)) {
    throw new Error(`signed with sequence ${signer.sequence}, expected ${expected.sequence}`);
  }
  const pubkeyB64 = signer.public_key?.key;
  if (typeof pubkeyB64 !== "string" || !pubkeyB64) {
    throw new Error("signer_info has no public key");
  }
  const fee = authInfo.fee ?? {};
  return {
    signed: {
      ...expected,
      fee: { amount: fee.amount ?? [], gas: String(fee.gas_limit ?? expected.fee.gas) },
      memo: String(body.memo ?? ""),
    },
    signature: {
      pub_key: { type: "tendermint/PubKeySecp256k1", value: pubkeyB64 },
      signature: signatures[0],
    },
  };
}

const UNJAIL_TYPE_URL = "/cosmos.slashing.v1beta1.MsgUnjail";

/**
 * Amino sign doc for an external operator's MsgUnjail (§5 unjail op).
 * Hand-written amino shape: cosmjs ships no slashing converter
 * (createSlashingAminoConverters throws "Not implemented", and its
 * AminoMsgUnjail declaration predates the SDK's annotations). The chain
 * regenerates the sign bytes from the decoded tx via the proto annotations
 * (SDK 0.53 cosmos/slashing/v1beta1/tx.proto: amino.name
 * "cosmos-sdk/MsgUnjail", amino.field_name "address"), so the field here
 * MUST be "address" or signature verification fails on-chain.
 */
export function buildUnjailSignDoc(
  operatorAddress: string,
  chainId: string,
  online: OnlineTxParams,
): StdSignDoc {
  const aminoMsg: AminoMsg = {
    type: "cosmos-sdk/MsgUnjail",
    value: { address: valoperAddress(operatorAddress) },
  };
  return makeSignDoc([aminoMsg], online.fee, chainId, "", online.accountNumber, online.sequence);
}

/** Broadcastable proto-JSON Tx from the wallet's signed unjail doc. */
export function assembleUnjailTxJson(
  operatorAddress: string,
  response: GentxSignResponse,
): string {
  // proto-JSON uses the proto field name (validator_addr), NOT the amino
  // field name the sign doc carries — jsonpb ignores Go struct json tags
  return assembleSignedTxJson(
    [{ "@type": UNJAIL_TYPE_URL, validator_addr: valoperAddress(operatorAddress) }],
    response,
  );
}
