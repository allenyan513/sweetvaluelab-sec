/**
 * A company's own SEC filings beyond the 8-K (#579): annual and quarterly
 * reports, proxies, registration statements and prospectuses — whichever forms
 * the caller's allowlist accepts (this repo's lives in the shared
 * filings registry, which web also reads). They come from the same submissions payload
 * the 8-K sync already fetches, so listing them costs no extra request. 8-Ks
 * keep their own table and parser (`./eightk.ts`): their item codes are data.
 *
 * Also here: the exhibit list of one filing, which is how an earnings 8-K's
 * press release (EX-99.1) is found — the submissions feed names only the
 * primary document, and the 8-K form itself is a cover page.
 *
 * Pure parsers (unit-tested) + thin client, no DB.
 */
import { secGet } from "./http.js";
import type { Submissions } from "./thirteenf.js";

export interface CompanyFiling {
  accessionNumber: string;
  form: string; // as filed, "10-K" | "10-K/A" | "DEF 14A" | …
  filedDate: string; // YYYY-MM-DD
  reportDate: string | null; // period of report (10-K / 10-Q), meeting date (proxy); often absent
  acceptedAt: string | null; // acceptanceDateTime — PIT
  primaryDocument: string;
}

/** Pure: the non-8-K filings in a submissions payload that `listed` accepts and
 *  that were filed on or after `since` (YYYY-MM-DD), newest first. Rows without
 *  a filing date are skipped. Which forms count is the caller's call (an app's
 *  own allowlist), so the package carries no opinion on it. */
export function findCompanyFilings(subs: Submissions, since: string, listed: (form: string) => boolean): CompanyFiling[] {
  const r = subs.filings?.recent;
  if (!r?.form || !r.accessionNumber) return [];
  const out: CompanyFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if (!listed(form) || form.startsWith("8-K")) continue; // 8-Ks: ./eightk.ts
    const accessionNumber = r.accessionNumber[i];
    const filedDate = r.filingDate?.[i] ?? "";
    if (!accessionNumber || !filedDate || filedDate < since) continue;
    out.push({
      accessionNumber,
      form,
      filedDate,
      reportDate: r.reportDate?.[i] || null,
      acceptedAt: r.acceptanceDateTime?.[i] || null,
      primaryDocument: r.primaryDocument?.[i] ?? "",
    });
  }
  return out.sort((a, b) => b.filedDate.localeCompare(a.filedDate));
}

export interface Exhibit {
  type: string; // "8-K" | "EX-99.1" | "EX-101.SCH" | …
  filename: string;
}

/**
 * Pure: the documents of a filing from its `-index-headers.html` page, which
 * carries the submission's SGML headers HTML-escaped: each document is a
 * `<TYPE>` line, then `<SEQUENCE>`, then its `<FILENAME>` — matched without
 * crossing into the next document's `<TYPE>`. (`index.json` lists the files
 * but not their types.)
 */
export function parseExhibits(html: string): Exhibit[] {
  const text = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const out: Exhibit[] = [];
  for (const m of text.matchAll(/<TYPE>([^\s<]+)(?:(?!<TYPE>)[\s\S])*?<FILENAME>([^\s<]+)/g)) out.push({ type: m[1]!, filename: m[2]! });
  return out;
}

/** Pure: an earnings 8-K's press release — EX-99.1, else its first EX-99.x
 *  (some issuers number the release 99 or 99.01). Null when there is none. */
export function releaseDocument(exhibits: readonly Exhibit[]): string | null {
  const ex99 = exhibits.filter((e) => /^EX-99(\.\d+)?$/.test(e.type));
  return (ex99.find((e) => e.type === "EX-99.1") ?? ex99[0])?.filename ?? null;
}

/** One filing's documents; null when EDGAR has no such filing. */
export async function fetchExhibits(cik: string | number, accessionNumber: string): Promise<Exhibit[] | null> {
  const dir = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replace(/-/g, "")}`;
  const html = await secGet<string>(`${dir}/${accessionNumber}-index-headers.html`, "text/html");
  return html == null ? null : parseExhibits(html);
}
