import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { checkSpec, testnetSpecInput } from "@sparkdream/launch-spec";
import { renderComponentSdl } from "../src/render-component-sdl.js";
import { descriptor, imageUploadsSecretProblem, setServiceEnv } from "../src/components/index.js";
import { writeScannerOperatorAddress } from "../src/components/scanner-secrets.js";

/**
 * Member image uploads: the frontend stores a picture in its own bucket only
 * after the fleet's scanner has cleared it, so the two share a pre-check
 * token the launcher makes.
 */

const UPLOADS = {
  endpoint: "https://endpoint.storage.example",
  bucket: "phoenix-images",
  publicBase: "https://phoenix-images.storage.example/",
  accessKeyId: "AKIDPHOENIX",
  secretRef: "secret:s3-images",
};

function specInput(opts: { uploads?: Record<string, unknown>; scanner?: boolean } = {}): unknown {
  return testnetSpecInput({
    topology: {
      validators: { count: 1 },
      sentries: { count: 1 },
      components: {
        explorer: { enabled: false },
        frontend: { enabled: true, domain: "app.phoenix.example", ...(opts.uploads ? { imageUploads: opts.uploads } : {}) },
        hub: { enabled: false },
        ...(opts.scanner === false ? {} : { scanner: { enabled: true, domain: "scan.phoenix.example" } }),
      },
      publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" },
      headscale: { domain: "hs.phoenix.example" },
    },
  });
}

function secrets(withS3 = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-images-"));
  if (withS3) fs.writeFileSync(path.join(dir, "s3-images"), "s3-secret-value\n", { mode: 0o600 });
  writeScannerOperatorAddress(dir, "sprkdrm1j4mqhgrdnjnxvlucjpq9eceyfuyek479e7watv");
  return dir;
}

function sdlOf(input: unknown, key: "frontend" | "scanner", secretsDir: string): any {
  const check = checkSpec(input);
  expect(check.errors).toEqual([]);
  const spec = check.spec!;
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "frontend-images-sdl-")), `${key}.yaml`);
  const domain = key === "frontend" ? "app.phoenix.example" : "scan.phoenix.example";
  renderComponentSdl({ spec, component: { key, image: spec.images[key], domain }, outPath, secretsDir } as any);
  return yaml.load(fs.readFileSync(outPath, "utf8")) as any;
}

function env(input: unknown, key: "frontend" | "scanner", secretsDir: string): string[] {
  return sdlOf(input, key, secretsDir).services[key].env as string[];
}

const value = (e: string[], name: string) => e.find((x) => x.startsWith(`${name}=`))?.slice(name.length + 1);

