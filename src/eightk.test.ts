import { describe, it, expect } from "vitest";
import { find8KFilings, parseCurrent8K, type Submissions } from "./eightk.js";

describe("find8KFilings", () => {
  const subs: Submissions = {
    filings: {
      recent: {
        form: ["8-K", "10-K", "8-K/A", "4"],
        accessionNumber: ["a1", "a2", "a3", "a4"],
        filingDate: ["2026-04-30", "2026-03-01", "2026-04-20", "2026-05-01"],
        reportDate: ["2026-04-30", "2025-12-31", "2026-04-18", ""],
        acceptanceDateTime: ["2026-04-30T16:30:00.000Z", "", "2026-04-20T08:00:00.000Z", ""],
        items: ["2.02,9.01", "", "5.02", ""],
        primaryDocument: ["a.htm", "b.htm", "c.htm", "d.htm"],
      },
    },
  };

  it("keeps only 8-K + 8-K/A, newest filed first, with items + dates", () => {
    const out = find8KFilings(subs);
    expect(out.map((f) => f.accessionNumber)).toEqual(["a1", "a3"]); // 04-30, 04-20
    expect(out[0]).toMatchObject({
      items: "2.02,9.01",
      reportDate: "2026-04-30",
      acceptedAt: "2026-04-30T16:30:00.000Z",
      primaryDocument: "a.htm",
    });
    expect(out[1]).toMatchObject({ accessionNumber: "a3", items: "5.02" });
  });

  it("skips a filing with no filing date and handles empty payloads", () => {
    const broken: Submissions = {
      filings: { recent: { form: ["8-K"], accessionNumber: ["a1"], filingDate: [""], items: ["8.01"] } },
    };
    expect(find8KFilings(broken)).toEqual([]);
    expect(find8KFilings({})).toEqual([]);
  });
});

describe("parseCurrent8K (EDGAR's current-filings Atom feed)", () => {
  // Trimmed from the live feed of 2026-10-02: an original 8-K with five items,
  // an amendment, a company name with an escaped ampersand, and a broken entry.
  const entry = (title: string, items: string[], updated: string, acc: string) => `<entry>
<title>${title}</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1015383/${acc.replace(/-/g, "")}/${acc}-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-10-02 &lt;b&gt;AccNo:&lt;/b&gt; ${acc} &lt;b&gt;Size:&lt;/b&gt; 697 KB
${items.map((i) => `&lt;br&gt;Item ${i}: Some Label`).join("\n")}
</summary>
<updated>${updated}</updated>
<category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
<id>urn:tag:sec.gov,2008:accession-number=${acc}</id>
</entry>`;
  const atom = `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title>
${entry("8-K - Outdoor Holding Co (0001015383) (Filer)", ["3.03", "5.02", "5.03", "5.07", "9.01"], "2026-10-02T17:29:10-04:00", "0001493152-26-045615")}
${entry("8-K/A - Procter &amp; Gamble Co (0000080424) (Filer)", ["2.02"], "2026-10-02T16:01:00-04:00", "0000080424-26-000099")}
<entry><title>not an 8-K line</title></entry>
</feed>`;

  it("reads form, company, CIK, accession, URL, acceptance time and every item code", () => {
    const [first, second] = parseCurrent8K(atom);
    expect(first).toEqual({
      form: "8-K",
      company: "Outdoor Holding Co",
      cik: "0001015383",
      accession: "0001493152-26-045615",
      url: "https://www.sec.gov/Archives/edgar/data/1015383/000149315226045615/0001493152-26-045615-index.htm",
      acceptedAt: "2026-10-02T17:29:10-04:00",
      items: ["3.03", "5.02", "5.03", "5.07", "9.01"],
    });
    // The amendment is parsed as what it is (the caller decides to skip it), and
    // the entity in the company name is decoded.
    expect(second).toMatchObject({ form: "8-K/A", company: "Procter & Gamble Co", cik: "0000080424", items: ["2.02"] });
  });

  it("skips an entry it cannot read instead of failing the page", () => {
    expect(parseCurrent8K(atom)).toHaveLength(2);
    expect(parseCurrent8K("<feed></feed>")).toEqual([]);
  });

  it("keeps the feed's offset, so the time is an instant: 17:29:10 EDT is 21:29:10 UTC", () => {
    expect(new Date(parseCurrent8K(atom)[0]!.acceptedAt).toISOString()).toBe("2026-10-02T21:29:10.000Z");
  });
});
