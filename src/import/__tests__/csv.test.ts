import { describe, expect, it } from "vitest";
import { parseCsv } from "@/import/csv";
import { productCsvRowSchema } from "@/model/products";

describe("parseCsv", () => {
  it("skips a trailing all-blank row instead of reporting it as invalid", () => {
    // A common artifact of opening/saving a CSV in a spreadsheet app —
    // every field empty, but the row still has delimiters (bare commas).
    const csv = "ProductCode,Name\nSKU1,Widget\n,\n";
    const { valid, invalid } = parseCsv(csv, productCsvRowSchema);
    expect(valid).toHaveLength(1);
    expect(valid[0].data.ProductCode).toBe("SKU1");
    expect(invalid).toEqual([]);
  });

  it("still reports a row missing required fields when it has real (non-blank) content", () => {
    const csv = "ProductCode,Name,Category\n,Widget,Widgets\n";
    const { valid, invalid } = parseCsv(csv, productCsvRowSchema);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors.join()).toContain("ProductCode is required");
  });

  it("tolerates a trailing extra empty column vs. the header (Cin7's own export quirk)", () => {
    const csv = "ProductCode,Name\nSKU1,Widget,\n";
    const { valid, invalid } = parseCsv(csv, productCsvRowSchema);
    expect(valid).toHaveLength(1);
    expect(invalid).toEqual([]);
  });
});
