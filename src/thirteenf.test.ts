import { describe, it, expect } from "vitest";
import {
  find13FFilings,
  latestPerPeriod,
  pickInfoTableDoc,
  parseInfoTable,
  normalizeValue,
  aggregateHoldings,
  padCik,
  accnNoDashes,
  valueScale,
  parseAmendmentType,
  pickCoverDoc,
  buildPeriodBook,
  restatesBook,
  groupByPeriod,
  find13FInPage,
  type Submissions,
  type Filing13F,
  type InfoTableEntry,
  type LoadedFiling,
} from "./thirteenf.js";
import type { Holding13F } from "./holdings.js";

describe("padCik / accnNoDashes", () => {
  it("zero-pads CIK to 10 digits", () => {
    expect(padCik(1067983)).toBe("0001067983");
  });
  it("strips dashes from accession", () => {
    expect(accnNoDashes("0001067983-25-000123")).toBe("000106798325000123");
  });
});

describe("find13FFilings", () => {
  const subs: Submissions = {
    filings: {
      recent: {
        accessionNumber: ["a-1", "a-2", "a-3", "a-4"],
        form: ["13F-HR", "10-K", "13F-HR", "13F-HR/A"],
        reportDate: ["2025-03-31", "2024-12-31", "2024-12-31", "2024-12-31"],
        filingDate: ["2025-05-15", "2025-02-01", "2025-02-14", "2025-03-01"],
      },
    },
  };

  it("keeps only 13F-HR and 13F-HR/A, newest report period first", () => {
    const f = find13FFilings(subs);
    expect(f.map((x) => x.accessionNumber)).toEqual(["a-1", "a-4", "a-3"]);
    expect(f.every((x) => x.form.startsWith("13F-HR"))).toBe(true);
  });

  it("returns [] when no filings present", () => {
    expect(find13FFilings({})).toEqual([]);
    expect(find13FFilings({ filings: { recent: {} } })).toEqual([]);
  });

  it("skips a filing with an empty filingDate (would make known_at Invalid)", () => {
    const f = find13FFilings({
      filings: {
        recent: {
          accessionNumber: ["a-1", "a-2"],
          form: ["13F-HR", "13F-HR"],
          reportDate: ["2025-03-31", "2024-12-31"],
          filingDate: ["2025-05-15", ""],
        },
      },
    });
    expect(f.map((x) => x.accessionNumber)).toEqual(["a-1"]);
  });
});

describe("latestPerPeriod", () => {
  it("collapses a period to its newest-filed filing (amendment supersedes)", () => {
    const f = latestPerPeriod(find13FFilings({
      filings: {
        recent: {
          accessionNumber: ["orig", "amend"],
          form: ["13F-HR", "13F-HR/A"],
          reportDate: ["2024-12-31", "2024-12-31"],
          filingDate: ["2025-02-14", "2025-03-01"],
        },
      },
    }));
    expect(f).toHaveLength(1);
    expect(f[0]!.accessionNumber).toBe("amend");
  });
});

describe("pickInfoTableDoc", () => {
  it("prefers a name that looks like an info table", () => {
    const doc = pickInfoTableDoc({
      directory: { item: [{ name: "primary_doc.xml" }, { name: "form13fInfoTable.xml" }, { name: "0001-25.txt" }] },
    });
    expect(doc).toBe("form13fInfoTable.xml");
  });
  it("falls back to a non-cover xml when no info-table name", () => {
    const doc = pickInfoTableDoc({ directory: { item: [{ name: "primary_doc.xml" }, { name: "table123.xml" }] } });
    expect(doc).toBe("table123.xml");
  });
  it("returns null when no xml present", () => {
    expect(pickInfoTableDoc({ directory: { item: [{ name: "a.txt" }] } })).toBeNull();
    expect(pickInfoTableDoc({})).toBeNull();
  });
  it("tolerates items missing a name without throwing", () => {
    const doc = pickInfoTableDoc({ directory: { item: [{} as { name: string }, { name: "infotable.xml" }] } });
    expect(doc).toBe("infotable.xml");
  });
});

