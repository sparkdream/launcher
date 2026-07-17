import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
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
          // cobra CLIs print the real "Error: ..." line last, sometimes on stdout
          reject(
            new Error(
              `${cmd} ${args.join(" ")} failed: ${error.message}\n` +
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
