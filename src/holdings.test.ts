import { describe, it, expect } from "vitest";
import { diffHoldings, type Holding13F } from "./holdings.js";

describe("diffHoldings", () => {
  const h = (cusip: string, shares: number, putCall = ""): Holding13F => ({
    cusip,
    issuerName: cusip,
    titleOfClass: "COM",
    value: shares,
    shares,
    putCall,
  });

  it("classifies new / added / trimmed / held / exited", () => {
    const prev = [h("A", 10), h("B", 20), h("C", 30)];
    const curr = [h("A", 10), h("B", 25), h("C", 5), h("D", 100)];
    const deltas = diffHoldings(curr, prev);
    const byCusip = Object.fromEntries(deltas.map((d) => [d.cusip, d.change]));
    expect(byCusip).toEqual({ A: "held", B: "added", C: "trimmed", D: "new" });
    // no exits here: all prev appear in curr
    expect(deltas.find((d) => d.change === "exited")).toBeUndefined();
  });

  it("includes exited names absent from the current quarter", () => {
    const deltas = diffHoldings([h("A", 10)], [h("A", 10), h("B", 20)]);
    const exited = deltas.find((d) => d.cusip === "B");
    expect(exited).toMatchObject({ change: "exited", shares: 0, prevShares: 20 });
  });

  it("diffs a share line and a Put on the same CUSIP as two separate positions", () => {
    // SPY stock 10 → 12 (added), SPY Put 5 → 5 (held). Keyed by CUSIP alone, the
    // put would be compared against the stock line and read as trimmed (5 < 12).
    const deltas = diffHoldings([h("SPY", 12), h("SPY", 5, "Put")], [h("SPY", 10), h("SPY", 5, "Put")]);
    expect(deltas.map((d) => [d.putCall, d.change, d.shares, d.prevShares])).toEqual([
      ["", "added", 12, 10],
      ["Put", "held", 5, 5],
    ]);
  });

  it("reports a Put closed while the share line stays as an exited Put, not an exited stock", () => {
    const deltas = diffHoldings([h("SPY", 10)], [h("SPY", 10), h("SPY", 5, "Put")]);
    expect(deltas.map((d) => [d.putCall, d.change])).toEqual([
      ["", "held"],
      ["Put", "exited"],
    ]);
  });
});

// ───────────────────────── #529 I-1: units, amendments, history ─────────────────────────
