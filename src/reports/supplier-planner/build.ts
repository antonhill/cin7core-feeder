/**
 * Supplier Planner — the "Imports"/lead-time-based procurement workflow,
 * deliberately kept separate from the simpler threshold-based Reorder
 * Report (Anton, 2026-07-23): different audience, different cadence
 * (bi-monthly vs monthly), and combining them would force a single tool to
 * arbitrate which threshold wins when a SKU has both a reorder level and a
 * supplier lead time configured.
 *
 * For each (product, supplier, location) with a Lead time configured
 * (src/cin7/product-supplier-options.ts): threshold = the greater of a
 * velocity-based lead-time demand figure and the supplier's own
 * `MinimumToReorder` — Anton confirmed the supplier's own configured
 * minimum should act as a floor under the velocity-based number, not be
 * overridden by it ("a bit of overlap" with the Reorder Report's own
 * threshold concept, without merging the two tools).
 *
 * **Per-location demand (2026-07-25):** on-hand/on-order/sales-velocity are
 * now genuinely computed per real Cin7 location, not one instance-wide
 * aggregate reused under every location label. Anton flagged that a line
 * could show a specific location name while still doing its math off the
 * whole instance's stock/sales — see report_supplier_plan_location_demand
 * (migration 0049) and query.ts's getSupplierPlanLocationDemand for where
 * this per-location data actually comes from. One deliberate limitation
 * carried over from that function: it only attributes SALES to a location
 * (sales.location is real, synced data); assembly-consumption demand is not
 * location-tagged in this schema today and is excluded here, unlike Reorder
 * Report's own total_out which blends both sources.
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
  productId: string;
  sku: string;
  name: string;
  suppliers: SupplierPlanLinkInput[];
}

export interface SupplierPlanLine {
  productId: string;
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

/** Same per-SKU mover/status the Reorder Report already computes (report_reorder RPC) — passed through rather than re-derived here, since there's no per-location equivalent bucketing yet (see this file's own header comment). onOrder is NOT here — like onHand/totalOut, it now comes from the per-location demand data instead, so a location's own incoming stock reduces only that location's own need. Optional/defaulted so existing callers/tests that only care about the threshold math don't need to supply it. */
export interface SupplierPlanExtra {
  moverCategory: SupplierPlanMoverCategory;
  status: SupplierPlanStatus;
}

export interface BuildSupplierPlanOptions {
  bufferPercent: number;
  periodDays: number;
}

/** One location's own on-hand/on-order/sales-velocity figures — see report_supplier_plan_location_demand (migration 0049). */
export interface SupplierPlanLocationDemand {
  onHand: number;
  onOrder: number;
  totalOut: number;
}

export interface SupplierPlanDemandData {
  /** sku -> real Cin7 location name -> that location's own demand. Only present for a SKU when it actually has synced per-location activity (product_availability and/or sale_lines/sales rows). */
  byLocation: Map<string, Map<string, SupplierPlanLocationDemand>>;
  /** sku -> org-wide aggregate demand (report_reorder) — used only as a fallback when a SKU has zero per-location rows at all (e.g. a brand-new product with nothing synced yet), so a real MinimumToReorder floor still surfaces a line instead of silently disappearing. */
  fallbackBySku: Map<string, SupplierPlanLocationDemand>;
  /** Real Cin7 location name -> its LocationID — a demand-derived line needs a genuine ID for PO creation, since it no longer necessarily comes from a matching supplier-option row. */
  locationIdByName: Map<string, string>;
}

const DEFAULT_EXTRA: SupplierPlanExtra = { moverCategory: "No movement", status: "Healthy" };
const ZERO_DEMAND: SupplierPlanLocationDemand = { onHand: 0, onOrder: 0, totalOut: 0 };

/** See SupplierPlanLine.isUnconfigured's own comment — requires every planning field to be zero/unset at once, not just Lead alone, so a deliberately-configured zero-lead entry with a real ReorderQuantity/MinimumToReorder isn't mistaken for an unconfigured placeholder. */
function isUnconfiguredOption(option: SupplierPlanOptionInput): boolean {
  return option.lead === 0 && (option.safety ?? 0) === 0 && option.reorderQuantity === 0 && !option.minimumToReorder;
}

