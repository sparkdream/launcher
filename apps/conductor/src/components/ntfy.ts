import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import type { StepCtx } from "../engine.js";
import { alertSettings, setAlertSettings } from "../incidents.js";
import { readSecretFile, writeSecretFile } from "../secrets.js";
import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

/**
 * The alerts server: upstream ntfy, which the launcher posts its incident
 * alerts to and a phone app reads. Stateless on purpose: the logins (the
 * phone's read-only user, the launcher's write-only token) are declared in
 * env (NTFY_AUTH_*), so a relaunch on another provider comes back with the
 * same logins and only the 24 h message cache is lost. The image has no
 * /var/cache or /var/lib/ntfy, so its two databases live in /tmp.
 */

const resources: SdlResources = {
  cpu: { units: 0.25 },
  memory: { size: "256Mi" },
  storage: [{ size: "512Mi" }],
};

/** The alerts server's logins, generated once per launch (secrets/ntfy.json). */
export interface NtfySecrets {
  /** The phone app's password: shown in the fleet's accounts panel. */
  phonePassword: string;
  phoneHash: string;
  /** The launcher's user logs in with its token; the password is never used. */
  launcherHash: string;
  /** tk_ + 29 characters, what `ntfy token generate` makes. */
  launcherToken: string;
}

const FILE = "ntfy.json";

const randomChars = (n: number, alphabet: string) =>
  Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");

/** bcrypt at cost 10, like `ntfy user hash` (ntfy reads bcryptjs's $2b$ form too). */
const hash = (password: string) => bcrypt.hashSync(password, 10);

export function readNtfySecrets(secretsDir: string): NtfySecrets | undefined {
  const file = path.join(secretsDir, FILE);
  return fs.existsSync(file) ? (JSON.parse(readSecretFile(file)) as NtfySecrets) : undefined;
}

/** The launch's ntfy logins, made on first use and never regenerated (a phone stays logged in). */
export function ensureNtfySecrets(secretsDir: string): NtfySecrets {
  const existing = readNtfySecrets(secretsDir);
  if (existing) return existing;
  const phonePassword = randomChars(24, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789");
  const fresh: NtfySecrets = {
    phonePassword,
    phoneHash: hash(phonePassword),
    launcherHash: hash(crypto.randomBytes(24).toString("hex")),
    launcherToken: `tk_${randomChars(29, "abcdefghijklmnopqrstuvwxyz0123456789")}`,
  };
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeSecretFile(path.join(secretsDir, FILE), JSON.stringify(fresh, null, 2));
  return fresh;
}

function settings(spec: LaunchSpec) {
  const n = spec.topology.components.ntfy!;
  return { domain: n.domain!, topic: n.topic ?? "sparkdream-alerts", user: n.user ?? "phone" };
}

function render(input: RenderInput) {
  const { spec, component, secretsDir } = input;
  if (!secretsDir) throw new Error("ntfy needs the launch's secrets directory to render its logins");
  const s = ensureNtfySecrets(secretsDir);
  const { domain, topic, user } = settings(spec);
  return {
    ntfy: {
      service: {
        image: component.image,
        args: ["serve"],
        expose: [{ port: 80, as: 80, accept: [component.domain!], proto: "tcp", to: [{ global: true }] }],
        env: [
          `NTFY_BASE_URL=https://${domain}`,
          "NTFY_LISTEN_HTTP=:80",
          // TLS ends at Cloudflare; client IPs come from X-Forwarded-For
          "NTFY_BEHIND_PROXY=true",
          "NTFY_CACHE_FILE=/tmp/ntfy-cache.db",
          "NTFY_CACHE_DURATION=24h",
          "NTFY_AUTH_FILE=/tmp/ntfy-user.db",
          "NTFY_AUTH_DEFAULT_ACCESS=deny-all",
          // instant notifications on iPhone go through ntfy.sh's push relay
          // (it sees a hash of the topic, never the message)
          "NTFY_UPSTREAM_BASE_URL=https://ntfy.sh",
          `NTFY_AUTH_USERS=${user}:${s.phoneHash}:user,launcher:${s.launcherHash}:user`,
          // the phone reads the alerts topic, the launcher only writes it
          `NTFY_AUTH_ACCESS=${user}:${topic}:ro,launcher:${topic}:wo`,
          `NTFY_AUTH_TOKENS=launcher:${s.launcherToken}:sparkdream launcher`,
        ],
      },
      resources,
    },
  };
}

/**
 * Point the launcher's own alerts at the server once it answers, unless they
 * already go somewhere else (another ntfy, or ntfy.sh): then that choice
 * stays, and the System panel offers this one. Runs after every placement.
 */
export async function useNtfyForAlerts(ctx: StepCtx, spec: LaunchSpec): Promise<Record<string, unknown>> {
  const { domain, topic } = settings(spec);
  const server = `https://${domain}`;
  const current = alertSettings(ctx.db);
  if (current.ntfy && current.ntfy.server !== server) {
    ctx.log(`ntfy: alerts already go to ${current.ntfy.server}; left as they are (switch in the System panel)`);
    return { alerts: "unchanged" };
  }
  const { launcherToken } = ensureNtfySecrets(ctx.dirs.secrets);
  setAlertSettings(ctx.db, { ...current, ntfy: { server, topic, token: launcherToken } });
  ctx.log(`ntfy: the launcher's alerts now go to ${server}/${topic}`);
  return { alerts: `${server}/${topic}` };
}

export const ntfy: ComponentDescriptor = {
  key: "ntfy",
  render,
  resources: () => [resources],
  imageServices: ["ntfy"],
  shellService: "ntfy",
  tunnels: () => [],
  // the env carries nothing chain-specific, and its logins come from the
  // secrets file, so a fresh render equals the deployed one
  envRefresh: "rerender",
  ingress: (spec) => {
    const { domain } = settings(spec);
    return [{ domain, healthUrl: `https://${domain}/v1/health` }];
  },
  configureSteps: (name, spec) => [{ name: name("ntfy-alerts"), run: (ctx) => useNtfyForAlerts(ctx, spec) }],
  retargetEnv: (spec) => ({ NTFY_BASE_URL: `https://${settings(spec).domain}` }),
};
