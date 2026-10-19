/**
 * A 13F holding and the quarter-over-quarter diff between two books. Pure — no
 * fetching, no XML — so the gateway can diff the quarters it reads from the DB
 * without reaching the EDGAR client in `./thirteenf.ts`. Imports nothing but
 * its sibling pure files; lint holds it to that.
 */

export interface Holding13F {
  cusip: string;
  issuerName: string;
  titleOfClass: string;
  /** Whole dollars (normalized). */
  value: number;
  shares: number;
  /** "Put" | "Call" | "" — a manager may hold shares AND options on one CUSIP. */
  putCall: string;
}

// ───────────────────────── quarter-over-quarter diff ─────────────────────────

export type HoldingChange = "new" | "added" | "trimmed" | "exited" | "held";

export interface HoldingDelta {
  cusip: string;
  putCall: string;
  issuerName: string;
  change: HoldingChange;
  shares: number; // current quarter shares (0 if exited)
  prevShares: number;
  value: number; // current quarter value (0 if exited)
}

/**
 * Pure: classify each position's quarter-over-quarter change. Keyed by
 * (cusip, putCall) so puts and shares diff independently. Exited names (present
 * last quarter, gone this quarter) are included with `change: "exited"`.
 */
export function diffHoldings(curr: Holding13F[], prev: Holding13F[]): HoldingDelta[] {
  const keyOf = (h: Holding13F): string => `${h.cusip}|${h.putCall}`;
  const prevByKey = new Map(prev.map((h) => [keyOf(h), h]));
  const out: HoldingDelta[] = [];
  for (const c of curr) {
    const p = prevByKey.get(keyOf(c));
    const prevShares = p?.shares ?? 0;
    let change: HoldingChange;
    if (!p) change = "new";
    else if (c.shares > prevShares) change = "added";
    else if (c.shares < prevShares) change = "trimmed";
    else change = "held";
    out.push({ cusip: c.cusip, putCall: c.putCall, issuerName: c.issuerName, change, shares: c.shares, prevShares, value: c.value });
  }
  const currKeys = new Set(curr.map(keyOf));
  for (const p of prev) {
    if (currKeys.has(keyOf(p))) continue;
    out.push({ cusip: p.cusip, putCall: p.putCall, issuerName: p.issuerName, change: "exited", shares: 0, prevShares: p.shares, value: 0 });
  }
  return out;
}
