import { makeSignDoc, type AminoMsg, type StdFee, type StdSignDoc } from "@cosmjs/amino";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { Decimal } from "@cosmjs/math";
import { encodePubkey } from "@cosmjs/proto-signing";
import { AminoTypes, createDefaultAminoConverters } from "@cosmjs/stargate";
import type { LaunchSpec } from "@sparkdream/launch-spec";
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
        moniker: `${input.spec.network.name}-val-${input.valIndex}`,
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

export function buildGentxSignDoc(input: GentxInputs): StdSignDoc {
  const aminoMsg: AminoMsg = aminoTypes.toAmino(createValidatorMsg(input));
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
  const aminoMsg: AminoMsg = aminoTypes.toAmino(createValidatorMsg(input));
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
  if (JSON.stringify(signed.msgs) !== JSON.stringify(expected.msgs)) {
    return { ok: false, reason: "msgs differ from the conductor-built sign doc" };
  }
  if (signed.memo !== expected.memo) {
    return { ok: false, reason: "memo differs from the conductor-built sign doc" };
  }
  if (JSON.stringify(signed.fee.amount) !== JSON.stringify(expected.fee.amount)) {
    return { ok: false, reason: "fee amount differs from the conductor-built sign doc" };
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
