import { describe, expect, it } from "vitest";
import {
  checkBlankAddressLine1,
  checkBlankCountry,
  checkBlankCustomerAccountCodes,
  checkBlankCustomerRequiredFields,
  checkBlankSupplierAccountPayable,
  checkBlankSupplierRequiredFields,
  checkContactMissingName,
  checkDuplicateProductSkus,
  checkFixedAssetType,
  checkMultipleDefaultAddresses,
  checkMultipleDefaultContacts,
  checkProductBooleanFields,
  checkProductEnumFields,
} from "@/import/warnings";
import type { ParsedRow } from "@/import/csv";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";
import type { CustomerCsvRow } from "@/model/customers";
import type { SupplierCsvRow } from "@/model/suppliers";
import type { ProductCsvRow } from "@/model/products";

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

describe("checkBlankAddressLine1", () => {
  it("warns when AddressLine1 is blank", () => {
    const rows = [parsedRow(1, supplierAddress({ AddressLine1: "" })), parsedRow(2, supplierAddress({}))];
    const warnings = checkBlankAddressLine1(rows);
    expect(warnings).toEqual([{ rowNumber: 1, message: '"ABC Suppliers" (Billing): AddressLine1 is blank' }]);
  });

  it("does not warn when AddressLine1 is set", () => {
    expect(checkBlankAddressLine1([parsedRow(1, supplierAddress({}))])).toEqual([]);
  });
});

