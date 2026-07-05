import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedRow } from "@/import/csv";
import { checkSupplierAddressReferences, checkCustomerAddressReferences } from "@/import/validate-address-references";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";
import type { CustomerAddressCsvRow } from "@/model/customer-addresses";

/** Minimal stand-in for the one query shape findMissingCustomerNames/findMissingSupplierNames actually issue. */
function fakeDb(existingNames: string[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: (_col: string, names: string[]) =>
            Promise.resolve({
              data: names.filter((n) => existingNames.includes(n)).map((name) => ({ name })),
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function supplierAddressRow(overrides: Partial<SupplierAddressCsvRow>, rowNumber = 1): ParsedRow<SupplierAddressCsvRow> {
  const data: SupplierAddressCsvRow = {
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
  return { rowNumber, raw: data as Record<string, unknown>, data };
}

function customerAddressRow(overrides: Partial<CustomerAddressCsvRow>, rowNumber = 1): ParsedRow<CustomerAddressCsvRow> {
  const data: CustomerAddressCsvRow = {
    Action: "Create/Update",
    Name: "Woolworths",
    AddressType: "Billing",
    AddressDefaultForType: "True",
    AddressLine1: "1 Tree Lane",
    AddressLine2: "",
    City: "Cape Town",
    State: "WC",
    Postcode: "8005",
    Country: "South Africa",
    IsParent: "",
    ...overrides,
  };
  return { rowNumber, raw: data as Record<string, unknown>, data };
}

describe("checkSupplierAddressReferences", () => {
  it("passes a row whose Name matches an existing supplier", async () => {
    const db = fakeDb(["ABC Suppliers"]);
    const { valid, invalid } = await checkSupplierAddressReferences(db, "org1", [supplierAddressRow({})]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it("rejects a row whose Name doesn't match an existing supplier", async () => {
    const db = fakeDb([]);
    const { valid, invalid } = await checkSupplierAddressReferences(db, "org1", [supplierAddressRow({})]);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors[0]).toMatch(/Name "ABC Suppliers" does not match an existing supplier/);
  });
});

describe("checkCustomerAddressReferences", () => {
  it("passes a row whose Name matches an existing customer", async () => {
    const db = fakeDb(["Woolworths"]);
    const { valid, invalid } = await checkCustomerAddressReferences(db, "org1", [customerAddressRow({})]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it("rejects a row whose Name doesn't match an existing customer", async () => {
    const db = fakeDb([]);
    const { valid, invalid } = await checkCustomerAddressReferences(db, "org1", [customerAddressRow({})]);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors[0]).toMatch(/Name "Woolworths" does not match an existing customer/);
  });
});
