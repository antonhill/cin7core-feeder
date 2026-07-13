/**
 * Casa das Natas: individual-nata sales + packaging-COGS split.
 *
 * Natas are sold two ways in this org's Cin7 data, neither of which is
 * "units sold" the way Cin7 itself reports it:
 *
 * 1. Predefined packs (e.g. "LisbonClassic6") — the pack's own Assembly BOM
 *    doesn't reference an individual-nata product at all; it consumes
 *    casing + filling + packaging directly. 1 unit sold is really N
 *    individual natas, where N is given by the pack's own BOM (see
 *    CASING_SKUS below).
 * 2. Mixed packs — a customer buys individual single-nata SKUs (already
 *    exactly 1 nata each) combined with a separate zero-priced "patch"
 *    packaging product (e.g. "6NataPackaging") in the *same* sale, to
 *    cover the physical packaging for the combo.
 *
 * Both are normalized here into "individual natas sold" per Nata Type,
 * with packaging cost (a shared, per-pack/per-sale cost, not a per-nata
 * one) split across however many natas it actually packaged.
 */

export interface NatasSaleLineInput {
  instanceId: string;
  cin7SaleId: string;
  productSku: string;
  productName: string | null;
  categoryCode: string | null;
  quantity: number;
  /** Line revenue — already net of discount (matches sale_lines.total). */
  total: number;
  /** "YYYY-MM-DD", or null if not yet known. */
  invoiceDate: string | null;
  location: string | null;
}

export interface BomLineInput {
  productSku: string;
  componentSku: string;
  quantity: number;
  estimatedUnitCost: number | null;
  /** The *component's own* category (products.category_code), not the parent's. */
  componentCategoryCode: string | null;
}

export interface BomCostInfo {
  /** Individual natas per unit of this SKU sold — from the pack's own casing component quantity, default 1 if none found (also correct for single-nata SKUs, which always carry quantity 1). */
  casingMultiplier: number;
  /** This SKU's own BOM cost of Packaging+Label+Topping components, per unit. */
  packagingUnitCost: number;
}

export interface UnmappedItem {
  sku: string;
  name: string | null;
  quantity: number;
}

export interface AggregatedNataRow {
  /** "YYYY-MM", or "Unknown" if invoiceDate was null. */
  month: string;
  location: string;
  nataType: string;
  individualNatas: number;
  revenue: number;
  packagingCost: number;
  packagingCostPerNata: number | null;
  /** Revenue minus packaging cost only — NOT a full-COGS profit (ingredient/casing cost isn't split by this report; see the Sales report's average_cost-based Profit/Margin% for that). */
  profit: number;
  /** profit / revenue * 100, null when revenue is 0 (matches the Sales report's own null-not-0 convention for an undefined ratio). */
  marginPercent: number | null;
}

export interface NatasReportResult {
  rows: AggregatedNataRow[];
  unmapped: UnmappedItem[];
}

/**
 * Explicit allowlist, not category-based: NatasCasingStd (the Standard
 * casing) is live-confirmed miscategorized as category "Nata" rather than
 * "Casing" in this org's own Cin7 data (only NatasCasingMini is correctly
 * categorized) — category matching would silently misdetect the Standard
 * size. An explicit list sidesteps the bad data and gives an obvious single
 * place to add a future third casing SKU.
 */
export const CASING_SKUS = ["NatasCasingStd", "NatasCasingMini"];

/** Confirmed with Anton 2026-07-13: packaging cost = Packaging + Label + Topping. Gift-category add-ons (branded aprons/oven gloves on gift-box SKUs) are deliberately excluded. */
export const PACKAGING_CATEGORIES = ["Packaging", "Label", "Topping"];

/** Matches the "patch" packaging products (1NataPackaging ... 12NataPackaging) sold alongside individual singles in a mixed-pack sale — confirmed live, category "Packaging", no collision risk within this org's own catalog. */
export const PACKAGING_PATCH_SKU_PATTERN = /^\d+NataPackaging$/;

/**
 * Ordered, most-specific-prefix-first. "LisbonClassicMini" must be checked
 * before "LisbonClassic" (a prefix of it) so Mini variants land in their
 * own type per Anton's decision, not folded into the base flavor.
 * Extensible for future flavors by adding a row.
 */
export const NATA_TYPE_RULES: { skuPrefix: string; typeName: string }[] = [
  { skuPrefix: "LisbonClassicMini", typeName: "Lisbon Classic Mini" },
  { skuPrefix: "LisbonClassic", typeName: "Lisbon Classic" },
  { skuPrefix: "HappyBerry", typeName: "Happy Berry" },
];

/** Returns null (not a fallback bucket) when no rule matches — callers surface this via `unmapped` rather than silently dropping or miscounting an unrecognized flavor. */
export function mapNataType(sku: string): string | null {
  for (const rule of NATA_TYPE_RULES) {
    if (sku.startsWith(rule.skuPrefix)) return rule.typeName;
  }
  return null;
}

