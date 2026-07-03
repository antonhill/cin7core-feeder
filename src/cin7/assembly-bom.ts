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
 * Field names below are confirmed against the generated C# client's model
 * classes (ProductPutRequestBillOfMaterialsProductsInner.cs /
 * ...ServicesInner.cs) and the .apib spec's "Bill Of Material Product/Service
 * Model" sections — not a guess. Two things the spec marks "required if
 * BillOfMaterial is true" live on the parent Product payload itself
 * (QuantityToProduce, AssemblyCostEstimationMethod) — merged in here since
 * this is the only place that knows whether the product has a BOM at all.
 */
export function toCin7BomFields(lines: CanonicalAssemblyBomLineRow[]): Record<string, unknown> {
  if (!lines.length) return {};

  const components = lines
    .filter((l) => !isServiceLine(l))
    .map((l) => ({
      ProductCode: l.component_sku,
      Quantity: l.quantity,
      WastageQuantity: l.wastage_quantity ?? undefined,
      WastagePercent: l.wastage_percent ?? undefined,
      CostPercentage: l.cost_percentage ?? undefined,
    }));
  const services = lines
    .filter(isServiceLine)
    .map((l) => ({
      // The Service model's name field is "Name", not "ProductCode" (unlike
      // the Product component model) — confirmed from the C# model class.
      Name: l.component_sku,
      Quantity: l.quantity,
      ExpenseAccount: l.expense_account ?? undefined,
      // PriceTier is documented as an integer on Cin7's side; we only store
      // a tier name/string (e.g. "Retail in VAT"), so it's omitted here
      // rather than sent as a type mismatch.
    }));

  return {
    BillOfMaterial: true,
    // Required when BillOfMaterial=true per the spec. Assembly BOMs produce
    // 1 unit of the finished good (unlike Production BOM's batch quantity).
    QuantityToProduce: 1,
    // Required when BillOfMaterial=true per the spec; exact accepted values
    // beyond this sample ("Average Cost") are unverified.
    AssemblyCostEstimationMethod: "Average Cost",
    // Omit rather than send an empty array — the spec doesn't require
    // either array to exist, only conditionally requires fields within items
    // that do.
    ...(components.length ? { BillOfMaterialsProducts: components } : {}),
    ...(services.length ? { BillOfMaterialsServices: services } : {}),
  };
}
