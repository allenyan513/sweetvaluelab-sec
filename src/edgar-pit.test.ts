/**
 * Point-in-time and precedence rules of the EDGAR companyfacts mapper, kept apart
 * from edgar.test.ts. The fixtures there file every fact on one day and give each
 * statement a single period, so these rules could not be told apart from their
 * opposites: the row's `acceptedDate` (→ known_at), concept priority on a shared
 * period end, newest-first ordering, and the instant-only filter for balance facts.
 */
import { describe, it, expect } from "vitest";
import { mapCompanyFactsToStatements, type CompanyFacts, type XbrlFact } from "./edgar.js";

const q = (start: string, end: string, val: number, filed: string): XbrlFact => ({ start, end, val, filed, form: "10-Q" });
const inst = (end: string, val: number, filed: string): XbrlFact => ({ end, val, filed, form: "10-Q" });
const usd = (facts: XbrlFact[]) => ({ units: { USD: facts } });
const perShare = (facts: XbrlFact[]) => ({ units: { "USD/shares": facts } });
const companyFacts = (usGaap: Record<string, { units: Record<string, XbrlFact[]> }>): CompanyFacts => ({ facts: { "us-gaap": usGaap } });

describe("row acceptedDate = the LATEST first filing across the row's fields", () => {
  // Q1 2020 (91 days). Net income and EPS are first filed in the Q1 10-Q on
  // 2020-04-30; revenue for the same quarter only appears a year later, as a
  // comparative in the Q1 2021 10-Q (2021-04-29). The row is not complete — not
  // knowable as a row — until 2021-04-29. Revenue sits FIRST in the field spec
  // and filed LATEST, so neither "earliest filing" nor "last field processed"
  // can produce the right date.
  const facts = companyFacts({
    RevenueFromContractWithCustomerExcludingAssessedTax: usd([q("2020-01-01", "2020-03-31", 1_000, "2021-04-29")]),
    NetIncomeLoss: usd([q("2020-01-01", "2020-03-31", 120, "2020-04-30")]),
    EarningsPerShareBasic: perShare([q("2020-01-01", "2020-03-31", 1.2, "2020-04-30")]),
  });

  it("stamps the row with 2021-04-29, not the earlier 2020-04-30", () => {
    const [row] = mapCompanyFactsToStatements("abc", facts, "quarter").income;
    expect(row).toMatchObject({ date: "2020-03-31", revenue: 1_000, netIncome: 120, eps: 1.2, acceptedDate: "2021-04-29" });
  });
});

describe("concept priority when two concepts tag the same period end", () => {
  it("keeps the higher-priority concept's value; the lower one only fills other ends", () => {
    // Priority order in INCOME_CONCEPTS.revenue: RevenueFromContractWithCustomer…
    // (1st) before RevenuesNetOfInterestExpense (5th). Both tag Q1 2020 with
    // different values; only the lower-priority one tags Q4 2019.
    const facts = companyFacts({
      RevenuesNetOfInterestExpense: usd([
        q("2020-01-01", "2020-03-31", 900, "2020-04-30"),
        q("2019-10-01", "2019-12-31", 850, "2020-01-30"),
      ]),
      RevenueFromContractWithCustomerExcludingAssessedTax: usd([q("2020-01-01", "2020-03-31", 1_000, "2020-04-30")]),
    });
    const income = mapCompanyFactsToStatements("abc", facts, "quarter").income;
    expect(income.map((r) => [r.date, r.revenue])).toEqual([
      ["2020-03-31", 1_000],
      ["2019-12-31", 850],
    ]);
  });
});

describe("row ordering", () => {
  it("returns every statement newest-first, whatever order the facts arrive in", () => {
    // Facts listed oldest-first on purpose.
    const facts = companyFacts({
      Revenues: usd([
        q("2019-10-01", "2019-12-31", 800, "2020-01-30"),
        q("2020-01-01", "2020-03-31", 900, "2020-04-30"),
        q("2020-04-01", "2020-06-30", 950, "2020-07-30"),
      ]),
      Assets: usd([inst("2019-12-31", 5_000, "2020-01-30"), inst("2020-03-31", 5_100, "2020-04-30"), inst("2020-06-30", 5_200, "2020-07-30")]),
      NetCashProvidedByUsedInOperatingActivities: usd([
        q("2019-10-01", "2019-12-31", 70, "2020-01-30"),
        q("2020-01-01", "2020-03-31", 80, "2020-04-30"),
        q("2020-04-01", "2020-06-30", 90, "2020-07-30"),
      ]),
    });
    const s = mapCompanyFactsToStatements("abc", facts, "quarter");
    const newestFirst = ["2020-06-30", "2020-03-31", "2019-12-31"];
    expect(s.income.map((r) => r.date)).toEqual(newestFirst);
    expect(s.balance.map((r) => r.date)).toEqual(newestFirst);
    expect(s.cashflow.map((r) => r.date)).toEqual(newestFirst);
  });
});

describe("balance sheet reads instant facts only", () => {
  it("ignores a duration fact on a balance concept, even one filed earlier for the same end", () => {
    // A duration `Assets` fact ending on the quarter end is a decoy (e.g. an
    // average-assets disclosure mis-tagged). It is filed earlier, so if it passed
    // the instant filter the earliest-filed rule would pick it.
    const facts = companyFacts({
      Assets: usd([q("2020-01-01", "2020-03-31", 9_999, "2020-04-15"), inst("2020-03-31", 5_100, "2020-04-30")]),
    });
    const [row] = mapCompanyFactsToStatements("abc", facts, "quarter").balance;
    expect(row).toMatchObject({ date: "2020-03-31", totalAssets: 5_100, acceptedDate: "2020-04-30" });
  });
});
