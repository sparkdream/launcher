import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * The one line of a cobra failure that says what went wrong, picked out of
 * the usage screen printed around it.
 *
 * Cobra prints usage on any error, and the SDK's commands put the error
 * itself either above it (`failed to validate genesis state: …`) or below
 * (`couldn't make client config: …`) — thousands of characters from either
 * end, so a fixed head or tail slice is as likely to cut it as keep it.
 * What the error lines have in common is being flush left: everything in the
 * usage screen is either an indented command/flag line or one of its
 * section headers.
 */
const COBRA_SECTIONS = /^(Usage|Aliases|Examples|Flags|Global Flags|Additional help topics|Available Commands):/;

export function cobraError(output: string): string | undefined {
  const candidates = output
    .split("\n")
    .filter((l) => l.trim() && !/^\s/.test(l) && !COBRA_SECTIONS.test(l))
    .map((l) => l.trim());
  return candidates[candidates.length - 1];
}

export function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...opts.env } },
      (error, stdout, stderr) => {
        if (error) {
          // cobra prints its usage screen on any failure and the real error
          // line with it — first on some commands, last on others, and either
          // way thousands of characters from the end this message keeps. Lead
          // with the line itself; the tails stay for everything it omits.
          const reason = cobraError(stderr) ?? cobraError(stdout);
          reject(
            new Error(
              `${cmd} ${args.join(" ")} failed: ${reason ?? error.message}\n` +
                `stdout(tail): ${stdout.slice(-1500)}\nstderr(tail): ${stderr.slice(-1500)}`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

import { currentAssets } from "./chain-assets/context.js";

/**
 * Binary resolution (§13): the running launch's assets context first (set
 * by runLaunch per launch), then the env override, then PATH.
 */
export function sparkdreamd(args: string[]): Promise<ExecResult> {
  const bin = currentAssets()?.bin ?? process.env.SPARKDREAMD_BIN ?? "sparkdreamd";
  return run(bin, args);
}
