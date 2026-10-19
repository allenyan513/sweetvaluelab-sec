/**
 * SEC EDGAR client + XBRL→statement mapper — the free, official source for
 * quarterly (10-Q) financials that FMP's free tier gates behind a paid plan.
 *
 * We deliberately consume the **companyfacts** API (`/api/xbrl/companyfacts/`)
 * rather than raw XBRL instance documents: companyfacts already returns
 * pre-structured JSON facts (concept / unit / period / filed), so the heavy
 * lifting that full XBRL processors (Arelle, edgartools) exist for — taxonomy /
 * linkbase resolution, dimensional contexts — is done for us. What remains is a
 * focused mapping layer: us-gaap concept → FMP field name, instant-vs-duration,
 * and quarterly-vs-YTD selection. The concept priority lists below are informed
 * by edgartools' (MIT) mapping conventions.
 *
 * The mapper emits **FMP-shaped rows** (same field names FMP returns) so the
 * existing read-through cache + valuation adapter consume them unchanged.
 *
 * Pure (mapper) + thin HTTP client, no DB — mirrors fmp.ts. The read-through /
 * persistence wiring lives in marketdata/index.ts.
 */
import { secGet, SecError } from "./http.js";

const SEC_DATA_BASE = "https://data.sec.gov";
const SEC_WWW_BASE = "https://www.sec.gov";

/** Back-compat alias — SEC fetch errors are now the shared `SecError`. */
export const EdgarError = SecError;

// ───────────────────────── ticker → CIK ─────────────────────────
// company_tickers.json maps every ticker to its zero-paddable CIK. Cached in
// memory for the process; it changes rarely (new listings).

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}
let tickerMap: Map<string, number> | null = null;
let tickerMapInFlight: Promise<Map<string, number>> | null = null;

export async function loadTickerMap(): Promise<Map<string, number>> {
  if (tickerMap) return tickerMap;
  // Collapse concurrent first-load calls onto one fetch — many symbols warming
  // at once must not each pull this (large) file. Reset on settle so a transient
  // failure retries instead of poisoning every future caller.
  if (!tickerMapInFlight) {
    tickerMapInFlight = (async () => {
      const raw = await secGet<Record<string, TickerRow>>(`${SEC_WWW_BASE}/files/company_tickers.json`);
      const m = new Map<string, number>();
      if (raw) for (const row of Object.values(raw)) m.set(row.ticker.toUpperCase(), row.cik_str);
      tickerMap = m;
      return m;
    })().finally(() => {
      tickerMapInFlight = null;
    });
  }
  return tickerMapInFlight;
}

/** 10-digit zero-padded CIK as the companyfacts path expects. */
export const padCik = (cik: number): string => String(cik).padStart(10, "0");

export async function tickerToCik(symbol: string): Promise<number | null> {
  const m = await loadTickerMap();
  return m.get(symbol.toUpperCase()) ?? null;
}

// ───────────────────────── companyfacts types ─────────────────────────

export interface XbrlFact {
  start?: string; // present for duration concepts (income / cash flow)
  end: string; // period end (instant) or duration end
  val: number;
  accn?: string;
  fy?: number;
  fp?: string; // "Q1" | "Q2" | "Q3" | "FY"
  form?: string; // "10-Q" | "10-K" | ...
  filed: string; // filing date → known_at (PIT)
  frame?: string;
  /** Set by `withDerivedQuarters` on a quarter it computed by subtraction —
   *  never on a fact companyfacts carries. */
  derived?: boolean;
}
interface XbrlConcept {
  units: Record<string, XbrlFact[]>;
}
export interface CompanyFacts {
  cik?: number;
  entityName?: string;
  facts?: { "us-gaap"?: Record<string, XbrlConcept>; dei?: Record<string, XbrlConcept> };
}

// ───────────────────────── concept → FMP field maps ─────────────────────────
// Each FMP field maps to an ordered list of candidate us-gaap concepts; the
// first one present in the filing wins (companies tag the same line differently).

export const INCOME_CONCEPTS: Record<string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "RevenuesNetOfInterestExpense", // banks and broker-dealers (GS)
  ],
  costOfRevenue: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"],
  grossProfit: ["GrossProfit"],
  researchAndDevelopmentExpenses: ["ResearchAndDevelopmentExpense"],
  sellingGeneralAndAdministrativeExpenses: ["SellingGeneralAndAdministrativeExpense"],
  generalAndAdministrativeExpenses: ["GeneralAndAdministrativeExpense"],
  operatingIncome: ["OperatingIncomeLoss"],
  // `InterestExpense` was split up in the 2024 taxonomy; a filer that moved to
  // one of the narrower tags read as zero interest until 2026-10 (135 of the
  // 518). Cash interest paid is the last resort (CHTR, CAT, GM tag no expense
  // line at all) — close to the expense, and the cost of debt only needs a rate.
  interestExpense: [
    "InterestExpense",
    "InterestExpenseNonoperating",
    "InterestExpenseDebt",
    "InterestAndDebtExpense",
    "InterestExpenseOperating",
    "InterestPaidNet",
    "InterestPaid",
  ],
  // The filer's own non-operating interest line, net and signed (+ = income).
  // Pre-tax income plus the expense above is operating income only when the
  // filer earns no interest: NKE's $278M on its cash put its FY2026 back-out at
  // $4,223M against the $3,850M EBIT it reports. Only the NONOPERATING tag —
  // a bank's `InterestIncomeExpenseNet` is its revenue, and FMP's own
  // `netInterestIncome` is a bank's net interest income too, hence the name.
  netInterestNonoperating: ["InterestIncomeExpenseNonoperatingNet"],
  incomeBeforeTax: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  incomeTaxExpense: ["IncomeTaxExpenseBenefit"],
  netIncome: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  eps: ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"],
  epsDiluted: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"], // ERIE tags one combined line
  weightedAverageShsOut: ["WeightedAverageNumberOfSharesOutstandingBasic"],
  weightedAverageShsOutDil: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
};

export const BALANCE_CONCEPTS: Record<string, string[]> = {
  totalAssets: ["Assets"],
  totalLiabilities: ["Liabilities"],
  totalStockholdersEquity: ["StockholdersEquity"],
  totalEquity: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  cashAndCashEquivalents: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  netReceivables: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
  accountPayables: ["AccountsPayableCurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"],
};
// Inventory and short-term investments have no single tag either; each has a
// resolver below (`resolveInventory`, `resolveShortTermInvestments`).
/** The whole inventory line, as one figure. Until 2026-10 only `InventoryNet`
 *  was read, so a filer that tags its balance-sheet line one level down read as
 *  holding none: NKE's $7.5B of finished goods, BA's $85B, DLTR's merchandise —
 *  and the DCFs' working capital had no inventory to grow. */
export const INVENTORY_TOTAL = [
  "InventoryNet",
  "InventoryNetOfAllowancesCustomerAdvancesAndProgressBillings", // BA
  "RetailRelatedInventoryMerchandise", // DLTR
];
/** The parts filed instead of a total, by stage. A combined tag covers two
 *  stages, so the singles it covers are not added beside it (EME files raw
 *  materials 0.12 + WIP 0.01 AND their 0.13 sum). Real-estate inventory (a
 *  homebuilder's land and homes: DHI, LEN, PHM, TOL) is deliberately left out —
 *  whether a builder's land belongs in its working capital is its own question. */
export const INVENTORY_PARTS = {
  finished: ["InventoryFinishedGoodsNetOfReserves", "InventoryFinishedGoods"], // NKE, AZO, SYY, ULTA
  wip: ["InventoryWorkInProcessNetOfReserves", "InventoryWorkInProcess"],
  raw: ["InventoryRawMaterialsNetOfReserves", "InventoryRawMaterialsAndSuppliesNetOfReserves", "InventoryRawMaterials", "InventoryRawMaterialsAndSupplies"], // FCX
  finishedAndWip: ["InventoryFinishedGoodsAndWorkInProcessNetOfReserves", "InventoryFinishedGoodsAndWorkInProcess"], // AMCR
  wipAndRaw: ["InventoryWorkInProcessAndRawMaterialsNetOfReserves", "InventoryWorkInProcessAndRawMaterials"], // EME
} as const;
/** Short-term investments beside the cash, as one figure — the first tag the
 *  filer uses: AAPL, GOOGL and META file marketable securities, MSFT and BA
 *  short-term investments, INTC, CRM and NOW available-for-sale debt, NKE the
 *  2023 taxonomy's AFS tag. None was read until 2026-10, so net debt counted
 *  GOOGL's $96B of securities as if it were not there. */
