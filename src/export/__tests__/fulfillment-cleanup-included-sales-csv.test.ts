import { describe, expect, it } from "vitest";
import { buildIncludedSalesCsv } from "@/export/fulfillment-cleanup-included-sales-csv";
import type { BackorderedSale } from "@/app/reports/fulfillment-cleanup/actions";

function sale(overrides: Partial<BackorderedSale>): BackorderedSale {
  return {
    cin7SaleId: "sale-1",
    orderNumber: "SO-1",
    customerName: "Acme",
    customerReference: null,
    orderDate: "2026-07-01",
    totalBackorderQty: 5,
    ...overrides,
  };
}

describe("buildIncludedSalesCsv", () => {
  it("writes the header row", () => {
    const csv = buildIncludedSalesCsv([]);
    expect(csv).toBe('"Order Number","Customer","Customer Reference","Order Date","Backorder Qty"\r\n');
  });

  it("writes one row per sale with its own fields", () => {
    const csv = buildIncludedSalesCsv([sale({ orderNumber: "SO-95", customerName: "Anton Tech", customerReference: "PO-123", orderDate: "2026-06-20", totalBackorderQty: 12 })]);
    const dataRow = csv.split("\r\n")[1];
    expect(dataRow).toBe('"SO-95","Anton Tech","PO-123","2026-06-20","12"');
  });

  it("writes a blank Customer Reference when none was given", () => {
    const csv = buildIncludedSalesCsv([sale({ customerReference: null })]);
    const dataRow = csv.split("\r\n")[1];
    expect(dataRow.split(",")[2]).toBe('""');
  });
});
