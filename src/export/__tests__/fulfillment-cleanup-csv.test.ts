import { describe, expect, it } from "vitest";
import { buildFulfillmentCleanupCsv } from "@/export/fulfillment-cleanup-csv";
import type { FulfillmentCleanupLine } from "@/reports/fulfillment-cleanup/build";

function line(overrides: Partial<FulfillmentCleanupLine>): FulfillmentCleanupLine {
  return {
    action: "Zero",
    location: "Main Warehouse",
    productSku: "SKU-A",
    productName: "Widget",
    bin: null,
    batchSn: null,
    expiryDate: null,
    quantity: 5,
    unitCost: 12.5,
    comments: "Backorder cleanup - negative availability correction",
    receivedDate: "2026-07-10",
    ...overrides,
  };
}

describe("buildFulfillmentCleanupCsv", () => {
  it("writes the header row matching Cin7's own BulkUpdateStockAdjustment.csv column order", () => {
    const csv = buildFulfillmentCleanupCsv([]);
    expect(csv).toBe(
      '"Zero/NonZero","Location","SKU","Name","Bin","BatchSerialNumber","ExpiryDate_YYYYMMDD","Quantity","UnitCost","Comments","ReceivedDate_YYYYMMDD"\r\n'
    );
  });

  it("strips dashes from dates to match Cin7's YYYYMMDD convention", () => {
    const csv = buildFulfillmentCleanupCsv([line({ expiryDate: "2027-01-01", receivedDate: "2026-07-10" })]);
    const dataRow = csv.split("\r\n")[1];
    expect(dataRow).toContain('"20270101"');
    expect(dataRow).toContain('"20260710"');
  });

  it("writes a blank ExpiryDate when none is set", () => {
    const csv = buildFulfillmentCleanupCsv([line({ expiryDate: null })]);
    const dataRow = csv.split("\r\n")[1];
    const cols = dataRow.split(",");
    expect(cols[6]).toBe('""');
  });

  it("writes the row's own action and quantity/cost values", () => {
    const csv = buildFulfillmentCleanupCsv([line({ action: "NonZero", productSku: "SKU-B", quantity: 3, unitCost: null })]);
    const dataRow = csv.split("\r\n")[1];
    expect(dataRow).toContain('"NonZero"');
    expect(dataRow).toContain('"SKU-B"');
    expect(dataRow).toContain('"3"');
  });
});
