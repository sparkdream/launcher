import {
  rawSecp256k1PubkeyToRawAddress,
  serializeSignDoc,
  type StdSignDoc,
} from "@cosmjs/amino";
import { Secp256k1, Secp256k1Signature, sha256 } from "@cosmjs/crypto";
import { fromBase64, fromBech32, toBech32 } from "@cosmjs/encoding";

/** Keplr's amino signature shape (signArbitrary / signAmino). */
export interface AminoSignature {
  pub_key: { type: string; value: string };
  signature: string;
}

export type AminoVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify an amino signature over a StdSignDoc: the pubkey must derive the
 * expected signer address, and the secp256k1 signature must be valid over
 * the doc's canonical sign bytes. Shared by session auth (ADR-36) and the
 * gentx flow.
 */
export async function verifyAminoSignature(
  doc: StdSignDoc,
  signer: string,
  signature: AminoSignature,
): Promise<AminoVerifyResult> {
  const pubkeyBytes = fromBase64(signature.pub_key.value);
  const { prefix } = fromBech32(signer);
  const derived = toBech32(prefix, rawSecp256k1PubkeyToRawAddress(pubkeyBytes));
  if (derived !== signer) {
    return { ok: false, reason: `signer ${derived} is not ${signer}` };
  }
  const valid = await Secp256k1.verifySignature(
    Secp256k1Signature.fromFixedLength(fromBase64(signature.signature)),
    sha256(serializeSignDoc(doc)),
    pubkeyBytes,
  );
  return valid ? { ok: true } : { ok: false, reason: "secp256k1 signature invalid" };
}
