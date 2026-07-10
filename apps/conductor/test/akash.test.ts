import path from "node:path";
import { describe, expect, it } from "vitest";
import { testnetSpec } from "@sparkdream/launch-spec";
import { selectProvider, type Bid } from "../src/akash/policy.js";
import { accountDepositMsg, createDeploymentMsg, createLeaseMsg, TypeUrl } from "../src/akash/messages.js";
import { loadSdl, sdlArtifacts, sortedJson } from "../src/akash/sdl-groups.js";
import { pollBids } from "../src/akash/client.js";
import { vendorDir } from "../src/vendor.js";
import { fakeProviders, FakeAkashApi } from "./fakes.js";

function bid(provider: string, amount: string, state = "open"): Bid {
  return {
    bid: {
      id: { owner: "akash1owner", dseq: "100", gseq: 1, oseq: 1, provider },
      state,
      price: { denom: "uact", amount },
    },
  };
}

const basePolicy = testnetSpec().providers.policy;

describe("policy engine (§6)", () => {
  it("picks the cheapest audited bid and explains rejections", () => {
    const providers = fakeProviders();
    providers.get("akash1provider2")!.isAudited = false;
    providers.get("akash1provider3")!.uptime7d = 0.5;
    const decision = selectProvider(
      [bid("akash1provider1", "300"), bid("akash1provider2", "100"), bid("akash1provider3", "200")],
      { policy: basePolicy, chosenProviders: new Set(), providers },
    );
    expect(decision.chosen?.bid.id.provider).toBe("akash1provider1");
    expect(decision.rejected).toEqual([
      { provider: "akash1provider2", reason: "not audited" },
      { provider: "akash1provider3", reason: expect.stringContaining("uptime") },
    ]);
  });

  it("enforces strict anti-affinity", () => {
    const decision = selectProvider(
      [bid("akash1provider1", "100"), bid("akash1provider2", "200")],
      {
        policy: basePolicy,
        chosenProviders: new Set(["akash1provider1"]),
        providers: fakeProviders(),
      },
    );
    expect(decision.chosen?.bid.id.provider).toBe("akash1provider2");
    expect(decision.rejected[0]!.reason).toContain("anti-affinity");
  });

  it("avoid list is a hard filter, even for a preferred or cheapest provider", () => {
    const decision = selectProvider(
      [bid("akash1provider1", "100"), bid("akash1provider2", "200")],
      {
        policy: { ...basePolicy, preference: ["akash1provider1"] },
        chosenProviders: new Set(),
        avoidProviders: new Set(["akash1provider1"]),
        providers: fakeProviders(),
      },
    );
    expect(decision.chosen?.bid.id.provider).toBe("akash1provider2");
    expect(decision.rejected).toEqual([
      { provider: "akash1provider1", reason: "on the avoid list" },
    ]);
  });

  it("preference list beats price", () => {
    const decision = selectProvider(
      [bid("akash1provider1", "100"), bid("akash1provider4", "900")],
      {
        policy: { ...basePolicy, maxPriceMultiplier: 10, preference: ["akash1provider4"] },
        chosenProviders: new Set(),
        providers: fakeProviders(),
      },
    );
    expect(decision.chosen?.bid.id.provider).toBe("akash1provider4");
  });

  it("rejects providers without the required storage class", () => {
    const providers = fakeProviders();
    providers.get("akash1provider1")!.storageClasses = [];
    const decision = selectProvider([bid("akash1provider1", "100")], {
      policy: basePolicy,
      chosenProviders: new Set(),
      requiredStorageClass: "beta3",
      providers,
    });
    expect(decision.chosen).toBeNull();
    expect(decision.rejected[0]!.reason).toBe("no beta3 persistent storage");
  });

  it("trusts the bid's resources_offer for storage class when metadata lacks it", () => {
    const providers = fakeProviders();
    providers.get("akash1provider1")!.storageClasses = []; // stale Console metadata
    const offering: Bid = {
      bid: {
        ...bid("akash1provider1", "100").bid,
        resources_offer: [
          { resources: { storage: [{ attributes: [{ key: "class", value: "beta3" }, { key: "persistent", value: "true" }] }] } },
        ],
      },
    };
    const decision = selectProvider([offering], {
      policy: basePolicy,
      chosenProviders: new Set(),
      requiredStorageClass: "beta3",
      providers,
    });
    expect(decision.chosen?.bid.id.provider).toBe("akash1provider1");
  });

  it("price ceiling is relative to the median", () => {
    const decision = selectProvider(
      [bid("akash1provider1", "100"), bid("akash1provider2", "110"), bid("akash1provider3", "9000")],
      { policy: basePolicy, chosenProviders: new Set(), providers: fakeProviders() },
    );
    expect(decision.chosen?.bid.id.provider).toBe("akash1provider1");
    expect(decision.rejected[0]!.reason).toContain("above 2x median");
  });
});

