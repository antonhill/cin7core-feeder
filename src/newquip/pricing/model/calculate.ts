import { marginFigures, type MarginFigures } from "@/lib/projects/margin-figures";
import { isInt, isQty, landedCents, lineCents, withMarkupBps } from "./money";
import type { ItemOverride, PricingRuleVersion, PricingScenario, ProjectAdjustment } from "./types";

// THE PRICING CALCULATION (NQ-008B Phase 1). Pure: scenario + rule version in, result out. No I/O, no clock, no role, no UI. Everything it shows is derived from its inputs,
// so the same scenario always gives the same result and a result can be recomputed to verify it.
//
//   per line   landed unit cost  = native cost x exchange rate x freight factor + fixed add-on        (rate = forward cover, else spot, else 1 for ZAR)
//              unit price        = landed x (1 + project markup)                                      (unless an item price override replaces it)
//              revenue / cost    = unit x quantity                                                     (quantity may be replaced by an item quantity override)
//   project    adjustment        = its OWN line, never spread into item prices
//   margin     gross margin %    = (selling - cost) / selling          markup % = (selling - cost) / cost      - separate numbers, never conflated
//
// A cost, rate or price that is not known is NULL and is reported; it is never 0, and a line that cannot be priced is left out of the totals and says why.

export type LineStatus = "priced" | "not_priced";
export type IssueCode = "cost_missing" | "cost_unverified_blocked" | "rate_missing" | "unverified_cost" | "freight_unspecified" | "freight_blocked" | "stale_rate" | "price_override_without_cost";
/** Issues that make the whole quotation provisional (a figure exists but rests on something unconfirmed). A line that is not priced makes it incomplete. */
const PROVISIONAL: ReadonlySet<IssueCode> = new Set(["unverified_cost", "freight_unspecified", "stale_rate", "price_override_without_cost"]);

export interface Issue { key: string | null; code: IssueCode | "adjustment_not_applied"; message: string }
export type RateKind = "base" | "spot" | "forward_cover";
export interface RateUsed { currency: string; rateMicro: number; kind: RateKind; source: string; asOf: string | null; coverDays: number | null }
export type PriceOrigin = "rule_markup" | "project_markup_change" | "item_override";

export interface CalculatedLine {
  key: string;
  label: string;
  sku: string | null;
  status: LineStatus;
  quantity: number;
  baseQuantity: number;
  quantityOverridden: boolean;
  supplier: string | null;
  currency: string | null;
  nativeUnitCostMicro: number | null;
  costVerification: "verified" | "unverified" | null;
  rate: RateUsed | null;
  freightFactorMicro: number | null;
  freightAddOnCents: number | null;
  /** Landed cost per unit, cents. null = unknown. */
  unitLandedCostCents: number | null;
  /** The price the rules produced, before any item override. null when it cannot be calculated. */
  calculatedUnitPriceCents: number | null;
  unitPriceCents: number | null;
  priceOrigin: PriceOrigin | null;
  revenueCents: number | null;
  costCents: number | null;
  margin: MarginFigures | null;
  /** The recorded override (with its reason, who and when) that shaped this line, if any. Internal: never part of a customer view. */
  override: ItemOverride | null;
  issues: Issue[];
}

export interface AdjustmentResult {
  kind: "target_total" | "amount";
  reason: string; by: string; at: string;
  requestedTargetCents: number | null;
  amountCents: number;
  applied: boolean;
}

export type Completeness = "complete" | "provisional" | "incomplete";
export interface PricingResult {
  ruleVersion: { id: string; label: string; status: PricingRuleVersion["status"] };
  pricingDate: string;
  markup: { bps: number; source: "rule_version" | "project_markup_change" };
  lines: CalculatedLine[];
  ratesUsed: RateUsed[];
  itemsRevenueCents: number;
  /** Cost of the priced lines; null unless EVERY priced line has a known cost. */
  itemsCostCents: number | null;
  adjustment: AdjustmentResult | null;
  totalExVatCents: number;
  /** Margin and markup on the TOTAL (after any project adjustment). All null while a priced line has no known cost. */
  margin: MarginFigures | null;
  completeness: Completeness;
  issues: Issue[];
}

