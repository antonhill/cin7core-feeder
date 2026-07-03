import { toCsv } from "@/export/csv-format";

/** Matches Cin7's own AssemblyBOM_*.csv template header exactly. */
const HEADER = [
  "Action", "ProductSKU", "ProductName", "ComponentSKU", "ComponentName", "Quantity",
  "WastageQuantity_ForStockComponentOnly", "WastagePercent_ForStockComponentOnly",
  "CostPercentage_ForStockComponentOnly",
  "PriceTier_ForServiceComponentOnly", "ExpenseAccount_ForServiceComponentOnly",
  "EstimatedUnitCost",
];

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

interface BomProductLine {
  ComponentProductID?: string;
  ProductCode?: string;
  Name?: string;
  Quantity?: number;
  WastageQuantity?: number;
  WastagePercent?: number;
  CostPercentage?: number;
}

interface BomServiceLine {
  ComponentProductID?: string;
  Name?: string;
  Quantity?: number;
  PriceTier?: number;
  ExpenseAccount?: string;
}

/**
 * Full-fidelity Assembly BOM export for every product in a chosen Cin7
 * instance that has a Bill of Materials configured — reads
 * BillOfMaterialsProducts/BillOfMaterialsServices, already embedded on the
 * same GET /Product response used for the products export (Cin7 has no
 * separate BOM endpoint — see cin7/assembly-bom.ts). EstimatedUnitCost has no
 * confirmed source field, left blank rather than guessed.
 */
export function toFullAssemblyBomCsv(products: Record<string, unknown>[]): string {
  const rows: string[][] = [];
  for (const p of products) {
    const productSku = str(p.SKU);
    const productName = str(p.Name);
    const stockLines = (p.BillOfMaterialsProducts as BomProductLine[] | undefined) ?? [];
    const serviceLines = (p.BillOfMaterialsServices as BomServiceLine[] | undefined) ?? [];

    for (const line of stockLines) {
      rows.push([
        "Create/Update", productSku, productName, str(line.ProductCode), str(line.Name), str(line.Quantity ?? 0),
        str(line.WastageQuantity ?? 0), str(line.WastagePercent ?? 0), str(line.CostPercentage ?? 0),
        "", "", "",
      ]);
    }
    for (const line of serviceLines) {
      rows.push([
        "Create/Update", productSku, productName, "", str(line.Name), str(line.Quantity ?? 0),
        "", "", "",
        str(line.PriceTier ?? ""), str(line.ExpenseAccount ?? ""), "",
      ]);
    }
  }
  return toCsv([HEADER, ...rows]);
}
