import { describe, it, expect } from "vitest";
import { parseForm4, find4Filings, form4DocName, type Submissions } from "./form4.js";

// Trimmed-but-real Apple Form 4 (accession 0001140361-26-025622, Newstead): an M
// option exercise (price footnoted → null), an F tax-withhold, and a derivative leg.
const AAPL_FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001780525</rptOwnerCik><rptOwnerName>Newstead Jennifer</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>true</isOfficer><officerTitle>SVP, GC and Secretary</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <aff10b5One>false</aff10b5One>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-15</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>30104</value></transactionShares>
        <transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>57784</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-15</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>14250</value></transactionShares>
        <transactionPricePerShare><value>296.42</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Restricted Stock Unit</value></securityTitle>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>30104</value></transactionShares><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;

describe("parseForm4", () => {
  const p = parseForm4(AAPL_FORM4)!;

  it("extracts issuer symbol + cik from the XML", () => {
    expect(p.symbol).toBe("AAPL");
    expect(p.issuerCik).toBe("0000320193");
    expect(p.is10b5_1).toBe(false);
  });

  it("extracts the reporting owner + relationship", () => {
    expect(p.owners).toHaveLength(1);
    expect(p.owners[0]).toMatchObject({ name: "Newstead Jennifer", cik: "0001780525", relationship: "Officer", officerTitle: "SVP, GC and Secretary" });
  });

  it("parses all transactions incl. derivative, with footnoted price → null", () => {
    expect(p.transactions).toHaveLength(3);
    expect(p.transactions[0]).toMatchObject({
      code: "M", acquiredDisposed: "A", shares: 30104, price: null, securityTitle: "Common Stock",
      isDerivative: false, sharesOwnedAfter: 57784, directIndirect: "D", transactionDate: "2026-06-15",
    });
    expect(p.transactions[1]).toMatchObject({ code: "F", price: 296.42, acquiredDisposed: "D", isDerivative: false });
    expect(p.transactions[2]).toMatchObject({ code: "M", isDerivative: true, securityTitle: "Restricted Stock Unit" });
  });

  it("reads a 10b5-1 plan flag when set", () => {
    expect(parseForm4(AAPL_FORM4.replace("<aff10b5One>false", "<aff10b5One>1"))!.is10b5_1).toBe(true);
  });

  it("normalizes a filer's TZ-suffixed transactionDate to a bare date", () => {
    // Some filers (e.g. AREC) write "2025-11-04-05:00" — the date column rejects it.
    const xml = AAPL_FORM4.replaceAll("<transactionDate><value>2026-06-15</value></transactionDate>", "<transactionDate><value>2026-06-15-05:00</value></transactionDate>");
    expect(parseForm4(xml)!.transactions[0]!.transactionDate).toBe("2026-06-15");
  });

  it("skips a row with no transaction code (a holding line, not a transaction)", () => {
    // Drop the F row's <transactionCoding> entirely: it must vanish, not come back
    // as code:null (the column is NOT NULL).
    const xml = AAPL_FORM4.replace("<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>F</transactionCode></transactionCoding>", "");
    expect(parseForm4(xml)!.transactions.map((t) => [t.code, t.isDerivative])).toEqual([
      ["M", false],
      ["M", true],
    ]);
  });

  it("reads comma-formatted share counts and prices", () => {
    const xml = AAPL_FORM4.replace("<transactionShares><value>14250</value>", "<transactionShares><value>14,250</value>").replace(
      "<value>296.42</value>",
      "<value>1,296.42</value>",
    );
    expect(parseForm4(xml)!.transactions[1]).toMatchObject({ code: "F", shares: 14250, price: 1296.42 });
  });

  it("builds a multi-relationship label", () => {
    const xml = AAPL_FORM4.replace("<isOfficer>true</isOfficer>", "<isDirector>true</isDirector><isOfficer>true</isOfficer>");
    expect(parseForm4(xml)!.owners[0]!.relationship).toBe("Director, Officer");
  });

  it("returns null for non-ownership XML", () => {
    expect(parseForm4("<foo/>")).toBeNull();
  });
});

describe("form4DocName", () => {
  it("strips the xsl-styled prefix to get the raw parseable XML name", () => {
    // submissions points at the HTML view; the raw ownershipDocument XML is the same name minus the prefix.
    expect(form4DocName("xslF345X06/wk-form4_1781816696.xml")).toBe("wk-form4_1781816696.xml");
    expect(form4DocName("xslF345X05/doc4.xml")).toBe("doc4.xml");
  });
  it("passes through a bare doc name and falls back when absent", () => {
    expect(form4DocName("wf-form4.xml")).toBe("wf-form4.xml");
    expect(form4DocName("")).toBe("form4.xml");
    expect(form4DocName(null)).toBe("form4.xml");
  });
});

describe("find4Filings", () => {
  const subs: Submissions = {
    filings: {
      recent: {
        form: ["4", "8-K", "4/A", "3"],
        accessionNumber: ["a1", "a2", "a3", "a4"],
        filingDate: ["2026-06-15", "2026-06-10", "2026-06-17", "2026-06-01"],
        acceptanceDateTime: ["2026-06-15T18:30:00.000Z", "", "2026-06-17T20:00:00.000Z", ""],
        primaryDocument: ["form4.xml", "x.htm", "form4.xml", "form3.xml"],
      },
    },
  };
  it("keeps only form 4 / 4/A, newest filed first, with acceptance time", () => {
    const out = find4Filings(subs);
    expect(out.map((f) => f.accessionNumber)).toEqual(["a3", "a1"]); // 06-17, 06-15
    expect(out[0]).toMatchObject({ acceptedAt: "2026-06-17T20:00:00.000Z" });
  });
  it("handles empty payloads", () => {
    expect(find4Filings({})).toEqual([]);
  });
});
