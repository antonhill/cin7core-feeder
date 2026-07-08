import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { fetchAllProductionOrdersList } from "@/cin7/production-orders";
import type { CostEstimatorBomLine } from "@/cin7/product-cost";

export interface LatestProductionOrderInfo {
  productionOrderId: string;
  orderNumber: string;
  completionDate: string | null;
}

/**
 * Confirmed live 2026-07-08 (order "MO-00036"): a Production BOM's recipe
 * can only be read from a completed Manufacture Order's detail —
 * /production/productionBOM (the BOM *definition*) returned zero versions
 * even for a SKU proven to have a real, built BOM version. Picks the most
 * recent order per SKU (by CompletionDate, ISO 8601 so lexicographic
 * comparison is chronological) since a SKU can have several orders and only
 * one recipe should represent it.
 */
export async function fetchLatestProductionOrdersBySku(
  creds: Cin7Credentials,
): Promise<Map<string, LatestProductionOrderInfo>> {
  const orders = await fetchAllProductionOrdersList(creds);
  const bySku = new Map<string, LatestProductionOrderInfo>();

  for (const order of orders) {
    if (
      order.Type !== "O" ||
      !order.ProductSku ||
      !order.ProductionOrderID ||
      !order.OrderNumber
    )
      continue;
    const candidateDate = order.CompletionDate ?? order.RequiredByDate ?? "";
    const existing = bySku.get(order.ProductSku);
    if (!existing || candidateDate > (existing.completionDate ?? "")) {
      bySku.set(order.ProductSku, {
        productionOrderId: order.ProductionOrderID,
        orderNumber: order.OrderNumber,
        completionDate: order.CompletionDate ?? null,
      });
    }
  }

  return bySku;
}

export interface ProductionResourceLine {
  resourceCode: string;
  resourceName: string;
  quantity: number;
  /** As reported by the source order — Cin7's own "0 means missing" sentinel applies (see estimate.ts's nonZero), so a 0/absent value reads as no cost recorded, not free. */
  cost: number | null;
  totalCost: number | null;
  /** The operation/step this resource line belongs to (WorkCenterName, e.g. "Mixing"/"Blending" — falls back to the operation's own Name if no work centre is set). Confirmed 2026-07-08 against a real order (MO-00041): the same resource code can legitimately appear once per operation with different costs, so this is what disambiguates otherwise-identical-looking rows, matching Cin7's own native report's per-step grouping. */
  stepName: string;
  /** Best-effort field name from the community client spec (e.g. "Cost per finished product" / "Cost per unit of time") — not yet confirmed against a raw live response, only inferred by matching Cin7's own report UI for the same order. Null if absent/wrong-cased on this account. */
  costCalculationType: string | null;
}

export interface ProductionOrderDetail {
  components: CostEstimatorBomLine[];
  resources: ProductionResourceLine[];
}

/**
 * Fetches one completed Manufacture Order's full nested Operations detail
 * and flattens it into a plain recipe: Components (deduped/summed by SKU
 * across operations, since costing needs one total quantity per component
 * SKU) and Resources (kept as separate per-operation lines — not re-priced,
 * see costing/production-estimate.ts).
 *
 * Field names for Components are confirmed live against a real response
 * (order "MO-00036") — notably `ProductSku` (not `ProductSKU`, unlike the
 * community client spec's generated model — yet another live casing
 * mismatch this project has repeatedly found). Resource field names are
 * NOT yet confirmed live (the one real order sampled had an empty
 * Resources array for its single operation) — best-effort from the same
 * community client spec, ready to correct once a populated example turns up.
 */
export async function fetchProductionOrderDetail(
  creds: Cin7Credentials,
  productionOrderId: string,
): Promise<ProductionOrderDetail> {
  const response = await cin7Request<{
    ProductionOrders?: Record<string, unknown>[];
  }>(creds, "/production/order", {
    query: {
      ProductionOrderID: productionOrderId,
      ReturnAttachmentsContent: "false",
    },
  });
  const order = response.ProductionOrders?.[0];
  const operations = Array.isArray(order?.Operations)
    ? (order.Operations as Record<string, unknown>[])
    : [];

  const componentsBySku = new Map<string, CostEstimatorBomLine>();
  const resources: ProductionResourceLine[] = [];

  for (const operation of operations) {
    const rawComponents = Array.isArray(operation.Components)
      ? (operation.Components as Record<string, unknown>[])
      : [];
    for (const c of rawComponents) {
      const sku = String(c.ProductSku ?? "");
      if (!sku) continue;
      const quantity = Number(c.Quantity ?? 0);
      const wastageQuantity = Number(c.WastageQty ?? 0);
      const existing = componentsBySku.get(sku);
      if (existing) {
        existing.quantity += quantity;
        existing.wastageQuantity += wastageQuantity;
      } else {
        componentsBySku.set(sku, {
          componentSku: sku,
          componentName: String(c.ProductName ?? ""),
          quantity,
          wastageQuantity,
        });
      }
    }

    const stepName = String(operation.WorkCenterName ?? operation.Name ?? "");
    const rawResources = Array.isArray(operation.Resources)
      ? (operation.Resources as Record<string, unknown>[])
      : [];
    for (const r of rawResources) {
      const code = String(r.ResourceCode ?? r.ResourceName ?? "");
      if (!code) continue;
      const cost = typeof r.Cost === "number" && r.Cost !== 0 ? r.Cost : null;
      const totalCost =
        typeof r.TotalCost === "number" && r.TotalCost !== 0
          ? r.TotalCost
          : null;
      resources.push({
        resourceCode: code,
        resourceName: String(r.ResourceName ?? code),
        quantity: Number(r.Quantity ?? 0),
        cost,
        totalCost,
        stepName,
        costCalculationType:
          typeof r.CostCalculationType === "string"
            ? r.CostCalculationType
            : null,
      });
    }
  }

  return { components: [...componentsBySku.values()], resources };
}
