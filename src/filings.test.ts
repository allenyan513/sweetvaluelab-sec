import { describe, it, expect } from "vitest";
import { findCompanyFilings, parseExhibits, releaseDocument } from "./filings.js";
import type { Submissions } from "./thirteenf.js";

/** A submissions `recent` block from rows, the feed's column-per-field shape. */
const subs = (rows: { form: string; date: string; accn?: string; report?: string; doc?: string }[]): Submissions => ({
  filings: {
    recent: {
      form: rows.map((r) => r.form),
      accessionNumber: rows.map((r, i) => r.accn ?? `0000000000-26-${String(i).padStart(6, "0")}`),
      filingDate: rows.map((r) => r.date),
      reportDate: rows.map((r) => r.report ?? ""),
      acceptanceDateTime: rows.map((r) => `${r.date}T16:20:00.000Z`),
      primaryDocument: rows.map((r) => r.doc ?? "doc.htm"),
    },
  },
});

describe("findCompanyFilings", () => {
  // The caller's allowlist; here everything but a Form 4 and a bank's structured note.
  const listed = (form: string): boolean => form !== "4" && form !== "424B2";

  it("keeps the listed forms inside the window, newest first, and leaves 8-Ks to their own parser", () => {
    const out = findCompanyFilings(
      subs([
        { form: "4", date: "2026-09-20" },
        { form: "8-K", date: "2026-08-26" },
        { form: "10-Q", date: "2026-08-26", report: "2026-07-26", doc: "nvda-20260726.htm" },
        { form: "424B2", date: "2026-07-01" },
        { form: "DEF 14A", date: "2026-05-12", report: "2026-06-24" },
        { form: "8-K/A", date: "2026-03-01" },
        { form: "10-K", date: "2026-02-25", report: "2026-01-25" },
        { form: "10-K", date: "2023-02-24", report: "2023-01-29" }, // outside the window
      ]),
      "2023-10-05",
      listed,
    );
    expect(out.map((f) => [f.form, f.filedDate, f.reportDate])).toEqual([
      ["10-Q", "2026-08-26", "2026-07-26"],
      ["DEF 14A", "2026-05-12", "2026-06-24"],
      ["10-K", "2026-02-25", "2026-01-25"],
    ]);
    expect(out[0]!.primaryDocument).toBe("nvda-20260726.htm");
  });

  it("keeps a filing made on the window's first day, and reads a missing report date as null", () => {
    const out = findCompanyFilings(subs([{ form: "S-8", date: "2023-10-05" }]), "2023-10-05", listed);
    expect(out).toHaveLength(1);
    expect(out[0]!.reportDate).toBeNull();
  });

  it("skips a row with no filing date or accession, and an empty payload", () => {
    const s = subs([{ form: "10-K", date: "" }]);
    expect(findCompanyFilings(s, "2020-01-01", listed)).toEqual([]);
    expect(findCompanyFilings({}, "2020-01-01", listed)).toEqual([]);
  });
});

// The shape of EDGAR's -index-headers.html: the SGML headers, escaped, inside <pre>.
const HEADERS = `<html><body><pre>
&lt;SEC-HEADER&gt;0001045810-26-000073.hdr.sgml : 20260826
&lt;ACCEPTANCE-DATETIME&gt;20260826162034
ACCESSION NUMBER:		0001045810-26-000073
CONFORMED SUBMISSION TYPE:	8-K
&lt;/SEC-HEADER&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;8-K
&lt;SEQUENCE&gt;1
&lt;FILENAME&gt;nvda-20260826.htm
&lt;DESCRIPTION&gt;8-K
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-99.1
&lt;SEQUENCE&gt;2
&lt;FILENAME&gt;q2fy27pr.htm
&lt;DESCRIPTION&gt;EX-99.1
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-99.2
&lt;SEQUENCE&gt;3
&lt;FILENAME&gt;q2fy27cfocommentary.htm
&lt;/DOCUMENT&gt;
</pre></body></html>`;

describe("parseExhibits", () => {
  it("pairs each document's type with its file name, across the sequence line between them", () => {
    expect(parseExhibits(HEADERS)).toEqual([
      { type: "8-K", filename: "nvda-20260826.htm" },
      { type: "EX-99.1", filename: "q2fy27pr.htm" },
      { type: "EX-99.2", filename: "q2fy27cfocommentary.htm" },
    ]);
  });

  it("skips a document with no file name rather than pairing it with the next one's", () => {
    const html = "&lt;TYPE&gt;EX-99.1\n&lt;SEQUENCE&gt;2\n&lt;/DOCUMENT&gt;\n&lt;DOCUMENT&gt;\n&lt;TYPE&gt;EX-10.1\n&lt;FILENAME&gt;agreement.htm";
    expect(parseExhibits(html)).toEqual([{ type: "EX-10.1", filename: "agreement.htm" }]);
    expect(releaseDocument(parseExhibits(html))).toBeNull(); // not the agreement passed off as the release
  });

  it("reads nothing from a page that is not a header listing", () => {
    expect(parseExhibits("<html>Your request originates from an undeclared automated tool</html>")).toEqual([]);
  });
});

describe("releaseDocument", () => {
  it("is EX-99.1 wherever it sits", () => {
    expect(releaseDocument(parseExhibits(HEADERS))).toBe("q2fy27pr.htm");
    expect(releaseDocument([{ type: "EX-99.2", filename: "b.htm" }, { type: "EX-99.1", filename: "a.htm" }])).toBe("a.htm");
  });

  it("falls back to the first EX-99 under another number, and to null without one", () => {
    expect(releaseDocument([{ type: "8-K", filename: "x.htm" }, { type: "EX-99", filename: "pr.htm" }])).toBe("pr.htm");
    expect(releaseDocument([{ type: "8-K", filename: "x.htm" }, { type: "EX-10.1", filename: "agreement.htm" }, { type: "EX-990", filename: "no.htm" }])).toBeNull();
  });
});
