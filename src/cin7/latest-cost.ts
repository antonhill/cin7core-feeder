import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import type { SupplierCostRead } from "@/lib/projects/latest-cost";

// READ-ONLY. One product's supplier cost records, for the NewQuip "Cin7 latest cost" estimate. A GET of /Product by exact SKU (the filter can be ignored by
// Cin7, so an answer for a different SKU is treated as "not found", never used). Nothing here writes to Cin7.
export interface ProductCostRead {
  sku: string; name: string; averageCost: number | null; suppliers: SupplierCostRead[];
  /** Cin7 Suppliers[] exactly as returned (read-only); the supplier-price reader interprets only the fields confirmed in this repo. */
  rawSuppliers: Record<string, unknown>[];
  /** The product's own stock unit of measure, when Cin7 returns it. */
  uom: string | null;
}

export async function fetchProductCostRead(creds: Cin7Credentials, sku: string): Promise<ProductCostRead | null> {
  const response = await cin7Request<{ Products?: Record<string, unknown>[] }>(creds, "/Product", { query: { SKU: sku, page: 1, limit: 1, IncludeSuppliers: "true" } });
  const p = response.Products?.[0];
  if (!p || p.SKU !== sku) return null;
  const suppliers = ((p.Suppliers as Record<string, unknown>[] | undefined) ?? []).map((s): SupplierCostRead => ({
    supplier: typeof s.SupplierName === "string" ? s.SupplierName : typeof s.Supplier === "string" ? s.Supplier : null,
    cost: typeof s.Cost === "number" ? s.Cost : null,
    fixedCost: typeof s.FixedCost === "number" ? s.FixedCost : null,
    lastSupplied: typeof s.LastSupplied === "string" && s.LastSupplied ? s.LastSupplied : null,
  }));
  return { sku, name: String(p.Name ?? ""), averageCost: typeof p.AverageCost === "number" ? p.AverageCost : null, suppliers, rawSuppliers: (p.Suppliers as Record<string, unknown>[] | undefined) ?? [], uom: typeof p.UOM === "string" ? p.UOM : null };
}
