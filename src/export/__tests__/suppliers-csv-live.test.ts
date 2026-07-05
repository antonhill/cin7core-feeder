import { describe, expect, it } from "vitest";
import { toFullSuppliersCsv } from "@/export/suppliers-csv-live";

const LIVE_SUPPLIER = {
  Name: "ABC Suppliers",
  Status: "Active",
  Currency: "ZAR",
  PaymentTerm: "30 days",
  TaxRule: "Standard Rate Purchases",
  AccountPayable: "800",
  Discount: 0,
  TaxNumber: "",
  AttributeSet: "",
  Comments: "",
  Contacts: [{ Name: "Peter", Phone: "0123456", Email: "peter@example.com", Default: true, IncludeInEmail: false }],
};

describe("toFullSuppliersCsv", () => {
  it("includes the exact Suppliers template header", () => {
    const csv = toFullSuppliersCsv([]);
    expect(csv.split("\r\n")[0]).toBe(
      '"Name","Status","Currency","PaymentTerm","TaxRule","AccountPayable","Carrier","Discount","TaxNumber","AttributeSet","AdditionalAttribute1","AdditionalAttribute2","AdditionalAttribute3","AdditionalAttribute4","AdditionalAttribute5","AdditionalAttribute6","AdditionalAttribute7","AdditionalAttribute8","AdditionalAttribute9","AdditionalAttribute10","Comments","ContactName","JobTitle","Phone","MobilePhone","Fax","Email","Website","ContactComment","ContactDefault","ContactIncludeInEmail","IsAccountingDimensionEnabled","DimensionAttribute1","DimensionAttribute2","DimensionAttribute3","DimensionAttribute4","DimensionAttribute5","DimensionAttribute6","DimensionAttribute7","DimensionAttribute8","DimensionAttribute9","DimensionAttribute10"'
    );
  });

  it("maps a real live supplier record's confirmed fields", () => {
    const csv = toFullSuppliersCsv([LIVE_SUPPLIER]);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toContain('"ABC Suppliers"');
    expect(dataLine).toContain('"800"');
    expect(dataLine).toContain('"Peter"');
  });

  it("leaves Carrier and JobTitle blank — confirmed absent from Cin7's real Supplier model", () => {
    const csv = toFullSuppliersCsv([LIVE_SUPPLIER]);
    const dataLine = csv.split("\r\n")[1];
    const cols = dataLine.split('","').map((c) => c.replace(/^"|"$/g, ""));
    expect(cols[6]).toBe(""); // Carrier
    expect(cols[22]).toBe(""); // JobTitle
  });

  it("emits one row with blank contact fields when there are no contacts", () => {
    const csv = toFullSuppliersCsv([{ ...LIVE_SUPPLIER, Contacts: [] }]);
    expect(csv.trim().split("\r\n")).toHaveLength(2); // header + 1 row
  });
});
