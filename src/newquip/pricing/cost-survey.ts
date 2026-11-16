// NEWQUIP COST-SOURCE SURVEY (read-only analysis; nothing here prices, stores or changes anything). Pure: raw Cin7 product facts in, a classification out.
// It answers "could this SKU be priced automatically from Cin7, or does it need a person?" using the commercial rules the owner approved for the proposed model:
//   cost      Suppliers[].Cost; the newest valid LastSupplied wins; equal newest dates with different costs are ambiguous
//   age       elapsed days / 365.25 from LastSupplied; undated, future-dated, ambiguous, missing or zero costs need review; older than the maximum (5 years) needs a fresh quote
//   bands     marginal: 0-1y 0%, 1-2y 10%, 2-3y 15%, over 3y 20%. Simple (default) or compound, applied progressively across the bands
// The escalation factors below are an ILLUSTRATION for the survey: floating point, never fed to a price. The real engine will use exact integer arithmetic.

export const DAYS_PER_YEAR = 365.25;
export const MAX_SOURCE_AGE_YEARS = 5;
export interface Band { fromYears: number; toYears: number | null; rate: number }
export const PROPOSED_BANDS: readonly Band[] = [
  { fromYears: 0, toYears: 1, rate: 0 }, { fromYears: 1, toYears: 2, rate: 0.1 }, { fromYears: 2, toYears: 3, rate: 0.15 }, { fromYears: 3, toYears: null, rate: 0.2 },
];

export interface RawSupplierRecord { supplierId: string | null; supplierName: string | null; cost: number | null; fixedCost: number | null; currency: string | null; lastSupplied: string | null }
export interface MasterSupplier { id: string; name: string; currency: string | null; active: boolean }
export interface SurveyInput {
  sku: string; found: boolean; productStatus: string | null; productName: string | null; uom: string | null; averageCost: number | null;
  suppliers: RawSupplierRecord[];
  /** Product/supplier fields whose names suggest a purchase unit, conversion or pack size, with the values Cin7 returned. Evidence only; never interpreted. */
  unitFields: Record<string, unknown>;
}
export type Tier = "ready" | "historical" | "review" | "missing";
export type Reason =
  | "not_in_cin7" | "product_inactive" | "no_supplier_record" | "no_positive_cost"
  | "undated" | "future_dated" | "ambiguous_same_date" | "older_than_maximum" | "supplier_unknown_or_inactive" | "currency_unknown" | "currency_conflict";
export interface Candidate { supplierId: string | null; supplierName: string | null; cost: number; currency: string | null; lastSupplied: string | null }
export interface SurveyResult {
  sku: string; tier: Tier; reasons: Reason[];
  selected: Candidate | null; ageYears: number | null; band: string | null;
  /** Currency the cost would be entered in: the supplier's own Cin7 currency. null = Cin7 holds none (exception). */
  currency: string | null; fxNeeded: boolean;
  simpleFactor: number | null; compoundFactor: number | null;
  positiveCandidates: number; zeroOrNegative: number; distinctSuppliers: number;
  /** More than one supplier carries a positive cost (informational, not an exception on its own). */
  multipleSuppliers: boolean;
  averageCostReference: number | null;
}

const isoDate = (s: string | null): number | null => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
};

export function ageYears(lastSupplied: string, todayIso: string): number | null {
  const a = isoDate(lastSupplied), b = isoDate(todayIso);
  if (a === null || b === null || a > b) return null;
  return (b - a) / 86_400_000 / DAYS_PER_YEAR;
}
export function bandOf(years: number): string {
  return years <= 1 ? "0-1y (0%)" : years <= 2 ? "1-2y (10%)" : years <= 3 ? "2-3y (15%)" : "over 3y (20%)";
}
/** Marginal simple factor: 1 + sum(rate x years inside the band). */
export function simpleFactor(years: number, bands: readonly Band[] = PROPOSED_BANDS): number {
  return 1 + bands.reduce((s, b) => s + b.rate * Math.max(0, Math.min(years, b.toYears ?? Infinity) - b.fromYears), 0);
}
/** Marginal compound factor: product of (1 + rate)^(years inside the band). */
export function compoundFactor(years: number, bands: readonly Band[] = PROPOSED_BANDS): number {
  return bands.reduce((p, b) => p * Math.pow(1 + b.rate, Math.max(0, Math.min(years, b.toYears ?? Infinity) - b.fromYears)), 1);
}

const EMPTY = (sku: string, tier: Tier, reasons: Reason[], extra: Partial<SurveyResult> = {}): SurveyResult => ({
  sku, tier, reasons, selected: null, ageYears: null, band: null, currency: null, fxNeeded: false, simpleFactor: null, compoundFactor: null,
  positiveCandidates: 0, zeroOrNegative: 0, distinctSuppliers: 0, multipleSuppliers: false, averageCostReference: null, ...extra,
});

