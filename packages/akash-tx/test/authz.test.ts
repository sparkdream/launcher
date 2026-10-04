import { describe, expect, it } from "vitest";
import { GenericAuthorization } from "cosmjs-types/cosmos/authz/v1beta1/authz";
import { AllowedMsgAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/feegrant";
import {
  launcherRegistry,
  toEncodeObject,
  TypeUrl,
  UNATTENDED_MSG_TYPES,
  unattendedGrantMsgs,
  unattendedRevokeMsgs,
} from "../src/index.js";

const OWNER = "akash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvwq8zk";
const GRANTEE = "akash1qyqszqgpqyqszqgpqyqszqgpqyqszqgpe6ckpj";

describe("unattended recovery msgs", () => {
  const registry = launcherRegistry();
  const roundTrip = (m: { typeUrl: string; value: Record<string, unknown> }) => {
    const enc = toEncodeObject(m);
    return registry.decode({ typeUrl: enc.typeUrl, value: registry.encode(enc) }) as any;
  };

  it("grants exactly the four deployment/lease msg types, expiring", () => {
    const msgs = unattendedGrantMsgs(OWNER, GRANTEE, "2026-11-02T00:00:00Z", { denom: "uact", amount: "5000000" });
    const grants = msgs.filter((m) => m.typeUrl === TypeUrl.Grant).map(roundTrip);
    expect(grants.map((g) => GenericAuthorization.decode(g.grant.authorization.value).msg)).toEqual([...UNATTENDED_MSG_TYPES]);
    expect(grants.every((g) => g.grant.expiration.seconds === BigInt(Date.parse("2026-11-02T00:00:00Z") / 1000))).toBe(true);
    expect(UNATTENDED_MSG_TYPES).not.toContain(TypeUrl.Send);
    expect(UNATTENDED_MSG_TYPES).not.toContain(TypeUrl.AccountDeposit);
  });

  it("caps the fee allowance and limits it to MsgExec", () => {
    const [allowance] = unattendedGrantMsgs(OWNER, GRANTEE, "2026-11-02T00:00:00Z", { denom: "uact", amount: "5000000" })
      .filter((m) => m.typeUrl === TypeUrl.GrantAllowance)
      .map(roundTrip);
    expect(allowance.allowance.typeUrl).toBe("/cosmos.feegrant.v1beta1.AllowedMsgAllowance");
    const inner = AllowedMsgAllowance.decode(allowance.allowance.value);
    expect(inner.allowedMessages).toEqual([TypeUrl.Exec]);
    expect(inner.allowance!.typeUrl).toBe("/cosmos.feegrant.v1beta1.BasicAllowance");
  });

  it("wraps launcher msgs in MsgExec, and revokes all of it", () => {
    const exec = roundTrip({
      typeUrl: TypeUrl.Exec,
      value: { grantee: GRANTEE, msgs: [{ typeUrl: TypeUrl.CloseDeployment, value: { id: { owner: OWNER, dseq: "42" } } }] },
    });
    expect(exec.grantee).toBe(GRANTEE);
    expect(registry.decode(exec.msgs[0])).toMatchObject({ id: { owner: OWNER, dseq: 42n } });
    const revokes = unattendedRevokeMsgs(OWNER, GRANTEE).map(roundTrip);
    expect(revokes).toHaveLength(UNATTENDED_MSG_TYPES.length + 1);
  });
});