describe("parseInfoTable", () => {
  it("returns [] for empty/garbage XML without throwing", () => {
    expect(parseInfoTable("")).toEqual([]);
    expect(parseInfoTable("<informationTable></informationTable>")).toEqual([]);
  });

  it("parses rows, preserving CUSIP leading zeros and reading shares/putCall", () => {
    const xml = `<?xml version="1.0"?>
      <informationTable>
        <infoTable>
          <nameOfIssuer>APPLE INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>1000</value>
          <shrsOrPrnAmt><sshPrnamt>50</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <investmentDiscretion>SOLE</investmentDiscretion>
        </infoTable>
        <infoTable>
          <nameOfIssuer>SPDR S&amp;P 500</nameOfIssuer>
          <titleOfClass>PUT</titleOfClass>
          <cusip>78462F103</cusip>
          <value>500</value>
          <shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <putCall>Put</putCall>
        </infoTable>
      </informationTable>`;
    const rows = parseInfoTable(xml);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cusip: "037833100", nameOfIssuer: "APPLE INC", value: 1000, shares: 50, putCall: "" });
    expect(rows[1]!.putCall).toBe("Put");
  });

  it("reads comma-formatted value and share amounts, and defaults a missing sshPrnamtType to SH", () => {
    const xml = `<informationTable><infoTable>
      <nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip>
      <value>1,234,567</value>
      <shrsOrPrnAmt><sshPrnamt>5,000</sshPrnamt></shrsOrPrnAmt>
    </infoTable></informationTable>`;
    expect(parseInfoTable(xml)[0]).toMatchObject({ value: 1_234_567, shares: 5_000, sshPrnamtType: "SH" });
  });

  it("tolerates namespace prefixes and a single-row table", () => {
    const xml = `<ns1:informationTable xmlns:ns1="x">
      <ns1:infoTable>
        <ns1:nameOfIssuer>NVIDIA</ns1:nameOfIssuer>
        <ns1:cusip>67066G104</ns1:cusip>
        <ns1:value>2000</ns1:value>
        <ns1:shrsOrPrnAmt><ns1:sshPrnamt>7</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>
      </ns1:infoTable>
    </ns1:informationTable>`;
    const rows = parseInfoTable(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cusip: "67066G104", value: 2000, shares: 7 });
  });
});

describe("normalizeValue", () => {
  it("scales pre-2023-01-03 filings from thousands to whole dollars", () => {
    expect(normalizeValue(1000, "2022-11-14")).toBe(1_000_000);
  });
  it("leaves on/after-cutoff filings as whole dollars", () => {
    expect(normalizeValue(1000, "2023-02-14")).toBe(1000);
    expect(normalizeValue(1000, "2023-01-03")).toBe(1000);
  });
});

describe("aggregateHoldings", () => {
  it("merges same (cusip, putCall), normalizes value, sorts by value desc", () => {
    const entries = [
      // Thousands, as filed in 2022: 100 ($100,000) for 500 shares is $200 a share.
      { nameOfIssuer: "APPLE INC", titleOfClass: "COM", cusip: "037833100", value: 100, shares: 500, sshPrnamtType: "SH", putCall: "" },
      { nameOfIssuer: "APPLE INC", titleOfClass: "COM", cusip: "037833100", value: 50, shares: 300, sshPrnamtType: "SH", putCall: "" },
      { nameOfIssuer: "NVIDIA", titleOfClass: "COM", cusip: "67066G104", value: 1000, shares: 9000, sshPrnamtType: "SH", putCall: "" },
    ];
    const out = aggregateHoldings(entries, "2022-11-14"); // thousands → ×1000
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ cusip: "67066G104", value: 1_000_000, shares: 9000 });
    expect(out[1]).toMatchObject({ cusip: "037833100", value: 150_000, shares: 800 });
  });

  it("keeps a put line distinct from the share line on the same issuer", () => {
    const entries = [
      { nameOfIssuer: "SPY", titleOfClass: "ETF", cusip: "78462F103", value: 100, shares: 5, sshPrnamtType: "SH", putCall: "" },
      { nameOfIssuer: "SPY", titleOfClass: "PUT", cusip: "78462F103", value: 200, shares: 2, sshPrnamtType: "SH", putCall: "Put" },
    ];
    const out = aggregateHoldings(entries, "2023-05-14");
    expect(out).toHaveLength(2);
  });
});

