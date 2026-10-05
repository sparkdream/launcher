import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import type { ConductorDb } from "./db.js";
import type { SshTarget } from "./services.js";
import { toSsh2CompatiblePrivateKey } from "./keys.js";

/**
 * Launcher-managed tmkms signer (§5 step 19, local variant): when the tmkms
 * signer runs on the machine the launcher runs on, the launcher can do what
 * every signer pause otherwise asks the operator to do by hand: repoint the
 * [[validator]] addr after a move, restart the signer, reset its watermark
 * on a chain reset, rejoin the mesh after a headscale re-key.
 *
 * Opt-in per validator ("adopt"): the launcher finds the running tmkms
 * process (on its own machine, or on another one it reaches over SSH, such
 * as a Raspberry Pi holding a hardware key), moves it under a systemd user
 * unit it owns unless it already runs as a systemd service (then that
 * service is used as it is), and records the binding in the settings table. The unit outlives launcher restarts, so
 * signing never depends on the conductor process. A validator without a
 * binding keeps the guided pauses exactly as before.
 *
 * Hard rules: the state file (double-sign watermark) is never edited, only
 * renamed aside on a chain reset; config edits replace one addr line and
 * keep a .bak; the launcher never starts its unit while a tmkms process it
 * does not own runs the same config.
 */

export interface LocalSignerBinding {
  key: string;
  chainId: string;
  /** systemd unit the signer runs as: one the launcher installed, or the operator's own. */
  unit: string;
  /** "user": systemctl --user; "system": sudo -n systemctl (default "user"). */
  scope?: UnitScope;
  /** The signer's machine when it is not the launcher's own. */
  remote?: RemoteHost;
  bin: string;
  workDir: string;
  /** Absolute path of the tmkms config. */
  config: string;
  /** Tailscale CLI that owns the signer machine's mesh address, when known. */
  meshCli: string | null;
  meshHostname: string | null;
  adoptedAt: string;
  /** Last thing the launcher did to the signer on its own (watchdog, ops). */
  lastAction?: { at: string; what: string };
}

export type UnitScope = "user" | "system";

/** Another machine the signer runs on, reached over SSH (key auth). */
export interface RemoteHost {
  /** the ssh_config alias it was resolved from, for display */
  alias?: string;
  host: string;
  port: number;
  user: string;
  /** private key file, readable by the conductor */
  keyPath: string;
}

export interface TmkmsProcess {
  pid: number;
  bin: string;
  cwd: string;
  /** Absolute config path from the -c/--config argument. */
  config: string;
  /** systemd unit the process runs under, if any. */
  unit: string | null;
  unitScope?: UnitScope;
}

/**
 * A tmkms process from what /proc says about it: argv, cwd and its cgroup
 * line (the unit, and whether it lives in the system or a user manager).
 */
