import { afterEach, describe, expect, it, vi } from "vitest";
import { akashOutageProbe, failoverFetch, parseLcds, RestAkashApi } from "../src/akash/rest.js";

const api = (lcd: string) => new RestAkashApi({ lcd, consoleApi: "https://console.invalid" });

function stubFetch(answer: (url: string) => Response | Error) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const a = answer(url);
    if (a instanceof Error) throw a;
    return a;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const TX = "/cosmos/tx/v1beta1/txs/ABC";
const confirmed = () => new Response(JSON.stringify({ tx_response: { code: 0 } }), { status: 200 });

describe("LCD failover", () => {
  it("parses a comma-separated list", () => {
    expect(parseLcds(" https://a/ , https://b ")).toEqual(["https://a", "https://b"]);
    expect(() => parseLcds(" , ")).toThrow();
  });

  it("moves past an LCD answering 502 and sticks with the one that answered", async () => {
    const calls = stubFetch((u) => (u.startsWith("https://down") ? new Response("", { status: 502 }) : confirmed()));
    const a = api("https://down,https://up");
    expect(await a.txStatus("ABC")).toBe("confirmed");
    expect(await a.txStatus("ABC")).toBe("confirmed");
    expect(calls).toEqual([`https://down${TX}`, `https://up${TX}`, `https://up${TX}`]);
  });

  it("moves past a network error too", async () => {
    stubFetch((u) => (u.startsWith("https://down") ? new TypeError("fetch failed") : confirmed()));
    expect(await api("https://down,https://up").txStatus("ABC")).toBe("confirmed");
  });

  it("takes a 404 as the answer rather than failing over", async () => {
    const calls = stubFetch(() => new Response("", { status: 404 }));
    expect(await api("https://a,https://b").txStatus("ABC")).toBe("pending");
    expect(calls).toEqual([`https://a${TX}`]);
  });

  it("keeps the single-LCD reading of an all-5xx deployment lookup", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    expect(await api("https://a,https://b").deploymentInfo("o", "1")).toBeUndefined();
  });
});

describe("failoverFetch", () => {
  it("starts at the given base and wraps around", async () => {
    const calls = stubFetch((u) => (u.startsWith("https://b") ? new Response("", { status: 521 }) : confirmed()));
    const { index } = await failoverFetch(["https://a", "https://b"], TX, 1);
    expect(index).toBe(0);
    expect(calls).toEqual([`https://b${TX}`, `https://a${TX}`]);
  });
});

describe("akashOutageProbe", () => {
  it("names each endpoint that is down, and caches the answer for a minute", async () => {
    let t = 0;
    let down = true;
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (down && url.startsWith("https://api")) return new Response("", { status: 521 });
      if (down) throw new TypeError("fetch failed");
      return new Response("{}");
    }) as unknown as typeof fetch;
    const probe = akashOutageProbe("https://api.akash", "https://rpc.akash:443/", fake, () => t);
    expect(await probe()).toBe("api.akash answers HTTP 521; rpc.akash does not answer (fetch failed)");
    expect(calls).toContain("https://rpc.akash:443/status");
    down = false;
    expect(await probe()).not.toBeNull();
    t = 60_000;
    expect(await probe()).toBeNull();
  });
});
