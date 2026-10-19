import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isQuarterDuration,
  isAnnualDuration,
  selectByEnd,
  mapCompanyFactsToStatements,
  fetchCompanyFacts,
  reconcileRevenue,
  resolveCapitalExpenditure,
  settleShareCounts,
  withDerivedQuarters,
  type CompanyFacts,
  type XbrlFact,
} from "./edgar.js";
import { configureSec } from "./settings.js";

configureSec({ userAgent: "qt-sec tests (tests@example.com)" });

const fact = (f: Partial<XbrlFact> & Pick<XbrlFact, "end" | "val" | "filed">): XbrlFact => ({ form: "10-Q", ...f });

describe("fetchCompanyFacts collapses concurrent same-CIK calls", () => {
  afterEach(() => vi.restoreAllMocks());
  it("issues a single network fetch and shares the result", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ facts: {} }), { status: 200 }));
    // Distinct CIK so a prior test's settled in-flight entry can't interfere.
    const [a, b, c] = await Promise.all([
      fetchCompanyFacts(424242),
      fetchCompanyFacts(424242),
      fetchCompanyFacts(424242),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("isQuarterDuration", () => {
  it("accepts a ~13-week quarter (91 days)", () => {
    expect(isQuarterDuration(fact({ start: "2019-09-29", end: "2019-12-28", val: 1, filed: "2020-01-29" }))).toBe(true);
  });
  it("rejects a 6-month YTD duration", () => {
    expect(isQuarterDuration(fact({ start: "2019-06-30", end: "2019-12-28", val: 1, filed: "2020-01-29" }))).toBe(false);
  });
  it("accepts the 16-week quarter of a 12-12-12-16 calendar, up to 120 days (COST's Q4)", () => {
    expect(isQuarterDuration(fact({ start: "2026-05-11", end: "2026-08-30", val: 1, filed: "2026-10-07" }))).toBe(true); // 111 days
    expect(isQuarterDuration(fact({ start: "2026-01-01", end: "2026-05-01", val: 1, filed: "2026-06-01" }))).toBe(true); // 120 days
    expect(isQuarterDuration(fact({ start: "2026-01-01", end: "2026-05-02", val: 1, filed: "2026-06-01" }))).toBe(false); // 121 days
  });
  it("rejects an annual duration", () => {
    expect(isQuarterDuration(fact({ start: "2019-01-01", end: "2019-12-31", val: 1, filed: "2020-02-01" }))).toBe(false);
  });
  it("rejects an instant (no start)", () => {
    expect(isQuarterDuration(fact({ end: "2019-12-28", val: 1, filed: "2020-01-29" }))).toBe(false);
  });
});

describe("isAnnualDuration", () => {
  it("accepts a ~52-week fiscal year (364 days)", () => {
    expect(isAnnualDuration(fact({ start: "2018-09-30", end: "2019-09-28", val: 1, filed: "2019-10-31" }))).toBe(true);
  });
  it("accepts a calendar year (365 days)", () => {
    expect(isAnnualDuration(fact({ start: "2019-01-01", end: "2019-12-31", val: 1, filed: "2020-02-01" }))).toBe(true);
  });
  it("rejects a ~13-week quarter", () => {
    expect(isAnnualDuration(fact({ start: "2019-09-29", end: "2019-12-28", val: 1, filed: "2020-01-29" }))).toBe(false);
  });
  it("rejects a 9-month YTD duration", () => {
    expect(isAnnualDuration(fact({ start: "2019-01-01", end: "2019-09-30", val: 1, filed: "2019-10-31" }))).toBe(false);
  });
  it("rejects an instant (no start)", () => {
    expect(isAnnualDuration(fact({ end: "2019-09-28", val: 1, filed: "2019-10-31" }))).toBe(false);
  });
});

describe("selectByEnd", () => {
  it("keeps only 10-Q facts and picks the earliest-filed per period end (PIT original)", () => {
    const facts: XbrlFact[] = [
      fact({ start: "2019-09-29", end: "2019-12-28", val: 100, filed: "2020-01-29" }), // original
      fact({ start: "2019-09-29", end: "2019-12-28", val: 105, filed: "2020-10-30" }), // restated comparative — ignored
      { form: "10-K", start: "2019-09-29", end: "2019-12-28", val: 999, filed: "2020-11-01" }, // wrong form — ignored
    ];
    const picks = selectByEnd(facts, isQuarterDuration);
    expect(picks.get("2019-12-28")).toEqual({ val: 100, filed: "2020-01-29" });
  });
});

// Minimal companyfacts: one quarter (end 2019-12-28) across all three statements,
// with YTD / annual / wrong-form decoys that must be filtered out.
const FACTS: CompanyFacts = {
  entityName: "Test Co",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            { start: "2019-09-29", end: "2019-12-28", val: 1000, form: "10-Q", filed: "2020-01-29" },
            { start: "2019-06-30", end: "2019-12-28", val: 2000, form: "10-Q", filed: "2020-01-29" }, // YTD decoy
          ],
        },
      },
      OperatingIncomeLoss: {
        units: { USD: [{ start: "2019-09-29", end: "2019-12-28", val: 300, form: "10-Q", filed: "2020-01-29" }] },
      },
      NetIncomeLoss: {
        units: { USD: [{ start: "2019-09-29", end: "2019-12-28", val: 250, form: "10-Q", filed: "2020-01-29" }] },
      },
      EarningsPerShareDiluted: {
        units: { "USD/shares": [{ start: "2019-09-29", end: "2019-12-28", val: 1.25, form: "10-Q", filed: "2020-01-29" }] },
      },
      Assets: {
        units: { USD: [{ end: "2019-12-28", val: 50000, form: "10-Q", filed: "2020-01-29" }] },
      },
      CashAndCashEquivalentsAtCarryingValue: {
        units: { USD: [{ end: "2019-12-28", val: 8000, form: "10-Q", filed: "2020-01-29" }] },
      },
      LongTermDebtNoncurrent: { units: { USD: [{ end: "2019-12-28", val: 4000, form: "10-Q", filed: "2020-01-29" }] } },
      LongTermDebtCurrent: { units: { USD: [{ end: "2019-12-28", val: 1000, form: "10-Q", filed: "2020-01-29" }] } },
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [{ start: "2019-09-29", end: "2019-12-28", val: 400, form: "10-Q", filed: "2020-01-29" }] },
      },
      DepreciationDepletionAndAmortization: {
        units: { USD: [{ start: "2019-09-29", end: "2019-12-28", val: 90, form: "10-Q", filed: "2020-01-29" }] },
      },
      PaymentsToAcquirePropertyPlantAndEquipment: {
        units: { USD: [{ start: "2019-09-29", end: "2019-12-28", val: 120, form: "10-Q", filed: "2020-01-29" }] },
      },
      PaymentsOfDividendsCommonStock: {
        units: { USD: [{ start: "2019-09-29", end: "2019-12-28", val: 60, form: "10-Q", filed: "2020-01-29" }] },
      },
    },
  },
};

describe("mapCompanyFactsToStatements (quarter)", () => {
  const { income, balance, cashflow } = mapCompanyFactsToStatements("test", FACTS, "quarter");

  it("maps income concepts to FMP field names, quarterly only (YTD excluded)", () => {
    expect(income).toHaveLength(1);
    const r = income[0]!;
    expect(r.symbol).toBe("TEST");
    expect(r.date).toBe("2019-12-28");
    expect(r.revenue).toBe(1000); // not the 2000 YTD
    expect(r.netIncome).toBe(250);
    expect(r.epsDiluted).toBe(1.25);
    expect(r.acceptedDate).toBe("2020-01-29");
  });

  it("derives EBITDA = operatingIncome + D&A", () => {
    expect(income[0]!.ebitda).toBe(390);
  });

  it("composes total debt from current + non-current", () => {
    expect(balance[0]!.totalDebt).toBe(5000);
    expect(balance[0]!.cashAndCashEquivalents).toBe(8000);
  });

  it("negates outflows to FMP sign and derives free cash flow", () => {
    const r = cashflow[0]!;
    expect(r.operatingCashFlow).toBe(400);
    expect(r.capitalExpenditure).toBe(-120); // sign-flipped
    expect(r.commonDividendsPaid).toBe(-60); // sign-flipped
    expect(r.freeCashFlow).toBe(280); // 400 - 120
  });

  it("returns empty statements for a payload with no us-gaap facts", () => {
    const empty = mapCompanyFactsToStatements("x", { facts: {} }, "quarter");
    expect(empty.income).toEqual([]);
    expect(empty.balance).toEqual([]);
    expect(empty.cashflow).toEqual([]);
  });
});

// Annual: a 10-K full fiscal year (end 2019-09-28) across all three statements,
// with a 10-Q quarterly decoy (wrong form) that the annual path must filter out.
const FACTS_ANNUAL: CompanyFacts = {
  entityName: "Annual Co",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            { start: "2018-09-30", end: "2019-09-28", val: 260000, form: "10-K", filed: "2019-10-31" },
            { start: "2019-06-30", end: "2019-09-28", val: 64000, form: "10-Q", filed: "2019-10-31" }, // quarter decoy — wrong form
          ],
        },
      },
      OperatingIncomeLoss: {
        units: { USD: [{ start: "2018-09-30", end: "2019-09-28", val: 63000, form: "10-K", filed: "2019-10-31" }] },
      },
      NetIncomeLoss: {
        units: { USD: [{ start: "2018-09-30", end: "2019-09-28", val: 55000, form: "10-K", filed: "2019-10-31" }] },
      },
      Assets: {
        units: { USD: [{ end: "2019-09-28", val: 338000, form: "10-K", filed: "2019-10-31" }] },
      },
      LongTermDebtNoncurrent: { units: { USD: [{ end: "2019-09-28", val: 90000, form: "10-K", filed: "2019-10-31" }] } },
      LongTermDebtCurrent: { units: { USD: [{ end: "2019-09-28", val: 10000, form: "10-K", filed: "2019-10-31" }] } },
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [{ start: "2018-09-30", end: "2019-09-28", val: 69000, form: "10-K", filed: "2019-10-31" }] },
      },
      DepreciationDepletionAndAmortization: {
        units: { USD: [{ start: "2018-09-30", end: "2019-09-28", val: 12000, form: "10-K", filed: "2019-10-31" }] },
      },
      PaymentsToAcquirePropertyPlantAndEquipment: {
        units: { USD: [{ start: "2018-09-30", end: "2019-09-28", val: 10000, form: "10-K", filed: "2019-10-31" }] },
      },
    },
  },
};

