/**
 * OpenFIGI symbology — free CUSIP→ticker resolution for 13F holdings. The 13F
 * info table carries only CUSIPs; the official CUSIP↔ticker master is a paid
 * dataset, but OpenFIGI (Bloomberg's open symbology service) maps the CUSIPs we
 * actually hold for free. Results are cached into `data_13f_cusip_map`, so this
 * runs once per new CUSIP, not per read.
 *
 * Rate limits: OpenFIGI throttles per-requester (≈25 req/min + 10 jobs/req
 * anonymous; higher with an API key). We batch jobs per request and space
 * requests under the per-minute ceiling. Thin and dependency-free (mirrors the
 * sec-http throttle, but OpenFIGI's window is per-minute, not per-second).
 */
import { secSettings } from "./settings.js";

export class OpenFigiError extends Error {}

export interface CusipTicker {
  ticker: string;
  name: string | null;
}

// OpenFIGI returns one job-result per request item, in order. A hit carries a
// `data` array (one entry per listing); a miss carries `warning` (unknown id).
interface FigiDatum {
  ticker?: string;
  name?: string;
  exchCode?: string;
  securityType?: string;
}
interface FigiResult {
  data?: FigiDatum[];
  warning?: string;
  error?: string;
}

// Jobs per request: a key lifts the cap to 100, anonymous is 10.
const batchSize = (): number => (secSettings().openfigi.apiKey ? 100 : 10);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Sliding 60s window, process-global so concurrent callers share one bucket
// (OpenFIGI's ceiling is per-requester, like SEC's).
const WINDOW_MS = 60_000;
const reqTimes: number[] = [];

async function throttle(): Promise<void> {
  const limit = secSettings().openfigi.rateLimit;
  const now = Date.now();
  while (reqTimes.length && now - reqTimes[0]! >= WINDOW_MS) reqTimes.shift();
  if (reqTimes.length >= limit) {
    await sleep(WINDOW_MS - (now - reqTimes[0]!));
    return throttle();
  }
  reqTimes.push(Date.now());
}

/**
 * A 13F identifier whose first character is a letter is a CINS — the CUSIP
 * scheme's foreign-issuer range (G = Ireland/Bermuda/Cayman, N = Netherlands,
 * L = Luxembourg, …): Accenture G1151C101, ASML N07059210, Spotify L8681T102.
 * OpenFIGI answers those only as ID_CINS; sent as ID_CUSIP they come back
 * "No identifier found", which is how ~2.7k of them ended up tombstoned.
 */
export const isCins = (id: string): boolean => /^[A-Z]/.test(id);

const idTypeFor = (id: string): "ID_CINS" | "ID_CUSIP" => (isCins(id) ? "ID_CINS" : "ID_CUSIP");

/**
 * Pick the best ticker among a hit's listings: prefer the US composite (the
 * exchange-agnostic primary symbol, exchCode "US"), else the first listing.
 * Returns null when no entry carries a ticker. `usOnly` drops the fallback: a
 * CINS hit lists the home-market lines first (Accenture's first rows are "CSA"
 * on German venues), so without a US composite the first listing would be a
 * foreign symbol that collides with an unrelated US ticker.
 */
export function pickTicker(data: FigiDatum[], opts: { usOnly?: boolean } = {}): CusipTicker | null {
  const withTicker = data.filter((d) => d.ticker);
  if (withTicker.length === 0) return null;
  const composite = withTicker.find((d) => d.exchCode === "US");
  const chosen = composite ?? (opts.usOnly ? undefined : withTicker[0]);
  if (!chosen) return null;
  return { ticker: chosen.ticker!.toUpperCase(), name: chosen.name?.trim() || null };
}

/** Map one parsed OpenFIGI response array back onto its request CUSIPs (same order). */
export function collectBatch(cusips: string[], results: FigiResult[]): Map<string, CusipTicker> {
  const out = new Map<string, CusipTicker>();
  results.forEach((r, i) => {
    const cusip = cusips[i];
    if (!cusip || !r.data) return; // warning/error/missing → leave unmapped
    const t = pickTicker(r.data, { usOnly: isCins(cusip) });
    if (t) out.set(cusip, t);
  });
  return out;
}

async function postMapping(cusips: string[]): Promise<FigiResult[]> {
  const apiKey = secSettings().openfigi.apiKey;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-OPENFIGI-APIKEY"] = apiKey;
  const body = JSON.stringify(cusips.map((c) => ({ idType: idTypeFor(c), idValue: c })));

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await throttle();
    let resp: Response;
    try {
      resp = await fetch(`${secSettings().openfigi.baseUrl}/mapping`, { method: "POST", headers, body });
    } catch (err) {
      if (attempt === maxAttempts - 1) throw new OpenFigiError(`OpenFIGI fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(2 ** attempt * 1_000);
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt === maxAttempts - 1) throw new OpenFigiError(`OpenFIGI ${resp.status}`);
      await sleep(2 ** attempt * 2_000); // 429 → back off harder than SEC
      continue;
    }
    if (!resp.ok) throw new OpenFigiError(`OpenFIGI ${resp.status}`);
    return (await resp.json()) as FigiResult[];
  }
  return [];
}

/**
 * Resolve CUSIPs → tickers via OpenFIGI. Dedupes + uppercases input, batches
 * under the jobs-per-request cap, and rate-limits requests. Best-effort: a CUSIP
 * with no match is simply absent from the result map (never throws for misses).
 */
export async function resolveCusips(cusipsRaw: string[]): Promise<Map<string, CusipTicker>> {
  const cusips = [...new Set(cusipsRaw.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const out = new Map<string, CusipTicker>();
  const size = batchSize();
  for (let i = 0; i < cusips.length; i += size) {
    const chunk = cusips.slice(i, i + size);
    const results = await postMapping(chunk);
    for (const [cusip, t] of collectBatch(chunk, results)) out.set(cusip, t);
  }
  return out;
}
