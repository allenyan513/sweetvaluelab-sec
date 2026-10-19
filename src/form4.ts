/**
 * SEC Form 4 (statement of changes in beneficial ownership) client + parsers — the
 * free, official, RICHER source for insider trades. Direct-from-SEC replacement for
 * FMP's flattened insider data: Form 4 carries the transaction CODE (P open-market
 * buy, S sell, M option/RSU exercise, A grant, F tax-withhold, G gift, …), the A/D
 * direction, the 10b5-1 plan flag, and derivative vs non-derivative — all of which
 * FMP drops (it keeps only P/S). The issuer's own submissions feed lists its insiders'
 * Form 4s, and the ticker is right in the XML (`issuerTradingSymbol`).
 *
 * Pure parsers (unit-tested) + thin client, no DB — mirrors thirteenf.ts / edgar-8k.ts.
 * Persistence in services/api/src/data/form4/. PIT: known_at = acceptance datetime.
 */
import { XMLParser } from "fast-xml-parser";
import { secGet } from "./http.js";
import { fetchSubmissions, accnNoDashes, type Submissions } from "./thirteenf.js";

export type { Submissions } from "./thirteenf.js";

const SEC_WWW_BASE = "https://www.sec.gov";

// Same config as the 13F info-table parser: tolerate ns prefixes, keep values as
// strings (don't let Number() corrupt CIKs / share counts), ignore attributes.
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

const asArray = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const str = (x: unknown): string | null => {
  if (x == null) return null;
  const s = String(x).trim();
  return s === "" ? null : s;
};
/** Most Form 4 leaves wrap their content in `<value>`; footnote-only leaves have no
 *  value (e.g. price referenced in a footnote) → null. */