export class PricingInputError extends Error {
  constructor(public readonly errors: string[]) { super(errors.join(" ")); this.name = "PricingInputError"; }
}

const ISO = /^[A-Z]{3}$/;
const hasReason = (r: { reason: string; by: string; at: string }): boolean => r.reason.trim().length > 0;

/** Everything wrong with the inputs, in plain words. Empty = the scenario can be calculated. */
export function validateScenario(s: PricingScenario): string[] {
  const e: string[] = [];
  const keys = new Set<string>();
  if (!Number.isFinite(Date.parse(s.pricingDate))) e.push("The pricing date is not a valid date.");
  for (const l of s.lines) {
    if (keys.has(l.key)) e.push(`Line "${l.key}" appears more than once.`);
    keys.add(l.key);
    if (!isQty(l.quantity)) e.push(`${l.label}: the quantity must be greater than zero.`);
    if (l.cost) {
      if (!ISO.test(l.cost.currency)) e.push(`${l.label}: the supplier currency must be a three-letter code.`);
      if (!isInt(l.cost.nativeUnitCostMicro) || l.cost.nativeUnitCostMicro < 0) e.push(`${l.label}: the supplier cost must be a non-negative number.`);
      if (!l.cost.source.trim()) e.push(`${l.label}: say where the supplier cost comes from.`);
    }
    if (l.freight) {
      if (!isInt(l.freight.factorMicro) || l.freight.factorMicro <= 0) e.push(`${l.label}: the freight factor must be greater than zero.`);
      if (l.freight.addOnCents !== undefined && (!isInt(l.freight.addOnCents) || l.freight.addOnCents < 0)) e.push(`${l.label}: the landed-cost add-on must be a whole number of cents, not negative.`);
    }
  }
  for (const [cur, q] of Object.entries(s.fxQuotes)) if (q && (!ISO.test(cur) || cur === "ZAR" || !isInt(q.rateMicro) || q.rateMicro <= 0)) e.push(`The ${cur} exchange rate is not valid (ZAR is always 1).`);
  for (const [cur, f] of Object.entries(s.forwardCover)) {
    if (!f) continue;
    if (!ISO.test(cur) || cur === "ZAR") e.push(`A forward-cover rate cannot be set for ${cur}.`);
    if (!isInt(f.rateMicro) || f.rateMicro <= 0) e.push(`The ${cur} forward-cover rate must be greater than zero.`);
    if (!isInt(f.coverDays) || f.coverDays <= 0) e.push(`The ${cur} forward-cover period must be a whole number of days.`);
    if (!hasReason(f)) e.push(`The ${cur} forward-cover rate needs a reason.`);
  }
  for (const [key, o] of Object.entries(s.itemOverrides)) {
    if (!o) continue;
    if (!keys.has(key)) e.push(`An override refers to "${key}", which is not a line of this quotation.`);
    if (o.price) {
      if (!isInt(o.price.unitPriceCents) || o.price.unitPriceCents <= 0) e.push(`${key}: an overridden price must be greater than zero (a line is never quoted at R0).`);
      if (!hasReason(o.price)) e.push(`${key}: a price override needs a reason.`);
    }
    if (o.quantity) {
      if (!isQty(o.quantity.quantity)) e.push(`${key}: an overridden quantity must be greater than zero.`);
      if (!hasReason(o.quantity)) e.push(`${key}: a quantity override needs a reason.`);
    }
  }
  if (s.projectMarkup) {
    if (!isInt(s.projectMarkup.markupBps) || s.projectMarkup.markupBps < 0 || s.projectMarkup.markupBps > 100_000) e.push("The project markup must be between 0% and 1000%.");
    if (!hasReason(s.projectMarkup)) e.push("A project markup change needs a reason.");
  }
  const a = s.projectAdjustment;
  if (a) {
    if (!hasReason(a)) e.push("A project price adjustment needs a reason.");
    if (a.kind === "target_total" && (!isInt(a.targetTotalCents) || a.targetTotalCents <= 0)) e.push("The target project price must be greater than zero.");
    if (a.kind === "amount" && !isInt(a.amountCents)) e.push("The adjustment amount must be a whole number of cents.");
  }
  return e;
}