export const SHORT_TERM_INVESTMENTS = [
  "ShortTermInvestments",
  "MarketableSecuritiesCurrent",
  "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  "DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent", // NKE
  "AvailableForSaleSecuritiesCurrent",
];
/** Cash and short-term investments as one line: what is left after the cash is
 *  the investments, for a filer that tags no line for them alone. */
export const CASH_AND_SHORT_TERM_INVESTMENTS = ["CashCashEquivalentsAndShortTermInvestments"];
// totalDebt has no single tag; `resolveTotalDebt` composes it per period end
// from these groups. Until 2026-10 only `LongTermDebtNoncurrent` / `LongTermDebt`
// counted as the long-term line, so a filer that tags its balance-sheet debt as
// `LongTermDebtAndCapitalLeaseObligations` (CMCSA, KO, VZ, AMT, PM … 97 of the
// 518) kept only the current portion: CMCSA's $99B of debt read as $6B, which
// flowed into net debt and inflated every DCF and EV multiple's equity value.
/** The non-current debt line, as each filer labels it on the balance sheet. */
export const DEBT_NONCURRENT = [
  "LongTermDebtNoncurrent",
  "LongTermDebtAndCapitalLeaseObligations",
  "LongTermNotesPayable", // ORCL
  "SeniorLongTermNotes",
  "UnsecuredLongTermDebt", // CME, CDNS
  "ConvertibleLongTermNotesPayable", // AKAM, DASH, DDOG
  "ConvertibleDebtNoncurrent",
  "LongTermNotesAndLoans", // CPAY
];
/** Short-term debt plus current maturities — the whole current line, when filed. */
export const DEBT_CURRENT_TOTAL = ["DebtCurrent"];
/** Only the current maturities of long-term debt; short-term borrowings come on top. */
export const DEBT_CURRENT_MATURITIES = ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"];
export const DEBT_SHORT_TERM = ["ShortTermBorrowings", "CommercialPaper"];
/** All the debt in one fact, as the filer adds it up (often in a footnote). Used
 *  to settle what `LongTermDebt` means (or that it is not the filer's line at
 *  all, under half of it: HST), and as the figure itself when nothing else is
 *  tagged — never over a balance-sheet split, since it can be a subset without
 *  the short-term borrowings (AWK, VLO, HON). */
export const DEBT_TOTAL = [
  "DebtLongtermAndShorttermCombinedAmount",
  "DebtAndCapitalLeaseObligations",
  "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
  "DebtInstrumentCarryingAmount",
];
/** us-gaap defines it as including current maturities, but a filer without a
 *  non-current tag mostly puts its balance-sheet non-current line here (ADBE,
 *  TSLA, SWKS, PTC, KLAC: their own totals equal it plus the current debt). */
export const DEBT_LONG_TERM = ["LongTermDebt"];
/** Last resort: notes of unknown classification (REITs: O, MAA; DHI, VRSN), or
 *  "other" long-term debt (XYZ) — too weak to anchor on, since CPAY files a few
 *  $M of it beside a $10B `LongTermDebt`. */
export const DEBT_UNCLASSIFIED = ["NotesPayable", "SeniorNotes", "OtherLongTermDebtNoncurrent"];
/** Debt split by security rather than by maturity: the two halves add up to
 *  the whole (ESS: $6,016M unsecured + $784M of mortgage notes, nothing else
 *  tagged; AIZ files only the unsecured half). Read beside the unclassified
 *  notes, never over a maturity split. */
export const DEBT_SECURED = ["SecuredDebt"];
export const DEBT_UNSECURED = ["UnsecuredDebt"];

export const CASHFLOW_CONCEPTS: Record<string, string[]> = {
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  depreciationAndAmortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
  ],
};
/** When no combined D&A tag is filed, the two halves many filers tag instead
 *  (MSFT, ADI, IBM, NUE, INTU…: 26 of the public universe had no EBITDA before
 *  #446, so EV/EBITDA returned N/A for them). Where a filer tags both forms they
 *  agree — COHR 242 + 280 = 522, DD 356 + 291 = 647, CTVA 559 + 644 = 1,203 —
 *  and TXN, whose amortization has run off, is depreciation alone.
 *  `OtherDepreciationAndAmortization` is the cash-flow total a few filers use
 *  (WDAY, VEEV) when neither is there. */
export const DEPRECIATION_CONCEPTS = ["Depreciation"];
export const AMORTIZATION_CONCEPTS = ["AmortizationOfIntangibleAssets"];
export const OTHER_DA_CONCEPTS = ["OtherDepreciationAndAmortization"];
/** The D&A inside cost of sales — a part of the total, so it can only correct a
 *  reading smaller than itself (`resolveDepreciationAmortization`). */
export const COST_OF_SALES_DA_CONCEPTS = ["CostOfGoodsAndServicesSoldDepreciationAndAmortization"];
/** The one combined tag filers also use for an operating-expense line beside
 *  the D&A in cost of sales (URI's "non-rental depreciation"). The others are
 *  defined as the whole and are never a line of their own. */
const DA_LINE_CONCEPT = "DepreciationAndAmortization";

/**
 * Non-recurring charges inside operating income (#475): a year's impairments,
 * restructuring, deal costs and losses on disposals, so the DCFs can read a
 * run-rate margin rather than project GIS's 2026 goodwill write-down forever.
 * Filers tag the same charge at several levels at once — GIS files goodwill
 * (1,500), intangibles (303), their total (1,750) AND a restructuring +
 * impairment total (2,898) — so each group takes the LARGEST of its aggregate
 * and the sum of its parts, never the sum of both.
 */
const NON_RECURRING = {
  impairmentTotals: ["GoodwillAndIntangibleAssetImpairment", "AssetImpairmentCharges"],
  goodwill: ["GoodwillImpairmentLoss"],
  intangiblesTotal: ["ImpairmentOfIntangibleAssetsExcludingGoodwill"],
  intangiblesParts: ["ImpairmentOfIntangibleAssetsIndefinitelivedExcludingGoodwill", "ImpairmentOfIntangibleAssetsFinitelived"],
  otherImpairment: ["OtherAssetImpairmentCharges", "ImpairmentOfLongLivedAssetsHeldForUse"],
  restructuring: ["RestructuringCharges", "RestructuringCosts", "OtherRestructuringCosts"],
  restructuringAndImpairment: ["RestructuringCostsAndAssetImpairmentCharges", "RestructuringSettlementAndImpairmentProvisions"],
  deals: ["BusinessCombinationAcquisitionRelatedCosts"],
  acquiredRnd: ["ResearchAndDevelopmentInProcess"],
  // Signed gain(+) / loss(−). Only a LOSS is added back: whether a disposal
  // sits inside operating income varies by filer (GIS: yes; HPE: below it), and
  // subtracting a gain that is not in there would cut a real margin.
  disposals: ["GainLossOnSaleOfBusiness", "DisposalGroupNotDiscontinuedOperationGainLossOnDisposal"],
} as const;

/**
 * Capex, tried in tiers per period end (`resolveCapitalExpenditure`). Until
 * 2026-10 only the first tier was read, so a filer whose cash-flow statement
 * tags capex one level down read as spending nothing: LLY's $7.8B of 2025
 * "purchases of property and equipment" is `…OtherPropertyPlantAndEquipment`,
 * VZ's $17.0B `…OtherProductiveAssets`, D's $12.7B the net tag. 76 of the
 * public universe's latest annual rows had no capex, and the DCFs projected
 * the 5% `capexIntensity` falls back to; these tiers read 34 of them. Most of
 * the rest are banks and insurers, which have no such line, REITs' property
 * purchases, or a company extension tag companyfacts does not carry (URI, COP).
 */
