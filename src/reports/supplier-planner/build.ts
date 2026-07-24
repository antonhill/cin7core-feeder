/**
 * Supplier Planner — the "Imports"/lead-time-based procurement workflow,
 * deliberately kept separate from the simpler threshold-based Reorder
 * Report (Anton, 2026-07-23): different audience, different cadence
 * (bi-monthly vs monthly), and combining them would force a single tool to
 * arbitrate which threshold wins when a SKU has both a reorder level and a
 * supplier lead time configured.
 *
 * For each (product, supplier, location) entry with a Lead time configured
 * (src/cin7/product-supplier-options.ts): threshold = the greater of a
 * velocity-based lead-time demand figure and the supplier's own
 * `MinimumToReorder` — Anton confirmed the supplier's own configured
 * minimum should act as a floor under the velocity-based number, not be
 * overridden by it ("a bit of overlap" with the Reorder Report's own
 * threshold concept, without merging the two tools).
 */

export interface SupplierPlanOptionInput {
  locationId: string | null;
  locationName: string | null;
  reorderQuantity: number;
  lead: number | null;
  safety: number | null;
  minimumToReorder: number | null;
}

export interface SupplierPlanLinkInput {
  supplierId: string;
  supplierName: string;
  cost: number | null;
  currency: string | null;
  options: SupplierPlanOptionInput[];
}

export interface SupplierPlanProductInput {
  sku: string;
  name: string;
  suppliers: SupplierPlanLinkInput[];
}

export interface SupplierPlanLine {
  productSku: string;
  productName: string;
  supplierId: string;
  supplierName: string;
  currency: string | null;
  cost: number | null;
  locationId: string | null;
  locationName: string | null;
  lead: number;
  safety: number;
  onHand: number;
  onOrder: number;
  totalOut: number;
  threshold: number;
  suggestedQty: number;
  needsReorder: boolean;
  moverCategory: SupplierPlanMoverCategory;
  status: SupplierPlanStatus;
  /** Lead/Safety/ReorderQuantity/MinimumToReorder all zero/unset — Cin7 appears to return this exact all-zero placeholder shape for a product+supplier link that has never had Product Supplier Options configured at all (confirmed live 2026-07-24 against a real account), rather than omitting the entry or nulling Lead. Distinguishing this from a genuinely-configured zero-lead entry needs all four fields to agree — a real entry could deliberately have Lead=0 (instant local pickup) while still carrying a real ReorderQuantity/MinimumToReorder. */
  isUnconfigured: boolean;
}

export type SupplierPlanMoverCategory = "Fast" | "Medium" | "Slow" | "No movement";
export type SupplierPlanStatus = "Stockout risk" | "Excess" | "Healthy";

/** Same per-SKU on_order/mover/status the Reorder Report already computes (report_reorder RPC) — passed through rather than re-derived here. Optional/defaulted so existing callers/tests that only care about the threshold math don't need to supply it. */
export interface SupplierPlanExtra {
  onOrder: number;
  moverCategory: SupplierPlanMoverCategory;
  status: SupplierPlanStatus;
}

export interface BuildSupplierPlanOptions {
  bufferPercent: number;
  periodDays: number;
}

/**
 * Cin7 auto-copies the "default" (locationId: null) options entry's Lead/
 * Safety/ReorderQuantity to EVERY existing location the first time a
 * supplier's options are configured — confirmed live 2026-07-23 (25
 * per-location entries alongside the one default entry, every one an exact
 * copy). Naively emitting one line per location would flood the report
 * with near-duplicate rows for every product. Collapses to just the
 * default entry, and only ALSO surfaces a location's own entry when its
 * values genuinely diverge from the default — i.e. someone actually
 * customized that location.
 */
function dedupeOptions(options: SupplierPlanOptionInput[]): SupplierPlanOptionInput[] {
  const defaultOption = options.find((o) => o.locationId === null) ?? options[0];
  if (!defaultOption) return [];
  const divergent = options.filter(
    (o) =>
      o.locationId !== null &&
      (o.lead !== defaultOption.lead || o.safety !== defaultOption.safety || o.reorderQuantity !== defaultOption.reorderQuantity)
  );
  return [defaultOption, ...divergent];
}

const DEFAULT_EXTRA: SupplierPlanExtra = { onOrder: 0, moverCategory: "No movement", status: "Healthy" };

/** See SupplierPlanLine.isUnconfigured's own comment — requires every planning field to be zero/unset at once, not just Lead alone, so a deliberately-configured zero-lead entry with a real ReorderQuantity/MinimumToReorder isn't mistaken for an unconfigured placeholder. */
function isUnconfiguredOption(option: SupplierPlanOptionInput): boolean {
  return option.lead === 0 && (option.safety ?? 0) === 0 && option.reorderQuantity === 0 && !option.minimumToReorder;
}

export function buildSupplierPlanLines(
  products: SupplierPlanProductInput[],
  velocityBySku: Map<string, number>,
  onHandBySku: Map<string, number>,
  opts: BuildSupplierPlanOptions,
  extraBySku: Map<string, SupplierPlanExtra> = new Map()
): SupplierPlanLine[] {
  const lines: SupplierPlanLine[] = [];

  for (const product of products) {
    const totalOut = velocityBySku.get(product.sku) ?? 0;
    const onHand = onHandBySku.get(product.sku) ?? 0;
    const extra = extraBySku.get(product.sku) ?? DEFAULT_EXTRA;
    const dailyRate = opts.periodDays > 0 ? totalOut / opts.periodDays : 0;

    for (const supplier of product.suppliers) {
      for (const option of dedupeOptions(supplier.options)) {
        if (option.lead === null) continue; // nothing to plan a lead time around

        const lead = option.lead;
        const safety = option.safety ?? 0;
        const leadTimeDemand = dailyRate * (lead + safety) * (1 + opts.bufferPercent / 100);
        const threshold = Math.max(leadTimeDemand, option.minimumToReorder ?? 0);
        const suggestedQty = Math.max(option.reorderQuantity || 0, threshold - onHand);

        lines.push({
          productSku: product.sku,
          productName: product.name,
          supplierId: supplier.supplierId,
          supplierName: supplier.supplierName,
          currency: supplier.currency,
          cost: supplier.cost,
          locationId: option.locationId,
          locationName: option.locationName,
          lead,
          safety,
          onHand,
          onOrder: extra.onOrder,
          totalOut,
          threshold: Math.round(threshold * 100) / 100,
          suggestedQty: Math.round(Math.max(suggestedQty, 0) * 100) / 100,
          needsReorder: onHand <= threshold,
          moverCategory: extra.moverCategory,
          status: extra.status,
          isUnconfigured: isUnconfiguredOption(option),
        });
      }
    }
  }

  return lines;
}

/** Groups lines by supplier for the UI's grouped-by-supplier table — same data-shaping createReplenishTransfersAction already does keyed by destination location, just keyed by supplier here. */
export function groupLinesBySupplier(lines: SupplierPlanLine[]): Map<string, SupplierPlanLine[]> {
  const grouped = new Map<string, SupplierPlanLine[]>();
  for (const line of lines) {
    const key = line.supplierName || line.supplierId;
    const arr = grouped.get(key) ?? [];
    arr.push(line);
    grouped.set(key, arr);
  }
  return grouped;
}
