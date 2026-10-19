/**
 * SEC Form 13F-HR client + parsers — the free, official source for institutional
 * managers' (Berkshire, Scion, Pershing Square, …) quarterly U.S. equity
 * holdings. Managers with >$100M in 13F securities must file within 45 days of
 * quarter end; the holdings live in an XML "information table" inside the filing.
 *
 * Flow (all SEC, no key):
 *   submissions/CIK{cik}.json     → locate the latest 13F-HR accession + period
 *   Archives/.../{accn}/index.json → find the information-table .xml document
 *   Archives/.../{accn}/{doc}.xml  → parse infoTable rows → holdings
 *
 * Pure parsers (unit-tested) + thin client, no DB — mirrors edgar.ts / fmp.ts.
 * Persistence wiring lives in services/api/src/data/thirteenf/. Honest limits: 45-day
 * lag (last quarter's book, not live), U.S. long positions only (puts are listed;
 * no shorts/cash/foreign/debt), and holdings carry only a CUSIP — the
 * CUSIP→ticker map is resolved separately (self-maintained table).
 */
import { secGet } from "./http.js";
import type { Holding13F } from "./holdings.js";

const SEC_DATA_BASE = "https://data.sec.gov";
const SEC_WWW_BASE = "https://www.sec.gov";

/** 10-digit zero-padded CIK as the submissions path expects. */
export const padCik = (cik: number): string => String(cik).padStart(10, "0");

/** Accession number with dashes stripped, as the Archives directory path uses. */
export const accnNoDashes = (accn: string): string => accn.replace(/-/g, "");

// ───────────────────────── submissions → latest 13F filings ─────────────────────────

interface SubmissionsRecent {
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  form?: string[];
  items?: string[]; // 8-K item codes, e.g. "2.02,9.01"
  primaryDocument?: string[];
}
export interface Submissions {
  cik?: number;
  name?: string;
  /** The entity's listed tickers (subject companies use this for CIK→ticker). */
  tickers?: string[];
  /** `recent` holds the newest ~1,000 filings; older ones are in `files`, one JSON
   *  page each with the same columns as `recent` (`CIK…-submissions-001.json`). */
  filings?: { recent?: SubmissionsRecent; files?: SubmissionsPage[] };
}

export interface SubmissionsPage {
  name: string;
  filingFrom?: string;
  filingTo?: string;
}

export interface Filing13F {
  accessionNumber: string;
  /** Period of report = the calendar quarter end the holdings are as of (PIT identity). */
  reportDate: string;
  /** Filing date → known_at (PIT) and the thousands-vs-dollars value cutoff. */
  filingDate: string;
  form: string; // "13F-HR" | "13F-HR/A"
}

/**
 * Pure: pluck all 13F-HR (and amendment 13F-HR/A) filings from a submissions
 * payload, newest report-period first. Amendments are kept — they restate a
 * quarter and the caller (filing newest-filed for a given reportDate) supersedes
 * the original. Only the `recent` page is read (covers ~1000 filings ≫ years of
 * quarterly 13Fs).
 */
export function find13FFilings(subs: Submissions): Filing13F[] {
  return find13FInPage(subs.filings?.recent);
}

/** Pure: the 13F-HR / 13F-HR/A filings in one page of submissions columns (the
 *  `recent` block or one of the older `files` pages), newest period first. */
export function find13FInPage(r: SubmissionsRecent | null | undefined): Filing13F[] {
  if (!r?.form || !r.accessionNumber) return [];
  const out: Filing13F[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (form !== "13F-HR" && form !== "13F-HR/A") continue;
    const accessionNumber = r.accessionNumber[i];
    const reportDate = r.reportDate?.[i] ?? "";
    const filingDate = r.filingDate?.[i] ?? "";
    // filingDate is required: it becomes known_at (NOT NULL) and the value cutoff;
    // an empty one would make `new Date("T00:00:00Z")` Invalid → DB write failure.
    if (!accessionNumber || !reportDate || !filingDate) continue;
    out.push({ accessionNumber, reportDate, filingDate, form });
  }
  // Newest report period first; for the same period, newest-filed first
  // (an amendment supersedes the original it restates).
  return out.sort((a, b) =>
    a.reportDate === b.reportDate ? b.filingDate.localeCompare(a.filingDate) : b.reportDate.localeCompare(a.reportDate),
  );
}

