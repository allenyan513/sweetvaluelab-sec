# @sweetvaluelab/sec

Clients and parsers for SEC EDGAR: company financials (XBRL companyfacts and instance documents), 13F-HR holdings, Schedule 13D / 13G, Form 8-K, Form 4 and a company's other filings, plus CUSIP → ticker resolution through OpenFIGI. It talks to the free public endpoints (`data.sec.gov`, `www.sec.gov/Archives`), needs no API key, and returns plain objects. It never touches a database. It is an ES module package (`"type": "module"`); there is no CommonJS build.

Its only dependency is [`fast-xml-parser`](https://www.npmjs.com/package/fast-xml-parser). It reads no environment variables and uses no Node built-ins: all it needs is a global `fetch` (Node 20 or later).

It is the SEC layer of [SweetValueLab](https://sweetvaluelab.com), a free US-equity valuation site, and runs there every night: the [13F pages](https://sweetvaluelab.com/investors) (each manager's quarter-over-quarter changes), the insider and ownership tabs on each stock, and the financial statements behind the valuation models all come through it. This is the same code, published from the site's repository.

```bash
npm install @sweetvaluelab/sec
```

## Quick start

```ts
import { configureSec } from "@sweetvaluelab/sec/settings";
import { tickerToCik, fetchStatements } from "@sweetvaluelab/sec/edgar";
import { fetchLatest13F } from "@sweetvaluelab/sec/thirteenf";
import { diffHoldings } from "@sweetvaluelab/sec/holdings";

configureSec({ userAgent: "Your Name (you@example.com)" });

// Annual income, balance-sheet and cash-flow rows, straight from XBRL companyfacts.
const cik = await tickerToCik("AAPL");
const statements = await fetchStatements("AAPL", "annual");
console.log(cik, statements?.income[0]); // { symbol, date, period, revenue, netIncome, … }

// Berkshire Hathaway's last two 13F books and what changed between them.
const [latest, previous] = (await fetchLatest13F(1067983, 2)) ?? [];
if (latest && previous) {
  for (const d of diffHoldings(latest.holdings, previous.holdings)) {
    if (d.change !== "held") console.log(d.change, d.issuerName, d.prevShares, "→", d.shares);
  }
}
```

## Configure once, before the first request

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
| `thirteenf` | 13F-HR: finding the filings in the submissions feed, parsing the information table, value scaling (thousands before 2023-01-03, dollars after, checked against implied prices), amendments (`RESTATEMENT` vs `NEW HOLDINGS`), and one book per period. |
| `holdings` | **Pure.** `Holding13F` and `diffHoldings` (new / added / trimmed / exited / held, keyed by CUSIP and put/call). |
| `ownership` | Schedule 13D / 13G: subject company from `hdr.sgml`, cover-page CUSIP / percent / shares (best effort). |
| `eightk` | 8-Ks from the submissions feed and EDGAR's real-time Atom feed, plus `company_tickers.json`. |
| `eightk-items` | **Pure.** The 8-K item-code taxonomy: label and materiality (`high` / `material` / `routine`). |
| `form4` | Form 4 XML: owners, Table I and II transactions, 10b5-1 flags. |
| `form4-codes` | **Pure.** The transaction-code taxonomy (P, S, A, M, F, …) and a buy / sell / neutral signal. |
| `filings` | A company's other filings in a date window, filtered by **your** allowlist: `findCompanyFilings(subs, since, (form) => boolean)`. Also an 8-K's exhibit list, to find its press release. |
| `openfigi` | `resolveCusips`: batched CUSIP → ticker lookups, preferring the US composite listing. |

The three pure modules make no requests and parse no XML. They import only one another, so code that must never fetch, such as a read-only API layer, can depend on them alone.

## Things EDGAR does that you would not guess

- `hdr.sgml` is SGML, not XML. Read the 13D / 13G subject company from it line by line.
- A manager can change the entity it files under. The old CIK just stops filing, so verify a roster CIK against its latest 13F-HR period.
- 13F values were reported in thousands until 2023-01-03 and in dollars after that. Some filers got the switch wrong in both directions, so `valueScale` decides per filing from the implied share prices.
- A `13F-HR/A` marked `NEW HOLDINGS` sometimes carries the entire book again instead of an addition to it. `buildPeriodBook` treats it as a restatement when it covers most of the original.
- companyfacts leaves some lines untagged for many filers: cost of revenue, operating income, EPS, sometimes the share count. The mapper returns only what is tagged and derives nothing beyond EBITDA (operating income + D&A) and free cash flow (operating cash flow − capex). A missing line comes back missing, and filling the gap is up to you.

## Tests

```bash
npm test
```

The tests use fixtures and a mocked `fetch`, and none of them touch the network.

## License

MIT. Built and maintained by [SweetValueLab](https://sweetvaluelab.com).
