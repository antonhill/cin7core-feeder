import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitCustomerRows } from "@/import/commit-customers";
import type { CustomerCsvRow } from "@/model/customers";

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

function row(overrides: Partial<CustomerCsvRow>): CustomerCsvRow {
  return {
    Name: "Woolworths",
    Status: "Active",
    Currency: "ZAR",
    PaymentTerm: "Cash",
    TaxRule: "Standard Rate Sales",
    AccountReceivable: "610",
    SaleAccount: "200",
    PriceTier: "Retail in VAT",
    Carrier: "Post",
    SalesRepresentative: "Anton Hill",
    Location: "",
    TaxNumber: "32424324",
    Tags: "Trade,Eastern Cape",
    DisplayName: "",
    IsLegalEntity: "False",
    ParentCustomer: "",
    IsBillParent: "False",
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
    ContactName: "Frank",
    JobTitle: "",
    Phone: "021454545",
    MobilePhone: "0829877854",
    Fax: "",
    Email: "frank@ww.com",
    Website: "",
    ContactComment: "",
    ContactDefault: "True",
    ContactIncludeInEmail: "True",
    MarketingConsent: "Unknown",
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

describe("commitCustomerRows", () => {
  it("upserts customers by name and their contacts separately", async () => {
    const { db, upserts, inserts } = createFakeDb();
    const summary = await commitCustomerRows(db, "org1", [row({}), row({ Name: "Zawadi" })]);
    expect(summary).toEqual({ customersUpserted: 2, contactsUpserted: 2 });
    expect(upserts.customers).toHaveLength(2);
    expect(upserts.customers[0]).toMatchObject({ org_id: "org1", name: "Woolworths" });
    expect(inserts.customer_contacts).toHaveLength(2);
    expect(inserts.customer_contacts[0]).toMatchObject({ org_id: "org1", name: "Woolworths", contact_name: "Frank" });
  });

  it("keeps CreditLimit with comma thousand-separators intact as a parsed number", async () => {
    const { db, upserts } = createFakeDb();
    await commitCustomerRows(db, "org1", [row({ CreditLimit: 10000 })]);
    expect(upserts.customers[0]).toMatchObject({ credit_limit: 10000 });
  });

  it("parses IsLegalEntity/IsBillParent booleans", async () => {
    const { db, upserts } = createFakeDb();
    await commitCustomerRows(db, "org1", [row({ IsLegalEntity: "True", IsBillParent: "True" })]);
    expect(upserts.customers[0]).toMatchObject({ is_legal_entity: true, is_bill_parent: true });
  });

  it("dedupes multiple rows sharing the same customer Name into one customer upsert, keeping every contact", async () => {
    const { db, upserts, inserts, deleteCalls } = createFakeDb();
    const summary = await commitCustomerRows(db, "org1", [
      row({ Name: "Corefeeder Customer", ContactName: "John" }),
      row({ Name: "Corefeeder Customer", ContactName: "Frank" }),
    ]);
    expect(summary).toEqual({ customersUpserted: 1, contactsUpserted: 2 });
    expect(upserts.customers).toHaveLength(1);
    expect(deleteCalls).toEqual([{ table: "customer_contacts", filters: { org_id: "org1", name: ["Corefeeder Customer"] } }]);
    expect(inserts.customer_contacts.map((c) => c.contact_name)).toEqual(["John", "Frank"]);
  });
});