export function classifySku(i: SurveyInput, master: ReadonlyMap<string, MasterSupplier>, todayIso: string): SurveyResult {
  const avg = i.averageCost != null && i.averageCost > 0 ? i.averageCost : null;
  if (!i.found) return EMPTY(i.sku, "missing", ["not_in_cin7"]);
  if (i.productStatus && i.productStatus.toLowerCase() !== "active") return EMPTY(i.sku, "missing", ["product_inactive"], { averageCostReference: avg });
  if (i.suppliers.length === 0) return EMPTY(i.sku, "missing", ["no_supplier_record"], { averageCostReference: avg });
  const positive = i.suppliers.filter((s) => typeof s.cost === "number" && Number.isFinite(s.cost) && s.cost > 0);
  const nonPositive = i.suppliers.length - positive.length;
  const base = { positiveCandidates: positive.length, zeroOrNegative: nonPositive, distinctSuppliers: new Set(i.suppliers.map((s) => s.supplierId ?? s.supplierName)).size, multipleSuppliers: positive.length > 1, averageCostReference: avg };
  if (positive.length === 0) return EMPTY(i.sku, "missing", ["no_positive_cost"], base);

  const reasons: Reason[] = [];
  const today = isoDate(todayIso)!;
  const dated = positive.map((s) => ({ s, t: isoDate(s.lastSupplied) })).filter((x): x is { s: RawSupplierRecord; t: number } => x.t !== null);
  const valid = dated.filter((x) => x.t <= today);
  let pick: RawSupplierRecord;
  let years: number | null = null;
  if (valid.length > 0) {
    const newest = Math.max(...valid.map((x) => x.t));
    const top = valid.filter((x) => x.t === newest);
    if (new Set(top.map((x) => x.s.cost)).size > 1) reasons.push("ambiguous_same_date");
    pick = top[0].s;
    years = ageYears(pick.lastSupplied!, todayIso);
  } else {
    pick = positive[0];
    reasons.push(dated.length > 0 ? "future_dated" : "undated");
    if (positive.length > 1 && new Set(positive.map((s) => s.cost)).size > 1) reasons.push("ambiguous_same_date");
  }
  const m = pick.supplierId ? master.get(pick.supplierId) : undefined;
  if (!m || !m.active) reasons.push("supplier_unknown_or_inactive");
  const masterCcy = m?.currency ?? null;
  if (!masterCcy && !pick.currency) reasons.push("currency_unknown");
  if (masterCcy && pick.currency && masterCcy !== pick.currency) reasons.push("currency_conflict");
  const currency = masterCcy;
  if (years !== null && years > MAX_SOURCE_AGE_YEARS) reasons.push("older_than_maximum");

  const selected: Candidate = { supplierId: pick.supplierId, supplierName: pick.supplierName, cost: pick.cost!, currency: pick.currency, lastSupplied: pick.lastSupplied };
  const common = { ...base, selected, ageYears: years, band: years === null ? null : bandOf(years), currency, fxNeeded: !!currency && currency !== "ZAR", simpleFactor: years === null ? null : simpleFactor(years), compoundFactor: years === null ? null : compoundFactor(years) };
  if (reasons.length > 0) return { sku: i.sku, tier: "review", reasons, ...common };
  return { sku: i.sku, tier: years !== null && years > 1 ? "historical" : "ready", reasons, ...common };
}

export interface Coverage {
  total: number; ready: number; historical: number; review: number; missing: number;
  reasons: Record<string, number>; bands: Record<string, number>; undated: number; fxNeeded: number; foreignCurrencies: Record<string, number>; multipleSuppliers: number;
}
export function coverage(results: readonly SurveyResult[]): Coverage {
  const c: Coverage = { total: results.length, ready: 0, historical: 0, review: 0, missing: 0, reasons: {}, bands: {}, undated: 0, fxNeeded: 0, foreignCurrencies: {}, multipleSuppliers: 0 };
  for (const r of results) {
    c[r.tier]++;
    for (const x of r.reasons) c.reasons[x] = (c.reasons[x] ?? 0) + 1;
    if (r.band) c.bands[r.band] = (c.bands[r.band] ?? 0) + 1;
    if (r.reasons.includes("undated")) c.undated++;
    if (r.fxNeeded) { c.fxNeeded++; c.foreignCurrencies[r.currency!] = (c.foreignCurrencies[r.currency!] ?? 0) + 1; }
    if (r.multipleSuppliers) c.multipleSuppliers++;
  }
  return c;
}

const UNIT_KEY = /unit|uom|convers|purchas|pack|moq|minim|multiple|case|carton|pallet/i;
/** Fields whose NAMES suggest a purchase unit or conversion, taken from a raw Cin7 object (scalars only). */
export function pickUnitFields(raw: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (UNIT_KEY.test(k) && (v === null || ["string", "number", "boolean"].includes(typeof v))) out[prefix + k] = v;
  return out;
}
