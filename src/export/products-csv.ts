import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "@/export/csv-format";
import { reverseCin7ProductType } from "@/model/products";

const PRICE_TIER_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const HEADER = [
  "ProductCode",
  "Name",
  "Category",
  "Type",
  "CostingMethod",
  "Barcode",
  "DefaultUnitOfMeasure",
  "Status",
  "Description",
  "PurchaseTaxRule",
  "SaleTaxRule",
  ...PRICE_TIER_INDEXES.map((i) => `PriceTier${i}`),
];

/**
 * Exports the org's current canonical products (+ price tiers) in the same
 * column format as Cin7's InventoryList CSV template, so it can be edited
 * and reimported. This is the hub's own canonical data — the same source
 * pushed to every connected instance — not a live pull from a specific
 * Cin7 instance, so the result is identical regardless of which instance
 * you'd otherwise pick.
 */
export async function exportProductsCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data: products, error } = await db
    .from("products")
    .select("sku, name, category_code, uom_code, barcode, type, tax_code, status, description, costing_method")
    .eq("org_id", orgId)
    .order("sku");
  if (error) throw new Error(`products: ${error.message}`);

  const { data: tiers, error: tierError } = await db
    .from("price_tiers")
    .select("product_sku, tier_code, amount")
    .eq("org_id", orgId);
  if (tierError) throw new Error(`price_tiers: ${tierError.message}`);

  const tiersBySku = new Map<string, Record<string, number>>();
  for (const t of tiers ?? []) {
    const bucket = tiersBySku.get(t.product_sku) ?? {};
    bucket[t.tier_code] = t.amount;
    tiersBySku.set(t.product_sku, bucket);
  }

  const rows = (products ?? []).map((p) => {
    const tierValues = tiersBySku.get(p.sku) ?? {};
    return [
      p.sku,
      p.name,
      p.category_code ?? "",
      reverseCin7ProductType(p.type),
      p.costing_method ?? "FIFO",
      p.barcode ?? "",
      p.uom_code ?? "",
      p.status ?? "Active",
      p.description ?? "",
      p.tax_code ?? "",
      p.tax_code ?? "",
      ...PRICE_TIER_INDEXES.map((i) => tierValues[`Tier${i}`] ?? 0),
    ];
  });

  return toCsv([HEADER, ...rows]);
}
