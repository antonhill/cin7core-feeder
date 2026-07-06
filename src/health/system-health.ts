/**
 * System Health scorecard — scans a live Cin7 Core instance across 6
 * dimensions and reports a per-dimension flagged-item list plus one overall
 * score. Same "live scan on demand, no canonical-DB staging" design as the
 * Data Audit tool (src/audit/product-audit.ts) — read-only, nothing is
 * written back. Field names/values below are live-verified (see
 * docs/PROJECT-NOTES.md and the plan history) against a real Cin7 sandbox,
 * not assumed from written docs.
 */

import type { Cin7SaleListEntry } from "@/cin7/sales";
import type { Cin7PurchaseListEntry } from "@/cin7/purchases";
import type { Cin7StockTransferListEntry } from "@/cin7/stock-transfers";
import type { Cin7FinishedGoodsListEntry } from "@/cin7/finished-goods";
import type { Cin7ProductionOrderListEntry } from "@/cin7/production-orders";
import type { ProductAuditResult } from "@/audit/product-audit";

export type HealthTone = "green" | "amber" | "red";

export interface DimensionResult<T> {
  key: string;
  label: string;
  flaggedCount: number;
  totalScanned: number;
  tone: HealthTone;
  items: T[];
}

export interface OverdueSale {
  saleId: string;
  orderNumber: string;
  customer: string;
  fulfilmentStatus: string;
  shipBy: string;
}

export interface OverduePurchase {
  purchaseId: string;
  orderNumber: string;
  supplier: string;
  receivingStatus: string;
  requiredBy: string;
}

export interface StuckTransfer {
  taskId: string;
  number: string;
  status: string;
  fromLocation: string;
  toLocation: string;
}

export interface IncompleteAssembly {
  taskId: string;
  assemblyNumber: string;
  productName: string;
  status: string;
}

export interface BehindProductionOrder {
  taskId: string;
  orderNumber: string;
  productName: string;
  status: string;
  requiredByDate: string;
}

export interface SystemHealthResult {
  sales: DimensionResult<OverdueSale>;
  purchases: DimensionResult<OverduePurchase>;
  transfers: DimensionResult<StuckTransfer>;
  assemblies: DimensionResult<IncompleteAssembly>;
  productionOrders: DimensionResult<BehindProductionOrder>;
  productData: DimensionResult<{ productId: string; sku: string; name: string }>;
  overallScore: number;
}

/** True when `value` is a real, parseable date strictly before `now`. Blank/null/unparseable dates are never "past deadline" — there's nothing to compare against. */
function isPast(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime();
}

/** Sales whose fulfilment hasn't happened yet and whose ShipBy deadline has passed. FulFilmentStatus casing is Cin7's own (not a typo here). */
export function findOverdueSales(sales: Cin7SaleListEntry[], now: Date = new Date()): OverdueSale[] {
  return sales
    .filter((s) => s.FulFilmentStatus && s.FulFilmentStatus !== "FULFILLED" && isPast(s.ShipBy, now))
    .map((s) => ({
      saleId: s.SaleID,
      orderNumber: s.OrderNumber ?? "",
      customer: s.Customer ?? "",
      fulfilmentStatus: s.FulFilmentStatus ?? "",
      shipBy: s.ShipBy ?? "",
    }));
}

/** Purchases not (fully) received whose RequiredBy deadline has passed. NOT AVAILABLE / blank CombinedReceivingStatus values are deliberately excluded — they mean "not applicable", not "outstanding". */
const OUTSTANDING_RECEIVING_STATUSES = new Set(["NOT RECEIVED", "PARTIALLY RECEIVED"]);

export function findOverduePurchases(purchases: Cin7PurchaseListEntry[], now: Date = new Date()): OverduePurchase[] {
  return purchases
    .filter((p) => p.CombinedReceivingStatus && OUTSTANDING_RECEIVING_STATUSES.has(p.CombinedReceivingStatus) && isPast(p.RequiredBy, now))
    .map((p) => ({
      purchaseId: p.ID,
      orderNumber: p.OrderNumber ?? "",
      supplier: p.Supplier ?? "",
      receivingStatus: p.CombinedReceivingStatus ?? "",
      requiredBy: p.RequiredBy ?? "",
    }));
}

/** Transfers sitting in draft/ordered/in-transit — the "stuck" states Anton described. COMPLETED/VOIDED are the two terminal states, excluded. No deadline comparison — none exists on the list endpoint (see stock-transfers.ts). */
const STUCK_TRANSFER_STATUSES = new Set(["DRAFT", "ORDERED", "IN TRANSIT"]);

export function findStuckTransfers(transfers: Cin7StockTransferListEntry[]): StuckTransfer[] {
  return transfers
    .filter((t) => t.Status && STUCK_TRANSFER_STATUSES.has(t.Status))
    .map((t) => ({
      taskId: t.TaskID,
      number: t.Number ?? "",
      status: t.Status ?? "",
      fromLocation: t.FromLocation ?? "",
      toLocation: t.ToLocation ?? "",
    }));
}