/** Precomputes casingMultiplier/packagingUnitCost once per distinct product SKU from its BOM lines — reused across every sale line referencing that SKU. */
export function buildBomCostIndex(bomLines: BomLineInput[]): Map<string, BomCostInfo> {
  const linesBySku = new Map<string, BomLineInput[]>();
  for (const line of bomLines) {
    const arr = linesBySku.get(line.productSku) ?? [];
    arr.push(line);
    linesBySku.set(line.productSku, arr);
  }

  const index = new Map<string, BomCostInfo>();
  for (const [sku, lines] of linesBySku) {
    let casingQty = 0;
    let packagingCost = 0;
    for (const line of lines) {
      if (CASING_SKUS.includes(line.componentSku)) casingQty += line.quantity;
      if (line.componentCategoryCode && PACKAGING_CATEGORIES.includes(line.componentCategoryCode)) {
        packagingCost += line.quantity * (line.estimatedUnitCost ?? 0);
      }
    }
    index.set(sku, { casingMultiplier: casingQty > 0 ? casingQty : 1, packagingUnitCost: packagingCost });
  }
  return index;
}

function monthOf(dateStr: string | null): string {
  return dateStr ? dateStr.slice(0, 7) : "Unknown";
}

/**
 * The core allocation. Groups sale lines by the sale they belong to (not
 * just cin7SaleId alone, since ids aren't guaranteed unique across separate
 * Cin7 instances), splits each sale's patch-packaging cost proportionally
 * across that sale's individual-nata lines by their share of natas, and
 * aggregates the result by (month, location, nataType).
 */
export function buildNatasReport(saleLines: NatasSaleLineInput[], bomCostIndex: Map<string, BomCostInfo>): NatasReportResult {
  const salesByKey = new Map<string, NatasSaleLineInput[]>();
  for (const line of saleLines) {
    const key = `${line.instanceId}:${line.cin7SaleId}`;
    const arr = salesByKey.get(key) ?? [];
    arr.push(line);
    salesByKey.set(key, arr);
  }

  const unmappedBySku = new Map<string, UnmappedItem>();
  const emitted: { month: string; location: string; nataType: string; individualNatas: number; revenue: number; packagingCost: number }[] = [];

  for (const lines of salesByKey.values()) {
    const natLines = lines.filter((l) => l.categoryCode === "Nata");
    const patchLines = lines.filter((l) => PACKAGING_PATCH_SKU_PATTERN.test(l.productSku));

    const perNatLine = natLines.map((line) => {
      const info = bomCostIndex.get(line.productSku);
      const individualNatas = line.quantity * (info?.casingMultiplier ?? 1);
      const ownPackagingCost = (info?.packagingUnitCost ?? 0) * line.quantity;
      return { line, individualNatas, ownPackagingCost };
    });

    const totalNatasInSale = perNatLine.reduce((sum, x) => sum + x.individualNatas, 0);
    const patchPackagingCostTotal = patchLines.reduce((sum, line) => {
      const info = bomCostIndex.get(line.productSku);
      return sum + (info?.packagingUnitCost ?? 0) * line.quantity;
    }, 0);

    for (const { line, individualNatas, ownPackagingCost } of perNatLine) {
      const nataType = mapNataType(line.productSku);
      if (nataType === null) {
        const existing = unmappedBySku.get(line.productSku);
        unmappedBySku.set(line.productSku, {
          sku: line.productSku,
          name: line.productName,
          quantity: (existing?.quantity ?? 0) + line.quantity,
        });
        continue;
      }

      const allocatedPatchShare =
        patchPackagingCostTotal > 0 && totalNatasInSale > 0 ? patchPackagingCostTotal * (individualNatas / totalNatasInSale) : 0;

      emitted.push({
        month: monthOf(line.invoiceDate),
        location: line.location ?? "Unknown",
        nataType,
        individualNatas,
        revenue: line.total,
        packagingCost: ownPackagingCost + allocatedPatchShare,
      });
    }
  }

  const grouped = new Map<
    string,
    { month: string; location: string; nataType: string; individualNatas: number; revenue: number; packagingCost: number }
  >();
  for (const e of emitted) {
    const key = `${e.month}|${e.location}|${e.nataType}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.individualNatas += e.individualNatas;
      existing.revenue += e.revenue;
      existing.packagingCost += e.packagingCost;
    } else {
      grouped.set(key, { ...e });
    }
  }

  const rows: AggregatedNataRow[] = [...grouped.values()]
    .map((r) => {
      const profit = r.revenue - r.packagingCost;
      return {
        ...r,
        packagingCostPerNata: r.individualNatas > 0 ? r.packagingCost / r.individualNatas : null,
        profit,
        marginPercent: r.revenue > 0 ? (profit / r.revenue) * 100 : null,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.location.localeCompare(b.location) || a.nataType.localeCompare(b.nataType));

  return { rows, unmapped: [...unmappedBySku.values()] };
}