const entry = (o: Partial<InfoTableEntry>): InfoTableEntry => ({
  nameOfIssuer: o.nameOfIssuer ?? "ISSUER",
  titleOfClass: o.titleOfClass ?? "COM",
  cusip: o.cusip ?? "000000001",
  value: o.value ?? 0,
  shares: o.shares ?? 0,
  sshPrnamtType: o.sshPrnamtType ?? "SH",
  putCall: o.putCall ?? "",
});

describe("valueScale", () => {
  // Baupost still files in thousands three years after the switch to dollars: its
  // stored Q2 2026 rows had a median value/shares of $0.13, and the site showed a
  // ~$5.4B book as $5.4M. The rows below are shaped like that, not copied from it.
  it("reads a post-2023 filing in thousands when its prices only make sense that way (Baupost)", () => {
    const baupost = [entry({ value: 2_500, shares: 16_000 }), entry({ value: 900, shares: 7_000 }), entry({ value: 4_000, shares: 30_000 })];
    expect(valueScale(baupost, "2026-08-13")).toBe(1000);
  });
  it("reads a pre-2023 filing in dollars when the filer already used dollars", () => {
    // $150 a share as written; ×1,000 would be $150,000.
    const dollars = [entry({ value: 1_500_000, shares: 10_000 }), entry({ value: 3_000_000, shares: 20_000 }), entry({ value: 800_000, shares: 4_000 })];
    expect(valueScale(dollars, "2019-02-14")).toBe(1);
  });
  it("keeps the date rule when both units are plausible (Oaktree: median near $1)", () => {
    // Median value/shares of 2.2: $2.20 in dollars, $2,200 in thousands — both possible.
    const ambiguous = [entry({ value: 2_200, shares: 1_000 }), entry({ value: 1_100, shares: 1_000 }), entry({ value: 3_300, shares: 1_000 })];
    expect(valueScale(ambiguous, "2026-08-14")).toBe(1);
    expect(valueScale(ambiguous, "2022-08-14")).toBe(1000);
  });
  it("judges by the median, so one odd position does not flip a filing", () => {
    // Four $50 stocks (in dollars) and one BRK.A at $700,000.
    const rows = [1, 2, 3, 4].map((i) => entry({ cusip: `C${i}`, value: 50_000, shares: 1_000 }));
    rows.push(entry({ cusip: "BRKA", value: 7_000_000, shares: 10 }));
    expect(valueScale(rows, "2025-05-15")).toBe(1);
  });
  it("ignores options, principal amounts and zero rows when judging", () => {
    const rows = [
      entry({ value: 5_000, shares: 100 }), // $50 in dollars
      entry({ value: 1, shares: 1_000_000, putCall: "Put" }),
      entry({ value: 1, shares: 1_000_000, sshPrnamtType: "PRN" }),
      entry({ value: 0, shares: 0 }),
    ];
    expect(valueScale(rows, "2024-02-14")).toBe(1);
  });
  it("falls back to the date rule with no share rows to judge from", () => {
    expect(valueScale([], "2020-02-14")).toBe(1000);
    expect(valueScale([], "2024-02-14")).toBe(1);
  });
  it("is what aggregateHoldings applies: the same thousands table lands in dollars either side of the cutoff", () => {
    const rows = [entry({ cusip: "A", value: 2_500, shares: 16_000 }), entry({ cusip: "B", value: 900, shares: 7_000 })];
    for (const filed of ["2022-11-14", "2026-08-13"]) {
      expect(aggregateHoldings(rows, filed).map((h) => h.value)).toEqual([2_500_000, 900_000]);
    }
  });
});

describe("parseInfoTable placeholder rows", () => {
  // Olstein's Q2 2026 13F-HR: nothing to report, one row of zeros.
  it("drops the all-zero placeholder a filer with no holdings files", () => {
    const xml = `<informationTable><infoTable><nameOfIssuer>0</nameOfIssuer><titleOfClass>0</titleOfClass><cusip>000000000</cusip><value>0</value><shrsOrPrnAmt><sshPrnamt>0</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>`;
    expect(parseInfoTable(xml)).toEqual([]);
  });
  it("keeps a real CUSIP that merely starts with zeros", () => {
    const xml = `<informationTable><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>037833100</cusip><value>10</value><shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>`;
    expect(parseInfoTable(xml).map((e) => e.cusip)).toEqual(["037833100"]);
  });
});