describe("mapCompanyFactsToStatements (annual)", () => {
  const { income, balance, cashflow } = mapCompanyFactsToStatements("annl", FACTS_ANNUAL, "annual");

  it("picks the 10-K full-year figure and tags period FY (quarter decoy excluded)", () => {
    expect(income).toHaveLength(1);
    const r = income[0]!;
    expect(r.symbol).toBe("ANNL");
    expect(r.date).toBe("2019-09-28");
    expect(r.period).toBe("FY");
    expect(r.revenue).toBe(260000); // not the 64000 10-Q quarter
    expect(r.netIncome).toBe(55000);
    expect(r.acceptedDate).toBe("2019-10-31");
  });

  it("derives full-year EBITDA, total debt, and free cash flow", () => {
    expect(income[0]!.ebitda).toBe(75000); // 63000 + 12000
    expect(balance[0]!.totalDebt).toBe(100000); // 90000 + 10000
    const cf = cashflow[0]!;
    expect(cf.capitalExpenditure).toBe(-10000); // sign-flipped
    expect(cf.freeCashFlow).toBe(59000); // 69000 - 10000
  });

  it("ignores 10-K facts when asked for quarter (form gate is symmetric)", () => {
    const q = mapCompanyFactsToStatements("annl", FACTS_ANNUAL, "quarter");
    // Only the 10-Q revenue fact survives; 10-K-only fields (netIncome, …) are gated out.
    expect(q.income[0]?.revenue).toBe(64000); // the 10-Q quarter, not the 260000 annual
    expect(q.income[0]?.netIncome).toBeUndefined();
  });
});

// A filer that migrated its revenue tag mid-history: older year under
// `RevenueFromContractWithCustomerExcludingAssessedTax`, newer under `Revenues`
// (NVDA does exactly this). Neither concept alone covers all years; resolve()
// must merge by period-end so every year keeps a revenue.
const FACTS_TAG_MIGRATION: CompanyFacts = {
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [{ start: "2021-01-01", end: "2021-12-31", val: 100, form: "10-K", filed: "2022-02-01" }] },
      },
      Revenues: {
        units: { USD: [{ start: "2022-01-01", end: "2022-12-31", val: 200, form: "10-K", filed: "2023-02-01" }] },
      },
    },
  },
};

describe("resolve merges candidate concepts by period-end", () => {
  it("keeps revenue for years that switched us-gaap tag", () => {
    const { income } = mapCompanyFactsToStatements("mig", FACTS_TAG_MIGRATION, "annual");
    const byEnd = Object.fromEntries(income.map((r) => [r.date, r.revenue]));
    expect(byEnd["2021-12-31"]).toBe(100); // from RevenueFromContractWithCustomer…
    expect(byEnd["2022-12-31"]).toBe(200); // from Revenues — would be dropped by first-match-wins
  });
});

// D&A filed as two lines rather than one combined tag (MSFT, ADI, IBM…, #446):
// 26 of the public universe had no EBITDA, so EV/EBITDA was N/A for them.
const annualFact = (end: string, val: number): XbrlFact => ({ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, form: "10-K", filed: `${Number(end.slice(0, 4))}-12-20` });
const FACTS_SPLIT_DA: CompanyFacts = {
  facts: {
    "us-gaap": {
      Revenues: { units: { USD: [annualFact("2024-06-30", 1000), annualFact("2025-06-30", 1200)] } },
      OperatingIncomeLoss: { units: { USD: [annualFact("2024-06-30", 400), annualFact("2025-06-30", 500)] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [annualFact("2024-06-30", 450), annualFact("2025-06-30", 560)] } },
      // The combined tag until FY2024, the two halves after the switch.
      DepreciationDepletionAndAmortization: { units: { USD: [annualFact("2024-06-30", 90)] } },
      Depreciation: { units: { USD: [annualFact("2024-06-30", 70), annualFact("2025-06-30", 80)] } },
      AmortizationOfIntangibleAssets: { units: { USD: [annualFact("2024-06-30", 21), annualFact("2025-06-30", 30)] } },
    },
  },
};

describe("D&A resolution when no combined tag is filed", () => {
  const { income, cashflow } = mapCompanyFactsToStatements("split", FACTS_SPLIT_DA, "annual");
  const byEnd = <T extends Record<string, unknown>>(rows: T[], field: string) => Object.fromEntries(rows.map((r) => [r.date, r[field]]));

  it("uses the combined tag where filed and depreciation + amortization after the switch", () => {
    expect(byEnd(income, "ebitda")).toEqual({ "2024-06-30": 490, "2025-06-30": 610 }); // 400 + 90, 500 + 80 + 30
    expect(byEnd(cashflow, "depreciationAndAmortization")).toEqual({ "2024-06-30": 90, "2025-06-30": 110 });
  });

  it("takes depreciation alone once the amortization has run off (TXN)", () => {
    const facts: CompanyFacts = {
      facts: { "us-gaap": { OperatingIncomeLoss: { units: { USD: [annualFact("2025-12-31", 600)] } }, Depreciation: { units: { USD: [annualFact("2025-12-31", 190)] } } } },
    };
    expect(mapCompanyFactsToStatements("txn", facts, "annual").income[0]!.ebitda).toBe(790);
  });

  it("falls back to the cash-flow OtherDepreciationAndAmortization total (WDAY)", () => {
    const facts: CompanyFacts = {
      facts: { "us-gaap": { OperatingIncomeLoss: { units: { USD: [annualFact("2026-01-31", 720)] } }, OtherDepreciationAndAmortization: { units: { USD: [annualFact("2026-01-31", 347)] } } } },
    };
    expect(mapCompanyFactsToStatements("wday", facts, "annual").income[0]!.ebitda).toBe(1067);
  });
});

// The D&A in cost of sales (`CostOfGoodsAndServicesSoldDepreciationAndAmortization`)
// is a part of the total: it corrects only a reading smaller than itself. FY 10-K
// figures in $M.
describe("D&A when part of it sits in cost of sales", () => {
  const da = (tags: Record<string, number>, end = "2025-12-31") => {
    const usGaap = Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, { units: { USD: [annualFact(end, v)] } }]));
    const { income, cashflow } = mapCompanyFactsToStatements("da", { facts: { "us-gaap": { NetCashProvidedByUsedInOperatingActivities: { units: { USD: [annualFact(end, 5_000)] } }, ...usGaap } } }, "annual");
    return { ebitda: income[0]?.ebitda, cashflow: cashflow[0]!.depreciationAndAmortization };
  };

  it("adds it to the DepreciationAndAmortization line it sits beside (URI 2025: 438 + 2,670)", () => {
    // EBITDA and the cash-flow line read the same figure: 3,973 + 3,108.
    expect(da({ OperatingIncomeLoss: 3_973, DepreciationAndAmortization: 438, CostOfGoodsAndServicesSoldDepreciationAndAmortization: 2_670 })).toEqual({ ebitda: 7_081, cashflow: 3_108 });
  });

  it("takes it over a smaller tag defined as the whole, never on top (HD FY2025: 4,059, not 7,573)", () => {
    const hd = { OperatingIncomeLoss: 20_890, DepreciationDepletionAndAmortization: 3_514, DepreciationAndAmortization: 3_273, CostOfGoodsAndServicesSoldDepreciationAndAmortization: 4_059 };
    expect(da(hd, "2026-02-01")).toEqual({ ebitda: 24_949, cashflow: 4_059 });
  });

  it("ignores it inside a larger total (CF 2025: 898 with 892 of it in cost of sales)", () => {
    expect(da({ OperatingIncomeLoss: 2_300, DepreciationDepletionAndAmortization: 898, CostOfGoodsAndServicesSoldDepreciationAndAmortization: 892 })).toEqual({ ebitda: 3_198, cashflow: 898 });
  });

  it("ignores it when it equals the line, which is then the whole (CASY FY2026)", () => {
    expect(da({ DepreciationAndAmortization: 449.958, CostOfGoodsAndServicesSoldDepreciationAndAmortization: 449.958 }, "2026-04-30").cashflow).toBe(449.958);
  });

  it("is the floor when it is the only D&A filed (PEG 2025)", () => {
    expect(da({ OperatingIncomeLoss: 2_980, CostOfGoodsAndServicesSoldDepreciationAndAmortization: 1_257 })).toEqual({ ebitda: 4_237, cashflow: 1_257 });
  });
});

// Non-recurring charges (#475): each group takes the larger of its aggregate and
// the sum of its parts, so a charge tagged at three levels counts once.
describe("resolveNonRecurringCharges via the annual income rows", () => {
  const tag = (end: string, val: number) => ({ units: { USD: [annualFact(end, val)] } });
  const nr = (usGaap: Record<string, { units: { USD: XbrlFact[] } }>) =>
    mapCompanyFactsToStatements("nr", { facts: { "us-gaap": { OperatingIncomeLoss: tag("2026-05-31", 886), ...usGaap } } }, "annual").income[0]!.nonRecurringCharges;

  it("counts goodwill + intangibles once when their total is also tagged (GIS)", () => {
    expect(nr({ GoodwillImpairmentLoss: tag("2026-05-31", 1500), ImpairmentOfIntangibleAssetsExcludingGoodwill: tag("2026-05-31", 303), GoodwillAndIntangibleAssetImpairment: tag("2026-05-31", 1750) })).toBe(1803);
  });

  it("takes a restructuring + impairment total over its parts when it is larger", () => {
    expect(nr({ GoodwillImpairmentLoss: tag("2026-05-31", 1500), RestructuringCharges: tag("2026-05-31", 400), RestructuringCostsAndAssetImpairmentCharges: tag("2026-05-31", 2898) })).toBe(2898);
  });

  it("adds deal costs and a disposal LOSS, and ignores a disposal gain (OMC / GIS)", () => {
    expect(nr({ RestructuringCharges: tag("2026-05-31", 1247), BusinessCombinationAcquisitionRelatedCosts: tag("2026-05-31", 347), GainLossOnSaleOfBusiness: tag("2026-05-31", -547) })).toBe(2141);
    expect(nr({ RestructuringCharges: tag("2026-05-31", 100), GainLossOnSaleOfBusiness: tag("2026-05-31", 1049) })).toBe(100);
  });

  it("stores nothing for a year without charges, or with a reversal", () => {
    expect(nr({})).toBeUndefined();
    expect(nr({ RestructuringCosts: tag("2026-05-31", -13) })).toBeUndefined();
  });
});

