import type { SkuOptionsView } from "../cost-actions";

// Pure presentation derivation for the CostPanel "Unit of measure" box: which unit-of-measure state the ALREADY-LOADED supplier options are in. It reads nothing
// and changes nothing; the rule itself lives in lib/projects/supplier-price.ts (Cin7 keeps ONE unit per product, so a record that states no unit field of its own is
// per stock unit). Only type imports, so it pulls in no server action.

export interface UnitException { sku: string; supplier: string; kind: "STATED" | "NO_STOCK_UNIT" | "OTHER"; fields: string[]; message: string }
export interface UnitStatus {
  /** Options with an established unit basis (stated same unit, stated factor, Cin7's single stock UOM, or confirmed). */
  perStockUnit: number;
  /** Genuine exceptions: Cin7 states a unit/pack/conversion we cannot interpret, the stock unit is unknown, or the conversion is not known. */
  exceptions: UnitException[];
  /** Options captured before unit information was tracked (statedUnitFields undefined) and blocked on the unit: unknown, needs a recapture. */
  legacySkus: string[];
}

export function deriveUnitStatus(skuOptions: Record<string, SkuOptionsView>): UnitStatus {
  const out: UnitStatus = { perStockUnit: 0, exceptions: [], legacySkus: [] };
  for (const [sku, so] of Object.entries(skuOptions)) {
    for (const o of so.options) {
      const block = o.problems.find((p) => p.blocking && (p.code === "UOM_UNCONFIRMED" || p.code === "BAD_CONVERSION_FACTOR"));
      if (!block) { if (o.unitBasisSource) out.perStockUnit++; continue; }
      const stated = o.raw.statedUnitFields;
      const supplier = o.supplierName ?? o.supplierId ?? "(unnamed supplier)";
      if (block.code === "UOM_UNCONFIRMED" && stated === undefined) { if (!out.legacySkus.includes(sku)) out.legacySkus.push(sku); continue; }
      if (stated && stated.length > 0) out.exceptions.push({ sku, supplier, kind: "STATED", fields: stated, message: block.message });
      else if (block.code === "UOM_UNCONFIRMED") out.exceptions.push({ sku, supplier, kind: "NO_STOCK_UNIT", fields: [], message: block.message });
      else out.exceptions.push({ sku, supplier, kind: "OTHER", fields: [], message: block.message });
    }
  }
  return out;
}
