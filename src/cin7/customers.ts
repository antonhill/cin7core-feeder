import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

export interface CanonicalCustomerRow {
  name: string;
  status: string | null;
  currency: string | null;
  payment_term: string | null;
  tax_rule: string | null;
  account_receivable: string | null;
  sale_account: string | null;
  price_tier: string | null;
  discount: number | null;
  credit_limit: number | null;
  carrier: string | null;
  sales_representative: string | null;
  location: string | null;
  tax_number: string | null;
  tags: string | null;
  display_name: string | null;
  is_legal_entity: boolean;
  is_bill_parent: boolean;
  attribute_set: string | null;
  additional_attribute_1: string | null;
  additional_attribute_2: string | null;
  additional_attribute_3: string | null;
  additional_attribute_4: string | null;
  additional_attribute_5: string | null;
  additional_attribute_6: string | null;
  additional_attribute_7: string | null;
  additional_attribute_8: string | null;
  additional_attribute_9: string | null;
  additional_attribute_10: string | null;
  comments: string | null;
}

export interface CanonicalCustomerAddressRow {
  address_type: string;
  address_default_for_type: boolean;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
}

export interface CanonicalCustomerContactRow {
  contact_name: string | null;
  job_title: string | null;
  phone: string | null;
  mobile_phone: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  contact_comment: string | null;
  contact_default: boolean;
  contact_include_in_email: boolean;
}

/**
 * Field mapping confirmed live 2026-07-04 against Cin7's real /customer
 * response (see docs/cin7-api-findings.md §10) — `SaleAccount` (our CSV/DB
 * column name) is `RevenueAccount` on Cin7's side. `CreditLimit` is now sent
 * — Cin7's own Customers CSV template docs (pasted by Anton 2026-07-05) list
 * it as a normal optional numeric field, superseding the earlier "unconfirmed,
 * held back" note. `IsOnCreditHold` and `ParentCustomer` (→ `CustomerParentID`)
 * remain held back: unlike CreditLimit they need a value transformation
 * (name → ID resolution, or a different write path entirely), not just a
 * straight pass-through, so still unconfirmed. `IsAccountingDimensionEnabled`/
 * `DimensionAttribute*` don't appear in Cin7's request model at all —
 * capture-only, never sent. `MarketingConsent` is a Cin7-side integer with
 * no confirmed mapping from our CSV's text values — also held back.
 *
 * Blank-clears-field rule (confirmed by Anton 2026-07-06, testing against a
 * real customer): every optional field is sent explicitly (`""` for text,
 * `0` for numbers) rather than omitted when blank. A prior version omitted a
 * blank field entirely (`|| undefined`, dropped by JSON.stringify), which
 * left Cin7 holding whatever value it already had — confirmed live as the
 * cause of a customer showing a DisplayName/AttributeSet ("Joe"/"Area") that
 * had never been in any import, surviving every later push untouched. A
 * blank field is now a deliberate instruction to clear, not "leave alone."
 */