describe("parseAmendmentType / pickCoverDoc", () => {
  // Trimmed from Berkshire's 13F-HR/A for Q1 2025 (0000950123-25-008361).
  const cover = (type: string) =>
    `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler" xmlns:ns1="http://www.sec.gov/edgar/common"><headerData><submissionType>13F-HR/A</submissionType></headerData><formData><coverPage><reportCalendarOrQuarter>03-31-2025</reportCalendarOrQuarter><isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentInfo><amendmentType>${type}</amendmentType></amendmentInfo></coverPage></formData></edgarSubmission>`;
  it("reads NEW HOLDINGS and RESTATEMENT", () => {
    expect(parseAmendmentType(cover("NEW HOLDINGS"))).toBe("NEW HOLDINGS");
    expect(parseAmendmentType(cover("RESTATEMENT"))).toBe("RESTATEMENT");
  });
  it("is null for an original filing or anything it does not recognise", () => {
    expect(parseAmendmentType(`<edgarSubmission><formData><coverPage><isAmendment>false</isAmendment></coverPage></formData></edgarSubmission>`)).toBeNull();
    expect(parseAmendmentType(cover("SOMETHING ELSE"))).toBeNull();
    expect(parseAmendmentType("not xml")).toBeNull();
  });
  it("finds primary_doc.xml among a filing's files, and only that", () => {
    expect(pickCoverDoc({ directory: { item: [{ name: "43981.xml" }, { name: "primary_doc.xml" }, { name: "x-index.html" }] } })).toBe("primary_doc.xml");
    expect(pickCoverDoc({ directory: { item: [{ name: "43981.xml" }] } })).toBeNull();
  });
});

const filing = (accessionNumber: string, filingDate: string, form: Filing13F["form"] = "13F-HR", reportDate = "2025-03-31"): Filing13F => ({ accessionNumber, filingDate, form, reportDate });
const hold = (cusip: string, value: number, shares = value / 100): Holding13F => ({ cusip, issuerName: cusip, titleOfClass: "COM", value, shares, putCall: "" });
const loaded = (f: Filing13F, holdings: Holding13F[] | null, amendmentType: LoadedFiling["amendmentType"] = null): LoadedFiling => ({ filing: f, holdings, amendmentType });

