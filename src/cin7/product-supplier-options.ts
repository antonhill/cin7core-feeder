import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

interface Cin7ProductListResponse {
  Products?: Record<string, unknown>[];
}

/**
 * Cin7's per-(product,supplier,location) reorder-planning entry — Lead/
 * Safety/ReorderQuantity/MinimumToReorder, confirmed live 2026-07-23
 * against Spark Demo's "New Item for Smart" / "3 Diamonds Transport (Pty)
 * Ltd" (see src/cin7/debug.ts's findProductSupplierOptionsExample). Nested
 * inside a Suppliers[] entry's own `ProductSupplierOptions` array — no
 * separate Include flag needed beyond IncludeSuppliers=true. MinimumToReorder
 * only populates on the one entry with locationId: null (Cin7's own "default
 * options" row, per its doc: "Can be set for default options set only").
 */
export interface SupplierPlanOption {
  locationId: string | null;
  locationName: string | null;
  reorderQuantity: number;
  lead: number | null;
  safety: number | null;
  minimumToReorder: number | null;
}

/** One product's link to one supplier — Cost is Cin7's "Latest Price" (confirmed live 2026-07-23 to track a manual edit, not an automatic goods-receipt figure). */
export interface SupplierPlanLink {
  supplierId: string;
  supplierName: string;
  cost: number | null;
  currency: string | null;
  options: SupplierPlanOption[];
}

export interface SupplierPlanProduct {
  productId: string;
  sku: string;
  name: string;
  suppliers: SupplierPlanLink[];
}

/**
 * One paginated `/Product` pass with `IncludeSuppliers=true` — the same
 * flag `product-cost.ts`/`pricing.ts` already use, which happens to carry
 * `ProductSupplierOptions` nested inside each Suppliers[] entry for free
 * (no separate flag exists or is needed).
 */
export async function fetchAllProductsForSupplierPlanning(creds: Cin7Credentials): Promise<SupplierPlanProduct[]> {
  const pageSize = 100;
  const all: SupplierPlanProduct[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
      query: { page, limit: pageSize, IncludeSuppliers: "true" },
    });
    const products = response.Products ?? [];
    for (const raw of products) all.push(toSupplierPlanProduct(raw));
    if (products.length < pageSize) break;
  }
  return all;
}

function toSupplierPlanProduct(raw: Record<string, unknown>): SupplierPlanProduct {
  const suppliers = ((raw.Suppliers as Record<string, unknown>[] | undefined) ?? []).map((s) => ({
    supplierId: String(s.SupplierID ?? ""),
    supplierName: String(s.SupplierName ?? ""),
    cost: typeof s.Cost === "number" ? s.Cost : null,
    currency: typeof s.Currency === "string" && s.Currency ? s.Currency : null,
    options: ((s.ProductSupplierOptions as Record<string, unknown>[] | undefined) ?? []).map((o) => ({
      locationId: typeof o.LocationID === "string" ? o.LocationID : null,
      locationName: typeof o.LocationName === "string" ? o.LocationName : null,
      reorderQuantity: Number(o.ReorderQuantity ?? 0),
      lead: typeof o.Lead === "number" ? o.Lead : null,
      safety: typeof o.Safety === "number" ? o.Safety : null,
      minimumToReorder: typeof o.MinimumToReorder === "number" ? o.MinimumToReorder : null,
    })),
  }));

  return {
    productId: String(raw.ID ?? ""),
    sku: String(raw.SKU ?? ""),
    name: String(raw.Name ?? ""),
    suppliers,
  };
}