// Total debt (2026-10): 97 of the 518 kept only their current debt because the
// long-term line was tagged `LongTermDebtAndCapitalLeaseObligations`. Figures are
// the companies' FY2025 10-K balances in $M, trimmed to the tags that decide.
describe("total debt composition", () => {
  const instant = (end: string, val: number, filed = "2026-02-03"): XbrlFact => ({ end, val, form: "10-K", filed });
  const debt = (tags: Record<string, number>, end = "2025-12-31") =>
    mapCompanyFactsToStatements(
      "debt",
      { facts: { "us-gaap": { Assets: { units: { USD: [instant(end, 1_000_000)] } }, ...Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, { units: { USD: [instant(end, v)] } }])) } } },
      "annual",
    ).balance[0]!.totalDebt;

  it("reads the long-term line under LongTermDebtAndCapitalLeaseObligations (CMCSA)", () => {
    // 92,980 non-current + 5,958 current; until the fix only the 5,958 counted.
    expect(debt({ LongTermDebtAndCapitalLeaseObligations: 92_980, DebtCurrent: 5_958 })).toBe(98_938);
  });

  it("takes DebtCurrent as the whole current line, not again with commercial paper (EMR)", () => {
    // DebtCurrent 4,800 already holds the 4,200 of commercial paper and 600 of maturities.
    expect(debt({ LongTermDebtNoncurrent: 8_300, DebtCurrent: 4_800, LongTermDebtCurrent: 600, CommercialPaper: 4_200 })).toBe(13_100);
  });

  it("adds short-term borrowings to current maturities when there is no DebtCurrent (HSIC)", () => {
    expect(debt({ LongTermDebtAndCapitalLeaseObligations: 2_310, LongTermDebtCurrent: 40, ShortTermBorrowings: 760 })).toBe(3_110);
  });

  it("reads LongTermDebt as the non-current line when the filer's total says so (TSLA)", () => {
    // 6,580 + 1,570 current = 8,150, against a carrying amount of 8,180; 6,580 alone is further off.
    expect(debt({ LongTermDebt: 6_580, DebtCurrent: 1_570, DebtInstrumentCarryingAmount: 8_180 })).toBe(8_150);
  });

  it("reads LongTermDebt as including current maturities when the filer's total says so (VRSK)", () => {
    // Total 4,740 ≈ LongTermDebt 4,770; adding the 1,510 current would give 6,280.
    expect(debt({ LongTermDebt: 4_770, LongTermDebtCurrent: 1_510, DebtLongtermAndShorttermCombinedAmount: 4_740 })).toBe(4_770);
  });

  it("takes LongTermDebt as the non-current line when there is no total to check against", () => {
    expect(debt({ LongTermDebt: 500, DebtCurrent: 500 })).toBe(1_000);
  });

  it("skips a zero non-current fact filed beside the real line (TYL)", () => {
    expect(debt({ LongTermDebtNoncurrent: 0, LongTermDebt: 600 })).toBe(600);
  });

  it("does not anchor on a sliver of 'other' long-term debt (CPAY)", () => {
    // 4 of other non-current debt; the line is LongTermNotesAndLoans 6,656 + 3,346 current.
    expect(debt({ OtherLongTermDebtNoncurrent: 4, LongTermNotesAndLoans: 6_656, LongTermDebtCurrent: 3_346, LongTermDebt: 10_002 })).toBe(10_002);
    // …but it is still the debt of a filer that tags nothing else (XYZ): 5,700 + 1,600.
    expect(debt({ OtherLongTermDebtNoncurrent: 5_700, DebtCurrent: 1_600 })).toBe(7_300);
  });

  it("passes over a sliver tagged as the non-current line (EXC FY2024)", () => {
    // 20 of LongTermNotesPayable is under half of LongTermDebt 44,670, so LongTermDebt
    // carries the line: 44,670 + 1,450 current + 1,860 short-term = 47,980 (not 3,330).
    expect(debt({ LongTermNotesPayable: 20, LongTermDebtCurrent: 1_450, ShortTermBorrowings: 1_860, LongTermDebt: 44_670 })).toBe(47_980);
  });

  it("keeps the split when its non-current line is the bulk of LongTermDebt (AWK, TMO)", () => {
    expect(debt({ LongTermDebtNoncurrent: 12_780, DebtCurrent: 3_060, LongTermDebt: 12_780 })).toBe(15_840);
    expect(debt({ LongTermDebtAndCapitalLeaseObligations: 30_280, DebtCurrent: 5_120, LongTermDebt: 35_200 })).toBe(35_400);
  });

  it("uses the filer's combined total when there is no split (SMCI)", () => {
    expect(debt({ DebtLongtermAndShorttermCombinedAmount: 4_060 })).toBe(4_060);
  });

  it("falls back to notes payable of unknown classification (Realty Income)", () => {
    expect(debt({ NotesPayable: 25_000, ShortTermBorrowings: 1_700 })).toBe(26_700);
  });

  it("adds secured and unsecured debt when nothing else is tagged (ESS 2025, AIZ)", () => {
    // 6,015.921 unsecured + 784.348 of mortgage notes; until 2026-10 ESS read as no debt.
    expect(debt({ UnsecuredDebt: 6_015.921, SecuredDebt: 784.348 })).toBeCloseTo(6_800.269, 6);
    expect(debt({ UnsecuredDebt: 2_206.9 })).toBe(2_206.9);
  });

  it("passes over a LongTermDebt that is a sliver beside the notes (ESS 2021, PHM 2025)", () => {
    // ESS tagged only its 638.959 of mortgages as LongTermDebt: 5,307.196 + 638.957.
    expect(debt({ LongTermDebt: 638.959, UnsecuredDebt: 5_307.196, SecuredDebt: 638.957, SeniorNotes: 0 })).toBeCloseTo(5_946.153, 6);
    // PHM: 43.9 beside 1,631.098 of notes payable, of which the 1,583.913 senior notes are a part.
    expect(debt({ LongTermDebt: 43.9, NotesPayable: 1_631.098, SeniorNotes: 1_583.913 })).toBe(1_631.098);
  });

  it("takes the filer's total once LongTermDebt is passed over (HST 2025)", () => {
    // 1,274 of LongTermDebt beside 3,986 of senior notes; the total 5,077 wins over the notes.
    expect(debt({ LongTermDebt: 1_274, SeniorNotes: 3_986, SecuredDebt: 95, DebtAndCapitalLeaseObligations: 5_077 })).toBe(5_077);
  });

  it("passes over a LongTermDebt that is the joint ventures' debt, not the filer's (HST, trimmed companyfacts)", () => {
    // Host's `LongTermDebt` is the "Total Debt" column of Note 4 (Investments in
    // Affiliates); its own debt is `DebtAndCapitalLeaseObligations`, the balance
    // sheet's "Total debt". In FY2016 and FY2017 the affiliates' figure is over
    // half of the senior notes (1,215 ≥ 2,380 / 2; 1,496 ≥ 2,778 / 2), so the
    // notes cannot tell; under half of Host's own total (1,215 < 3,649 / 2;
    // 1,496 < 3,954 / 2; 1,274 < 5,077 / 2) it is passed over in every year.
    const at = (end: string, val: number, accn: string, filed: string, fy: number): XbrlFact => ({ end, val: val * 1e6, accn, filed, fy, fp: "FY", form: "10-K" });
    const fy16 = ["0001564590-17-002348", "2017-02-24", 2016] as const;
    const fy17 = ["0001564590-18-003330", "2018-02-27", 2017] as const;
    const fy25 = ["0001070750-26-000054", "2026-02-25", 2025] as const;
    const tag = (vals: [number, number, number]) => ({ units: { USD: [at("2016-12-31", vals[0], ...fy16), at("2017-12-31", vals[1], ...fy17), at("2025-12-31", vals[2], ...fy25)] } });
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          Assets: tag([11_408, 11_693, 13_049]),
          LongTermDebt: tag([1_215, 1_496, 1_274]),
          SeniorNotes: tag([2_380, 2_778, 3_986]),
          SecuredDebt: tag([63, 6, 95]),
          LineOfCredit: tag([1_206, 1_170, 996]),
          DebtAndCapitalLeaseObligations: tag([3_649, 3_954, 5_077]),
        },
      },
    };
    const rows = mapCompanyFactsToStatements("HST", facts, "annual").balance;
    expect(Object.fromEntries(rows.map((r) => [r.date, r.totalDebt]))).toEqual({
      "2016-12-31": 3_649e6,
      "2017-12-31": 3_954e6,
      "2025-12-31": 5_077e6,
    });
  });

  it("keeps LongTermDebt from half the filer's total up, current debt included, and passes it over below", () => {
    // 470 + 30 current is exactly half of 1,000: kept, as the non-current reading
    // (500 is nearer 1,000 than 470 is). One less and the total is the debt.
    expect(debt({ LongTermDebt: 470, DebtCurrent: 30, DebtAndCapitalLeaseObligations: 1_000 })).toBe(500);
    expect(debt({ LongTermDebt: 469, DebtCurrent: 30, DebtAndCapitalLeaseObligations: 1_000 })).toBe(1_000);
    // TSLA 2022: 1,029 of LongTermDebt is under half its carrying amount of 2,061,
    // but with the 1,016 current it is the whole: 2,045, not the 2,061 footnote.
    expect(debt({ LongTermDebt: 1_029, DebtCurrent: 1_016, DebtInstrumentCarryingAmount: 2_061 })).toBe(2_045);
  });

  it("keeps LongTermDebt from half the notes up, current debt included, and passes it over below", () => {
    expect(debt({ LongTermDebt: 470, NotesPayable: 1_000, DebtCurrent: 30 })).toBe(500);
    expect(debt({ LongTermDebt: 469, NotesPayable: 1_000, DebtCurrent: 30 })).toBe(1_030);
    // The notes are weighed by the larger reading: secured + unsecured here.
    expect(debt({ LongTermDebt: 499, NotesPayable: 900, SecuredDebt: 300, UnsecuredDebt: 700 })).toBe(1_000);
  });

  it("weighs LongTermDebt with the current debt against notes that hold both (SWKS FY2025)", () => {
    // 496.4 non-current + 499.4 current = the 995.8 of senior notes; 496.4 alone is under
    // half of them, but passing it over would add the current debt to the notes again (1,495.2).
    // (The 10-K also files the 995.8 as a combined total; its 10-Qs do not, so it is left out.)
    expect(debt({ LongTermDebt: 496.4, DebtCurrent: 499.4, SeniorNotes: 995.8 })).toBeCloseTo(995.8, 6);
  });

  it("reads SWKS's quarters the same way as its year (trimmed companyfacts, #803 backfill dry run)", () => {
    // SWKS has $1B of notes ($500M due 2026, $500M due 2031). Its 10-Qs file
    // LongTermDebt (the 2031 half), DebtCurrent (the 2026 half) and SeniorNotes
    // (both), and no combined total; the 10-K adds the combined total. Before the
    // fix the quarters read 496.2 + 499.2 + 995.4 = 1,494.6 (the current half
    // twice) while the year read 995.8. After the 2026 notes are repaid the
    // current line is 0 and the notes are the 2031 half alone.
    const at = (end: string, val: number, form: string, accn: string, filed: string): XbrlFact => ({ end, val: val * 1e5, form, accn, filed });
    const q3fy25 = ["10-Q", "0000004127-25-000073", "2025-08-05"] as const;
    const fy25 = ["10-K", "0000004127-25-000085", "2025-11-07"] as const;
    const q2fy26 = ["10-Q", "0000004127-26-000015", "2026-05-05"] as const;
    const q3fy26 = ["10-Q", "0000004127-26-000049", "2026-07-28"] as const;
    // [2025-06-27, 2025-10-03, 2026-04-03, 2026-07-03], in $0.1M; the 10-K's figure at its own end.
    const tag = (v: [number, number, number, number] | [null, number, null, null]) => ({
      units: {
        USD: [
          v[0] === null ? null : at("2025-06-27", v[0], ...q3fy25),
          at("2025-10-03", v[1], ...fy25),
          v[2] === null ? null : at("2026-04-03", v[2], ...q2fy26),
          v[3] === null ? null : at("2026-07-03", v[3], ...q3fy26),
        ].filter((f): f is XbrlFact => f !== null),
      },
    });
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          Assets: tag([77_146, 79_170, 78_960, 74_250]),
          LongTermDebt: tag([4_962, 4_964, 4_967, 4_969]),
          DebtCurrent: tag([4_992, 4_994, 4_999, 0]),
          SeniorNotes: tag([9_954, 9_958, 9_966, 4_969]),
          DebtLongtermAndShorttermCombinedAmount: tag([null, 9_958, null, null]),
        },
      },
    };
    const byDate = (period: "annual" | "quarter") => Object.fromEntries(mapCompanyFactsToStatements("SWKS", facts, period).balance.map((r) => [r.date, r.totalDebt]));
    const quarters = byDate("quarter");
    expect(quarters["2025-06-27"]).toBeCloseTo(995.4e6, 0);
    expect(quarters["2026-04-03"]).toBeCloseTo(996.6e6, 0);
    expect(quarters["2026-07-03"]).toBeCloseTo(496.9e6, 0);
    expect(byDate("annual")["2025-10-03"]).toBeCloseTo(995.8e6, 0);
  });

  it("takes the larger of the unclassified notes and the security split (Realty Income)", () => {
    // 25,031.947 of notes payable beside 37.761 of mortgages: not 37.761, and not both.
    expect(debt({ NotesPayable: 25_031.947, SecuredDebt: 37.761 })).toBe(25_031.947);
  });

  it("never lets the security split overrule a maturity split (DUK)", () => {
    // 80,108 non-current + 7,104 current + 2,624 short-term; the 35,585 + 4,279 footnote split is a subset.
    expect(debt({ LongTermDebtNoncurrent: 80_108, LongTermDebtCurrent: 7_104, ShortTermBorrowings: 2_624, LongTermDebt: 87_212, UnsecuredDebt: 35_585, SecuredDebt: 4_279 })).toBe(89_836);
  });

  it("leaves total debt unset when nothing is tagged", () => {
    expect(debt({})).toBeUndefined();
  });

  it("decides each period end on its own across a tag migration", () => {
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          Assets: { units: { USD: [instant("2024-12-31", 1_000_000, "2025-02-01"), instant("2025-12-31", 1_000_000)] } },
          LongTermDebtNoncurrent: { units: { USD: [instant("2024-12-31", 50_000, "2025-02-01")] } },
          LongTermDebtAndCapitalLeaseObligations: { units: { USD: [instant("2025-12-31", 47_000)] } },
          LongTermDebtCurrent: { units: { USD: [instant("2024-12-31", 3_000, "2025-02-01"), instant("2025-12-31", 4_000)] } },
        },
      },
    };
    const rows = mapCompanyFactsToStatements("mig", facts, "annual").balance;
    expect(Object.fromEntries(rows.map((r) => [r.date, r.totalDebt]))).toEqual({ "2024-12-31": 53_000, "2025-12-31": 51_000 });
  });
});

