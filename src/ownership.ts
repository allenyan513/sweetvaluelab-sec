/**
 * SEC Schedule 13D / 13G client + parsers — the free, official source for
 * beneficial-ownership (>5%) disclosures. 13D = activist (intent to influence,
 * ~10-day deadline after crossing 5%); 13G = passive institution (quarterly/
 * annual). The symbol-centric companion to 13F (`thirteenf.ts`): for a stock,
 * who has filed a >5% stake on it.
 *
 * Flow (all SEC, no key):
 *   submissions/CIK{filerCik}.json   → the filer's 13D/13G filings (+ primaryDocument)
 *   Archives/.../{accn}.hdr.sgml      → SUBJECT-COMPANY block → subject CIK + name
 *   submissions/CIK{subjectCik}.json  → subject `tickers[0]` (makes it symbol-queryable)
 *   Archives/.../{primaryDoc}         → cover page → cusip / % / shares (BEST-EFFORT)
 *
 * Pure parsers (unit-tested) + thin client, no DB — mirrors thirteenf.ts.
 * Persistence wiring lives in services/api/src/data/sec/ownership.ts. Honest
 * limits: roster-bound coverage (only tracked filers). The cover page comes in
 * two formats: a pre-2025 `SC 13D` is unstructured HTML, so cusip/%/shares are
 * best-effort and often null — never block on them; a `SCHEDULE 13D` (structured
 * rules, 2024-12-18 on) is XML with those fields tagged.
 */
import { XMLParser } from "fast-xml-parser";
import { secGet } from "./http.js";
import { fetchSubmissions, padCik, accnNoDashes, type Submissions } from "./thirteenf.js";

export type { Submissions } from "./thirteenf.js";

const SEC_WWW_BASE = "https://www.sec.gov";

/**
 * The ownership forms we ingest, under both of EDGAR's names. The structured
 * 13D/G rules (effective 2024-12-18) renamed the form types from `SC 13D` /
 * `SC 13G` to `SCHEDULE 13D` / `SCHEDULE 13G` (Icahn, CIK 921669, files only
 * `SCHEDULE 13D/A` from 2025 on); a filer's submissions list both names across
 * its history. Kept in one place — a new variant only edits here.
 */
export const OWNERSHIP_FORMS = [
  "SC 13D",
  "SC 13G",
  "SC 13D/A",
  "SC 13G/A",
  "SCHEDULE 13D",
  "SCHEDULE 13G",
  "SCHEDULE 13D/A",
  "SCHEDULE 13G/A",
] as const;
const OWNERSHIP_FORM_SET = new Set<string>(OWNERSHIP_FORMS);

// ───────────────────────── submissions → ownership filings ─────────────────────────

export interface OwnershipFiling {
  accessionNumber: string;
  form: string; // one of OWNERSHIP_FORMS, as filed ("SC 13D/A", "SCHEDULE 13D/A", …)
  schedule: "13D" | "13G"; // derived
  isAmendment: boolean; // derived (…/A)
  /** Filing date (YYYY-MM-DD) → known_at (PIT). 13D/13G have no period-of-report. */
  filedDate: string;
  /** Cover document name (from submissions) — fetched best-effort for cusip/%/shares. */
  primaryDocument: string;
}

/** Pure: derive schedule + amendment flag from a form string. */
export function classifyForm(form: string): { schedule: "13D" | "13G"; isAmendment: boolean } {
  return { schedule: /13D/i.test(form) ? "13D" : "13G", isAmendment: /\/A$/i.test(form) };
}

/**
 * Pure: pluck all 13D/13G (and /A amendments) filings, under either form name,
 * from a filer's submissions payload, newest-filed first. Each amendment is its own filing
 * (own accession); the read layer supersedes by latest filed. `reportDate` is
 * empty for these forms, so we key on `filedDate` only.
 */
export function findOwnershipFilings(subs: Submissions): OwnershipFiling[] {
  const r = subs.filings?.recent;
  if (!r?.form || !r.accessionNumber) return [];
  const out: OwnershipFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (!form || !OWNERSHIP_FORM_SET.has(form)) continue;
    const accessionNumber = r.accessionNumber[i];
    const filedDate = r.filingDate?.[i] ?? "";
    // filedDate is required: it becomes known_at (NOT NULL); empty → Invalid Date → write failure.
    if (!accessionNumber || !filedDate) continue;
    const { schedule, isAmendment } = classifyForm(form);
    out.push({ accessionNumber, form, schedule, isAmendment, filedDate, primaryDocument: r.primaryDocument?.[i] ?? "" });
  }
  return out.sort((a, b) => b.filedDate.localeCompare(a.filedDate));
}

