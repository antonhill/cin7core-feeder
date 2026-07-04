import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

export interface CanonicalSupplierRow {
  name: string;
  status: string | null;
  currency: string | null;
  payment_term: string | null;
  tax_rule: string | null;
  account_payable: string | null;
  discount: number | null;
  tax_number: string | null;
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

export interface CanonicalSupplierAddressRow {
  address_type: string;
  address_default_for_type: boolean;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
}

export interface CanonicalSupplierContactRow {
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
 * Field mapping confirmed live 2026-07-04 against Cin7's real /supplier
 * response (see docs/cin7-api-findings.md §10). Two things our CSV carries
 * that Cin7's Supplier write model does NOT have, confirmed absent from a
 * real live response: `Carrier`, and (unlike Customer contacts) `JobTitle`
 * on a contact — both omitted here rather than sent and silently dropped.
 * `IsAccountingDimensionEnabled`/`DimensionAttribute*` aren't in Cin7's
 * request model at all — capture-only, never sent.
 */
export function toCin7SupplierPayload(
  supplier: CanonicalSupplierRow,
  addresses: CanonicalSupplierAddressRow[] = [],
  contacts: CanonicalSupplierContactRow[] = []
) {
  const payload: Record<string, unknown> = {
    Name: supplier.name,
    Status: supplier.status || "Active",
    Currency: supplier.currency || undefined,
    PaymentTerm: supplier.payment_term || undefined,
    TaxRule: supplier.tax_rule || undefined,
    AccountPayable: supplier.account_payable || undefined,
    Discount: supplier.discount ?? undefined,
    TaxNumber: supplier.tax_number || undefined,
    AttributeSet: supplier.attribute_set || undefined,
    AdditionalAttribute1: supplier.additional_attribute_1 || undefined,
    AdditionalAttribute2: supplier.additional_attribute_2 || undefined,
    AdditionalAttribute3: supplier.additional_attribute_3 || undefined,
    AdditionalAttribute4: supplier.additional_attribute_4 || undefined,
    AdditionalAttribute5: supplier.additional_attribute_5 || undefined,
    AdditionalAttribute6: supplier.additional_attribute_6 || undefined,
    AdditionalAttribute7: supplier.additional_attribute_7 || undefined,
    AdditionalAttribute8: supplier.additional_attribute_8 || undefined,
    AdditionalAttribute9: supplier.additional_attribute_9 || undefined,
    AdditionalAttribute10: supplier.additional_attribute_10 || undefined,
    Comments: supplier.comments || undefined,
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

  const namedContacts = contacts.filter((c) => c.contact_name);
  if (namedContacts.length) {
    payload.Contacts = namedContacts.map((c) => ({
      Name: c.contact_name,
      Phone: c.phone || undefined,
      MobilePhone: c.mobile_phone || undefined,
      Fax: c.fax || undefined,
      Email: c.email || undefined,
      Website: c.website || undefined,
      Comment: c.contact_comment || undefined,
      Default: c.contact_default,
      IncludeInEmail: c.contact_include_in_email,
    }));
  }

  return payload;
}

interface Cin7SupplierListResponse {
  SupplierList?: { ID: string; Name?: string }[];
}
type Cin7SupplierResponse = { ID?: string } & Cin7SupplierListResponse;

export async function findSupplierByName(creds: Cin7Credentials, name: string): Promise<{ id: string } | null> {
  const response = await cin7Request<Cin7SupplierListResponse>(creds, "/supplier", {
    query: { Name: name, page: 1, limit: 1 },
  });
  const first = response.SupplierList?.[0];
  if (!first || first.Name !== name) return null;
  return { id: first.ID };
}

function requireId(response: Cin7SupplierResponse, action: string): string {
  const id = response.ID ?? response.SupplierList?.[0]?.ID;
  if (!id) throw new Error(`${action} response had no ID field — raw response: ${JSON.stringify(response).slice(0, 500)}`);
  return id;
}

export type SupplierPushStatus = "created" | "updated";

/** Create-or-update a supplier by Name — Cin7 has no single upsert call, same as Product. */
export async function pushSupplier(
  creds: Cin7Credentials,
  supplier: CanonicalSupplierRow,
  addresses: CanonicalSupplierAddressRow[] = [],
  contacts: CanonicalSupplierContactRow[] = []
): Promise<{ cin7Id: string; status: SupplierPushStatus }> {
  const payload = toCin7SupplierPayload(supplier, addresses, contacts);
  const existing = await findSupplierByName(creds, supplier.name);

  if (existing) {
    const updated = await cin7Request<Cin7SupplierResponse>(creds, "/supplier", {
      method: "PUT",
      body: { ID: existing.id, ...payload },
    });
    return { cin7Id: requireId(updated, "PUT /supplier"), status: "updated" };
  }

  const created = await cin7Request<Cin7SupplierResponse>(creds, "/supplier", {
    method: "POST",
    body: payload,
  });
  return { cin7Id: requireId(created, "POST /supplier"), status: "created" };
}