describe("inventory when InventoryNet is not filed", () => {
  const instant = (end: string, val: number, filed = "2026-07-15"): XbrlFact => ({ end, val, form: "10-K", filed });
  const balance = (tags: Record<string, number>, end = "2026-05-31") =>
    mapCompanyFactsToStatements(
      "inv",
      { facts: { "us-gaap": { Assets: { units: { USD: [instant(end, 1_000_000)] } }, ...Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, { units: { USD: [instant(end, v)] } }])) } } },
      "annual",
    ).balance[0]!;
  const inventory = (tags: Record<string, number>) => balance(tags).inventory;

  it("reads a finished-goods-only filer's line (NKE FY2026: $7,501M)", () => {
    expect(inventory({ InventoryFinishedGoodsNetOfReserves: 7_501 })).toBe(7_501);
  });

  it("takes the total over its parts when both are filed (CAT)", () => {
    expect(inventory({ InventoryNet: 18_140, InventoryFinishedGoodsNetOfReserves: 8_720, InventoryRawMaterialsNetOfReserves: 7_430, InventoryWorkInProcessNetOfReserves: 1_600 })).toBe(18_140);
  });

  it("reads the totals filed under other names (BA, DLTR)", () => {
    expect(inventory({ InventoryNetOfAllowancesCustomerAdvancesAndProgressBillings: 84_680 })).toBe(84_680);
    expect(inventory({ RetailRelatedInventoryMerchandise: 2_500 })).toBe(2_500);
  });

  it("adds the stages when no total is filed", () => {
    // 300 finished + 120 WIP + 80 raw.
    expect(inventory({ InventoryFinishedGoods: 300, InventoryWorkInProcess: 120, InventoryRawMaterials: 80 })).toBe(500);
    // AMCR: finished + WIP combined 2,140, raw and supplies 1,530.
    expect(inventory({ InventoryFinishedGoodsAndWorkInProcessNetOfReserves: 2_140, InventoryRawMaterialsAndSuppliesNetOfReserves: 1_530 })).toBe(3_670);
  });

  it("does not add a stage again beside the combined tag that holds it (EME)", () => {
    // WIP + raw 130 already holds the 120 of raw materials; 15 of finished goods on top
    // (the stages alone would give 15 + 120 = 135, both together 265).
    expect(inventory({ InventoryWorkInProcessAndRawMaterialsNetOfReserves: 130, InventoryRawMaterialsNetOfReserves: 120, InventoryFinishedGoods: 15 })).toBe(145);
    // AMCR's combined finished + WIP beside a WIP line: 2,140 + 1,530 raw, the 400 of WIP not again.
    expect(inventory({ InventoryFinishedGoodsAndWorkInProcessNetOfReserves: 2_140, InventoryWorkInProcessNetOfReserves: 400, InventoryRawMaterialsAndSuppliesNetOfReserves: 1_530 })).toBe(3_670);
  });

  it("leaves a homebuilder's real-estate inventory out, and a filer with none at none", () => {
    expect(inventory({ InventoryOperativeBuilders: 11_840 })).toBeUndefined();
    expect(inventory({})).toBeUndefined();
  });
});

describe("short-term investments beside the cash", () => {
  const instant = (end: string, val: number, filed = "2026-07-15"): XbrlFact => ({ end, val, form: "10-K", filed });
  const sti = (tags: Record<string, number>, end = "2026-05-31") =>
    mapCompanyFactsToStatements(
      "sti",
      { facts: { "us-gaap": { Assets: { units: { USD: [instant(end, 1_000_000)] } }, ...Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, { units: { USD: [instant(end, v)] } }])) } } },
      "annual",
    ).balance[0]!.shortTermInvestments;

  it("reads NKE's available-for-sale securities ($1,464M)", () => {
    expect(sti({ CashAndCashEquivalentsAtCarryingValue: 7_563, DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent: 1_464 })).toBe(1_464);
  });

  it("reads marketable securities (GOOGL) and takes the first tag filed (ADI)", () => {
    expect(sti({ MarketableSecuritiesCurrent: 96_140 })).toBe(96_140);
    expect(sti({ ShortTermInvestments: 1_150, AvailableForSaleSecuritiesDebtSecuritiesCurrent: 1_150 })).toBe(1_150);
  });

  it("backs it out of a cash-and-investments line when no line of its own is filed", () => {
    // 6,590 together − 5,430 cash = 1,160.
    expect(sti({ CashCashEquivalentsAndShortTermInvestments: 6_590, CashAndCashEquivalentsAtCarryingValue: 5_430 })).toBe(1_160);
    // Its own line wins over the difference.
    expect(sti({ CashCashEquivalentsAndShortTermInvestments: 6_590, CashAndCashEquivalentsAtCarryingValue: 5_430, ShortTermInvestments: 1_000 })).toBe(1_000);
  });

  it("is absent with none filed, a zero, or a combined line no bigger than the cash", () => {
    expect(sti({ CashAndCashEquivalentsAtCarryingValue: 500 })).toBeUndefined();
    expect(sti({ ShortTermInvestments: 0 })).toBeUndefined();
    expect(sti({ CashCashEquivalentsAndShortTermInvestments: 500, CashAndCashEquivalentsAtCarryingValue: 500 })).toBeUndefined();
  });
});

describe("non-operating net interest (NKE FY2026)", () => {
  const net = (tags: Record<string, number>) =>
    mapCompanyFactsToStatements("int", { facts: { "us-gaap": { NetIncomeLoss: { units: { USD: [annualFact("2025-12-31", 3_108)] } }, ...Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, { units: { USD: [annualFact("2025-12-31", v)] } }])) } } }, "annual").income[0]!.netInterestNonoperating;

  it("reads the signed non-operating line, income positive", () => {
    expect(net({ InterestIncomeExpenseNonoperatingNet: 50 })).toBe(50);
    expect(net({ InterestIncomeExpenseNonoperatingNet: -410 })).toBe(-410);
  });

  it("never reads a bank's net interest income as it", () => {
    expect(net({ InterestIncomeExpenseNet: 52_000 })).toBeUndefined();
  });
});

describe("interest expense under the post-2024 tags", () => {
  const interest = (tags: Record<string, number>) =>
    mapCompanyFactsToStatements("int", { facts: { "us-gaap": { OperatingIncomeLoss: { units: { USD: [annualFact("2025-12-31", 9_000)] } }, ...Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, { units: { USD: [annualFact("2025-12-31", v)] } }])) } } }, "annual").income[0]!.interestExpense;

  it("reads InterestExpenseDebt (AMGN) and InterestAndDebtExpense (BA)", () => {
    expect(interest({ InterestExpenseDebt: 2_800 })).toBe(2_800);
    expect(interest({ InterestAndDebtExpense: 2_790 })).toBe(2_790);
  });

  it("prefers the expense line over cash interest paid", () => {
    expect(interest({ InterestExpenseNonoperating: 4_410, InterestPaidNet: 3_870 })).toBe(4_410);
  });

  it("falls back to cash interest paid when no expense line is tagged (CHTR)", () => {
    expect(interest({ InterestPaidNet: 4_980 })).toBe(4_980);
  });
});

// ADM's 2025 10-K, in $B: ASC 606 contract revenue 24.956 inside a total of
// 80.269 (the rest is commodity contracts under ASC 815), with cost of revenue
// 75.236 and gross profit 5.033 tagged against the total.
const usd = (end: string, val: number) => ({ units: { USD: [{ start: "2025-01-01", end, val, form: "10-K", filed: "2026-02-17" }] } });
const adm = (extra: Record<string, ReturnType<typeof usd>> = {}): CompanyFacts => ({
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: usd("2025-12-31", 24.956),
      Revenues: usd("2025-12-31", 80.269),
      CostOfRevenue: usd("2025-12-31", 75.236),
      GrossProfit: usd("2025-12-31", 5.033),
      ...extra,
    },
  },
});

