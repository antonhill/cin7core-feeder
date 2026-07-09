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

/** One ordered line — the "outstanding qty still coming" side of a backorder-ETA cross-reference, distinct from PurchaseReceiptLine's "already received" side. Confirmed live 2026-07-09 (surveyBackorderEtaFields) present identically under Order.Lines[] on both classic and Advanced-purchase responses, with no per-line date field at all — only the purchase-order-level RequiredBy (see PurchaseDetail.requiredBy) exists as an ETA. */
export interface PurchaseOrderLine {
  productSku: string;
  productName: string;
  quantity: number;
}

export interface PurchaseDetail {
  source: "purchase" | "advanced-purchase";
  receiptLines: PurchaseReceiptLine[];
  orderLines: PurchaseOrderLine[];
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
export async function fetchPurchaseDetail(creds: Cin7Credentials, purchaseId: string): Promise<PurchaseDetail> {
  try {
    const response = await cin7Request<Record<string, unknown>>(creds, "/purchase", {
      query: { ID: purchaseId, CombineAdditionalCharges: "false" },
    });
    const stockReceived = response.StockReceived as Record<string, unknown> | undefined;
    const rawLines = Array.isArray(stockReceived?.Lines) ? (stockReceived.Lines as Record<string, unknown>[]) : [];
    return {
      source: "purchase",
      receiptLines: rawLines.map(toReceiptLine).filter((l): l is PurchaseReceiptLine => l !== null),
      ...extractOrderLinesAndDropShip(response),
    };
  } catch (e) {
    const isAdvancedPurchaseOnly = e instanceof Cin7ApiError && /Advanced Purchase/i.test(e.message);
    if (!isAdvancedPurchaseOnly) throw e;

    const response = await cin7Request<Record<string, unknown>>(creds, "/advanced-purchase", {
      query: { ID: purchaseId, CombineAdditionalCharges: "false" },
    });
    const putAway = Array.isArray(response.PutAway) ? (response.PutAway as Record<string, unknown>[]) : [];
    const rawLines = putAway.flatMap((batch) => (Array.isArray(batch.Lines) ? (batch.Lines as Record<string, unknown>[]) : []));
    return {
      source: "advanced-purchase",
      receiptLines: rawLines.map(toReceiptLine).filter((l): l is PurchaseReceiptLine => l !== null),
      ...extractOrderLinesAndDropShip(response),
    };
  }
}
