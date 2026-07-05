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
 *
 * Blank-clears-field rule (same as customers.ts, confirmed by Anton
 * 2026-07-06): every optional field is sent explicitly (`""` for text, `0`
 * for numbers) rather than omitted when blank, so a blank CSV value actively
 * clears whatever Cin7 already has instead of silently leaving it untouched.
 */
export function toCin7SupplierPayload(
  supplier: CanonicalSupplierRow,
  addresses: CanonicalSupplierAddressRow[] = [],
  contacts: CanonicalSupplierContactRow[] = []
) {
  const payload: Record<string, unknown> = {
    Name: supplier.name,
    Status: supplier.status || "Active",
    Currency: supplier.currency ?? "",
    PaymentTerm: supplier.payment_term ?? "",
    TaxRule: supplier.tax_rule ?? "",
    AccountPayable: supplier.account_payable ?? "",
    Discount: supplier.discount ?? 0,
    TaxNumber: supplier.tax_number ?? "",
    AttributeSet: supplier.attribute_set ?? "",
    AdditionalAttribute1: supplier.additional_attribute_1 ?? "",
    AdditionalAttribute2: supplier.additional_attribute_2 ?? "",
    AdditionalAttribute3: supplier.additional_attribute_3 ?? "",
    AdditionalAttribute4: supplier.additional_attribute_4 ?? "",
    AdditionalAttribute5: supplier.additional_attribute_5 ?? "",
    AdditionalAttribute6: supplier.additional_attribute_6 ?? "",
    AdditionalAttribute7: supplier.additional_attribute_7 ?? "",
    AdditionalAttribute8: supplier.additional_attribute_8 ?? "",
    AdditionalAttribute9: supplier.additional_attribute_9 ?? "",
    AdditionalAttribute10: supplier.additional_attribute_10 ?? "",
    Comments: supplier.comments ?? "",
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

/**
 * Fetches every supplier in this Cin7 instance (with nested Addresses[]/
 * Contacts[], per §10 in docs/cin7-api-findings.md) for a live full-fidelity
 * pull — same page-until-short-page pagination as fetchAllProductsWithBom in
 * products.ts.
 */
export async function fetchAllSuppliers(creds: Cin7Credentials): Promise<Record<string, unknown>[]> {
  const pageSize = 100;
  const all: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ SupplierList?: Record<string, unknown>[] }>(creds, "/supplier", {
      query: { page, limit: pageSize },
    });
    const suppliers = response.SupplierList ?? [];
    all.push(...suppliers);
    if (suppliers.length < pageSize) break;
  }
  return all;
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