export const CAPEX = {
  /** The whole line, as one figure. */
  total: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  /** Lines that are each a part of PP&E spending, filed instead of a total —
   *  summed, since a filer that splits them has no figure for the whole: EOG's
   *  oil and gas additions ($6,115M) beside its other PP&E ($479M), LNT's
   *  utility and non-utility construction, HST's renewals and its
   *  return-on-investment projects. Acquisitions of oil and gas properties,
   *  real estate and intangibles are left out: those are deals, not the
   *  spending that keeps the asset base running (FANG's 2024 Endeavor deal). */
  parts: [
    "PaymentsToAcquireOtherPropertyPlantAndEquipment", // LLY, WEC, ADP
    "PaymentsToAcquireOtherProductiveAssets", // VZ, INCY
    "PaymentsToAcquireMachineryAndEquipment", // RL
    "PaymentsToAcquireFurnitureAndFixtures", // KKR
    "PaymentsForCapitalImprovements", // AJG, IT, SNA
    "PaymentsForConstructionInProcess", // ED
    "PaymentsToAcquireOilAndGasPropertyAndEquipment", // EOG
    "PaymentsToExploreAndDevelopOilAndGasProperties", // APA, FANG
  ],
  /** Payments net of disposal proceeds: D, MS, CFG. Only a net outflow counts. */
  net: ["PaymentsForProceedsFromProductiveAssets"],
  /** Capitalized software, when it is the only capex line filed (VEEV). Never
   *  added to a PP&E figure: a filer with the total tag does not get its
   *  software added either, and the two tiers should mean the same thing. */
  software: ["PaymentsToDevelopSoftware", "PaymentsForSoftware"],
} as const;
/** The part whose name says least about what was bought (VZ's capex, but also
 *  QCOM's spectrum and COIN's software): summed with the parts, never trusted
 *  to overrule a total tag. */
const CAPEX_CATCH_ALL = "PaymentsToAcquireOtherProductiveAssets";
/** Purchases of whole assets or businesses: never capex, and a part whose very
 *  figure the filer also tags as one of these is that deal, mis-tagged (HST's
 *  Q1 2018 10-Q: $1,019M of hotels as `…OtherPropertyPlantAndEquipment`, the
 *  same $1,019M as `PaymentsToAcquireRealEstate` a year later). Only figures
 *  as filed are matched: two quarters derived by subtraction can agree by
 *  chance (DOW Q3 2022: 134 − 80 = 54 of gas-field development, 54 − 0 = 54
 *  of acquisitions). */
const CAPEX_DEALS = [
  "PaymentsToAcquireRealEstate",
  "PaymentsToAcquireBusinessesNetOfCashAcquired",
  "PaymentsToAcquireBusinessesGross",
  "PaymentsToAcquireOilAndGasProperty",
  "PaymentsToAcquireIntangibleAssets",
];
export const DIVIDENDS_CONCEPTS = ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"];

/**
 * What diluted shares add to basic (`settleShareCounts`), for a filer that tags
 * the basic count and the dilution but not the diluted total: AJG's 2025 10-K
 * has 256.1M basic and 4.0M of share-based dilution, and no 260.1M. The total
 * adjustment where filed, else the sum of whichever parts are.
 */
export const DILUTION = {
  total: ["WeightedAverageNumberDilutedSharesOutstandingAdjustment"],
  parts: [
    "IncrementalCommonSharesAttributableToShareBasedPaymentArrangements",
    "IncrementalCommonSharesAttributableToConversionOfDebtSecurities",
    "IncrementalCommonSharesAttributableToConversionOfPreferredStock",
    "IncrementalCommonSharesAttributableToCallOptionsAndWarrants",
    "IncrementalCommonSharesAttributableToContingentlyIssuableShares",
  ],
} as const;
/** The cover page's shares outstanding, the scale check's anchor when net
 *  income over EPS cannot be one (no EPS, or one too small to divide by). */
export const COVER_SHARES = "EntityCommonStockSharesOutstanding";

// ───────────────────────── pure mapping helpers (unit-tested) ─────────────────────────

const daysBetween = (aISO: string, bISO: string): number => Math.abs(Date.parse(bISO) - Date.parse(aISO)) / 86_400_000;

// Local period type — deliberately NOT imported from marketdata (which imports
// this module) to avoid a cycle. Mirrors marketdata's StatementPeriod literals.
type Period = "annual" | "quarter";

/** A duration fact one fiscal quarter long, excluding 6/9-mo YTD and annual:
 *  13–14 weeks, or the 16-week quarter of a 12-12-12-16 calendar (COST's Q4,
 *  KR's Q1), which a 6-month YTD (~182 days) is still far from. */
export function isQuarterDuration(f: XbrlFact): boolean {
  if (!f.start) return false;
  const d = daysBetween(f.start, f.end);
  return d >= 80 && d <= 120;
}

/** A duration fact ~one full fiscal year long, covering 52/53-week and calendar
 *  years; excludes the quarter (~90d) and 9-month YTD (~270d). 10-K only. */
export function isAnnualDuration(f: XbrlFact): boolean {
  if (!f.start) return false;
  const d = daysBetween(f.start, f.end);
  return d >= 350 && d <= 380;
}

/** Per-period selection knobs: which filing form carries the figure, the
 *  duration predicate for income/cash-flow facts, and the FMP `period` literal. */
const PERIOD_SPEC: Record<Period, { form: string; duration: (f: XbrlFact) => boolean; label: string }> = {
  quarter: { form: "10-Q", duration: isQuarterDuration, label: "Q" },
  annual: { form: "10-K", duration: isAnnualDuration, label: "FY" },
};

interface PickedFact {
  val: number;
  filed: string;
}

/**
 * For one concept's facts: keep only those matching `pred` and filed on `form`
 * (10-Q for quarters, 10-K for annual), group by period-end, and take the
 * **earliest-filed** per end (the original filing — PIT-correct known_at; later
 * restatements/comparatives ignored).
 */
export function selectByEnd(
  facts: XbrlFact[],
  pred: (f: XbrlFact) => boolean,
  form = "10-Q",
): Map<string, PickedFact> {
  const byEnd = new Map<string, PickedFact>();
  for (const f of facts) {
    if (f.form !== form) continue;
    if (!pred(f)) continue;
    const prev = byEnd.get(f.end);
    if (!prev || f.filed < prev.filed) byEnd.set(f.end, { val: f.val, filed: f.filed });
  }
  return byEnd;
}

/** A cumulative fact longer than this is not a year-to-date figure. */
const MAX_YTD_DAYS = 380;
/** A derived weighted share count this far from the longer period's own is a
 *  mixed basis (a split restated in one filing and not the other), not a count. */
const SHARES_DERIVED_BAND = 2;
/** A figure filed this long after its period ended is a later filing's
 *  comparative — a concept the filer only started tagging — not the original. */
const ORIGINAL_FILING_DAYS = 150;

const dayAfter = (iso: string): string => new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10);

/**
 * The quarters a 10-Q never states, derived from the cumulative figures that are
 * filed (#761). A 10-Q states its quarter's income, but most filers state cash
 * flow only year to date (6 and 9 months), and a fiscal Q4 is in no 10-Q at all:
 * the 10-K has the year. So the quarterly cash flow held only fiscal Q1s, one per
 * year, and every quarterly income table skipped Q4.
 *
 * For each us-gaap duration concept, the facts of one fiscal year share a start
 * date; two of them a quarter apart in length give the quarter between their
 * ends: Q2 = 6M − 3M, Q3 = 9M − 6M, Q4 = FY − 9M. Each cumulative figure is its
 * original filing (earliest filed per start and end), and the derived quarter is
 * known when the later of the two was filed — the 10-K for a Q4. A pair is used
 * only when both were filed within `ORIGINAL_FILING_DAYS` of their period end: a
 * concept first tagged in a later filing's comparatives (AAPL's G&A, from 2026)
 * would otherwise date the whole row to that later filing. A quarter a 10-Q
 * states always wins; a 3-month fact a 10-K states (some filers tag their Q4) is
 * used as filed when it is the original, and only as a last resort when it is a
 * later year's comparative. Money is subtracted; a weighted share count is
 * subtracted weighted by days, and dropped when the result is off the longer
 * period's count by more than `SHARES_DERIVED_BAND`×; per-share figures are not
 * derived (`mapCompanyFactsToStatements` divides the derived net income by the
 * derived share count instead). Every derived fact is stamped `form: "10-Q"`, so
 * the quarter path selects it like a stated one.
 */
