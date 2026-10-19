import { describe, it, expect } from "vitest";
import { decodeCode } from "./form4-codes.js";

describe("decodeCode", () => {
  it("flags open-market buy/sell as signals, the rest neutral", () => {
    expect(decodeCode("P")).toEqual({ code: "P", label: "Open-market buy", signal: "buy" });
    expect(decodeCode("S").signal).toBe("sell");
    expect(decodeCode("M")).toEqual({ code: "M", label: "Option/RSU exercise", signal: "neutral" });
    expect(decodeCode("ZZ")).toEqual({ code: "ZZ", label: "Code ZZ", signal: "neutral" });
  });
});
