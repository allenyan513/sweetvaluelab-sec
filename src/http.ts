/**
 * Shared SEC EDGAR HTTP layer — a single rate-limited, UA-compliant fetcher used
 * by every SEC consumer (companyfacts in `edgar.ts`, 13F filings in
 * `thirteenf.ts`). Kept in one module on purpose: SEC's fair-access guideline is
 * ≤10 req/s *per requester*, so the throttle bucket must be process-global and
 * shared across consumers — two independent buckets would let the combined rate
 * exceed the ceiling. Thin and dependency-free (mirrors fmp.ts).
 */
import { secSettings } from "./settings.js";

export class SecError extends Error {}

// ───────────────────────── rate-limited fetch (SEC fair-access) ─────────────────────────
// SEC asks for ≤10 req/s and a descriptive User-Agent with contact info. We run
// a conservative sliding-window bucket (default 8/s) and always send the UA.

const WINDOW_MS = 1_000;
const timestamps: number[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function throttle(): Promise<void> {
  const limit = secSettings().rateLimit;
  const now = Date.now();
  while (timestamps.length && now - timestamps[0]! >= WINDOW_MS) timestamps.shift();
  if (timestamps.length >= limit) {
    await sleep(WINDOW_MS - (now - timestamps[0]!));
    return throttle();
  }
  timestamps.push(Date.now());
}

/**
 * GET a SEC URL with rate-limiting, the compliant User-Agent, and soft 404 →
 * null. Retries 429/5xx/network up to 3 attempts with exponential backoff.
 * `accept` defaults to JSON; pass `"application/xml"` (or text) for filing
 * documents — the caller gets the raw body string when `accept` is non-JSON.
 */
export async function secGet<T>(url: string, accept = "application/json"): Promise<T | null> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await throttle();
    try {
      const resp = await fetch(url, { headers: { "User-Agent": secSettings().userAgent, Accept: accept } });
      if (resp.status === 404) return null; // no such resource — soft
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt === maxAttempts - 1) throw new SecError(`SEC ${resp.status} for ${url}`);
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (!resp.ok) throw new SecError(`SEC ${resp.status} for ${url}`);
      const isJson = accept.includes("json");
      // Parse the body INSIDE the try so a malformed/empty 200 retries (via the
      // catch) rather than throwing a bare SyntaxError that aborts the sync.
      return (isJson ? await resp.json() : await resp.text()) as T;
    } catch (err) {
      if (err instanceof SecError) throw err; // terminal HTTP error (4xx) — don't retry
      if (attempt === maxAttempts - 1) throw new SecError(`SEC fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(2 ** attempt * 500); // network or body-parse error — back off + retry
    }
  }
  return null;
}
