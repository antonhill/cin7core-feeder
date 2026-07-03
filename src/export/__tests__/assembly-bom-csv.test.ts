import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exportAssemblyBomCsv } from "@/export/assembly-bom-csv";

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

describe("exportAssemblyBomCsv", () => {
  it("includes the exact AssemblyBOM template header", async () => {
    const db = createFakeDb({ assembly_bom_lines: [], products: [] });
    const csv = await exportAssemblyBomCsv(db, "org1");
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      '"Action","ProductSKU","ProductName","ComponentSKU","ComponentName","Quantity","WastageQuantity_ForStockComponentOnly","WastagePercent_ForStockComponentOnly","CostPercentage_ForStockComponentOnly","PriceTier_ForServiceComponentOnly","ExpenseAccount_ForServiceComponentOnly","EstimatedUnitCost"'
    );
  });

  it("always exports Action=Create/Update and fills ProductName by joining products", async () => {
    const db = createFakeDb({
      assembly_bom_lines: [
        {
          org_id: "org1",
          product_sku: "PARENT",
          component_sku: "COMP1",
          component_name: "Component One",
          quantity: 2,
          wastage_quantity: null,
          wastage_percent: null,
          cost_percentage: null,
          price_tier: null,
          expense_account: null,
          estimated_unit_cost: null,
        },
      ],
      products: [{ org_id: "org1", sku: "PARENT", name: "Parent Product" }],
    });

    const csv = await exportAssemblyBomCsv(db, "org1");
    const dataLine = csv.split("\r\n")[1];

    expect(dataLine.startsWith('"Create/Update","PARENT","Parent Product","COMP1","Component One","2"')).toBe(true);
  });
});
