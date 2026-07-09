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
 * Verify before accepting into genesis (§5 step 3b): the signature must be
 * valid over the doc the wallet actually signed, the signer must be the
 * declared operator, and the signed doc must not have drifted from ours in
 * any consensus-relevant way.
 */
export async function verifyGentxSignature(
  expected: StdSignDoc,
  response: GentxSignResponse,
  operatorAddress: string,
): Promise<GentxVerifyResult> {
  const { signed, signature } = response;
  if (signed.chain_id !== expected.chain_id) return { ok: false, reason: "chain_id mismatch" };
  if (signed.account_number !== "0") return { ok: false, reason: "account_number must be 0" };
  if (signed.sequence !== "0") return { ok: false, reason: "sequence must be 0" };
  if (JSON.stringify(signed.msgs) !== JSON.stringify(expected.msgs)) {
    return { ok: false, reason: "msgs differ from the conductor-built sign doc" };
  }
  // memo and fee are copied from the signed doc into the genesis-hashed
  // gentx (assembleGentxJson) — the wallet may adjust gas, but memo and fee
  // amount must not drift (a fee the account can't cover fails at InitChain)
  if (signed.memo !== expected.memo) {
    return { ok: false, reason: "memo differs from the conductor-built sign doc" };
  }
  if (JSON.stringify(signed.fee.amount) !== JSON.stringify(expected.fee.amount)) {
    return { ok: false, reason: "fee amount differs from the conductor-built sign doc" };
  }

  return verifyAminoSignature(signed, operatorAddress, signature);
}

/**
 * Assemble the gentx file (proto-JSON Tx, the format `collect-gentxs`
 * reads). Message fields come from the same source as the sign doc; fee and
 * memo come from the doc the wallet signed (Keplr may adjust gas).
 */
export function assembleGentxJson(input: GentxInputs, response: GentxSignResponse): string {
  const msg = createValidatorMsg(input).value;
  const commission = commissionFlags(input.spec); // protojson decimal form
  const signed = response.signed;
  return JSON.stringify(
    {
      body: {
        messages: [
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
            sequence: "0",
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
