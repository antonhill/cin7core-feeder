import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed via the Apiary spec: /saleList is header-only (no line items) but
 * cheap and paginated — this is phase 1 of the sales sync (see
 * sync/sync-sales.ts). Unlike /Product or /customer/supplier (which use
 * lowercase page/limit — confirmed live for those specific endpoints),
 * /saleList's own documented query template uses capitalized Page/Limit,
 * same casing as the /ref/* reference-book endpoints — used verbatim here
 * rather than guessed.
 */
export interface Cin7SaleListEntry {
  SaleID: string;
  OrderNumber?: string;
  Status?: string;
  OrderDate?: string;
  InvoiceDate?: string | null;
  Customer?: string;
  CustomerID?: string;
  InvoiceNumber?: string | null;
  CustomerCurrency?: string;
  Updated?: string;
  CombinedInvoiceStatus?: string;
  OrderLocationID?: string;
}

/**
 * The values actually present on a real live account's CombinedInvoiceStatus
 * field (confirmed 2026-07-06 via the "Check sale statuses" diagnostic,
 * Settings > Cin7 Instances) are `INVOICED`, `INVOICED / CREDITED`,
 * `NOT INVOICED`, `PARTIALLY INVOICED`, `NOT AVAILABLE` — not the
 * `VOIDED`/`DRAFT`/`AUTHORISED`/`NOT AVAILABLE`/`PAID` the community Apiary
 * spec's field-level doc table claims. A first version filtered server-side
 * on `CombinedInvoiceStatus=AUTHORISED`, which matched nothing on a real
 * account with 560 sales — this is the corrected set of statuses that mean
 * "has at least one real invoice attached" (a PARTIALLY INVOICED sale still
 * has real, already-issued invoice lines worth reporting on; a credit note
 * against an invoice doesn't retroactively make the original invoice not
 * have happened, though netting credit notes off revenue isn't handled yet
 * — a known scope boundary, not a bug).
 */
const INVOICED_STATUSES = new Set(["INVOICED", "INVOICED / CREDITED", "PARTIALLY INVOICED"]);

/**
 * Fetches every invoiced sale, optionally scoped to sales changed since a
 * given ISO timestamp for incremental sync. `/saleList`'s own
 * `CombinedInvoiceStatus` query param only accepts one exact value, so
 * filtering to the several statuses above happens client-side after an
 * unfiltered (but still UpdatedSince-scoped) fetch, rather than one API call
 * per status. Paginates until a short page signals the end, same pattern as
 * fetchAllProductsWithBom.
 */
export async function fetchInvoicedSalesList(creds: Cin7Credentials, updatedSince?: string): Promise<Cin7SaleListEntry[]> {
  const pageSize = 100;
  const all: Cin7SaleListEntry[] = [];
  for (let page = 1; ; page++) {
    const query: Record<string, string | number> = { Page: page, Limit: pageSize };
    if (updatedSince) query.UpdatedSince = updatedSince;
    const response = await cin7Request<{ SaleList?: Cin7SaleListEntry[] }>(creds, "/saleList", { query });
    const sales = response.SaleList ?? [];
    all.push(...sales);
    if (sales.length < pageSize) break;
  }
  return all.filter((sale) => sale.CombinedInvoiceStatus && INVOICED_STATUSES.has(sale.CombinedInvoiceStatus));
}

export interface Cin7SaleInvoiceLine {
  ProductID?: string;
  SKU?: string;
  Name?: string;
  Quantity?: number;
  Price?: number;
  Discount?: number;
  Tax?: number;
  Total?: number;
  /** Average product cost per unit — this is Cin7's own COGS basis, confirmed on the Sale Invoice Line Model. */
  AverageCost?: number;
}

export interface Cin7SaleInvoice {
  InvoiceNumber?: string;
  InvoiceDate?: string;
  Lines?: Cin7SaleInvoiceLine[];
}

export interface Cin7SaleDetail {
  ID: string;
  /** "Default location to pick stock from" — the only place Location is exposed; /saleList only has a Location GUID (OrderLocationID). */
  Location?: string;
  /** An array because a single Sale can be invoiced more than once over its life (e.g. partial shipments) — each with its own InvoiceNumber/InvoiceDate/Lines. */
  Invoices?: Cin7SaleInvoice[];
}

/**
 * Fetches full line-item detail (with per-line AverageCost) for one sale.
 * Confirmed via the Apiary spec: there's no bulk "all line items" endpoint —
 * this is the only way to get product/quantity/cost detail, one call per
 * sale, which is why it's the rate-limited, budget-capped phase of the sync.
 */
export async function fetchSaleDetail(creds: Cin7Credentials, saleId: string): Promise<Cin7SaleDetail> {
  return cin7Request<Cin7SaleDetail>(creds, "/sale", { query: { ID: saleId } });
}