describe("buildPeriodBook", () => {
  // Berkshire, Q1 2025: the May 13F-HR left four positions out under confidential
  // treatment, and an August 13F-HR/A (NEW HOLDINGS) disclosed them.
  it("adds a NEW HOLDINGS amendment to the original instead of replacing it (Berkshire Q1 2025)", () => {
    const original = filing("orig", "2025-05-15");
    const amendment = filing("amend", "2025-08-14", "13F-HR/A");
    const book = buildPeriodBook([loaded(original, [hold("AAPL", 600), hold("AXP", 400)]), loaded(amendment, [hold("CB", 300)], "NEW HOLDINGS")])!;
    expect(book.holdings.map((h) => h.cusip)).toEqual(["AAPL", "AXP", "CB"]);
    expect(book.base.accessionNumber).toBe("orig");
    expect(book.added.map((f) => f.accessionNumber)).toEqual(["amend"]);
  });
  it("stamps each holding with the filing it came from, so a late disclosure is known from its own date", () => {
    const book = buildPeriodBook([loaded(filing("orig", "2025-05-15"), [hold("AAPL", 600)]), loaded(filing("amend", "2025-08-14", "13F-HR/A"), [hold("CB", 300)], "NEW HOLDINGS")])!;
    const byCusip = Object.fromEntries(book.holdings.map((h) => [h.cusip, [h.accessionNumber, h.filingDate]]));
    expect(byCusip).toEqual({ AAPL: ["orig", "2025-05-15"], CB: ["amend", "2025-08-14"] });
  });
  it("lets a RESTATEMENT replace the book, dropping what it no longer lists", () => {
    const book = buildPeriodBook([loaded(filing("orig", "2025-05-15"), [hold("AAPL", 600), hold("XOM", 50)]), loaded(filing("restate", "2025-06-01", "13F-HR/A"), [hold("AAPL", 610)], "RESTATEMENT")])!;
    expect(book.holdings.map((h) => [h.cusip, h.value])).toEqual([["AAPL", 610]]);
    expect(book.base.accessionNumber).toBe("restate");
  });
  it("drops a NEW HOLDINGS amendment filed before the restatement that superseded it", () => {
    const book = buildPeriodBook([
      loaded(filing("orig", "2025-05-15"), [hold("AAPL", 600)]),
      loaded(filing("new", "2025-05-20", "13F-HR/A"), [hold("CB", 300)], "NEW HOLDINGS"),
      loaded(filing("restate", "2025-06-01", "13F-HR/A"), [hold("AAPL", 600), hold("CB", 300)], "RESTATEMENT"),
    ])!;
    expect(book.holdings.map((h) => h.cusip).sort()).toEqual(["AAPL", "CB"]);
    expect(book.ignored.map((f) => f.accessionNumber)).toEqual(["new"]);
  });
  it("sums a position both filings list, as two lots of it", () => {
    const book = buildPeriodBook([loaded(filing("orig", "2025-05-15"), [hold("AAPL", 600, 6)]), loaded(filing("amend", "2025-08-14", "13F-HR/A"), [hold("AAPL", 100, 1)], "NEW HOLDINGS")])!;
    expect(book.holdings).toHaveLength(1);
    expect(book.holdings[0]).toMatchObject({ value: 700, shares: 7, accessionNumber: "orig" });
  });
  it("ignores an amendment whose cover it could not classify", () => {
    const book = buildPeriodBook([loaded(filing("orig", "2025-05-15"), [hold("AAPL", 600)]), loaded(filing("odd", "2025-08-14", "13F-HR/A"), [hold("ZZZ", 999)], null)])!;
    expect(book.holdings.map((h) => h.cusip)).toEqual(["AAPL"]);
    expect(book.ignored.map((f) => f.accessionNumber)).toEqual(["odd"]);
  });
  it("falls back to the previous original when the newest one's table cannot be read", () => {
    const book = buildPeriodBook([loaded(filing("first", "2025-05-15"), [hold("AAPL", 600)]), loaded(filing("refiled", "2025-05-16"), null)])!;
    expect(book.base.accessionNumber).toBe("first");
  });
  it("has no book for a period of amendments only, or of unreadable tables", () => {
    expect(buildPeriodBook([loaded(filing("amend", "2025-08-14", "13F-HR/A"), [hold("CB", 300)], "NEW HOLDINGS")])).toBeNull();
    expect(buildPeriodBook([loaded(filing("orig", "2013-02-14"), null)])).toBeNull();
    expect(buildPeriodBook([])).toBeNull();
  });
  it("keeps an empty book empty (a filer with nothing to report)", () => {
    expect(buildPeriodBook([loaded(filing("orig", "2026-07-07"), [])])!.holdings).toEqual([]);
  });
});

describe("restatesBook", () => {
  const book = [hold("AAPL", 600, 6), hold("AXP", 400, 4), hold("CB", 300, 3), hold("KO", 200, 2)];
  const tenBook = Array.from({ length: 10 }, (_, i) => hold(`C${i}`, 100 * (i + 1)));
  it("is true once the amendment repeats nine in ten of the original's positions share for share", () => {
    expect(restatesBook([...book, hold("XOM", 50)], book)).toBe(true);
    expect(restatesBook(tenBook.slice(0, 9), tenBook)).toBe(true);
  });
  it("is false below nine in ten, so a late disclosure that repeats part of the original still adds", () => {
    expect(restatesBook(tenBook.slice(0, 8), tenBook)).toBe(false);
    // Half the book: the small filer whose original would lose a position if this replaced it.
    expect(restatesBook([hold("AAPL", 600, 6), hold("AXP", 400, 4), hold("XOM", 50)], book)).toBe(false);
    expect(restatesBook([hold("XOM", 50)], book)).toBe(false);
  });
  it("counts a repeated position only at the same share count, and a put apart from the shares", () => {
    expect(restatesBook([hold("AAPL", 610, 6.1), hold("AXP", 400, 4), hold("CB", 300, 3), hold("KO", 200, 2)], book)).toBe(false);
    expect(restatesBook(book.map((h) => ({ ...h, putCall: "Put" })), book)).toBe(false);
  });
  it("is false against an empty original", () => {
    expect(restatesBook([hold("AAPL", 600, 6)], [])).toBe(false);
  });
});