describe("frontend image uploads", () => {
  it("gives the frontend its bucket and the scanner pre-check, and the scanner the same token", () => {
    const dir = secrets();
    const input = specInput({ uploads: UPLOADS });
    const fe = env(input, "frontend", dir);
    expect(fe).toContain("IMAGE_S3_ENDPOINT=https://endpoint.storage.example");
    expect(fe).toContain("IMAGE_S3_REGION=us-west-2");
    expect(fe).toContain("IMAGE_S3_BUCKET=phoenix-images");
    expect(fe).toContain("IMAGE_S3_ACCESS_KEY=AKIDPHOENIX");
    expect(fe).toContain("IMAGE_S3_SECRET_KEY=s3-secret-value");
    expect(fe).toContain("IMAGE_PUBLIC_BASE=https://phoenix-images.storage.example");
    expect(fe).toContain("IMAGE_PRECHECK_URL=https://scan.phoenix.example/precheck");
    const token = value(fe, "IMAGE_PRECHECK_TOKEN")!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(value(env(input, "scanner", dir), "CS_PRECHECK_TOKEN")).toBe(token);
    // rendering again keeps the token, so the two stay in agreement
    expect(value(env(input, "frontend", dir), "IMAGE_PRECHECK_TOKEN")).toBe(token);
  });

  it("renders nothing without an imageUploads block, and the scanner opens no pre-check", () => {
    const dir = secrets();
    expect(env(specInput(), "frontend", dir).some((e) => e.startsWith("IMAGE_"))).toBe(false);
    expect(env(specInput(), "scanner", dir).some((e) => e.startsWith("CS_PRECHECK_"))).toBe(false);
  });

  it("lets a full-size file through both ingresses, and one number raises the limit everywhere", () => {
    const dir = secrets();
    const expose = (input: unknown, key: "frontend" | "scanner") => sdlOf(input, key, dir).services[key].expose[0];
    // left alone: the UI's and the scanner's own 4 MiB, which the ingress must still be told
    const plain = specInput({ uploads: UPLOADS });
    expect(expose(plain, "frontend").http_options).toEqual({ max_body_size: 4 * 1024 * 1024 });
    expect(expose(plain, "scanner").http_options).toEqual({ max_body_size: 4 * 1024 * 1024 });
    expect(value(env(plain, "frontend", dir), "IMAGE_COPY_MAX_BYTES")).toBeUndefined();
    expect(value(env(plain, "scanner", dir), "CS_PRECHECK_MAX_BYTES")).toBeUndefined();
    const raised = specInput({ uploads: { ...UPLOADS, copyMaxBytes: 10485760 } });
    expect(value(env(raised, "frontend", dir), "IMAGE_COPY_MAX_BYTES")).toBe("10485760");
    expect(value(env(raised, "scanner", dir), "CS_PRECHECK_MAX_BYTES")).toBe("10485760");
    expect(expose(raised, "frontend").http_options).toEqual({ max_body_size: 10485760 });
    expect(expose(raised, "scanner").http_options).toEqual({ max_body_size: 10485760 });
    // no uploads, no change to the ingress
    expect(expose(specInput(), "frontend").http_options).toBeUndefined();
    expect(expose(specInput(), "scanner").http_options).toBeUndefined();
    // a scanner deployed before this picks the body size up on its next upgrade
    const doc = { services: { scanner: { expose: [{ port: 8080, as: 80 }] } } } as any;
    descriptor("scanner").upgradeDoc!(doc, checkSpec(raised).spec!);
    expect(doc.services.scanner.expose[0].http_options).toEqual({ max_body_size: 10485760 });
    descriptor("scanner").upgradeDoc!(doc, checkSpec(specInput()).spec!);
    expect(doc.services.scanner.expose[0].http_options).toBeUndefined();
  });

  it("refuses uploads without the scanner that checks them", () => {
    const res = checkSpec(specInput({ uploads: UPLOADS, scanner: false }));
    expect(res.errors.map((e) => e.path)).toContain("topology.components.frontend.imageUploads");
  });

  it("refuses a secret written into the spec, a plain-http public address and unknown fields", () => {
    expect(checkSpec(specInput({ uploads: { ...UPLOADS, secretRef: "s3-secret-value" } })).ok).toBe(false);
    expect(checkSpec(specInput({ uploads: { ...UPLOADS, publicBase: "http://images.example" } })).ok).toBe(false);
    expect(checkSpec(specInput({ uploads: { ...UPLOADS, secretKey: "x" } })).ok).toBe(false);
  });

  it("stops the render when the storage secret is not there", () => {
    expect(() => env(specInput({ uploads: UPLOADS }), "frontend", secrets(false))).toThrow(/secret:s3-images is not set/);
  });
});

