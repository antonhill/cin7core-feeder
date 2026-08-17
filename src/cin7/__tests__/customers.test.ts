import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  toCin7CustomerPayload,
  fetchAllCustomers,
  pushCustomer,
  type CanonicalCustomerAddressRow,
  type CanonicalCustomerContactRow,
  type CanonicalCustomerRow,
} from "@/cin7/customers";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

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

describe("fetchAllCustomers", () => {
  it("paginates until a short page signals the end", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ Name: `Customer ${i}` }));
    const page2 = [{ Name: "Last Customer" }];
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CustomerList: page1 })
      .mockResolvedValueOnce({ CustomerList: page2 });

    const all = await fetchAllCustomers(creds);

    expect(all).toHaveLength(1001);
    expect(cin7Request).toHaveBeenCalledTimes(2);
    expect(cin7Request).toHaveBeenNthCalledWith(1, creds, "/customer", { query: { page: 1, limit: 1000 } });
    expect(cin7Request).toHaveBeenNthCalledWith(2, creds, "/customer", { query: { page: 2, limit: 1000 } });
  });

  it("stops after a single short page", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ CustomerList: [{ Name: "Only One" }] });
    const all = await fetchAllCustomers(creds);
    expect(all).toEqual([{ Name: "Only One" }]);
    expect(cin7Request).toHaveBeenCalledTimes(1);
  });
});

describe("pushCustomer Phase 3.2 fast path", () => {
  it("PUTs to a known Cin7 ID and skips the find-by-Name GET", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ ID: "known-id" }); // PUT
    const result = await pushCustomer(creds, customer({ name: "Acme" }), [], [], "known-id");
    expect(result).toEqual({ cin7Id: "known-id", status: "updated" });
    expect(cin7Request).toHaveBeenCalledTimes(1);
    const [, path, options] = vi.mocked(cin7Request).mock.calls[0];
    expect(path).toBe("/customer");
    expect(options).toMatchObject({ method: "PUT", body: expect.objectContaining({ ID: "known-id" }) });
  });

  it("uses the find-by-Name path when no known ID is provided (unchanged behaviour)", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CustomerList: [] }) // findCustomerByName → not found
      .mockResolvedValueOnce({ ID: "new-id" }); // POST create
    const result = await pushCustomer(creds, customer({ name: "Acme" }));
    expect(result).toEqual({ cin7Id: "new-id", status: "created" });
    expect(cin7Request).toHaveBeenCalledTimes(2);
  });

  it("security re-audit round 3, item 2: the create POST sets nonIdempotentCreate — no blind auto-retry on an ambiguous network failure", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ CustomerList: [] }) // findCustomerByName → not found
      .mockResolvedValueOnce({ ID: "new-id" }); // POST create
    await pushCustomer(creds, customer({ name: "Acme" }));
    const [, , createOptions] = vi.mocked(cin7Request).mock.calls[1];
    expect(createOptions).toMatchObject({ method: "POST", nonIdempotentCreate: true });
  });
});
