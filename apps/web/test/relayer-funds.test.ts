import { describe, expect, it } from "vitest";
import { toBase, toDisplay } from "../lib/relayer-funds";

describe("relayer funds amounts", () => {
  it("shows base units in display units", () => {
    expect(toDisplay("2500000", 6)).toBe("2.5");
    expect(toDisplay("10000000", 6)).toBe("10");
    expect(toDisplay("1", 6)).toBe("0.000001");
    expect(toDisplay("0", 6)).toBe("0");
    expect(toDisplay("42", 0)).toBe("42");
  });

  it("parses what the user types back to base units, refusing anything else", () => {
    expect(toBase("2.5", 6)).toBe("2500000");
    expect(toBase("10", 6)).toBe("10000000");
    expect(toBase(".5", 6)).toBe("500000");
    expect(toBase("0.000001", 6)).toBe("1");
    // more decimals than the denom has would silently round: refused
    expect(toBase("0.0000001", 6)).toBeNull();
    expect(toBase("", 6)).toBeNull();
    expect(toBase(".", 6)).toBeNull();
    expect(toBase("1,5", 6)).toBeNull();
    expect(toBase("-1", 6)).toBeNull();
  });
});
