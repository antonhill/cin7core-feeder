import { describe, expect, it } from "vitest";
import {
  toCin7CustomerPayload,
  type CanonicalCustomerAddressRow,
  type CanonicalCustomerContactRow,
  type CanonicalCustomerRow,
} from "@/cin7/customers";

function customer(overrides: Partial<CanonicalCustomerRow>): CanonicalCustomerRow {
  return {
    name: "Woolworths",
    status: "Active",
    currency: "ZAR",
    payment_term: "Cash",
    tax_rule: "Standard Rate Sales",
    account_receivable: "610",
    sale_account: "200",
    price_tier: "Retail in VAT",
    discount: 10,
    credit_limit: null,
    carrier: "Post",
    sales_representative: "Anton Hill",
    location: null,
    tax_number: "32424324",
    tags: "Trade,Eastern Cape",
    display_name: null,
    is_legal_entity: false,
    is_bill_parent: false,
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

function contact(overrides: Partial<CanonicalCustomerContactRow>): CanonicalCustomerContactRow {
  return {
    contact_name: "Frank",
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

describe("toCin7CustomerPayload", () => {
  it("maps SaleAccount (our column name) to RevenueAccount (Cin7's real field name)", () => {
    const payload = toCin7CustomerPayload(customer({ sale_account: "200" }));
    expect(payload.RevenueAccount).toBe("200");
    expect(payload).not.toHaveProperty("SaleAccount");
  });

  it("sends CreditLimit (Cin7's own CSV docs confirm it's a normal writable field) but still omits IsOnCreditHold/ParentCustomer — those need ID resolution, not push-confirmed", () => {
    const payload = toCin7CustomerPayload(customer({ credit_limit: 5000 }));
    expect(payload.CreditLimit).toBe(5000);
    expect(payload).not.toHaveProperty("IsOnCreditHold");
    expect(payload).not.toHaveProperty("ParentCustomer");
    expect(payload).not.toHaveProperty("CustomerParentID");
  });

  it("sends CreditLimit as 0 (Cin7's own documented blank default) rather than omitting it — a blank field must actively clear whatever Cin7 already has", () => {
    const payload = toCin7CustomerPayload(customer({ credit_limit: null }));
    expect(payload.CreditLimit).toBe(0);
  });

  it("sends CreditLimit 0 verbatim — 0 is a meaningful value (\"not applied\"), not the same as blank", () => {
    const payload = toCin7CustomerPayload(customer({ credit_limit: 0 }));
    expect(payload.CreditLimit).toBe(0);
  });

  it("sends blank optional text fields as an explicit empty string, not omitted — confirmed live 2026-07-06: omitting left a stale DisplayName/AttributeSet in Cin7 that no import had ever set", () => {
    const payload = toCin7CustomerPayload(customer({ display_name: null, attribute_set: null, location: null }));
    expect(payload.DisplayName).toBe("");
    expect(payload.AttributeSet).toBe("");
    expect(payload.Location).toBe("");
  });

  it("omits Addresses/Contacts when there are none", () => {
    const payload = toCin7CustomerPayload(customer({}), [], []);
    expect(payload.Addresses).toBeUndefined();
    expect(payload.Contacts).toBeUndefined();
  });

  it("builds Addresses[] with Cin7's real field names, blank optional lines sent as empty strings", () => {
    const address: CanonicalCustomerAddressRow = {
      address_type: "Billing",
      address_default_for_type: true,
      address_line_1: "1 Tree Lane",
      address_line_2: null,
      city: "Cape Town",
      state: "WC",
      postcode: "8005",
      country: "South Africa",
    };
    const payload = toCin7CustomerPayload(customer({}), [address]);
    expect(payload.Addresses).toEqual([
      {
        Line1: "1 Tree Lane",
        Line2: "",
        City: "Cape Town",
        State: "WC",
        Postcode: "8005",
        Country: "South Africa",
        Type: "Billing",
        DefaultForType: true,
      },
    ]);
  });

  it("builds a Contacts[] entry (including JobTitle) per contact with a name set", () => {
    const withContact = toCin7CustomerPayload(customer({}), [], [contact({ job_title: "Manager", contact_default: true })]);
    expect(withContact.Contacts).toEqual([
      expect.objectContaining({ Name: "Frank", JobTitle: "Manager", Default: true }),
    ]);

    const withoutContact = toCin7CustomerPayload(customer({}), [], [contact({ contact_name: null })]);
    expect(withoutContact.Contacts).toBeUndefined();
  });

  it("builds multiple Contacts[] entries — a customer can have several contacts", () => {
    const payload = toCin7CustomerPayload(customer({}), [], [contact({ contact_name: "John" }), contact({ contact_name: "Frank" })]);
    expect(payload.Contacts).toEqual([
      expect.objectContaining({ Name: "John" }),
      expect.objectContaining({ Name: "Frank" }),
    ]);
  });
});