export function withDerivedQuarters(facts: CompanyFacts): CompanyFacts {
  const src = facts.facts?.["us-gaap"];
  if (!src) return facts;
  const out: Record<string, XbrlConcept> = {};
  for (const [concept, c] of Object.entries(src)) {
    const units: Record<string, XbrlFact[]> = {};
    for (const [unit, list] of Object.entries(c.units)) units[unit] = unit === "USD" || unit === "shares" ? [...list, ...deriveQuarters(list, unit === "shares")] : list;
    out[concept] = { units };
  }
  return { ...facts, facts: { ...facts.facts, "us-gaap": out } };
}

function deriveQuarters(list: XbrlFact[], shares: boolean): XbrlFact[] {
  const stated = new Set<string>();
  // A quarter-long fact a 10-K states (a filer that tags its Q4) is a quarter as filed.
  const statedIn10K = new Map<string, XbrlFact>();
  const byStart = new Map<string, Map<string, XbrlFact>>();
  for (const f of list) {
    if (!f.start || (f.form !== "10-Q" && f.form !== "10-K")) continue;
    if (isQuarterDuration(f)) {
      if (f.form === "10-Q") stated.add(f.end);
      else if (!statedIn10K.has(f.end) || f.filed < statedIn10K.get(f.end)!.filed) statedIn10K.set(f.end, f);
    }
    if (daysBetween(f.start, f.end) > MAX_YTD_DAYS) continue;
    let ends = byStart.get(f.start);
    if (!ends) byStart.set(f.start, (ends = new Map()));
    const prev = ends.get(f.end);
    if (!prev || f.filed < prev.filed) ends.set(f.end, f);
  }
  const original = (f: XbrlFact) => daysBetween(f.end, f.filed) <= ORIGINAL_FILING_DAYS;
  const derived = new Map<string, XbrlFact>();
  const fromTenK = new Set<string>();
  for (const [end, f] of statedIn10K) {
    if (stated.has(end) || !original(f)) continue;
    derived.set(end, { ...f, form: "10-Q" });
    fromTenK.add(end);
  }
  const add = (f: XbrlFact) => {
    if (stated.has(f.end) || fromTenK.has(f.end)) return;
    const prev = derived.get(f.end);
    if (!prev || f.filed < prev.filed) derived.set(f.end, f);
  };
  for (const [start, ends] of byStart) {
    const seq = [...ends.values()].sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < seq.length; i++) {
      const b = seq[i]!;
      const a = seq[i - 1]!;
      if (!original(a) || !original(b)) continue;
      const qStart = dayAfter(a.end);
      if (!isQuarterDuration({ ...b, start: qStart })) continue;
      const filed = a.filed > b.filed ? a.filed : b.filed;
      let val: number;
      if (shares) {
        const da = daysBetween(start, a.end) + 1;
        const db = daysBetween(start, b.end) + 1;
        val = (b.val * db - a.val * da) / (db - da);
        if (!(val > 0) || val > b.val * SHARES_DERIVED_BAND || val < b.val / SHARES_DERIVED_BAND) continue;
        val = Math.round(val);
      } else {
        val = b.val - a.val;
      }
      add({ start: qStart, end: b.end, val, filed, form: "10-Q", fp: b.fp, fy: b.fy, accn: b.accn, derived: true });
    }
  }
  // A quarter a later 10-K states as a comparative (HUBB's FY2025 10-K carries
  // Q4 2024) only where nothing filed at the time gives it.
  for (const [end, f] of statedIn10K) if (!stated.has(end) && !derived.has(end)) derived.set(end, { ...f, form: "10-Q" });
  return [...derived.values()];
}

const usGaap = (facts: CompanyFacts, concept: string): XbrlFact[] => {
  const c = facts.facts?.["us-gaap"]?.[concept];
  if (!c) return [];
  // EPS lives under "USD/shares", share counts under "shares", money under "USD".
  return c.units["USD"] ?? c.units["USD/shares"] ?? c.units["shares"] ?? Object.values(c.units)[0] ?? [];
};

/**
 * Merge candidate concepts by period-end. Candidates are alternative tags for
 * the *same* line (priority-ordered), so the highest-priority concept present
 * for a given end wins, and lower-priority ones only fill ends it doesn't cover.
 * (A single concept rarely spans every period — e.g. a filer that migrated
 * `RevenueFromContractWithCustomerExcludingAssessedTax` → `Revenues` mid-history
 * needs both to cover all years.) Empty map if no candidate is present.
 */
function resolve(
  facts: CompanyFacts,
  candidates: string[],
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const merged = new Map<string, PickedFact>();
  for (const concept of candidates) {
    for (const [end, pick] of selectByEnd(usGaap(facts, concept), pred, form)) {
      if (!merged.has(end)) merged.set(end, pick);
    }
  }
  return merged;
}

/**
 * D&A per period end: the combined tag where filed, else depreciation plus
 * intangible amortization, else the cash-flow "other D&A" total. Each end is
 * decided on its own, so a filer that switched from the combined tag to the
 * two lines is covered across the switch.
 *
 * The D&A in cost of sales is a part of the total, so a reading smaller than
 * it cannot be the total. When the reading is `DepreciationAndAmortization`,
 * it is the operating-expense line beside it, and the two add up (URI 2025:
 * $438M non-rental + $2,670M of rental depreciation = $3,108M). When it is a
 * tag defined as the whole, the filer's tags disagree and the larger one is
 * the nearer (HD FY2025: $4,059M over $3,514M; NDSN). With nothing else
 * filed it is the floor (PEG). Otherwise it is ignored: CF, EXC and VLO file
 * it as most of a total that already includes it.
 */
export function resolveDepreciationAmortization(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const combinedTags = CASHFLOW_CONCEPTS.depreciationAndAmortization!;
  const combined = resolve(facts, combinedTags, pred, form);
  const asLine = resolve(facts, [DA_LINE_CONCEPT], pred, form);
  const totals = resolve(facts, combinedTags.filter((c) => c !== DA_LINE_CONCEPT), pred, form);
  const dep = resolve(facts, DEPRECIATION_CONCEPTS, pred, form);
  const amort = resolve(facts, AMORTIZATION_CONCEPTS, pred, form);
  const other = resolve(facts, OTHER_DA_CONCEPTS, pred, form);
  const costOfSales = resolve(facts, COST_OF_SALES_DA_CONCEPTS, pred, form);
  const out = new Map(combined);
  for (const [end, d] of dep) {
    if (out.has(end)) continue;
    const a = amort.get(end);
    out.set(end, { val: d.val + (a?.val ?? 0), filed: a && a.filed > d.filed ? a.filed : d.filed });
  }
  for (const [end, o] of other) if (!out.has(end)) out.set(end, o);
  for (const [end, c] of costOfSales) {
    const read = out.get(end);
    if (read && read.val >= c.val) continue;
    // The combined tags are tried whole-first, so the line was read only where no whole is filed.
    const isLine = read !== undefined && asLine.has(end) && !totals.has(end);
    out.set(end, isLine ? { val: read.val + c.val, filed: c.filed > read.filed ? c.filed : read.filed } : c);
  }
  return out;
}

/**
 * Capital expenditure per period end, positive (the caller flips the sign),
 * each end decided on its own: the total tag where filed (WEC's 2022 files
 * both the total and its own `…OtherPropertyPlantAndEquipment` part, and the
 * total wins), else the sum of the part lines, else the net tag when it is an
 * outflow, else capitalized software. Ends with none of them are left out.
 *
 * A "total" under half of a PP&E part is not their total but another line:
 * the next total tag is tried, then the parts. AEP's
 * `PaymentsToAcquireProductiveAssets` is its acquisitions ($3,453M in 2025,
 * $399M in 2024) beside $8,453M and $7,631M of construction expenditures, so
 * the parts win; URI's first total tag held only its non-rental capex ($120M
 * in 2014 beside $1,701M of rental equipment), and its second the whole
 * ($1,821M). A part a little over the total is left alone: MCHP's $111M of
 * `…OtherProductiveAssets` beside a $91M total that is the cash-flow line.
 * And that catch-all never overrules a total, however large: QCOM's FY2010
 * $1,064M under it is India spectrum beside $426M of capex, COIN's 2021 $61M
 * capitalized software.
 */
