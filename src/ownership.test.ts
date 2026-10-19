import { describe, it, expect } from "vitest";
import {
  classifyForm,
  findOwnershipFilings,
  parseOwnershipHeader,
  parseCoverPage,
  coverDocPath,
  type Submissions,
} from "./ownership.js";

// Real Icahn / Southwest Gas SC 13D/A header (accession 0001539497-24-002482),
// trimmed to the load-bearing tags. Verified against live EDGAR.
const ICAHN_SWX_HEADER = `<SEC-HEADER>
<ACCESSION-NUMBER>0001539497-24-002482
<TYPE>SC 13D/A
<FILING-DATE>20241120
<GROUP-MEMBERS>BECKTON CORP.
<GROUP-MEMBERS>ICAHN CAPITAL LP
<GROUP-MEMBERS>ICAHN ENTERPRISES HOLDINGS L.P.
<SUBJECT-COMPANY>
<COMPANY-DATA>
<CONFORMED-NAME>Southwest Gas Holdings, Inc.
<CIK>0001692115
</COMPANY-DATA>
<FORM-TYPE>SC 13D/A
</SUBJECT-COMPANY>
<FILED-BY>
<COMPANY-DATA>
<CONFORMED-NAME>ICAHN CARL C
<CIK>0000921669
</COMPANY-DATA>
<FORM-TYPE>SC 13D/A
<FORMER-CONFORMED-NAME>ICAHN CARL C ET AL
</FILED-BY>
</SEC-HEADER>`;

// Real Icahn / JetBlue SCHEDULE 13D/A (accession 0001539497-26-002326, filed
// 2026-08-20) — the structured form EDGAR moved to on 2024-12-18. Its header is
// the same pseudo-SGML as the old one; trimmed to the load-bearing tags.
const ICAHN_JBLU_HEADER = `<SEC-HEADER>0001539497-26-002326.hdr.sgml : 20260820
<ACCEPTANCE-DATETIME>20260820213005
<ACCESSION-NUMBER>0001539497-26-002326
<TYPE>SCHEDULE 13D/A
<FILING-DATE>20260820
<SUBJECT-COMPANY>
<COMPANY-DATA>
<CONFORMED-NAME>JETBLUE AIRWAYS CORP
<CIK>0001158463
<ASSIGNED-SIC>4512
</COMPANY-DATA>
<FILING-VALUES>
<FORM-TYPE>SCHEDULE 13D/A
</FILING-VALUES>
</SUBJECT-COMPANY>
<FILED-BY>
<COMPANY-DATA>
<CONFORMED-NAME>ICAHN CARL C
<CIK>0000921669
</COMPANY-DATA>
<FILING-VALUES>
<FORM-TYPE>SCHEDULE 13D/A
</FILING-VALUES>
<FORMER-COMPANY>
<FORMER-CONFORMED-NAME>ICAHN CARL C ET AL
<DATE-CHANGED>19950612
</FORMER-COMPANY>
</FILED-BY>
</SEC-HEADER>`;

