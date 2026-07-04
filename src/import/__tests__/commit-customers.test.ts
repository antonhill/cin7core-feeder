import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitCustomerRows } from "@/import/commit-customers";
import type { CustomerCsvRow } from "@/model/customers";

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
  it("upserts customers by name", async () => {
    const { db, upserts } = createFakeDb();
    const summary = await commitCustomerRows(db, "org1", [row({}), row({ Name: "Zawadi" })]);
    expect(summary).toEqual({ customersUpserted: 2 });
    expect(upserts.customers).toHaveLength(2);
    expect(upserts.customers[0]).toMatchObject({ org_id: "org1", name: "Woolworths" });
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
});
