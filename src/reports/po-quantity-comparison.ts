/**
 * Purchase Order Quantity Comparison — pure reconciliation logic (no I/O).
 *
 * Reads only what the purchase sync already caches (`purchases`,
 * `purchase_order_lines`, `purchase_receipt_lines`). Quantities are
 * aggregated per (instance, PO, SKU): Cin7 receipt lines carry no order-line
 * key, so a line-level join would be unsupported (and would double-count the
 * ordered quantity whenever a SKU has several receipts). Duplicate-SKU order
 * lines are therefore summed, and `orderLineCount` says how many were merged.
 *
 * Correctness rules enforced here:
 * - A PO whose detail has not synced (`detail_synced_at` null) gets ONE row
 *   with null quantities — never zero. Any order/receipt lines still in the
 *   cache for it are leftovers from an earlier fetch and are ignored.
 * - A PO with detail synced but no cached lines at all is also incomplete.
 * - A PO re-listed after its detail was fetched (`updated_at` later than
 *   `detail_synced_at`) is shown but flagged possibly stale: the sync only
 *   re-fetches detail when the receiving status changes, so e.g. a further
 *   partial receipt can leave the cached received quantity out of date.
 * - Outstanding = ordered − received and is never clamped: over-receipts
 *   show as negatives.
 */

export type LineStatus = "fully_received" | "partially_received" | "not_received" | "over_received";

export type DataQuality = "ok" | "detail_not_synced" | "no_lines_cached" | "possibly_stale" | "receipt_suspect";

/** The four states shown to users: Complete, Incomplete (no usable lines), Potentially stale, Suspect (cached receipts contradict Cin7's own receiving status). Only Complete rows feed trusted totals. */
export type QualityGroup = "complete" | "incomplete" | "stale" | "suspect";

export function qualityGroup(q: DataQuality): QualityGroup {
  switch (q) {
    case "ok":
      return "complete";
    case "possibly_stale":
      return "stale";
    case "receipt_suspect":
      return "suspect";
    default:
      return "incomplete";
  }
}