export function toCin7CustomerPayload(
  customer: CanonicalCustomerRow,
  addresses: CanonicalCustomerAddressRow[] = [],
  contacts: CanonicalCustomerContactRow[] = []
) {
  const payload: Record<string, unknown> = {
    Name: customer.name,
    Status: customer.status || "Active",
    Currency: customer.currency ?? "",
    PaymentTerm: customer.payment_term ?? "",
    TaxRule: customer.tax_rule ?? "",
    AccountReceivable: customer.account_receivable ?? "",
    RevenueAccount: customer.sale_account ?? "",
    PriceTier: customer.price_tier ?? "",
    Discount: customer.discount ?? 0,
    CreditLimit: customer.credit_limit ?? 0,
    Carrier: customer.carrier ?? "",
    SalesRepresentative: customer.sales_representative ?? "",
    Location: customer.location ?? "",
    TaxNumber: customer.tax_number ?? "",
    Tags: customer.tags ?? "",
    DisplayName: customer.display_name ?? "",
    IsLegalEntity: customer.is_legal_entity,
    IsBillParent: customer.is_bill_parent,
    AttributeSet: customer.attribute_set ?? "",
    AdditionalAttribute1: customer.additional_attribute_1 ?? "",
    AdditionalAttribute2: customer.additional_attribute_2 ?? "",
    AdditionalAttribute3: customer.additional_attribute_3 ?? "",
    AdditionalAttribute4: customer.additional_attribute_4 ?? "",
    AdditionalAttribute5: customer.additional_attribute_5 ?? "",
    AdditionalAttribute6: customer.additional_attribute_6 ?? "",
    AdditionalAttribute7: customer.additional_attribute_7 ?? "",
    AdditionalAttribute8: customer.additional_attribute_8 ?? "",
    AdditionalAttribute9: customer.additional_attribute_9 ?? "",
    AdditionalAttribute10: customer.additional_attribute_10 ?? "",
    Comments: customer.comments ?? "",
  };

  if (addresses.length) {
    payload.Addresses = addresses.map((a) => ({
      Line1: a.address_line_1 ?? "",
      Line2: a.address_line_2 ?? "",
      City: a.city ?? "",
      State: a.state ?? "",
      Postcode: a.postcode ?? "",
      Country: a.country ?? "",
      Type: a.address_type,
      DefaultForType: a.address_default_for_type,
    }));
  }

  const namedContacts = contacts.filter((c) => c.contact_name);
  if (namedContacts.length) {
    payload.Contacts = namedContacts.map((c) => ({
      Name: c.contact_name,
      JobTitle: c.job_title ?? "",
      Phone: c.phone ?? "",
      MobilePhone: c.mobile_phone ?? "",
      Fax: c.fax ?? "",
      Email: c.email ?? "",
      Website: c.website ?? "",
      Comment: c.contact_comment ?? "",
      Default: c.contact_default,
      IncludeInEmail: c.contact_include_in_email,
    }));
  }

  return payload;
}

interface Cin7CustomerListResponse {
  CustomerList?: { ID: string; Name?: string }[];
}
type Cin7CustomerResponse = { ID?: string } & Cin7CustomerListResponse;

export async function findCustomerByName(creds: Cin7Credentials, name: string): Promise<{ id: string } | null> {
  const response = await cin7Request<Cin7CustomerListResponse>(creds, "/customer", {
    query: { Name: name, page: 1, limit: 1 },
  });
  const first = response.CustomerList?.[0];
  if (!first || first.Name !== name) return null;
  return { id: first.ID };
}

function requireId(response: Cin7CustomerResponse, action: string): string {
  const id = response.ID ?? response.CustomerList?.[0]?.ID;
  if (!id) throw new Error(`${action} response had no ID field — raw response: ${JSON.stringify(response).slice(0, 500)}`);
  return id;
}

export type CustomerPushStatus = "created" | "updated";

/** Create-or-update a customer by Name — Cin7 has no single upsert call, same as Product. */
export async function pushCustomer(
  creds: Cin7Credentials,
  customer: CanonicalCustomerRow,
  addresses: CanonicalCustomerAddressRow[] = [],
  contacts: CanonicalCustomerContactRow[] = []
): Promise<{ cin7Id: string; status: CustomerPushStatus }> {
  const payload = toCin7CustomerPayload(customer, addresses, contacts);
  const existing = await findCustomerByName(creds, customer.name);

  if (existing) {
    const updated = await cin7Request<Cin7CustomerResponse>(creds, "/customer", {
      method: "PUT",
      body: { ID: existing.id, ...payload },
    });
    return { cin7Id: requireId(updated, "PUT /customer"), status: "updated" };
  }

  const created = await cin7Request<Cin7CustomerResponse>(creds, "/customer", {
    method: "POST",
    body: payload,
  });
  return { cin7Id: requireId(created, "POST /customer"), status: "created" };
}