export function resolveCapitalExpenditure(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const totals = CAPEX.total.map((c) => selectByEnd(usGaap(facts, c), pred, form));
  // Every figure filed per period end, derived quarters left out (`CAPEX_DEALS`).
  const asFiled = (tags: readonly string[]) => {
    const byEnd = new Map<string, Set<number>>();
    for (const c of tags) for (const f of usGaap(facts, c)) if (!f.derived && f.form === form && pred(f)) byEnd.set(f.end, (byEnd.get(f.end) ?? new Set()).add(f.val));
    return byEnd;
  };
  const parts = CAPEX.parts.map((c) => ({ tag: c as string, byEnd: selectByEnd(usGaap(facts, c), pred, form), filed: asFiled([c]) }));
  const deals = asFiled(CAPEX_DEALS);
  const ends = new Set<string>();
  for (const m of [...totals, ...parts.map((x) => x.byEnd)]) for (const e of m.keys()) ends.add(e);
  const out = new Map<string, PickedFact>();
  for (const end of ends) {
    // A part equal to another to the dollar is one line tagged twice (VMRK 2018:
    // $188.5M as both capital improvements and other PP&E), counted once; one
    // equal to a deal the filer tags is that deal (HST), left out.
    const picks = parts
      .map(({ tag, byEnd, filed }) => ({ tag, p: byEnd.get(end), filed: filed.get(end) }))
      .filter((x, i, all): x is { tag: string; p: PickedFact; filed: Set<number> | undefined } =>
        x.p !== undefined && x.p.val > 0 && all.findIndex((y) => y.p?.val === x.p!.val) === i && !(x.filed?.has(x.p.val) && deals.get(end)?.has(x.p.val)));
    const largestPpePart = Math.max(0, ...picks.filter((x) => x.tag !== CAPEX_CATCH_ALL).map((x) => x.p.val));
    // The first total tag that is not under half a PP&E part (URI 2014's second
    // one). Its size, since the caller drops the sign: CCI filed 2019's as −$2,057M.
    const total = totals.map((m) => m.get(end)).find((t) => t !== undefined && !(largestPpePart > 2 * Math.abs(t.val)));
    if (total) out.set(end, total);
    else if (picks.length > 0) out.set(end, { val: picks.reduce((n, x) => n + x.p.val, 0), filed: picks.reduce((f, x) => (x.p.filed > f ? x.p.filed : f), "") });
  }
  for (const tier of [CAPEX.net, CAPEX.software]) {
    for (const [end, p] of resolve(facts, [...tier], pred, form)) if (!out.has(end) && p.val > 0) out.set(end, p);
  }
  return out;
}

/**
 * Total debt per period end (instant facts), each end decided on its own. The
 * current line is `DebtCurrent` when filed (it already holds the short-term
 * borrowings), else current maturities plus short-term borrowings.
 *   1. A non-current line at least half of `LongTermDebt` (or with no
 *      `LongTermDebt` beside it) + the current line. A smaller one is a sliver
 *      that is not the whole line (EXC: $0.02B of notes beside $44.7B).
 *   2. Else `LongTermDebt`, read one of two ways: as the non-current line (+ the
 *      current line) or as including current maturities (+ short-term
 *      borrowings). The filer's own total picks whichever it is closer to;
 *      without one, the non-current reading, which is the common usage. Passed
 *      over when it and the current debt are under half of the notes in step
 *      4: then it is a sliver beside the real line (PHM: $44M beside $1,631M
 *      of notes payable; ESS until 2021: its $639M of mortgages beside $5,307M
 *      unsecured). The current debt counts because notes can be the whole of
 *      both: SWKS's $997M of senior notes are its $497M + $500M current. And
 *      passed over when, with the current line, it is under half of the
 *      filer's own total: then it is someone else's debt in a footnote (HST
 *      tags its unconsolidated joint ventures' $1,274M as `LongTermDebt` beside
 *      its own $5,077M; in 2014, 2016 and 2017 that was even over half of the
 *      senior notes).
 *   3. Else the filer's own total.
 *   4. Else the notes: the larger of the unclassified notes and secured +
 *      unsecured debt, plus whatever current debt is filed.
 * Ends where it all sums to 0 are left out (no debt, or none tagged).
 */
export function resolveInventory(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const total = resolve(facts, INVENTORY_TOTAL, pred, form);
  const parts = Object.fromEntries(
    Object.entries(INVENTORY_PARTS).map(([k, tags]) => [k, resolve(facts, [...tags], pred, form)]),
  ) as Record<keyof typeof INVENTORY_PARTS, Map<string, PickedFact>>;
  const ends = new Set<string>(total.keys());
  for (const m of Object.values(parts)) for (const e of m.keys()) ends.add(e);

  const out = new Map<string, PickedFact>();
  for (const end of ends) {
    const whole = total.get(end);
    if (whole) {
      out.set(end, whole);
      continue;
    }
    const at = (k: keyof typeof INVENTORY_PARTS) => parts[k].get(end);
    const used = (at("finishedAndWip")
      ? [at("finishedAndWip"), at("raw")]
      : at("wipAndRaw")
        ? [at("wipAndRaw"), at("finished")]
        : [at("finished"), at("wip"), at("raw")]
    ).filter((p): p is PickedFact => p !== undefined);
    const val = used.reduce((n, p) => n + p.val, 0);
    if (val > 0) out.set(end, { val, filed: used.reduce((f, p) => (p.filed > f ? p.filed : f), "") });
  }
  return out;
}

/**
 * Short-term investments per period end: the filer's own line where tagged,
 * else its cash-and-investments line less its cash. Ends with none are left
 * out, as are a negative remainder (the two lines disagree).
 */
export function resolveShortTermInvestments(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const out = resolve(facts, SHORT_TERM_INVESTMENTS, pred, form);
  const combined = resolve(facts, CASH_AND_SHORT_TERM_INVESTMENTS, pred, form);
  const cash = resolve(facts, BALANCE_CONCEPTS.cashAndCashEquivalents!, pred, form);
  for (const [end, both] of combined) {
    if (out.has(end)) continue;
    const c = cash.get(end);
    if (c && both.val > c.val) out.set(end, { val: both.val - c.val, filed: both.filed > c.filed ? both.filed : c.filed });
  }
  for (const [end, p] of out) if (!(p.val > 0)) out.delete(end);
  return out;
}

export function resolveTotalDebt(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const groups = {
    noncurrent: resolve(facts, DEBT_NONCURRENT, pred, form),
    currentTotal: resolve(facts, DEBT_CURRENT_TOTAL, pred, form),
    maturities: resolve(facts, DEBT_CURRENT_MATURITIES, pred, form),
    shortTerm: resolve(facts, DEBT_SHORT_TERM, pred, form),
    total: resolve(facts, DEBT_TOTAL, pred, form),
    longTerm: resolve(facts, DEBT_LONG_TERM, pred, form),
    unclassified: resolve(facts, DEBT_UNCLASSIFIED, pred, form),
    secured: resolve(facts, DEBT_SECURED, pred, form),
    unsecured: resolve(facts, DEBT_UNSECURED, pred, form),
  };
  const ends = new Set<string>();
  for (const m of Object.values(groups)) for (const e of m.keys()) ends.add(e);

  const out = new Map<string, PickedFact>();
  for (const end of ends) {
    const used: PickedFact[] = [];
    // A zero fact counts as absent: TYL files `LongTermDebtNoncurrent = 0`
    // beside the line that actually holds their debt.
    const peek = (m: Map<string, PickedFact>): PickedFact | undefined => {
      const p = m.get(end);
      return p && p.val > 0 ? p : undefined;
    };
    const take = (m: Map<string, PickedFact>): number | undefined => {
      const p = peek(m);
      if (p) used.push(p);
      return p?.val;
    };
    const shortTerm = () => take(groups.shortTerm) ?? 0;
    const current = () => take(groups.currentTotal) ?? (take(groups.maturities) ?? 0) + shortTerm();

    // Step 4's notes, weighed up front so step 2 can tell a sliver of `LongTermDebt`.
    const unclassified = peek(groups.unclassified);
    const bySecurity = [peek(groups.secured), peek(groups.unsecured)].filter((p): p is PickedFact => p !== undefined);
    const securitySum = bySecurity.reduce((n, p) => n + p.val, 0);
    const notes = (unclassified?.val ?? 0) >= securitySum ? (unclassified ? [unclassified] : []) : bySecurity;
    const notesVal = notes.reduce((n, p) => n + p.val, 0);

    const longTerm = take(groups.longTerm);
    const noncurrent = take(groups.noncurrent);
    // Step 2's larger reading, against the notes and the filer's own total,
    // since either can be the whole of both: SWKS's notes are its 496 of
    // LongTermDebt + 499 current, and TSLA 2022's 1,029 is under half its
    // 2,061 carrying amount, but with the 1,016 current it is the whole.
    const currentVal = peek(groups.currentTotal)?.val ?? (peek(groups.maturities)?.val ?? 0) + (peek(groups.shortTerm)?.val ?? 0);
    const ownTotal = peek(groups.total)?.val ?? 0;
    let val: number;
    if (noncurrent !== undefined && (longTerm === undefined || noncurrent >= longTerm / 2)) {
      val = noncurrent + current();
    } else if (longTerm !== undefined && longTerm + currentVal >= notesVal / 2 && longTerm + currentVal >= ownTotal / 2) {
      const asNoncurrent = longTerm + current();
      const withCurrent = longTerm + shortTerm();
      const total = take(groups.total);
      val = total !== undefined && Math.abs(withCurrent - total) < Math.abs(asNoncurrent - total) ? withCurrent : asNoncurrent;
    } else {
      const total = take(groups.total);
      if (total !== undefined) val = total;
      else {
        used.push(...notes);
        val = notesVal + current();
      }
    }
    if (val > 0) out.set(end, { val, filed: used.reduce((f, p) => (p.filed > f ? p.filed : f), "") });
  }
  return out;
}

