import { describe, expect, it } from "vitest";
import {
  parseStocktakeFile,
  buildConfirmationLines,
  setBulkChecked,
  mergeStocktakeFile,
  buildStocktakeCsv,
  type StocktakeRow,
  type ConfirmationLine,
} from "@/reports/stocktake-assistant/build";
import type { StocktakeStagedStockRow } from "@/reports/query";

function staged(overrides: Partial<StocktakeStagedStockRow>): StocktakeStagedStockRow {
  return { product_sku: "SKU-A", product_name: "Widget", picked_qty: 0, packed_qty: 0, ...overrides };
}

function stocktakeRow(overrides: Partial<StocktakeRow>): StocktakeRow {
  return {
    "Product Code": "SKU-A",
    "Product Name": "Widget",
    Bin: "",
    Unit: "ea",
    BatchSN: "",
    ExpiryDate_YYYYMMDD: "",
    "Quantity On Hand": "6.0000",
    "Stocktake Quantity": "0.0000",
    ...overrides,
  };
}

function line(overrides: Partial<ConfirmationLine>): ConfirmationLine {
  return { productSku: "SKU-A", productName: "Widget", stage: "pick", quantity: 8, checked: true, ...overrides };
}

describe("parseStocktakeFile", () => {
  const CSV =
    '"Product Code","Product Name","Bin","Unit","BatchSN","ExpiryDate_YYYYMMDD","Quantity On Hand","Stocktake Quantity"\r\n' +
    '"1561","Widget","","ea","","",6.0000,0.0000\r\n' +
    '"1561","Widget","Bin1","ea","","",16.0000,0.0000\r\n';

  it("parses every data row, preserving values as strings", () => {
    const { rows, error } = parseStocktakeFile(CSV);
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0]["Product Code"]).toBe("1561");
    expect(rows[1].Bin).toBe("Bin1");
  });

  it("rejects a file missing the required columns", () => {
    const { rows, error } = parseStocktakeFile('"SKU","Qty"\r\n"1561",5\r\n');
    expect(rows).toEqual([]);
    expect(error).toMatch(/Product Code/);
  });

  it("skips a blank trailing row (no Product Code)", () => {
    const { rows } = parseStocktakeFile(CSV + '"","","","","","",,\r\n');
    expect(rows).toHaveLength(2);
  });
});

describe("buildConfirmationLines", () => {
  it("emits one line per nonzero stage, skipping zero quantities", () => {
    const lines = buildConfirmationLines([staged({ picked_qty: 5, packed_qty: 0 }), staged({ product_sku: "SKU-B", picked_qty: 0, packed_qty: 3 })]);
    expect(lines).toEqual([
      { productSku: "SKU-A", productName: "Widget", stage: "pick", quantity: 5, checked: true },
      { productSku: "SKU-B", productName: "Widget", stage: "pack", quantity: 3, checked: true },
    ]);
  });

  it("emits both pick and pack lines when both are nonzero", () => {
    const lines = buildConfirmationLines([staged({ picked_qty: 5, packed_qty: 3 })]);
    expect(lines).toHaveLength(2);
  });
});

describe("setBulkChecked", () => {
  it("unchecks only the matching stage, leaving the other untouched", () => {
    const lines = [line({ stage: "pick", checked: true }), line({ stage: "pack", checked: true })];
    const result = setBulkChecked(lines, false, "pick");
    expect(result[0].checked).toBe(false);
    expect(result[1].checked).toBe(true);
  });

  it("with no stage argument, applies to every line", () => {
    const lines = [line({ stage: "pick" }), line({ stage: "pack" })];
    const result = setBulkChecked(lines, false);
    expect(result.every((l) => !l.checked)).toBe(true);
  });
});

describe("mergeStocktakeFile", () => {
  it("auto-places onto the single existing Bin row when a SKU has exactly one Bin with on-hand stock", () => {
    const original = [stocktakeRow({ Bin: "Bin1", "Quantity On Hand": "6.0000", "Stocktake Quantity": "0.0000" })];
    const { rows, autoPlacedCount, appendedCount } = mergeStocktakeFile(original, [line({ quantity: 8 })]);
    expect(autoPlacedCount).toBe(1);
    expect(appendedCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]["Stocktake Quantity"]).toBe("8");
    expect(rows[0].Bin).toBe("Bin1");
    expect(rows[0]["Product Name"]).toBe("Widget"); // unchanged, no [PLACE MANUALLY] prefix
  });

  it("sums onto whatever Stocktake Quantity the row already had, rather than overwriting it", () => {
    const original = [stocktakeRow({ "Quantity On Hand": "6.0000", "Stocktake Quantity": "2.0000" })];
    const { rows } = mergeStocktakeFile(original, [line({ quantity: 8 })]);
    expect(rows[0]["Stocktake Quantity"]).toBe("10");
  });

  it("sums picked + packed together onto the same auto-placed row", () => {
    const original = [stocktakeRow({ "Quantity On Hand": "6.0000" })];
    const { rows, autoPlacedCount } = mergeStocktakeFile(original, [line({ stage: "pick", quantity: 5 }), line({ stage: "pack", quantity: 3 })]);
    expect(autoPlacedCount).toBe(1);
    expect(rows[0]["Stocktake Quantity"]).toBe("8");
  });

  it("falls back to an appended, clearly-flagged row when a SKU's on-hand stock spans more than one Bin", () => {
    const original = [stocktakeRow({ Bin: "", "Quantity On Hand": "6.0000" }), stocktakeRow({ Bin: "Bin1", "Quantity On Hand": "16.0000" })];
    const { rows, autoPlacedCount, appendedCount } = mergeStocktakeFile(original, [line({ quantity: 8 })]);
    expect(autoPlacedCount).toBe(0);
    expect(appendedCount).toBe(1);
    expect(rows[0]).toEqual(original[0]);
    expect(rows[1]).toEqual(original[1]);
    const appended = rows[rows.length - 1];
    expect(appended["Product Code"]).toBe("SKU-A");
    expect(appended["Product Name"]).toBe("[PICKED/PACKED - PLACE MANUALLY] Widget");
    expect(appended.Bin).toBe("");
    expect(appended["Stocktake Quantity"]).toBe("8");
  });

  it("falls back to an appended row when no row for that SKU has any on-hand qty at all", () => {
    const original = [stocktakeRow({ "Quantity On Hand": "0.0000" })];
    const { autoPlacedCount, appendedCount } = mergeStocktakeFile(original, [line({ quantity: 4 })]);
    expect(autoPlacedCount).toBe(0);
    expect(appendedCount).toBe(1);
  });

  it("excludes unticked lines entirely", () => {
    const { rows, autoPlacedCount, appendedCount } = mergeStocktakeFile([stocktakeRow({})], [line({ checked: false })]);
    expect(autoPlacedCount).toBe(0);
    expect(appendedCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(stocktakeRow({}));
  });

  it("ignores a line whose SKU nets to zero across checked entries", () => {
    const { appendedCount, autoPlacedCount } = mergeStocktakeFile([stocktakeRow({})], [line({ quantity: 0, checked: true })]);
    expect(appendedCount).toBe(0);
    expect(autoPlacedCount).toBe(0);
  });
});

describe("buildStocktakeCsv", () => {
  it("emits the fixed 8-column header regardless of input row key order", () => {
    const csv = buildStocktakeCsv([stocktakeRow({})]);
    const [header] = csv.split("\r\n");
    expect(header).toBe('"Product Code","Product Name","Bin","Unit","BatchSN","ExpiryDate_YYYYMMDD","Quantity On Hand","Stocktake Quantity"');
  });
});
