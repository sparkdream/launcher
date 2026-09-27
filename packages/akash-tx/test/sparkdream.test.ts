import { decodeTxRaw } from "@cosmjs/proto-signing";
import { fromBase64, toBase64 } from "@cosmjs/encoding";
import { describe, expect, it } from "vitest";
import { encodedToEncodeObjects, fillSigner, sparkdreamSigning, WALLET_SIGNER } from "../src/sparkdream.js";

const ME = "sprkdrm1jct5shlz26j2qgdeyzj2nwe5e79djprhcgpwrc";
const POLICY = "sprkdrm1f936xhjtcm2ceexu25hze36mqxzpn0krz9ls6g8l09m6nf9c2qvq0hx8se";

// What the conductor's wallet-signed pauses hand the browser: the messages
// encoded by the chain binary's own JSON parser (`sparkdreamd tx encode` of a
// tx JSON holding these messages; regenerate if they change), with the signer
// placeholder in their address fields: register peer, peer policy, commons
// proposal (nested MsgResumePeer), vote, execute, bank send.
const CHAIN_ENCODED_TX = "CtQGCpQBCikvc3BhcmtkcmVhbS5mZWRlcmF0aW9uLnYxLk1zZ1JlZ2lzdGVyUGVlchJnCgg8c2lnbmVyPhIYbWFzdG9kb24ucGhvZW5peC5leGFtcGxlGhhtYXN0b2Rvbi5waG9lbml4LmV4YW1wbGUgAjIlcmVnaXN0ZXJlZCBieSB0aGUgU3BhcmtEcmVhbSBsYXVuY2hlcgqIAQotL3NwYXJrZHJlYW0uZmVkZXJhdGlvbi52MS5Nc2dVcGRhdGVQZWVyUG9saWN5ElcKCDxzaWduZXI+EhhtYXN0b2Rvbi5waG9lbml4LmV4YW1wbGUaMQoYbWFzdG9kb24ucGhvZW5peC5leGFtcGxlGglibG9nX3Bvc3QaCmJsb2dfcmVwbHkKugIKKC9zcGFya2RyZWFtLmNvbW1vbnMudjEuTXNnU3VibWl0UHJvcG9zYWwSjQIKCDxzaWduZXI+EkJzcHJrZHJtMWY5MzZ4aGp0Y20yY2VleHUyNWh6ZTM2bXF4enBuMGtyejlsczZnOGwwOW02bmY5YzJxdnEwaHg4c2UaiQEKJy9zcGFya2RyZWFtLmZlZGVyYXRpb24udjEuTXNnUmVzdW1lUGVlchJeCkJzcHJrZHJtMWY5MzZ4aGp0Y20yY2VleHUyNWh6ZTM2bXF4enBuMGtyejlsczZnOGwwOW02bmY5YzJxdnEwaHg4c2USGG1hc3RvZG9uLnBob2VuaXguZXhhbXBsZSIxQWN0aXZhdGUgZmVkZXJhdGlvbiBwZWVyIG1hc3RvZG9uLnBob2VuaXguZXhhbXBsZQo4CiYvc3BhcmtkcmVhbS5jb21tb25zLnYxLk1zZ1ZvdGVQcm9wb3NhbBIOCgg8c2lnbmVyPhADGAEKOQopL3NwYXJrZHJlYW0uY29tbW9ucy52MS5Nc2dFeGVjdXRlUHJvcG9zYWwSDAoIPHNpZ25lcj4QAwp+ChwvY29zbW9zLmJhbmsudjFiZXRhMS5Nc2dTZW5kEl4KCDxzaWduZXI+Ei5zcHJrZHJtMWN0azZxbnNnNXJmN2RkdXB2a3h0aDhxNmg3ZDQ5aDgwdmNqZ2cwGiIKFHVzcGFyei5zcGFya2RyZWFtZGV2EgoxMDAwNDAwMDAwEgISAA==";

const encoded = decodeTxRaw(fromBase64(CHAIN_ENCODED_TX)).body.messages.map((m) => ({
  typeUrl: m.typeUrl,
  value: toBase64(m.value),
}));