describe("revenue is the line cost of revenue + gross profit add up to", () => {
  const revenue = (facts: CompanyFacts) => mapCompanyFactsToStatements("adm", facts, "annual").income[0]!.revenue;

  it("takes Revenues over a contract revenue that is only part of it (ADM: 75.236 + 5.033 = 80.269)", () => {
    expect(revenue(adm())).toBe(80.269);
  });

  it("keeps the first tag when it already adds up, whatever Revenues says (RSG files gross revenue under it)", () => {
    const rsg = adm({ RevenueFromContractWithCustomerExcludingAssessedTax: usd("2025-12-31", 80.269), Revenues: usd("2025-12-31", 95) });
    expect(revenue(rsg)).toBe(80.269);
  });

  it("without gross profit, still takes a Revenues more than twice the contract revenue (ADM: 80.269 against 24.956)", () => {
    const { GrossProfit: _, ...rest } = adm().facts!["us-gaap"]!;
    expect(revenue({ facts: { "us-gaap": rest } })).toBe(80.269);
  });

  it("changes nothing when no candidate adds up and none is twice the contract revenue", () => {
    expect(revenue(adm({ Revenues: usd("2025-12-31", 45) }))).toBe(24.956);
  });

  it("accepts a candidate within 1% of the sum, and not beyond", () => {
    const at = (v: number) => {
      const r = { revenue: 60, costOfRevenue: 60, grossProfit: 40 };
      reconcileRevenue(r, { candidates: [60, v] });
      return r.revenue;
    };
    expect(at(101)).toBe(101);
    expect(at(99)).toBe(99);
    expect(at(101.5)).toBe(60);
  });
});

// Filers whose contract revenue (ASC 606) leaves out rent, premiums or energy
// derivatives the income statement's top line holds. Figures are each
// company's own 2025 10-K facts (EQT's 2023), in $M.
describe("revenue is the income statement's top line, not its contract slice", () => {
  const k10 = (val: number, end = "2025-12-31") => ({ units: { USD: [{ start: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, end, val, form: "10-K", filed: "2026-02-24" }] } });
  const revenue = (tags: Record<string, number>, end?: string) =>
    mapCompanyFactsToStatements("x", { facts: { "us-gaap": Object.fromEntries(Object.entries(tags).map(([t, v]) => [t, k10(v, end)])) } }, "annual").income[0]!.revenue;
  const CONTRACT = "RevenueFromContractWithCustomerExcludingAssessedTax";

  it("takes Revenues where operating income + costs and expenses add up to it (AMT: 4,845.8 + 5,798.8 = 10,644.6)", () => {
    expect(revenue({ [CONTRACT]: 935.9, Revenues: 10_644.6, CostsAndExpenses: 5_798.8, OperatingIncomeLoss: 4_845.8, OperatingLeaseLeaseIncome: 9_708.7 })).toBe(10_644.6);
  });

  it("falls through to the operating identity when gross profit belongs to a part (CNC: 2,670 + 14,209 is neither; −7,623 + 202,400 = 194,777)", () => {
    expect(revenue({ [CONTRACT]: 174_581, Revenues: 194_777, CostOfGoodsAndServicesSold: 2_670, GrossProfit: 14_209, CostsAndExpenses: 202_400, OperatingIncomeLoss: -7_623 })).toBe(194_777);
  });

  it("keeps the contract revenue the operating identity confirms, though Revenues is larger (HAS: 11.1 + 4,690.2 = 4,701.3)", () => {
    expect(revenue({ [CONTRACT]: 4_701.3, Revenues: 5_365.9, CostOfGoodsAndServicesSold: 1_296.2, CostsAndExpenses: 4_690.2, OperatingIncomeLoss: 11.1 }, "2025-12-28")).toBe(4_701.3);
  });

  it("keeps the contract revenue with no identity when Revenues is less than twice it (RSG: 16,591 of 19,027 gross of eliminations)", () => {
    expect(revenue({ [CONTRACT]: 16_591, Revenues: 19_027, CostOfGoodsAndServicesSold: 9_630, OperatingIncomeLoss: 3_302 })).toBe(16_591);
  });

  it("never lowers revenue to a top line that nets a hedging loss (EQT 2022: 2,718.0 + 4,779.7 = 7,497.7 against 12,114.2 of sales)", () => {
    expect(revenue({ [CONTRACT]: 12_114.168, Revenues: 7_497.689, CostsAndExpenses: 4_779.692, OperatingIncomeLoss: 2_717.997 }, "2022-12-31")).toBe(12_114.168);
  });

  it("passes over a higher top line when the difference is the year's hedge gain (EQT 2023: 6,908.9 − 5,044.8 = 1,864.2 ≈ 1,838.9)", () => {
    const eqt = { [CONTRACT]: 5_044.768, Revenues: 6_908.923, CostsAndExpenses: 4_594.512, OperatingIncomeLoss: 2_314.411 };
    expect(revenue({ ...eqt, DerivativeInstrumentsNotDesignatedAsHedgingInstrumentsGainLossNet: 1_838.941 }, "2023-12-31")).toBe(5_044.768);
    // A derivative result that is not the gap leaves the identity in charge.
    expect(revenue({ ...eqt, DerivativeInstrumentsNotDesignatedAsHedgingInstrumentsGainLossNet: 300 }, "2023-12-31")).toBe(6_908.923);
  });

  it("takes Revenues over a contract revenue under half of it when no identity holds (UDR: 553.6 + 1,401.6 is neither; 11.4 of 1,712.3)", () => {
    expect(revenue({ [CONTRACT]: 11.361, Revenues: 1_712.317, CostsAndExpenses: 1_401.624, OperatingIncomeLoss: 553.606 })).toBe(1_712.317);
  });

  it("reads a bank's net revenue rather than its fee income (CFG: 1,635 of 8,247)", () => {
    expect(revenue({ [CONTRACT]: 1_635, Revenues: 8_247 })).toBe(8_247);
  });

  it("takes lease income when no revenue total is tagged (CPT: 13.0 of contract revenue, 1,573.5 of rent)", () => {
    expect(revenue({ [CONTRACT]: 12.967, OperatingLeaseLeaseIncome: 1_573.544, CostOfGoodsAndServicesSold: 566.71 })).toBe(1_573.544);
  });

  it("switches to another line at exactly twice the picked revenue, not below", () => {
    const at = (v: number) => {
      const r = { revenue: 50 };
      reconcileRevenue(r, { candidates: [50, v] });
      return r.revenue;
    };
    expect(at(100)).toBe(100);
    expect(at(99.99)).toBe(50);
  });
});