export function calculatePricing(scenario: PricingScenario, rules: PricingRuleVersion): PricingResult {
  const errors = validateScenario(scenario);
  if (errors.length) throw new PricingInputError(errors);

  const markupBps = scenario.projectMarkup?.markupBps ?? rules.markupBps;
  const markupSource = scenario.projectMarkup ? "project_markup_change" : "rule_version";
  const nowMs = Date.parse(scenario.pricingDate);
  const used = new Map<string, RateUsed>();

  const lines: CalculatedLine[] = scenario.lines.map((l) => {
    const ov = scenario.itemOverrides[l.key];
    const issues: Issue[] = [];
    const add = (code: IssueCode, message: string) => issues.push({ key: l.key, code, message: `${l.label}: ${message}` });
    const quantity = ov?.quantity?.quantity ?? l.quantity;
    let rate: RateUsed | null = null;
    let unitLanded: number | null = null;
    let freightFactor: number | null = null;
    let addOn: number | null = null;

    if (!l.cost) add("cost_missing", "no supplier cost has been entered, so the cost cannot be calculated.");
    else {
      const c = l.cost;
      if (c.currency === "ZAR") rate = { currency: "ZAR", rateMicro: 1_000_000, kind: "base", source: "Rand", asOf: null, coverDays: null };
      else if (scenario.forwardCover[c.currency]) {
        const f = scenario.forwardCover[c.currency]!;
        rate = { currency: c.currency, rateMicro: f.rateMicro, kind: "forward_cover", source: `Forward cover (${f.coverDays} days) set by ${f.by}`, asOf: f.at, coverDays: f.coverDays };
      } else if (scenario.fxQuotes[c.currency]) {
        const q = scenario.fxQuotes[c.currency]!;
        rate = { currency: c.currency, rateMicro: q.rateMicro, kind: "spot", source: q.source, asOf: q.asOf, coverDays: null };
        if (rules.maxRateAgeDays !== null) {
          const ageDays = (nowMs - Date.parse(q.asOf)) / 86_400_000;
          if (!(ageDays <= rules.maxRateAgeDays)) add("stale_rate", `the ${c.currency} rate is older than ${rules.maxRateAgeDays} days.`);
        }
      } else add("rate_missing", `there is no ${c.currency} exchange rate, so the rand cost cannot be calculated.`);

      if (c.verification === "unverified") {
        if (rules.unverifiedCost === "block") { add("cost_unverified_blocked", "the supplier cost is not verified, and these rules do not price an unverified cost."); rate = null; }
        else add("unverified_cost", "the supplier cost has not been verified.");
      }
      if (rate) {
        if (l.freight) { freightFactor = l.freight.factorMicro; addOn = l.freight.addOnCents ?? 0; }
        else if (rules.freightUnspecified === "block") { add("freight_blocked", "no freight or landed-cost adjustment is recorded, and these rules do not price without one."); rate = null; }
        else { freightFactor = 1_000_000; addOn = 0; add("freight_unspecified", "no freight or landed-cost adjustment is recorded (none assumed)."); }
      }
      if (rate && freightFactor !== null) {
        unitLanded = landedCents(c.nativeUnitCostMicro, rate.rateMicro, freightFactor) + (addOn ?? 0);
        used.set(`${rate.currency}|${rate.kind}|${rate.rateMicro}`, rate);
      }
    }

    const calculated = unitLanded === null ? null : withMarkupBps(unitLanded, markupBps);
    let unitPrice = calculated;
    let origin: PriceOrigin | null = calculated === null ? null : markupSource === "project_markup_change" ? "project_markup_change" : "rule_markup";
    if (ov?.price) { unitPrice = ov.price.unitPriceCents; origin = "item_override"; if (unitLanded === null) add("price_override_without_cost", "priced by an override but its cost is unknown, so no margin is shown."); }

    const revenue = unitPrice === null ? null : lineCents(unitPrice, quantity);
    const priced = revenue !== null;
    const cost = priced && unitLanded !== null ? lineCents(unitLanded, quantity) : null;
    return {
      key: l.key, label: l.label, sku: l.sku, status: priced ? "priced" : "not_priced",
      quantity, baseQuantity: l.quantity, quantityOverridden: ov?.quantity !== undefined,
      supplier: l.cost?.supplierName ?? null, currency: l.cost?.currency ?? null, nativeUnitCostMicro: l.cost?.nativeUnitCostMicro ?? null, costVerification: l.cost?.verification ?? null,
      rate, freightFactorMicro: freightFactor, freightAddOnCents: addOn,
      unitLandedCostCents: unitLanded, calculatedUnitPriceCents: calculated, unitPriceCents: unitPrice, priceOrigin: origin,
      revenueCents: revenue, costCents: cost, margin: revenue === null ? null : marginFigures(revenue, cost), override: ov && (ov.price || ov.quantity) ? structuredClone(ov) : null, issues,
    };
  });

  const priced = lines.filter((l) => l.status === "priced");
  const itemsRevenue = priced.reduce((a, l) => a + (l.revenueCents ?? 0), 0);
  const itemsCost = priced.length > 0 && priced.every((l) => l.costCents !== null) ? priced.reduce((a, l) => a + (l.costCents ?? 0), 0) : null;
  const issues: Issue[] = lines.flatMap((l) => l.issues);
  const incomplete = lines.some((l) => l.status === "not_priced");

  let adjustment: AdjustmentResult | null = null;
  const a: ProjectAdjustment | null = scenario.projectAdjustment;
  if (a) {
    const base = { reason: a.reason.trim(), by: a.by, at: a.at };
    if (a.kind === "target_total") {
      // A target is meaningless against a partial total, so it is not applied until every line is priced.
      adjustment = incomplete
        ? { kind: a.kind, ...base, requestedTargetCents: a.targetTotalCents, amountCents: 0, applied: false }
        : { kind: a.kind, ...base, requestedTargetCents: a.targetTotalCents, amountCents: a.targetTotalCents - itemsRevenue, applied: true };
      if (!adjustment.applied) issues.push({ key: null, code: "adjustment_not_applied", message: "The target project price is not applied while some lines are not priced." });
    } else if (itemsRevenue + a.amountCents < 0) {
      adjustment = { kind: a.kind, ...base, requestedTargetCents: null, amountCents: 0, applied: false };
      issues.push({ key: null, code: "adjustment_not_applied", message: "The adjustment would make the project price negative, so it is not applied." });
    } else adjustment = { kind: a.kind, ...base, requestedTargetCents: null, amountCents: a.amountCents, applied: true };
  }

  const total = itemsRevenue + (adjustment?.applied ? adjustment.amountCents : 0);
  const provisional = issues.some((i) => i.code !== "adjustment_not_applied" && PROVISIONAL.has(i.code));
  return {
    ruleVersion: { id: rules.id, label: rules.label, status: rules.status },
    pricingDate: scenario.pricingDate,
    markup: { bps: markupBps, source: markupSource },
    lines,
    ratesUsed: [...used.values()].sort((x, y) => x.currency.localeCompare(y.currency) || x.kind.localeCompare(y.kind)),
    itemsRevenueCents: itemsRevenue,
    itemsCostCents: itemsCost,
    adjustment,
    totalExVatCents: total,
    margin: priced.length === 0 ? null : marginFigures(total, itemsCost),
    completeness: incomplete ? "incomplete" : provisional ? "provisional" : "complete",
    issues,
  };
}
