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

/**
 * Field mapping confirmed live 2026-07-04 against Cin7's real /customer
 * response (see docs/cin7-api-findings.md §10) — `SaleAccount` (our CSV/DB
 * column name) is `RevenueAccount` on Cin7's side. `CreditLimit`,
 * `IsOnCreditHold`, and `ParentCustomer` (→ `CustomerParentID`) are
 * deliberately omitted: present in Cin7's GET response but absent from the
 * community-sourced write-model docs, so pushing them is unconfirmed and
 * held back per that doc's finding. `IsAccountingDimensionEnabled`/
 * `DimensionAttribute*` don't appear in Cin7's request model at all —
 * capture-only, never sent. `MarketingConsent` is a Cin7-side integer with
 * no confirmed mapping from our CSV's text values — also held back.
 */
export function toCin7CustomerPayload(customer: CanonicalCustomerRow, addresses: CanonicalCustomerAddressRow[] = []) {
  const payload: Record<string, unknown> = {
    Name: customer.name,
    Status: customer.status || "Active",
    Currency: customer.currency || undefined,
    PaymentTerm: customer.payment_term || undefined,
    TaxRule: customer.tax_rule || undefined,
    AccountReceivable: customer.account_receivable || undefined,
    RevenueAccount: customer.sale_account || undefined,
    PriceTier: customer.price_tier || undefined,
    Discount: customer.discount ?? undefined,
    Carrier: customer.carrier || undefined,
    SalesRepresentative: customer.sales_representative || undefined,
    Location: customer.location || undefined,
    TaxNumber: customer.tax_number || undefined,
    Tags: customer.tags || undefined,
    DisplayName: customer.display_name || undefined,
    IsLegalEntity: customer.is_legal_entity,
    IsBillParent: customer.is_bill_parent,
    AttributeSet: customer.attribute_set || undefined,
    AdditionalAttribute1: customer.additional_attribute_1 || undefined,
    AdditionalAttribute2: customer.additional_attribute_2 || undefined,
    AdditionalAttribute3: customer.additional_attribute_3 || undefined,
    AdditionalAttribute4: customer.additional_attribute_4 || undefined,
    AdditionalAttribute5: customer.additional_attribute_5 || undefined,
    AdditionalAttribute6: customer.additional_attribute_6 || undefined,
    AdditionalAttribute7: customer.additional_attribute_7 || undefined,
    AdditionalAttribute8: customer.additional_attribute_8 || undefined,
    AdditionalAttribute9: customer.additional_attribute_9 || undefined,
    AdditionalAttribute10: customer.additional_attribute_10 || undefined,
    Comments: customer.comments || undefined,
  };

  if (addresses.length) {
    payload.Addresses = addresses.map((a) => ({
      Line1: a.address_line_1 || undefined,
      Line2: a.address_line_2 || undefined,
      City: a.city || undefined,
      State: a.state || undefined,
      Postcode: a.postcode || undefined,
      Country: a.country || undefined,
      Type: a.address_type,
      DefaultForType: a.address_default_for_type,
    }));
  }

  if (customer.contact_name) {
    payload.Contacts = [
      {
        Name: customer.contact_name,
        JobTitle: customer.job_title || undefined,
        Phone: customer.phone || undefined,
        MobilePhone: customer.mobile_phone || undefined,
        Fax: customer.fax || undefined,
        Email: customer.email || undefined,
        Website: customer.website || undefined,
        Comment: customer.contact_comment || undefined,
        Default: customer.contact_default,
        IncludeInEmail: customer.contact_include_in_email,
      },
    ];
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
  addresses: CanonicalCustomerAddressRow[] = []
): Promise<{ cin7Id: string; status: CustomerPushStatus }> {
  const payload = toCin7CustomerPayload(customer, addresses);
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
