// NewQuip SUPPLIER PRICE OPTIONS, CURRENCY and UNIT NORMALISATION, and SUPPLIER SELECTION (pure).
//
// Cin7 keeps one price record per product-supplier pair (Suppliers[]), in THAT SUPPLIER'S CURRENCY. This module turns each record into a comparable ZAR
// unit cost - or says exactly why it cannot - and applies the owner-approved selection rules. Nothing here ever invents a number:
//   * a foreign-currency price is converted only with a recorded rate (source + effective time); no rate / a stale rate / an invalid currency = UNUSABLE;
//   * a price whose unit basis is not established is UNUSABLE (no silent per-stock-unit assumption);
//   * a missing price is never zero; AverageCost and FixedCost are never substituted;
//   * the newest "last supplied" date NEVER decides which supplier is used (the date is informational);
//   * the cheapest supplier is NEVER chosen automatically.
// ROUNDING POLICY: the original price keeps full precision (1/1,000,000 of a currency unit). The ZAR unit cost is price x rate / unit-factor, rounded HALF UP
// to the whole cent ONCE, in exact integer arithmetic; totals are quantity x that rounded unit cost, rounded half up to the cent.

export type OptionProblemCode = "NO_COST" | "INVALID_COST" | "NO_CURRENCY" | "INVALID_CURRENCY" | "NO_RATE" | "INVALID_RATE" | "STALE_RATE" | "UOM_UNCONFIRMED" | "BAD_CONVERSION_FACTOR" | "BAD_DATE";
export interface OptionProblem { code: OptionProblemCode; message: string; blocking: boolean }

/** A Cin7 Suppliers[] record as read, before any interpretation. Every field may be absent. */
export interface RawSupplierPrice {
  supplierId: string | null; supplierName: string | null;
  /** Suppliers[].Cost: the supplier's Latest Price, in the supplier's currency, per `purchaseUnit` (or the stock unit when none is stated). */
  cost: number | null;
  /** The currency of that price: the record's own, else the supplier master's. Null when neither is known. */
  currency: string | null;
  lastSupplied: string | null;
  /** Only when Cin7 states it: the unit the price is quoted in, and how many STOCK units one such unit contains. */
  purchaseUnit?: string | null; stockUnit?: string | null; conversionFactor?: number | null;
  preferred?: boolean | null;
  /**
   * Names of the unit-related fields (unit / UOM / pack / carton / conversion / multiple) that Cin7 returned with a value on THIS Suppliers[] record.
   * `undefined` = the record was captured before this was tracked, or by something that did not look: unknown, so never treated as "none".
   * `[]` = a fresh read that positively found none, i.e. the record states no unit of its own and Cin7's single product UOM governs the price.
   */
  statedUnitFields?: string[];
}

/** How the unit of a usable price was established (kept on the option as the audit trail). */
export type UnitBasisSource = "STATED_SAME_UNIT" | "STATED_FACTOR" | "CIN7_SINGLE_STOCK_UOM" | "CONFIRMED_BY_USER";

export interface FxRate { currency: string; /** Decimal string, ZAR per 1 unit of `currency`, up to 6 decimals. */ rate: string; source: string; /** When the rate was effective (ISO). */ asOf: string }
export interface UnitBasis { basis: "STOCK_UNIT"; confirmedBy: string; confirmedAt: string; reason: string }
export interface NormaliseEnv { fx: Readonly<Record<string, FxRate | undefined>>; nowIso: string; maxRateAgeHours: number; unitBasis: UnitBasis | null }

export const BASE_CURRENCY = "ZAR";
export const DEFAULT_MAX_RATE_AGE_HOURS = 72;

export interface SupplierOption {
  /** The record exactly as read from Cin7 (kept so the option can be re-evaluated under a newer exchange rate without another Cin7 call). */
  raw: RawSupplierPrice;
  supplierId: string | null; supplierName: string | null;
  /** The ORIGINAL unit price in millionths of a currency unit (full precision, exact), as supplied. */
  priceMicro: number | null; currency: string | null;
  lastSupplied: string | null; lastSuppliedValid: boolean;
  purchaseUnit: string | null; /** Stock units per purchase unit actually used (1 when the price is per stock unit). */ conversionFactor: number | null;
  preferred: boolean | null;
  /** How the unit was established; null when the price is unusable for a unit reason. Absent on options stored before this existed. */
  unitBasisSource?: UnitBasisSource | null;
  fx: { rate: string; source: string; asOf: string } | null;
  zarUnitCents: number | null;
  status: "USABLE" | "UNUSABLE"; problems: OptionProblem[];
}

