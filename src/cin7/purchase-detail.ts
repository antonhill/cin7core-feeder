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

export interface PurchaseDetail {
  source: "purchase" | "advanced-purchase";
  receiptLines: PurchaseReceiptLine[];
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
    return { source: "purchase", receiptLines: rawLines.map(toReceiptLine).filter((l): l is PurchaseReceiptLine => l !== null) };
  } catch (e) {
    const isAdvancedPurchaseOnly = e instanceof Cin7ApiError && /Advanced Purchase/i.test(e.message);
    if (!isAdvancedPurchaseOnly) throw e;

    const response = await cin7Request<Record<string, unknown>>(creds, "/advanced-purchase", {
      query: { ID: purchaseId, CombineAdditionalCharges: "false" },
    });
    const putAway = Array.isArray(response.PutAway) ? (response.PutAway as Record<string, unknown>[]) : [];
    const rawLines = putAway.flatMap((batch) => (Array.isArray(batch.Lines) ? (batch.Lines as Record<string, unknown>[]) : []));
    return { source: "advanced-purchase", receiptLines: rawLines.map(toReceiptLine).filter((l): l is PurchaseReceiptLine => l !== null) };
  }
}
