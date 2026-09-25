import fs from "node:fs";
import path from "node:path";
import { grpcRequired, lcdRequired, type LaunchSpec } from "@sparkdream/launch-spec";
import type { StepCtx } from "./engine.js";
import { NODE_HOME } from "./node-ops.js";
import type { SshTarget } from "./services.js";

/**
 * What a sentry's app.toml must open for the fleet's service components and
 * public endpoints. The vendored template ships the LCD off and bound to
 * localhost.
 */
export interface SentryServe {
  /** LCD on 0.0.0.0:1317 with CORS: the explorer's tailnet tunnel and the
   *  public api domain (ingress → pod 1317) both reach it from outside the
   *  container, and Keplr calls the public api straight from the browser. */
  lcd: boolean;
  /** gRPC on 0.0.0.0:9090: a relayer (this fleet's, or another fleet's that
   *  relays to this chain) reaches it through a mesh tunnel, which dials the
   *  sentry's tailnet address rather than its localhost. */
  grpc: boolean;
}

/** What the spec's own components need. `relayedTo` adds gRPC for another
 *  fleet's relayer dialing this chain, which this spec cannot know about. */
export function sentryServe(spec: LaunchSpec, relayedTo = false): SentryServe {
  return { lcd: lcdRequired(spec), grpc: grpcRequired(spec) || relayedTo };
}

/** Set `key = value` inside `[section]`, replacing the key's first line.
 *  Throws when the key is absent: a template or node config without it has
 *  drifted, and silently leaving the port closed is the failure to avoid. */
function setInSection(toml: string, section: string, key: string, value: string): string {
  const lines = toml.split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const header = /^\[([^\]]+)\]\s*$/.exec(lines[i]!);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    if (inSection && new RegExp(`^${key}\\s*=`).test(lines[i]!)) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  throw new Error(`app.toml has no ${key} in [${section}]`);
}

/**
 * Open what `serve` asks for in a sentry app.toml. Section-scoped and
 * idempotent, so it applies equally to a freshly rendered template, to a
 * live node's config (a component added after launch), and to a relaunched
 * sentry's launch-time bundle (which predates any such component). Never
 * closes anything: a flag that is false leaves the file alone.
 */
export function applySentryServe(app: string, serve: SentryServe): string {
  let out = app;
  if (serve.lcd) {
    out = setInSection(out, "api", "enable", "true");
    out = setInSection(out, "api", "address", '"tcp://0.0.0.0:1317"');
    out = setInSection(out, "api", "enabled-unsafe-cors", "true");
  }
  if (serve.grpc) {
    out = setInSection(out, "grpc", "enable", "true");
    out = setInSection(out, "grpc", "address", '"0.0.0.0:9090"');
  }
  return out;
}

/**
 * Apply `serve` to a live sentry's app.toml over SSH. Returns whether the
 * file changed; the caller decides whether the node needs a restart to pick
 * it up (a relaunched node that has not started yet does not).
 */
export async function patchSentryAppToml(
  ctx: StepCtx,
  key: string,
  target: SshTarget,
  serve: SentryServe,
): Promise<boolean> {
  const file = `${NODE_HOME}/config/app.toml`;
  const current = (await ctx.services.ssh.exec(target, `cat ${file}`, { quick: true })).stdout;
  const wanted = applySentryServe(current, serve);
  if (wanted === current) return false;
  const local = path.join(ctx.dirs.root, `${key}.app.toml.serve`);
  fs.writeFileSync(local, wanted);
  await ctx.services.ssh.upload(target, local, file);
  fs.rmSync(local, { force: true });
  ctx.log(`${key}: app.toml opened for the fleet's components`);
  return true;
}
