export interface CanonicalAssemblyBomLineRow {
  product_sku: string;
  component_sku: string;
  quantity: number;
  wastage_quantity: number | null;
  wastage_percent: number | null;
  cost_percentage: number | null;
  price_tier: string | null;
  expense_account: string | null;
}

/**
 * A line with PriceTier/ExpenseAccount set is a service line (per the
 * AssemblyBOM CSV template's *_ForServiceComponentOnly columns); otherwise
 * it's a stock component.
 */
function isServiceLine(line: CanonicalAssemblyBomLineRow): boolean {
  return Boolean(line.price_tier || line.expense_account);
}

/**
 * Cin7 has no standalone Bill-of-Materials endpoint — confirmed 2026-07-03
 * via two independent sources (github.com/nnhansg/dear-openapi's Apiary
 * transcription, and the FalconEyeSolutions/CIN7-DearInventory generated
 * client): `PUT /BillOfMaterials` doesn't exist server-side (it was
 * redirect-looping). BOM fields live directly on the Product resource and
 * are set via the same POST/PUT /Product call used for the product's core
 * fields — see products.ts's pushProduct, which merges these fields in.
 *
 * Component references accept EITHER `ComponentProductID` (Cin7 GUID) or
 * `ProductCode` (SKU) — we use SKU, since it avoids needing the component's
 * own Cin7 ID resolved (and possibly not-yet-synced) first.
 */
export function toCin7BomFields(lines: CanonicalAssemblyBomLineRow[]) {
  if (!lines.length) return {};

  const components = lines
    .filter((l) => !isServiceLine(l))
    .map((l) => ({
      ProductCode: l.component_sku,
      Quantity: l.quantity,
      Wastage: l.wastage_quantity ?? undefined,
      WastagePercentage: l.wastage_percent ?? undefined,
      CostAllocationPercentage: l.cost_percentage ?? undefined,
    }));
  const services = lines
    .filter(isServiceLine)
    .map((l) => ({
      ProductCode: l.component_sku,
      Quantity: l.quantity,
      PriceTier: l.price_tier ?? undefined,
      ExpenseAccount: l.expense_account ?? undefined,
    }));

  return {
    BillOfMaterial: true,
    BillOfMaterialsProducts: components,
    BillOfMaterialsServices: services,
  };
}
