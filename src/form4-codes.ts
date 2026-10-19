/**
 * The Form 4 transaction-code taxonomy: what each Table I/II code (P, S, A, M,
 * F, …) means and whether it reads as a buy, a sell or neither. Pure — no
 * fetching, no XML — so the gateway can decode stored codes without reaching
 * the EDGAR client in `./form4.ts`. Imports nothing but its sibling pure files;
 * lint holds it to that.
 */

// ───────────────────────── transaction-code taxonomy ─────────────────────────

export type Signal = "buy" | "sell" | "neutral";

interface CodeDef {
  label: string;
  signal: Signal;
}

// Form 4 Table I/II transaction codes. P/S (open-market) are the strong signals;
// the rest (grants, exercises, tax, gifts) are routine — but unlike FMP we keep them.
export const TRANSACTION_CODES: Record<string, CodeDef> = {
  P: { label: "Open-market buy", signal: "buy" },
  S: { label: "Open-market sell", signal: "sell" },
  A: { label: "Grant / award", signal: "neutral" },
  D: { label: "Disposition to issuer", signal: "neutral" },
  F: { label: "Tax withholding", signal: "neutral" },
  I: { label: "Discretionary transaction", signal: "neutral" },
  M: { label: "Option/RSU exercise", signal: "neutral" },
  C: { label: "Conversion of derivative", signal: "neutral" },
  E: { label: "Expiration (short)", signal: "neutral" },
  H: { label: "Expiration (long)", signal: "neutral" },
  O: { label: "Exercise (out-of-money)", signal: "neutral" },
  X: { label: "Exercise (in-money)", signal: "neutral" },
  G: { label: "Bona fide gift", signal: "neutral" },
  L: { label: "Small acquisition", signal: "neutral" },
  W: { label: "Will / inheritance", signal: "neutral" },
  Z: { label: "Voting trust", signal: "neutral" },
  J: { label: "Other", signal: "neutral" },
  K: { label: "Equity swap", signal: "neutral" },
  U: { label: "Tender of shares", signal: "neutral" },
};

export interface DecodedCode {
  code: string;
  label: string;
  signal: Signal;
}
export function decodeCode(code: string): DecodedCode {
  const def = TRANSACTION_CODES[code];
  return def ? { code, ...def } : { code, label: `Code ${code}`, signal: "neutral" };
}