// The same filing's raw primary_doc.xml, trimmed to three of its eleven reporting
// persons in filed order: the master fund (0 shares — it had sold out), Icahn
// Partners LP (the group's 12,528,346 shares = 3.32%), and 560 State Street
// (100 shares = 0.00003%). Item 5's percent is prose and is not read.
const ICAHN_JBLU_13D_XML = `<?xml version="1.0" encoding="UTF-8"?><edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13D" xmlns:com="http://www.sec.gov/edgar/common">
  <schemaVersion>X0202</schemaVersion>
  <headerData><submissionType>SCHEDULE 13D/A</submissionType></headerData>
  <formData>
    <coverPageHeader>
      <amendmentNo>6</amendmentNo>
      <issuerInfo>
        <issuerCIK>0001158463</issuerCIK>
        <issuerCusips>
          <issuerCusipNumber>477143101</issuerCusipNumber>
        </issuerCusips>
        <issuerName>JETBLUE AIRWAYS CORP</issuerName>
        <address><com:city>LONG ISLAND CITY</com:city></address>
      </issuerInfo>
    </coverPageHeader>
    <reportingPersons>
      <reportingPersonInfo>
        <reportingPersonName>Icahn Partners Master Fund LP</reportingPersonName>
        <aggregateAmountOwned>0.00</aggregateAmountOwned>
        <percentOfClass>0.00</percentOfClass>
      </reportingPersonInfo>
      <reportingPersonInfo>
        <reportingPersonName>Icahn Partners LP</reportingPersonName>
        <soleVotingPower>12528246.00</soleVotingPower>
        <aggregateAmountOwned>12528346.00</aggregateAmountOwned>
        <percentOfClass>3.32</percentOfClass>
      </reportingPersonInfo>
      <reportingPersonInfo>
        <reportingPersonName>560 State Street LLC</reportingPersonName>
        <aggregateAmountOwned>100.00</aggregateAmountOwned>
        <percentOfClass>0.00003</percentOfClass>
      </reportingPersonInfo>
    </reportingPersons>
    <items1To7>
      <item5>
        <percentageOfClassSecurities>As of August 20, 2026, the Reporting Persons may be deemed to beneficially own, in the aggregate, 12,528,346 shares of Common Stock, representing approximately 3.32% of the Issuer's outstanding shares</percentageOfClassSecurities>
      </item5>
    </items1To7>
  </formData>
</edgarSubmission>`;

// Real Icahn / Centuri SCHEDULE 13G/A primary_doc.xml (accession
// 0001539497-25-002292, filed 2025-09-05), trimmed. The 13G schema names the same
// facts differently, and item 4 reuses the tag `classPercent` for prose — a decoy.
const ICAHN_CTRI_13G_XML = `<?xml version="1.0" encoding="UTF-8"?><edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13g" xmlns:com="http://www.sec.gov/edgar/common">
  <headerData><submissionType>SCHEDULE 13G/A</submissionType></headerData>
  <formData>
    <coverPageHeader>
      <issuerInfo>
        <issuerCik>0001981599</issuerCik>
        <issuerName>Centuri Holdings, Inc.</issuerName>
        <issuerCusip>155923105</issuerCusip>
      </issuerInfo>
    </coverPageHeader>
    <coverPageHeaderReportingPersonDetails>
      <reportingPersonName>Icahn Enterprises L.P.</reportingPersonName>
      <reportingPersonBeneficiallyOwnedNumberOfShares>
        <soleVotingPower>10847672.00</soleVotingPower>
      </reportingPersonBeneficiallyOwnedNumberOfShares>
      <reportingPersonBeneficiallyOwnedAggregateNumberOfShares>10847672.00</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
      <classPercent>12.24</classPercent>
    </coverPageHeaderReportingPersonDetails>
    <items>
      <item4>
        <amountBeneficiallyOwned>The Reporting Persons have sole voting and sole dispositive power with regard to 7,977,377 Shares.</amountBeneficiallyOwned>
        <classPercent>As of September 5, 2025, the Reporting Persons may be deemed to beneficially own in the aggregate  10,847,672 Shares, representing approximately 12.24% of the Issuer's outstanding Shares</classPercent>
      </item4>
    </items>
  </formData>
</edgarSubmission>`;

describe("classifyForm", () => {
  it("derives schedule + amendment flag from the four pre-2025 form strings", () => {
    expect(classifyForm("SC 13D")).toEqual({ schedule: "13D", isAmendment: false });
    expect(classifyForm("SC 13D/A")).toEqual({ schedule: "13D", isAmendment: true });
    expect(classifyForm("SC 13G")).toEqual({ schedule: "13G", isAmendment: false });
    expect(classifyForm("SC 13G/A")).toEqual({ schedule: "13G", isAmendment: true });
  });

  it("derives the same from the SCHEDULE 13D/G names EDGAR uses since 2024-12-18", () => {
    expect(classifyForm("SCHEDULE 13D")).toEqual({ schedule: "13D", isAmendment: false });
    expect(classifyForm("SCHEDULE 13D/A")).toEqual({ schedule: "13D", isAmendment: true });
    expect(classifyForm("SCHEDULE 13G")).toEqual({ schedule: "13G", isAmendment: false });
    expect(classifyForm("SCHEDULE 13G/A")).toEqual({ schedule: "13G", isAmendment: true });
  });
});

