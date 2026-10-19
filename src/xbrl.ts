/**
 * XBRL instance reader — the dimensional facts a filing carries that the
 * companyfacts API (`edgar.ts`) does not: revenue and cost by segment member,
 * award milestones, anything tagged with an axis. companyfacts flattens every
 * fact to (concept, period) and drops the axis, so "automotive revenue" and
 * "total revenue" collapse into one number. The instance document keeps them
 * apart, at the price of parsing the contexts ourselves.
 *
 * Deliberately narrow: contexts with explicit members only (no typed members),
 * plain-text numeric facts, one filing at a time. That is all the thesis
 * generator (`scripts/gen-thesis-segments.ts`) needs, and a full XBRL processor
 * is the kind of dependency this package does not take on. Pure parser + thin
 * client, same shape as the other SEC modules.
 */
import { secGet } from "./http.js";

const SEC_WWW_BASE = "https://www.sec.gov";

export interface XbrlContext {
  id: string;
  /** Duration facts carry start/end; instant facts carry `instant`. ISO dates. */
  start?: string;
  end?: string;
  instant?: string;
  /** Explicit dimension members, namespace prefix stripped, in document order. */
  members: readonly string[];
}

export interface XbrlInstanceFact {
  /** Namespace prefix, e.g. `us-gaap`, `dei`, or the filer's own (`tsla`). */
  ns: string;
  /** Concept local name, e.g. `RevenueFromContractWithCustomerExcludingAssessedTax`. */
  tag: string;
  value: number;
  context: XbrlContext;
}

export interface XbrlInstance {
  facts: readonly XbrlInstanceFact[];
  /** `dei:EntityCommonStockSharesOutstanding` as of the cover date, when present. */
  coverShares: { instant: string; value: number } | null;
}

/** Strip an optional namespace prefix from a member or element name. */
const local = (qname: string): string => qname.replace(/^[^:]+:/, "");

/**
 * Pure: parse an XBRL instance document into numeric facts with their
 * contexts. Text facts (TextBlocks, dates, booleans) are skipped; a fact whose
 * value is not a finite number is skipped too.
 */
export function parseXbrlInstance(xml: string): XbrlInstance {
  // Both the prefixed (`xbrli:context`) and default-namespace forms occur in the wild.
  const src = xml.replace(/<(\/?)xbrli:/g, "<$1");
  const contexts = new Map<string, XbrlContext>();
  for (const m of src.matchAll(/<context id="([^"]+)">([\s\S]*?)<\/context>/g)) {
    const [, id, body] = m;
    const members = [...body!.matchAll(/<xbrldi:explicitMember dimension="[^"]+">([^<]+)<\/xbrldi:explicitMember>/g)].map((x) => local(x[1]!.trim()));
    contexts.set(id!, {
      id: id!,
      start: body!.match(/<startDate>([^<]+)<\/startDate>/)?.[1]?.trim(),
      end: body!.match(/<endDate>([^<]+)<\/endDate>/)?.[1]?.trim(),
      instant: body!.match(/<instant>([^<]+)<\/instant>/)?.[1]?.trim(),
      members,
    });
  }
  const facts: XbrlInstanceFact[] = [];
  let coverShares: XbrlInstance["coverShares"] = null;
  for (const m of src.matchAll(/<([A-Za-z][\w-]*):([A-Za-z][\w]*)\s([^>]*?)contextRef="([^"]+)"[^>]*>([^<]*)<\/\1:\2>/g)) {
    const [, ns, tag, , ctxId, raw] = m;
    if (ns === "link" || ns === "xbrldi") continue;
    const context = contexts.get(ctxId!);
    if (!context) continue;
    const value = Number(raw!.trim());
    if (!Number.isFinite(value)) continue;
    const fact = { ns: ns!, tag: tag!, value, context };
    facts.push(fact);
    if (ns === "dei" && tag === "EntityCommonStockSharesOutstanding" && context.instant && context.members.length === 0) {
      coverShares = { instant: context.instant, value };
    }
  }
  return { facts, coverShares };
}

