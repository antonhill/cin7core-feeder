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
  /** Not a true "created" timestamp — Cin7 doesn't expose one on this list endpoint, only last-modified. */
  lastModifiedOn: string;
}

export interface IncompleteAssembly {
  taskId: string;
  assemblyNumber: string;
  productName: string;
  status: string;
  /** The build/start date — often blank on a fresh DRAFT that hasn't been started yet (confirmed live). Not a deadline field. */
  date: string;
}

export interface ProductDataBreakdownItem {
  label: string;
  count: number;
  unit: "products" | "groups";
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
  productData: DimensionResult<ProductDataBreakdownItem>;
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
      lastModifiedOn: t.LastModifiedOn ?? "",
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
      date: f.Date ?? "",
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

/**
 * Reuses the existing Data Audit's findings and breaks them down by the same
 * named checks the /audit page itself surfaces (Anton: "so basically what
 * the audit tab gives but just scoring it overall") — rather than a single
 * blended "products affected" count, which wasn't specific enough to act on.
 * Zero-count rows are dropped so a clean catalog shows an empty breakdown.
 * `flaggedProducts` (distinct products with ≥1 issue) still drives the
 * overall tone/score, matching how every other dimension is scored.
 */
function scoreProductData(auditResult: ProductAuditResult): { breakdown: ProductDataBreakdownItem[]; flaggedProducts: number; total: number } {
  const countByType = new Map<string, number>();
  for (const issue of auditResult.issues) {
    countByType.set(issue.type, (countByType.get(issue.type) ?? 0) + 1);
  }

  const missingInventorySetup =
    (countByType.get("missing_location") ?? 0) + (countByType.get("missing_uom") ?? 0) + (countByType.get("missing_inventory_account") ?? 0);
  const missingGLAccounts = (countByType.get("missing_revenue_account") ?? 0) + (countByType.get("missing_cogs_account") ?? 0);

  const breakdown: ProductDataBreakdownItem[] = (
    [
      { label: "Missing Brand", count: countByType.get("missing_brand") ?? 0, unit: "products" },
      { label: "Missing sales pricing", count: countByType.get("missing_sales_pricing") ?? 0, unit: "products" },
      { label: "Missing inventory setup (Location/UOM/Account)", count: missingInventorySetup, unit: "products" },
      { label: "Missing GL account mappings (Revenue/COGS)", count: missingGLAccounts, unit: "products" },
      { label: "Duplicate categories", count: auditResult.duplicateCategories.length, unit: "groups" },
      { label: "Duplicate brands", count: auditResult.duplicateBrands.length, unit: "groups" },
      { label: "Duplicate units of measure", count: auditResult.duplicateUOMs.length, unit: "groups" },
      { label: "Duplicate tags", count: auditResult.duplicateTags.length, unit: "groups" },
      { label: "Inconsistent attributes", count: auditResult.attributeGaps.length, unit: "groups" },
    ] satisfies ProductDataBreakdownItem[]
  ).filter((item) => item.count > 0);

  const flaggedProducts = new Set(auditResult.issues.map((i) => i.productId)).size;
  return { breakdown, flaggedProducts, total: auditResult.products.length };
}

/**
 * Severity heuristic — green when nothing's flagged, red once flagged items
 * exceed 15% of what was scanned, amber in between. A simple, adjustable
 * rule (no configured threshold requested); total=0 always yields green,
 * no divide-by-zero. `flaggedCount` is passed explicitly rather than derived
 * from `items.length` — Product Data Health's `items` is a named breakdown
 * (up to 9 rows), not one row per affected product.
 */
function toDimension<T>(key: string, label: string, items: T[], flaggedCount: number, totalScanned: number): DimensionResult<T> {
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
  const overdueSales = findOverdueSales(input.sales, now);
  const sales = toDimension("sales", "Sales unfulfilled past deadline", overdueSales, overdueSales.length, input.sales.length);

  const overduePurchases = findOverduePurchases(input.purchases, now);
  const purchases = toDimension(
    "purchases",
    "Purchases not received past deadline",
    overduePurchases,
    overduePurchases.length,
    input.purchases.length
  );

  const stuckTransfers = findStuckTransfers(input.transfers);
  const transfers = toDimension("transfers", "Transfers stuck", stuckTransfers, stuckTransfers.length, input.transfers.length);

  const incompleteAssemblies = findIncompleteAssemblies(input.finishedGoods);
  const assemblies = toDimension(
    "assemblies",
    "Assemblies not completed",
    incompleteAssemblies,
    incompleteAssemblies.length,
    input.finishedGoods.length
  );

  const behindProductionOrders = findBehindProductionOrders(input.productionOrders, now);
  const productionOrders = toDimension(
    "productionOrders",
    "Production Orders due and behind",
    behindProductionOrders,
    behindProductionOrders.length,
    input.productionOrders.filter((o) => o.Type === "O").length
  );

  const { breakdown, flaggedProducts, total: productDataTotal } = scoreProductData(input.productAudit);
  const productData = toDimension("productData", "Product data health", breakdown, flaggedProducts, productDataTotal);

  const dimensions = [sales, purchases, transfers, assemblies, productionOrders, productData];
  const averagePercentFlagged =
    dimensions.reduce((sum, d) => sum + (d.totalScanned > 0 ? d.flaggedCount / d.totalScanned : 0), 0) / dimensions.length;
  const overallScore = Math.round(100 * (1 - averagePercentFlagged));

  return { sales, purchases, transfers, assemblies, productionOrders, productData, overallScore };
}
