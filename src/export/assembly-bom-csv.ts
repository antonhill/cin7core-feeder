import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "@/export/csv-format";

const HEADER = [
  "Action",
  "ProductSKU",
  "ProductName",
  "ComponentSKU",
  "ComponentName",
  "Quantity",
  "WastageQuantity_ForStockComponentOnly",
  "WastagePercent_ForStockComponentOnly",
  "CostPercentage_ForStockComponentOnly",
  "PriceTier_ForServiceComponentOnly",
  "ExpenseAccount_ForServiceComponentOnly",
  "EstimatedUnitCost",
];

/**
 * Exports the org's current canonical Assembly BOM lines in the same column
 * format as Cin7's AssemblyBOM CSV template, so it can be edited and
 * reimported. Every row exports with Action="Create/Update" — re-import
 * that same file unmodified is a safe no-op; change a row's Action to
 * "Delete" to remove that specific component line on reimport.
 */
export async function exportAssemblyBomCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data: lines, error } = await db
    .from("assembly_bom_lines")
    .select(
      "product_sku, component_sku, component_name, quantity, wastage_quantity, wastage_percent, cost_percentage, price_tier, expense_account, estimated_unit_cost"
    )
    .eq("org_id", orgId)
    .order("product_sku");
  if (error) throw new Error(`assembly_bom_lines: ${error.message}`);

  const { data: products, error: productsError } = await db
    .from("products")
    .select("sku, name")
    .eq("org_id", orgId);
  if (productsError) throw new Error(`products: ${productsError.message}`);
  const nameBySku = new Map((products ?? []).map((p) => [p.sku, p.name]));

  const rows = (lines ?? []).map((l) => [
    "Create/Update",
    l.product_sku,
    nameBySku.get(l.product_sku) ?? "",
    l.component_sku,
    l.component_name ?? "",
    l.quantity,
    l.wastage_quantity ?? "",
    l.wastage_percent ?? "",
    l.cost_percentage ?? "",
    l.price_tier ?? "",
    l.expense_account ?? "",
    l.estimated_unit_cost ?? "",
  ]);

  return toCsv([HEADER, ...rows]);
}
