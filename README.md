<a href="https://sweetvaluelab.com/?utm_source=npm-sec&utm_medium=readme"><img src="https://sweetvaluelab.com/og-default.png" alt="SweetValueLab: free US equity research, no account, no paywall" width="100%"></a>

# @sweetvaluelab/sec

[![npm](https://img.shields.io/npm/v/@sweetvaluelab/sec)](https://www.npmjs.com/package/@sweetvaluelab/sec) [![license](https://img.shields.io/npm/l/@sweetvaluelab/sec)](./LICENSE) [![types](https://img.shields.io/npm/types/@sweetvaluelab/sec)](https://www.npmjs.com/package/@sweetvaluelab/sec) [![live at sweetvaluelab.com](https://img.shields.io/badge/live%20at-sweetvaluelab.com-3b82f6)](https://sweetvaluelab.com/?utm_source=npm-sec&utm_medium=readme)

**Read SEC EDGAR from TypeScript.** Financial statements from XBRL, 13F holdings and their quarter-over-quarter changes, insider trades (Form 4), 8-K events, 13D / 13G stakes, and CUSIP → ticker. No API key, one dependency, typed throughout.

> **This is the SEC layer of [SweetValueLab](https://sweetvaluelab.com/?utm_source=npm-sec&utm_medium=readme)**, a free, no-login research site for the 518 stocks of the S&P 500 and Nasdaq-100: valuation models and reverse DCFs, financial statements, the 13F portfolios of 80+ well-known managers, insider trades and SEC filings. The code here runs there every night. If you only need the data, it is already parsed on the site, as [open datasets](https://sweetvaluelab.com/datasets?utm_source=npm-sec&utm_medium=readme), and through a [free MCP server](#just-want-the-data) for AI assistants.

## Why this package

- **No key, no account.** It talks to SEC's free public endpoints (`data.sec.gov`, `www.sec.gov/Archives`) and OpenFIGI's anonymous tier.
- **One dependency** ([`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser)), no Node built-ins, no environment variables. All it needs is a global `fetch` (Node 20 or later).
- **Polite by default.** A process-wide throttle keeps you under SEC's 10 requests per second, every request carries your User-Agent, and 429s, 5xx and network errors are retried with backoff.
- **Handles EDGAR's quirks** so you don't learn them the hard way: 13F values switching from thousands to dollars, amendments that restate a whole book, fiscal Q4 that no 10-Q reports, SGML headers that look like XML. [More below](#things-edgar-does-that-you-would-not-guess).
- **Plain objects out.** No database, no ORM, no classes to subclass. Point-in-time fields (`acceptedAt`, `filedDate`) come with every filing.

## Install

```bash
npm install @sweetvaluelab/sec
```

ES modules only (`"type": "module"`); there is no CommonJS build.

## Quick start

```ts
import { configureSec } from "@sweetvaluelab/sec/settings";
import { fetchStatements } from "@sweetvaluelab/sec/edgar";

// SEC requires a User-Agent with a name and a contact address.
configureSec({ userAgent: "Your Name (you@example.com)" });

const statements = await fetchStatements("AAPL", "annual");
console.log(statements?.income[0]);
// { symbol: "AAPL", date: "2025-09-27", period: "FY", revenue: 416161000000, netIncome: 112010000000, … }
```

## Recipes

Every recipe below is something the site shows for real. Follow the "see it live" link to see the output rendered.

### What did a fund manager buy and sell last quarter? (13F)

```ts
import { fetchLatest13F } from "@sweetvaluelab/sec/thirteenf";
import { diffHoldings } from "@sweetvaluelab/sec/holdings";

const BERKSHIRE = 1067983; // the filer's CIK
const [latest, previous] = (await fetchLatest13F(BERKSHIRE, 2)) ?? [];

for (const d of diffHoldings(latest!.holdings, previous!.holdings)) {
  if (d.change !== "held") console.log(d.change, d.issuerName, d.prevShares, "→", d.shares);
}
// added ALPHABET INC …
// trimmed BANK OF AMER CORP …
```

See it live: [Berkshire Hathaway's 13F](https://sweetvaluelab.com/investors/buffett?utm_source=npm-sec&utm_medium=readme) · [all 80+ managers](https://sweetvaluelab.com/investors?utm_source=npm-sec&utm_medium=readme)

### Who inside the company traded shares? (Form 4)

```ts
import { tickerToCik } from "@sweetvaluelab/sec/edgar";
import { fetchSubmissions } from "@sweetvaluelab/sec/thirteenf";
import { find4Filings, fetch4Xml, parseForm4 } from "@sweetvaluelab/sec/form4";
import { decodeCode } from "@sweetvaluelab/sec/form4-codes";

const cik = (await tickerToCik("AAPL"))!;
const subs = (await fetchSubmissions(cik))!;

for (const f of find4Filings(subs).slice(0, 5)) {
  const xml = await fetch4Xml(cik, f.accessionNumber, f.primaryDocument);
  const form = xml ? parseForm4(xml) : null;
  for (const t of form?.transactions ?? []) {
    console.log(f.filedDate, form!.owners[0]?.name, decodeCode(t.code).label, t.shares, t.price);
  }
}
```

See it live: [Apple's insider trades](https://sweetvaluelab.com/stocks/aapl/insiders?utm_source=npm-sec&utm_medium=readme)

### What did the company just disclose? (8-K)

```ts
import { fetch8KFilings } from "@sweetvaluelab/sec/eightk";
import { decodeItems } from "@sweetvaluelab/sec/eightk-items";

for (const f of ((await fetch8KFilings(320193)) ?? []).slice(0, 5)) {
  console.log(f.filedDate, decodeItems(f.items).map((i) => `${i.code} ${i.label} (${i.category})`));
}
// 2026-07-30 [ "2.02 Results of Operations (Earnings) (material)", "9.01 Financial Statements and Exhibits (routine)" ]
```

See it live: [Apple's SEC filings](https://sweetvaluelab.com/stocks/aapl/filings?utm_source=npm-sec&utm_medium=readme)

### Quarterly financial statements (XBRL)

```ts
import { fetchStatements } from "@sweetvaluelab/sec/edgar";

const q = await fetchStatements("MSFT", "quarter");
// q.income / q.balance / q.cashflow: every quarter EDGAR has, newest first, including the fiscal Q4
// that no 10-Q reports (the 10-K year minus the three quarters before it).
```

See it live: [Microsoft's financials](https://sweetvaluelab.com/stocks/msft/financials?utm_source=npm-sec&utm_medium=readme)

### CUSIP → ticker (OpenFIGI)

```ts
import { resolveCusips } from "@sweetvaluelab/sec/openfigi";

const map = await resolveCusips(["037833100", "594918104"]);
console.log(map.get("037833100")); // { ticker: "AAPL", name: "APPLE INC" }
```

13F filings name positions by CUSIP only; this is how the site turns them into tickers.

## Just want the data?

Running your own EDGAR pipeline is the right call when you need custom fields or your own storage. If you don't, the same data is already parsed and refreshed nightly:

- **On the web:** [sweetvaluelab.com](https://sweetvaluelab.com/?utm_source=npm-sec&utm_medium=readme). Every stock has a valuation page, financials, insiders, ownership and filings. No sign-up.
- **As files:** [open datasets](https://sweetvaluelab.com/datasets?utm_source=npm-sec&utm_medium=readme) in CSV and JSON, CC BY 4.0.
- **In your AI assistant:** a free, read-only MCP server at `https://api.sweetvaluelab.com/mcp`, no key and no account, listed in the official MCP Registry as `com.sweetvaluelab/valuation`. Its tools find a stock, return its valuation (the price, each model's value and range, the discount rate) and the market context (the Treasury curve, the sentiment gauge).

  Claude (claude.ai or the desktop app): Settings → Connectors → Add custom connector, then paste the address. Claude Code:

  ```bash
  claude mcp add --transport http sweetvaluelab https://api.sweetvaluelab.com/mcp
  ```

  Cursor and other clients, in the MCP config file:

  ```json
  { "mcpServers": { "sweetvaluelab": { "url": "https://api.sweetvaluelab.com/mcp" } } }
  ```

  More in the [setup notes](https://sweetvaluelab.com/datasets?utm_source=npm-sec&utm_medium=readme#mcp). It answers from the same nightly data as the pages: model output, not live quotes, and not investment advice.

## Configuration

SEC's [fair-access policy](https://www.sec.gov/os/accessing-edgar-data) requires every request to carry a User-Agent naming who you are, with a contact address, and to stay at or below 10 requests per second. The package has no default identity: until you configure it, every fetch throws.

```ts
import { configureSec } from "@sweetvaluelab/sec/settings";

configureSec({
  userAgent: "Acme Research (ops@acme.example)", // required
  rateLimit: 8,                                   // EDGAR req/s, process-wide (default 8)
  openfigi: {
    apiKey: null,                                 // anonymous: 10 jobs per request (a key allows 100)
    rateLimit: 20,                                // req/min (default 20, under the anonymous limit)
  },
});
```

The EDGAR throttle is one sliding window for the whole process, shared by every module, because SEC counts requests per requester and not per module. `secGet` retries a 429, a 5xx, a network error and a malformed 200 up to three times with exponential backoff, and turns a 404 into `null`.

## Modules

Import each one by path, `@sweetvaluelab/sec/<module>`:

| Module | What it does |
|---|---|
| `settings` | `configureSec` / `secSettings`. |
| `http` | `secGet`: the rate-limited, User-Agent-stamped fetch every other module goes through. `SecError`. |
| `edgar` | Ticker → CIK (`tickerToCik`), companyfacts, and the mapping from XBRL concepts to income, balance and cash-flow rows, annual and quarterly. Quarterly rows include the quarters no 10-Q states — fiscal Q4 (the 10-K year minus nine months) and cash flow filed only year to date — derived by `withDerivedQuarters`. |
| `xbrl` | Reads one filing's XBRL instance: the dimensional facts (segment members, axes) that companyfacts flattens away. |
| `thirteenf` | 13F-HR: finding the filings in the submissions feed, parsing the information table, value scaling (thousands before 2023-01-03, dollars after, checked against implied prices), amendments (`RESTATEMENT` vs `NEW HOLDINGS`), and one book per period. Also `fetchSubmissions`, a company's whole filing index. |
| `holdings` | **Pure.** `Holding13F` and `diffHoldings` (new / added / trimmed / exited / held, keyed by CUSIP and put/call). |
| `ownership` | Schedule 13D / 13G: subject company from `hdr.sgml`, cover-page CUSIP / percent / shares (best effort). |
| `eightk` | 8-Ks from the submissions feed and EDGAR's real-time Atom feed, plus `company_tickers.json`. |
| `eightk-items` | **Pure.** The 8-K item-code taxonomy: label and materiality (`high` / `material` / `routine`). |
| `form4` | Form 4 XML: owners, Table I and II transactions, 10b5-1 flags. |
| `form4-codes` | **Pure.** The transaction-code taxonomy (P, S, A, M, F, …) with a label and whether the code is a purchase, a sale or neither. |
| `filings` | A company's other filings in a date window, filtered by **your** allowlist: `findCompanyFilings(subs, since, (form) => boolean)`. Also an 8-K's exhibit list, to find its press release. |
| `openfigi` | `resolveCusips`: batched CUSIP → ticker lookups, preferring the US composite listing. |

The three pure modules make no requests and parse no XML. They import only one another, so code that must never fetch, such as a read-only API layer or a browser bundle, can depend on them alone.

## Things EDGAR does that you would not guess

- `hdr.sgml` is SGML, not XML. Read the 13D / 13G subject company from it line by line.
- A manager can change the entity it files under. The old CIK just stops filing, so verify a CIK against its latest 13F-HR period.
- 13F values were reported in thousands until 2023-01-03 and in dollars after that. Some filers got the switch wrong in both directions, so `valueScale` decides per filing from the implied share prices.
- A `13F-HR/A` marked `NEW HOLDINGS` sometimes carries the entire book again instead of an addition to it. `buildPeriodBook` treats it as a restatement when it covers most of the original.
- companyfacts leaves some lines untagged for many filers: cost of revenue, operating income, EPS, sometimes the share count. The mapper returns only what is tagged and derives nothing beyond EBITDA (operating income + D&A) and free cash flow (operating cash flow − capex). A missing line comes back missing, and filling the gap is up to you.

## Contributing

Issues and pull requests are welcome at [github.com/allenyan513/sweetvaluelab-sec](https://github.com/allenyan513/sweetvaluelab-sec). The tests use fixtures and a mocked `fetch`, and none of them touch the network:

```bash
npm test
```

## License

MIT © [SweetValueLab](https://sweetvaluelab.com/?utm_source=npm-sec&utm_medium=readme). If this saved you a weekend of reading EDGAR's documentation, a link back to the site is the nicest thank-you.
