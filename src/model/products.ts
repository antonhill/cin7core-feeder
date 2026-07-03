import { z } from "zod";

/**
 * Mirrors the columns of Cin7 Core's "InventoryList" CSV export template
 * (docs/cin7-templates/InventoryList_*.csv). Only the columns the hub
 * currently maps into the canonical schema are typed strictly; everything
 * else is accepted and ignored so re-exports with extra columns don't fail.
 */
export const productCsvRowSchema = z.object({
  ProductCode: z.string().trim().min(1, "ProductCode is required"),
  Name: z.string().trim().min(1, "Name is required"),
  Category: z.string().trim().optional().default(""),
  Type: z.string().trim().optional().default(""),
  CostingMethod: z.string().trim().optional().default(""),
  Barcode: z.string().trim().optional().default(""),
  DefaultUnitOfMeasure: z.string().trim().optional().default(""),
  Status: z.string().trim().optional().default(""),
  Description: z.string().trim().optional().default(""),
  PurchaseTaxRule: z.string().trim().optional().default(""),
  SaleTaxRule: z.string().trim().optional().default(""),
  PriceTier1: z.coerce.number().optional(),
  PriceTier2: z.coerce.number().optional(),
  PriceTier3: z.coerce.number().optional(),
  PriceTier4: z.coerce.number().optional(),
  PriceTier5: z.coerce.number().optional(),
  PriceTier6: z.coerce.number().optional(),
  PriceTier7: z.coerce.number().optional(),
  PriceTier8: z.coerce.number().optional(),
  PriceTier9: z.coerce.number().optional(),
  PriceTier10: z.coerce.number().optional(),
});

export type ProductCsvRow = z.infer<typeof productCsvRowSchema>;

/** Cin7 Core's own "Type" values -> our canonical product_type enum. */
const CIN7_TYPE_MAP: Record<string, "raw" | "component" | "assembly" | "finished" | "placeholder"> = {
  Stock: "component",
  Service: "component",
  "Non-Inventory": "raw",
  BillOfMaterials: "assembly",
};

export function mapCin7ProductType(cin7Type: string): "raw" | "component" | "assembly" | "finished" | "placeholder" {
  return CIN7_TYPE_MAP[cin7Type] ?? "component";
}

export interface CanonicalProduct {
  sku: string;
  name: string;
  description: string | null;
  category_code: string | null;
  uom_code: string | null;
  barcode: string | null;
  type: "raw" | "component" | "assembly" | "finished" | "placeholder";
  tax_code: string | null;
  active: boolean;
  /**
   * The raw CSV Status value (e.g. "Active", "Inactive", "Deprecated"),
   * pushed to Cin7 verbatim — Cin7 supports statuses beyond Active/Inactive
   * (Deprecated is the confirmed soft-delete mechanism for products), so
   * deriving just a boolean would lose that.
   */
  status: string;
  /**
   * Required by Cin7 on product create (POST /Product fails with "Required
   * attribute 'CostingMethod' not provided" otherwise) — confirmed live.
   * Every sample row in Cin7's own InventoryList export uses "FIFO".
   */
  costing_method: string;
  /**
   * The raw CSV Type value (e.g. "Stock", "Service", "Non-Inventory"),
   * pushed to Cin7 verbatim — the `type` field above is lossy (Stock and
   * Service both collapse to "component"), which silently turned Service
   * products into Stock on every push. Same pattern as `status` vs `active`.
   */
  cin7_type: string;
}

export interface CanonicalPriceTier {
  product_sku: string;
  tier_code: string;
  amount: number;
}

const PRICE_TIER_COLUMNS = [
  "PriceTier1", "PriceTier2", "PriceTier3", "PriceTier4", "PriceTier5",
  "PriceTier6", "PriceTier7", "PriceTier8", "PriceTier9", "PriceTier10",
] as const;

export function toCanonicalProduct(row: ProductCsvRow): CanonicalProduct {
  return {
    sku: row.ProductCode,
    name: row.Name,
    description: row.Description || null,
    category_code: row.Category || null,
    uom_code: row.DefaultUnitOfMeasure || null,
    barcode: row.Barcode || null,
    type: mapCin7ProductType(row.Type),
    tax_code: row.SaleTaxRule || row.PurchaseTaxRule || null,
    active: row.Status ? row.Status.toUpperCase() === "ACTIVE" : true,
    status: row.Status || "Active",
    costing_method: row.CostingMethod || "FIFO",
    cin7_type: row.Type || "Stock",
  };
}

export function toCanonicalPriceTiers(row: ProductCsvRow): CanonicalPriceTier[] {
  return PRICE_TIER_COLUMNS
    .map((col, i) => ({ tier_code: `Tier${i + 1}`, amount: row[col] }))
    .filter((t): t is { tier_code: string; amount: number } => typeof t.amount === "number" && t.amount > 0)
    .map((t) => ({ product_sku: row.ProductCode, tier_code: t.tier_code, amount: t.amount }));
}
