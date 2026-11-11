import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request, Cin7ApiError } from "@/cin7/http";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";

/**
 * DIAGNOSTIC ONLY — read-only (GET) receipt-integrity probe for the PO
 * Quantity Comparison investigation. Never writes to Cin7 or the database.
 *
 * For one purchase it fetches the raw detail (classic /purchase, falling back
 * to /advanced-purchase exactly as the sync does), describes EVERY top-level
 * section that carries `Lines` (so we discover where Advanced purchases keep
 * receipts/invoices without assuming), counts lines missing a CardID, and
 * compares live per-SKU quantities with what the CURRENT sync parser would
 * store (fetchPurchaseDetail) and with what the cache holds today.
 */

export interface SectionSummary {
  lines: number;
  withCardId: number;
  withoutCardId: number;
  qtySum: number;
  lineKeys: string[];
}

export interface SkuDiff {
  sku: string;
  liveOrdered: number;
  liveStockReceived: number;
  livePutAway: number;
  parserWouldStoreReceived: number;
  cachedOrdered: number | null;
  cachedReceived: number | null;
}

export interface PurchaseProbeResult {
  purchaseId: string;
  endpoint: "/purchase" | "/advanced-purchase" | null;
  error?: string;
  topLevelKeys: string[];
  sections: Record<string, SectionSummary>;
  /** Distinct SKUs where any live source differs from what the parser stores or the cache holds (max 15). */
  skuDiffs: SkuDiff[];
  skuCount: number;
}

function asLines(v: unknown): Record<string, unknown>[] {
  if (!v || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap((e) => asLines(e));
  const lines = (v as Record<string, unknown>).Lines;
  return Array.isArray(lines) ? (lines as Record<string, unknown>[]) : [];
}

function summarise(lines: Record<string, unknown>[]): SectionSummary {
  const keys = new Set<string>();
  let withCardId = 0;
  let qtySum = 0;
  for (const l of lines) {
    for (const k of Object.keys(l)) keys.add(k);
    if (typeof l.CardID === "string" && l.CardID) withCardId += 1;
    qtySum += Number(l.Quantity ?? 0) || 0;
  }
  return { lines: lines.length, withCardId, withoutCardId: lines.length - withCardId, qtySum: Math.round(qtySum * 1e6) / 1e6, lineKeys: [...keys].sort() };
}

function bySku(lines: Record<string, unknown>[], qty: (l: Record<string, unknown>) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const sku = String(l.SKU ?? "").trim() || "(no SKU)";
    m.set(sku, (m.get(sku) ?? 0) + qty(l));
  }
  return m;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function probePurchaseReceipts(
  creds: Cin7Credentials,
  purchaseId: string,
  cached: { ordered: Map<string, number>; received: Map<string, number> } | null
): Promise<PurchaseProbeResult> {
  let endpoint: PurchaseProbeResult["endpoint"] = null;
  let response: Record<string, unknown>;
  try {
    try {
      response = await cin7Request<Record<string, unknown>>(creds, "/purchase", { query: { ID: purchaseId, CombineAdditionalCharges: "false" } });
      endpoint = "/purchase";
    } catch (e) {
      if (!(e instanceof Cin7ApiError && /Advanced Purchase/i.test(e.message))) throw e;
      response = await cin7Request<Record<string, unknown>>(creds, "/advanced-purchase", { query: { ID: purchaseId, CombineAdditionalCharges: "false" } });
      endpoint = "/advanced-purchase";
    }
  } catch (e) {
    return { purchaseId, endpoint, error: e instanceof Error ? e.message : "Unknown error", topLevelKeys: [], sections: {}, skuDiffs: [], skuCount: 0 };
  }

  const sections: Record<string, SectionSummary> = {};
  for (const [key, value] of Object.entries(response)) {
    const lines = asLines(value);
    if (lines.length > 0) sections[key] = summarise(lines);
  }
  // Order.Lines lives one level down ({ Order: { Lines: [...] } }), reported under "Order".
  const orderLines = asLines(response.Order);
  const stockLines = asLines(response.StockReceived);
  const putAwayLines = asLines(response.PutAway);

  let parserReceived = new Map<string, number>();
  try {
    const parsed = await fetchPurchaseDetail(creds, purchaseId);
    for (const l of parsed.receiptLines) parserReceived.set(l.productSku.trim() || "(no SKU)", (parserReceived.get(l.productSku.trim() || "(no SKU)") ?? 0) + l.quantity);
  } catch {
    parserReceived = new Map();
  }

  const q = (l: Record<string, unknown>) => Number(l.Quantity ?? 0) || 0;
  const o = bySku(orderLines, q);
  const s = bySku(stockLines, q);
  const p = bySku(putAwayLines, q);
  const skus = new Set([...o.keys(), ...s.keys(), ...p.keys(), ...parserReceived.keys(), ...(cached?.ordered.keys() ?? []), ...(cached?.received.keys() ?? [])]);

  const diffs: SkuDiff[] = [];
  for (const sku of [...skus].sort()) {
    const d: SkuDiff = {
      sku,
      liveOrdered: r6(o.get(sku) ?? 0),
      liveStockReceived: r6(s.get(sku) ?? 0),
      livePutAway: r6(p.get(sku) ?? 0),
      parserWouldStoreReceived: r6(parserReceived.get(sku) ?? 0),
      cachedOrdered: cached ? r6(cached.ordered.get(sku) ?? 0) : null,
      cachedReceived: cached ? r6(cached.received.get(sku) ?? 0) : null,
    };
    const agree =
      d.liveStockReceived === d.parserWouldStoreReceived &&
      d.livePutAway === d.parserWouldStoreReceived &&
      d.cachedReceived === d.parserWouldStoreReceived &&
      d.cachedOrdered === d.liveOrdered;
    if (!agree) diffs.push(d);
  }

  return { purchaseId, endpoint, topLevelKeys: Object.keys(response).sort(), sections: { ...sections, ...(orderLines.length ? { "Order.Lines": summarise(orderLines) } : {}) }, skuDiffs: diffs.slice(0, 15), skuCount: skus.size };
}
