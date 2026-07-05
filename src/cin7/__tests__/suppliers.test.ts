import { describe, expect, it } from "vitest";
import {
  toCin7SupplierPayload,
  type CanonicalSupplierAddressRow,
  type CanonicalSupplierContactRow,
  type CanonicalSupplierRow,
} from "@/cin7/suppliers";

function supplier(overrides: Partial<CanonicalSupplierRow>): CanonicalSupplierRow {
  return {
    name: "ABC Suppliers",
    status: "Active",
    currency: "ZAR",
    payment_term: "120 days",
    tax_rule: "Standard Rate Purchases",
    account_payable: "800",
    discount: 0,
    tax_number: null,
    attribute_set: null,
    additional_attribute_1: null,
    additional_attribute_2: null,
    additional_attribute_3: null,
    additional_attribute_4: null,
    additional_attribute_5: null,
    additional_attribute_6: null,
    additional_attribute_7: null,
    additional_attribute_8: null,
    additional_attribute_9: null,
    additional_attribute_10: null,
    comments: null,
    ...overrides,
  };
}

function contact(overrides: Partial<CanonicalSupplierContactRow>): CanonicalSupplierContactRow {
  return {
    contact_name: "Peter Parker",
    job_title: null,
    phone: null,
    mobile_phone: null,
    fax: null,
    email: null,
    website: null,
    contact_comment: null,
    contact_default: false,
    contact_include_in_email: false,
    ...overrides,
  };
}

describe("toCin7SupplierPayload", () => {
  it("never sends Carrier — confirmed absent from Cin7's real Supplier write model", () => {
    const payload = toCin7SupplierPayload(supplier({}));
    expect(payload).not.toHaveProperty("Carrier");
  });

  it("sends blank optional fields as an explicit empty string, not omitted — same blank-clears-field rule as customers", () => {
    const payload = toCin7SupplierPayload(supplier({ attribute_set: null, tax_number: null, comments: null }));
    expect(payload.AttributeSet).toBe("");
    expect(payload.TaxNumber).toBe("");
    expect(payload.Comments).toBe("");
  });

  it("builds Addresses[] with Cin7's real field names, same shape as Customer", () => {
    const address: CanonicalSupplierAddressRow = {
      address_type: "Billing",
      address_default_for_type: true,
      address_line_1: "1 Pear Tree Circle",
      address_line_2: null,
      city: "Epping",
      state: "Western Cape",
      postcode: "8121",
      country: "South Africa",
    };
    const payload = toCin7SupplierPayload(supplier({}), [address]);
    expect(payload.Addresses).toEqual([
      expect.objectContaining({ Line1: "1 Pear Tree Circle", Type: "Billing", DefaultForType: true }),
    ]);
  });

  it("builds a Contacts[] entry without JobTitle — confirmed absent from Cin7's real Supplier contact model", () => {
    const payload = toCin7SupplierPayload(supplier({}), [], [contact({ job_title: "Sales Director" })]);
    expect(payload.Contacts).toEqual([expect.objectContaining({ Name: "Peter Parker" })]);
    expect((payload.Contacts as Record<string, unknown>[])[0]).not.toHaveProperty("JobTitle");
  });

  it("omits Contacts when there's no contact name", () => {
    const payload = toCin7SupplierPayload(supplier({}), [], [contact({ contact_name: null })]);
    expect(payload.Contacts).toBeUndefined();
  });

  it("builds multiple Contacts[] entries — a supplier can have several contacts", () => {
    const payload = toCin7SupplierPayload(supplier({}), [], [contact({ contact_name: "Peter" }), contact({ contact_name: "Mary Jane" })]);
    expect(payload.Contacts).toEqual([
      expect.objectContaining({ Name: "Peter" }),
      expect.objectContaining({ Name: "Mary Jane" }),
    ]);
  });
});