/**
 * Total non-recurring charges per period end (positive = a charge; 0 is not
 * stored). Each tag is read on its own — not merged across a group's candidates
 * like `resolve` does — because in a group the tags are levels of one another,
 * not alternatives for the same line.
 */
export function resolveNonRecurringCharges(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const byTag = new Map<string, Map<string, PickedFact>>();
  for (const tags of Object.values(NON_RECURRING)) for (const t of tags) byTag.set(t, selectByEnd(usGaap(facts, t), pred, form));
  const ends = new Set<string>();
  for (const m of byTag.values()) for (const e of m.keys()) ends.add(e);

  const out = new Map<string, PickedFact>();
  for (const end of ends) {
    let filed = "";
    const val = (tag: string): number => {
      const p = byTag.get(tag)?.get(end);
      if (!p) return 0;
      if (p.filed > filed) filed = p.filed;
      return p.val;
    };
    const charge = (tag: string) => Math.max(0, val(tag));
    const most = (tags: readonly string[]) => Math.max(0, ...tags.map(charge));
    const sum = (tags: readonly string[]) => tags.reduce((n, t) => n + charge(t), 0);

    const intangibles = Math.max(most(NON_RECURRING.intangiblesTotal), sum(NON_RECURRING.intangiblesParts));
    const impairment = Math.max(most(NON_RECURRING.impairmentTotals), most(NON_RECURRING.goodwill) + intangibles + sum(NON_RECURRING.otherImpairment));
    const restructuring = most(NON_RECURRING.restructuring);
    const both = Math.max(most(NON_RECURRING.restructuringAndImpairment), impairment + restructuring);
    const disposalLoss = Math.max(0, -Math.min(0, ...NON_RECURRING.disposals.map(val)));
    const total = both + sum(NON_RECURRING.deals) + sum(NON_RECURRING.acquiredRnd) + disposalLoss;
    if (total > 0) out.set(end, { val: total, filed });
  }
  return out;
}

type Row = Record<string, unknown>;

/**
 * Assemble FMP-shaped rows for one statement from a field→concept spec. `kind`
 * picks instant (balance) vs quarter-duration (income/cash flow) selection.
 * Rows are keyed by period-end; `known_at` (as `acceptedDate`) is that period's
 * original filing date. Returned newest-first (marketdata's convention).
 */
function buildRows(
  symbol: string,
  facts: CompanyFacts,
  spec: Record<string, string[]>,
  kind: "duration" | "instant",
  period: Period,
): Map<string, Row> {
  const { form, duration, label } = PERIOD_SPEC[period];
  const pred = kind === "instant" ? (f: XbrlFact) => f.start === undefined : duration;
  const rows = new Map<string, Row>();
  const filedByEnd = new Map<string, string>();

  const ensure = (end: string): Row => {
    let r = rows.get(end);
    if (!r) {
      r = { symbol, date: end, period: label };
      rows.set(end, r);
    }
    return r;
  };

  for (const [field, candidates] of Object.entries(spec)) {
    const picks = resolve(facts, candidates, pred, form);
    for (const [end, pick] of picks) {
      ensure(end)[field] = pick.val;
      // Track the latest filing across the row's fields as its knowable moment.
      const prev = filedByEnd.get(end);
      if (!prev || pick.filed > prev) filedByEnd.set(end, pick.filed);
    }
  }
  for (const [end, r] of rows) {
    r.acceptedDate = filedByEnd.get(end);
    r.fiscalYear = Number(end.slice(0, 4));
  }
  return rows;
}

/** How far revenue may sit from the total an identity gives and still be that
 *  line (rounding, a sliver of excise tax). */
const REVENUE_IDENTITY_TOLERANCE = 0.01;

/** A lessor's rent, which ASC 842 keeps out of contract revenue. CPT tags no
 *  revenue total at all: its $1,573.5M of property revenue is this line, beside
 *  $13.0M of contract revenue. */
const LEASE_INCOME_CONCEPTS = ["OperatingLeaseLeaseIncome"];
/** Mark-to-market on hedges that a producer books inside its top line (EQT). */
const HEDGE_GAIN_CONCEPTS = ["DerivativeInstrumentsNotDesignatedAsHedgingInstrumentsGainLossNet"];
/** How close a gap between two revenue lines must come to the hedge result to
 *  be it (EQT's 2023: a $1,864M gap, $1,839M of derivative gains). */
const HEDGE_GAP_TOLERANCE = 0.05;

/** What a row's revenue is checked against, per period end. */
export interface RevenueEvidence {
  /** Each `INCOME_CONCEPTS.revenue` tag's value at this end, in priority order. */
  candidates: readonly (number | undefined)[];
  /** `CostsAndExpenses`: with operating income, the top line by subtraction. */
  costsAndExpenses?: number;
  /** `OperatingLeaseLeaseIncome`: a line of revenue outside the candidates. */
  leaseIncome?: number;
  /** Gains on derivatives not designated as hedges, booked in the top line by some producers. */
  hedgeGain?: number;
}

/**
 * Settle a row's revenue on the income statement's top line. The tags are
 * tried in priority order, and the first, the contract revenue of ASC 606, can
 * be only part of it: ADM and BG book most of their sales as commodity
 * contracts under ASC 815 (ADM's 2025: $25.0B of contract revenue in $80.3B),
 * URI its equipment rentals as lease income under ASC 842 ($3.7B of $16.1B),
 * MELI its lending income; REITs and towers their rent (AMT's 2025: $0.94B in
 * $10.64B, UDR $11M in $1.71B), CNC its insurance premiums ($174.6B in
 * $194.8B), CEG and KMI their energy derivatives and leases. That read the
 * margin as −200% against a cost of sales of the whole business, and AMT's
 * EV/Revenue at 10× its value. `Revenues` is not simply preferred, since some
 * filers tag the gross revenue before intersegment eliminations with it (RSG
 * $19.0B against $16.6B; HAS $5.37B against $4.70B). So the evidence, in order:
 *   1. Cost of revenue + gross profit, when both are filed.
 *   2. Operating income + `CostsAndExpenses`, when both are filed (AMT, CNC,
 *      KMI, CEG — and HAS, whose $11.1M + $4,690.2M confirms its contract
 *      revenue). It only ever raises revenue: a top line below the contract
 *      revenue nets hedging losses against it (EQT's 2022: $12.1B of gas sales,
 *      $7.5B after a $4.6B derivative loss), which no model should read as sales.
 *      For the same reason a higher top line is passed over when what it adds
 *      is the year's hedge gain (EQT's 2023: $5.04B of sales, $6.91B in all).
 *   The first identity that some candidate meets settles it: the picked
 *   revenue if it fits, else the first candidate that does.
 *   3. Without one, a picked revenue under half of another revenue line filed
 *      for the same end is a slice, not the top line: the first candidate at
 *      least twice it wins, then lease income (CPT). Intersegment eliminations
 *      are nowhere near that (RSG's contract revenue is 87% of `Revenues`).
 * Banks and insurers fall under 3 as well: their contract revenue is fee
 * income alone (CFG $1.6B of $8.2B, MET $2.4B of $77.1B), and `Revenues` is net
 * revenue, the line GS already reads through `RevenuesNetOfInterestExpense`.
 */