describe("a fleet that is already running", () => {
  const gateway = "https://gw.phoenix.example/raw/{id}";
  /** The scanner's SDL as an upgrade leaves it: env set in place. */
  function patched(doc: any, input: unknown, dir: string): string[] {
    const d = descriptor("scanner");
    expect(d.envRefresh).toBe("patch");
    setServiceEnv(doc, d.imageServices, d.chainEnv!(checkSpec(input).spec!, dir));
    return doc.services.scanner.env as string[];
  }

  it("gives a deployed scanner the token and gateway in place, and takes them away again", () => {
    const dir = secrets();
    // deployed before the spec had image uploads
    const before = env(specInput(), "scanner", dir);
    const doc = { services: { scanner: { env: [...before] } } };
    const withUploads = specInput({ uploads: { ...UPLOADS, arweave: { gateway } } });
    const after = patched(doc, withUploads, dir);
    expect(value(after, "CS_PRECHECK_TOKEN")).toBe(value(env(withUploads, "frontend", dir), "IMAGE_PRECHECK_TOKEN"));
    expect(after).toContain(`CS_ARWEAVE_GATEWAY=${gateway}`);
    // everything it was deployed with is kept
    for (const e of before) expect(after).toContain(e);
    // and the same SDL a fresh render gives
    expect([...after].sort()).toEqual([...env(withUploads, "scanner", dir)].sort());
    expect(patched(doc, specInput(), dir)).toEqual(before);
  });

  it("says before a chain reset that the storage secret cannot be read", () => {
    const spec = (input: unknown) => checkSpec(input).spec!;
    expect(imageUploadsSecretProblem(spec(specInput({ uploads: UPLOADS })), secrets())).toBeUndefined();
    expect(imageUploadsSecretProblem(spec(specInput({ uploads: UPLOADS })), secrets(false))).toMatch(
      /secret:s3-images is not set in the launch's secrets/,
    );
    const viaEnv = spec(specInput({ uploads: { ...UPLOADS, secretRef: "env:SD_TEST_IMAGE_SECRET_UNSET" } }));
    expect(imageUploadsSecretProblem(viaEnv, secrets())).toMatch(/env:SD_TEST_IMAGE_SECRET_UNSET is not set in the environment/);
    expect(imageUploadsSecretProblem(spec(specInput()), secrets(false))).toBeUndefined();
  });

  it("asks nothing of the scanner while the frontend is off", () => {
    const input = testnetSpecInput({
      topology: {
        validators: { count: 1 },
        sentries: { count: 1 },
        components: {
          explorer: { enabled: false },
          frontend: { enabled: false, imageUploads: UPLOADS },
          hub: { enabled: false },
          scanner: { enabled: true, domain: "scan.phoenix.example" },
        },
        publicEndpoints: { api: "api.phoenix.example", rpc: "rpc.phoenix.example" },
        headscale: { domain: "hs.phoenix.example" },
      },
    });
    expect(env(input, "scanner", secrets()).some((e) => e.startsWith("CS_PRECHECK_"))).toBe(false);
    const noScanner = structuredClone(input) as any;
    delete noScanner.topology.components.scanner;
    expect(checkSpec(noScanner).errors.map((e) => e.path)).not.toContain("topology.components.frontend.imageUploads");
  });
});

describe("permanent copies on Arweave", () => {
  const arweave = (over: Record<string, unknown> = {}) => ({ ...UPLOADS, arweave: over });

  it("can be switched off in the spec, and shares a custom gateway with the scanner", () => {
    const dir = secrets();
    const input = specInput({ uploads: arweave({ disabled: true, gateway: "https://gw.phoenix.example/raw/{id}" }) });
    const fe = env(input, "frontend", dir);
    expect(fe).toContain("ARWEAVE_UPLOADS_DISABLED=true");
    expect(fe).toContain("ARWEAVE_GATEWAY=https://gw.phoenix.example/raw/{id}");
    expect(env(input, "scanner", dir)).toContain("CS_ARWEAVE_GATEWAY=https://gw.phoenix.example/raw/{id}");
  });

  it("renders nothing for Arweave without the block, or with an empty one", () => {
    const none = (u: Record<string, unknown>) => env(specInput({ uploads: u }), "frontend", secrets()).some((e) => e.startsWith("ARWEAVE_"));
    expect(none(UPLOADS)).toBe(false);
    expect(none(arweave())).toBe(false);
  });

  it("refuses the settings of the old site-run copies, a bad gateway and a key", () => {
    const ok = (over: Record<string, unknown>) => checkSpec(specInput({ uploads: arweave(over) })).ok;
    // x/storage takes the fee and a storage operator holds the wallet
    expect(ok({ feeAmount: "2000000" })).toBe(false);
    expect(ok({ feeRecipient: "sprkdrm1j4mqhgrdnjnxvlucjpq9eceyfuyek479e7watv" })).toBe(false);
    expect(ok({ address: "a".repeat(43) })).toBe(false);
    expect(ok({ node: "https://arweave.net" })).toBe(false);
    expect(ok({ gateway: "http://gw.phoenix.example/{id}" })).toBe(false);
    expect(ok({ jwkRef: "secret:arweave-key" })).toBe(false);
  });
});
