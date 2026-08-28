import { describe, expect, it } from "vitest";
import { EDITOR, openLaunchFor, type LaunchChoice } from "../lib/open-launch";

/**
 * The Launch panel sits above the fleet cards, and both are wallet-scoped:
 * whatever the panel names has to be a launch of the account whose fleets are
 * on screen.
 */
describe("open launch", () => {
  const done = (launchId: string): LaunchChoice => ({
    launchId,
    launchStatus: "completed",
    alive: true,
  });
  const running = (launchId: string): LaunchChoice => ({
    launchId,
    launchStatus: "running",
    alive: true,
  });
  const closed = (launchId: string): LaunchChoice => ({ ...done(launchId), alive: false });

  it("drops a launch remembered for another deploy account", () => {
    // the reported case: the testnet account's launch header over the devnet
    // account's fleet, after switching accounts in Keplr
    expect(openLaunchFor("testnet-launch", [done("devnet-launch")], null)).toBe("devnet-launch");
  });

  it("keeps a launch the connected account still has", () => {
    expect(openLaunchFor("a", [done("a"), done("b")], null)).toBe("a");
  });

  it("opens the chain an account is running when it has chosen nothing", () => {
    expect(openLaunchFor(null, [closed("old"), done("live")], null)).toBe("live");
  });

  it("leaves the editor open when that is the account's own choice", () => {
    expect(openLaunchFor(EDITOR, [done("live")], null)).toBe(null);
  });

  it("reattaches to a launch that needs attention, editor or not", () => {
    // running, paused on a signature or failed: the panel holds the only
    // banners that reach it
    expect(openLaunchFor(EDITOR, [done("live"), running("busy")], null)).toBe("busy");
    expect(openLaunchFor(null, [done("live"), running("busy")], null)).toBe("busy");
  });

  it("prefers the most recent of several", () => {
    expect(openLaunchFor(null, [running("first"), running("second")], null)).toBe("second");
    expect(openLaunchFor(null, [done("first"), done("second")], null)).toBe("second");
  });

  it("keeps the open launch for an account with no fleets of its own", () => {
    // the reported case: a gentx pauses the launch and asks for the operator
    // account ("select the matching account in Keplr"). That account owns no
    // deployments, and clearing the panel took the Sign button with it
    expect(openLaunchFor(null, [], "signing-launch")).toBe("signing-launch");
    // and what it remembered, so a reload mid-signature comes back to the
    // banner rather than to an empty editor
    expect(openLaunchFor("signing-launch", [], null)).toBe("signing-launch");
    expect(openLaunchFor(EDITOR, [], "signing-launch")).toBe(null);
  });

  it("opens nothing for an account with no fleets, or only closed ones", () => {
    expect(openLaunchFor(null, [], null)).toBe(null);
    expect(openLaunchFor(null, [closed("shut")], null)).toBe(null);
  });

  it("holds a launch created a moment ago, before the sweep sees it", () => {
    // create() stores and opens the new launch; the fleet snapshot in hand
    // predates it, and must not yank the panel back to the running chain
    expect(openLaunchFor("fresh", [done("live")], "fresh")).toBe("fresh");
  });

  it("still drops the other account's launch while that one is on screen", () => {
    expect(openLaunchFor(null, [done("devnet-launch")], "testnet-launch")).toBe("devnet-launch");
  });
});