describe("buildPeriodBook: a full book filed as NEW HOLDINGS (First Eagle Q2 2026)", () => {
  // Trimmed from First Eagle's 13F-HR (0001325447-26-000020, 614 rows) and its
  // 13F-HR/A (0001325447-26-000033, 616 rows), whose cover says NEW HOLDINGS but
  // whose table is the original's again plus Exxon. Each position is filed on
  // two lines, one of them for the other included manager — those two do sum.
  const row = (name: string, cusip: string, value: number, shares: number, otherManager: boolean) =>
    `<infoTable><nameOfIssuer>${name}</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${cusip}</cusip><value>${value}</value><shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><investmentDiscretion>SOLE</investmentDiscretion>${otherManager ? "<otherManager>1</otherManager>" : ""}<votingAuthority><Sole>${shares}</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable>`;
  const table = (rows: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows.join("")}</informationTable>`;
  const originalRows = [
    row("ALPHABET INC", "02079K305", 13223, 37, true),
    row("ALPHABET INC", "02079K305", 185433932, 518885, false),
    row("BECTON DICKINSON &amp; CO", "075887109", 41653917, 275252, true),
    row("BECTON DICKINSON &amp; CO", "075887109", 2049020760, 13540083, false),
  ];
  const exxonRows = [row("EXXON MOBIL CORP", "30231G102", 17933620, 131170, true), row("EXXON MOBIL CORP", "30231G102", 810188911, 5925899, false)];
  const original = filing("0001325447-26-000020", "2026-08-05", "13F-HR", "2026-06-30");
  const amendment = filing("0001325447-26-000033", "2026-08-24", "13F-HR/A", "2026-06-30");
  const cover = `<edgarSubmission><formData><coverPage><isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo></coverPage></formData></edgarSubmission>`;
  const book = buildPeriodBook([
    loaded(original, aggregateHoldings(parseInfoTable(table(originalRows)), original.filingDate)),
    loaded(amendment, aggregateHoldings(parseInfoTable(table([...originalRows, ...exxonRows])), amendment.filingDate), parseAmendmentType(cover)),
  ])!;

  it("takes the amendment as the book instead of adding it to the original", () => {
    expect(book.base.accessionNumber).toBe("0001325447-26-000033");
    expect(book.added).toEqual([]);
    expect(book.holdings.map((h) => [h.cusip, h.shares, h.value])).toEqual([
      ["075887109", 275252 + 13540083, 41653917 + 2049020760],
      ["30231G102", 131170 + 5925899, 17933620 + 810188911],
      ["02079K305", 37 + 518885, 13223 + 185433932],
    ]);
  });
  it("keeps the amendment's total, not the sum of both filings", () => {
    const total = book.holdings.reduce((s, h) => s + h.value, 0);
    expect(total).toBe(13223 + 185433932 + 41653917 + 2049020760 + 17933620 + 810188911);
  });
});

describe("groupByPeriod / find13FInPage", () => {
  it("groups filings by period, newest first, and drops a filing seen on two pages", () => {
    const a = filing("a", "2025-05-15", "13F-HR", "2025-03-31");
    const b = filing("b", "2025-08-14", "13F-HR/A", "2025-03-31");
    const c = filing("c", "2025-08-12", "13F-HR", "2025-06-30");
    const groups = groupByPeriod([a, c, b, a]);
    expect(groups.map((g) => [g.reportDate, g.filings.map((f) => f.accessionNumber)])).toEqual([
      ["2025-06-30", ["c"]],
      ["2025-03-31", ["a", "b"]],
    ]);
  });
  it("reads an older submissions page, which has the same columns as `recent`", () => {
    const page = { accessionNumber: ["x", "y", "z"], form: ["13F-HR", "4", "13F-HR/A"], reportDate: ["2014-03-31", "", "2014-03-31"], filingDate: ["2014-05-15", "2014-05-01", "2014-06-01"] };
    expect(find13FInPage(page).map((f) => f.accessionNumber)).toEqual(["z", "x"]);
    expect(find13FInPage(undefined)).toEqual([]);
  });
});
