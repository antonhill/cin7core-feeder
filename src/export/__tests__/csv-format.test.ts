import { describe, expect, it } from "vitest";
import { csvField, toCsv, sanitizeCsvField, toSanitizedCsv } from "@/export/csv-format";

describe("csvField/toCsv — unchanged, shared by every Cin7 round-trip export", () => {
  it("does not prefix a value starting with = + - @ (a literal SKU/account code must round-trip byte-for-byte)", () => {
    expect(csvField("-5")).toBe('"-5"');
    expect(csvField("=SUM(A1)")).toBe('"=SUM(A1)"');
  });

  it("quotes every field and escapes embedded quotes", () => {
    expect(toCsv([["a\"b", 1]])).toBe('"a""b","1"\r\n');
  });
});

describe("sanitizeCsvField — security re-audit P1-7, human-facing exports only", () => {
  it("passes normal values through unchanged", () => {
    expect(sanitizeCsvField("Widget")).toBe('"Widget"');
    expect(sanitizeCsvField(42)).toBe('"42"');
    expect(sanitizeCsvField(null)).toBe('""');
    expect(sanitizeCsvField(undefined)).toBe('""');
  });

  it("prefixes a value starting with =, +, -, or @ with a single quote", () => {
    expect(sanitizeCsvField("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    expect(sanitizeCsvField("+1234")).toBe(`"'+1234"`);
    expect(sanitizeCsvField("-1234")).toBe(`"'-1234"`);
    expect(sanitizeCsvField("@SUM")).toBe(`"'@SUM"`);
  });

  it("prefixes a value starting with a leading control character (e.g. tab)", () => {
    expect(sanitizeCsvField("\tmalicious")).toBe(`"'\tmalicious"`);
  });

  it("does not prefix a value merely containing one of those characters mid-string", () => {
    expect(sanitizeCsvField("Order-123")).toBe('"Order-123"');
    expect(sanitizeCsvField("a@b.com")).toBe('"a@b.com"');
  });

  it("does not prefix an empty string", () => {
    expect(sanitizeCsvField("")).toBe('""');
  });
});

describe("toSanitizedCsv — security re-audit P1-7", () => {
  it("sanitizes every cell and preserves row order", () => {
    const csv = toSanitizedCsv([
      ["Order", "Customer"],
      ["1001", "=EVIL()"],
    ]);
    expect(csv).toBe('"Order","Customer"\r\n"1001","\'=EVIL()"\r\n');
  });
});
