import { describe, it, expect } from "vitest";
import { checkUploadSize, looksLikeText, assertCsvWithinLimits, MAX_CSV_ROWS, MAX_CSV_COLUMNS, MAX_CSV_FIELD_LENGTH, MAX_CSV_UPLOAD_BYTES } from "@/lib/csv-upload-limits";

function fakeFile(size: number): File {
  return { size } as File;
}

describe("checkUploadSize — security re-audit P1-7", () => {
  it("returns null (no error) for a file within the limit", () => {
    expect(checkUploadSize(fakeFile(1024))).toBeNull();
    expect(checkUploadSize(fakeFile(MAX_CSV_UPLOAD_BYTES))).toBeNull();
  });

  it("returns a clear message for a file over the limit", () => {
    const msg = checkUploadSize(fakeFile(MAX_CSV_UPLOAD_BYTES + 1));
    expect(msg).toMatch(/maximum is 10MB/);
  });
});

describe("looksLikeText — security re-audit P1-7", () => {
  it("accepts normal CSV text, including spaces, unicode, and punctuation", () => {
    expect(looksLikeText("Product Code,Name\nABC-123,Widget™ — Deluxe\n")).toBe(true);
  });

  it("rejects text containing a NUL byte (a strong binary-file signal)", () => {
    expect(looksLikeText(`abc${String.fromCharCode(0)}def`)).toBe(false);
  });

  it("accepts an empty string", () => {
    expect(looksLikeText("")).toBe(true);
  });
});

describe("assertCsvWithinLimits — security re-audit P1-7", () => {
  it("does not throw for a normal, small CSV", () => {
    const data = [{ SKU: "A", Name: "Widget" }];
    expect(() => assertCsvWithinLimits(data, ["SKU", "Name"])).not.toThrow();
  });

  it("throws when the column count exceeds the limit", () => {
    const fields = Array.from({ length: MAX_CSV_COLUMNS + 1 }, (_, i) => `col${i}`);
    expect(() => assertCsvWithinLimits([], fields)).toThrow(/columns.*maximum is 200/);
  });

  it("does not throw at exactly the column limit", () => {
    const fields = Array.from({ length: MAX_CSV_COLUMNS }, (_, i) => `col${i}`);
    expect(() => assertCsvWithinLimits([], fields)).not.toThrow();
  });

  it("throws when the row count exceeds the limit", () => {
    const data = Array.from({ length: MAX_CSV_ROWS + 1 }, () => ({ SKU: "A" }));
    expect(() => assertCsvWithinLimits(data, ["SKU"])).toThrow(/rows.*maximum is 50,000/);
  });

  it("does not throw at exactly the row limit", () => {
    const data = Array.from({ length: MAX_CSV_ROWS }, () => ({ SKU: "A" }));
    expect(() => assertCsvWithinLimits(data, ["SKU"])).not.toThrow();
  });

  it("throws when a single cell exceeds the max field length, naming the row and column", () => {
    const data = [{ SKU: "A" }, { SKU: "x".repeat(MAX_CSV_FIELD_LENGTH + 1) }];
    expect(() => assertCsvWithinLimits(data, ["SKU"])).toThrow(/Row 2, column "SKU".*maximum is 10,000/);
  });

  it("does not throw for a cell exactly at the max field length", () => {
    const data = [{ SKU: "x".repeat(MAX_CSV_FIELD_LENGTH) }];
    expect(() => assertCsvWithinLimits(data, ["SKU"])).not.toThrow();
  });

  it("ignores non-string cell values (e.g. already-coerced numbers) when checking field length", () => {
    const data = [{ Qty: 12345 }];
    expect(() => assertCsvWithinLimits(data, ["Qty"])).not.toThrow();
  });
});
