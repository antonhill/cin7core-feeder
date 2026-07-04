import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitSupplierRows } from "@/import/commit-suppliers";
import type { SupplierCsvRow } from "@/model/suppliers";

function createFakeDb() {
  const upserts: Record<string, Record<string, unknown>[]> = {};

  function builder(table: string) {
    const api = {
      upsert: async (payload: Record<string, unknown>[]) => {
        upserts[table] = [...(upserts[table] ?? []), ...payload];
        return { error: null };
      },
    };
    return api;
  }

  return { db: { from: builder } as unknown as SupabaseClient, upserts };
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
    ContactName: "",
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
  it("upserts suppliers by name", async () => {
    const { db, upserts } = createFakeDb();
    const summary = await commitSupplierRows(db, "org1", [row({}), row({ Name: "Other Supplier" })]);
    expect(summary).toEqual({ suppliersUpserted: 2 });
    expect(upserts.suppliers).toHaveLength(2);
    expect(upserts.suppliers[0]).toMatchObject({ org_id: "org1", name: "ABC Suppliers" });
  });

  it("parses True/False contact flags into real booleans", async () => {
    const { db, upserts } = createFakeDb();
    await commitSupplierRows(db, "org1", [row({ ContactDefault: "True", ContactIncludeInEmail: "true" })]);
    expect(upserts.suppliers[0]).toMatchObject({ contact_default: true, contact_include_in_email: true });
  });
});
