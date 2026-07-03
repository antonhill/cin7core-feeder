import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exportProductsCsv } from "@/export/products-csv";

/** Minimal in-memory stand-in for .select().eq().order() chains. */
function createFakeDb(tables: Record<string, Record<string, unknown>[]>) {
  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      order: () => api,
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
        const rows = tables[table] ?? [];
        resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null });
      },
    };
    return api;
  }
  return { from: builder } as unknown as SupabaseClient;
}

describe("exportProductsCsv", () => {
  it("includes the exact InventoryList template header", async () => {
    const db = createFakeDb({ products: [], price_tiers: [] });
    const csv = await exportProductsCsv(db, "org1");
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      '"ProductCode","Name","Category","Type","Barcode","DefaultUnitOfMeasure","Status","Description","PurchaseTaxRule","SaleTaxRule","PriceTier1","PriceTier2","PriceTier3","PriceTier4","PriceTier5","PriceTier6","PriceTier7","PriceTier8","PriceTier9","PriceTier10"'
    );
  });

  it("maps a product row and merges in its price tiers by index", async () => {
    const db = createFakeDb({
      products: [
        {
          org_id: "org1",
          sku: "SKU1",
          name: "Widget",
          category_code: "Widgets",
          uom_code: "Item",
          barcode: "12345",
          type: "component",
          tax_code: "VAT",
          status: "Active",
          description: "A widget",
        },
      ],
      price_tiers: [
        { org_id: "org1", product_sku: "SKU1", tier_code: "Tier1", amount: 100 },
        { org_id: "org1", product_sku: "SKU1", tier_code: "Tier3", amount: 90 },
      ],
    });

    const csv = await exportProductsCsv(db, "org1");
    const dataLine = csv.split("\r\n")[1];

    expect(dataLine).toContain('"SKU1"');
    expect(dataLine).toContain('"Widget"');
    expect(dataLine).toContain('"Stock"'); // reverse-mapped from "component"
    expect(dataLine).toContain('"Active"');
    expect(dataLine).toContain('"100"'); // PriceTier1
    expect(dataLine).toContain('"90"'); // PriceTier3
  });

  it("defaults an unpopulated price tier to 0", async () => {
    const db = createFakeDb({
      products: [
        {
          org_id: "org1",
          sku: "SKU1",
          name: "Widget",
          category_code: null,
          uom_code: null,
          barcode: null,
          type: "component",
          tax_code: null,
          status: "Active",
          description: null,
        },
      ],
      price_tiers: [],
    });

    const csv = await exportProductsCsv(db, "org1");
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine.endsWith('"0","0","0","0","0","0","0","0","0","0"')).toBe(true);
  });
});
