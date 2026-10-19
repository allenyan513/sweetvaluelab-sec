import { describe, it, expect, vi, afterEach } from "vitest";
import { pickTicker, collectBatch, resolveCusips, isCins } from "./openfigi.js";
import { configureSec } from "./settings.js";

configureSec({ userAgent: "qt-sec tests (tests@example.com)" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pickTicker", () => {
  it("prefers the US composite listing", () => {
    expect(
      pickTicker([
        { ticker: "AAPL.MX", exchCode: "MM" },
        { ticker: "AAPL", exchCode: "US", name: "APPLE INC" },
      ]),
    ).toEqual({ ticker: "AAPL", name: "APPLE INC" });
  });
  it("falls back to the first ticketed listing when there is no US composite", () => {
    expect(pickTicker([{ ticker: "ry", exchCode: "TO", name: "Royal Bank" }])).toEqual({
      ticker: "RY",
      name: "Royal Bank",
    });
  });
  it("usOnly refuses the foreign fallback", () => {
    expect(pickTicker([{ ticker: "CSA", exchCode: "GR" }], { usOnly: true })).toBeNull();
    expect(pickTicker([{ ticker: "CSA", exchCode: "GR" }, { ticker: "ACN", exchCode: "US" }], { usOnly: true })).toEqual({ ticker: "ACN", name: null });
  });
  it("returns null when no entry carries a ticker", () => {
    expect(pickTicker([{ exchCode: "US" }])).toBeNull();
    expect(pickTicker([])).toBeNull();
  });
});

describe("isCins", () => {
  it("is a letter in the first position — the foreign-issuer range", () => {
    for (const id of ["G1151C101", "N07059210", "L8681T102", "Y2573F102"]) expect(isCins(id)).toBe(true);
    // A US CUSIP starts with a digit even when letters follow (Berkshire B).
    for (const id of ["037833100", "084670702", "88160R101"]) expect(isCins(id)).toBe(false);
  });
});

describe("collectBatch", () => {
  it("aligns results to request CUSIPs by index and skips misses", () => {
    const m = collectBatch(
      ["037833100", "000000000", "191216100"],
      [
        { data: [{ ticker: "AAPL", exchCode: "US", name: "APPLE INC" }] },
        { warning: "No identifier found." },
        { data: [{ ticker: "KO", exchCode: "US" }] },
      ],
    );
    expect(m.get("037833100")).toEqual({ ticker: "AAPL", name: "APPLE INC" });
    expect(m.has("000000000")).toBe(false); // warning → unmapped
    expect(m.get("191216100")).toEqual({ ticker: "KO", name: null });
    expect(m.size).toBe(2);
  });
});

describe("resolveCusips", () => {
  it("dedupes + uppercases, batches under the anonymous 10-job cap, returns a map", async () => {
    const cusips = Array.from({ length: 12 }, (_, i) => `G${String(i).padStart(8, "0")}`);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const jobs = JSON.parse(String((init as RequestInit).body)) as { idValue: string }[];
      const results = jobs.map((j) => ({ data: [{ ticker: `T_${j.idValue}`, exchCode: "US" }] }));
      return new Response(JSON.stringify(results), { status: 200 });
    });
    // Feed duplicates + a lowercase dup — all collapse to the 12 distinct CUSIPs.
    const out = await resolveCusips([...cusips, ...cusips, "g00000000"]);
    expect(spy).toHaveBeenCalledTimes(2); // 12 distinct / 10 per batch → 2 requests
    expect(out.size).toBe(12);
    expect(out.get("G00000000")).toEqual({ ticker: "T_G00000000", name: null });
  });

  it("sends a CINS as ID_CINS and takes its US composite over the home-market lines", async () => {
    // Shaped on OpenFIGI's real answer for Accenture's CINS: seven "CSA" lines on
    // German venues come first, the US composite last.
    const accenture = [
      ...["GR", "GF", "GD", "GY", "GS", "GM", "GH"].map((exchCode) => ({ ticker: "CSA", exchCode, name: "ACCENTURE PLC-CL A" })),
      { ticker: "ACN", exchCode: "US", name: "ACCENTURE PLC-CL A" },
    ];
    let sent: { idType: string; idValue: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent = JSON.parse(String((init as RequestInit).body)) as typeof sent;
      const byId: Record<string, unknown> = {
        "037833100": { data: [{ ticker: "AAPL", exchCode: "US", name: "APPLE INC" }] },
        G1151C101: { data: accenture },
        // A CINS listed only abroad: no US composite, so no ticker (left to tombstone).
        G9999Z999: { data: [{ ticker: "XYZ", exchCode: "LN", name: "FOREIGN ONLY PLC" }] },
      };
      return new Response(JSON.stringify(sent.map((j) => byId[j.idValue] ?? { warning: "No identifier found." })), { status: 200 });
    });
    const out = await resolveCusips(["037833100", "G1151C101", "G9999Z999"]);
    expect(sent).toEqual([
      { idType: "ID_CUSIP", idValue: "037833100" },
      { idType: "ID_CINS", idValue: "G1151C101" },
      { idType: "ID_CINS", idValue: "G9999Z999" },
    ]);
    expect(out.get("G1151C101")).toEqual({ ticker: "ACN", name: "ACCENTURE PLC-CL A" });
    expect(out.get("037833100")).toEqual({ ticker: "AAPL", name: "APPLE INC" });
    expect(out.has("G9999Z999")).toBe(false);
  });

  it("retries on 429 then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n += 1;
      if (n === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify([{ data: [{ ticker: "AAPL", exchCode: "US" }] }]), { status: 200 });
    });
    const p = resolveCusips(["037833100"]);
    await vi.runAllTimersAsync(); // flush the backoff sleep
    const out = await p;
    expect(n).toBe(2);
    expect(out.get("037833100")).toEqual({ ticker: "AAPL", name: null });
  });
});