/**
 * Pure: among 13F filings, keep the authoritative one per report period (the
 * newest-filed, so an amendment wins), newest period first.
 */
export function latestPerPeriod(filings: Filing13F[]): Filing13F[] {
  const byPeriod = new Map<string, Filing13F>();
  for (const f of filings) {
    const prev = byPeriod.get(f.reportDate);
    if (!prev || f.filingDate > prev.filingDate) byPeriod.set(f.reportDate, f);
  }
  return [...byPeriod.values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
}

// ───────────────────────── filing index → information-table doc ─────────────────────────

interface FilingIndex {
  directory?: { item?: { name: string; type?: string }[] };
}

/**
 * Pure: find the information-table XML document name in a filing's index.json.
 * Prefer a name that looks like an info table; otherwise fall back to the only
 * (or any) `.xml` that isn't the primary 13F cover document. The cover/primary
 * doc is itself XML, so we exclude obvious headers and prefer the table name.
 */
export function pickInfoTableDoc(index: FilingIndex): string | null {
  const items = index.directory?.item ?? [];
  const xmls = items.map((i) => i?.name).filter((n): n is string => typeof n === "string" && /\.xml$/i.test(n));
  if (xmls.length === 0) return null;
  const named = xmls.find((n) => /info.?table|infotable|form13fInfoTable/i.test(n));
  if (named) return named;
  // Exclude the primary cover (often "primary_doc.xml" or "*_doc.xml" / header).
  const nonCover = xmls.filter((n) => !/primary.?doc|primarydoc|header|^xslForm/i.test(n));
  return nonCover[0] ?? xmls[0] ?? null;
}

// ───────────────────────── information table XML → entries ─────────────────────────

import { XMLParser } from "fast-xml-parser";

// removeNSPrefix strips the ns1:/n1: prefixes filers sprinkle on; parseTagValue
// off keeps CUSIPs as strings (leading zeros / letters must survive — Number()
// would corrupt "037833100"). We coerce value/shares numerically ourselves.
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

export interface InfoTableEntry {
  nameOfIssuer: string;
  titleOfClass: string;
  cusip: string;
  /** Raw `value` as filed — thousands of $ before 2023-01-03, whole $ after. */
  value: number;
  shares: number;
  /** "SH" (shares) | "PRN" (principal). */
  sshPrnamtType: string;
  /** "Put" | "Call" | "" for a plain long share position. */
  putCall: string;
}

const asArray = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const str = (x: unknown): string => (x == null ? "" : String(x).trim());
const num = (x: unknown): number => {
  const n = Number(str(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pure: parse a 13F information-table XML into raw entries (one per filed row,
 * not yet aggregated or value-normalized). Tolerates namespace prefixes and a
 * single-row table (fast-xml-parser yields an object, not an array, for one row).
 */
export function parseInfoTable(xml: string): InfoTableEntry[] {
  const doc = parser.parse(xml) as Record<string, unknown> | null;
  const table = (doc?.informationTable ?? doc?.infoTable ?? doc) as Record<string, unknown> | null;
  const rows = asArray((table?.infoTable ?? table) as unknown) as Record<string, unknown>[];
  const out: InfoTableEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue; // tolerate null/empty parsed tags
    const cusip = str(row.cusip);
    if (!cusip) continue; // not an info-table row
    // A filer with nothing to report still has to file a table, and does it with
    // one placeholder row of zeros (Olstein, Q2 2026: CUSIP 000000000, value 0).
    if (/^0+$/.test(cusip)) continue;
    const amt = (row.shrsOrPrnAmt ?? {}) as Record<string, unknown>;
    out.push({
      nameOfIssuer: str(row.nameOfIssuer),
      titleOfClass: str(row.titleOfClass),
      cusip: cusip.toUpperCase(),
      value: num(row.value),
      shares: num(amt.sshPrnamt),
      sshPrnamtType: str(amt.sshPrnamtType) || "SH",
      putCall: str(row.putCall),
    });
  }
  return out;
}

// ───────────────────────── value normalization + aggregation ─────────────────────────

/**
 * SEC amended Form 13F so that for filings made on or after 2023-01-03 the
 * `value` column is reported in **whole dollars**; earlier filings reported it in
 * **thousands**. Normalize to whole dollars by filing date (a 1000× error if
 * skipped).
 */
const DOLLARS_CUTOFF = "2023-01-03";
export function normalizeValue(rawValue: number, filingDate: string): number {
  return filingDate && filingDate < DOLLARS_CUTOFF ? rawValue * 1000 : rawValue;
}

/** The implied price a real portfolio's median position can have, in dollars. */
const PLAUSIBLE_PRICE = { min: 1, max: 5000 } as const;

/**
 * Pure: the multiplier that turns this filing's `value` column into whole dollars.
 *
 * The rule says thousands before 2023-01-03 and dollars after, and some filers
 * never got the memo: Baupost, AKO and Triple Frond still file in thousands in
 * 2026, which put Baupost's $5.4B book on the site as $5.4M. So the filing date
 * only breaks a tie. What decides is the median implied price (value ÷ shares)
 * of the plain share rows: whichever unit puts it between $1 and $5,000 is the
 * unit the filer used. When both or neither do (a median price of $1–$5, or a
 * table with no share rows), the date rule stands.
 */
export function valueScale(entries: readonly InfoTableEntry[], filingDate: string): 1 | 1000 {
  const byDate: 1 | 1000 = filingDate && filingDate < DOLLARS_CUTOFF ? 1000 : 1;
  const ratios = entries
    .filter((e) => !e.putCall && e.sshPrnamtType !== "PRN" && e.shares > 0 && e.value > 0)
    .map((e) => e.value / e.shares)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return byDate;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  const plausible = (scale: number): boolean => median * scale >= PLAUSIBLE_PRICE.min && median * scale <= PLAUSIBLE_PRICE.max;
  if (plausible(1) && !plausible(1000)) return 1;
  if (plausible(1000) && !plausible(1)) return 1000;
  return byDate;
}

/**
 * Pure: collapse raw info-table entries into one holding per (cusip, putCall),
 * summing value and shares and converting value to whole dollars (`valueScale`). Same-CUSIP rows (multiple lots / discretion buckets) merge; a put and a
 * share line on the same issuer stay distinct (different putCall key).
 */
export function aggregateHoldings(entries: InfoTableEntry[], filingDate: string): Holding13F[] {
  const byKey = new Map<string, Holding13F>();
  const scale = valueScale(entries, filingDate);
  for (const e of entries) {
    const key = `${e.cusip}|${e.putCall}`;
    const value = e.value * scale;
    const prev = byKey.get(key);
    if (prev) {
      prev.value += value;
      prev.shares += e.shares;
    } else {
      byKey.set(key, {
        cusip: e.cusip,
        issuerName: e.nameOfIssuer,
        titleOfClass: e.titleOfClass,
        value,
        shares: e.shares,
        putCall: e.putCall,
      });
    }
  }
  // Largest position first — the natural display order.
  return [...byKey.values()].sort((a, b) => b.value - a.value);
}

// ───────────────────────── client ─────────────────────────

export async function fetchSubmissions(cik: number): Promise<Submissions | null> {
  return secGet<Submissions>(`${SEC_DATA_BASE}/submissions/CIK${padCik(cik)}.json`);
}

async function fetchFilingIndex(cik: number, accn: string): Promise<FilingIndex | null> {
  return secGet<FilingIndex>(`${SEC_WWW_BASE}/Archives/edgar/data/${cik}/${accnNoDashes(accn)}/index.json`);
}

async function fetchInfoTableXml(cik: number, accn: string, doc: string): Promise<string | null> {
  return secGet<string>(`${SEC_WWW_BASE}/Archives/edgar/data/${cik}/${accnNoDashes(accn)}/${doc}`, "application/xml");
}

// ───────────────────────── amendments → one book per period ─────────────────────────

/**
 * A 13F-HR/A says on its cover what it is. A RESTATEMENT is the whole book again
 * and replaces what came before; NEW HOLDINGS lists only positions the original
 * left out (typically ones held back under confidential treatment and disclosed
 * later — Berkshire's Q1 2025 amendment added four) and must be ADDED to it.
 * Taking the newest filing of a period as the book, as this module used to, turns
 * a NEW HOLDINGS amendment into a four-stock portfolio. 536 of the roster's 6,419
 * 13F filings are amendments.
 */
export type AmendmentType = "RESTATEMENT" | "NEW HOLDINGS";

/** Pure: the amendment type on a 13F cover page (`primary_doc.xml`), or null. */
export function parseAmendmentType(xml: string): AmendmentType | null {
  const doc = parser.parse(xml) as Record<string, unknown> | null;
  const cover = (((doc?.edgarSubmission as Record<string, unknown> | undefined)?.formData as Record<string, unknown> | undefined)?.coverPage ?? {}) as Record<string, unknown>;
  const type = str((cover.amendmentInfo as Record<string, unknown> | undefined)?.amendmentType).toUpperCase();
  return type === "RESTATEMENT" || type === "NEW HOLDINGS" ? type : null;
}

/** Pure: the cover page's document name in a filing index. */
export function pickCoverDoc(index: FilingIndex): string | null {
  const names = (index.directory?.item ?? []).map((i) => i?.name).filter((n): n is string => typeof n === "string");
  return names.find((n) => /^primary_doc\.xml$/i.test(n)) ?? null;
}

/** One filing of a period, as loaded: its table (null when it has none or it
 *  could not be read) and, for an amendment, what kind it is. */
export interface LoadedFiling {
  filing: Filing13F;
  amendmentType: AmendmentType | null;
  holdings: Holding13F[] | null;
}

const filedAfter = (a: Filing13F, b: Filing13F): boolean =>
  a.filingDate === b.filingDate ? a.accessionNumber > b.accessionNumber : a.filingDate > b.filingDate;

/** A holding plus the filing it came from — its PIT stamp. */
export interface PeriodHolding extends Holding13F {
  accessionNumber: string;
  filingDate: string;
}

export interface PeriodBook {
  /** The filing the book is built on (an original or a RESTATEMENT). */
  base: Filing13F;
  /** NEW HOLDINGS amendments added to it, oldest first. */
  added: Filing13F[];
  /** Amendments left out: an unknown type, or filed before the base they would add to. */
  ignored: Filing13F[];
  holdings: PeriodHolding[];
}

/** Share of the original's positions a NEW HOLDINGS amendment may repeat before
 *  it counts as the whole book under the wrong label. Every mislabelled refiling
 *  in the roster census repeats 98–100% and every genuine one 0%, so any cut in
 *  between separates them today; 0.9 is chosen for what a wrong call costs. Read
 *  as a RESTATEMENT, the amendment replaces the original, and the original's
 *  positions it does not repeat drop out: at 0.9 that is at most a tenth of the
 *  book, at 0.5 it was half (a two-position filer whose late disclosure repeats
 *  one of them would lose the other). */
const RESTATED_SHARE = 0.9;

/**
 * Pure: whether a NEW HOLDINGS amendment is in fact the whole book again. Some
 * filers label a full refiling NEW HOLDINGS: First Eagle's Q2 2026 13F-HR/A
 * (0001325447-26-000033) repeats all 424 of the original's positions at the
 * same share counts and adds one, Exxon. Added on top of the original, it
 * doubled every position and put a $60B book on the site as $121B. A genuine
 * NEW HOLDINGS amendment lists what the original left out, so it repeats few or
 * none of the original's positions; one that repeats nearly all of them
 * (RESTATED_SHARE), share for share, is taken as the RESTATEMENT it is.
 */
export function restatesBook(amendment: readonly Holding13F[], original: readonly Holding13F[]): boolean {
  if (original.length === 0) return false;
  const shares = new Map(amendment.map((h) => [`${h.cusip}|${h.putCall}`, h.shares]));
  const repeated = original.filter((h) => shares.get(`${h.cusip}|${h.putCall}`) === h.shares).length;
  return repeated / original.length >= RESTATED_SHARE;
}

/**
 * Pure: one period's filings → the book as of the latest filing.
 *
 * A NEW HOLDINGS amendment that repeats the original's book (`restatesBook`) is
 * read as a RESTATEMENT first. The base is the newest-filed original or
 * RESTATEMENT that has a readable
 * table (an older one is used if the newest cannot be read). Every NEW HOLDINGS
 * amendment filed after the base is added on top — a position it shares with the
 * base is summed, as two lots of one position. Each holding keeps the filing it
 * came from, so a position disclosed late is known from its amendment's date,
 * not the original's. Null when no base can be read (a period of amendments
 * only, or tables that all failed).
 */
export function buildPeriodBook(filings: readonly LoadedFiling[]): PeriodBook | null {
  const original = filings
    .filter((l) => l.filing.form === "13F-HR" && l.holdings !== null)
    .sort((a, b) => (filedAfter(a.filing, b.filing) ? -1 : 1))[0];
  const loaded = filings.map((l): LoadedFiling =>
    l.amendmentType === "NEW HOLDINGS" && l.holdings && original && restatesBook(l.holdings, original.holdings!) ? { ...l, amendmentType: "RESTATEMENT" } : l,
  );
  const bases = loaded
    .filter((l) => l.filing.form === "13F-HR" || l.amendmentType === "RESTATEMENT")
    .sort((a, b) => (filedAfter(a.filing, b.filing) ? -1 : 1));
  const base = bases.find((l) => l.holdings !== null);
  if (!base) return null;
  const amendments = loaded.filter((l) => l.filing.form === "13F-HR/A" && l.amendmentType !== "RESTATEMENT");
  const added = amendments
    .filter((l) => l.amendmentType === "NEW HOLDINGS" && l.holdings !== null && filedAfter(l.filing, base.filing))
    .sort((a, b) => (filedAfter(a.filing, b.filing) ? 1 : -1));
  const ignored = amendments.filter((l) => !added.includes(l)).map((l) => l.filing);

  const byKey = new Map<string, PeriodHolding>();
  for (const part of [base, ...added]) {
    for (const h of part.holdings!) {
      const key = `${h.cusip}|${h.putCall}`;
      const prev = byKey.get(key);
      if (prev) {
        prev.value += h.value;
        prev.shares += h.shares;
      } else {
        byKey.set(key, { ...h, accessionNumber: part.filing.accessionNumber, filingDate: part.filing.filingDate });
      }
    }
  }
  return {
    base: base.filing,
    added: added.map((l) => l.filing),
    ignored,
    holdings: [...byKey.values()].sort((a, b) => b.value - a.value),
  };
}

/** Pure: a filer's 13F filings grouped by report period, newest period first. */
export function groupByPeriod(filings: readonly Filing13F[]): { reportDate: string; filings: Filing13F[] }[] {
  const byPeriod = new Map<string, Filing13F[]>();
  const seen = new Set<string>();
  for (const f of filings) {
    if (seen.has(f.accessionNumber)) continue; // the same filing on two pages
    seen.add(f.accessionNumber);
    const list = byPeriod.get(f.reportDate);
    if (list) list.push(f);
    else byPeriod.set(f.reportDate, [f]);
  }
  return [...byPeriod.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([reportDate, list]) => ({ reportDate, filings: list }));
}

// ───────────────────────── client: periods and history ─────────────────────────

export interface Quarter13F {
  reportDate: string;
  /** The base filing's date and accession (the book is "as filed" then). */
  filingDate: string;
  accessionNumber: string;
  holdings: PeriodHolding[];
  /** NEW HOLDINGS amendments folded in, and amendments left out. */
  added: string[];
  ignored: string[];
}

/** Load one filing: its table and, for an amendment, its cover's type. */
async function loadFiling(cik: number, filing: Filing13F): Promise<LoadedFiling> {
  const index = await fetchFilingIndex(cik, filing.accessionNumber);
  if (!index) return { filing, amendmentType: null, holdings: null };
  let amendmentType: AmendmentType | null = null;
  if (filing.form === "13F-HR/A") {
    const cover = pickCoverDoc(index);
    const xml = cover ? await secGet<string>(`${SEC_WWW_BASE}/Archives/edgar/data/${cik}/${accnNoDashes(filing.accessionNumber)}/${cover}`, "application/xml") : null;
    amendmentType = xml ? parseAmendmentType(xml) : null;
  }
  const doc = pickInfoTableDoc(index);
  const xml = doc ? await fetchInfoTableXml(cik, filing.accessionNumber, doc) : null;
  return { filing, amendmentType, holdings: xml ? aggregateHoldings(parseInfoTable(xml), filing.filingDate) : null };
}

/** One period's book from all of its filings (see `buildPeriodBook`). */
export async function fetch13FPeriod(cik: number, filings: readonly Filing13F[]): Promise<Quarter13F | null> {
  const loaded: LoadedFiling[] = [];
  for (const f of filings) loaded.push(await loadFiling(cik, f));
  const book = buildPeriodBook(loaded);
  if (!book) return null;
  return {
    reportDate: book.base.reportDate,
    filingDate: book.base.filingDate,
    accessionNumber: book.base.accessionNumber,
    holdings: book.holdings,
    added: book.added.map((f) => f.accessionNumber),
    ignored: book.ignored.map((f) => f.accessionNumber),
  };
}

/**
 * Every 13F filing a CIK has made, from `recent` and every older page. Pages
 * whose filings all predate `since` are not fetched. Null when the CIK is
 * unknown to EDGAR.
 */
export async function fetchAll13FFilings(cik: number, since?: string): Promise<Filing13F[] | null> {
  const subs = await fetchSubmissions(cik);
  if (!subs) return null;
  const out = find13FFilings(subs);
  for (const page of subs.filings?.files ?? []) {
    if (since && page.filingTo && page.filingTo < since) continue;
    const cols = await secGet<SubmissionsRecent>(`${SEC_DATA_BASE}/submissions/${page.name}`);
    out.push(...find13FInPage(cols));
  }
  return out;
}

/**
 * Resolve CIK → the most recent `quarters` periods, each built from all of its
 * filings (original + amendments). Newest period first. Null when the CIK isn't
 * a 13F filer / has no filings; a period that cannot be built is skipped.
 */
export async function fetchLatest13F(cik: number, quarters = 2): Promise<Quarter13F[] | null> {
  const subs = await fetchSubmissions(cik);
  if (!subs) return null;
  const periods = groupByPeriod(find13FFilings(subs)).slice(0, quarters);
  if (periods.length === 0) return null;
  const out: Quarter13F[] = [];
  for (const p of periods) {
    const q = await fetch13FPeriod(cik, p.filings);
    if (q) out.push(q);
  }
  return out;
}