export function buildSupplierPlanLines(
  products: SupplierPlanProductInput[],
  demand: SupplierPlanDemandData,
  opts: BuildSupplierPlanOptions,
  extraBySku: Map<string, SupplierPlanExtra> = new Map()
): SupplierPlanLine[] {
  const lines: SupplierPlanLine[] = [];

  for (const product of products) {
    const extra = extraBySku.get(product.sku) ?? DEFAULT_EXTRA;
    const perLocation = demand.byLocation.get(product.sku);
    // A SKU with genuine per-location activity gets one demand entry per
    // real location it actually has stock/sales in — no location the
    // product has never touched gets a manufactured zero row. A SKU with
    // NONE at all (nothing synced yet) falls back to a single org-wide
    // entry, same as this report's previous instance-wide-only behavior.
    const demandEntries: { locationName: string | null; figures: SupplierPlanLocationDemand }[] =
      perLocation && perLocation.size > 0
        ? [...perLocation.entries()].map(([locationName, figures]) => ({ locationName, figures }))
        : [{ locationName: null, figures: demand.fallbackBySku.get(product.sku) ?? ZERO_DEMAND }];

    for (const supplier of product.suppliers) {
      const defaultOption = supplier.options.find((o) => o.locationId === null) ?? supplier.options[0];
      if (!defaultOption || defaultOption.lead === null) continue; // nothing to plan a lead time around

      // MinimumToReorder only ever populates on the default (locationId:
      // null) entry — Cin7 only lets it be configured centrally, never
      // per-location (src/cin7/product-supplier-options.ts) — so it always
      // comes from here regardless of which location's own option below
      // supplies the lead time/reorder quantity.
      const minimumFloor = defaultOption.minimumToReorder ?? 0;

      for (const { locationName, figures } of demandEntries) {
        const matchingOption = locationName ? supplier.options.find((o) => o.locationId !== null && o.locationName === locationName) : undefined;
        const option = matchingOption ?? defaultOption;
        if (option.lead === null) continue;

        const lead = option.lead;
        const safety = option.safety ?? 0;
        const dailyRate = opts.periodDays > 0 ? figures.totalOut / opts.periodDays : 0;
        const leadTimeDemand = dailyRate * (lead + safety) * (1 + opts.bufferPercent / 100);
        const threshold = Math.max(leadTimeDemand, minimumFloor);
        const suggestedQty = Math.max(option.reorderQuantity || 0, threshold - figures.onHand);

        lines.push({
          productId: product.productId,
          productSku: product.sku,
          productName: product.name,
          supplierId: supplier.supplierId,
          supplierName: supplier.supplierName,
          currency: supplier.currency,
          cost: supplier.cost,
          locationId: locationName ? (demand.locationIdByName.get(locationName) ?? null) : null,
          locationName,
          lead,
          safety,
          onHand: figures.onHand,
          onOrder: figures.onOrder,
          totalOut: figures.totalOut,
          threshold: Math.round(threshold * 100) / 100,
          suggestedQty: Math.round(Math.max(suggestedQty, 0) * 100) / 100,
          needsReorder: figures.onHand <= threshold,
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

export interface PurchaseOrderGroup {
  supplierId: string;
  supplierName: string;
  locationId: string;
  locationName: string;
  lines: SupplierPlanLine[];
}

export interface PurchaseOrderFallbackLocation {
  locationId: string;
  locationName: string;
}

/**
 * Groups selected lines by (supplier, location) — not just supplier — for
 * real PO creation, since a Cin7 Purchase Order has exactly one receiving
 * Location (confirmed live 2026-07-25, src/cin7/purchase-write.ts). A
 * supplier whose selected lines span multiple locations needs one PO per
 * location, not one PO overall.
 *
 * A line only has `locationId: null` when its SKU has no per-location
 * demand data at all (buildSupplierPlanLines' own org-wide fallback case)
 * — `fallbackLocation`, a location the caller has the user explicitly
 * choose as "where this PO's stock arrives," fills in for that case.
 * Without a fallback, a location-less line is skipped — nowhere for Cin7
 * to receive that stock into.
 */
export function groupLinesForPurchaseOrders(lines: SupplierPlanLine[], fallbackLocation?: PurchaseOrderFallbackLocation): PurchaseOrderGroup[] {
  const grouped = new Map<string, PurchaseOrderGroup>();
  for (const line of lines) {
    const locationId = line.locationId ?? fallbackLocation?.locationId ?? null;
    const locationName = line.locationName ?? fallbackLocation?.locationName ?? null;
    if (!locationId || !locationName) continue;
    const key = `${line.supplierId}::${locationId}`;
    const existing = grouped.get(key);
    if (existing) existing.lines.push(line);
    else grouped.set(key, { supplierId: line.supplierId, supplierName: line.supplierName, locationId, locationName, lines: [line] });
  }
  return [...grouped.values()];
}
