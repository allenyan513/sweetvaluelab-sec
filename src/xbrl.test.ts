import { describe, expect, it } from "vitest";
import { findFact, membersOf, multiMemberContexts, parseXbrlInstance, pickInstanceDoc, XbrlAmbiguousFact } from "./xbrl.js";

/** A cut-down instance in the shape Tesla's 10-Q uses (default namespace, explicit members). */
const XML = `<?xml version="1.0" encoding="utf-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:tsla="http://www.tesla.com/20260630" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
  <link:schemaRef xmlns:link="http://www.xbrl.org/2003/linkbase" xlink:href="x.xsd"/>
  <context id="c-1"><entity><identifier scheme="http://www.sec.gov/CIK">0001318605</identifier></entity><period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context>
  <context id="c-2"><entity><identifier scheme="http://www.sec.gov/CIK">0001318605</identifier><segment><xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">tsla:AutomotiveRevenuesMember</xbrldi:explicitMember></segment></entity><period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context>
  <context id="c-3"><entity><identifier scheme="http://www.sec.gov/CIK">0001318605</identifier><segment><xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">tsla:EnergyGenerationAndStorageMember</xbrldi:explicitMember></segment></entity><period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context>
  <context id="c-4"><entity><identifier scheme="http://www.sec.gov/CIK">0001318605</identifier></entity><period><instant>2026-07-16</instant></period></context>
  <context id="c-5"><entity><identifier scheme="http://www.sec.gov/CIK">0001318605</identifier><segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">tsla:AutomotiveSegmentMember</xbrldi:explicitMember><xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">tsla:AutomotiveSalesMember</xbrldi:explicitMember></segment></entity><period><startDate>2026-04-01</startDate><endDate>2026-06-30</endDate></period></context>
  <us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="c-1" decimals="-6" id="f1" unitRef="usd">28236000000</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax>
  <us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="c-2" decimals="-6" id="f2" unitRef="usd">20516000000</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax>
  <us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="c-3" decimals="-6" id="f3" unitRef="usd">3139000000</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax>
  <us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="c-5" decimals="-6" id="f4" unitRef="usd">20006000000</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax>
  <dei:EntityCommonStockSharesOutstanding contextRef="c-4" decimals="INF" id="f5" unitRef="shares">3949547394</dei:EntityCommonStockSharesOutstanding>
  <dei:DocumentType contextRef="c-1" id="f6">10-Q</dei:DocumentType>
  <tsla:RestructuringAndOtherExpenses contextRef="c-1" decimals="-6" id="f7" unitRef="usd">0</tsla:RestructuringAndOtherExpenses>
</xbrl>`;

describe("parseXbrlInstance", () => {
  const inst = parseXbrlInstance(XML);

  it("keeps numeric facts with their contexts and drops text facts", () => {
    expect(inst.facts.map((f) => f.tag)).not.toContain("DocumentType");
    expect(inst.facts.find((f) => f.tag === "RestructuringAndOtherExpenses")?.ns).toBe("tsla");
    expect(inst.facts).toHaveLength(6);
  });

  it("reads the cover share count", () => {
    expect(inst.coverShares).toEqual({ instant: "2026-07-16", value: 3949547394 });
  });

  it("takes the undimensioned cover share count over a per-class one filed after it", () => {
    // Multi-class filers (GOOGL, BRK) tag EntityCommonStockSharesOutstanding per
    // class under a ClassOfStockAxis member. A class count is not the total.
    const classCtx = `<context id="c-6"><entity><identifier scheme="http://www.sec.gov/CIK">0001318605</identifier><segment><xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClassBMember</xbrldi:explicitMember></segment></entity><period><instant>2026-07-16</instant></period></context>`;
    const classFact = `<dei:EntityCommonStockSharesOutstanding contextRef="c-6" decimals="INF" id="f8" unitRef="shares">860000000</dei:EntityCommonStockSharesOutstanding>`;
    const withClass = XML.replace("</xbrl>", `${classCtx}\n${classFact}\n</xbrl>`);
    expect(parseXbrlInstance(withClass).coverShares).toEqual({ instant: "2026-07-16", value: 3949547394 });
    // With only the per-class fact left, there is no cover total to report.
    const onlyClass = withClass.replace(/<dei:EntityCommonStockSharesOutstanding contextRef="c-4"[^\n]*\n/, "");
    expect(parseXbrlInstance(onlyClass).coverShares).toBeNull();
  });

  it("strips the namespace prefix from members and keeps multi-member contexts apart", () => {
    const one = findFact(inst, { tag: "RevenueFromContractWithCustomerExcludingAssessedTax", members: ["AutomotiveRevenuesMember"], start: "2026-04-01", end: "2026-06-30" });
    expect(one?.value).toBe(20516000000);
    const two = findFact(inst, { tag: "RevenueFromContractWithCustomerExcludingAssessedTax", members: ["AutomotiveSalesMember", "AutomotiveSegmentMember"] });
    expect(two?.value).toBe(20006000000);
    expect(findFact(inst, { tag: "RevenueFromContractWithCustomerExcludingAssessedTax" })?.value).toBe(28236000000);
  });

  it("lists the single-member breakdown of a concept over a period", () => {
    expect(membersOf(inst, "RevenueFromContractWithCustomerExcludingAssessedTax", "2026-04-01", "2026-06-30")).toEqual([
      { member: "AutomotiveRevenuesMember", value: 20516000000 },
      { member: "EnergyGenerationAndStorageMember", value: 3139000000 },
    ]);
  });

  it("lists the multi-member contexts of a concept over a period, once each", () => {
    expect(multiMemberContexts(inst, "RevenueFromContractWithCustomerExcludingAssessedTax", "2026-04-01", "2026-06-30")).toEqual([{ members: ["AutomotiveSegmentMember", "AutomotiveSalesMember"], value: 20006000000 }]);
  });

  it("tolerates a fact repeated with the same value and refuses two different values for one query", () => {
    const repeated = XML.replace("</xbrl>", `<us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="c-1" decimals="-6" id="f8" unitRef="usd">28236000000</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax></xbrl>`);
    expect(findFact(parseXbrlInstance(repeated), { tag: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2026-04-01", end: "2026-06-30" })?.value).toBe(28236000000);
    const conflicting = XML.replace("</xbrl>", `<us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="c-1" decimals="-6" id="f8" unitRef="usd">1</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax></xbrl>`);
    expect(() => findFact(parseXbrlInstance(conflicting), { tag: "RevenueFromContractWithCustomerExcludingAssessedTax", start: "2026-04-01", end: "2026-06-30" })).toThrow(XbrlAmbiguousFact);
  });

  it("also parses the xbrli-prefixed form", () => {
    const prefixed = XML.replace(/<(\/?)(context|entity|identifier|segment|period|startDate|endDate|instant)\b/g, "<$1xbrli:$2");
    expect(parseXbrlInstance(prefixed).facts).toHaveLength(6);
  });
});

describe("pickInstanceDoc", () => {
  it("prefers the extracted inline-XBRL instance", () => {
    expect(pickInstanceDoc({ directory: { item: [{ name: "tsla-20260630.htm" }, { name: "tsla-20260630_cal.xml" }, { name: "tsla-20260630_htm.xml" }, { name: "FilingSummary.xml" }] } })).toBe("tsla-20260630_htm.xml");
    expect(pickInstanceDoc({ directory: { item: [{ name: "a.htm" }] } })).toBeNull();
  });
});
