import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

interface Cin7ProductListResponse {
  Products?: Record<string, unknown>[];
}

/** One Product Supplier record — confirmed live 2026-07-08 via the cost-basis field survey (Settings > Cin7 Instances), only present when the request includes `IncludeSuppliers=true` (same opt-in pattern as `IncludeBOM`; the plain bulk list omits it entirely). */
export interface Cin7ProductSupplier {
  cost: number | null;
  fixedCost: number | null;
  lastSupplied: string | null;
}

/** A component/BOM line as Cin7 actually returns it on `BillOfMaterialsProducts` — see src/export/assembly-bom-csv-live.ts's BomProductLine for the same shape used on the CSV export side. */
export interface CostEstimatorBomLine {
  componentSku: string;
  componentName: string;
  quantity: number;
  wastageQuantity: number;
}

export interface CostEstimatorProduct {
  sku: string;
  name: string;
  isAssembly: boolean;
  /** Confirmed 2026-07-08: a read-only enum with exactly 4 values — "Assembly", "Production", "Make to Order", "None". Read from the same combined /Product call (no extra fetch) to detect Production BOM SKUs for the Production Cost Estimator. */
  bomType: string | undefined;
  bomLines: CostEstimatorBomLine[];
  averageCost: number | null;
  suppliers: Cin7ProductSupplier[];
}

/**
 * One paginated `/Product` pass, `IncludeBOM=true&IncludeSuppliers=true`
 * together — a single fetch serves both needs the cost estimator has
 * (which products are assemblies + their BOM lines, and every product's
 * cost fields to resolve each BOM line's component cost against), avoiding
 * a second full-catalog page-through for what would otherwise be an N+1
 * cost per component SKU (same "no N+1 detail calls" discipline already
 * applied in reports/assemblies/actions.ts).
 */
export async function fetchAllProductsForCosting(
  creds: Cin7Credentials,
): Promise<CostEstimatorProduct[]> {
  const pageSize = 100;
  const all: CostEstimatorProduct[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<Cin7ProductListResponse>(
      creds,
      "/Product",
      {
        query: {
          page,
          limit: pageSize,
          IncludeBOM: "true",
          IncludeSuppliers: "true",
        },
      },
    );
    const products = response.Products ?? [];
    for (const raw of products) all.push(toCostEstimatorProduct(raw));
    if (products.length < pageSize) break;
  }
  return all;
}

function toCostEstimatorProduct(
  raw: Record<string, unknown>,
): CostEstimatorProduct {
  const bomLines = (
    (raw.BillOfMaterialsProducts as Record<string, unknown>[] | undefined) ?? []
  ).map((line) => ({
    componentSku: String(line.ProductCode ?? ""),
    componentName: String(line.Name ?? ""),
    quantity: Number(line.Quantity ?? 0),
    wastageQuantity: Number(line.WastageQuantity ?? 0),
  }));

  const suppliers = (
    (raw.Suppliers as Record<string, unknown>[] | undefined) ?? []
  ).map((s) => ({
    cost: typeof s.Cost === "number" ? s.Cost : null,
    fixedCost: typeof s.FixedCost === "number" ? s.FixedCost : null,
    lastSupplied: typeof s.LastSupplied === "string" ? s.LastSupplied : null,
  }));

  return {
    sku: String(raw.SKU ?? ""),
    name: String(raw.Name ?? ""),
    isAssembly: raw.BillOfMaterial === true,
    bomType: typeof raw.BOMType === "string" ? raw.BOMType : undefined,
    bomLines,
    averageCost: typeof raw.AverageCost === "number" ? raw.AverageCost : null,
    suppliers,
  };
}
