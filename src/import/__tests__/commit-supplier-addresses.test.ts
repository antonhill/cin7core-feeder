import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitSupplierAddressRows } from "@/import/commit-supplier-addresses";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";

/** Minimal in-memory stand-in supporting .delete().eq().in() and .insert(). */
function createFakeDb() {
  const inserts: Record<string, Record<string, unknown>[]> = {};
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
      in: (col: string, vals: unknown) => {
        filters[col] = vals;
        return api;
      },
      insert: async (payload: Record<string, unknown>[]) => {
        inserts[table] = [...(inserts[table] ?? []), ...payload];
        return { error: null };
      },
      then: (resolve: (v: { error: null }) => void) => {
        if (mode === "delete") deleteCalls.push({ table, filters: { ...filters } });
        resolve({ error: null });
      },
    };
    return api;
  }

  return { db: { from: builder } as unknown as SupabaseClient, inserts, deleteCalls };
}

function row(overrides: Partial<SupplierAddressCsvRow>): SupplierAddressCsvRow {
  return {
    Action: "Create/Update",
    Name: "ABC Suppliers",
    AddressType: "Billing",
    AddressDefaultForType: "True",
    AddressLine1: "1 Pear Tree Circle",
    AddressLine2: "",
    City: "Epping",
    State: "Western Cape",
    Postcode: "8121",
    Country: "South Africa",
    ...overrides,
  };
}

describe("commitSupplierAddressRows", () => {
  it("deletes every existing address for names present, then inserts the file's rows", async () => {
    const { db, inserts, deleteCalls } = createFakeDb();
    const summary = await commitSupplierAddressRows(db, "org1", [
      row({ AddressType: "Billing" }),
      row({ AddressType: "Shipping" }),
    ]);
    expect(summary).toEqual({ addressesUpserted: 2, suppliersReplaced: 1 });
    expect(deleteCalls).toEqual([{ table: "supplier_addresses", filters: { org_id: "org1", name: ["ABC Suppliers"] } }]);
    expect(inserts.supplier_addresses).toHaveLength(2);
  });

  it("replaces addresses independently per distinct name", async () => {
    const { db, deleteCalls } = createFakeDb();
    await commitSupplierAddressRows(db, "org1", [row({ Name: "Supplier A" }), row({ Name: "Supplier B" })]);
    expect(deleteCalls[0].filters.name).toEqual(["Supplier A", "Supplier B"]);
  });

  it("excludes rows whose Action is Delete from the reinsert", async () => {
    const { db, inserts } = createFakeDb();
    const summary = await commitSupplierAddressRows(db, "org1", [
      row({ AddressType: "Billing" }),
      row({ AddressType: "Shipping", Action: "Delete" }),
    ]);
    expect(summary.addressesUpserted).toBe(1);
    expect(inserts.supplier_addresses).toHaveLength(1);
    expect(inserts.supplier_addresses[0]).toMatchObject({ address_type: "Billing" });
  });
});
