import { describe, expect, it } from "vitest";
import { launcherRegistry, mintActMsg, toEncodeObject, TypeUrl } from "../src/index.js";
import { MsgMintACT } from "@sparkdreamnft/sparkdreamjs/akash/bme/v1/msgs.js";

const OWNER = "akash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

describe("MsgMintACT codec", () => {
  it("round-trips encode/decode", () => {
    const msg = MsgMintACT.fromPartial({
      owner: OWNER,
      to: OWNER,
      coinsToBurn: { denom: "uakt", amount: "5000000" },
    });
    const bytes = MsgMintACT.encode(msg).finish();
    expect(MsgMintACT.decode(bytes)).toEqual(msg);
  });

  it("matches the akash.bme.v1 wire format (field numbers 1/2/3)", () => {
    const bytes = MsgMintACT.encode(
      MsgMintACT.fromPartial({ owner: "a", to: "b", coinsToBurn: { denom: "uakt", amount: "1" } }),
    ).finish();
    // owner: tag 0x0a (field 1, wire type 2); to: 0x12; coins_to_burn: 0x1a
    expect(bytes[0]).toBe(0x0a);
    expect(bytes[2]).toBe(0x61); // "a"
    expect(bytes[3]).toBe(0x12);
    expect(bytes[5]).toBe(0x62); // "b"
    expect(bytes[6]).toBe(0x1a);
  });

  it("mintActMsg sets to === owner and snake_case coin field", () => {
    const msg = mintActMsg(OWNER, { denom: "uakt", amount: "1000000" });
    expect(msg.typeUrl).toBe(TypeUrl.MintAct);
    expect(msg.value).toEqual({
      owner: OWNER,
      to: OWNER,
      coins_to_burn: { denom: "uakt", amount: "1000000" },
    });
  });

  it("toEncodeObject converts the stored proto-JSON shape", () => {
    const enc = toEncodeObject(mintActMsg(OWNER, { denom: "uakt", amount: "1000000" }));
    expect(enc.typeUrl).toBe("/akash.bme.v1.MsgMintACT");
    expect(enc.value).toEqual({
      owner: OWNER,
      to: OWNER,
      coinsToBurn: { denom: "uakt", amount: "1000000" },
    });
  });

  it("is registered in launcherRegistry and encodes through the registry", () => {
    const registry = launcherRegistry();
    const enc = toEncodeObject(mintActMsg(OWNER, { denom: "uakt", amount: "1000000" }));
    const any = registry.encodeAsAny(enc);
    expect(any.typeUrl).toBe("/akash.bme.v1.MsgMintACT");
    expect(MsgMintACT.decode(any.value)).toEqual(enc.value);
  });
});
