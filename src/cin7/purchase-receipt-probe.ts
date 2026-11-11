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

/** Primitive fields whose NAME suggests status/date/identity — values truncated; never free-text, contact or address fields. */
const SAFE_KEY = /status|date|updated|number|state|type|source|combined|received|invoice|void|locked|authori[sz]|^id$|id$/i;

export type Scalars = Record<string, string | number | boolean | null>;

function safeScalars(obj: unknown): Scalars {
  const out: Scalars = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!SAFE_KEY.test(k)) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v as number | boolean | null;
    else if (typeof v === "string") out[k] = v.slice(0, 40);
  }
  return out;
}

export interface ParserSimulation {
  receiptRows: number;
  /** (cardId|sku) keys occurring more than once — each would violate purchase_receipt_lines' PK (org, instance, card_id, product_sku) and roll back the whole PO. */
  duplicateReceiptKeys: { key: string; count: number; quantities: number[] }[];
  wouldViolateReceiptPk: boolean;
  orderRows: number;
  blankSkuReceiptRows: number;
  nonFiniteQuantityRows: number;
  error?: string;
}

export interface PurchaseProbeResult {
  purchaseId: string;
  /** Top-level primitive fields with status/date/identity-like names. */
  scalars?: Scalars;
  /** Per-section event/header primitives (e.g. StockReceived[].Status/Date), max 10 per section. */
  sectionEvents?: Record<string, Scalars[]>;
  /** Distinct per-line `Status` values by section, when lines carry one. */
  lineStatuses?: Record<string, Record<string, number>>;
  parser?: ParserSimulation;
  /** The /purchaseList row for this PO (found via Search on order number), primitives only. */
  listEntry?: Scalars | null;
  listLookupError?: string;
  /** Source LastUpdatedDate vs the latest line/event Date seen in the detail. */
  lastUpdated?: { listLastUpdated: string | null; latestDetailDate: string | null; listCoversLatestDetailDate: boolean | null };
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
  cached: { ordered: Map<string, number>; received: Map<string, number> } | null,
  orderNumber: string | null = null
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
  let parser: ParserSimulation;
  try {
    const parsed = await fetchPurchaseDetail(creds, purchaseId);
    const keyCount = new Map<string, number[]>();
    let blank = 0;
    let nonFinite = 0;
    for (const l of parsed.receiptLines) {
      const sku = l.productSku.trim() || "(no SKU)";
      parserReceived.set(sku, (parserReceived.get(sku) ?? 0) + l.quantity);
      const k = `${l.cardId}|${l.productSku}`;
      keyCount.set(k, [...(keyCount.get(k) ?? []), l.quantity]);
      if (!l.productSku.trim()) blank += 1;
      if (!Number.isFinite(l.quantity)) nonFinite += 1;
    }
    const dups = [...keyCount.entries()].filter(([, q]) => q.length > 1).map(([key, quantities]) => ({ key: key.replace(/^[^|]{8}[^|]*/, (m) => m.slice(0, 8) + "…"), count: quantities.length, quantities }));
    parser = {
      receiptRows: parsed.receiptLines.length,
      duplicateReceiptKeys: dups,
      wouldViolateReceiptPk: dups.length > 0,
      orderRows: parsed.orderLines.length,
      blankSkuReceiptRows: blank,
      nonFiniteQuantityRows: nonFinite,
    };
  } catch (e) {
    parserReceived = new Map();
    parser = { receiptRows: 0, duplicateReceiptKeys: [], wouldViolateReceiptPk: false, orderRows: 0, blankSkuReceiptRows: 0, nonFiniteQuantityRows: 0, error: (e instanceof Error ? e.message : "Unknown error").slice(0, 200) };
  }

  // Section headers/events and per-line statuses — to find draft/unauthorised receiving structures.
  const sectionEvents: Record<string, Scalars[]> = {};
  const lineStatuses: Record<string, Record<string, number>> = {};
  let latestDetailDate: string | null = null;
  const noteDate = (v: unknown) => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && (!latestDetailDate || v > latestDetailDate)) latestDetailDate = v;
  };
  for (const [key, value] of Object.entries(response)) {
    if (!value || typeof value !== "object") continue;
    const containers = Array.isArray(value) ? (value as unknown[]) : [value];
    const events: Scalars[] = [];
    for (const c of containers.slice(0, 10)) {
      const sc = safeScalars(c);
      if (Object.keys(sc).length) events.push(sc);
      for (const v of Object.values(sc)) noteDate(v);
    }
    if (events.length) sectionEvents[key] = events;
    const lines = asLines(value);
    for (const l of lines) {
      noteDate(l.Date);
      if (typeof l.Status === "string") {
        lineStatuses[key] = lineStatuses[key] ?? {};
        lineStatuses[key][l.Status] = (lineStatuses[key][l.Status] ?? 0) + 1;
      }
    }
  }

  // Source last-modified: look the PO up in /purchaseList by order number (GET) and compare with the latest detail date.
  let listEntry: Scalars | null = null;
  let listLookupError: string | undefined;
  if (orderNumber) {
    try {
      const resp = await cin7Request<{ PurchaseList?: Record<string, unknown>[] }>(creds, "/purchaseList", { query: { Search: orderNumber, Limit: 5, Page: 1 } });
      const hit = (resp.PurchaseList ?? []).find((e) => e.ID === purchaseId);
      if (hit) {
        const sc = safeScalars(hit);
        if (typeof hit.LastUpdatedDate === "string") sc.LastUpdatedDate = hit.LastUpdatedDate.slice(0, 40);
        listEntry = sc;
      }
      if (!hit) listLookupError = "PO not returned by purchaseList Search";
    } catch (e) {
      listLookupError = (e instanceof Error ? e.message : "Unknown error").slice(0, 200);
    }
  }
  const finalListEntry = listEntry as Scalars | null;
  const listLast = typeof finalListEntry?.LastUpdatedDate === "string" ? (finalListEntry.LastUpdatedDate as string) : null;
  const lastUpdated = {
    listLastUpdated: listLast,
    latestDetailDate,
    listCoversLatestDetailDate: listLast && latestDetailDate ? listLast.slice(0, 10) >= (latestDetailDate as string).slice(0, 10) : null,
  };

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

  return { purchaseId, scalars: safeScalars(response), sectionEvents, lineStatuses, parser, listEntry, listLookupError, lastUpdated, endpoint, topLevelKeys: Object.keys(response).sort(), sections: { ...sections, ...(orderLines.length ? { "Order.Lines": summarise(orderLines) } : {}) }, skuDiffs: diffs.slice(0, 15), skuCount: skus.size };
}