describe("tx messages", () => {
  it("shapes match the console-air port (§9 versions)", () => {
    const dep = createDeploymentMsg({
      owner: "akash1owner",
      dseq: "42",
      groups: [{ name: "dcloud" }],
      hash: new Uint8Array([1, 2, 3]),
      deposit: { denom: "uact", amount: "5000000" },
    });
    expect(dep.typeUrl).toBe("/akash.deployment.v1beta4.MsgCreateDeployment");
    expect(dep.value.id).toEqual({ owner: "akash1owner", dseq: "42" });
    expect(dep.value.hash).toBe(Buffer.from([1, 2, 3]).toString("base64"));

    const lease = createLeaseMsg({ owner: "o", dseq: "42", gseq: 1, oseq: 1, provider: "p" });
    expect(lease.typeUrl).toBe("/akash.market.v1beta5.MsgCreateLease");

    const deposit = accountDepositMsg("akash1owner", "42", { denom: "uact", amount: "1" });
    expect(deposit.typeUrl).toBe(TypeUrl.AccountDeposit);
    expect(deposit.value.signer).toBe("akash1owner");
    expect(deposit.value.id).toEqual({ scope: 1, xid: "akash1owner/42" });
    expect(deposit.value.deposit).toEqual({
      amount: { denom: "uact", amount: "1" },
      sources: [2, 1], // grant, balance — console-air order
    });

    expect(dep.value.deposit).toEqual({
      amount: { denom: "uact", amount: "5000000" },
      sources: [2, 1],
    });
  });
});

describe("SDL artifacts", () => {
  it("extracts groups/manifest/hash from the vendored sentry SDL", () => {
    const sdl = loadSdl(path.join(vendorDir(), "network", "testnet", "sentry.sdl.yaml"));
    const artifacts = sdlArtifacts(sdl);
    expect(artifacts.pricingDenom).toBe("uact");
    expect(artifacts.requiredStorageClass).toBe("beta3");
    expect(artifacts.groups).toHaveLength(1);
    expect(artifacts.manifest[0].services[0].name).toBe("sparkdreamd");
    expect(artifacts.hash).toHaveLength(32);
    // deterministic: same SDL → same hash
    expect(Buffer.from(sdlArtifacts(sdl).hash)).toEqual(Buffer.from(artifacts.hash));
  });

  it("sortedJson is key-order independent", () => {
    expect(sortedJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("bid polling", () => {
  it("keeps collecting until no new provider bids for settleRounds polls", async () => {
    // bids trickle in: p1, then p2, then the flow dries up
    const rounds = [["p1"], ["p1", "p2"], ["p1", "p2"], ["p1", "p2"]];
    let call = 0;
    const api = {
      listBids: async () => (rounds[Math.min(call++, rounds.length - 1)] ?? []).map((p) => bid(p, "100")),
    } as any;
    const bids = await pollBids(api, "akash1owner", "42", {
      minBids: 1,
      settleRounds: 2,
      sleep: async () => {},
    });
    // didn't stop at the first bid: waited out two stable rounds and kept both
    expect(call).toBe(4);
    expect(bids).toHaveLength(2);
  });

  it("returns early once minBids is reached", async () => {
    const api = new FakeAkashApi();
    let polls = 0;
    const bids = await pollBids(api, "akash1owner", "42", {
      minBids: 2,
      sleep: async () => {},
      onPoll: () => polls++,
    });
    expect(polls).toBe(1);
    expect(bids.length).toBeGreaterThanOrEqual(2);
  });
});
