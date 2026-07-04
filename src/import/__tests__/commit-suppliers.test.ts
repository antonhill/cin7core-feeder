import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitSupplierRows } from "@/import/commit-suppliers";
import type { SupplierCsvRow } from "@/model/suppliers";

/** Minimal in-memory stand-in supporting .upsert(), .delete().eq().in(), and .insert(). */
function createFakeDb() {
  const upserts: Record<string, Record<string, unknown>[]> = {};
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const deleteCalls: { table: string; filters: Record<string, unknown> }[] = [];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let mode: "delete" | null = null;
    const api = {
      upsert: async (payload: Record<string, unknown>[]) => {
        upserts[table] = [...(upserts[table] ?? []), ...payload];
        return { error: null };
      },
      insert: async (payload: Record<string, unknown>[]) => {
        inserts[table] = [...(inserts[table] ?? []), ...payload];
        return { error: null };
      },
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
      then: (resolve: (v: { error: null }) => void) => {
        if (mode === "delete") deleteCalls.push({ table, filters: { ...filters } });
        resolve({ error: null });
      },
    };
    return api;
  }

  return { db: { from: builder } as unknown as SupabaseClient, upserts, inserts, deleteCalls };
}

function row(overrides: Partial<SupplierCsvRow>): SupplierCsvRow {
  return {
    Name: "ABC Suppliers",
    Status: "Active",
    Currency: "ZAR",
    PaymentTerm: "30 days",
    TaxRule: "Standard Rate Purchases",
    AccountPayable: "800",
    Carrier: "",
    TaxNumber: "",
    AttributeSet: "",
    AdditionalAttribute1: "",
    AdditionalAttribute2: "",
    AdditionalAttribute3: "",
    AdditionalAttribute4: "",
    AdditionalAttribute5: "",
    AdditionalAttribute6: "",
    AdditionalAttribute7: "",
    AdditionalAttribute8: "",
    AdditionalAttribute9: "",
    AdditionalAttribute10: "",
    Comments: "",
    ContactName: "Peter Parker",
    JobTitle: "",
    Phone: "",
    MobilePhone: "",
    Fax: "",
    Email: "",
    Website: "",
    ContactComment: "",
    ContactDefault: "False",
    ContactIncludeInEmail: "False",
    IsAccountingDimensionEnabled: "False",
    DimensionAttribute1: "",
    DimensionAttribute2: "",
    DimensionAttribute3: "",
    DimensionAttribute4: "",
    DimensionAttribute5: "",
    DimensionAttribute6: "",
    DimensionAttribute7: "",
    DimensionAttribute8: "",
    DimensionAttribute9: "",
    DimensionAttribute10: "",
    ...overrides,
  };
}

describe("commitSupplierRows", () => {
  it("upserts suppliers by name and their contacts separately", async () => {
    const { db, upserts, inserts } = createFakeDb();
    const summary = await commitSupplierRows(db, "org1", [row({}), row({ Name: "Other Supplier" })]);
    expect(summary).toEqual({ suppliersUpserted: 2, contactsUpserted: 2 });
    expect(upserts.suppliers).toHaveLength(2);
    expect(upserts.suppliers[0]).toMatchObject({ org_id: "org1", name: "ABC Suppliers" });
    expect(inserts.supplier_contacts[0]).toMatchObject({ org_id: "org1", name: "ABC Suppliers", contact_name: "Peter Parker" });
  });

  it("parses True/False contact flags into real booleans on the contact row", async () => {
    const { db, inserts } = createFakeDb();
    await commitSupplierRows(db, "org1", [row({ ContactDefault: "True", ContactIncludeInEmail: "true" })]);
    expect(inserts.supplier_contacts[0]).toMatchObject({ contact_default: true, contact_include_in_email: true });
  });

  it("dedupes multiple rows sharing the same supplier Name into one supplier upsert, keeping every contact", async () => {
    const { db, upserts, inserts, deleteCalls } = createFakeDb();
    const summary = await commitSupplierRows(db, "org1", [
      row({ Name: "Corefeeder Supplier", ContactName: "John" }),
      row({ Name: "Corefeeder Supplier", ContactName: "Frank" }),
    ]);
    expect(summary).toEqual({ suppliersUpserted: 1, contactsUpserted: 2 });
    expect(upserts.suppliers).toHaveLength(1);
    expect(deleteCalls).toEqual([{ table: "supplier_contacts", filters: { org_id: "org1", name: ["Corefeeder Supplier"] } }]);
    expect(inserts.supplier_contacts.map((c) => c.contact_name)).toEqual(["John", "Frank"]);
  });

  it("inserts no contact row for a supplier row with no ContactName", async () => {
    const { db, inserts } = createFakeDb();
    const summary = await commitSupplierRows(db, "org1", [row({ ContactName: "" })]);
    expect(summary).toEqual({ suppliersUpserted: 1, contactsUpserted: 0 });
    expect(inserts.supplier_contacts).toBeUndefined();
  });
});
