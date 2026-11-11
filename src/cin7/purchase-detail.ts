import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

export interface PurchaseReceiptLine {
  cardId: string;
  productSku: string;
  productName: string;
  quantity: number;
  receivedDate: string | null;
  location: string | null;
  locationId: string | null;
}

/**
 * Two or more receipt lines share a (CardID, SKU) — the table's primary key —
 * but disagree on a field the table stores (date/location), so summing them
 * would silently discard information. The PO is failed visibly instead.
 * Never carries field VALUES, only names.
 */
export class ReceiptLineConflictError extends Error {
  constructor(
    public readonly sku: string,
    public readonly conflictingFields: string[]
  ) {
    super(`Conflicting duplicate receipt lines for SKU ${sku}: differing ${conflictingFields.join(", ")}`);
    this.name = "ReceiptLineConflictError";
  }
}

/**
 * purchase_receipt_lines is keyed (org, instance, purchase, card_id, product_sku)
 * since migration 0124 (originally (org, instance, card_id, product_sku), 0025 —
 * which collided ACROSS purchase orders when Cin7 returned the nil CardID).
 * Within one PO the key is still unique: Cin7 can return several lines with the
 * same CardID and SKU in one receiving batch (confirmed live: PO-14939 had four,
 * 21+20+106+233 = 380), and inserting them raises a duplicate-key error that
 * rolls the whole PO back. This sums the quantities of lines that share the key
 * — the table (and every report) already holds one total per card and SKU — and
 * only when every stored field agrees. Otherwise it throws
 * ReceiptLineConflictError rather than dropping a date/location. First-seen
 * order is preserved; a non-empty product name is kept from the first line.
 */