/** Assemblies not yet completed. No deadline field exists on this resource at all (confirmed live) — status only, no "past deadline" concept possible here. */
const INCOMPLETE_ASSEMBLY_STATUSES = new Set(["DRAFT", "AUTHORISED", "IN PROGRESS"]);

export function findIncompleteAssemblies(finishedGoods: Cin7FinishedGoodsListEntry[]): IncompleteAssembly[] {
  return finishedGoods
    .filter((f) => f.Status && INCOMPLETE_ASSEMBLY_STATUSES.has(f.Status))
    .map((f) => ({
      taskId: f.TaskID,
      assemblyNumber: f.AssemblyNumber ?? "",
      productName: f.ProductName ?? "",
      status: f.Status ?? "",
    }));
}

/**
 * Production orders not yet complete whose RequiredByDate has passed.
 * Filters to Type "O" (the order itself) internally — Type "R" rows are
 * routing sub-records sharing the same ProductionOrderID and would
 * double-count if included (confirmed live).
 */
const OPEN_PRODUCTION_ORDER_STATUSES_EXCLUDED = new Set(["COMPLETED", "VOIDED"]);

export function findBehindProductionOrders(orders: Cin7ProductionOrderListEntry[], now: Date = new Date()): BehindProductionOrder[] {
  return orders
    .filter((o) => o.Type === "O")
    .filter((o) => o.Status && !OPEN_PRODUCTION_ORDER_STATUSES_EXCLUDED.has(o.Status) && isPast(o.RequiredByDate, now))
    .map((o) => ({
      taskId: o.TaskID,
      orderNumber: o.OrderNumber ?? "",
      productName: o.ProductName ?? "",
      status: o.Status ?? "",
      requiredByDate: o.RequiredByDate ?? "",
    }));
}

/** Reuses the existing Data Audit's findings — counts distinct products with at least one issue against the full scanned roster. */
function scoreProductData(auditResult: ProductAuditResult): { flagged: { productId: string; sku: string; name: string }[]; total: number } {
  const flaggedIds = new Set(auditResult.issues.map((i) => i.productId));
  const flagged = auditResult.products.filter((p) => flaggedIds.has(p.productId)).map((p) => ({ productId: p.productId, sku: p.sku, name: p.name }));
  return { flagged, total: auditResult.products.length };
}

/**
 * Severity heuristic — green when nothing's flagged, red once flagged items
 * exceed 15% of what was scanned, amber in between. A simple, adjustable
 * rule (no configured threshold requested); total=0 always yields green,
 * no divide-by-zero.
 */
function toDimension<T>(key: string, label: string, items: T[], totalScanned: number): DimensionResult<T> {
  const flaggedCount = items.length;
  const percentFlagged = totalScanned > 0 ? flaggedCount / totalScanned : 0;
  const tone: HealthTone = flaggedCount === 0 ? "green" : percentFlagged <= 0.15 ? "amber" : "red";
  return { key, label, flaggedCount, totalScanned, tone, items };
}

export interface SystemHealthInput {
  sales: Cin7SaleListEntry[];
  purchases: Cin7PurchaseListEntry[];
  transfers: Cin7StockTransferListEntry[];
  finishedGoods: Cin7FinishedGoodsListEntry[];
  productionOrders: Cin7ProductionOrderListEntry[];
  productAudit: ProductAuditResult;
}

export function runSystemHealth(input: SystemHealthInput, now: Date = new Date()): SystemHealthResult {
  const sales = toDimension("sales", "Sales unfulfilled past deadline", findOverdueSales(input.sales, now), input.sales.length);
  const purchases = toDimension(
    "purchases",
    "Purchases not received past deadline",
    findOverduePurchases(input.purchases, now),
    input.purchases.length
  );
  const transfers = toDimension("transfers", "Transfers stuck", findStuckTransfers(input.transfers), input.transfers.length);
  const assemblies = toDimension(
    "assemblies",
    "Assemblies not completed",
    findIncompleteAssemblies(input.finishedGoods),
    input.finishedGoods.length
  );
  const productionOrders = toDimension(
    "productionOrders",
    "Production Orders due and behind",
    findBehindProductionOrders(input.productionOrders, now),
    input.productionOrders.filter((o) => o.Type === "O").length
  );
  const { flagged: productDataFlagged, total: productDataTotal } = scoreProductData(input.productAudit);
  const productData = toDimension("productData", "Product data health", productDataFlagged, productDataTotal);

  const dimensions = [sales, purchases, transfers, assemblies, productionOrders, productData];
  const averagePercentFlagged =
    dimensions.reduce((sum, d) => sum + (d.totalScanned > 0 ? d.flaggedCount / d.totalScanned : 0), 0) / dimensions.length;
  const overallScore = Math.round(100 * (1 - averagePercentFlagged));

  return { sales, purchases, transfers, assemblies, productionOrders, productData, overallScore };
}
