import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { applySentryServe } from "../src/sentry-serve.js";
import { templatePath } from "../src/vendor.js";

const template = () => fs.readFileSync(templatePath("app.toml.sentry"), "utf8");

/** The value of `key` inside `[section]`, or undefined. */
function valueIn(toml: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const line of toml.split("\n")) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line);
    if (inSection && m) return m[1];
  }
  return undefined;
}

describe("applySentryServe", () => {
  it("opens the LCD on all interfaces with CORS, touching only [api]", () => {
    const before = template();
    const after = applySentryServe(before, { lcd: true, grpc: false });
    expect(valueIn(after, "api", "enable")).toBe("true");
    expect(valueIn(after, "api", "address")).toBe('"tcp://0.0.0.0:1317"');
    expect(valueIn(after, "api", "enabled-unsafe-cors")).toBe("true");
    // other sections keep their own enable/address lines
    expect(valueIn(after, "grpc", "enable")).toBe(valueIn(before, "grpc", "enable"));
    expect(valueIn(after, "grpc", "address")).toBe(valueIn(before, "grpc", "address"));
    const changed = before.split("\n").filter((l, i) => l !== after.split("\n")[i]);
    expect(changed).toHaveLength(3);
  });

  it("is idempotent, so it can re-apply to a live or relaunched node", () => {
    const once = applySentryServe(template(), { lcd: true, grpc: false });
    expect(applySentryServe(once, { lcd: true, grpc: false })).toBe(once);
  });

  it("leaves the file alone when nothing is asked for", () => {
    expect(applySentryServe(template(), { lcd: false, grpc: false })).toBe(template());
  });

  it("binds gRPC to all interfaces for a relayer's mesh tunnel, touching only [grpc]", () => {
    const before = template();
    const after = applySentryServe(before, { lcd: false, grpc: true });
    expect(valueIn(after, "grpc", "enable")).toBe("true");
    expect(valueIn(after, "grpc", "address")).toBe('"0.0.0.0:9090"');
    expect(valueIn(after, "api", "address")).toBe(valueIn(before, "api", "address"));
    expect(applySentryServe(after, { lcd: false, grpc: true })).toBe(after);
  });

  it("refuses a config whose [api] section has drifted", () => {
    const drifted = template().replace(/^enabled-unsafe-cors\s*=.*$/m, "");
    expect(() => applySentryServe(drifted, { lcd: true, grpc: false })).toThrow(/enabled-unsafe-cors in \[api\]/);
  });
});
