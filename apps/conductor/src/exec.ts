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

const BINARY = process.env.SPARKDREAMD_BIN ?? "sparkdreamd";

export function sparkdreamd(args: string[]): Promise<ExecResult> {
  return run(BINARY, args);
}
