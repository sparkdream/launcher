import { describe, expect, it } from "vitest";
import { LocalHealth } from "../src/local-health.js";

function gauge() {
  const clock = { wall: 1_000_000, mono: 5_000 };
  const health = new LocalHealth({ wall: () => clock.wall, mono: () => clock.mono, settleMs: 180_000 });
  const pass = (ms: number, wallMs = ms) => {
    clock.mono += ms;
    clock.wall += wallMs;
  };
  return { health, pass };
}

describe("the launcher's own machine", () => {
  it("is fine while its timer fires about on time", () => {
    const { health, pass } = gauge();
    for (const ms of [1000, 1040, 1900, 1000]) {
      pass(ms);
      health.beat();
    }
    expect(health.trouble()).toBeNull();
  });

  it("is troubled once the timer fires seconds late, until it has run smoothly for the settle time", () => {
    const { health, pass } = gauge();
    pass(9000);
    health.beat();
    expect(health.trouble()).toMatch(/fired 8\.0s late, 0s ago/);
    for (let i = 0; i < 179; i++) {
      pass(1000);
      health.beat();
    }
    expect(health.trouble()).toMatch(/179s ago/);
    pass(1000);
    health.beat();
    expect(health.trouble()).toBeNull();
  });

  it("a second stall starts the settle time over", () => {
    const { health, pass } = gauge();
    pass(9000);
    health.beat();
    pass(170_000);
    health.beat();
    pass(20_000);
    expect(health.trouble()).not.toBeNull();
  });

  it("sees a suspended machine by the wall clock alone", () => {
    const { health, pass } = gauge();
    pass(1000, 3_600_000);
    health.beat();
    expect(health.trouble()).toMatch(/late/);
  });

  it("reports a stall still in progress when asked before its timer got to fire", () => {
    const { health, pass } = gauge();
    health.start();
    try {
      expect(health.trouble()).toBeNull();
      pass(30_000);
      expect(health.trouble()).toMatch(/fired 29\.0s late/);
    } finally {
      health.stop();
    }
  });
});