describe("checkMultipleDefaultAddresses", () => {
  it("warns on every row when two Billing addresses for the same Name are both flagged default", () => {
    const rows = [
      parsedRow(1, supplierAddress({ AddressDefaultForType: "True" })),
      parsedRow(2, supplierAddress({ AddressDefaultForType: "True" })),
    ];
    const warnings = checkMultipleDefaultAddresses(rows);
    expect(warnings).toEqual([
      { rowNumber: 1, message: '"ABC Suppliers" (Billing): more than one address is flagged default for this type (rows 1, 2) — only one should be' },
      { rowNumber: 2, message: '"ABC Suppliers" (Billing): more than one address is flagged default for this type (rows 1, 2) — only one should be' },
    ]);
  });

  it("does not warn when only one address of a type is flagged default", () => {
    const rows = [
      parsedRow(1, supplierAddress({ AddressDefaultForType: "True" })),
      parsedRow(2, supplierAddress({ AddressDefaultForType: "False" })),
    ];
    expect(checkMultipleDefaultAddresses(rows)).toEqual([]);
  });

  it("does not warn when two defaults are for different address types", () => {
    const rows = [
      parsedRow(1, supplierAddress({ AddressType: "Billing", AddressDefaultForType: "True" })),
      parsedRow(2, supplierAddress({ AddressType: "Shipping", AddressDefaultForType: "True" })),
    ];
    expect(checkMultipleDefaultAddresses(rows)).toEqual([]);
  });

  it("does not warn when two defaults are for different Names", () => {
    const rows = [
      parsedRow(1, supplierAddress({ Name: "ABC Suppliers", AddressDefaultForType: "True" })),
      parsedRow(2, supplierAddress({ Name: "XYZ Suppliers", AddressDefaultForType: "True" })),
    ];
    expect(checkMultipleDefaultAddresses(rows)).toEqual([]);
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

describe("checkBlankSupplierRequiredFields", () => {
  it("warns for each of PaymentTerm/TaxRule that's blank — Cin7's own docs list these as required for suppliers", () => {
    const warnings = checkBlankSupplierRequiredFields([parsedRow(4, supplierRow({ PaymentTerm: "", TaxRule: "" }))]);
    expect(warnings).toEqual([
      { rowNumber: 4, message: '"ABC Suppliers": PaymentTerm is blank — Cin7 requires this for suppliers' },
      { rowNumber: 4, message: '"ABC Suppliers": TaxRule is blank — Cin7 requires this for suppliers' },
    ]);
  });

  it("does not warn when both are set", () => {
    expect(checkBlankSupplierRequiredFields([parsedRow(1, supplierRow({}))])).toEqual([]);
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

function productRow(overrides: Partial<ProductCsvRow>): ProductCsvRow {
  return {
    ProductCode: "SKU-1",
    Name: "Widget",
    Category: "",
    Brand: "",
    Type: "",
    FixedAssetType: "",
    CostingMethod: "FIFO",
    WeightUnits: "",
    DimensionUnits: "",
    Barcode: "",
    DefaultLocation: "",
    LastSuppliedBy: "",
    SupplierProductCode: "",
    SupplierProductName: "",
    DefaultUnitOfMeasure: "",
    Status: "",
    Description: "",
    PurchaseTaxRule: "",
    SaleTaxRule: "",
    AutoAssemble: "",
    AutoDisassemble: "",
    DropShip: "",
    DropShipSupplier: "",
    InventoryAccount: "",
    RevenueAccount: "",
    ExpenseAccount: "",
    COGSAccount: "",
    ProductAttributeSet: "",
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
    DiscountName: "",
    ProductFamilySKU: "",
    ProductFamilyName: "",
    ProductFamilyOption1Name: "",
    ProductFamilyOption1Value: "",
    ProductFamilyOption2Name: "",
    ProductFamilyOption2Value: "",
    ProductFamilyOption3Name: "",
    ProductFamilyOption3Value: "",
    CommaDelimitedTags: "",
    StockLocator: "",
    ShortDescription: "",
    Sellable: "",
    PickZones: "",
    WarrantySetupName: "",
    InternalNote: "",
    MakeToOrderBom: "",
    IsAccountingDimensionEnabled: "",
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
    HSCode: "",
    CountryOfOrigin: "",
    ...overrides,
  };
}

describe("checkProductEnumFields", () => {
  it("does not warn when all fields are blank or valid", () => {
    const rows = [
      parsedRow(1, productRow({ CostingMethod: "FIFO - Batch", Type: "Service", DropShip: "Always Drop Ship", Status: "Deprecated" })),
      parsedRow(2, productRow({ CostingMethod: "", Type: "", DropShip: "", Status: "" })),
    ];
    expect(checkProductEnumFields(rows)).toEqual([]);
  });

  it("warns on an unrecognized CostingMethod", () => {
    const warnings = checkProductEnumFields([parsedRow(1, productRow({ CostingMethod: "Fifoo" }))]);
    expect(warnings).toEqual([{ rowNumber: 1, message: '"Widget": CostingMethod "Fifoo" is not a recognized value' }]);
  });

  it("warns on an unrecognized Type", () => {
    const warnings = checkProductEnumFields([parsedRow(1, productRow({ Type: "Sotck" }))]);
    expect(warnings).toEqual([{ rowNumber: 1, message: '"Widget": Type "Sotck" is not a recognized value (expected Stock, Service or Fixed Asset)' }]);
  });

  it("does not warn on the code-supported legacy Type values Non-Inventory/BillOfMaterials", () => {
    const rows = [parsedRow(1, productRow({ Type: "Non-Inventory" })), parsedRow(2, productRow({ Type: "BillOfMaterials" }))];
    expect(checkProductEnumFields(rows)).toEqual([]);
  });

  it("warns on an unrecognized DropShip value", () => {
    const warnings = checkProductEnumFields([parsedRow(1, productRow({ DropShip: "Sometimes" }))]);
    expect(warnings).toEqual([
      { rowNumber: 1, message: '"Widget": DropShip "Sometimes" is not a recognized value (expected No Drop Ship, Optional Drop Ship or Always Drop Ship)' },
    ]);
  });

  it("warns on an unrecognized Status value", () => {
    const warnings = checkProductEnumFields([parsedRow(1, productRow({ Status: "Discontinued" }))]);
    expect(warnings).toEqual([{ rowNumber: 1, message: '"Widget": Status "Discontinued" is not a recognized value (expected Active or Deprecated)' }]);
  });

  it("does not warn on a real Cin7 export's casing — confirmed live 2026-07-06: an InventoryList export renders Status as \"ACTIVE\" (all caps), not the \"Active\" its own field docs claim", () => {
    const rows = [
      parsedRow(1, productRow({ Status: "ACTIVE" })),
      parsedRow(2, productRow({ Status: "active" })),
      parsedRow(3, productRow({ CostingMethod: "fifo" })),
      parsedRow(4, productRow({ Type: "STOCK" })),
      parsedRow(5, productRow({ DropShip: "no drop ship" })),
    ];
    expect(checkProductEnumFields(rows)).toEqual([]);
  });
});

describe("checkProductBooleanFields", () => {
  it("does not warn for Yes/No or True/False, case-insensitively", () => {
    const rows = [
      parsedRow(1, productRow({ AutoAssemble: "Yes", AutoDisassemble: "no", Sellable: "TRUE" })),
      parsedRow(2, productRow({ AutoAssemble: "false", AutoDisassemble: "", Sellable: "" })),
    ];
    expect(checkProductBooleanFields(rows)).toEqual([]);
  });

  it("warns on an unrecognized value", () => {
    const warnings = checkProductBooleanFields([parsedRow(1, productRow({ Sellable: "Y" }))]);
    expect(warnings).toEqual([{ rowNumber: 1, message: '"Widget": Sellable "Y" is not a recognized value (expected Yes/No or True/False)' }]);
  });
});

describe("checkFixedAssetType", () => {
  it("warns when Type is Fixed Asset but FixedAssetType is blank", () => {
    const warnings = checkFixedAssetType([parsedRow(1, productRow({ Type: "Fixed Asset", FixedAssetType: "" }))]);
    expect(warnings).toEqual([
      { rowNumber: 1, message: '"Widget": Type is "Fixed Asset" but FixedAssetType is blank — Cin7 requires this for fixed assets' },
    ]);
  });

  it("warns when FixedAssetType is set but Type isn't Fixed Asset", () => {
    const warnings = checkFixedAssetType([parsedRow(1, productRow({ Type: "Stock", FixedAssetType: "Vehicle" }))]);
    expect(warnings).toEqual([
      { rowNumber: 1, message: '"Widget": FixedAssetType is set but Type is "Stock", not Fixed Asset — Cin7 expects this blank for non-fixed-asset products' },
    ]);
  });

  it("treats a blank Type as the Stock default when deciding whether FixedAssetType should be blank", () => {
    const warnings = checkFixedAssetType([parsedRow(1, productRow({ Type: "", FixedAssetType: "Vehicle" }))]);
    expect(warnings).toEqual([
      { rowNumber: 1, message: '"Widget": FixedAssetType is set but Type is "Stock", not Fixed Asset — Cin7 expects this blank for non-fixed-asset products' },
    ]);
  });

  it("does not warn when Type is Fixed Asset and FixedAssetType is set", () => {
    expect(checkFixedAssetType([parsedRow(1, productRow({ Type: "Fixed Asset", FixedAssetType: "Vehicle" }))])).toEqual([]);
  });

  it("does not warn when Type is Stock and FixedAssetType is blank", () => {
    expect(checkFixedAssetType([parsedRow(1, productRow({ Type: "Stock", FixedAssetType: "" }))])).toEqual([]);
  });
});

describe("checkDuplicateProductSkus", () => {
  it("warns on every row when a ProductCode appears more than once", () => {
    const rows = [
      parsedRow(1, productRow({ ProductCode: "SKU-1" })),
      parsedRow(2, productRow({ ProductCode: "SKU-2" })),
      parsedRow(3, productRow({ ProductCode: "SKU-1" })),
    ];
    const warnings = checkDuplicateProductSkus(rows);
    expect(warnings).toEqual([
      { rowNumber: 1, message: 'ProductCode "SKU-1" appears 2 times in this file (rows 1, 3) — only the last one was kept' },
      { rowNumber: 3, message: 'ProductCode "SKU-1" appears 2 times in this file (rows 1, 3) — only the last one was kept' },
    ]);
  });

  it("does not warn when every ProductCode is unique", () => {
    const rows = [parsedRow(1, productRow({ ProductCode: "SKU-1" })), parsedRow(2, productRow({ ProductCode: "SKU-2" }))];
    expect(checkDuplicateProductSkus(rows)).toEqual([]);
  });
});

describe("checkMultipleDefaultContacts", () => {
  it("warns on every row when two contacts for the same Name are both flagged default — contacts have no Type, unlike addresses", () => {
    const rows = [
      parsedRow(1, customerRow({ ContactName: "Frank", ContactDefault: "True" })),
      parsedRow(2, customerRow({ ContactName: "John", ContactDefault: "True" })),
    ];
    const warnings = checkMultipleDefaultContacts(rows);
    expect(warnings).toEqual([
      { rowNumber: 1, message: '"Woolworths": more than one contact is flagged default (rows 1, 2) — only one should be' },
      { rowNumber: 2, message: '"Woolworths": more than one contact is flagged default (rows 1, 2) — only one should be' },
    ]);
  });

  it("does not warn when only one contact is flagged default", () => {
    const rows = [
      parsedRow(1, customerRow({ ContactName: "Frank", ContactDefault: "True" })),
      parsedRow(2, customerRow({ ContactName: "John", ContactDefault: "False" })),
    ];
    expect(checkMultipleDefaultContacts(rows)).toEqual([]);
  });

  it("does not warn when two defaults are for different Names", () => {
    const rows = [
      parsedRow(1, customerRow({ Name: "Woolworths", ContactName: "Frank", ContactDefault: "True" })),
      parsedRow(2, customerRow({ Name: "Pick n Pay", ContactName: "John", ContactDefault: "True" })),
    ];
    expect(checkMultipleDefaultContacts(rows)).toEqual([]);
  });

  it("works for Suppliers too — same contact column shape", () => {
    const rows = [
      parsedRow(1, supplierRow({ ContactName: "Peter", ContactDefault: "True" })),
      parsedRow(2, supplierRow({ ContactName: "Mary", ContactDefault: "True" })),
    ];
    const warnings = checkMultipleDefaultContacts(rows);
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toContain('"ABC Suppliers"');
  });
});
