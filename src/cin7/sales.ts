import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Fields Cin7's own Apiary spec (`nnhansg/dear-openapi`, `specification/
 * dearinventory.apib`, checked directly 2026-07-10 — the JS-rendered mirror
 * this project usually has to work around) documents as writable via
 * `PUT /sale`, distinct from read-only fields also present on `GET /sale`
 * (`BaseCurrency`, `CustomerCurrency`, `COGSAmount`, `Status`, every
 * `Combined*Status`, `Type`, `ServiceOnly`, `SourceChannel`) and from
 * `Quote`/`Order`/`Fulfilments`/`Invoices`/`CreditNotes`, which are nested
 * sub-resources with their own dedicated endpoints and aren't accepted here.
 */
const SALE_WRITABLE_FIELDS = [
  "ID",
  "Customer",
  "CustomerID",
  "Contact",
  "Phone",
  "Email",
  "DefaultAccount",
  "SkipQuote",
  "BillingAddress",
  "ShippingAddress",
  "ShippingNotes",
  "TaxRule",
  "Terms",
  "PriceTier",
  "ShipBy",
  "Location",
  "SaleOrderDate",
  "Note",
  "CustomerReference",
  "SalesRepresentative",
  "Carrier",
  "CurrencyRate",
  "ExternalID",
  "AdditionalAttributes",
] as const;

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
  /** Note the internal capitalization — Cin7's own JSON key is "FulFilmentStatus", not "FulfilmentStatus". Separate concept from CombinedInvoiceStatus: whether the goods have actually gone out, not whether it's been invoiced. */
  FulFilmentStatus?: string;
  /** The shipping deadline — confirmed live, distinct from InvoiceDueDate (a payment due date, unrelated to fulfillment). Null when no deadline was set on the order. */
  ShipBy?: string | null;
  /**
   * Confirmed live 2026-07-09 (surveySaleFulfillmentFields) for the Order
   * Fulfillment Dashboard — all present on /saleList already, no new API
   * calls needed. Real observed values matched the community spec exactly
   * this time (unlike CombinedInvoiceStatus's own earlier surprise):
   * CombinedPickingStatus/CombinedPackingStatus/CombinedShippingStatus are
   * each `VOIDED`/`NOT AVAILABLE`/<verb>ED/<verb>ING/`NOT <verb>ED`/
   * `PARTIALLY <verb>ED`; CombinedPaymentStatus is `NOT REFUNDED`/`PREPAID`/
   * `PARTIALLY PAID`/`UNPAID`/`PAID`/`VOIDED`.
   */
  OrderStatus?: string;
  CombinedPickingStatus?: string;
  CombinedPackingStatus?: string;
  CombinedShippingStatus?: string;
  CombinedPaymentStatus?: string;
  CombinedTrackingNumbers?: string | null;
  Carrier?: string | null;
  /** Real amount paid so far — confirmed live, reliable enough to answer "what's been paid" directly from the list scan, no per-order detail call needed. */
  PaidAmount?: number;
  SaleInvoicesTotalAmount?: number;
}

/**
 * Fetches every sale on the account, optionally scoped to sales changed
 * since a given ISO timestamp. Paginates until a short page signals the
 * end, same pattern as fetchAllProductsWithBom. Used by both the sales sync
 * (which needs every sale regardless of invoice status, so the Order
 * Fulfillment Dashboard can see pre-invoice orders too — see
 * sync/sync-sales.ts) and the System Health scorecard.
 */
export async function fetchAllSalesList(creds: Cin7Credentials, updatedSince?: string): Promise<Cin7SaleListEntry[]> {
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
  return all;
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

/** One Order line — confirmed live 2026-07-09. BackorderQuantity is what's NOT currently available to pick; Order.Lines[] itself is sometimes empty on older/legacy sales even when Fulfilments[] has real data, so its absence means "no backorder data available," not "zero backordered." */
export interface Cin7SaleOrderLine {
  SKU?: string;
  Name?: string;
  Quantity?: number;
  BackorderQuantity?: number;
}

export interface Cin7SaleOrder {
  SaleOrderNumber?: string;
  Lines?: Cin7SaleOrderLine[];
}

/** A Pick or Pack line — the ACTUAL quantity picked/packed so far, distinct from Order.Lines[]'s planned quantity (same "planned vs actual" split already used for Assembly Builds' OrderLines vs PickLines). Location/Bin/BatchSN confirmed present live 2026-07-09 — where a completed pick actually came from, an audit trail (not forward guidance — see report_order_fulfillment_lines' cross-reference against product_availability for "where to pick a still-outstanding line from" instead). */
export interface Cin7SaleFulfilmentPickPackLine {
  SKU?: string;
  Name?: string;
  Quantity?: number;
  Location?: string;
  LocationID?: string;
  BatchSN?: string;
}

export interface Cin7SaleFulfilmentPickPack {
  Status?: string;
  Lines?: Cin7SaleFulfilmentPickPackLine[];
}

/** Confirmed live 2026-07-09: Fulfilments is a genuine array — a sale can have more than one (e.g. split picks), so "already picked/packed" must sum across every entry, not just read index 0. */
export interface Cin7SaleFulfilment {
  TaskID?: string;
  FulFilmentStatus?: string;
  Pick?: Cin7SaleFulfilmentPickPack;
  Pack?: Cin7SaleFulfilmentPickPack;
}

/**
 * A file attached to the sale — confirmed live 2026-07-09 (a real order had
 * an auto-generated "Expanded Pick List" PDF here). `DownloadUrl` carries a
 * `timeStamp` query param that looks like a signed/expiring link, so this is
 * deliberately never synced/stored — always fetched fresh via
 * fetchSaleDetail at the moment a user wants to open a document, not cached
 * for later use.
 */
export interface Cin7SaleAttachment {
  ID?: string;
  ContentType?: string;
  FileName?: string;
  DownloadUrl?: string;
}

export interface Cin7SaleDetail {
  ID: string;
  /** "Default location to pick stock from" — the only place Location is exposed; /saleList only has a Location GUID (OrderLocationID). */
  Location?: string;
  /**
   * Cin7's own docs (checked 2026-07-10): "Reference number used by
   * customer to identify this sale. Could be a purchase order number
   * generated by customer." Detail-only (like Note/COGSAmount), not on the
   * cheap /saleList scan — extracted from the same /sale?ID= call already
   * made for line detail, no extra Cin7 request.
   */
  CustomerReference?: string | null;
  /** An array because a single Sale can be invoiced more than once over its life (e.g. partial shipments) — each with its own InvoiceNumber/InvoiceDate/Lines. */
  Invoices?: Cin7SaleInvoice[];
  Order?: Cin7SaleOrder;
  Fulfilments?: Cin7SaleFulfilment[];
  Attachments?: Cin7SaleAttachment[];
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

/**
 * Updates a Sale's ShipBy date in Cin7 Core (e.g. dragging a card to a new
 * day on the shipping calendar). `PUT /sale` requires the full writable
 * field set on every call, not a partial patch — Cin7's own spec marks
 * `Location` as unconditionally required, and `Customer`/`CustomerID` as
 * required if the other isn't present — so this re-fetches the sale fresh
 * immediately beforehand and round-trips every other writable field
 * unchanged. The live GET is used rather than this app's own synced `sales`
 * table, since that table only carries what reporting needs (order number,
 * customer name, Combined*Status columns), not the full writable set
 * (BillingAddress, TaxRule, Terms, PriceTier, ...).
 */
export async function updateSaleShipBy(creds: Cin7Credentials, saleId: string, shipBy: string | null): Promise<void> {
  const current = await cin7Request<Record<string, unknown>>(creds, "/sale", { query: { ID: saleId } });

  const body: Record<string, unknown> = {};
  for (const field of SALE_WRITABLE_FIELDS) {
    if (current[field] !== undefined) body[field] = current[field];
  }
  body.ShipBy = shipBy;
  // GET returns TaxCalculation ("Inclusive"/"Exclusive"); PUT expects the boolean TaxInclusive instead — same field, different shape on read vs write.
  if (current.TaxCalculation !== undefined) body.TaxInclusive = current.TaxCalculation === "Inclusive";

  await cin7Request(creds, "/sale", { method: "PUT", body });
}