describe("findOwnershipFilings", () => {
  const subs: Submissions = {
    filings: {
      recent: {
        form: ["10-K", "SC 13D", "SC 13G/A", "SC 13D/A", "8-K"],
        accessionNumber: ["a0", "a1", "a2", "a3", "a4"],
        filingDate: ["2024-01-01", "2024-03-01", "2024-02-01", "2024-04-01", "2024-05-01"],
        reportDate: ["", "", "", "", ""], // 13D/13G have no period-of-report
        primaryDocument: ["x.htm", "d1.htm", "d2.htm", "d3.htm", "x.htm"],
      },
    },
  };

  it("keeps only the four ownership forms, newest filed first", () => {
    const out = findOwnershipFilings(subs);
    expect(out.map((f) => f.accessionNumber)).toEqual(["a3", "a1", "a2"]); // 04-01, 03-01, 02-01
    expect(out.map((f) => f.form)).toEqual(["SC 13D/A", "SC 13D", "SC 13G/A"]);
  });

  it("derives schedule/isAmendment and carries the cover doc name", () => {
    const byAcc = Object.fromEntries(findOwnershipFilings(subs).map((f) => [f.accessionNumber, f]));
    expect(byAcc.a1).toMatchObject({ schedule: "13D", isAmendment: false, primaryDocument: "d1.htm" });
    expect(byAcc.a2).toMatchObject({ schedule: "13G", isAmendment: true });
    expect(byAcc.a3).toMatchObject({ schedule: "13D", isAmendment: true });
  });

  it("keeps both form names in one filer's history (Icahn's submissions switch in 2025)", () => {
    // Shape of Icahn's (CIK 921669) real submissions: SCHEDULE 13D/A and a
    // SCHEDULE 13G/A in 2025-26, an SC 13D/A in 2024, and a 13F-HR in between.
    const mixed: Submissions = {
      filings: {
        recent: {
          form: ["SCHEDULE 13D/A", "13F-HR", "SCHEDULE 13G/A", "SCHEDULE 13D", "SC 13D/A", "SC 14D9"],
          accessionNumber: ["0001539497-26-002326", "f1", "0001539497-25-002292", "n1", "0001539497-24-002482", "x"],
          filingDate: ["2026-08-20", "2026-08-14", "2025-09-05", "2025-11-05", "2024-11-20", "2025-01-01"],
          primaryDocument: ["xslSCHEDULE_13D_X02/primary_doc.xml", "", "xslSCHEDULE_13G_X01/primary_doc.xml", "", "d.htm", ""],
        },
      },
    };
    expect(findOwnershipFilings(mixed).map((f) => [f.form, f.schedule, f.isAmendment, f.filedDate])).toEqual([
      ["SCHEDULE 13D/A", "13D", true, "2026-08-20"],
      ["SCHEDULE 13D", "13D", false, "2025-11-05"],
      ["SCHEDULE 13G/A", "13G", true, "2025-09-05"],
      ["SC 13D/A", "13D", true, "2024-11-20"],
    ]);
  });

  it("skips a filing with an empty filingDate (would break known_at)", () => {
    const broken: Submissions = {
      filings: { recent: { form: ["SC 13D"], accessionNumber: ["a1"], filingDate: [""], primaryDocument: ["d.htm"] } },
    };
    expect(findOwnershipFilings(broken)).toEqual([]);
  });

  it("returns [] for a payload with no recent filings", () => {
    expect(findOwnershipFilings({})).toEqual([]);
  });
});