const val = (node: unknown): string | null => {
  if (node == null) return null;
  if (typeof node === "object") {
    const v = (node as Record<string, unknown>).value;
    return v == null ? null : str(v);
  }
  return str(node);
};
const numVal = (node: unknown): number | null => {
  const s = val(node);
  if (s == null) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const boolTag = (x: unknown): boolean => {
  const s = (val(x) ?? "").toLowerCase();
  return s === "true" || s === "1";
};
// Normalize a filer-supplied date to a bare YYYY-MM-DD (the `date` column rejects
// anything else). Some filers append a TZ offset or time ("2025-11-04-05:00",
// "2025-11-04T00:00:00"); take the leading date, drop the rest. Non-date → null.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}/;
const dateOnly = (s: string | null): string | null => (s == null ? null : (s.match(DATE_ONLY_RE)?.[0] ?? null));

// ───────────────────────── submissions → Form 4 filings ─────────────────────────

export interface Form4Filing {
  accessionNumber: string;
  filedDate: string;
  acceptedAt: string | null;
  primaryDocument: string;
}

/** Pure: pluck form 4 / 4/A filings from an issuer's submissions, newest filed first. */
export function find4Filings(subs: Submissions): Form4Filing[] {
  const r = subs.filings?.recent;
  if (!r?.form || !r.accessionNumber) return [];
  const out: Form4Filing[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (form !== "4" && form !== "4/A") continue;
    const accessionNumber = r.accessionNumber[i];
    const filedDate = r.filingDate?.[i] ?? "";
    if (!accessionNumber || !filedDate) continue;
    out.push({ accessionNumber, filedDate, acceptedAt: r.acceptanceDateTime?.[i] || null, primaryDocument: r.primaryDocument?.[i] ?? "" });
  }
  return out.sort((a, b) => b.filedDate.localeCompare(a.filedDate));
}

// ───────────────────────── Form 4 XML → owners + transactions ─────────────────────────

export interface Form4Owner {
  name: string;
  cik: string | null;
  relationship: string | null; // "Director, Officer" etc.
  officerTitle: string | null;
}
export interface Form4Txn {
  code: string;
  acquiredDisposed: string | null; // "A" | "D"
  shares: number | null;
  price: number | null; // null for grants/gifts/footnoted prices
  securityTitle: string | null;
  isDerivative: boolean;
  sharesOwnedAfter: number | null;
  directIndirect: string | null; // "D" | "I"
  transactionDate: string | null;
}
export interface ParsedForm4 {
  symbol: string | null;
  issuerCik: string | null;
  owners: Form4Owner[];
  is10b5_1: boolean;
  transactions: Form4Txn[];
}

function parseOwner(o: Record<string, unknown>): Form4Owner {
  const id = (o.reportingOwnerId ?? {}) as Record<string, unknown>;
  const rel = (o.reportingOwnerRelationship ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (boolTag(rel.isDirector)) parts.push("Director");
  if (boolTag(rel.isOfficer)) parts.push("Officer");
  if (boolTag(rel.isTenPercentOwner)) parts.push("10% Owner");
  if (boolTag(rel.isOther)) parts.push("Other");
  return { name: str(val(id.rptOwnerName) ?? id.rptOwnerName) ?? "", cik: str(id.rptOwnerCik), relationship: parts.join(", ") || null, officerTitle: str(rel.officerTitle) };
}

function parseTxn(t: Record<string, unknown>, isDerivative: boolean): Form4Txn | null {
  const coding = (t.transactionCoding ?? {}) as Record<string, unknown>;
  const code = str(coding.transactionCode);
  if (!code) return null; // a holding row (no transaction) — skip
  const amt = (t.transactionAmounts ?? {}) as Record<string, unknown>;
  const post = (t.postTransactionAmounts ?? {}) as Record<string, unknown>;
  const nature = (t.ownershipNature ?? {}) as Record<string, unknown>;
  return {
    code,
    acquiredDisposed: val(amt.transactionAcquiredDisposedCode),
    shares: numVal(amt.transactionShares),
    price: numVal(amt.transactionPricePerShare),
    securityTitle: val(t.securityTitle),
    isDerivative,
    sharesOwnedAfter: numVal(post.sharesOwnedFollowingTransaction),
    directIndirect: val(nature.directOrIndirectOwnership),
    transactionDate: dateOnly(val(t.transactionDate)),
  };
}

/** Pure: parse a Form 4 `ownershipDocument` XML into owners + transactions. Tolerates
 *  single-vs-array, multi-owner group filings, and footnote-only prices. */
export function parseForm4(xml: string): ParsedForm4 | null {
  const root = (parser.parse(xml) as { ownershipDocument?: Record<string, unknown> } | null)?.ownershipDocument;
  if (!root) return null;
  const issuer = (root.issuer ?? {}) as Record<string, unknown>;
  const nonDeriv = (root.nonDerivativeTable ?? {}) as Record<string, unknown>;
  const deriv = (root.derivativeTable ?? {}) as Record<string, unknown>;
  const transactions = [
    ...asArray(nonDeriv.nonDerivativeTransaction as unknown).map((t) => parseTxn(t as Record<string, unknown>, false)),
    ...asArray(deriv.derivativeTransaction as unknown).map((t) => parseTxn(t as Record<string, unknown>, true)),
  ].filter((t): t is Form4Txn => t != null);
  return {
    symbol: str(val(issuer.issuerTradingSymbol) ?? issuer.issuerTradingSymbol)?.toUpperCase() ?? null,
    issuerCik: str(issuer.issuerCik),
    owners: asArray(root.reportingOwner as unknown).map((o) => parseOwner(o as Record<string, unknown>)),
    is10b5_1: boolTag(root.aff10b5One),
    transactions,
  };
}

// ───────────────────────── thin client ─────────────────────────

/** Resolve the raw Form 4 XML document name from the submissions `primaryDocument`.
 *  Filers name the doc arbitrarily ("wk-form4_178…xml", "doc4.xml", …), and the
 *  submissions feed points at the XSL-styled view ("xslF345X06/wk-form4_…xml") which
 *  renders to HTML, not the parseable `ownershipDocument` XML. Strip the `xslF345Xnn/`
 *  prefix to get the raw XML; fall back to the legacy "form4.xml" when absent. */
export function form4DocName(primaryDocument: string | null | undefined): string {
  const pd = (primaryDocument ?? "").trim();
  if (!pd) return "form4.xml";
  return pd.replace(/^xslF345X\d+\//, "");
}

/** Fetch a Form 4 filing's raw ownership XML. `cik` is numeric (un-padded);
 *  `primaryDocument` comes from the submissions feed (see {@link form4DocName}). */
export async function fetch4Xml(cik: number, accn: string, primaryDocument?: string): Promise<string | null> {
  const doc = form4DocName(primaryDocument);
  return secGet<string>(`${SEC_WWW_BASE}/Archives/edgar/data/${cik}/${accnNoDashes(accn)}/${doc}`, "application/xml");
}

export { fetchSubmissions };