// Capex filed one level below the total tag: LLY, VZ, D, EOG… — 34 of the
// public universe's latest annual rows read as no capex before 2026-10. Values
// and filing dates are the companies' own 10-K facts, in $M.
describe("capital expenditure when the total tag is not filed", () => {
  const k10 = (start: string, end: string, val: number, filed: string): XbrlFact => ({ start, end, val, form: "10-K", filed });
  const tag = (...facts: XbrlFact[]) => ({ units: { USD: facts } });
  // A cash-flow row exists only where operating cash flow (or D&A) is filed, so
  // each fixture carries one for every year it asserts on.
  const ocf = tag(...["2022", "2023", "2024", "2025"].map((y) => k10(`${y}-01-01`, `${y}-12-31`, 1, `${Number(y) + 1}-02-01`)), k10("2025-02-01", "2026-01-31", 1, "2026-03-20"));
  const map = (facts: Record<string, ReturnType<typeof tag>>) =>
    mapCompanyFactsToStatements("x", { facts: { "us-gaap": { NetCashProvidedByUsedInOperatingActivities: ocf, ...facts } } }, "annual").cashflow;
  const capexByEnd = (facts: Record<string, ReturnType<typeof tag>>) =>
    Object.fromEntries(map(facts).filter((r) => r.capitalExpenditure !== undefined).map((r) => [r.date, r.capitalExpenditure]));

  it("reads LLY's purchases of property and equipment and derives free cash flow from them", () => {
    const [fy25, fy24] = map({
      NetCashProvidedByUsedInOperatingActivities: tag(k10("2024-01-01", "2024-12-31", 8817.9, "2025-02-19"), k10("2025-01-01", "2025-12-31", 16813, "2026-02-12")),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2024-01-01", "2024-12-31", 5057.8, "2025-02-19"), k10("2025-01-01", "2025-12-31", 7841, "2026-02-12")),
      // Acquired IPR&D sits on the same statement and is not capex.
      PaymentsToAcquireInProcessResearchAndDevelopment: tag(k10("2025-01-01", "2025-12-31", 3008, "2026-02-12")),
    });
    expect(fy25!.capitalExpenditure).toBe(-7841);
    expect(fy25!.freeCashFlow).toBe(8972); // 16,813 − 7,841
    expect(fy24!.capitalExpenditure).toBe(-5057.8);
    expect(fy24!.freeCashFlow).toBeCloseTo(3760.1, 6); // 8,817.9 − 5,057.8
  });

  it("sums the part lines and leaves out property acquisitions (EOG: 6,115 + 479; 5,353 + 1,019)", () => {
    expect(capexByEnd({
      PaymentsToAcquireOilAndGasPropertyAndEquipment: tag(k10("2024-01-01", "2024-12-31", 5353, "2025-02-27"), k10("2025-01-01", "2025-12-31", 6115, "2026-02-24")),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2024-01-01", "2024-12-31", 1019, "2025-02-27"), k10("2025-01-01", "2025-12-31", 479, "2026-02-24")),
      PaymentsToAcquireOilAndGasProperty: tag(k10("2024-01-01", "2024-12-31", 146, "2025-02-27"), k10("2025-01-01", "2025-12-31", 269, "2026-02-24")),
    })).toEqual({ "2025-12-31": -6594, "2024-12-31": -6372 });
  });

  it("dates a summed figure by the later of its parts' filings", () => {
    // A part re-filed later (a 10-K/A) cannot make the sum knowable earlier.
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          PaymentsToAcquireOilAndGasPropertyAndEquipment: tag(k10("2025-01-01", "2025-12-31", 6115, "2026-02-24")),
          PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 479, "2026-03-10")),
        },
      },
    };
    expect(resolveCapitalExpenditure(facts, isAnnualDuration, "10-K").get("2025-12-31")).toEqual({ val: 6594, filed: "2026-03-10" });
  });

  it("takes the total over its own part when both are filed (WEC 2022: 2,696.9 beside 2,314.9)", () => {
    expect(capexByEnd({
      PaymentsToAcquirePropertyPlantAndEquipment: tag(k10("2022-01-01", "2022-12-31", 2696.9, "2023-02-23")),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2022-01-01", "2022-12-31", 2314.9, "2023-02-23"), k10("2023-01-01", "2023-12-31", 2493, "2024-02-22")),
    })).toEqual({ "2022-12-31": -2696.9, "2023-12-31": -2493 });
  });

  it("falls back to the net productive-assets tag when it is an outflow (D), never a net inflow", () => {
    expect(capexByEnd({
      PaymentsForProceedsFromProductiveAssets: tag(k10("2024-01-01", "2024-12-31", -40, "2025-02-27"), k10("2025-01-01", "2025-12-31", 12653, "2026-02-23")),
    })).toEqual({ "2025-12-31": -12653 });
  });

  it("prefers a PP&E part to the net tag when both are filed", () => {
    expect(capexByEnd({
      PaymentsToAcquireOtherProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 17011, "2026-02-17")),
      PaymentsForProceedsFromProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 16500, "2026-02-17")),
    })).toEqual({ "2025-12-31": -17011 });
  });

  it("lets a PP&E part more than twice the total overrule it (AEP 2025: 8,453 of construction, not 3,453)", () => {
    const [fy25] = map({
      NetCashProvidedByUsedInOperatingActivities: tag(k10("2025-01-01", "2025-12-31", 6944, "2026-02-12")),
      PaymentsToAcquireProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 3453, "2026-02-12")),
      PaymentsForConstructionInProcess: tag(k10("2025-01-01", "2025-12-31", 8453, "2026-02-12")),
    });
    expect(fy25!.capitalExpenditure).toBe(-8453);
    expect(fy25!.freeCashFlow).toBe(-1509); // 6,944 − 8,453
  });

  it("keeps the total at exactly twice a part, and from a zero total gives way", () => {
    const pair = (total: number, part: number) =>
      capexByEnd({ PaymentsToAcquirePropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", total, "2026-02-12")), PaymentsForConstructionInProcess: tag(k10("2025-01-01", "2025-12-31", part, "2026-02-12")) });
    expect(pair(100, 200)).toEqual({ "2025-12-31": -100 });
    expect(pair(100, 201)).toEqual({ "2025-12-31": -201 });
    expect(pair(0, 6246)).toEqual({ "2025-12-31": -6246 }); // AEP 2020 filed its total tag as 0
  });

  it("tries the next total tag before the parts (URI 2014: 1,821, not 120 or 1,701)", () => {
    expect(capexByEnd({
      PaymentsToAcquirePropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 120, "2026-01-21")),
      PaymentsToAcquireProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 1821, "2026-01-21")),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 1701, "2026-01-21")),
    })).toEqual({ "2025-12-31": -1821 });
  });

  it("never lets the catch-all part overrule a total (QCOM FY2010 spectrum 1,064 beside 426; MCHP)", () => {
    expect(capexByEnd({
      PaymentsToAcquireProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 426, "2026-02-12")),
      PaymentsToAcquireOtherProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 1064, "2026-02-12")),
    })).toEqual({ "2025-12-31": -426 });
    expect(capexByEnd({
      PaymentsToAcquirePropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 91.1, "2026-02-12")),
      PaymentsToAcquireOtherProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 110.8, "2026-02-12")),
    })).toEqual({ "2025-12-31": -91.1 });
  });

  it("counts a part tagged twice once, and sums it with the catch-all once overruled (VMRK 2018, INVH 2018)", () => {
    expect(capexByEnd({
      PaymentsToAcquireProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 4.505, "2026-02-21")),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 188.501, "2026-02-21")),
      PaymentsForCapitalImprovements: tag(k10("2025-01-01", "2025-12-31", 188.501, "2026-02-21")),
    })).toEqual({ "2025-12-31": -188.501 });
    // 45.7 of capital improvements overrule the 4.027 total; the 141.7 catch-all is then summed in.
    const invh = capexByEnd({
      PaymentsToAcquirePropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 4.027, "2026-02-28")),
      PaymentsForCapitalImprovements: tag(k10("2025-01-01", "2025-12-31", 45.7, "2026-02-28")),
      PaymentsToAcquireOtherProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 141.7, "2026-02-28")),
    });
    expect(invh["2025-12-31"]).toBeCloseTo(-187.4, 9);
  });

  it("leaves out a part the filer also tags as an acquisition (HST Q1 2018: 1,019 of hotels beside 86)", () => {
    const hst = {
      PaymentsToAcquireProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 86, "2026-05-03")),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(k10("2025-01-01", "2025-12-31", 1019, "2026-05-03")),
      // The same figure, re-tagged in the next year's filing.
      PaymentsToAcquireRealEstate: tag(k10("2025-01-01", "2025-12-31", 1019, "2027-05-03")),
    };
    expect(capexByEnd(hst)).toEqual({ "2025-12-31": -86 });
    // Without the total it is still no capex, rather than a $1,019M part.
    const { PaymentsToAcquireProductiveAssets: _, ...partsOnly } = hst;
    expect(capexByEnd(partsOnly)).toEqual({});
  });

  it("keeps HST's Q1 capex at the total when its hotel purchases sit under a part (trimmed companyfacts)", () => {
    // Q1 2017: the original 10-Q tags the $467M of acquisitions as
    // `…BusinessesNetOfCashAcquired`; the next year's comparative re-tags them as
    // `…OtherPropertyPlantAndEquipment`. Q1 2018: the reverse — the original 10-Q
    // tags $1,019M of hotels as the part, the 2019 comparative as real estate.
    // Before the fix each part was over twice the total and overruled it:
    // 467 + 16 = 483 and 1,019 + 29 = 1,048 of capex, not 64 and 86.
    const m = 1e6;
    const f = (start: string, end: string, val: number, accn: string, filed: string): XbrlFact => ({ start, end, val: val * m, form: "10-Q", fp: "Q1", accn, filed });
    const q17 = ["2017-01-01", "2017-03-31"] as const;
    const q18 = ["2018-01-01", "2018-03-31"] as const;
    const orig17 = ["0001564590-17-008108", "2017-05-02"] as const;
    const orig18 = ["0001564590-18-010734", "2018-05-03"] as const;
    const comp19 = ["0001564590-19-015608", "2019-05-03"] as const;
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          NetCashProvidedByUsedInOperatingActivities: tag(f(...q17, 209, ...orig17), f(...q18, 248, ...orig18)),
          PaymentsToAcquireProductiveAssets: tag(f(...q17, 64, ...orig17), f(...q18, 86, ...orig18)),
          PaymentsForCapitalImprovements: tag(f(...q17, 16, ...orig17), f(...q18, 29, ...orig18)),
          PaymentsToAcquireOtherPropertyPlantAndEquipment: tag(f(...q17, 467, ...orig18), f(...q18, 1019, ...orig18)),
          PaymentsToAcquireBusinessesNetOfCashAcquired: tag(f(...q17, 467, ...orig17)),
          PaymentsToAcquireRealEstate: tag(f(...q18, 1019, ...comp19)),
        },
      },
    };
    const rows = Object.fromEntries(mapCompanyFactsToStatements("HST", facts, "quarter").cashflow.map((r) => [r.date, [r.capitalExpenditure, r.freeCashFlow]]));
    expect(rows).toEqual({ "2017-03-31": [-64 * m, 145 * m], "2018-03-31": [-86 * m, 162 * m] }); // 209 − 64, 248 − 86
  });

  it("never matches a deal on quarters derived by subtraction (DOW Q3 2022, trimmed companyfacts)", () => {
    // DOW files its gas-field development and its acquisitions year to date only:
    // 80 → 134 and 0 → 54, so both Q3s derive to 54, by chance. The 54 of
    // development is capex beside the 452 of machinery the 10-Q states:
    // 452 + 54 = 506, and free cash flow (5,397 − 3,457) − 506 = 1,434.
    const m = 1e6;
    const f = (start: string, end: string, val: number, accn: string, filed: string): XbrlFact => ({ start, end, val: val * m, form: "10-Q", accn, filed });
    const h1 = ["2022-01-01", "2022-06-30"] as const;
    const m9 = ["2022-01-01", "2022-09-30"] as const;
    const q10Q2 = ["0001751788-22-000123", "2022-07-22"] as const;
    const q10Q3 = ["0001751788-22-000131", "2022-10-21"] as const;
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          NetCashProvidedByUsedInOperatingActivities: tag(f(...h1, 3457, ...q10Q2), f(...m9, 5397, ...q10Q3)),
          PaymentsToAcquireMachineryAndEquipment: tag(f(...h1, 772, ...q10Q2), f("2022-04-01", "2022-06-30", 457, ...q10Q2), f(...m9, 1224, ...q10Q3), f("2022-07-01", "2022-09-30", 452, ...q10Q3)),
          PaymentsToExploreAndDevelopOilAndGasProperties: tag(f(...h1, 80, ...q10Q2), f(...m9, 134, ...q10Q3)),
          PaymentsToAcquireBusinessesNetOfCashAcquired: tag(f(...h1, 0, ...q10Q2), f(...m9, 54, ...q10Q3)),
        },
      },
    };
    const q3 = mapCompanyFactsToStatements("DOW", facts, "quarter").cashflow.find((r) => r.date === "2022-09-30");
    expect([q3?.capitalExpenditure, q3?.freeCashFlow]).toEqual([-506 * m, 1434 * m]);
  });

  it("reads a total filed with the wrong sign by its size (CCI 2019: −2,057)", () => {
    expect(capexByEnd({ PaymentsToAcquireProductiveAssets: tag(k10("2025-01-01", "2025-12-31", -2057, "2026-03-10")) })).toEqual({ "2025-12-31": -2057 });
  });

  it("uses capitalized software only when no PP&E line is filed (VEEV 29.131), never on top of one (ROP 47.4, not 104.7)", () => {
    const veev = { PaymentsForSoftware: tag(k10("2025-02-01", "2026-01-31", 29.131, "2026-03-20")) };
    expect(capexByEnd(veev)).toEqual({ "2026-01-31": -29.131 });
    expect(capexByEnd({
      PaymentsToAcquireOtherProductiveAssets: tag(k10("2025-01-01", "2025-12-31", 47.4, "2026-02-24")),
      PaymentsToDevelopSoftware: tag(k10("2025-01-01", "2025-12-31", 57.3, "2026-02-24")),
    })).toEqual({ "2025-12-31": -47.4 });
  });
});

// One calendar fiscal year (2025-01-01 → 2025-12-31) as a filer states it (#761):
// income quarter by quarter in each 10-Q plus the year to date, cash flow year to
// date only, and the year in the 10-K. Every filing on its own day, every line
// moving, so a quarter taken from the wrong pair or dated by the wrong filing shows.
const Q1 = { start: "2025-01-01", end: "2025-03-31", filed: "2025-04-30" };
const Q2 = { start: "2025-04-01", end: "2025-06-30", filed: "2025-07-30" };
const Q3 = { start: "2025-07-01", end: "2025-09-30", filed: "2025-10-30" };
const H1 = { start: "2025-01-01", end: "2025-06-30", filed: "2025-07-30" };
const M9 = { start: "2025-01-01", end: "2025-09-30", filed: "2025-10-30" };
const FY = { start: "2025-01-01", end: "2025-12-31", filed: "2026-02-20", form: "10-K" };
const q = (p: object, val: number): XbrlFact => ({ form: "10-Q", ...p, val }) as XbrlFact;
const units = (u: string, ...list: XbrlFact[]) => ({ units: { [u]: list } });
const YEAR: CompanyFacts = {
  facts: {
    "us-gaap": {
      // Stated Q2 = 110; the 6-month figure says 212 − 100 = 112 (a rounding in the
      // filing) — the stated quarter must win. Q4 = 480 − 335 = 145.
      RevenueFromContractWithCustomerExcludingAssessedTax: units("USD", q(Q1, 100), q(Q2, 110), q(H1, 212), q(Q3, 125), q(M9, 335), q(FY, 480)),
      // Q4 = 95 − 67 = 28.
      NetIncomeLoss: units("USD", q(Q1, 20), q(Q2, 22), q(H1, 42), q(Q3, 25), q(M9, 67), q(FY, 95)),
      // Weighted by days: Q4 = (990 × 365 − 1000 × 273) / 92 = 88,350 / 92 = 960.3 → 960.
      WeightedAverageNumberOfDilutedSharesOutstanding: units("shares", q(Q1, 1005), q(Q2, 1000), q(Q3, 995), q(M9, 1000), q(FY, 990)),
      EarningsPerShareDiluted: units("USD/shares", q(Q1, 0.02), q(Q2, 0.022), q(Q3, 0.025), q(M9, 0.067), q(FY, 0.096)),
      // Year to date only: 50, 120, 200, 310 → quarters 50, 70, 80, 110.
      NetCashProvidedByUsedInOperatingActivities: units("USD", q(Q1, 50), q(H1, 120), q(M9, 200), q(FY, 310)),
      // 10, 25, 45, 70 → 10, 15, 20, 25.
      PaymentsToAcquirePropertyPlantAndEquipment: units("USD", q(Q1, 10), q(H1, 25), q(M9, 45), q(FY, 70)),
      // First tagged in 2026: the 9-month figure exists only as a comparative filed
      // a year later, so no Q4 may come of it.
      GeneralAndAdministrativeExpense: units("USD", q({ ...M9, filed: "2026-10-29" }, 30), q(FY, 42)),
    },
  },
};

