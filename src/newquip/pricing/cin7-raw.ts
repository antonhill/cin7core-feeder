import { pickUnitFields, type RawSupplierRecord, type SurveyInput } from "./cost-survey";

// A raw Cin7 /Product record (as the read-only survey reads it) -> the SurveyInput the cost classification takes. Pure; mirrors the survey action's own mapping.
type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const dateOnly = (v: unknown): string | null => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s; };

export function surveyInputFromRaw(sku: string, p: Raw | null): SurveyInput {
  if (!p) return { sku, found: false, productStatus: null, productName: null, uom: null, averageCost: null, suppliers: [], unitFields: {} };
  const sups = Array.isArray(p.Suppliers) ? (p.Suppliers as unknown[]).filter(isObj) : [];
  const suppliers: RawSupplierRecord[] = sups.map((s) => ({ supplierId: str(s.SupplierID), supplierName: str(s.SupplierName), cost: num(s.Cost), fixedCost: num(s.FixedCost), currency: str(s.Currency), lastSupplied: dateOnly(s.LastSupplied) }));
  return { sku, found: true, productStatus: str(p.Status), productName: str(p.Name), uom: str(p.UOM), averageCost: num(p.AverageCost), suppliers, unitFields: { ...pickUnitFields(p) } };
}
