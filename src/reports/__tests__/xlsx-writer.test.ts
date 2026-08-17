import { describe, expect, it } from "vitest";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";
import type { SheetExport } from "@/reports/export-xlsx";

function sheet(data: (string | number)[][]): SheetExport {
  return { data, merges: [], headerRowCount: 1 };
}

describe("renderXlsxBase64 — security re-audit P1-7 resource boundaries", () => {
  it("renders a normal small sheet to a non-empty base64 string", async () => {
    const result = await renderXlsxBase64(sheet([["SKU", "Qty"], ["A", 1]]), "Sheet1");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("throws when the row count exceeds the limit", async () => {
    const data = Array.from({ length: 25_001 }, (_, i) => [`sku${i}`, i]);
    await expect(renderXlsxBase64(sheet(data), "Sheet1")).rejects.toThrow(/25,001 rows.*maximum is 25,000/);
  });

  it("does not throw at exactly the row limit", async () => {
    const data = Array.from({ length: 25_000 }, (_, i) => [`sku${i}`, i]);
    await expect(renderXlsxBase64(sheet(data), "Sheet1")).resolves.toEqual(expect.any(String));
  });

  it("throws when a single cell exceeds the max length, naming the row and column", async () => {
    const data = [["ok", "x".repeat(10_001)]];
    await expect(renderXlsxBase64(sheet(data), "Sheet1")).rejects.toThrow(/Row 1, column 2.*maximum is 10,000/);
  });

  it("does not throw for a cell exactly at the max length", async () => {
    const data = [["ok", "x".repeat(10_000)]];
    await expect(renderXlsxBase64(sheet(data), "Sheet1")).resolves.toEqual(expect.any(String));
  });

  it("ignores non-string cell values (numbers) when checking cell length", async () => {
    const data = [[123456789, 1]];
    await expect(renderXlsxBase64(sheet(data), "Sheet1")).resolves.toEqual(expect.any(String));
  });
});
