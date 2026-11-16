import { stableStringify } from "../../quote/baseline";
import type { PricingSubmission } from "./apply";

// THE SERVER RULE FOR A SUPPLIER COST'S IDENTITY (pure; the lookups are injected). A cost that is NEW or CHANGED must name a real, active Cin7 supplier BY ITS CIN7 ID (the name is only a label), and its currency
// must come from that supplier's own Cin7 record, or be an explicit, reasoned override where Cin7 holds none. Nothing is ever defaulted to ZAR and nothing here calculates a price or writes to Cin7.
//
// A cost that is unchanged from what the form was opened against is NOT re-checked (so older entries made before supplier selection existed keep working until someone changes them).
export interface Cin7SupplierRef { id: string; name: string; currency: string | null; active: boolean }
export interface Cin7ProductSupplierRef { supplierId: string; supplierName: string; /** Cin7's "latest price" for this product from this supplier, as returned (may be absent). */ cost: number | null; currency: string | null; /** The date part of Cin7's last-supplied timestamp; null when Cin7 holds none. */ lastSupplied: string | null }
export type Lookup<T> = { status: "ok"; value: T } | { status: "unavailable" };
export interface IdentityLookups {
  supplier(id: string): Promise<Lookup<Cin7SupplierRef | null>>;
  productSuppliers(sku: string): Promise<Lookup<Cin7ProductSupplierRef[] | null>>;
}

type Entry = PricingSubmission["skus"][string];
const significant = (x: Entry | undefined): string => (x ? stableStringify({ i: x.supplierId, n: x.supplierName, c: x.currency, v: x.nativeUnitCostE7, s: x.source, f: x.freight, cs: x.currencySource ?? null, co: x.currencyOverrideReason ?? null, k: x.costKind ?? null, d: x.costDate ?? null }) : "");

/** A Cin7 decimal cost as the stored integer of 1e-7 units, exactly (no floating-point drift): 6.5454755 -> 65454755. */
export function costToE7(cost: number): number {
  const [w, f = ""] = Math.abs(cost).toFixed(7).split(".");
  return Number(w) * 1e7 + Number(f.padEnd(7, "0"));
}

export const UNAVAILABLE = "Cin7 supplier data could not be read just now, so the supplier and its currency could not be confirmed. Nothing was saved; try again in a moment.";

export async function validateSupplierIdentities(i: { submission: PricingSubmission; base: PricingSubmission | null; lookups: IdentityLookups; nowIso: string }): Promise<string[]> {
  const errors: string[] = [];
  const today = i.nowIso.slice(0, 10);
  for (const [sku, e] of Object.entries(i.submission.skus)) {
    if (significant(e) === significant(i.base?.skus[sku])) continue; // not changed by this save
    const at = `${sku}:`;
    if (!e.supplierId || !e.supplierName) { errors.push(`${at} choose the supplier from Cin7 (search by name).`); continue; }
    if (!e.currencySource) { errors.push(`${at} the currency must come from the Cin7 supplier record (or be set by hand with a reason).`); continue; }
    if (!e.costKind) { errors.push(`${at} say what kind of cost this is: a Cin7 historical cost, a new supplier quotation or your own estimate.`); continue; }
    const sup = await i.lookups.supplier(e.supplierId);
    if (sup.status === "unavailable") { errors.push(UNAVAILABLE); continue; }
    if (!sup.value || !sup.value.active) { errors.push(`${at} that supplier is not an active supplier in Cin7.`); continue; }
    if (sup.value.name.trim().toLowerCase() !== e.supplierName.trim().toLowerCase()) errors.push(`${at} the supplier name does not match Cin7 (${sup.value.name}). Choose the supplier again.`);
    const cin7Currency = sup.value.currency;
    if (e.currencySource === "cin7_supplier") {
      if (!cin7Currency) errors.push(`${at} Cin7 holds no currency for ${sup.value.name}. Set the currency by hand with a reason, or add it to the supplier in Cin7.`);
      else if (cin7Currency !== e.currency) errors.push(`${at} Cin7 holds ${cin7Currency} for ${sup.value.name}, not ${e.currency}. The currency comes from the supplier record.`);
    } else if (cin7Currency) errors.push(`${at} Cin7 already holds ${cin7Currency} for ${sup.value.name}, so the currency cannot be overridden. Use it, or correct it in Cin7.`);

    if (e.costKind === "supplier_quotation") {
      if (!e.costDate) errors.push(`${at} enter the date of the supplier quotation.`);
      else if (e.costDate > today) errors.push(`${at} the quotation date cannot be in the future.`);
    }
    if (e.costKind === "cin7_historical") {
      const ps = await i.lookups.productSuppliers(sku);
      if (ps.status === "unavailable") { errors.push(UNAVAILABLE); continue; }
      const rec = ps.value?.find((r) => r.supplierId === e.supplierId);
      if (!rec || rec.cost == null) { errors.push(`${at} Cin7 holds no price from ${e.supplierName} for this product, so it cannot be recorded as a Cin7 historical cost.`); continue; }
      if (costToE7(rec.cost) !== e.nativeUnitCostE7) errors.push(`${at} the cost is not the Cin7 price (${rec.cost}). A changed figure is a new quotation or an estimate, not a Cin7 historical cost.`);
      if (rec.currency && rec.currency !== e.currency) errors.push(`${at} Cin7 prices this product from ${e.supplierName} in ${rec.currency}, not ${e.currency}.`);
      if ((e.costDate ?? null) !== rec.lastSupplied) errors.push(`${at} the cost date must be Cin7's last-supplied date${rec.lastSupplied ? ` (${rec.lastSupplied})` : " (Cin7 holds none, so the date stays blank)"}.`);
    }
  }
  return [...new Set(errors)]; // one outage message, not one per product
}

/**
 * How old a DATED Cin7 price is, for the Estimator's information only. It never changes a cost: there is no approved policy for ageing one. A price with no date has no age (never guessed), and a date in the
 * future is treated as unknown. "Stale" is a prompt to confirm the price is still current (12 months or more), not a calculation.
 */
export function priceAge(lastSupplied: string | null, todayIso: string): { months: number; stale: boolean; text: string } | null {
  if (!lastSupplied || !/^\d{4}-\d{2}-\d{2}$/.test(lastSupplied)) return null;
  const a = Date.parse(lastSupplied), b = Date.parse(todayIso.slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return null;
  const months = Math.floor((b - a) / (30.4375 * 86_400_000));
  return { months, stale: months >= 12, text: months < 1 ? "less than a month ago" : months === 1 ? "1 month ago" : months < 24 ? `${months} months ago` : `${Math.floor(months / 12)} years ago` };
}

