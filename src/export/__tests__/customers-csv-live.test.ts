import { describe, expect, it } from "vitest";
import { toFullCustomersCsv } from "@/export/customers-csv-live";

const LIVE_CUSTOMER = {
  Name: "Woolworths",
  Status: "Active",
  Currency: "ZAR",
  PaymentTerm: "Cash",
  TaxRule: "Standard Rate Sales",
  AccountReceivable: "610",
  RevenueAccount: "200",
  PriceTier: "Retail in VAT",
  Discount: 5,
  CreditLimit: 1000,
  Carrier: "Post",
  SalesRepresentative: "Anton Hill",
  Location: "Main Warehouse",
  TaxNumber: "32424324",
  Tags: "vip",
  DisplayName: "Woolies",
  IsLegalEntity: false,
  IsBillParent: false,
  AttributeSet: "",
  Comments: "",
  Contacts: [
    { Name: "Frank", JobTitle: "Buyer", Phone: "0123456", Email: "frank@example.com", Default: true, IncludeInEmail: true },
  ],
};

describe("toFullCustomersCsv", () => {
  it("includes the exact Customers template header", () => {
    const csv = toFullCustomersCsv([]);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      '"Name","Status","Currency","PaymentTerm","TaxRule","AccountReceivable","SaleAccount","PriceTier","Discount","CreditLimit","Carrier","SalesRepresentative","Location","TaxNumber","Tags","DisplayName","IsLegalEntity","ParentCustomer","IsBillParent","AttributeSet","AdditionalAttribute1","AdditionalAttribute2","AdditionalAttribute3","AdditionalAttribute4","AdditionalAttribute5","AdditionalAttribute6","AdditionalAttribute7","AdditionalAttribute8","AdditionalAttribute9","AdditionalAttribute10","Comments","ContactName","JobTitle","Phone","MobilePhone","Fax","Email","Website","ContactComment","ContactDefault","ContactIncludeInEmail","MarketingConsent","IsAccountingDimensionEnabled","DimensionAttribute1","DimensionAttribute2","DimensionAttribute3","DimensionAttribute4","DimensionAttribute5","DimensionAttribute6","DimensionAttribute7","DimensionAttribute8","DimensionAttribute9","DimensionAttribute10"'
    );
  });

  it("maps RevenueAccount (Cin7's real field) to the SaleAccount CSV column", () => {
    const csv = toFullCustomersCsv([LIVE_CUSTOMER]);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toContain('"200"');
  });

  it("emits one row per contact", () => {
    const twoContacts = { ...LIVE_CUSTOMER, Contacts: [{ Name: "Frank" }, { Name: "John" }] };
    const csv = toFullCustomersCsv([twoContacts]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 contact rows
    expect(lines[1]).toContain('"Frank"');
    expect(lines[2]).toContain('"John"');
  });

  it("emits one row with blank contact fields when there are no contacts", () => {
    const noContacts = { ...LIVE_CUSTOMER, Contacts: [] };
    const csv = toFullCustomersCsv([noContacts]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[1]).toContain('"Woolworths"');
  });

  it("leaves ParentCustomer and MarketingConsent blank — no confirmed mapping", () => {
    const csv = toFullCustomersCsv([LIVE_CUSTOMER]);
    const dataLine = csv.split("\r\n")[1];
    const cols = dataLine.split('","').map((c) => c.replace(/^"|"$/g, ""));
    expect(cols[17]).toBe(""); // ParentCustomer
    expect(cols[41]).toBe(""); // MarketingConsent
  });
});