export function reconcileRevenue(row: Row, evidence: RevenueEvidence): void {
  const { revenue } = row;
  if (typeof revenue !== "number") return;
  const others = [...evidence.candidates, evidence.leaseIncome].filter((v): v is number => typeof v === "number");
  const sum = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a + b : undefined);
  const identities = [
    { total: sum(row.costOfRevenue, row.grossProfit), mayLower: true },
    { total: sum(row.operatingIncome, evidence.costsAndExpenses), mayLower: false },
  ];
  for (const { total, mayLower } of identities) {
    if (total === undefined || !(total > 0)) continue;
    const fits = (v: number) => Math.abs(v - total) <= total * REVENUE_IDENTITY_TOLERANCE;
    if (fits(revenue)) return;
    const match = others.find(fits);
    if (match === undefined) continue;
    const hedge = evidence.hedgeGain;
    const isHedge = hedge !== undefined && Math.abs(match - revenue - hedge) <= Math.abs(match - revenue) * HEDGE_GAP_TOLERANCE;
    if (mayLower || (match > revenue && !isHedge)) row.revenue = match;
    return;
  }
  if (!(revenue > 0)) return;
  const whole = others.find((v) => v >= revenue * 2);
  if (whole !== undefined) row.revenue = whole;
}

/** A rescaled count must land this close to its anchor. */
const SHARE_SCALE_BAND = 3;
/** No listed company the mapper serves has fewer weighted shares (NVR, the
 *  smallest count in the public universe, has ~3M): a count below this is a
 *  scale slip, and a rescale never lands below it. */
const MIN_SHARES = 1_000_000;
/** Net income over an EPS smaller than this is too rounded to anchor on
 *  (0.05 may be 0.045 or 0.055: ±10%). */
const MIN_ANCHOR_EPS = 0.1;
/** The cover page is dated after the period end: weeks for most filers, up to
 *  four months for a late 10-K. */
const COVER_DATE_DAYS = 150;
/** Dilution this large a share of basic is a total filed under a part's tag
 *  (GEN 2008: 884M "incremental" beside 868M basic; L 2013), not dilution. */
const MAX_DILUTION = 0.5;

/** The dilution added to basic shares per period end: the total adjustment,
 *  else the sum of the parts filed. */
export function resolveDilution(
  facts: CompanyFacts,
  pred: (f: XbrlFact) => boolean,
  form: string,
): Map<string, PickedFact> {
  const out = resolve(facts, [...DILUTION.total], pred, form);
  const parts = DILUTION.parts.map((c) => selectByEnd(usGaap(facts, c), pred, form));
  const ends = new Set<string>();
  for (const m of parts) for (const e of m.keys()) ends.add(e);
  for (const end of ends) {
    if (out.has(end)) continue;
    const picks = parts.map((m) => m.get(end)).filter((p): p is PickedFact => p !== undefined);
    out.set(end, { val: picks.reduce((n, p) => n + p.val, 0), filed: picks.reduce((f, p) => (p.filed > f ? p.filed : f), "") });
  }
  return out;
}

/** The cover-page share count of the filing for a period: the first cover
 *  date on or after its end, within `COVER_DATE_DAYS`, on the same form. */
export function coverSharesFor(facts: CompanyFacts, end: string, form: string): number | undefined {
  const list = facts.facts?.dei?.[COVER_SHARES]?.units["shares"] ?? [];
  let best: XbrlFact | undefined;
  for (const f of list) {
    if (f.form !== form || f.end < end || daysBetween(end, f.end) > COVER_DATE_DAYS || !(f.val > 0)) continue;
    if (!best || f.end < best.end) best = f;
  }
  return best?.val;
}

/** The count rescaled by the power of 1,000 that brings it nearest the anchor;
 *  null when that still leaves it more than `SHARE_SCALE_BAND`× away or under
 *  `MIN_SHARES`. */
function rescaleShares(val: number, anchor: number): number | null {
  const k = Math.round(Math.log10(anchor / val) / 3);
  if (k === 0) return val;
  const fixed = Math.round(val * 1000 ** k);
  const ratio = fixed / anchor;
  return ratio > SHARE_SCALE_BAND || ratio < 1 / SHARE_SCALE_BAND || fixed < MIN_SHARES ? null : fixed;
}

/**
 * Settle a row's two weighted share counts.
 *
 * Scale: a filer's XBRL can carry a count at the wrong scale — MCD has filed
 * its weighted shares in millions (713.4 basic, 716.4 diluted for 2025) in
 * every 10-K and 10-Q since early 2024, COP, EG, GRMN and WRB in thousands for
 * years at a time, SHW and NTRS a thousand and a million times over. Each count
 * is checked against an anchor: net income over the matching EPS (8,563M /
 * 11.95 = 716.6M for MCD). A count that a power of 1,000 brings within
 * `SHARE_SCALE_BAND`× of it is rescaled; within ~30× nothing changes. The
 * anchor can be the wrong one — HAL's 10-Qs for 2021–24 carry EPS a million
 * times over (0.65 as 650,000), which would read its 881M shares as 881 — so a
 * rescale never lands under `MIN_SHARES`, and a count of at least that many is
 * otherwise left as filed. Without a diluted EPS the settled basic count
 * anchors the diluted one (COP's 2018 diluted 1,175,538, in thousands, beside
 * basic EPS only): the two are never 30× apart. Only a count under it, which
 * cannot be right, is checked against the cover page's shares outstanding
 * when nothing else can anchor
 * (a derived fiscal Q4 has none of its own); the cover is not trusted further,
 * since it can be the spun-off shell's handful of shares (VTRS's 2019
 * comparatives) or itself a thousand times over (HBAN, Q4 2014). A count under
 * `MIN_SHARES` that its anchor contradicts and no power of 1,000 fixes is
 * dropped; one with no anchor at all is left as filed.
 *
 * Missing diluted count, with the basic one filed:
 *   - diluted EPS equal to basic and negative: a loss year, where dilution is
 *     antidilutive and ignored, so the counts are equal by definition (TTWO's
 *     fiscal 2026);
 *   - else basic + the dilution the filer tags (AJG, `resolveDilution`), when
 *     it is under `MAX_DILUTION` of basic;
 *   - else, diluted EPS equal to basic: any dilution is inside the EPS rounding.
 * Nothing is derived without a diluted EPS to show what dilution was (LEN's
 * fiscal 2025 files basic only). Filers whose counts companyfacts does not
 * carry at all — per class of stock (BRK-B, V, STZ, HSY, ERIE…), or, for recent
 * years, LYB, SJM, VTRS, KKR, REG — stay as they are, for the readers' basic /
 * FMP fallbacks.
 */