describe("wallet-signed Spark Dream messages", () => {
  it("decodes the chain's encoding with enums intact and the wallet's address filled in", () => {
    const [register, policy, submit, vote, execute, send] = encodedToEncodeObjects(encoded, ME);
    // the enum the JSON-side conversion lost ("peer type must be specified")
    expect(register!.value).toMatchObject({ authority: ME, peerId: "mastodon.phoenix.example", type: 2 });
    expect(policy!.value).toMatchObject({ authority: ME, policy: { inboundContentTypes: ["blog_post", "blog_reply"] } });
    expect(submit!.value).toMatchObject({ proposer: ME, policyAddress: POLICY });
    expect(vote!.value).toMatchObject({ voter: ME, proposalId: 3n, option: 1 });
    expect(execute!.value).toMatchObject({ executor: ME, proposalId: 3n });
    expect(send!.value).toMatchObject({ fromAddress: ME, amount: [{ denom: "usparz.sparkdreamdev", amount: "1000400000" }] });
    expect(JSON.stringify(encodedToEncodeObjects(encoded, ME), (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(WALLET_SIGNER);
  });

  it("re-encodes to exactly the chain's bytes once the address is filled in", () => {
    const { registry } = sparkdreamSigning();
    // with the placeholder kept, decode + encode round-trips byte for byte
    for (const [i, eo] of encodedToEncodeObjects(encoded, WALLET_SIGNER).entries()) {
      expect(toBase64(registry.encode(eo))).toBe(encoded[i]!.value);
    }
  });

  it("leaves a proposal's nested message bytes alone, and renders them as amino JSON a Ledger can read", () => {
    const { aminoTypes, registry } = sparkdreamSigning();
    const submit = encodedToEncodeObjects(encoded, ME)[2]!;
    const inner = submit.value.messages[0];
    expect(inner.value).toBeInstanceOf(Uint8Array);
    expect(registry.decode(inner)).toMatchObject({ authority: POLICY, peerId: "mastodon.phoenix.example" });
    const amino = aminoTypes.toAmino(submit);
    expect(amino.type).toBe("sparkdream/x/commons/MsgSubmitProposal");
    expect(amino.value.messages[0]).toMatchObject({ type: "sparkdream/x/federation/MsgResumePeer", value: { peer_id: "mastodon.phoenix.example" } });
    // every message the pauses send has an amino form (Keplr + Ledger)
    for (const eo of encodedToEncodeObjects(encoded, ME)) expect(() => aminoTypes.toAmino(eo)).not.toThrow();
  });

  it("fills only strings: bytes and big integers pass through", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(fillSigner({ a: WALLET_SIGNER, b: bytes, c: 5n, d: [WALLET_SIGNER] }, ME)).toEqual({ a: ME, b: bytes, c: 5n, d: [ME] });
  });

  it("keeps a Timestamp a Date, so a session grant converts to amino JSON", () => {
    // a session grant's expiration decodes to a Date; rebuilding it as a
    // plain object left {} and broke amino conversion ("getTime is not a function")
    const { registry, aminoTypes } = sparkdreamSigning();
    const typeUrl = "/sparkdream.session.v1.MsgCreateSession";
    const expiration = new Date("2026-12-01T00:00:00Z");
    const value = registry.encode({
      typeUrl,
      value: { granter: WALLET_SIGNER, grantee: POLICY, allowedMsgTypes: ["/sparkdream.federation.v1.MsgVerifyContent"],
        spendLimit: { denom: "uspark", amount: "25000000" }, expiration, maxExecCount: 10000n },
    });
    const [eo] = encodedToEncodeObjects([{ typeUrl, value: toBase64(value) }], ME);
    expect((eo!.value as any).granter).toBe(ME);
    expect((eo!.value as any).expiration).toEqual(expiration);
    expect(() => aminoTypes.toAmino(eo!)).not.toThrow();
    expect(fillSigner({ at: expiration }, ME).at).toBe(expiration);
  });

  it("refuses a message type it does not know", () => {
    expect(() => encodedToEncodeObjects([{ typeUrl: "/nope.v1.MsgNothing", value: "" }], ME)).toThrow(/cannot sign/);
  });
});
