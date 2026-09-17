import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyReferenceGenesis, assertNoReferenceAccounts } from "../src/genesis-params.js";

/**
 * The guard that keeps the reference network's own accounts out of a launched
 * chain's genesis. applyReferenceGenesis strips the address-keyed half of the
 * reference field by field, which is a denylist: every address-bearing field
 * the chain repo adds is a hole until someone notices. The failure is silent
 * at runtime — x/commons treats a non-empty founding_members as an override of
 * the image's compiled-in founders, so a leak produces a chain that starts,
 * produces blocks, and has no councils — so it has to fail at build time.
 */

const vendor = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../vendor/sparkdream-deploy/network",
);
const load = (net: string) =>
  JSON.parse(fs.readFileSync(path.join(vendor, net, "genesis.json"), "utf8"));

describe("assertNoReferenceAccounts", () => {
  it("passes when the launched genesis shares no accounts with the reference", () => {
    const reference = load("devnet");
    const clean = { app_state: { commons: { founding_members: [] }, rep: { member_map: [] } } };
    expect(() => assertNoReferenceAccounts(clean, reference, [])).not.toThrow();
  });

  it("catches a reference founding_members block that survived the overlay", () => {
    const reference = load("devnet");
    const leaked = {
      app_state: { commons: { founding_members: reference.app_state.commons.founding_members } },
    };
    expect(() => assertNoReferenceAccounts(leaked, reference, [])).toThrow(/commons: sprkdrm/);
  });

  it("catches the testnet welcome post's author", () => {
    const reference = load("testnet");
    const leaked = { app_state: { blog: reference.app_state.blog } };
    expect(() => assertNoReferenceAccounts(leaked, reference, [])).toThrow(/blog: sprkdrm/);
  });

  it("allows an address the spec placed deliberately (canonical relaunch)", () => {
    const reference = load("devnet");
    const members = reference.app_state.commons.founding_members as { address: string }[];
    const leaked = { app_state: { commons: { founding_members: members } } };
    expect(() =>
      assertNoReferenceAccounts(leaked, reference, members.map((m) => m.address)),
    ).not.toThrow();
  });

  it("does not flag module addresses, which are identical on every chain", () => {
    const reference = load("devnet");
    const session = { app_state: { session: reference.app_state.session } };
    expect(() => assertNoReferenceAccounts(session, reference, [])).not.toThrow();
  });
});

/**
 * The reference network's seeded blog content is wanted on a relaunch of that
 * same network and wrong on any other chain. The spec's explicit addresses are
 * what tells the two apart.
 */
describe("applyReferenceGenesis / reference blog content", () => {
  const reference = load("testnet");
  const author = reference.app_state.blog.posts[0].creator as string;

  const specWith = (addresses: string[]) =>
    ({
      token: { baseDenom: "uspark.newchain", displayDenom: "SPARK", dreamDisplayDenom: "DREAM", exponent: 6 },
      accounts: { initial: addresses.map((address, i) => ({ name: `a${i}`, address })) },
    }) as any;

  const skeleton = () => ({
    app_state: {
      blog: { posts: [], post_count: "1", replies: [], reply_count: "1", reactions: [], reaction_counts: [] },
      staking: { params: {} },
      identity: { identity: {} },
    },
  });

  it("drops the welcome post when its author is not among the spec's accounts", () => {
    const genesis = skeleton();
    applyReferenceGenesis(genesis, reference, specWith(["sprkdrm1someoneelse"]));
    expect(genesis.app_state.blog.posts).toHaveLength(0);
    expect(genesis.app_state.blog.post_count).toBe("1");
  });

  it("keeps the welcome post when the spec carries its author over", () => {
    const genesis = skeleton();
    applyReferenceGenesis(genesis, reference, specWith([author]));
    expect(genesis.app_state.blog.posts).toHaveLength(1);
    expect(genesis.app_state.blog.posts[0].creator).toBe(author);
    expect(genesis.app_state.blog.post_count).toBe(reference.app_state.blog.post_count);
  });
});