export function describeProcess(pid: number, bin: string, cwd: string, argv: string[], cgroup: string): TmkmsProcess | null {
  if (!argv.includes("start")) return null;
  const i = argv.findIndex((a) => a === "-c" || a === "--config");
  const rel = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--config="))?.slice(9);
  // tmkms's own default when no -c is given
  const config = path.resolve(cwd, rel ?? "tmkms.toml");
  const unit = /\/([^/]+\.service)\s*$/m.exec(cgroup)?.[1] ?? null;
  const unitScope: UnitScope | undefined = unit ? (/\/user@\d+\.service\//.test(cgroup) ? "user" : "system") : undefined;
  return { pid, bin, cwd, config, unit, ...(unitScope ? { unitScope } : {}) };
}

export interface MeshCli {
  cli: string;
  running: boolean;
  ips: string[];
  hostname: string | null;
}

/** The machine-side half: everything that touches processes and files. */
export interface LocalSignerHost {
  processes(): Promise<TmkmsProcess[]>;
  readFile(file: string): Promise<string>;
  /** Atomic replace; the previous content is kept as <file>.bak. */
  writeFile(file: string, text: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  /** Write the unit file, daemon-reload, enable (not start). */
  installUnit(unit: string, contents: string, scope?: UnitScope): Promise<void>;
  unitActive(unit: string, scope?: UnitScope): Promise<boolean>;
  startUnit(unit: string, scope?: UnitScope): Promise<void>;
  stopUnit(unit: string, scope?: UnitScope): Promise<void>;
  restartUnit(unit: string, scope?: UnitScope): Promise<void>;
  /** SIGTERM, then wait for the process to exit. */
  kill(pid: number): Promise<void>;
  unitLog(unit: string, lines: number, scope?: UnitScope): Promise<string>;
  meshClis(): Promise<MeshCli[]>;
  meshUp(cli: string, args: string[]): Promise<void>;
  /**
   * Whether this user's systemd manager outlives its sessions (logind
   * linger), turning it on when the user may. Without it a user unit stops
   * once the last session ends, which over SSH is right after each command.
   * Absent: not checked.
   */
  ensureLinger?(): Promise<boolean>;
}

// --- tmkms.toml (pure) ---

export interface TmkmsConfigView {
  validators: { chainId: string; addr: string }[];
  stateFiles: string[];
  /** [[chain]] blocks: one config can sign for several chains, each with its own watermark */
  chains: { id: string; stateFile: string }[];
}

/**
 * Just enough TOML for tmkms configs: array-of-table headers and simple
 * `key = "value"` lines. Never used to re-serialize: edits are line splices
 * (withValidatorAddr), so comments and the operator's own edits survive.
 */
export function parseTmkmsConfig(text: string): TmkmsConfigView {
  const view: TmkmsConfigView = { validators: [], stateFiles: [], chains: [] };
  let table = "";
  let current: { chainId: string; addr: string } | null = null;
  let chain: { id: string; stateFile: string } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      current = null;
      chain = null;
      if (table === "chain") {
        chain = { id: "", stateFile: "" };
        view.chains.push(chain);
      }
      if (table === "validator") {
        current = { chainId: "", addr: "" };
        view.validators.push(current);
      }
      continue;
    }
    const kv = /^([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (table === "validator" && current) {
      if (k === "chain_id") current.chainId = v!;
      if (k === "addr") current.addr = v!;
    }
    if (table === "chain" && k === "state_file") view.stateFiles.push(v!);
    if (table === "chain" && chain) {
      if (k === "id") chain.id = v!;
      if (k === "state_file") chain.stateFile = v!;
    }
  }
  return view;
}

/**
 * The config with the addr of the [[validator]] block for `chainId` set to
 * `addr`. Exactly one such block must exist: a config naming the chain
 * twice would leave the launcher guessing which validator it signs for.
 */
export function withValidatorAddr(text: string, chainId: string, addr: string): string {
  const lines = text.split("\n");
  const blocks: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[\[validator\]\]\s*(#.*)?$/.test(lines[i]!)) {
      let end = i + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
      blocks.push({ start: i, end });
    }
  }
  const mine = blocks.filter((b) =>
    lines.slice(b.start, b.end).some((l) => new RegExp(`^\\s*chain_id\\s*=\\s*"${escapeRe(chainId)}"`).test(l)),
  );
  if (mine.length !== 1) {
    throw new Error(`tmkms config has ${mine.length} [[validator]] blocks for ${chainId}; expected exactly one`);
  }
  const b = mine[0]!;
  const at = lines.slice(b.start, b.end).findIndex((l) => /^\s*addr\s*=/.test(l));
  if (at < 0) throw new Error(`the [[validator]] block for ${chainId} has no addr line`);
  lines[b.start + at] = `addr = "${addr}"`;
  return lines.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function signerAddr(tailnetIp: string): string {
  return `tcp://${tailnetIp}:26659`;
}

export function unitName(chainId: string, key: string): string {
  return `sparkdream-tmkms-${chainId}-${key}.service`.replace(/[^A-Za-z0-9:_.@-]/g, "-");
}

/** One systemd command-line word: double-quoted, with systemd's specifier (%) and variable ($) expansion escaped. */
function unitWord(word: string): string {
  return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function renderUnit(b: { key: string; chainId: string; bin: string; workDir: string; config: string }): string {
  return [
    "# Installed by the SparkDream launcher (managed tmkms signer).",
    "# The launcher edits the config's addr line and restarts this unit;",
    "# it never edits the state file. Remove the binding in the launcher's",
    "# tmkms panel before changing this unit by hand.",
    "[Unit]",
    `Description=tmkms signer for ${b.chainId} ${b.key}`,
    "After=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${b.workDir}`,
    `ExecStart=${unitWord(b.bin)} start -c ${unitWord(b.config)}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// --- bindings (settings table) ---

const SETTING_PREFIX = "local-signer:";
const settingKey = (launchId: string, key: string) => `${SETTING_PREFIX}${launchId}:${key}`;

export function getBinding(db: ConductorDb, launchId: string, key: string): LocalSignerBinding | null {
  const raw = db.getSetting(settingKey(launchId, key));
  return raw ? (JSON.parse(raw) as LocalSignerBinding) : null;
}

export function setBinding(db: ConductorDb, launchId: string, binding: LocalSignerBinding): void {
  db.setSetting(settingKey(launchId, binding.key), JSON.stringify(binding));
}

export function clearBinding(db: ConductorDb, launchId: string, key: string): void {
  db.deleteSetting(settingKey(launchId, key));
}

function noteAction(db: ConductorDb, launchId: string, b: LocalSignerBinding, what: string): void {
  setBinding(db, launchId, { ...b, lastAction: { at: new Date().toISOString(), what } });
}

// --- operations ---

export interface SignerDeps {
  db: ConductorDb;
  /** the launcher's own machine, when a signer can be managed on it */
  host: LocalSignerHost | undefined;
  /** another machine's host, reached over SSH */
  remote?: ((r: RemoteHost) => LocalSignerHost) | undefined;
  launchId: string;
  log?: (msg: string) => void;
}

/** SignerDeps from a step context (structural, to keep engine.ts out). */
export function signerDepsOf(ctx: {
  db: ConductorDb;
  services: { localSigner?: LocalSignerHost | undefined; remoteSigner?: ((r: RemoteHost) => LocalSignerHost) | undefined };
  launchId: string;
  log(msg: string): void;
}): SignerDeps {
  return {
    db: ctx.db,
    host: ctx.services.localSigner,
    remote: ctx.services.remoteSigner,
    launchId: ctx.launchId,
    log: (m) => ctx.log(m),
  };
}

/** The machine a binding's signer runs on, or undefined when this launcher cannot reach it. */
export function hostFor(deps: SignerDeps, b: LocalSignerBinding): LocalSignerHost | undefined {
  return b.remote ? deps.remote?.(b.remote) : deps.host;
}

/** Where a binding runs, for log lines. */
function where(b: LocalSignerBinding): string {
  return b.remote ? ` on ${b.remote.alias ?? b.remote.host}` : "";
}

/**
 * Run a managed-signer action from a step. A failure never fails the step:
 * the step's own probe and pause follow, and the pause names what went
 * wrong (`note`), so the operator can finish by hand.
 */
export async function tryManaged(
  deps: SignerDeps,
  action: (deps: SignerDeps) => Promise<boolean>,
): Promise<{ managed: boolean; ok: boolean; note: string }> {
  try {
    const managed = await action(deps);
    return {
      managed,
      ok: managed,
      note: managed
        ? "\nThe launcher manages this signer and already restarted it; if it still has not " +
          "connected, check its log (journalctl -u <unit>, with --user for a user unit) and the mesh link."
        : "",
    };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    deps.log?.(`managed tmkms signer: ${msg}`);
    return { managed: true, ok: false, note: `\nThe launcher manages this signer but could not update it: ${msg}` };
  }
}

/** Which machine a binding's signer runs on: one mesh login serves every binding there. */
export function signerMachine(b: LocalSignerBinding): string {
  return b.remote ? `${b.remote.user}@${b.remote.host}:${b.remote.port}` : "local";
}

/** The managed signer for `key`, or null when it is the operator's to run. */
export function managedSigner(deps: SignerDeps, key: string): LocalSignerBinding | null {
  const b = getBinding(deps.db, deps.launchId, key);
  return b && hostFor(deps, b) ? b : null;
}

/**
 * A tmkms process on this machine that runs the binding's config outside
 * its unit: the operator started one by hand. Starting the unit beside it
 * would put two signers on one validator.
 */
async function assertNoStraySigner(host: LocalSignerHost, b: LocalSignerBinding): Promise<void> {
  const stray = (await host.processes()).find((p) => p.config === b.config && p.unit !== b.unit);
  if (stray) {
    throw new Error(
      `a tmkms process outside the launcher (pid ${stray.pid}) runs ${b.config}; stop it, ` +
        `or remove the launcher's binding for ${b.key}, so only one signer runs this validator`,
    );
  }
}

/**
 * Point the managed signer for `key` at `tailnetIp` and restart it. Returns
 * false when the signer is not launcher-managed (the caller pauses for the
 * operator as before). The state file is untouched: a restart keeps the
 * watermark, which is what stops a double-sign.
 */
export async function repointSigner(deps: SignerDeps, key: string, tailnetIp: string, why: string): Promise<boolean> {
  const b = managedSigner(deps, key);
  const host = b && hostFor(deps, b);
  if (!b || !host) return false;
  await assertNoStraySigner(host, b);
  const addr = signerAddr(tailnetIp);
  const text = await host.readFile(b.config);
  const next = withValidatorAddr(text, b.chainId, addr);
  if (next !== text) await host.writeFile(b.config, next);
  await host.restartUnit(b.unit, b.scope);
  const what = next !== text ? `repointed to ${addr} and restarted (${why})` : `restarted (${why})`;
  noteAction(deps.db, deps.launchId, b, what);
  deps.log?.(`${key}: managed tmkms signer${where(b)} ${what}`);
  return true;
}

/** Restart the managed signer as-is. False when not managed. */
export async function restartSigner(deps: SignerDeps, key: string, why: string): Promise<boolean> {
  const b = managedSigner(deps, key);
  const host = b && hostFor(deps, b);
  if (!b || !host) return false;
  await assertNoStraySigner(host, b);
  await host.restartUnit(b.unit, b.scope);
  noteAction(deps.db, deps.launchId, b, `restarted (${why})`);
  deps.log?.(`${key}: managed tmkms signer${where(b)} restarted (${why})`);
  return true;
}

/**
 * Chain reset: the chain restarts at height 1 under the same chain-id, so
 * the watermark must go back to zero. The state file is renamed aside (never
 * deleted: it is the record of what this key signed on the old chain) and
 * tmkms starts a fresh one. False when not managed.
 */
export async function resetSignerState(deps: SignerDeps, key: string): Promise<boolean> {
  const b = managedSigner(deps, key);
  const host = b && hostFor(deps, b);
  if (!b || !host) return false;
  await assertNoStraySigner(host, b);
  // the watermark of THIS chain: one tmkms may sign for several, and the
  // others' state must not move (a config with one chain and no id names it
  // implicitly)
  const { chains } = parseTmkmsConfig(await host.readFile(b.config));
  const mine = chains.filter((c) => c.id === b.chainId);
  const chosen = mine.length === 1 ? mine[0]! : chains.length === 1 && !chains[0]!.id ? chains[0]! : null;
  if (!chosen?.stateFile) {
    throw new Error(`${b.config} has no single [[chain]] block with a state_file for ${b.chainId}`);
  }
  const state = path.resolve(b.workDir, chosen.stateFile);
  await host.stopUnit(b.unit, b.scope);
  let moved = "";
  if (await host.exists(state)) {
    moved = `${state}.reset-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await host.rename(state, moved);
  }
  await host.startUnit(b.unit, b.scope);
  const what = moved ? `watermark reset (old state kept as ${path.basename(moved)})` : "watermark reset (no state file yet)";
  noteAction(deps.db, deps.launchId, b, what);
  deps.log?.(`${key}: managed tmkms signer${where(b)} ${what}`);
  return true;
}

/**
 * Headscale re-key: log the signer machine back into the (new) mesh. Uses
 * the Tailscale CLI recorded at adoption, which on WSL is the Windows one:
 * with mirrored networking the signer's tailnet address belongs to Windows.
 */
export async function rejoinSignerMesh(
  deps: SignerDeps,
  b: LocalSignerBinding,
  loginServer: string,
  authKey: string,
): Promise<void> {
  const host = hostFor(deps, b);
  if (!host || !b.meshCli) throw new Error(`${b.key}: no mesh CLI recorded for the managed signer`);
  const args = ["up", `--login-server=${loginServer}`, `--authkey=${authKey}`, "--force-reauth"];
  if (b.meshHostname) args.push(`--hostname=${b.meshHostname}`);
  try {
    await host.meshUp(b.meshCli, args);
  } catch (e) {
    // the error text carries the command line, and goes to logs and pause notes
    throw new Error(String(e instanceof Error ? e.message : e).split(authKey).join("<authkey>"));
  }
  deps.log?.(`${b.key}: signer machine${where(b)} rejoined the mesh through ${b.meshCli}`);
}

export interface AdoptCandidate extends TmkmsProcess {
  managed: boolean;
}

/** tmkms processes on this machine that sign for `chainId`. */
export async function findCandidates(host: LocalSignerHost, chainId: string): Promise<AdoptCandidate[]> {
  const out: AdoptCandidate[] = [];
  for (const p of await host.processes()) {
    let view: TmkmsConfigView;
    try {
      view = parseTmkmsConfig(await host.readFile(p.config));
    } catch {
      continue;
    }
    if (!view.validators.some((v) => v.chainId === chainId)) continue;
    out.push({ ...p, managed: Boolean(p.unit?.startsWith("sparkdream-tmkms-")) });
  }
  return out;
}

/**
 * Pick the process signing for validator `key`: the one whose addr points
 * at the validator's tailnet IP, else (one validator) the only one there is.
 */
export async function candidateFor(
  host: LocalSignerHost,
  chainId: string,
  key: string,
  tailnetIp: string | null,
  validatorCount: number,
): Promise<AdoptCandidate> {
  const all = await findCandidates(host, chainId);
  if (all.length === 0) throw new Error(`no tmkms process on the signer's machine signs for ${chainId}`);
  if (tailnetIp) {
    const addr = signerAddr(tailnetIp);
    const hits: AdoptCandidate[] = [];
    for (const c of all) {
      const view = parseTmkmsConfig(await host.readFile(c.config));
      if (view.validators.some((v) => v.chainId === chainId && v.addr === addr)) hits.push(c);
    }
    if (hits.length === 1) return hits[0]!;
  }
  if (validatorCount === 1 && all.length === 1) return all[0]!;
  throw new Error(
    `cannot tell which tmkms process signs for ${key} (${all.length} sign for ${chainId}); ` +
      `point one at ${tailnetIp ? signerAddr(tailnetIp) : "the validator"} first`,
  );
}

/**
 * Move the running signer for `key` under a launcher-owned systemd user
 * unit. The hand-started process is stopped only after the unit is
 * installed, and the unit starts right after, so the gap is the tmkms
 * startup time (seconds). Idempotent: an already-managed signer only
 * re-records its binding.
 */
export async function adoptSigner(
  deps: SignerDeps,
  args: { key: string; chainId: string; tailnetIp: string | null; validatorCount: number; remote?: RemoteHost },
): Promise<LocalSignerBinding> {
  const host = args.remote ? deps.remote?.(args.remote) : deps.host;
  if (!host) {
    throw new Error(
      args.remote
        ? "this launcher cannot reach a signer over SSH"
        : "this launcher cannot manage a local signer (not running on the signer's machine)",
    );
  }
  const proc = await candidateFor(host, args.chainId, args.key, args.tailnetIp, args.validatorCount);
  const ownUnit = unitName(args.chainId, args.key);
  // a signer already running as a systemd service (the operator's own unit)
  // is kept as it is: restarting that unit is all the launcher needs
  const existing = proc.unit && proc.unit !== ownUnit ? { unit: proc.unit, scope: proc.unitScope ?? "system" } : null;
  const unit = existing?.unit ?? ownUnit;
  const scope: UnitScope = existing?.scope ?? "user";
  const mesh = (await host.meshClis().catch(() => [])).find((m) => m.running) ?? null;
  const binding: LocalSignerBinding = {
    key: args.key,
    chainId: args.chainId,
    unit,
    scope,
    ...(args.remote ? { remote: args.remote } : {}),
    bin: proc.bin,
    workDir: proc.cwd,
    config: proc.config,
    meshCli: mesh?.cli ?? null,
    meshHostname: mesh?.hostname ?? null,
    adoptedAt: new Date().toISOString(),
  };
  if (!existing && proc.unit !== ownUnit) {
    // the unit must be able to start the same binary before the running one
    // is stopped: a replaced binary reads "<path> (deleted)", and a process
    // the SSH user cannot inspect shows no path at all
    if (!proc.bin.startsWith("/") || proc.bin.endsWith(" (deleted)") || !proc.cwd.startsWith("/")) {
      throw new Error(
        `cannot run pid ${proc.pid}'s tmkms under a unit: its binary (${proc.bin || "unreadable"}) or working ` +
          `directory (${proc.cwd || "unreadable"}) is not a usable path. Restart it from its installed binary ` +
          "(as the user the launcher connects as), then adopt again; it was left running",
      );
    }
    // a user unit lives only as long as the user's systemd manager: without
    // linger that ends with the last session (over SSH, right after each
    // command), and the signer would stop as soon as the launcher let go
    if (host.ensureLinger && !(await host.ensureLinger())) {
      throw new Error(
        "this user's systemd does not outlive its sessions (no linger), so a launcher unit would stop " +
          `between commands: run \`sudo loginctl enable-linger ${args.remote?.user ?? "$USER"}\` on the signer machine, then adopt again; it was left running`,
      );
    }
    await host.installUnit(unit, renderUnit(binding));
    await host.kill(proc.pid);
    await host.startUnit(unit);
  }
  let active = false;
  for (let i = 0; i < 10 && !active; i++) {
    active = await host.unitActive(unit, scope);
    if (!active) await new Promise((r) => setTimeout(r, 500));
  }
  if (!active) {
    const log = await host.unitLog(unit, 20, scope).catch(() => "");
    throw new Error(`${unit} did not stay up after adoption. Last log lines:\n${log}`);
  }
  // a wrapper that respawns the hand-started tmkms would now run a second
  // signer beside the unit: stop the launcher's, never leave two
  const stray = (await host.processes()).find((p) => p.config === binding.config && p.unit !== unit);
  if (stray && !existing) {
    await host.stopUnit(unit, scope).catch(() => undefined);
    throw new Error(
      `another tmkms (pid ${stray.pid}) started on ${binding.config} after the hand-started one was stopped, ` +
        "probably restarted by a wrapper script or supervisor; the launcher's unit was stopped so only one signs. " +
        "Stop that wrapper, then adopt again",
    );
  }
  setBinding(deps.db, deps.launchId, binding);
  deps.log?.(`${args.key}: tmkms signer${where(binding)} ${existing ? `managed through its ${scope} unit` : "now runs as"} ${unit}`);
  return binding;
}

// --- the real machine ---

const WINDOWS_TAILSCALE = "/mnt/c/Program Files/Tailscale/tailscale.exe";

/** Linux host with a systemd user manager (WSL with systemd=true included). */
export class SystemdSignerHost implements LocalSignerHost {
  constructor(private readonly unitDir = path.join(process.env.HOME ?? "/root", ".config/systemd/user")) {}

  async processes(): Promise<TmkmsProcess[]> {
    const out: TmkmsProcess[] = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const dir = `/proc/${entry}`;
      try {
        if (fs.readFileSync(`${dir}/comm`, "utf8").trim() !== "tmkms") continue;
        const argv = fs.readFileSync(`${dir}/cmdline`, "utf8").split("\0").filter(Boolean);
        const p = describeProcess(
          Number(entry),
          fs.readlinkSync(`${dir}/exe`),
          fs.readlinkSync(`${dir}/cwd`),
          argv,
          fs.readFileSync(`${dir}/cgroup`, "utf8"),
        );
        if (p) out.push(p);
      } catch {
        // gone mid-scan, or another user's process
      }
    }
    return out;
  }

  async readFile(file: string): Promise<string> {
    return fs.readFileSync(file, "utf8");
  }

  async writeFile(file: string, text: string): Promise<void> {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o600 });
    fs.renameSync(tmp, file);
  }

  async exists(file: string): Promise<boolean> {
    return fs.existsSync(file);
  }

  async rename(from: string, to: string): Promise<void> {
    fs.renameSync(from, to);
  }

  async installUnit(unit: string, contents: string): Promise<void> {
    fs.mkdirSync(this.unitDir, { recursive: true });
    fs.writeFileSync(path.join(this.unitDir, unit), contents);
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", unit]);
  }

  async ensureLinger(): Promise<boolean> {
    const user = os.userInfo().username;
    const linger = async () =>
      (await run("loginctl", ["show-user", user, "-p", "Linger", "--value"]).catch(() => null))?.stdout.trim() === "yes";
    if (await linger()) return true;
    await run("loginctl", ["enable-linger", user]).catch(() => undefined);
    return linger();
  }

  /** systemctl for a scope: the user manager, or the system one through passwordless sudo. */
  private systemctl(scope: UnitScope | undefined, args: string[]) {
    return scope === "system" ? run("sudo", ["-n", "systemctl", ...args]) : run("systemctl", ["--user", ...args]);
  }

  async unitActive(unit: string, scope?: UnitScope): Promise<boolean> {
    const res = await (scope === "system"
      ? run("systemctl", ["is-active", unit])
      : run("systemctl", ["--user", "is-active", unit])
    ).catch(() => null);
    return res?.stdout.trim() === "active";
  }

  async startUnit(unit: string, scope?: UnitScope): Promise<void> {
    await this.systemctl(scope, ["start", unit]);
  }

  async stopUnit(unit: string, scope?: UnitScope): Promise<void> {
    await this.systemctl(scope, ["stop", unit]);
  }

  async restartUnit(unit: string, scope?: UnitScope): Promise<void> {
    await this.systemctl(scope, ["restart", unit]);
  }

  async kill(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    throw new Error(`tmkms (pid ${pid}) did not exit within 10s of SIGTERM`);
  }

  async unitLog(unit: string, lines: number, scope?: UnitScope): Promise<string> {
    const args = ["-u", unit, "-n", String(lines), "--no-pager", "-o", "cat"];
    const res = await (scope === "system" ? run("sudo", ["-n", "journalctl", ...args]) : run("journalctl", ["--user", ...args]));
    return res.stdout;
  }

  async meshClis(): Promise<MeshCli[]> {
    const candidates = ["tailscale", ...(fs.existsSync(WINDOWS_TAILSCALE) ? [WINDOWS_TAILSCALE] : [])];
    const out: MeshCli[] = [];
    for (const cli of candidates) {
      const res = await withTimeout(run(cli, ["status", "--json", "--peers=false"]), 15_000).catch(() => null);
      if (!res) continue;
      try {
        const st = JSON.parse(res.stdout) as {
          BackendState?: string;
          Self?: { TailscaleIPs?: string[]; HostName?: string };
        };
        out.push({
          cli,
          running: st.BackendState === "Running",
          ips: (st.Self?.TailscaleIPs ?? []).filter((ip) => ip.includes(".")),
          hostname: st.Self?.HostName ?? null,
        });
      } catch {
        // not JSON: an old CLI, or one that cannot reach its daemon
      }
    }
    return out;
  }

  async meshUp(cli: string, args: string[]): Promise<void> {
    await withTimeout(run(cli, args), 120_000);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// --- another machine, over SSH ---

/** POSIX single-quote a shell argument. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What SshSignerHost needs from the launcher's SSH client. */
export interface SshExec {
  exec(target: SshTarget, command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; code: number }>;
  upload(target: SshTarget, localPath: string, remotePath: string): Promise<void>;
}

/**
 * The signer's own machine over SSH (a Raspberry Pi with the hardware key):
 * the same operations as SystemdSignerHost, as shell commands. A system unit
 * is driven through passwordless sudo, and so is `tailscale up`.
 */
export class SshSignerHost implements LocalSignerHost {
  constructor(
    private readonly ssh: SshExec,
    private readonly remote: RemoteHost,
    private readonly readKey: (file: string) => string = (f) => toSsh2CompatiblePrivateKey(fs.readFileSync(f, "utf8")),
  ) {}

  private target(): SshTarget {
    return { host: this.remote.host, port: this.remote.port, user: this.remote.user, privateKeyPem: this.readKey(this.remote.keyPath) };
  }

  private async sh(command: string, timeoutMs = 60_000): Promise<string> {
    const res = await this.ssh.exec(this.target(), command, { timeoutMs });
    if (res.code !== 0) throw new Error(`${this.remote.alias ?? this.remote.host}: \`${command.slice(0, 80)}\` exited ${res.code}: ${res.stdout.slice(-300)}`);
    return res.stdout;
  }

  private systemctl(scope: UnitScope | undefined, args: string): Promise<string> {
    return this.sh(scope === "system" ? `sudo -n systemctl ${args}` : `systemctl --user ${args}`);
  }

  async processes(): Promise<TmkmsProcess[]> {
    // one line per tmkms: pid, exe, cwd, argv (NUL→\x01), last cgroup line
    const out = await this.sh(
      `for p in $(pgrep -x tmkms); do printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$(readlink /proc/$p/exe)" ` +
        `"$(readlink /proc/$p/cwd)" "$(tr '\\0' '\\001' < /proc/$p/cmdline)" "$(tail -n 1 /proc/$p/cgroup)"; done; true`,
    );
    const procs: TmkmsProcess[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [pid, bin, cwd, argv, cgroup] = line.split("\t");
      const p = describeProcess(Number(pid), bin ?? "", cwd ?? "", (argv ?? "").split("\x01").filter(Boolean), cgroup ?? "");
      if (p) procs.push(p);
    }
    return procs;
  }

  async readFile(file: string): Promise<string> {
    return this.sh(`cat ${sq(file)}`);
  }

  async writeFile(file: string, text: string): Promise<void> {
    const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signer-")), "upload");
    fs.writeFileSync(local, text, { mode: 0o600 });
    try {
      const tmp = `${file}.tmp-launcher`;
      await this.ssh.upload(this.target(), local, tmp);
      // keep the old copy, keep the old file's mode, then swap in one rename
      await this.sh(`f=${sq(file)}; t=${sq(tmp)}; [ -f "$f" ] && cp -p "$f" "$f.bak" && chmod --reference="$f" "$t"; mv "$t" "$f"`);
    } finally {
      fs.rmSync(path.dirname(local), { recursive: true, force: true });
    }
  }

  async exists(file: string): Promise<boolean> {
    return (await this.sh(`[ -e ${sq(file)} ] && echo yes || echo no`)).trim() === "yes";
  }

  async rename(from: string, to: string): Promise<void> {
    await this.sh(`mv ${sq(from)} ${sq(to)}`);
  }

  async ensureLinger(): Promise<boolean> {
    const probe = `loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true`;
    if ((await this.sh(probe)).trim() === "yes") return true;
    // a user may turn on its own linger where polkit allows; passwordless sudo otherwise
    await this.sh(`loginctl enable-linger "$(id -un)" 2>/dev/null || sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null || true`);
    return (await this.sh(probe)).trim() === "yes";
  }

  async installUnit(unit: string, contents: string, scope: UnitScope = "user"): Promise<void> {
    const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signer-")), unit);
    fs.writeFileSync(local, contents);
    try {
      await this.ssh.upload(this.target(), local, `/tmp/${unit}`);
      if (scope === "system") {
        await this.sh(`sudo -n mv /tmp/${unit} /etc/systemd/system/${unit} && sudo -n systemctl daemon-reload && sudo -n systemctl enable ${unit}`);
      } else {
        await this.sh(`mkdir -p ~/.config/systemd/user && mv /tmp/${unit} ~/.config/systemd/user/${unit} && systemctl --user daemon-reload && systemctl --user enable ${unit}`);
      }
    } finally {
      fs.rmSync(path.dirname(local), { recursive: true, force: true });
    }
  }

  async unitActive(unit: string, scope?: UnitScope): Promise<boolean> {
    const cmd = scope === "system" ? `systemctl is-active ${unit}` : `systemctl --user is-active ${unit}`;
    return (await this.sh(`${cmd} || true`).catch(() => "")).trim() === "active";
  }

  async startUnit(unit: string, scope?: UnitScope): Promise<void> {
    await this.systemctl(scope, `start ${unit}`);
  }

  async stopUnit(unit: string, scope?: UnitScope): Promise<void> {
    await this.systemctl(scope, `stop ${unit}`);
  }

  async restartUnit(unit: string, scope?: UnitScope): Promise<void> {
    await this.systemctl(scope, `restart ${unit}`);
  }

  async kill(pid: number): Promise<void> {
    await this.sh(`kill -TERM ${pid} 2>/dev/null; for i in $(seq 50); do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.2; done; exit 1`);
  }

  async unitLog(unit: string, lines: number, scope?: UnitScope): Promise<string> {
    const args = `-u ${unit} -n ${lines} --no-pager -o cat`;
    return this.sh(scope === "system" ? `sudo -n journalctl ${args}` : `journalctl --user ${args}`);
  }

  async meshClis(): Promise<MeshCli[]> {
    const out = await this.sh("tailscale status --json --peers=false 2>/dev/null || true").catch(() => "");
    try {
      const st = JSON.parse(out) as { BackendState?: string; Self?: { TailscaleIPs?: string[]; HostName?: string } };
      return [
        {
          cli: "tailscale",
          running: st.BackendState === "Running",
          ips: (st.Self?.TailscaleIPs ?? []).filter((ip) => ip.includes(".")),
          hostname: st.Self?.HostName ?? null,
        },
      ];
    } catch {
      return [];
    }
  }

  async meshUp(cli: string, args: string[]): Promise<void> {
    await this.sh(`sudo -n ${cli} ${args.map(sq).join(" ")}`, 120_000);
  }
}

/**
 * An ssh_config alias (e.g. "rasp") as a RemoteHost, from the conductor's
 * own ~/.ssh/config or, on WSL, the Windows user's (whose IdentityFile is a
 * C:\ path, read here through /mnt/c). Null when no config names it.
 */
export function resolveSshAlias(alias: string, configFiles = defaultSshConfigs()): RemoteHost | null {
  for (const file of configFiles) {
    if (!fs.existsSync(file)) continue;
    let inBlock = false;
    const found: Record<string, string> = {};
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(\S+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const k = m[1]!.toLowerCase();
      const v = m[2]!.replace(/^"(.*)"$/, "$1");
      if (k === "host") {
        if (inBlock) break;
        inBlock = v.split(/\s+/).includes(alias);
        continue;
      }
      if (inBlock && !(k in found)) found[k] = v;
    }
    if (!inBlock && !found.hostname) continue;
    const key = found.identityfile;
    if (!key) continue;
    return {
      alias,
      host: found.hostname ?? alias,
      port: Number(found.port ?? 22),
      user: found.user ?? os.userInfo().username,
      keyPath: windowsPath(key.replace(/^~(?=[/\\])/, path.dirname(path.dirname(file)))),
    };
  }
  return null;
}

/** C:\Users\x\... → /mnt/c/Users/x/... (WSL); anything else unchanged. */
function windowsPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : p;
}

function defaultSshConfigs(): string[] {
  const own = path.join(os.homedir(), ".ssh", "config");
  const windows = fs.existsSync("/mnt/c/Users")
    ? fs.readdirSync("/mnt/c/Users").map((u) => path.join("/mnt/c/Users", u, ".ssh", "config"))
    : [];
  return [own, ...windows];
}