export function aggregateReceiptLines(lines: PurchaseReceiptLine[]): PurchaseReceiptLine[] {
  const byKey = new Map<string, PurchaseReceiptLine>();
  for (const line of lines) {
    const key = `${line.cardId}|${line.productSku}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...line });
      continue;
    }
    const conflicts: string[] = [];
    if (existing.receivedDate !== line.receivedDate) conflicts.push("receivedDate");
    if (existing.location !== line.location) conflicts.push("location");
    if (existing.locationId !== line.locationId) conflicts.push("locationId");
    if (conflicts.length > 0) throw new ReceiptLineConflictError(line.productSku, conflicts);
    existing.quantity = Math.round((existing.quantity + line.quantity) * 1e6) / 1e6;
    if (!existing.productName && line.productName) existing.productName = line.productName;
  }
  return [...byKey.values()];
}

/** One ordered line — the "outstanding qty still coming" side of a backorder-ETA cross-reference, distinct from PurchaseReceiptLine's "already received" side. Confirmed live 2026-07-09 (surveyBackorderEtaFields) present identically under Order.Lines[] on both classic and Advanced-purchase responses, with no per-line date field at all — only the purchase-order-level RequiredBy (see PurchaseDetail.requiredBy) exists as an ETA. */
export interface PurchaseOrderLine {
  productSku: string;
  productName: string;
  quantity: number;
}

/**
 * The response is not a purchase detail at all (empty, non-object, or none of the fields every real
 * response carries). Thrown BEFORE anything is persisted so an incomplete API answer can never
 * replace a valid cached receipt set.
 */
export class PurchaseDetailStructureError extends Error {
  constructor(reason: string) {
    super(`Purchase detail response is not usable: ${reason}`);
    this.name = "PurchaseDetailStructureError";
  }
}

/** Deliberately lenient: Service Purchases legitimately have NO line sections, so this only rejects answers that are not a purchase detail at all. */
function assertDetailStructure(response: unknown): asserts response is Record<string, unknown> {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new PurchaseDetailStructureError("not an object");
  const known = ["ID", "OrderNumber", "Status", "Order", "StockReceived", "PutAway"];
  if (!known.some((k) => k in (response as Record<string, unknown>))) throw new PurchaseDetailStructureError("none of the expected purchase fields are present");
}

export interface FetchPurchaseDetailOptions {
  /** The endpoint that served this PO last time (purchases.source) — tried first so an Advanced PO costs one call instead of two. Falls back to the standard classic-first path on any Cin7 API error. */
  sourceHint?: string | null;
}

export interface PurchaseDetail {
  source: "purchase" | "advanced-purchase";
  receiptLines: PurchaseReceiptLine[];
  orderLines: PurchaseOrderLine[];
  /** False when the response carried NO receipt section at all (StockReceived / PutAway absent) — distinct from "present but empty". Undefined on older mocks; treat as present. */
  receiptSectionPresent?: boolean;
  /** Receipt lines the parser could not key (no CardID) and therefore did not persist. Instrumentation only — their treatment is unchanged until a validated identity strategy exists. */
  droppedReceiptLines?: { count: number; quantity: number };
  /** True when this purchase is a drop-shipment (RelatedDropShipSaleTask present — confirmed live 2026-07-09) — goods ship straight to the customer and never arrive in this warehouse, so it should never be treated as a source of "still coming" backorder stock regardless of RequiredBy. */
  isDropShip: boolean;
}

/** Trims Cin7's "2024-01-09T00:00:00" date fields to a plain date, same convention as sales.ts's toDateOnly. */
function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

function toReceiptLine(raw: Record<string, unknown>): PurchaseReceiptLine | null {
  const cardId = typeof raw.CardID === "string" ? raw.CardID : null;
  if (!cardId) return null;
  return {
    cardId,
    productSku: String(raw.SKU ?? ""),
    productName: String(raw.Name ?? ""),
    quantity: Number(raw.Quantity ?? 0),
    receivedDate: toDateOnly(raw.Date as string | undefined),
    location: typeof raw.Location === "string" ? raw.Location : null,
    locationId: typeof raw.LocationID === "string" ? raw.LocationID : null,
  };
}

/** Maps raw receipt lines, aggregating duplicates, and counts (without persisting) the lines that have no CardID. */
function parseReceiptLines(rawLines: Record<string, unknown>[]): { lines: PurchaseReceiptLine[]; dropped: { count: number; quantity: number } } {
  const keyed: PurchaseReceiptLine[] = [];
  let droppedCount = 0;
  let droppedQty = 0;
  for (const raw of rawLines) {
    const line = toReceiptLine(raw);
    if (line) keyed.push(line);
    else {
      droppedCount += 1;
      const q = Number(raw.Quantity ?? 0);
      droppedQty += Number.isFinite(q) ? q : 0;
    }
  }
  return { lines: aggregateReceiptLines(keyed), dropped: { count: droppedCount, quantity: Math.round(droppedQty * 1e6) / 1e6 } };
}

function toOrderLine(raw: Record<string, unknown>): PurchaseOrderLine {
  return {
    productSku: String(raw.SKU ?? ""),
    productName: String(raw.Name ?? ""),
    quantity: Number(raw.Quantity ?? 0),
  };
}

/** Order.Lines[]/RelatedDropShipSaleTask live at the top level of the response on both classic and Advanced-purchase shapes (confirmed live 2026-07-09) — extracted once here rather than duplicated in both branches below. */
function extractOrderLinesAndDropShip(response: Record<string, unknown>): { orderLines: PurchaseOrderLine[]; isDropShip: boolean } {
  const order = response.Order as Record<string, unknown> | undefined;
  const rawOrderLines = Array.isArray(order?.Lines) ? (order.Lines as Record<string, unknown>[]) : [];
  return { orderLines: rawOrderLines.map(toOrderLine), isDropShip: Boolean(response.RelatedDropShipSaleTask) };
}

/**
 * Fetches one purchase order's actual received-stock lines — the "in" side
 * of the Inventory Movement report. Confirmed live 2026-07-09 (see
 * debug.ts's surveyPurchaseDetailFields, the diagnostic this mirrors) that
 * Cin7 has two purchase "kinds" with different response shapes:
 *   - classic purchases:  GET /purchase?ID=          -> StockReceived.Lines[]
 *   - Advanced/Service purchases: the plain endpoint 400s with "...Please
 *     use AdvancedPurchase endpoint" — GET /advanced-purchase?ID= instead,
 *     whose own StockReceived is always present but empty on this account;
 *     the real received quantities live in PutAway[].Lines[].
 * Both shapes carry a CardID per line — confirmed live to be a stable,
 * unique identifier per receiving batch-line (a single order split across
 * two real receiving dates had two distinct CardIDs), used here as the
 * table's row identity (see migration 0024_purchase_receipts.sql).
 */
function parseClassic(response: Record<string, unknown>): PurchaseDetail {
  const stockReceived = response.StockReceived as Record<string, unknown> | undefined;
  const rawLines = Array.isArray(stockReceived?.Lines) ? (stockReceived.Lines as Record<string, unknown>[]) : [];
  const { lines, dropped } = parseReceiptLines(rawLines);
  return {
    source: "purchase",
    receiptLines: lines,
    receiptSectionPresent: "StockReceived" in response,
    droppedReceiptLines: dropped,
    ...extractOrderLinesAndDropShip(response),
  };
}

function parseAdvanced(response: Record<string, unknown>): PurchaseDetail {
  const putAway = Array.isArray(response.PutAway) ? (response.PutAway as Record<string, unknown>[]) : [];
  const rawLines = putAway.flatMap((batch) => (Array.isArray(batch.Lines) ? (batch.Lines as Record<string, unknown>[]) : []));
  const { lines, dropped } = parseReceiptLines(rawLines);
  return {
    source: "advanced-purchase",
    receiptLines: lines,
    receiptSectionPresent: "PutAway" in response,
    droppedReceiptLines: dropped,
    ...extractOrderLinesAndDropShip(response),
  };
}

export async function fetchPurchaseDetail(creds: Cin7Credentials, purchaseId: string, options: FetchPurchaseDetailOptions = {}): Promise<PurchaseDetail> {
  const query = { ID: purchaseId, CombineAdditionalCharges: "false" };

  if (options.sourceHint === "advanced-purchase") {
    try {
      const response = await cin7Request<unknown>(creds, "/advanced-purchase", { query });
      assertDetailStructure(response);
      return parseAdvanced(response);
    } catch (e) {
      // Only a Cin7 API error means "maybe this isn't an Advanced PO any more / transient" — fall through to the standard path.
      // A structure or conflict error is a real verdict about THIS response and must not be masked by a second call.
      if (!(e instanceof Cin7ApiError)) throw e;
    }
  }

  try {
    const response = await cin7Request<unknown>(creds, "/purchase", { query });
    assertDetailStructure(response);
    return parseClassic(response);
  } catch (e) {
    const isAdvancedPurchaseOnly = e instanceof Cin7ApiError && /Advanced Purchase/i.test(e.message);
    if (!isAdvancedPurchaseOnly) throw e;

    const response = await cin7Request<unknown>(creds, "/advanced-purchase", { query });
    assertDetailStructure(response);
    return parseAdvanced(response);
  }
}
