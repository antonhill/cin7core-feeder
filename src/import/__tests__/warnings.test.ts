import { describe, expect, it } from "vitest";
import {
  checkBlankCountry,
  checkBlankCustomerAccountCodes,
  checkBlankCustomerRequiredFields,
  checkBlankSupplierAccountPayable,
  checkContactMissingName,
} from "@/import/warnings";
import type { ParsedRow } from "@/import/csv";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";
import type { CustomerCsvRow } from "@/model/customers";
import type { SupplierCsvRow } from "@/model/suppliers";

function parsedRow<T>(rowNumber: number, data: T): ParsedRow<T> {
  return { rowNumber, raw: {}, data };
}

function supplierAddress(overrides: Partial<SupplierAddressCsvRow>): SupplierAddressCsvRow {
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

describe("checkBlankCountry", () => {
  it("warns when Country is blank", () => {
    const rows = [parsedRow(1, supplierAddress({ Country: "" })), parsedRow(2, supplierAddress({}))];
    const warnings = checkBlankCountry(rows);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ rowNumber: 1 });
    expect(warnings[0].message).toContain("Country is blank");
  });

  it("does not warn when Country is set", () => {
    expect(checkBlankCountry([parsedRow(1, supplierAddress({}))])).toEqual([]);
  });
});

function supplierRow(overrides: Partial<SupplierCsvRow>): SupplierCsvRow {
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

describe("checkBlankSupplierAccountPayable", () => {
  it("warns when AccountPayable is blank", () => {
    const warnings = checkBlankSupplierAccountPayable([parsedRow(3, supplierRow({ AccountPayable: "" }))]);
    expect(warnings).toEqual([{ rowNumber: 3, message: '"ABC Suppliers": AccountPayable is blank' }]);
  });

  it("does not warn when AccountPayable is set — existence against a real instance is a push-time check, not import-time", () => {
    expect(checkBlankSupplierAccountPayable([parsedRow(1, supplierRow({ AccountPayable: "999-does-not-exist" }))])).toEqual([]);
  });
});

function customerRow(overrides: Partial<CustomerCsvRow>): CustomerCsvRow {
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
    Tags: "",
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

describe("checkBlankCustomerAccountCodes", () => {
  it("warns separately for AccountReceivable and SaleAccount when either is blank", () => {
    const warnings = checkBlankCustomerAccountCodes([parsedRow(5, customerRow({ AccountReceivable: "", SaleAccount: "" }))]);
    expect(warnings).toEqual([
      { rowNumber: 5, message: '"Woolworths": AccountReceivable is blank' },
      { rowNumber: 5, message: '"Woolworths": SaleAccount is blank' },
    ]);
  });

  it("does not warn when both are set", () => {
    expect(checkBlankCustomerAccountCodes([parsedRow(1, customerRow({}))])).toEqual([]);
  });
});

describe("checkBlankCustomerRequiredFields", () => {
  it("warns for each of PaymentTerm/TaxRule/PriceTier that's blank — Cin7's own docs list these as required", () => {
    const warnings = checkBlankCustomerRequiredFields([
      parsedRow(4, customerRow({ PaymentTerm: "", TaxRule: "", PriceTier: "" })),
    ]);
    expect(warnings).toEqual([
      { rowNumber: 4, message: '"Woolworths": PaymentTerm is blank — Cin7 requires this for customers' },
      { rowNumber: 4, message: '"Woolworths": TaxRule is blank — Cin7 requires this for customers' },
      { rowNumber: 4, message: '"Woolworths": PriceTier is blank — Cin7 requires this for customers' },
    ]);
  });

  it("does not warn when all three are set", () => {
    expect(checkBlankCustomerRequiredFields([parsedRow(1, customerRow({}))])).toEqual([]);
  });
});

describe("checkContactMissingName", () => {
  it("warns when contact details are present but ContactName is blank — Cin7 rejects a nameless contact, and it's silently dropped on commit", () => {
    const warnings = checkContactMissingName([
      parsedRow(7, customerRow({ ContactName: "", Email: "joe@example.com" })),
    ]);
    expect(warnings).toEqual([
      {
        rowNumber: 7,
        message: '"Woolworths": has contact details (e.g. Email/Phone) but no ContactName — Cin7 requires a name for a contact, so this contact will be dropped',
      },
    ]);
  });

  it("does not warn when ContactName is set", () => {
    expect(
      checkContactMissingName([parsedRow(1, customerRow({ ContactName: "Frank", Email: "frank@example.com" }))])
    ).toEqual([]);
  });

  it("does not warn when there's no contact detail at all — a blank ContactName with nothing else is just no contact for this row", () => {
    expect(checkContactMissingName([parsedRow(1, customerRow({ ContactName: "" }))])).toEqual([]);
  });

  it("works for Suppliers too — same contact column shape", () => {
    const warnings = checkContactMissingName([
      parsedRow(2, supplierRow({ ContactName: "", Phone: "0123456" })),
    ]);
    expect(warnings).toEqual([
      {
        rowNumber: 2,
        message: '"ABC Suppliers": has contact details (e.g. Email/Phone) but no ContactName — Cin7 requires a name for a contact, so this contact will be dropped',
      },
    ]);
  });
});
