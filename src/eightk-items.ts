/**
 * The Form 8-K item-code taxonomy: what each item number (2.02 earnings, 5.02
 * leadership, 1.03 bankruptcy, …) means and how material it is. Pure — no
 * fetching, no XML — so the gateway can decode the codes it reads from the DB
 * without reaching the EDGAR client in `./eightk.ts`. Imports nothing but its
 * sibling pure files (`./form4-codes`, `./holdings`); lint holds it to that.
 */

// ───────────────────────── 8-K item-code taxonomy ─────────────────────────

/** Materiality bucket for display + (future) playbook routing. */
export type ItemCategory = "high" | "material" | "routine";

interface ItemDef {
  label: string;
  category: ItemCategory;
}

// The standard Form 8-K items. `high` = market-moving / distress (bankruptcy,
// delisting, restatement, control change, cyber); `material` = earnings, M&A,
// leadership, agreements, obligations; `routine` = exhibits, Reg FD, votes, admin.
export const ITEM_CODES: Record<string, ItemDef> = {
  "1.01": { label: "Entry into a Material Agreement", category: "material" },
  "1.02": { label: "Termination of a Material Agreement", category: "material" },
  "1.03": { label: "Bankruptcy or Receivership", category: "high" },
  "1.04": { label: "Mine Safety", category: "routine" },
  "1.05": { label: "Material Cybersecurity Incident", category: "high" },
  "2.01": { label: "Completion of Acquisition/Disposition", category: "material" },
  "2.02": { label: "Results of Operations (Earnings)", category: "material" },
  "2.03": { label: "Creation of a Direct Financial Obligation", category: "material" },
  "2.04": { label: "Triggering Event Accelerating an Obligation", category: "material" },
  "2.05": { label: "Costs of Exit or Disposal", category: "material" },
  "2.06": { label: "Material Impairments", category: "material" },
  "3.01": { label: "Notice of Delisting", category: "high" },
  "3.02": { label: "Unregistered Sale of Equity", category: "material" },
  "3.03": { label: "Modification to Security-Holder Rights", category: "material" },
  "4.01": { label: "Change in Certifying Accountant", category: "material" },
  "4.02": { label: "Non-Reliance on Prior Financials (Restatement)", category: "high" },
  "5.01": { label: "Change in Control", category: "high" },
  "5.02": { label: "Departure/Election of Directors or Officers", category: "material" },
  "5.03": { label: "Amendment to Articles/Bylaws", category: "routine" },
  "5.04": { label: "Suspension of Trading Under Benefit Plans", category: "routine" },
  "5.05": { label: "Amendment to Code of Ethics", category: "routine" },
  "5.06": { label: "Change in Shell Company Status", category: "material" },
  "5.07": { label: "Submission of Matters to a Shareholder Vote", category: "routine" },
  "5.08": { label: "Shareholder Director Nominations", category: "routine" },
  "7.01": { label: "Regulation FD Disclosure", category: "routine" },
  "8.01": { label: "Other Events", category: "routine" },
  "9.01": { label: "Financial Statements and Exhibits", category: "routine" },
};

export interface DecodedItem {
  code: string;
  label: string;
  category: ItemCategory;
}

const CATEGORY_RANK: Record<ItemCategory, number> = { high: 0, material: 1, routine: 2 };

/** Pure: decode a raw item CSV ("2.02,9.01") to labelled items, most-material first.
 *  Unknown codes (new SEC items) pass through with a generic label + routine. */
export function decodeItems(csv: string): DecodedItem[] {
  return (csv ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((code) => {
      const def = ITEM_CODES[code];
      return def ? { code, ...def } : { code, label: `Item ${code}`, category: "routine" as ItemCategory };
    })
    .sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
}

/** Pure: the filing's overall category = its most-material item. */
export function filingCategory(csv: string): ItemCategory {
  const items = decodeItems(csv);
  return items[0]?.category ?? "routine";
}