describe("quarters a 10-Q never states are derived (#761)", () => {
  const s = mapCompanyFactsToStatements("yr", YEAR, "quarter");
  const at = (rows: Record<string, unknown>[], end: string) => rows.find((r) => r.date === end)!;

  it("derives fiscal Q4 income as the year minus nine months, known when the 10-K was filed", () => {
    const q4 = at(s.income, "2025-12-31");
    expect(q4.revenue).toBe(145);
    expect(q4.netIncome).toBe(28);
    expect(q4.acceptedDate).toBe("2026-02-20");
    expect(s.income.map((r) => r.date)).toEqual(["2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31"]);
  });

  it("keeps a quarter the filing states over the difference of its year-to-date figures", () => {
    expect(at(s.income, "2025-06-30").revenue).toBe(110);
  });

  it("derives the weighted share count by days, and the per-share figure from it", () => {
    const q4 = at(s.income, "2025-12-31");
    expect(q4.weightedAverageShsOutDil).toBe(960);
    expect(q4.epsDiluted).toBe(0.03); // 28 / 960 = 0.0292, not FY − 9M (0.029)
    expect(at(s.income, "2025-09-30").epsDiluted).toBe(0.025); // stated, untouched
  });

  it("turns year-to-date cash flow into quarters, each dated by its own filing", () => {
    const byEnd = Object.fromEntries(s.cashflow.map((r) => [r.date, [r.operatingCashFlow, r.capitalExpenditure, r.freeCashFlow, r.acceptedDate]]));
    expect(byEnd).toEqual({
      "2025-03-31": [50, -10, 40, "2025-04-30"],
      "2025-06-30": [70, -15, 55, "2025-07-30"],
      "2025-09-30": [80, -20, 60, "2025-10-30"],
      "2025-12-31": [110, -25, 85, "2026-02-20"],
    });
  });

  it("does not derive from a later filing's comparative, which would date the row a year late", () => {
    const q4 = at(s.income, "2025-12-31");
    expect(q4.generalAndAdministrativeExpenses).toBeUndefined();
    expect(q4.acceptedDate).toBe("2026-02-20");
  });

  it("leaves the annual path as filed", () => {
    const a = mapCompanyFactsToStatements("yr", YEAR, "annual");
    expect(a.income.map((r) => [r.date, r.revenue])).toEqual([["2025-12-31", 480]]);
    expect(a.cashflow.map((r) => [r.date, r.operatingCashFlow])).toEqual([["2025-12-31", 310]]);
  });
});

describe("withDerivedQuarters guards", () => {
  const derivedQ4 = (list: XbrlFact[], unit = "USD") => {
    const out = withDerivedQuarters({ facts: { "us-gaap": { X: units(unit, ...list) } } });
    return out.facts!["us-gaap"]!.X!.units[unit]!.filter((f) => f.end === "2025-12-31" && f.form === "10-Q");
  };

  it("uses a pair filed exactly 150 days after its period end, and not 151", () => {
    // 2025-09-30 + 150 days = 2026-02-27.
    expect(derivedQ4([q({ ...M9, filed: "2026-02-27" }, 300), q(FY, 400)]).map((f) => f.val)).toEqual([100]);
    expect(derivedQ4([q({ ...M9, filed: "2026-02-28" }, 300), q(FY, 400)])).toEqual([]);
  });

  it("drops a derived share count off the year's by more than 2× (a split restated in one filing only)", () => {
    // The 10-K states the year after a 10-for-1 split, the 10-Q before it.
    expect(derivedQ4([q(M9, 1000), q(FY, 9000)], "shares")).toEqual([]);
  });

  it("takes a 3-month figure a 10-K states as the quarter, over the year minus nine months", () => {
    const stated = q({ start: "2025-10-01", end: "2025-12-31", filed: "2026-02-20", form: "10-K" }, 99);
    expect(derivedQ4([q(M9, 300), q(FY, 400), stated]).map((f) => f.val)).toEqual([99]);
  });

  it("prefers the year minus nine months over a later 10-K's comparative of the quarter (HUBB, Q4 2024)", () => {
    const comparative = q({ start: "2025-10-01", end: "2025-12-31", filed: "2027-02-18", form: "10-K" }, 99);
    expect(derivedQ4([q(M9, 300), q(FY, 400), comparative]).map((f) => [f.val, f.filed])).toEqual([[100, "2026-02-20"]]);
    // With no pair to derive from, the comparative is the only figure there is.
    expect(derivedQ4([q(FY, 400), comparative]).map((f) => [f.val, f.filed])).toEqual([[99, "2027-02-18"]]);
  });

  it("derives nothing from per-share figures or instants", () => {
    expect(derivedQ4([q(M9, 1.5), q(FY, 2)], "USD/shares")).toEqual([]);
    expect(derivedQ4([q({ end: "2025-09-30", filed: "2025-10-30" }, 5), q({ end: "2025-12-31", filed: "2026-02-20", form: "10-K" }, 6)])).toEqual([]);
  });
});

