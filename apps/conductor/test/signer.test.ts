import path from "node:path";
import { describe, expect, it } from "vitest";
import { MsgCreateDeployment } from "@sparkdreamnft/sparkdreamjs/akash/deployment/v1beta4/deploymentmsg.js";
import {
  accountDepositMsg,
  closeDeploymentMsg,
  createCertificateMsg,
  createDeploymentMsg,
  createLeaseMsg,
  TypeUrl,
} from "../src/akash/messages.js";
import { loadSdl, sdlArtifacts } from "../src/akash/sdl-groups.js";
import { launcherRegistry, toEncodeObject, CliSigner } from "../src/signer.js";
import { vendorDir } from "../src/vendor.js";

// throwaway test vector (cosmjs docs mnemonic) — never funded
const TEST_MNEMONIC =
  "surround miss nominee dream gap cross assault thank captain prosper drop duty group candy wealth weather scale put";

describe("signer conversion (stored JSON → proto)", () => {
  it("encodes every launch-pipeline message type via the registry", () => {
    const registry = launcherRegistry();
    const sdl = loadSdl(path.join(vendorDir(), "network", "testnet", "validator.sdl.yaml"));
    const artifacts = sdlArtifacts(sdl);

    const msgs = [
      createCertificateMsg("akash1owner", "CERT-PEM", "PUB-PEM"),
      createDeploymentMsg({
        owner: "akash1owner",
        dseq: "1234",
        groups: artifacts.groups,
        hash: artifacts.hash,
        deposit: { denom: "uact", amount: "5000000" },
      }),
      createLeaseMsg({ owner: "akash1owner", dseq: "1234", gseq: 1, oseq: 1, provider: "akash1p" }),
      closeDeploymentMsg("akash1owner", "1234"),
    ];

    for (const msg of msgs) {
      const encodeObject = toEncodeObject(msg);
      const any = registry.encodeAsAny(encodeObject);
      expect(any.typeUrl).toBe(msg.typeUrl);
      expect(any.value.length).toBeGreaterThan(0);
    }
  });

  it("deployment groups survive the conversion round-trip", () => {
    const sdl = loadSdl(path.join(vendorDir(), "network", "testnet", "sentry.sdl.yaml"));
    const artifacts = sdlArtifacts(sdl);
    const msg = createDeploymentMsg({
      owner: "akash1owner",
      dseq: "42",
      groups: artifacts.groups,
      hash: artifacts.hash,
      deposit: { denom: "uact", amount: "5000000" },
    });
    const encoded = toEncodeObject(msg);
    const bytes = MsgCreateDeployment.encode(encoded.value).finish();
    const decoded = MsgCreateDeployment.decode(bytes);
    expect(decoded.id!.dseq).toBe(42n);
    expect(decoded.groups).toHaveLength(1);
    const resource = decoded.groups[0]!.resources[0]!;
    // raw vendored sentry SDL declares cpu:1 (spec resources apply in render-sdls)
    expect(new TextDecoder().decode(resource.resource!.cpu!.units!.val)).toBe("1000");
    const persistent = resource.resource!.storage.find((s) => s.name === "data")!;
    expect(persistent.attributes.some((a) => a.key === "persistent" && a.value === "true")).toBe(true);
    // sentry exposes SSH + P2P + RPC globally, none on port 80 → all RANDOM_PORT
    expect(resource.resource!.endpoints).toHaveLength(3);
    expect(resource.resource!.endpoints.every((e) => e.kind === 1)).toBe(true);
    expect(decoded.hash).toEqual(new Uint8Array(artifacts.hash));
  });

  it("rejects the unresolved escrow top-up type loudly", () => {
    const deposit = accountDepositMsg("akash1owner", "42", { denom: "uact", amount: "1" });
    expect(() => toEncodeObject(deposit)).toThrow(/no encoder/);
    expect(deposit.typeUrl).toBe(TypeUrl.AccountDeposit);
  });
});

describe("CliSigner", () => {
  it("derives a deterministic owner address offline", async () => {
    const signer = new CliSigner({
      mnemonic: TEST_MNEMONIC,
      rpcEndpoint: "http://127.0.0.1:1", // never contacted for address derivation
      gasPrice: "0.025uact",
    });
    const address = await signer.ownerAddress();
    expect(address).toMatch(/^akash1[a-z0-9]{38}$/);
    // deterministic: same mnemonic → same address
    expect(await signer.ownerAddress()).toBe(address);
  });
});
