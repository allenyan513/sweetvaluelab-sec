import { describe, it, expect } from "vitest";
import { decodeItems, filingCategory } from "./eightk-items.js";

describe("decodeItems", () => {
  it("decodes a CSV to labelled items, most-material first", () => {
    const out = decodeItems("9.01,2.02");
    expect(out.map((i) => i.code)).toEqual(["2.02", "9.01"]); // material before routine
    expect(out[0]).toMatchObject({ code: "2.02", category: "material", label: "Results of Operations (Earnings)" });
    expect(out[1]).toMatchObject({ code: "9.01", category: "routine" });
  });

  it("ranks high-materiality items first", () => {
    expect(decodeItems("8.01,1.03,2.02").map((i) => i.code)).toEqual(["1.03", "2.02", "8.01"]);
  });

  it("passes unknown codes through as routine with a generic label", () => {
    expect(decodeItems("99.99")).toEqual([{ code: "99.99", label: "Item 99.99", category: "routine" }]);
  });

  it("tolerates whitespace + empty", () => {
    expect(decodeItems(" 2.02 , 9.01 ").map((i) => i.code)).toEqual(["2.02", "9.01"]);
    expect(decodeItems("")).toEqual([]);
  });
});

describe("filingCategory", () => {
  it("is the most-material item's category", () => {
    expect(filingCategory("2.02,9.01")).toBe("material");
    expect(filingCategory("1.03")).toBe("high");
    expect(filingCategory("9.01")).toBe("routine");
    expect(filingCategory("")).toBe("routine");
  });
});