describe("parseOwnershipHeader", () => {
  it("extracts subject company + filer from a real Icahn 13D/A header", () => {
    const h = parseOwnershipHeader(ICAHN_SWX_HEADER);
    expect(h).not.toBeNull();
    expect(h!.subjectCik).toBe("0001692115");
    expect(h!.subjectName).toBe("Southwest Gas Holdings, Inc.");
    expect(h!.filerName).toBe("ICAHN CARL C"); // NOT the <FORMER-CONFORMED-NAME>
    expect(h!.groupMembers).toContain("ICAHN CAPITAL LP");
    expect(h!.groupMembers.length).toBe(3);
  });

  it("reads a SCHEDULE 13D/A header the same way (the header format did not change)", () => {
    expect(parseOwnershipHeader(ICAHN_JBLU_HEADER)).toEqual({
      subjectCik: "0001158463",
      subjectName: "JETBLUE AIRWAYS CORP",
      filerName: "ICAHN CARL C",
      groupMembers: [],
    });
  });

  it("takes <CONFORMED-NAME>, never a <FORMER-CONFORMED-NAME> that comes before it", () => {
    // The real headers put FORMER-COMPANY after COMPANY-DATA, so "first match wins"
    // alone would hide an unanchored tag match. Here the former name comes first.
    const sgml = `<SUBJECT-COMPANY>
<FORMER-COMPANY>
<FORMER-CONFORMED-NAME>OLD SUBJECT NAME
</FORMER-COMPANY>
<COMPANY-DATA>
<CONFORMED-NAME>New Subject Inc
<CIK>0001158463
</COMPANY-DATA>
</SUBJECT-COMPANY>
<FILED-BY>
<FORMER-COMPANY>
<FORMER-CONFORMED-NAME>ICAHN CARL C ET AL
</FORMER-COMPANY>
<COMPANY-DATA>
<CONFORMED-NAME>ICAHN CARL C
</COMPANY-DATA>
</FILED-BY>`;
    const h = parseOwnershipHeader(sgml)!;
    expect(h.subjectName).toBe("New Subject Inc");
    expect(h.filerName).toBe("ICAHN CARL C");
  });

  it("keeps the first CIK in the subject block when a second one follows", () => {
    const sgml = `<SUBJECT-COMPANY>
<COMPANY-DATA>
<CONFORMED-NAME>Southwest Gas Holdings, Inc.
<CIK>0001692115
</COMPANY-DATA>
<COMPANY-DATA>
<CONFORMED-NAME>Southwest Gas Corp
<CIK>0000092416
</COMPANY-DATA>
</SUBJECT-COMPANY>`;
    expect(parseOwnershipHeader(sgml)).toMatchObject({ subjectCik: "0001692115", subjectName: "Southwest Gas Holdings, Inc." });
  });

  it("pads a short subject CIK to 10 digits", () => {
    const sgml = `<SUBJECT-COMPANY>\n<COMPANY-DATA>\n<CONFORMED-NAME>Foo Inc\n<CIK>320193\n</COMPANY-DATA>\n</SUBJECT-COMPANY>`;
    expect(parseOwnershipHeader(sgml)!.subjectCik).toBe("0000320193");
  });

  it("returns null when there is no subject company", () => {
    expect(parseOwnershipHeader("<FILED-BY>\n<CONFORMED-NAME>Someone\n</FILED-BY>")).toBeNull();
  });
});

