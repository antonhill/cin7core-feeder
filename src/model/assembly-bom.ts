import { z } from "zod";

/**
 * Mirrors Cin7 Core's "AssemblyBOM" CSV export template
 * (docs/cin7-templates/AssemblyBOM_*.csv) — one row per component line.
 */
export const assemblyBomCsvRowSchema = z.object({
  Action: z.string().trim().optional().default("Create/Update"),
  ProductSKU: z.string().trim().min(1, "ProductSKU is required"),
  ProductName: z.string().trim().optional().default(""),
  ComponentSKU: z.string().trim().min(1, "ComponentSKU is required"),
  ComponentName: z.string().trim().optional().default(""),
  Quantity: z.coerce.number().positive("Quantity must be > 0"),
  WastageQuantity_ForStockComponentOnly: z.coerce.number().optional(),
  WastagePercent_ForStockComponentOnly: z.coerce.number().optional(),
  CostPercentage_ForStockComponentOnly: z.coerce.number().optional(),
  PriceTier_ForServiceComponentOnly: z.string().trim().optional().default(""),
  ExpenseAccount_ForServiceComponentOnly: z.string().trim().optional().default(""),
  EstimatedUnitCost: z.coerce.number().optional(),
});

export type AssemblyBomCsvRow = z.infer<typeof assemblyBomCsvRowSchema>;

export interface CanonicalAssemblyBomLine {
  product_sku: string;
  component_sku: string;
  component_name: string | null;
  quantity: number;
  wastage_quantity: number | null;
  wastage_percent: number | null;
  cost_percentage: number | null;
  price_tier: string | null;
  expense_account: string | null;
  estimated_unit_cost: number | null;
}

export function toCanonicalAssemblyBomLine(row: AssemblyBomCsvRow): CanonicalAssemblyBomLine {
  return {
    product_sku: row.ProductSKU,
    component_sku: row.ComponentSKU,
    component_name: row.ComponentName || null,
    quantity: row.Quantity,
    wastage_quantity: row.WastageQuantity_ForStockComponentOnly ?? null,
    wastage_percent: row.WastagePercent_ForStockComponentOnly ?? null,
    cost_percentage: row.CostPercentage_ForStockComponentOnly ?? null,
    price_tier: row.PriceTier_ForServiceComponentOnly || null,
    expense_account: row.ExpenseAccount_ForServiceComponentOnly || null,
    estimated_unit_cost: row.EstimatedUnitCost ?? null,
  };
}