export interface PurchaseHeader {
  instance_id: string;
  cin7_purchase_id: string;
  order_number: string | null;
  supplier_name: string | null;
  status: string | null;
  combined_receiving_status: string | null;
  order_date: string | null;
  is_drop_ship: boolean | null;
  detail_synced_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface OrderLineInput {
  instance_id: string;
  cin7_purchase_id: string;
  product_sku: string | null;
  product_name: string | null;
  quantity: number | string | null;
}

export interface ReceiptLineInput {
  instance_id: string;
  cin7_purchase_id: string;
  product_sku: string | null;
  product_name: string | null;
  quantity: number | string | null;
}

export interface PoQuantityRow {
  /** Stable React/sort key: instance|purchase|sku. */
  key: string;
  instanceId: string;
  instanceName: string;
  cin7PurchaseId: string;
  orderNumber: string | null;
  supplierName: string | null;
  orderDate: string | null;
  poStatus: string | null;
  receivingStatus: string | null;
  isDropShip: boolean;
  /** Null only on the single placeholder row of a PO with incomplete detail. */
  sku: string | null;
  productName: string | null;
  /** How many order lines were summed into `ordered` (>1 = duplicate-SKU lines). */
  orderLineCount: number;
  ordered: number | null;
  received: number | null;
  /** ordered − received, never clamped. */
  outstanding: number | null;
  lineStatus: LineStatus | null;
  /** Received against a SKU that is not on the PO at all (ordered 0). */
  notOnOrder: boolean;
  dataQuality: DataQuality;
  /** Why the row is not Complete (null when it is). */
  dataQualityNote: string | null;
  detailSyncedAt: string | null;
}

/** Float-noise guard for summing decimal quantities (Cin7 allows fractional units). */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function toNum(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export const NO_SKU_LABEL = "(no SKU)";

function normSku(sku: string | null | undefined): string {
  const s = (sku ?? "").trim();
  return s === "" ? NO_SKU_LABEL : s;
}

export function classifyLine(ordered: number, received: number): LineStatus {
  if (received > ordered) return "over_received";
  if (received === 0) return "not_received";
  if (received === ordered) return "fully_received";
  return "partially_received";
}

function poKey(instanceId: string, purchaseId: string): string {
  return `${instanceId}|${purchaseId}`;
}

interface SkuAgg {
  name: string | null;
  orderedLines: number;
  ordered: number;
  received: number;
}

function placeholderRow(h: PurchaseHeader, instanceName: string, quality: DataQuality): PoQuantityRow {
  return {
    key: `${poKey(h.instance_id, h.cin7_purchase_id)}|`,
    instanceId: h.instance_id,
    instanceName,
    cin7PurchaseId: h.cin7_purchase_id,
    orderNumber: h.order_number,
    supplierName: h.supplier_name,
    orderDate: h.order_date,
    poStatus: h.status,
    receivingStatus: h.combined_receiving_status,
    isDropShip: Boolean(h.is_drop_ship),
    sku: null,
    productName: null,
    orderLineCount: 0,
    ordered: null,
    received: null,
    outstanding: null,
    lineStatus: null,
    notOnOrder: false,
    dataQuality: quality,
    dataQualityNote: quality === "detail_not_synced" ? "PO detail has not synced (never fetched or failing)." : "PO detail synced but no order or receipt lines are cached.",
    detailSyncedAt: h.detail_synced_at,
  };
}

/** True when the PO was re-listed in Cin7 after its detail was last fetched (1s tolerance for same-run ordering). */
export function isDetailPossiblyStale(h: Pick<PurchaseHeader, "detail_synced_at" | "updated_at">): boolean {
  if (!h.detail_synced_at || !h.updated_at) return false;
  return new Date(h.updated_at).getTime() - new Date(h.detail_synced_at).getTime() > 1000;
}

/**
 * Cin7's own CombinedReceivingStatus is an independent signal. When the cached
 * quantities contradict it the cached receipts cannot be trusted (e.g. receipt
 * lines lost at ingest). Does NOT catch under-counts on genuinely partial POs.
 */
export function receiptSuspectReason(receivingStatus: string | null, skus: { ordered: number; received: number }[]): string | null {
  const totalReceived = round(skus.reduce((n, a) => n + a.received, 0));
  if (receivingStatus === "FULLY RECEIVED" && skus.some((a) => round(a.received) < round(a.ordered))) {
    return "Cin7 says FULLY RECEIVED but cached receipts are below the ordered quantity — receipt lines may be missing.";
  }
  if (receivingStatus === "PARTIALLY RECEIVED" && totalReceived === 0) {
    return "Cin7 says PARTIALLY RECEIVED but no receipts are cached — receipt lines may be missing.";
  }
  if (receivingStatus === "NOT RECEIVED" && totalReceived > 0) {
    return "Cin7 says NOT RECEIVED but receipts are cached — the cached PO data is inconsistent.";
  }
  return null;
}

export interface TrustedTotals {
  trustedPoCount: number;
  trustedRowCount: number;
  ordered: number;
  received: number;
  outstanding: number;
  excludedPoCount: { incomplete: number; stale: number; suspect: number };
}

/** Totals over Complete rows ONLY. Incomplete / potentially stale / suspect POs are counted but never summed. */
export function computeTrustedTotals(rows: PoQuantityRow[]): TrustedTotals {
  const trusted = new Set<string>();
  const ex = { incomplete: new Set<string>(), stale: new Set<string>(), suspect: new Set<string>() };
  let ordered = 0;
  let received = 0;
  let trustedRowCount = 0;
  for (const r of rows) {
    const po = `${r.instanceId}|${r.cin7PurchaseId}`;
    const g = qualityGroup(r.dataQuality);
    if (g === "complete") {
      trusted.add(po);
      trustedRowCount += 1;
      ordered += r.ordered ?? 0;
      received += r.received ?? 0;
    } else ex[g].add(po);
  }
  return {
    trustedPoCount: trusted.size,
    trustedRowCount,
    ordered: round(ordered),
    received: round(received),
    outstanding: round(ordered - received),
    excludedPoCount: { incomplete: ex.incomplete.size, stale: ex.stale.size, suspect: ex.suspect.size },
  };
}

export function buildPoQuantityRows(input: {
  purchases: PurchaseHeader[];
  orderLines: OrderLineInput[];
  receiptLines: ReceiptLineInput[];
  instanceNames: Record<string, string>;
}): PoQuantityRow[] {
  const { purchases, orderLines, receiptLines, instanceNames } = input;

  const ordersByPo = new Map<string, OrderLineInput[]>();
  for (const l of orderLines) {
    const k = poKey(l.instance_id, l.cin7_purchase_id);
    const arr = ordersByPo.get(k);
    if (arr) arr.push(l);
    else ordersByPo.set(k, [l]);
  }
  const receiptsByPo = new Map<string, ReceiptLineInput[]>();
  for (const l of receiptLines) {
    const k = poKey(l.instance_id, l.cin7_purchase_id);
    const arr = receiptsByPo.get(k);
    if (arr) arr.push(l);
    else receiptsByPo.set(k, [l]);
  }

  const rows: PoQuantityRow[] = [];
  for (const h of purchases) {
    const instanceName = instanceNames[h.instance_id] ?? h.instance_id;
    if (!h.detail_synced_at) {
      rows.push(placeholderRow(h, instanceName, "detail_not_synced"));
      continue;
    }

    const k = poKey(h.instance_id, h.cin7_purchase_id);
    const orders = ordersByPo.get(k) ?? [];
    const receipts = receiptsByPo.get(k) ?? [];
    if (orders.length === 0 && receipts.length === 0) {
      rows.push(placeholderRow(h, instanceName, "no_lines_cached"));
      continue;
    }

    const bySku = new Map<string, SkuAgg>();
    const get = (sku: string): SkuAgg => {
      let a = bySku.get(sku);
      if (!a) {
        a = { name: null, orderedLines: 0, ordered: 0, received: 0 };
        bySku.set(sku, a);
      }
      return a;
    };
    for (const o of orders) {
      const a = get(normSku(o.product_sku));
      a.orderedLines += 1;
      a.ordered += toNum(o.quantity);
      a.name = a.name ?? o.product_name;
    }
    for (const r of receipts) {
      const a = get(normSku(r.product_sku));
      a.received += toNum(r.quantity);
      a.name = a.name ?? r.product_name;
    }

    let quality: DataQuality = "ok";
    let note: string | null = null;
    if (isDetailPossiblyStale(h)) {
      quality = "possibly_stale";
      note = "PO changed in Cin7 after its quantities were last fetched; received quantities may be out of date.";
    } else if (!h.is_drop_ship) {
      const suspectReason = receiptSuspectReason(h.combined_receiving_status, [...bySku.values()]);
      if (suspectReason) {
        quality = "receipt_suspect";
        note = suspectReason;
      }
    }
    for (const [sku, a] of [...bySku.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      const ordered = round(a.ordered);
      const received = round(a.received);
      rows.push({
        key: `${k}|${sku}`,
        instanceId: h.instance_id,
        instanceName,
        cin7PurchaseId: h.cin7_purchase_id,
        orderNumber: h.order_number,
        supplierName: h.supplier_name,
        orderDate: h.order_date,
        poStatus: h.status,
        receivingStatus: h.combined_receiving_status,
        isDropShip: Boolean(h.is_drop_ship),
        sku,
        productName: a.name,
        orderLineCount: a.orderedLines,
        ordered,
        received,
        outstanding: round(ordered - received),
        lineStatus: classifyLine(ordered, received),
        notOnOrder: a.orderedLines === 0 && received !== 0,
        dataQuality: quality,
        dataQualityNote: note,
        detailSyncedAt: h.detail_synced_at,
      });
    }
  }
  return rows;
}

export interface InstanceSyncSummary {
  instanceId: string;
  instanceName: string;
  poCount: number;
  /** POs whose detail has never synced or is queued for re-fetch (incl. ones failing every run). */
  detailPending: number;
  possiblyStale: number;
  lastListSyncedAt: string | null;
  lastDetailSyncedAt: string | null;
  /** Approximate start of cached coverage: first cached PO's creation − 12 months (the sync's initial backfill window). Null if no POs cached. */
  approxCoverageFrom: string | null;
}

export const BACKFILL_MONTHS = 12;

export function summariseInstanceSync(input: {
  purchases: PurchaseHeader[];
  listSyncedAt: Record<string, string | null>;
  instanceNames: Record<string, string>;
  instanceIds: string[];
}): InstanceSyncSummary[] {
  return input.instanceIds.map((instanceId) => {
    const mine = input.purchases.filter((p) => p.instance_id === instanceId);
    let lastDetail: string | null = null;
    let firstCreated: string | null = null;
    for (const p of mine) {
      if (p.detail_synced_at && (!lastDetail || p.detail_synced_at > lastDetail)) lastDetail = p.detail_synced_at;
      if (p.created_at && (!firstCreated || p.created_at < firstCreated)) firstCreated = p.created_at;
    }
    let approxCoverageFrom: string | null = null;
    if (firstCreated) {
      const d = new Date(firstCreated);
      d.setMonth(d.getMonth() - BACKFILL_MONTHS);
      approxCoverageFrom = d.toISOString().slice(0, 10);
    }
    return {
      instanceId,
      instanceName: input.instanceNames[instanceId] ?? instanceId,
      poCount: mine.length,
      detailPending: mine.filter((p) => !p.detail_synced_at).length,
      possiblyStale: mine.filter(isDetailPossiblyStale).length,
      lastListSyncedAt: input.listSyncedAt[instanceId] ?? null,
      lastDetailSyncedAt: lastDetail,
      approxCoverageFrom,
    };
  });
}

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  fully_received: "Fully received",
  partially_received: "Partially received",
  not_received: "Not received",
  over_received: "Over-received",
};

export const DATA_QUALITY_LABEL: Record<DataQuality, string> = {
  ok: "Complete",
  detail_not_synced: "Incomplete — detail not synced",
  no_lines_cached: "Incomplete — no lines cached",
  possibly_stale: "Potentially stale",
  receipt_suspect: "Suspect — receipts don't match Cin7 status",
};

export const QUALITY_GROUP_LABEL: Record<QualityGroup, string> = {
  complete: "Complete",
  incomplete: "Incomplete",
  stale: "Potentially stale",
  suspect: "Suspect",
};
