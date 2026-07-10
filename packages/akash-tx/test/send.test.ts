import { describe, expect, it } from "vitest";
import { launcherRegistry, sendMsg, toEncodeObject, TypeUrl } from "../src/index.js";

const FROM = "akash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const TO = "akash1j7yznr6njvz0sjnw5dalngtck8teyr8y3euj3w";

describe("bank MsgSend (launch fee)", () => {
  it("stores proto-JSON and converts to the cosmjs camelCase shape", () => {
    const msg = sendMsg(FROM, TO, { denom: "uact", amount: "123456" });
    expect(msg.typeUrl).toBe(TypeUrl.Send);
    expect(msg.value).toEqual({
      from_address: FROM,
      to_address: TO,
      amount: [{ denom: "uact", amount: "123456" }],
    });
    const enc = toEncodeObject(msg);
    expect(enc.value).toEqual({
      fromAddress: FROM,
      toAddress: TO,
      amount: [{ denom: "uact", amount: "123456" }],
    });
  });

  it("encodes through launcherRegistry (defaultRegistryTypes carries bank)", () => {
    const registry = launcherRegistry();
    const any = registry.encodeAsAny(toEncodeObject(sendMsg(FROM, TO, { denom: "uact", amount: "1" })));
    expect(any.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    // decode back through the registry to prove the plain shape encoded fully
    const decoded: any = registry.decode({ typeUrl: any.typeUrl, value: any.value });
    expect(decoded.fromAddress).toBe(FROM);
    expect(decoded.toAddress).toBe(TO);
    expect(decoded.amount).toEqual([{ denom: "uact", amount: "1" }]);
  });
});
