import { describe, expect, it } from "vitest";
import { buildSynth } from "@/rwtsa-demo/__tests__/helpers";
import { computeAvailable, reconcile } from "@/rwtsa-demo/reconcile";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";

describe("AT-9: deterministic reconciliation", () => {
  it("hand-checked tiny case: units by style, last-6/12 windows, PO qty by style or SKU, and available excludes Bond and In transit", () => {
    const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
    const tables = {
      items: [
        { sku: "A-S", styleCode: "A" },
        { sku: "A-M", styleCode: "A" },
        { sku: "B-S", styleCode: "B" },
      ],
      salesHistory: months.flatMap((month) => [
        { sku: "A-S", month, qty: 1 },
        { sku: "B-S", month, qty: 10 },
      ]),
      stock: [
        { sku: "A-S", jhb: 10, durban: 5, capeTown: 3, factoryStore: 2, committed: 4, bond: 100, inTransit: 50, availableComputed: computeAvailable({ jhb: 10, durban: 5, capeTown: 3, factoryStore: 2, committed: 4 }) },
        { sku: "B-S", jhb: 1, durban: 0, capeTown: 0, factoryStore: 0, committed: 0, bond: 0, inTransit: 7, availableComputed: 1 },
      ],
      importPos: [
        { styleCode: "A", sku: null, qty: 500 },
        { styleCode: null, sku: "B-S", qty: 20 },
      ],
      bom: [],
      routing: [],
      productionOrders: [],
      landedCost: [],
      paymentsFec: [],
      customers: [],
      quotes: [],
      salesFileAverages: [],
    } as unknown as RwtsaDataset["tables"];

    const r = reconcile(tables, months);
    expect(computeAvailable({ jhb: 10, durban: 5, capeTown: 3, factoryStore: 2, committed: 4 })).toBe(16);
    expect(r.unitsByStyle.A).toMatchObject({ skuCount: 2, availableUnits: 16, committedUnits: 4, inTransitUnits: 50, bondUnits: 100, salesLast6Months: 6, salesLast12Months: 12, salesAllMonths: 12, importPoQty: 500 });
    expect(r.unitsByStyle.B).toMatchObject({ skuCount: 1, availableUnits: 1, salesLast6Months: 60, salesLast12Months: 120, importPoQty: 20 });
    expect(r.totals.availableUnits).toBe(17);
    expect(r.months).toEqual({ first: "2025-01", last: "2025-12", count: 12 });
    expect(Object.keys(r.unitsByStyle)).toEqual(["A", "B"]); // sorted
  });

  it("is order-independent and totals equal the sum of the styles", async () => {
    const a = (await buildSynth()).dataset!.reconciliation;
    const b = (await buildSynth({ shuffleColumns: true, shuffleRows: true })).dataset!.reconciliation;
    expect(b.controlHash).toBe(a.controlHash);
    expect(b).toEqual(a);
    const sum = Object.values(a.unitsByStyle).reduce((s, x) => s + x.availableUnits, 0);
    expect(a.totals.availableUnits).toBe(sum);
    expect(a.rowCounts).toMatchObject({ Items: 24, SalesHistory: 24, Stock: 24, Quotes: 12 });
  });

  it("changes the control hash when any single value changes", async () => {
    const base = (await buildSynth()).dataset!.reconciliation.controlHash;
    const changed = (
      await buildSynth({}, (wb) => {
        const ws = wb.getWorksheet("Customers")!;
        ws.getRow(2).getCell(3).value = "Different Rep";
      })
    ).dataset!.reconciliation.controlHash;
    expect(changed).not.toBe(base);
  });
});