const ISO = /^[A-Z]{3}$/;
const RATE = /^\d{1,6}(\.\d{1,6})?$/;
const big = (n: number) => BigInt(Math.round(n));
const BIG_0 = BigInt(0), BIG_2 = BigInt(2), BIG_100 = BigInt(100), BIG_1E6 = BigInt(1000000);

/** Decimal string "17.5" -> millionths (17_500_000), exact; null when not a plain positive decimal with at most 6 decimals. */
export function rateToMicro(rate: string): bigint | null {
  const t = rate.trim();
  if (!RATE.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const micro = BigInt(w) * BIG_1E6 + BigInt(f.padEnd(6, "0"));
  return micro > BIG_0 ? micro : null;
}

/** floor((a * 2 + b) / (2 * b)) for positive b: exact round-half-up integer division. */
const divRound = (a: bigint, b: bigint): bigint => (BIG_2 * a + b) / (BIG_2 * b);

/** price (micro units) x rate (micro) / factor (micro) -> whole ZAR cents, half up, exact. price*rate is in 1e-12 currency units; x100 for cents; factor in 1e-6. */
export function convertToZarCents(priceMicro: number, rateMicro: bigint, factorMicro: bigint): number {
  // cents = price * rate / factor * 100 = (priceMicro/1e6)*(rateMicro/1e6)/(factorMicro/1e6)*100 = priceMicro*rateMicro*100 / (factorMicro * 1e6)
  return Number(divRound(big(priceMicro) * rateMicro * BIG_100, factorMicro * BIG_1E6));
}

const parseOk = (iso: string | null): boolean => !!iso && Number.isFinite(new Date(iso).getTime());

export function normaliseOption(raw: RawSupplierPrice, env: NormaliseEnv): SupplierOption {
  const problems: OptionProblem[] = [];
  const block = (code: OptionProblemCode, message: string) => problems.push({ code, message, blocking: true });
  const currency = raw.currency === null ? null : raw.currency.trim().toUpperCase();

  // price
  let priceMicro: number | null = null;
  if (raw.cost === null || raw.cost === undefined) block("NO_COST", "Cin7 holds no Latest Price for this supplier.");
  else if (typeof raw.cost !== "number" || !Number.isFinite(raw.cost)) block("INVALID_COST", "The Latest Price is not a number.");
  else if (raw.cost <= 0) block("NO_COST", raw.cost === 0 ? "The Latest Price is zero, which is treated as no price (never as a cost of zero)." : "The Latest Price is negative.");
  else priceMicro = Math.round(raw.cost * 1_000_000);

  // currency + rate
  let fx: SupplierOption["fx"] = null;
  let rateMicro: bigint | null = null;
  if (currency === null || currency === "") block("NO_CURRENCY", "The supplier price has no currency, so it cannot be compared.");
  else if (!ISO.test(currency)) block("INVALID_CURRENCY", `"${raw.currency}" is not a valid ISO 4217 currency code.`);
  else if (currency === BASE_CURRENCY) { rateMicro = BIG_1E6; fx = null; }
  else {
    const r = env.fx[currency];
    if (!r) block("NO_RATE", `No exchange rate to ZAR is recorded for ${currency}, so this price cannot be treated as rand.`);
    else {
      const m = rateToMicro(r.rate);
      const t = new Date(r.asOf).getTime();
      if (m === null) block("INVALID_RATE", `The recorded ${currency} rate "${r.rate}" is invalid.`);
      else if (!Number.isFinite(t)) block("INVALID_RATE", `The ${currency} rate has no valid effective time.`);
      else if (new Date(env.nowIso).getTime() - t > env.maxRateAgeHours * 3_600_000) block("STALE_RATE", `The ${currency} rate is older than ${env.maxRateAgeHours} hours (effective ${r.asOf}); record a current rate.`);
      else { rateMicro = m; fx = { rate: r.rate.trim(), source: r.source, asOf: r.asOf }; }
    }
  }

  // unit
  // Cin7 Core keeps ONE unit of measure per product (Product.UOM) and a Suppliers[] record has no unit or conversion field of its own: the Latest Price is per
  // that stock unit. So a record that states no unit-related field, on a product whose stock unit is known, is per stock unit - this is a property of the
  // record's own contents (the `[]` below must come from a fresh read), not an assumption about the supplier. Anything that DOES state a unit, a pack or a
  // conversion we cannot interpret stays blocked, as does a record whose stock unit or content is unknown.
  let factor: number | null = null;
  let unitSource: UnitBasisSource | null = null;
  const pu = (raw.purchaseUnit ?? "").trim(); const su = (raw.stockUnit ?? "").trim();
  const stated = raw.statedUnitFields;
  if (raw.conversionFactor !== undefined && raw.conversionFactor !== null) {
    if (!Number.isFinite(raw.conversionFactor) || raw.conversionFactor <= 0) block("BAD_CONVERSION_FACTOR", "The purchase-unit conversion factor is not a positive number.");
    else { factor = raw.conversionFactor; unitSource = "STATED_FACTOR"; }
  } else if (stated && stated.length > 0) block("UOM_UNCONFIRMED", `Cin7 returned unit-related information on this price (${stated.join(", ")}) that this tool cannot interpret, so it is not assumed to be per stock unit.`);
  else if (pu && su && pu.toLowerCase() !== su.toLowerCase()) block("BAD_CONVERSION_FACTOR", `The price is quoted per "${pu}" but the stock unit is "${su}" and the number of ${su} in one ${pu} is not known.`);
  else if (pu && su) { factor = 1; unitSource = "STATED_SAME_UNIT"; } // same unit stated on both sides
  else if (stated && stated.length === 0 && su) { factor = 1; unitSource = "CIN7_SINGLE_STOCK_UOM"; } // no unit of its own: Cin7's one product UOM governs
  else if (env.unitBasis && env.unitBasis.basis === "STOCK_UNIT") { factor = 1; unitSource = "CONFIRMED_BY_USER"; } // explicitly confirmed by an authorised user for this estimate
  else block("UOM_UNCONFIRMED", stated && stated.length === 0 ? "Cin7 did not return the product's stock unit, so the unit of this price cannot be established, and nobody has confirmed it is per stock unit." : "Cin7 does not state which unit this price is for, and nobody has confirmed it is per stock unit.");

  const dateOk = raw.lastSupplied === null || raw.lastSupplied === "" ? true : parseOk(raw.lastSupplied);
  if (!dateOk) problems.push({ code: "BAD_DATE", message: `The last-supplied date "${raw.lastSupplied}" cannot be read. It is informational only and does not affect the cost.`, blocking: false });

  let zar: number | null = null;
  if (priceMicro !== null && rateMicro !== null && factor !== null && !problems.some((p) => p.blocking)) {
    zar = convertToZarCents(priceMicro, rateMicro, BigInt(Math.round(factor * 1_000_000)));
    if (zar <= 0) { zar = null; problems.push({ code: "NO_COST", message: "The converted cost rounds to zero, which is not a usable cost.", blocking: true }); }
  }
  return {
    raw: { ...raw }, supplierId: raw.supplierId, supplierName: raw.supplierName, priceMicro, currency: currency || null, lastSupplied: raw.lastSupplied, lastSuppliedValid: dateOk,
    purchaseUnit: pu || null, conversionFactor: factor, preferred: raw.preferred ?? null, unitBasisSource: zar === null ? null : unitSource, fx, zarUnitCents: zar,
    status: zar === null ? "UNUSABLE" : "USABLE", problems,
  };
}

export type SelectionMethod = "AUTO_SINGLE" | "PREFERRED" | "MANUAL_SELECTION";
export type SelectionStatus = "SELECTED" | "NEEDS_CHOICE" | "PREFERRED_INVALID" | "MISSING";
export interface ChosenSupplier { supplierId: string | null; supplierName: string | null; method: SelectionMethod; reason?: string; by?: string; at?: string }
export interface Selection { status: SelectionStatus; chosen: ChosenSupplier | null; option: SupplierOption | null; message: string }

const same = (a: Pick<SupplierOption, "supplierId" | "supplierName">, b: { supplierId: string | null; supplierName: string | null }) =>
  a.supplierId !== null && b.supplierId !== null ? a.supplierId === b.supplierId : (a.supplierName ?? "").trim().toLowerCase() === (b.supplierName ?? "").trim().toLowerCase() && !!a.supplierName;

/**
 * The owner-approved rules:
 *  - an explicit, usable Estimator choice stands (it is only ever changed by the Estimator);
 *  - exactly one flagged preferred supplier that is usable is selected; a preferred supplier that is unusable or absent requires an explicit alternative
 *    or an authorised manual estimate (it never silently falls back);
 *  - with no preference, a single usable supplier is selected automatically; several require a choice; none = MISSING.
 * Never the newest date, never the cheapest.
 */
export function selectSupplier(options: readonly SupplierOption[], choice?: ChosenSupplier | null): Selection {
  const usable = options.filter((o) => o.status === "USABLE");
  if (choice && choice.method === "MANUAL_SELECTION") {
    const o = options.find((x) => same(x, choice));
    if (o && o.status === "USABLE") return { status: "SELECTED", chosen: choice, option: o, message: `Selected by the estimator${choice.reason ? `: ${choice.reason}` : ""}.` };
    // the earlier choice is no longer usable (price removed, rate stale ...): fall through and say so, never keep a cost that is gone
  }
  const flagged = options.filter((o) => o.preferred === true);
  if (flagged.length === 1) {
    const p = flagged[0];
    if (p.status === "USABLE") return { status: "SELECTED", chosen: { supplierId: p.supplierId, supplierName: p.supplierName, method: "PREFERRED" }, option: p, message: "The preferred supplier." };
    return { status: "PREFERRED_INVALID", chosen: null, option: null, message: `The preferred supplier ${p.supplierName ?? p.supplierId ?? ""} has no usable price (${p.problems.filter((x) => x.blocking).map((x) => x.message).join(" ")}). Choose another supplier or enter an authorised manual estimate.` };
  }
  if (usable.length === 0) return { status: "MISSING", chosen: null, option: null, message: options.length === 0 ? "Cin7 has no supplier price for this product." : "No supplier has a usable Latest Price." };
  if (flagged.length === 0 && usable.length === 1) {
    const o = usable[0];
    return { status: "SELECTED", chosen: { supplierId: o.supplierId, supplierName: o.supplierName, method: "AUTO_SINGLE" }, option: o, message: "The only supplier with a usable price." };
  }
  return { status: "NEEDS_CHOICE", chosen: null, option: null, message: flagged.length > 1 ? "More than one supplier is marked preferred, so there is no valid preference: the estimator must choose." : `${usable.length} suppliers have a usable price: the estimator must choose.` };
}

/** Whether a supplier choice may replace the current one without a reason: only the first choice. Changing an existing choice needs a recorded reason. */
export function selectionNeedsReason(previous: ChosenSupplier | null | undefined, next: { supplierId: string | null; supplierName: string | null }, options: readonly SupplierOption[]): boolean {
  if (previous && !same({ supplierId: previous.supplierId, supplierName: previous.supplierName }, next)) return true;
  const flagged = options.filter((o) => o.preferred === true);
  return flagged.length === 1 && !same(flagged[0], next); // choosing against the preference
}

/** Reads the standard fields from a raw Cin7 Suppliers[] element. Only fields confirmed in this repo are read; the rest stay null/absent. */
export function rawFromCin7(s: Record<string, unknown>, supplierCurrency: (name: string | null) => string | null): RawSupplierPrice {
  const name = typeof s.SupplierName === "string" ? s.SupplierName : typeof s.Supplier === "string" ? s.Supplier : null;
  const id = typeof s.SupplierID === "string" ? s.SupplierID : typeof s.ID === "string" ? s.ID : null;
  const own = typeof s.Currency === "string" && s.Currency.trim() ? s.Currency : null;
  return {
    supplierId: id, supplierName: name, cost: typeof s.Cost === "number" ? s.Cost : null, currency: own ?? supplierCurrency(name),
    lastSupplied: typeof s.LastSupplied === "string" && s.LastSupplied ? s.LastSupplied : null,
    statedUnitFields: statedUnitFields(s),
  };
}

/** Top-level Suppliers[] keys known (live-confirmed or documented) to carry NO unit information. Anything else with a value is treated as a possible unit statement. */
const KNOWN_SUPPLIER_KEYS = new Set(["SupplierID", "SupplierName", "Supplier", "ID", "Cost", "FixedCost", "Currency", "LastSupplied", "DropShip", "SupplierInventoryCode", "SupplierProductName", "ProductSupplierOptions"]);
/** Keys inside ProductSupplierOptions[] known to carry no unit information (reorder / lead-time planning only). */
const KNOWN_OPTION_KEYS = new Set(["LocationID", "LocationName", "ReorderQuantity", "Lead", "Safety", "MinimumToReorder"]);
const ID_LIKE = /^[0-9a-f]{8}-?([0-9a-f]{4}-?){3}[0-9a-f]{12}$/i;
/**
 * Fields seen on real live Cin7 Suppliers[] records (NQ-Q-0023 capture, 2026-11-03: all 24 records carried exactly these four) that carry no unit semantics, accepted
 * ONLY in their expected shape so a changed meaning still fails closed:
 *  - ProductID, ProductSupplierID: record identifiers (GUID strings).
 *  - IncludeInPricing: a boolean flag (whether the supplier price feeds product pricing), not a quantity or unit.
 *  - PurchaseCost: a cost figure. Its own semantics are not documented, so it is accepted only when it is zero (unset: a zero carries no unit or pack factor) or numerically identical to Cost (it then adds nothing that could
 *    disagree with the Latest Price's unit); any different number, or a non-number, keeps the price blocked and is reported for a human to look at.
 */
function isInertMetadata(key: string, s: Record<string, unknown>): boolean {
  const v = s[key];
  if (key === "ProductID" || key === "ProductSupplierID") return typeof v === "string" && ID_LIKE.test(v);
  if (key === "IncludeInPricing") return typeof v === "boolean";
  if (key === "PurchaseCost") return typeof v === "number" && Number.isFinite(v) && (v === 0 || (typeof s.Cost === "number" && Math.abs(v - s.Cost) < 0.0000005));
  return false;
}
/** A blocked field named WITH its value (prices and ids only; nothing sensitive) so the next capture shows a human what the field actually holds. */
function describeBlocked(k: string, s: Record<string, unknown>): string {
  const show = (v: unknown) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t.length > 40 ? `${t.slice(0, 40)}...` : t; };
  if (k === "PurchaseCost") return `PurchaseCost=${show(s[k])} (Cost=${show(s.Cost)}; accepted only when 0 or equal to Cost)`;
  if (k === "ProductID" || k === "ProductSupplierID") return `${k}=${show(s[k])} (expected a GUID string)`;
  if (k === "IncludeInPricing") return `IncludeInPricing=${show(s[k])} (expected true/false)`;
  return k;
}
const has = (v: unknown) => v !== null && v !== undefined && v !== "";
/**
 * The fields a Cin7 Suppliers[] record carries with a value that are NOT known to be unit-free. Empty = the record states no unit of its own.
 * An ALLOWLIST on purpose: a new or unrecognised field (a pack size, a bag size, a nested carton quantity) blocks the price rather than slipping through as
 * per-unit; the cost is only that an unrelated new field also blocks, visibly, by name.
 */
export function statedUnitFields(s: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(s)) if (has(s[k]) && !KNOWN_SUPPLIER_KEYS.has(k) && !isInertMetadata(k, s)) out.add(describeBlocked(k, s));
  const opts = s.ProductSupplierOptions;
  if (opts !== null && opts !== undefined && !Array.isArray(opts)) out.add("ProductSupplierOptions");
  else for (const o of (opts as unknown[] | undefined) ?? []) {
    if (o === null || typeof o !== "object" || Array.isArray(o)) { out.add("ProductSupplierOptions"); continue; }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (has(v) && !KNOWN_OPTION_KEYS.has(k)) out.add(`ProductSupplierOptions.${k}`);
  }
  return [...out].sort();
}
