import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitCustomerAddressRows } from "@/import/commit-customer-addresses";
import type { CustomerAddressCsvRow } from "@/model/customer-addresses";

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

function row(overrides: Partial<CustomerAddressCsvRow>): CustomerAddressCsvRow {
  return {
    Action: "Create/Update",
    Name: "Anton Hill",
    AddressType: "Billing",
    AddressDefaultForType: "True",
    AddressLine1: "111",
    AddressLine2: "",
    City: "CT",
    State: "WC",
    Postcode: "8005",
    Country: "South Africa",
    IsParent: "False",
    ...overrides,
  };
}

describe("commitCustomerAddressRows", () => {
  it("replaces every address for names present in the file", async () => {
    const { db, inserts, deleteCalls } = createFakeDb();
    const summary = await commitCustomerAddressRows(db, "org1", [
      row({ AddressDefaultForType: "True" }),
      row({ AddressDefaultForType: "False", AddressLine1: "4 Glenside" }),
    ]);
    expect(summary).toEqual({ addressesUpserted: 2, customersReplaced: 1 });
    expect(deleteCalls).toEqual([{ table: "customer_addresses", filters: { org_id: "org1", name: ["Anton Hill"] } }]);
    expect(inserts.customer_addresses).toHaveLength(2);
  });

  it("carries the IsParent flag through", async () => {
    const { db, inserts } = createFakeDb();
    await commitCustomerAddressRows(db, "org1", [row({ Name: "157 QUEEN STREET", IsParent: "True" })]);
    expect(inserts.customer_addresses[0]).toMatchObject({ is_parent: true });
  });

  it("excludes rows whose Action is Delete from the reinsert", async () => {
    const { db, inserts } = createFakeDb();
    const summary = await commitCustomerAddressRows(db, "org1", [
      row({ AddressType: "Billing" }),
      row({ AddressType: "Shipping", Action: "Delete" }),
    ]);
    expect(summary.addressesUpserted).toBe(1);
    expect(inserts.customer_addresses).toHaveLength(1);
  });
});
