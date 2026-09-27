import { fromBase64 } from "@cosmjs/encoding";
import { Registry, type EncodeObject } from "@cosmjs/proto-signing";
import { AminoTypes, createDefaultAminoConverters, defaultRegistryTypes, type AminoConverters } from "@cosmjs/stargate";
import { sparkdreamAminoConverters, sparkdreamProtoRegistry } from "@sparkdreamnft/sparkdreamjs/sparkdream/client.js";
import { configureNestedAminoConverter } from "@sparkdreamnft/sparkdreamjs/nested-amino.js";

/**
 * Signing a Spark Dream chain's messages in a browser wallet (the launcher's
 * wallet-signed pauses). The conductor encodes each message with the chain's
 * own binary (enums, nested messages and all, exactly as the chain parses
 * them) and leaves WALLET_SIGNER where the signer's address belongs; this
 * decodes them with the chain's registry, puts the wallet's address in, and
 * hands back the EncodeObjects a SigningStargateClient signs, in direct mode
 * or amino-JSON (Keplr with a Ledger).
 */

/** Placeholder the conductor writes where the signer's address belongs. */
export const WALLET_SIGNER = "<signer>";

export interface SparkdreamSigning {
  registry: Registry;
  aminoTypes: AminoTypes;
}

let cached: SparkdreamSigning | undefined;

/** The registry + amino types for Spark Dream chains (SDK modules included). */
export function sparkdreamSigning(): SparkdreamSigning {
  if (cached) return cached;
  const registry = new Registry([...defaultRegistryTypes, ...(sparkdreamProtoRegistry as any)]);
  const converters: AminoConverters = { ...createDefaultAminoConverters(), ...(sparkdreamAminoConverters as any) };
  const aminoTypes = new AminoTypes(converters);
  // commons proposals nest messages in Any: their converter renders those
  // through this registry, as the chain's aminojson handler does
  configureNestedAminoConverter({ registry: registry as any, aminoTypes });
  cached = { registry, aminoTypes };
  return cached;
}

/** Replace every WALLET_SIGNER string in `msgs` with `address`. Only arrays
 *  and plain objects are rebuilt: anything else (bytes, big integers, the
 *  Date a Timestamp decodes to) passes through as it is, since rebuilding a
 *  Date from its own properties leaves an empty object. */
export function fillSigner<T>(msgs: T, address: string): T {
  const walk = (v: unknown): unknown => {
    if (v === WALLET_SIGNER) return address;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(msgs) as T;
}

/**
 * Chain-encoded messages (typeUrl + base64 value, WALLET_SIGNER standing in
 * for the signer) → EncodeObjects signed by `address`.
 */
export function encodedToEncodeObjects(
  encoded: Array<{ typeUrl: string; value: string }>,
  address: string,
): EncodeObject[] {
  const { registry } = sparkdreamSigning();
  return encoded.map(({ typeUrl, value }) => {
    if (!registry.lookupType(typeUrl)) throw new Error(`this launcher cannot sign ${typeUrl}`);
    const decoded = registry.decode({ typeUrl, value: fromBase64(value) });
    return { typeUrl, value: fillSigner(decoded, address) };
  });
}