// ───────────────────────── filing header (SGML) → subject company ─────────────────────────

export interface OwnershipHeader {
  subjectCik: string; // 10-digit zero-padded
  subjectName: string;
  filerName: string;
  groupMembers: string[];
}

const tagValue = (line: string, tag: string): string | null => {
  // Line-oriented pseudo-SGML: `<TAG>value` with no closing tag for scalars.
  const m = line.match(new RegExp(`^<${tag}>(.*)$`));
  return m ? m[1]!.trim() : null;
};

/**
 * Pure: parse a 13D/13G `.hdr.sgml` header (line-oriented pseudo-SGML — NOT real
 * XML, do not feed fast-xml-parser). Captures the SUBJECT-COMPANY (the security
 * the stake is in: CIK + conformed name), the FILED-BY conformed name, and any
 * GROUP-MEMBERS. Returns null when there's no parseable subject company (the
 * filing can't be made symbol-queryable → caller skips it).
 */
export function parseOwnershipHeader(sgml: string): OwnershipHeader | null {
  const lines = sgml.split(/\r?\n/);
  let subjectCik = "";
  let subjectName = "";
  let filerName = "";
  const groupMembers: string[] = [];
  let scope: "subject" | "filedby" | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("<SUBJECT-COMPANY>")) scope = "subject";
    else if (line.startsWith("<FILED-BY>")) scope = "filedby";
    else if (line.startsWith("</SUBJECT-COMPANY>") || line.startsWith("</FILED-BY>")) scope = null;

    const gm = tagValue(line, "GROUP-MEMBERS");
    if (gm) groupMembers.push(gm);

    // <CONFORMED-NAME> (exact — not <FORMER-CONFORMED-NAME>) and the first <CIK> per block.
    const name = tagValue(line, "CONFORMED-NAME");
    const cik = tagValue(line, "CIK");
    if (scope === "subject") {
      if (name && !subjectName) subjectName = name;
      if (cik && !subjectCik) subjectCik = cik.padStart(10, "0");
    } else if (scope === "filedby") {
      if (name && !filerName) filerName = name;
    }
  }
  if (!subjectCik) return null;
  return { subjectCik, subjectName, filerName, groupMembers };
}

// ───────────────────────── cover page (HTML) → cusip / % / shares (best-effort) ─────────────────────────