// Weighted share counts (2026-10 EDGAR audit). Figures are the filers' own
// 10-K facts in companyfacts; each fixture names the filing it comes from.
describe("weighted share counts: scale check and the missing diluted count", () => {
  const fy = (start: string, end: string, filed: string) => (u: string, val: number): XbrlFact => ({ start, end, val, form: "10-K", filed });
  const one = (f: XbrlFact, u: string) => ({ units: { [u]: [f] } });
  /** One fiscal year's income facts; `null` leaves a tag out. */
  const year = (
    period: [string, string, string],
    v: { basic?: number; diluted?: number; ni?: number; eps?: number; epsDil?: number; extra?: Record<string, number> },
    cover?: { end: string; val: number; form?: string },
  ): CompanyFacts => {
    const at = fy(...period);
    const g: Record<string, { units: Record<string, XbrlFact[]> }> = {};
    if (v.basic !== undefined) g.WeightedAverageNumberOfSharesOutstandingBasic = one(at("shares", v.basic), "shares");
    if (v.diluted !== undefined) g.WeightedAverageNumberOfDilutedSharesOutstanding = one(at("shares", v.diluted), "shares");
    if (v.ni !== undefined) g.NetIncomeLoss = one(at("USD", v.ni), "USD");
    if (v.eps !== undefined) g.EarningsPerShareBasic = one(at("USD/shares", v.eps), "USD/shares");
    if (v.epsDil !== undefined) g.EarningsPerShareDiluted = one(at("USD/shares", v.epsDil), "USD/shares");
    for (const [tag, val] of Object.entries(v.extra ?? {})) g[tag] = one(at("shares", val), "shares");
    const dei = cover ? { EntityCommonStockSharesOutstanding: one({ end: cover.end, val: cover.val, form: cover.form ?? "10-K", filed: period[2] }, "shares") } : undefined;
    return { facts: { "us-gaap": g, ...(dei ? { dei } : {}) } };
  };
  const income = (facts: CompanyFacts) => mapCompanyFactsToStatements("x", facts, "annual").income[0]!;

  // MCD, 10-K for 2025 (accession 0000063908-26-000035, filed 2026-02-24): the
  // statement says 713.4M basic and 716.4M diluted shares; the XBRL carries
  // 713.4 and 716.4. Net income $8,563M, EPS $12.00 / $11.95.
  const MCD: [string, string, string] = ["2025-01-01", "2025-12-31", "2026-02-24"];
  const mcd = { basic: 713.4, diluted: 716.4, ni: 8_563_000_000, eps: 12, epsDil: 11.95 };

  it("rescales counts filed in millions by the anchor net income / EPS gives (MCD 2025: 8,563M / 11.95 = 716.6M)", () => {
    const r = income(year(MCD, mcd));
    expect(r.weightedAverageShsOut).toBe(713_400_000);
    expect(r.weightedAverageShsOutDil).toBe(716_400_000);
  });

  it("falls back to the cover page when EPS cannot anchor (MCD's 710,398,642 shares at 2026-01-31)", () => {
    const noEps = { basic: 713.4, diluted: 716.4, ni: 8_563_000_000 };
    expect(income(year(MCD, noEps, { end: "2026-01-31", val: 710_398_642 })).weightedAverageShsOutDil).toBe(716_400_000);
    // No anchor at all: left as filed.
    expect(income(year(MCD, noEps)).weightedAverageShsOutDil).toBe(716.4);
    // A cover date 150 days after the year end is the filing's; 151 days is not (2025-12-31 + 150 = 2026-05-30).
    expect(income(year(MCD, noEps, { end: "2026-05-30", val: 710_398_642 })).weightedAverageShsOutDil).toBe(716_400_000);
    expect(income(year(MCD, noEps, { end: "2026-05-31", val: 710_398_642 })).weightedAverageShsOutDil).toBe(716.4);
    // A 10-Q's cover is not the 10-K's.
    expect(income(year(MCD, noEps, { end: "2026-01-31", val: 710_398_642, form: "10-Q" })).weightedAverageShsOutDil).toBe(716.4);
    // A cover no power of 1,000 brings within 3× contradicts a count under a million: 716.4 × 1,000² = 716M against 5.0B (7×).
    expect(income(year(MCD, noEps, { end: "2026-01-31", val: 5_000_000_000 })).weightedAverageShsOutDil).toBeUndefined();
  });

  it("anchors diluted on the settled basic count when there is no diluted EPS (COP 2018)", () => {
    // COP's 2018 10-K (filed 2019-02-19): both counts in thousands — 1,166,499
    // basic, 1,175,538 diluted, each over the million floor — beside net income
    // $6,257M and a basic EPS of $5.36 only. Basic: 6,257M / 5.36 = 1,167.4M →
    // ×1,000; diluted then against that basic count → ×1,000.
    const cop = income(year(["2018-01-01", "2018-12-31", "2019-02-19"], { basic: 1_166_499, diluted: 1_175_538, ni: 6_257_000_000, eps: 5.36 }));
    expect(cop.weightedAverageShsOut).toBe(1_166_499_000);
    expect(cop.weightedAverageShsOutDil).toBe(1_175_538_000);
  });

  it("does not consult the cover page for a count of a million or more", () => {
    const noEps = { ni: 16_800_000, eps: 0.03 }; // EPS too small to anchor
    // VTRS's 2019 comparatives: the pre-spin shell's 1,000 shares on the cover.
    expect(income(year(MCD, { ...noEps, basic: 515_700_000 }, { end: "2026-01-31", val: 1_000 })).weightedAverageShsOut).toBe(515_700_000);
    // HBAN, Q4 2014: a cover a thousand times over its 817.05M shares.
    expect(income(year(MCD, { ...noEps, basic: 817_050_000 }, { end: "2026-01-31", val: 817_047_530_000 })).weightedAverageShsOut).toBe(817_050_000);
    // Exactly a million is a count; one share fewer is checked against the cover (×1,000).
    expect(income(year(MCD, { ...noEps, basic: 1_000_000 }, { end: "2026-01-31", val: 900_000_000 })).weightedAverageShsOut).toBe(1_000_000);
    expect(income(year(MCD, { ...noEps, basic: 999_999 }, { end: "2026-01-31", val: 900_000_000 })).weightedAverageShsOut).toBe(999_999_000);
  });

  it("never rescales a count to under a million on an EPS filed off scale (HAL Q3 2024: EPS 0.65 tagged as 650,000)", () => {
    // 10-Q for Q3 2024: net income $571M, 881M basic shares; 571M / 650,000 = 878 would read them as 881.
    const at = (val: number): XbrlFact => ({ start: "2024-07-01", end: "2024-09-30", val, form: "10-Q", filed: "2024-10-25" });
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          WeightedAverageNumberOfSharesOutstandingBasic: { units: { shares: [at(881_000_000)] } },
          NetIncomeLoss: { units: { USD: [at(571_000_000)] } },
          EarningsPerShareBasic: { units: { "USD/shares": [at(650_000)] } },
        },
      },
    };
    expect(mapCompanyFactsToStatements("hal", facts, "quarter").income[0]!.weightedAverageShsOut).toBe(881_000_000);
  });

  it("anchors on EPS of 0.10 and up, and on the cover below it", () => {
    // Net income 100M; a basic count filed in thousands (1,000 = 1.0B shares).
    const at = (eps: number) => income(year(MCD, { basic: 1000, ni: 100_000_000, eps }, { end: "2026-01-31", val: 1_200_000 })).weightedAverageShsOut;
    expect(at(0.1)).toBe(1_000_000_000); // 100M / 0.10 = 1.0B → ×1,000²
    expect(at(0.09)).toBe(1_000_000); // the cover's 1.2M → ×1,000 (a count under a million)
  });

  it("does not anchor on an EPS whose sign differs from net income's (preferred dividends)", () => {
    // NI +10M with EPS −0.50 would say −20M shares; the cover (713M) says the count is in millions.
    const r = income(year(MCD, { basic: 713.4, ni: 10_000_000, eps: -0.5 }, { end: "2026-01-31", val: 713_000_000 }));
    expect(r.weightedAverageShsOut).toBe(713_400_000);
  });

  it("drops a count no power of 1,000 brings within 3× of the anchor, and keeps one exactly 3× away", () => {
    // Anchor 3,000M / 1.00 = 3,000M. 9.0 → ×1,000³ = 9,000M, exactly 3× → kept.
    const at = (basic: number) => income(year(MCD, { basic, ni: 3_000_000_000, eps: 1 })).weightedAverageShsOut;
    expect(at(9)).toBe(9_000_000_000);
    expect(at(9.03)).toBeUndefined(); // 9,030M is 3.01× away
    expect(at(1)).toBe(1_000_000_000); // 1,000M: ×1,000³, exactly 3× under → kept
    expect(at(1.002)).toBe(1_002_000_000); // 1,002M: 2.99× under
    expect(at(0.99)).toBeUndefined(); // 990M: 3.03× under
  });

  it("leaves a count within ~30× of the anchor as filed (a real gap, not a scale slip)", () => {
    // Anchor 1,000M; a count of 40M (25× off) is not a power of 1,000 away.
    expect(income(year(MCD, { basic: 40_000_000, ni: 1_000_000_000, eps: 1 })).weightedAverageShsOut).toBe(40_000_000);
  });

  // AJG, 10-K for 2025 (filed 2026-02-17): 256.1M basic, 4.0M of share-based
  // dilution, no diluted total; EPS $5.83 / $5.74, net income $1,494M
  // (1,494 / 5.74 = 260.3M, the same count the 10-K prints: 260.1M).
  const AJG: [string, string, string] = ["2025-01-01", "2025-12-31", "2026-02-17"];
  const ajg = { basic: 256_100_000, ni: 1_494_000_000, eps: 5.83, epsDil: 5.74 };

  it("adds the dilution the filer tags to basic (AJG 2025: 256.1M + 4.0M = 260.1M)", () => {
    const r = income(year(AJG, { ...ajg, extra: { IncrementalCommonSharesAttributableToShareBasedPaymentArrangements: 4_000_000 } }));
    expect(r.weightedAverageShsOutDil).toBe(260_100_000);
  });

  it("sums the dilution parts, and prefers the filer's total adjustment over them", () => {
    const parts = {
      IncrementalCommonSharesAttributableToShareBasedPaymentArrangements: 4_000_000,
      IncrementalCommonSharesAttributableToConversionOfDebtSecurities: 1_500_000,
    };
    expect(income(year(AJG, { ...ajg, extra: parts })).weightedAverageShsOutDil).toBe(261_600_000); // 256.1 + 4.0 + 1.5
    const withTotal = { ...parts, WeightedAverageNumberDilutedSharesOutstandingAdjustment: 4_200_000 };
    expect(income(year(AJG, { ...ajg, extra: withTotal })).weightedAverageShsOutDil).toBe(260_300_000); // 256.1 + 4.2
  });

  it("ignores dilution of half the basic count or more: a total filed under a part's tag (GEN 2008, L 2013)", () => {
    const at = (inc: number) => income(year(AJG, { ...ajg, extra: { IncrementalCommonSharesAttributableToShareBasedPaymentArrangements: inc } })).weightedAverageShsOutDil;
    expect(at(128_049_999)).toBe(384_149_999); // just under 256.1M / 2
    expect(at(128_050_000)).toBeUndefined(); // exactly half
  });

  it("dates the row by the dilution fact when it was filed later", () => {
    const facts = year(AJG, ajg);
    facts.facts!["us-gaap"]!.IncrementalCommonSharesAttributableToShareBasedPaymentArrangements = one(fy("2025-01-01", "2025-12-31", "2027-02-16")("shares", 4_000_000), "shares");
    const r = income(facts);
    expect(r.weightedAverageShsOutDil).toBe(260_100_000);
    expect(r.acceptedDate).toBe("2027-02-16");
  });

  // TTWO, 10-K for fiscal 2026 (year to 2026-03-31, filed 2026-05-22): 183.9M
  // basic, net loss $298.2M, basic and diluted EPS both −$1.62.
  const TTWO: [string, string, string] = ["2025-04-01", "2026-03-31", "2026-05-22"];
  const ttwo = { basic: 183_900_000, ni: -298_200_000, eps: -1.62, epsDil: -1.62 };

  it("takes basic as diluted in a loss year, even beside tagged dilution, which is antidilutive (TTWO fiscal 2026)", () => {
    expect(income(year(TTWO, ttwo)).weightedAverageShsOutDil).toBe(183_900_000);
    const tagged = { ...ttwo, extra: { WeightedAverageNumberDilutedSharesOutstandingAdjustment: 2_000_000 } };
    expect(income(year(TTWO, tagged)).weightedAverageShsOutDil).toBe(183_900_000);
  });

  // LEN, 10-K for fiscal 2025 (year to 2025-11-30, filed 2026-01-28): 257,746,000
  // basic shares and basic EPS $7.98; no diluted EPS or count.
  const LEN: [string, string, string] = ["2024-12-01", "2025-11-30", "2026-01-28"];
  const len = { basic: 257_746_000, ni: 2_078_179_000, eps: 7.98 };

  it("derives nothing without a diluted EPS to show what dilution was (LEN fiscal 2025)", () => {
    expect(income(year(LEN, len)).weightedAverageShsOutDil).toBeUndefined();
  });

  it("takes basic as diluted in a profit year only when the two EPS are equal", () => {
    expect(income(year(LEN, { ...len, epsDil: 7.98 })).weightedAverageShsOutDil).toBe(257_746_000);
    expect(income(year(LEN, { ...len, epsDil: 7.97 })).weightedAverageShsOutDil).toBeUndefined();
  });

  it("keeps a filed diluted count over every derivation", () => {
    const r = income(year(AJG, { ...ajg, diluted: 260_500_000, extra: { IncrementalCommonSharesAttributableToShareBasedPaymentArrangements: 4_000_000 } }));
    expect(r.weightedAverageShsOutDil).toBe(260_500_000);
  });

  it("rescales basic before adding the dilution to it", () => {
    // MCD's basic in millions, its 3.0M of dilution in shares, and the diluted total left out: 713.4M + 3.0M.
    const r = income(year(MCD, { basic: 713.4, ni: 8_563_000_000, eps: 12, epsDil: 11.95, extra: { IncrementalCommonSharesAttributableToShareBasedPaymentArrangements: 3_000_000 } }));
    expect(r.weightedAverageShsOutDil).toBe(716_400_000);
  });

  it("settleShareCounts leaves a row without share counts untouched", () => {
    const r: Record<string, unknown> = { netIncome: 5, eps: 1, epsDiluted: 1 };
    settleShareCounts(r, { cover: 10 });
    expect(r).toEqual({ netIncome: 5, eps: 1, epsDiluted: 1 });
  });
});

describe("weighted share counts on the quarter path", () => {
  // MCD's 10-Q for Q1 2026 (filed 2026-05-07) carries 713.5 diluted shares;
  // the income figures are rounded for the fixture: 1,000M / 1.40 = 714.3M.
  it("rescales a 10-Q's count the same way", () => {
    const at = (val: number, u: string): XbrlFact => ({ start: "2026-01-01", end: "2026-03-31", val, form: "10-Q", filed: "2026-05-07" });
    const facts: CompanyFacts = {
      facts: {
        "us-gaap": {
          WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [at(713.5, "shares")] } },
          NetIncomeLoss: { units: { USD: [at(1_000_000_000, "USD")] } },
          EarningsPerShareDiluted: { units: { "USD/shares": [at(1.4, "USD/shares")] } },
        },
      },
    };
    expect(mapCompanyFactsToStatements("mcd", facts, "quarter").income[0]!.weightedAverageShsOutDil).toBe(713_500_000);
  });
});