describe("parseCoverPage (best-effort, nullable)", () => {
  it("parses cusip, percent, and shares from a clean cover", () => {
    const html = `<p>CUSIP No. 844895102</p>
      <td>AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON</td><td>3,500,000</td>
      <td>PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (11)</td><td>4.9%</td>`;
    expect(parseCoverPage(html)).toEqual({ cusip: "844895102", pctOfClass: 4.9, sharesOwned: 3500000 });
  });

  it("still gets the CUSIP when the percent is detached from its label (null contract)", () => {
    // Real-world failure mode: the % sits in a far table cell with no nearby '%'.
    const html = `<p>CUSIP No. 844895102</p><table><tr><td>Percent of class represented by amount in row</td></tr>
      ${"<td>x</td>".repeat(40)}<tr><td>4.9</td></tr></table>`;
    const out = parseCoverPage(html);
    expect(out.cusip).toBe("844895102");
    expect(out.pctOfClass).toBeNull();
  });

  it("rejects a percent above 100 (a mis-read, not a stake)", () => {
    const html = `<p>CUSIP No. 844895102</p><td>PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (11)</td><td>150%</td>`;
    expect(parseCoverPage(html).pctOfClass).toBeNull();
    // …while exactly 100 is still a legal percent.
    expect(parseCoverPage(html.replace("150%", "100%")).pctOfClass).toBe(100);
  });

  it("returns all-null on an unparseable blob, never throws", () => {
    expect(parseCoverPage("<html>nothing useful here</html>")).toEqual({ cusip: null, pctOfClass: null, sharesOwned: null });
  });

  it("only scans the first 250KB (perf guard) — content past the cap is ignored", () => {
    const html = `<p>CUSIP No. 844895102</p>${"x".repeat(260_000)}<td>PERCENT OF CLASS REPRESENTED</td><td>99%</td>`;
    const out = parseCoverPage(html);
    expect(out.cusip).toBe("844895102"); // at the start → parsed
    expect(out.pctOfClass).toBeNull(); // beyond 250KB → not scanned
  });
});

describe("parseCoverPage — structured SCHEDULE 13D/G XML (2024-12-18 on)", () => {
  it("reads a real 13D/A: the cusip, and the largest reporting person's shares with its own percent", () => {
    // Filed order is 0 / 12,528,346 / 100 shares: first-wins would give 0, last-wins
    // 100, so only "largest aggregate" gives the group's 12,528,346 = 3.32%.
    expect(parseCoverPage(ICAHN_JBLU_13D_XML)).toEqual({ cusip: "477143101", pctOfClass: 3.32, sharesOwned: 12528346 });
  });

  it("reads a real 13G/A under the 13G schema's tag names, ignoring item 4's prose classPercent", () => {
    expect(parseCoverPage(ICAHN_CTRI_13G_XML)).toEqual({ cusip: "155923105", pctOfClass: 12.24, sharesOwned: 10847672 });
  });

  it("rejects a percent above 100 but keeps the shares", () => {
    const xml = ICAHN_JBLU_13D_XML.replace("<percentOfClass>3.32<", "<percentOfClass>332<");
    expect(parseCoverPage(xml)).toMatchObject({ pctOfClass: null, sharesOwned: 12528346 });
  });

  it("drops a malformed cusip rather than storing it", () => {
    const xml = ICAHN_JBLU_13D_XML.replace("<issuerCusipNumber>477143101<", "<issuerCusipNumber>N/A<");
    expect(parseCoverPage(xml).cusip).toBeNull();
  });

  it("treats an empty aggregate tag as not disclosed, not as 0 shares", () => {
    const xml = ICAHN_CTRI_13G_XML.replace(
      "<reportingPersonBeneficiallyOwnedAggregateNumberOfShares>10847672.00</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>",
      "<reportingPersonBeneficiallyOwnedAggregateNumberOfShares></reportingPersonBeneficiallyOwnedAggregateNumberOfShares>",
    );
    expect(parseCoverPage(xml)).toEqual({ cusip: "155923105", pctOfClass: null, sharesOwned: null });
  });

  it("returns all-null for a structured document with no reporting persons, never throws", () => {
    const xml = `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13D"><formData/></edgarSubmission>`;
    expect(parseCoverPage(xml)).toEqual({ cusip: null, pctOfClass: null, sharesOwned: null });
  });
});

describe("coverDocPath", () => {
  it("fetches the raw XML behind a structured filing's XSL-rendered view", () => {
    // submissions' primaryDocument for 0001539497-26-002326 is the rendered HTML view.
    expect(coverDocPath("xslSCHEDULE_13D_X02/primary_doc.xml")).toBe("primary_doc.xml");
    expect(coverDocPath("xslSCHEDULE_13G_X01/primary_doc.xml")).toBe("primary_doc.xml");
  });

  it("leaves a pre-2025 HTML cover name untouched", () => {
    expect(coverDocPath("d879371dsc13da.htm")).toBe("d879371dsc13da.htm");
  });
});
