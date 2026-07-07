/**
 * Data consistency/accuracy checks for Customers and Suppliers, live from a
 * connected Cin7 instance — extends Data Audit beyond the product-only scope
 * `product-audit.ts` started with (Anton: "add customers and suppliers").
 * Both resources share the same Addresses[]/Contacts[] shape (confirmed live,
 * see docs/cin7-api-findings.md §10), so one generic set of checks covers
 * both — gated by `kind` only where Cin7's own field set genuinely differs:
 * Tags/SalesRepresentative/Location are confirmed present on Customer's
 * push-confirmed field list but absent from Supplier's, so those three
 * checks only ever run for `kind: "customer"`.
 *
 * All checks here are pure/report-only in intent — see apply-party-fixes.ts
 * for which of these (Tags/SalesRepresentative/Location, all customer-only
 * single-value fields) actually get a bulk-fix UI. Contacts/Email/Phone/
 * TaxNumber/address fields are inherently per-entity (no single value makes
 * sense to apply to many customers/suppliers at once — same reasoning as
 * product-audit.ts's missing_sales_pricing), so those stay report-only.
 */

export type PartyKind = "customer" | "supplier";

export type PartyAuditIssueType =
  | "no_contacts"
  | "missing_email"
  | "missing_phone"
  | "missing_tax_number"
  | "missing_address_country"
  | "missing_address_postcode"
  | "missing_tags"
  | "missing_sales_rep"
  | "missing_location";

export interface PartyAuditIssue {
  type: PartyAuditIssueType;
  partyId: string;
  name: string;
}

export interface PartySummary {
  partyId: string;
  name: string;
}

export interface PartyAuditResult {
  issues: PartyAuditIssue[];
  parties: PartySummary[];
}

interface RawAddress {
  Country?: string;
  Postcode?: string;
  [key: string]: unknown;
}

interface RawContact {
  Name?: string;
  Email?: string;
  Phone?: string;
  MobilePhone?: string;
  [key: string]: unknown;
}

export interface RawParty {
  ID?: string;
  Name?: string;
  TaxNumber?: string;
  Tags?: string;
  SalesRepresentative?: string;
  Location?: string;
  Addresses?: RawAddress[];
  Contacts?: RawContact[];
  [key: string]: unknown;
}

function partyRef(p: RawParty): { partyId: string; name: string } {
  return { partyId: p.ID ?? "", name: p.Name ?? "" };
}

/** A contact only counts if it actually has a name — matches the "namedContacts" convention already used when pushing (see toCin7CustomerPayload/toCin7SupplierPayload). */
function namedContacts(p: RawParty): RawContact[] {
  return (p.Contacts ?? []).filter((c) => c.Name?.trim());
}

/** No contacts at all (or only nameless ones, which don't count as real contacts). */
export function findNoContacts(parties: RawParty[]): PartyAuditIssue[] {
  return parties.filter((p) => namedContacts(p).length === 0).map((p) => ({ type: "no_contacts", ...partyRef(p) }));
}

/** None of this party's contacts have an Email set — a party with zero contacts is naturally included too, since it has no way to be emailed either. */
export function findMissingEmail(parties: RawParty[]): PartyAuditIssue[] {
  return parties.filter((p) => !namedContacts(p).some((c) => c.Email?.trim())).map((p) => ({ type: "missing_email", ...partyRef(p) }));
}

/** None of this party's contacts have a Phone or MobilePhone set. */
export function findMissingPhone(parties: RawParty[]): PartyAuditIssue[] {
  return parties
    .filter((p) => !namedContacts(p).some((c) => c.Phone?.trim() || c.MobilePhone?.trim()))
    .map((p) => ({ type: "missing_phone", ...partyRef(p) }));
}

/** No TaxNumber set at all. */
export function findMissingTaxNumber(parties: RawParty[]): PartyAuditIssue[] {
  return parties.filter((p) => !p.TaxNumber?.trim()).map((p) => ({ type: "missing_tax_number", ...partyRef(p) }));
}

/**
 * Parties with at least one address on file where Country (respectively
 * Postcode) is blank — a party with zero addresses isn't flagged here, since
 * there's nothing to check yet (a separate "no address at all" gap, not in
 * scope for this pass).
 */
export function findMissingAddressCountry(parties: RawParty[]): PartyAuditIssue[] {
  return parties
    .filter((p) => (p.Addresses ?? []).length > 0 && (p.Addresses ?? []).some((a) => !a.Country?.trim()))
    .map((p) => ({ type: "missing_address_country", ...partyRef(p) }));
}

export function findMissingAddressPostcode(parties: RawParty[]): PartyAuditIssue[] {
  return parties
    .filter((p) => (p.Addresses ?? []).length > 0 && (p.Addresses ?? []).some((a) => !a.Postcode?.trim()))
    .map((p) => ({ type: "missing_address_postcode", ...partyRef(p) }));
}

/** Customer-only — Tags isn't in Supplier's confirmed field set at all (docs/cin7-api-findings.md §10). */
export function findMissingTags(parties: RawParty[]): PartyAuditIssue[] {
  return parties.filter((p) => !p.Tags?.trim()).map((p) => ({ type: "missing_tags", ...partyRef(p) }));
}

/** Customer-only — SalesRepresentative isn't in Supplier's confirmed field set at all. */
export function findMissingSalesRep(parties: RawParty[]): PartyAuditIssue[] {
  return parties.filter((p) => !p.SalesRepresentative?.trim()).map((p) => ({ type: "missing_sales_rep", ...partyRef(p) }));
}

/** Customer-only — Location isn't in Supplier's confirmed field set at all. */
export function findMissingLocation(parties: RawParty[]): PartyAuditIssue[] {
  return parties.filter((p) => !p.Location?.trim()).map((p) => ({ type: "missing_location", ...partyRef(p) }));
}

export function runPartyAudit(parties: RawParty[], kind: PartyKind): PartyAuditResult {
  const issues: PartyAuditIssue[] = [
    ...findNoContacts(parties),
    ...findMissingEmail(parties),
    ...findMissingPhone(parties),
    ...findMissingTaxNumber(parties),
    ...findMissingAddressCountry(parties),
    ...findMissingAddressPostcode(parties),
  ];
  if (kind === "customer") {
    issues.push(...findMissingTags(parties), ...findMissingSalesRep(parties), ...findMissingLocation(parties));
  }

  return { issues, parties: parties.map(partyRef) };
}
