import { describe, expect, it } from "vitest";
import { restartNode } from "../src/node-ops.js";

const target = { host: "node", port: 22 } as never;

/** Minimal ssh stub: records commands, answers the PID-1 probe. */
function stubSsh(pid1: string | Error) {
  const log: string[] = [];
  const ssh = {
    async exec(_t: unknown, command: string) {
      log.push(command);
      if (command.includes("/proc/1/comm")) {
        if (pid1 instanceof Error) throw pid1;
        return { stdout: pid1, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  } as never;
  return { log, ssh };
}

describe("restartNode", () => {
  it("detaches the signal and sends no start when the node is the container's PID 1", async () => {
    const { log, ssh } = stubSsh("sparkdreamd\n");
    await restartNode(ssh, target);
    // Backgrounded: the exec has to return before the container goes down,
    // because the shell that would acknowledge it dies along with init.
    const kill = log.find((c) => c.includes("pkill -x sparkdreamd"));
    expect(kill).toBeDefined();
    expect(kill!.trimEnd().endsWith("&")).toBe(true);
    // No start command — the container restart brings the node back on its
    // own, and waiting on a start here is what wedged rewire past ten minutes.
    expect(log.some((c) => c.includes("sparkdreamd start"))).toBe(false);
  });

  it("keeps the kill-then-start pair when the node is an ordinary child process", async () => {
    const { log, ssh } = stubSsh("sh\n");
    await restartNode(ssh, target);
    expect(log).toContain("pkill -x sparkdreamd || true");
    expect(log.some((c) => c.includes("sparkdreamd start"))).toBe(true);
  });

  it("falls back to the child-process path when PID 1 cannot be read", async () => {
    const { log, ssh } = stubSsh(new Error("no /proc on this image"));
    await restartNode(ssh, target);
    expect(log.some((c) => c.includes("sparkdreamd start"))).toBe(true);
  });
});