export interface CoverData {
  cusip: string | null;
  pctOfClass: number | null;
  sharesOwned: number | null;
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");

// removeNSPrefix drops the `com:` prefixes; parseTagValue off keeps CUSIPs as strings.
const xmlParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

type XmlNode = Record<string, unknown>;
const asArray = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
/** A tag holding a plain number ("12528346.00", "3.32"); an empty tag or prose → null (Number("") would be 0). */
const xmlNum = (x: unknown): number | null => {
  if (typeof x !== "string" || !/^\s*[0-9][0-9,]*(\.[0-9]+)?\s*$/.test(x)) return null;
  const n = Number(x.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pure: read cusip / % / shares from a structured `SCHEDULE 13D` / `SCHEDULE 13G`
 * `primary_doc.xml`. The two schemas tag the same facts under different names
 * (13D: `issuerCusipNumber`, `reportingPersonInfo`, `aggregateAmountOwned`,
 * `percentOfClass`; 13G: `issuerCusip`, `coverPageHeaderReportingPersonDetails`,
 * `reportingPersonBeneficiallyOwnedAggregateNumberOfShares`, `classPercent`).
 *
 * A filing covers several reporting persons — funds, their GP, and the person who
 * controls them all. The stake we report is the LARGEST aggregate any of them
 * claims (the controlling person reports the whole group; a feeder fund may show
 * 0), with that same person's percent, so the two numbers always belong together.
 */
function parseCoverXml(xml: string): CoverData {
  const doc = xmlParser.parse(xml) as XmlNode | null;
  const form = ((doc?.edgarSubmission as XmlNode | undefined)?.formData ?? {}) as XmlNode;
  const issuer = ((form.coverPageHeader as XmlNode | undefined)?.issuerInfo ?? {}) as XmlNode;
  const rawCusip = asArray((issuer.issuerCusips as XmlNode | undefined)?.issuerCusipNumber ?? issuer.issuerCusip)[0];
  const cusipText = typeof rawCusip === "string" ? rawCusip.trim().toUpperCase() : "";
  const cusip = /^[0-9A-Z]{9}$/.test(cusipText) ? cusipText : null;

  const persons = [
    ...asArray((form.reportingPersons as XmlNode | undefined)?.reportingPersonInfo),
    ...asArray(form.coverPageHeaderReportingPersonDetails),
  ] as XmlNode[];
  let best: { shares: number; pct: number | null } | null = null;
  for (const p of persons) {
    if (!p || typeof p !== "object") continue;
    const shares = xmlNum(p.aggregateAmountOwned ?? p.reportingPersonBeneficiallyOwnedAggregateNumberOfShares);
    if (shares == null) continue;
    const pct = xmlNum(p.percentOfClass ?? p.classPercent);
    if (!best || shares > best.shares) best = { shares, pct: pct != null && pct <= 100 ? pct : null };
  }
  return { cusip, pctOfClass: best?.pct ?? null, sharesOwned: best?.shares ?? null };
}

/**
 * Pure, BEST-EFFORT: pull CUSIP / percent-of-class / shares from a 13D/13G cover
 * page. A structured `SCHEDULE 13D/G` XML document is read by its tags (see
 * `parseCoverXml`). The pre-2025 cover is unstructured HTML with the key numbers
 * in table cells often physically separated from their labels, so % and shares
 * frequently DO NOT parse — every field is nullable and this never throws. CUSIP
 * (a 9-char header token) is the most reliable. Treat null as "not
 * disclosed/unparsed", not zero.
 */
export function parseCoverPage(html: string): CoverData {
  if (/<edgarSubmission[\s>]/.test(html.slice(0, 2_000))) {
    try {
      return parseCoverXml(html);
    } catch {
      return { cusip: null, pctOfClass: null, sharesOwned: null };
    }
  }
  // The cover page (CUSIP / % / shares) is always at the very start of the filing;
  // a 13D/13G can carry MBs of exhibits, so cap the regex work to the first 250KB.
  const text = stripTags(html.slice(0, 250_000));

  let cusip: string | null = null;
  const cm = text.match(/CUSIP\s*(?:No\.?|Number)?\s*[:.)]?\s*([0-9A-Z](?:[ ]?[0-9A-Z]){8})/i);
  if (cm) {
    const compact = cm[1]!.replace(/\s+/g, "").toUpperCase();
    if (compact.length === 9) cusip = compact;
  }

  let pctOfClass: number | null = null;
  // Tolerant gap: the value often sits past a row-number like "(11)", so allow any
  // chars (capped) between the label and the first "<number>%". Requires a literal
  // % — a detached value with no % sign stays null (best-effort contract).
  const pm = text.match(/PERCENT\s+OF\s+CLASS[\s\S]{0,80}?([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (pm) {
    const n = Number(pm[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) pctOfClass = n;
  }

  let sharesOwned: number | null = null;
  const sm = text.match(/AGGREGATE\s+AMOUNT\s+BENEFICIALLY\s+OWNED[^0-9]{0,80}?([0-9][0-9,]{3,})/i);
  if (sm) {
    const n = Number(sm[1]!.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) sharesOwned = n;
  }

  return { cusip, pctOfClass, sharesOwned };
}

// ───────────────────────── thin client ─────────────────────────

/** Fetch a filing's `.hdr.sgml` header (raw text). `filerCik` is the numeric (un-padded) CIK. */
export async function fetchOwnershipHeader(filerCik: number, accn: string): Promise<string | null> {
  const dir = accnNoDashes(accn);
  return secGet<string>(`${SEC_WWW_BASE}/Archives/edgar/data/${filerCik}/${dir}/${accn}.hdr.sgml`, "application/sgml");
}

/**
 * Pure: the document to fetch for a filing's cover. For a structured filing,
 * submissions names the XSL-rendered view (`xslSCHEDULE_13D_X02/primary_doc.xml`,
 * HTML with the numbers scattered across table cells); the raw XML that view is
 * rendered from sits at the same name without the `xsl…/` directory.
 */
export function coverDocPath(primaryDocument: string): string {
  return primaryDocument.replace(/^xsl[^/]*\//, "");
}

/** Fetch a filing's cover document (raw HTML, or the structured XML) for best-effort parsing. */
export async function fetchCoverDoc(filerCik: number, accn: string, primaryDocument: string): Promise<string | null> {
  if (!primaryDocument) return null;
  const dir = accnNoDashes(accn);
  return secGet<string>(`${SEC_WWW_BASE}/Archives/edgar/data/${filerCik}/${dir}/${coverDocPath(primaryDocument)}`, "text/html");
}

/** Resolve a subject company's CIK → its first listed ticker (null if not US-listed). */
export async function fetchSubjectTicker(subjectCik: string): Promise<{ ticker: string | null; name: string | null }> {
  const subs = await fetchSubmissions(Number(subjectCik));
  if (!subs) return { ticker: null, name: null };
  return { ticker: subs.tickers?.[0] ?? null, name: subs.name ?? null };
}

export { padCik };