export interface FactQuery {
  tag: string;
  /** Exact member set (order-insensitive); `[]` selects the undimensioned fact. */
  members?: readonly string[];
  start?: string;
  end?: string;
  instant?: string;
}

const sameMembers = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

export class XbrlAmbiguousFact extends Error {}

/**
 * Pure: the fact matching the query, or null. Members default to none (the
 * total). A filing repeats a fact in several places (the statement, a note),
 * which is fine when the values agree; two DIFFERENT values for one query
 * (a restated period, a unit mix-up) throw rather than let the first one win.
 */
export function findFact(inst: XbrlInstance, q: FactQuery): XbrlInstanceFact | null {
  const members = q.members ?? [];
  let found: XbrlInstanceFact | null = null;
  for (const f of inst.facts) {
    if (f.tag !== q.tag) continue;
    if (!sameMembers(f.context.members, members)) continue;
    if (q.start !== undefined && f.context.start !== q.start) continue;
    if (q.end !== undefined && f.context.end !== q.end) continue;
    if (q.instant !== undefined && f.context.instant !== q.instant) continue;
    if (found && found.value !== f.value) {
      throw new XbrlAmbiguousFact(`${q.tag}${members.length ? ` [${members.join("|")}]` : ""} ${q.instant ?? `${q.start ?? "…"}→${q.end ?? "…"}`}: ${found.value} and ${f.value}`);
    }
    found ??= f;
  }
  return found;
}

/** Pure: every distinct single-member context carrying `tag` over the period, with its value. */
export function membersOf(inst: XbrlInstance, tag: string, start: string, end: string): Array<{ member: string; value: number }> {
  const out: Array<{ member: string; value: number }> = [];
  const seen = new Set<string>();
  for (const f of inst.facts) {
    if (f.tag !== tag || f.context.start !== start || f.context.end !== end || f.context.members.length !== 1) continue;
    const m = f.context.members[0]!;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ member: m, value: f.value });
  }
  return out;
}

/** Pure: every distinct multi-member context carrying `tag` over the period (e.g. segment axis × product axis), with its value. */
export function multiMemberContexts(inst: XbrlInstance, tag: string, start: string, end: string): Array<{ members: readonly string[]; value: number }> {
  const out: Array<{ members: readonly string[]; value: number }> = [];
  const seen = new Set<string>();
  for (const f of inst.facts) {
    if (f.tag !== tag || f.context.start !== start || f.context.end !== end || f.context.members.length < 2) continue;
    const key = [...f.context.members].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ members: f.context.members, value: f.value });
  }
  return out;
}

// ───────────────────────── client ─────────────────────────

interface FilingIndex {
  directory?: { item?: { name: string; type?: string }[] };
}

const accnNoDashes = (accn: string): string => accn.replace(/-/g, "");

/**
 * Pure: the instance document's name in a filing's index. Inline-XBRL filings
 * (every 10-Q/10-K since 2019) ship the extracted instance as `<doc>_htm.xml`.
 */
export function pickInstanceDoc(index: FilingIndex): string | null {
  const items = index.directory?.item ?? [];
  return items.find((i) => /_htm\.xml$/i.test(i.name))?.name ?? items.find((i) => /\.xml$/i.test(i.name) && !/FilingSummary|_cal|_def|_lab|_pre/i.test(i.name))?.name ?? null;
}

/** Fetch + parse one filing's XBRL instance. Null when the filing or its instance is missing. */
export async function fetchXbrlInstance(cik: number, accession: string): Promise<XbrlInstance | null> {
  const dir = `${SEC_WWW_BASE}/Archives/edgar/data/${cik}/${accnNoDashes(accession)}`;
  const index = await secGet<FilingIndex>(`${dir}/index.json`);
  if (!index) return null;
  const doc = pickInstanceDoc(index);
  if (!doc) return null;
  const xml = await secGet<string>(`${dir}/${doc}`, "application/xml");
  return xml ? parseXbrlInstance(xml) : null;
}
