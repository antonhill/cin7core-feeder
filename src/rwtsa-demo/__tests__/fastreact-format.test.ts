import { describe, expect, it } from "vitest";
import { compliantHeader, fileName, contractFor, CONTRACT, FILE_IDS } from "@/rwtsa-demo/fastreact/contract";
import { checkTextValue, formatDate, parseIsoDate, renderTable } from "@/rwtsa-demo/fastreact/format";

describe("vendor field contract", () => {
  it("names the five files with the documented extensions", () => {
    expect(FILE_IDS).toEqual(["CUSTOMER", "PRODTYPE", "PRODUCTS", "ORDERS", "UPDATE"]);
    expect(fileName("CUSTOMER", "tab")).toBe("CUSTOMER.txt");
    expect(fileName("ORDERS", "csv")).toBe("ORDERS.csv");
    expect(fileName("UPDATE", "tab")).toBe("UPDATE.txt");
  });

  it("marks exactly the vendor's bold (essential) fields", () => {
    const essential = (file: (typeof FILE_IDS)[number]) => contractFor(file).filter((c) => c.essential).map((c) => c.code);
    expect(essential("CUSTOMER")).toEqual(["C.CODE"]);
    expect(essential("PRODTYPE")).toEqual(["T.CODE"]);
    expect(essential("PRODUCTS")).toEqual(["P.CODE", "P.TYPE", "P^WC:n"]);
    expect(essential("ORDERS")).toEqual(["O.CODE", "O.PROD", "O.CUST", "O^DD:n", "O^DQ:n"]);
    expect(essential("UPDATE")).toEqual(["U.ORDER", "U.DATE", "U.QTY"]);
  });

  it("uses vendor codes, never the friendly headings of the worked examples", () => {
    for (const c of CONTRACT) expect(c.code).toMatch(/^[A-Z]\^?\.?[A-Z_^:.a-z]+$/);
    expect(CONTRACT.some((c) => /ref|description|delivery date/i.test(c.code))).toBe(false);
  });

  it("converts to compliant field names with the documented substitutions", () => {
    expect(compliantHeader("O^DD:1")).toBe("O2DD41");
    expect(compliantHeader("C.CODE")).toBe("C1CODE");
    expect(compliantHeader("P^WC:12")).toBe("P2WC412");
  });
});

describe("text value safety", () => {
  it("accepts ordinary values", () => {
    expect(checkTextValue("ABC-123 xl")).toBeNull();
    expect(checkTextValue("Z1::A::B")).toBeNull();
  });
  it("rejects tabs, line breaks and control characters", () => {
    expect(checkTextValue("a\tb")).toMatch(/tab|control/i);
    expect(checkTextValue("a\nb")).toMatch(/line break|control/i);
    expect(checkTextValue("a\rb")).toMatch(/line break|control/i);
    expect(checkTextValue("a\u0000b")).toMatch(/control/i);
  });
  it("rejects a leading spreadsheet formula character", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)"]) expect(checkTextValue(v)).toMatch(/formula/i);
  });
  it("rejects leading or trailing whitespace instead of trimming silently", () => {
    expect(checkTextValue(" a")).toMatch(/space/i);
    expect(checkTextValue("a ")).toMatch(/space/i);
  });
  it("treats a quote or comma as legal text (it is quoted in CSV)", () => {
    expect(checkTextValue('ab"c')).toBeNull();
    expect(checkTextValue("a,b")).toBeNull();
  });
});

describe("dates", () => {
  it("accepts only real calendar dates", () => {
    expect(parseIsoDate("2026-11-06")).toEqual({ y: 2026, m: 11, d: 6 });
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate("06/11/2026")).toBeNull();
    expect(parseIsoDate("2026-1-1")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });
  it("formats in each configured format", () => {
    expect(formatDate("2026-11-06", "YYYY-MM-DD")).toBe("2026-11-06");
    expect(formatDate("2026-11-06", "DD/MM/YYYY")).toBe("06/11/2026");
    expect(formatDate("2026-11-06", "YYYYMMDD")).toBe("20261106");
  });
});

describe("table rendering", () => {
  const cols = ["C.CODE", "C.DESCRIP"];
  it("renders tab-separated with a header row of field codes, CRLF line ends and no trailing blank line issues", () => {
    const r = renderTable(cols, [["A1", "Alpha"], ["B2", "Beta"]], "tab", "standard");
    expect(r.errors).toEqual([]);
    expect(r.text).toBe("C.CODE\tC.DESCRIP\r\nA1\tAlpha\r\nB2\tBeta\r\n");
  });
  it("renders CSV with every field quoted and inner quotes doubled", () => {
    const r = renderTable(cols, [["A1", 'He said "hi", ok']], "csv", "standard");
    expect(r.errors).toEqual([]);
    expect(r.text).toBe('"C.CODE","C.DESCRIP"\r\n"A1","He said ""hi"", ok"\r\n');
  });
  it("uses compliant headers when asked", () => {
    expect(renderTable(["O^DD:1"], [["x"]], "tab", "compliant").text.startsWith("O2DD41\r\n")).toBe(true);
  });
  it("refuses a value that would break the delimiter instead of altering it", () => {
    const r = renderTable(cols, [["A1", "bad\tvalue"]], "tab", "standard");
    expect(r.errors.length).toBe(1);
    expect(r.text).toBe("");
    expect(r.errors[0]).toMatch(/row 1/i);
    expect(r.errors[0]).not.toMatch(/bad/);
  });
  it("refuses a ragged row", () => {
    expect(renderTable(cols, [["only-one"]], "tab", "standard").errors.length).toBe(1);
  });
  it("is deterministic", () => {
    const a = renderTable(cols, [["A", "1"], ["B", "2"]], "tab", "standard").text;
    const b = renderTable(cols, [["A", "1"], ["B", "2"]], "tab", "standard").text;
    expect(a).toBe(b);
  });
});