export function settleShareCounts(row: Row, ctx: { dilution?: PickedFact; cover?: number }): void {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const ni = num(row.netIncome);
  const guard = (field: "weightedAverageShsOut" | "weightedAverageShsOutDil", eps: number | undefined, other?: number) => {
    const val = num(row[field]);
    if (val === undefined || !(val > 0)) return;
    const fromEps = ni !== undefined && eps !== undefined && Math.abs(eps) >= MIN_ANCHOR_EPS && Math.sign(eps) === Math.sign(ni) ? ni / eps : undefined;
    const anchor = fromEps ?? other ?? (val < MIN_SHARES ? ctx.cover : undefined);
    if (anchor === undefined) return;
    const fixed = rescaleShares(val, anchor);
    if (fixed !== null) row[field] = fixed;
    else if (val < MIN_SHARES) delete row[field];
  };
  const eps = num(row.eps);
  const epsDil = num(row.epsDiluted);
  guard("weightedAverageShsOut", eps);
  const basic = num(row.weightedAverageShsOut);
  if (num(row.weightedAverageShsOutDil) === undefined && basic !== undefined && basic > 0) {
    const sameEps = eps !== undefined && epsDil !== undefined && eps === epsDil;
    if (sameEps && epsDil < 0) row.weightedAverageShsOutDil = basic;
    else if (ctx.dilution !== undefined && ctx.dilution.val >= 0 && ctx.dilution.val < basic * MAX_DILUTION) {
      row.weightedAverageShsOutDil = basic + ctx.dilution.val;
      if (typeof row.acceptedDate === "string" && ctx.dilution.filed > row.acceptedDate) row.acceptedDate = ctx.dilution.filed;
    } else if (sameEps) row.weightedAverageShsOutDil = basic;
  }
  guard("weightedAverageShsOutDil", epsDil, num(row.weightedAverageShsOut));
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface EdgarStatements {
  income: Row[];
  balance: Row[];
  cashflow: Row[];
}

/**
 * Map a companyfacts payload to FMP-shaped quarterly income / balance /
 * cash-flow rows (newest-first). Derives the fields FMP supplies but XBRL has no
 * single tag for: total debt (current+non-current), EBITDA (operating income +
 * D&A), and free cash flow (OCF − capex). Sign conventions match FMP/value-scope
 * (capex & dividends negative). On the quarter path the quarters no 10-Q states —
 * fiscal Q4, and the cash flow a filer states only year to date — are derived
 * first (`withDerivedQuarters`).
 */
export function mapCompanyFactsToStatements(symbol: string, filed: CompanyFacts, period: Period): EdgarStatements {
  const sym = symbol.toUpperCase();
  const facts = period === "quarter" ? withDerivedQuarters(filed) : filed;
  const { form, duration } = PERIOD_SPEC[period];
  const newestFirst = (rows: Map<string, Row>): Row[] =>
    [...rows.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Income — duration; add derived EBITDA = operatingIncome + D&A.
  const incomeRows = buildRows(sym, facts, INCOME_CONCEPTS, "duration", period);
  const daDuration = resolveDepreciationAmortization(facts, duration, form);
  const nonRecurring = resolveNonRecurringCharges(facts, duration, form);
  const revenueByTag = INCOME_CONCEPTS.revenue!.map((c) => selectByEnd(usGaap(facts, c), duration, form));
  const costsAndExpenses = selectByEnd(usGaap(facts, "CostsAndExpenses"), duration, form);
  const leaseIncome = resolve(facts, LEASE_INCOME_CONCEPTS, duration, form);
  const hedgeGain = resolve(facts, HEDGE_GAIN_CONCEPTS, duration, form);
  const dilution = resolveDilution(facts, duration, form);
  for (const [end, r] of incomeRows) {
    reconcileRevenue(r, {
      candidates: revenueByTag.map((m) => m.get(end)?.val),
      costsAndExpenses: costsAndExpenses.get(end)?.val,
      leaseIncome: leaseIncome.get(end)?.val,
      hedgeGain: hedgeGain.get(end)?.val,
    });
    settleShareCounts(r, { dilution: dilution.get(end), cover: coverSharesFor(facts, end, form) });
    const oi = typeof r.operatingIncome === "number" ? r.operatingIncome : undefined;
    const da = daDuration.get(end)?.val;
    if (oi !== undefined && da !== undefined) r.ebitda = oi + da;
    const nr = nonRecurring.get(end);
    if (nr !== undefined) r.nonRecurringCharges = nr.val;
    // A derived quarter has no per-share figure of its own (see withDerivedQuarters).
    if (period === "quarter" && typeof r.netIncome === "number") {
      if (typeof r.eps !== "number" && typeof r.weightedAverageShsOut === "number" && r.weightedAverageShsOut > 0) r.eps = round2(r.netIncome / r.weightedAverageShsOut);
      if (typeof r.epsDiluted !== "number" && typeof r.weightedAverageShsOutDil === "number" && r.weightedAverageShsOutDil > 0) r.epsDiluted = round2(r.netIncome / r.weightedAverageShsOutDil);
    }
  }

  // Balance — instant; compose total debt from current + non-current.
  const balanceRows = buildRows(sym, facts, BALANCE_CONCEPTS, "instant", period);
  const instant = (f: XbrlFact) => f.start === undefined;
  const debt = resolveTotalDebt(facts, instant, form);
  const inventory = resolveInventory(facts, instant, form);
  const shortTermInvestments = resolveShortTermInvestments(facts, instant, form);
  for (const [end, r] of balanceRows) {
    const total = debt.get(end)?.val;
    if (total !== undefined) r.totalDebt = total;
    const inv = inventory.get(end)?.val;
    if (inv !== undefined) r.inventory = inv;
    const sti = shortTermInvestments.get(end)?.val;
    if (sti !== undefined) r.shortTermInvestments = sti;
  }

  // Cash flow — duration; negate outflows to FMP sign, derive FCF = OCF − capex.
  const cashflowRows = buildRows(sym, facts, CASHFLOW_CONCEPTS, "duration", period);
  // The D&A line is filled from the same resolution as EBITDA's, so the two
  // statements never disagree about it.
  // Amortization of acquired intangibles on its own line too: non-cash, and it
  // runs off as the intangibles are written down, so the DCFs treat it apart
  // from depreciation (#446).
  const amortization = resolve(facts, AMORTIZATION_CONCEPTS, duration, form);
  for (const [end, r] of cashflowRows) {
    const da = daDuration.get(end);
    if (da !== undefined) r.depreciationAndAmortization = da.val;
    const am = amortization.get(end);
    if (am !== undefined) r.amortizationOfIntangibles = am.val;
  }
  const capex = resolveCapitalExpenditure(facts, duration, form);
  const dividends = resolve(facts, DIVIDENDS_CONCEPTS, duration, form);
  for (const [end, r] of cashflowRows) {
    const capexVal = capex.get(end)?.val;
    if (capexVal !== undefined) r.capitalExpenditure = -Math.abs(capexVal);
    const div = dividends.get(end)?.val;
    if (div !== undefined) r.commonDividendsPaid = -Math.abs(div);
    const ocf = typeof r.operatingCashFlow === "number" ? r.operatingCashFlow : undefined;
    if (ocf !== undefined && capexVal !== undefined) r.freeCashFlow = ocf - Math.abs(capexVal);
  }

  return { income: newestFirst(incomeRows), balance: newestFirst(balanceRows), cashflow: newestFirst(cashflowRows) };
}

// ───────────────────────── client ─────────────────────────

const factsInFlight = new Map<number, Promise<CompanyFacts | null>>();

/** Fetch a company's full XBRL companyfacts (all concepts, all periods).
 *  Concurrent calls for the same CIK collapse onto one request — the payload is
 *  large (often >10 MB) and warming income+balance+cashflow × annual+quarter
 *  would otherwise pull it up to 6× at once, risking SEC rate limits. */
export async function fetchCompanyFacts(cik: number): Promise<CompanyFacts | null> {
  const existing = factsInFlight.get(cik);
  if (existing) return existing;
  const p = secGet<CompanyFacts>(`${SEC_DATA_BASE}/api/xbrl/companyfacts/CIK${padCik(cik)}.json`).finally(() =>
    factsInFlight.delete(cik),
  );
  factsInFlight.set(cik, p);
  return p;
}

/** Resolve ticker → CIK → companyfacts → FMP-shaped statements for `period`
 *  (annual from 10-K, quarter from 10-Q). Null when the ticker isn't an EDGAR
 *  filer (foreign / ADR) or has no facts — callers fall back accordingly. */
export async function fetchStatements(symbol: string, period: Period): Promise<EdgarStatements | null> {
  const cik = await tickerToCik(symbol);
  if (cik == null) return null;
  const facts = await fetchCompanyFacts(cik);
  if (!facts) return null;
  return mapCompanyFactsToStatements(symbol, facts, period);
}

/** Back-compat thin wrapper. */
export const fetchQuarterlyStatements = (symbol: string): Promise<EdgarStatements | null> =>
  fetchStatements(symbol, "quarter");
