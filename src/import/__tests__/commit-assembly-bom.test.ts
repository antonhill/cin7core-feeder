import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitAssemblyBomRows } from "@/import/commit-assembly-bom";
import type { AssemblyBomCsvRow } from "@/model/assembly-bom";

/** Minimal in-memory stand-in supporting .upsert() and .delete().eq().eq().eq(). */
function createFakeDb() {
  const upserts: Record<string, Record<string, unknown>[]> = {};
  const deleteCalls: { table: string; filters: Record<string, unknown> }[] = [];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "delete" | null = null;
    const api = {
      delete: () => {
        mode = "delete";
        return api;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      upsert: async (payload: Record<string, unknown>[]) => {
        upserts[table] = [...(upserts[table] ?? []), ...payload];
        return { error: null };
      },
      then: (resolve: (v: { error: null }) => void) => {
        if (mode === "delete") deleteCalls.push({ table, filters: { ...filters } });
        resolve({ error: null });
      },
    };
    return api;
  }

  return { db: { from: builder } as unknown as SupabaseClient, upserts, deleteCalls };
}

function row(overrides: Partial<AssemblyBomCsvRow>): AssemblyBomCsvRow {
  return {
    Action: "Create/Update",
    ProductSKU: "PARENT",
    ProductName: "Parent",
    ComponentSKU: "COMP",
    ComponentName: "Component",
    Quantity: 1,
    PriceTier_ForServiceComponentOnly: "",
    ExpenseAccount_ForServiceComponentOnly: "",
    ...overrides,
  };
}

describe("commitAssemblyBomRows", () => {
  it("upserts Create/Update rows (including the default action)", async () => {
    const { db, upserts } = createFakeDb();

    const summary = await commitAssemblyBomRows(db, "org1", [
      row({ ComponentSKU: "COMP1" }),
      row({ Action: "Create/Update", ComponentSKU: "COMP2" }),
    ]);

    expect(summary).toEqual({ linesUpserted: 2, linesDeleted: 0 });
    expect(upserts.assembly_bom_lines).toHaveLength(2);
  });

  it("deletes a row whose Action is Delete, instead of upserting it", async () => {
    const { db, upserts, deleteCalls } = createFakeDb();

    const summary = await commitAssemblyBomRows(db, "org1", [
      row({ Action: "Delete", ComponentSKU: "COMP1" }),
    ]);

    expect(summary).toEqual({ linesUpserted: 0, linesDeleted: 1 });
    expect(upserts.assembly_bom_lines).toBeUndefined();
    expect(deleteCalls).toEqual([
      { table: "assembly_bom_lines", filters: { org_id: "org1", product_sku: "PARENT", component_sku: "COMP1" } },
    ]);
  });

  it("is case-insensitive and trims whitespace on the Action column", async () => {
    const { db, deleteCalls } = createFakeDb();
    await commitAssemblyBomRows(db, "org1", [row({ Action: "  delete  " })]);
    expect(deleteCalls).toHaveLength(1);
  });

  it("handles a mixed batch of upserts and deletes in one import", async () => {
    const { db, upserts, deleteCalls } = createFakeDb();

    const summary = await commitAssemblyBomRows(db, "org1", [
      row({ ComponentSKU: "COMP1" }),
      row({ Action: "Delete", ComponentSKU: "COMP2" }),
      row({ ComponentSKU: "COMP3" }),
    ]);

    expect(summary).toEqual({ linesUpserted: 2, linesDeleted: 1 });
    expect(upserts.assembly_bom_lines).toHaveLength(2);
    expect(deleteCalls).toHaveLength(1);
  });
});
