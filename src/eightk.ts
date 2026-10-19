/**
 * SEC Form 8-K (current report) client + parsers — the free, official source for a
 * company's material events. Unlike news, 8-Ks are structured: the item codes
 * (2.02 earnings, 5.02 leadership, 1.03 bankruptcy, …) come straight from the
 * submissions feed's `items` field, so NO document parsing is needed.
 *
 * Flow (all SEC, no key):
 *   files/company_tickers.json        → ticker → CIK (for the ingest universe)
 *   submissions/CIK{cik}.json         → form=8-K rows: accession, dates, items, doc
 *
 * Pure parsers (unit-tested) + thin client, no DB — mirrors thirteenf.ts. Honest
 * limit: item codes describe WHAT happened, not the detail (that's in the
 * unparsed doc).
 */
import { secGet } from "./http.js";
import { fetchSubmissions, type Submissions } from "./thirteenf.js";

export type { Submissions } from "./thirteenf.js";

// ───────────────────────── the current-filings feed (real time) ─────────────────────────
//
// EDGAR's "latest filings" Atom feed lists every 8-K minutes after it is accepted
// (filings are accepted 06:00–22:00 ET on business days), newest first, each with
// the filer's CIK, the index URL, the acceptance time and the item codes — the
// same facts the per-company submissions feed gives a day later, for every filer
// at once. One request per page of up to 100.

export interface Current8K {
  form: string; // "8-K" | "8-K/A"
  company: string;
  cik: string; // 10-digit
  accession: string;
  url: string; // the filing's index page
  acceptedAt: string; // ISO, with the feed's offset
  items: string[]; // ["2.02", "9.01"]
}

const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Pure: the Atom feed → its 8-K entries. Entries that do not parse are skipped. */
export function parseCurrent8K(atom: string): Current8K[] {
  const out: Current8K[] = [];
  for (const m of atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const title = /<title>([^<]*)<\/title>/.exec(e)?.[1];
    const head = title ? /^(\S+) - (.+) \((\d{10})\) \((?:Filer|Subject)\)$/.exec(unescape(title).trim()) : null;
    const url = /<link [^>]*href="([^"]+)"/.exec(e)?.[1];
    const accepted = /<updated>([^<]+)<\/updated>/.exec(e)?.[1];
    const accession = /accession-number=([\d-]+)/.exec(e)?.[1];
    if (!head || !url || !accepted || !accession) continue;
    const summary = unescape(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(e)?.[1] ?? "");
    const items = [...summary.matchAll(/Item (\d+\.\d+):/g)].map((x) => x[1]!);
    out.push({ form: head[1]!, company: head[2]!, cik: head[3]!, accession, url, acceptedAt: accepted.trim(), items });
  }
  return out;
}

/** One page of the current 8-K feed (newest first). */
export async function fetchCurrent8K(start = 0, count = 100): Promise<Current8K[]> {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=${start}&count=${count}&output=atom`;
  const atom = await secGet<string>(url, "application/atom+xml");
  return atom ? parseCurrent8K(atom) : [];
}

// ───────────────────────── submissions → 8-K filings ─────────────────────────

export interface EightKFiling {
  accessionNumber: string;
  filedDate: string; // YYYY-MM-DD
  reportDate: string | null; // event date (8-K cover); often present
  acceptedAt: string | null; // acceptanceDateTime — PIT (when it went public)
  items: string; // raw CSV
  primaryDocument: string;
}

/** Pure: pluck all 8-K (and 8-K/A) filings from a submissions payload, newest filed
 *  first. Skips rows with no filing date (would break known_at). */
export function find8KFilings(subs: Submissions): EightKFiling[] {
  const r = subs.filings?.recent;
  if (!r?.form || !r.accessionNumber) return [];
  const out: EightKFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (form !== "8-K" && form !== "8-K/A") continue;
    const accessionNumber = r.accessionNumber[i];
    const filedDate = r.filingDate?.[i] ?? "";
    if (!accessionNumber || !filedDate) continue;
    out.push({
      accessionNumber,
      filedDate,
      reportDate: r.reportDate?.[i] || null,
      acceptedAt: r.acceptanceDateTime?.[i] || null,
      items: r.items?.[i] ?? "",
      primaryDocument: r.primaryDocument?.[i] ?? "",
    });
  }
  return out.sort((a, b) => b.filedDate.localeCompare(a.filedDate));
}

// ───────────────────────── client ─────────────────────────

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Fetch SEC's official ticker → CIK directory (one ~1MB JSON, ~10k companies).
 *  Returns Map<TICKER, { cik (10-digit), name }>. */
export async function fetchCompanyTickers(): Promise<Map<string, { cik: string; name: string }>> {
  const raw = await secGet<Record<string, CompanyTickerEntry>>("https://www.sec.gov/files/company_tickers.json");
  const map = new Map<string, { cik: string; name: string }>();
  if (!raw) return map;
  for (const e of Object.values(raw)) {
    if (!e?.ticker || e.cik_str == null) continue;
    map.set(e.ticker.toUpperCase(), { cik: String(e.cik_str).padStart(10, "0"), name: e.title ?? "" });
  }
  return map;
}

/** Resolve one symbol's recent 8-K filings via its CIK. `cik` is numeric (un-padded). */
export async function fetch8KFilings(cik: number): Promise<EightKFiling[] | null> {
  const subs = await fetchSubmissions(cik);
  if (!subs) return null;
  return find8KFilings(subs);
}
