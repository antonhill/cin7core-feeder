import { classifySku, type MasterSupplier, type SurveyInput } from "./cost-survey";
import { canPriceAnything, fxFresh, resolveFreight, type CommercialSettings } from "./commercial-settings";
import { escalateCostE7, escalationFor } from "./cost-escalation";
import { cost7, formatCost7 } from "./model/money";
import type { PricingSubmission, SkuSubmission } from "./estimator/apply";
import { AUTO_ACTOR, autoFlagAction, isAutoOwned } from "./estimator/auto-owned";
export { AUTO_ACTOR, autoFlagAction, isAutoOwned };

// AUTOMATIC COSTING FROM CIN7 (pure; no I/O). For one SKU: the Cin7 supplier record the survey already selects (the latest-dated positive supplier cost) + the Manager's commercial settings +
// today -> EITHER the same per-SKU cost input the Estimator workflow stores (so the prices come out of calculatePricing via createEstimatorPriceSource: there is NO second calculator),
// OR a flag saying exactly why no price is produced. It never invents a value: a missing exchange rate, a missing freight policy, a missing / undated / future-dated / over-age / ambiguous
// cost each give NO price and a flag. The result is marked costKind "cin7_auto" (distinct from an Estimator-entered cost) and is ALWAYS unverified: a Manager still verifies it independently.

export type AutoFlagCode = "settings_incomplete" | "not_read" | "no_cost" | "cost_needs_review" | "cost_too_old" | "currency_unknown" | "fx_missing" | "fx_stale" | "cost_precision" | "freight_not_set" | "freight_conflict";
/** Text that is safe for ANY viewer, including a Rep: it never carries a cost, rate, freight or margin. */
export const NEUTRAL_FLAG_TEXT: Record<AutoFlagCode, string> = {
  settings_incomplete: "Price pending: commercial settings incomplete",
  not_read: "Price pending: the supplier cost has not been read yet",
  no_cost: "No Cin7 cost for this product",
  cost_needs_review: "Price pending: the supplier cost needs review",
  cost_too_old: "Price pending: a current supplier quotation is needed",
  currency_unknown: "Price pending: the supplier currency needs review",
  fx_missing: "Price pending: commercial settings incomplete",
  fx_stale: "Price pending: commercial settings incomplete",
  cost_precision: "Price pending: the supplier cost needs review",
  freight_not_set: "Price pending: commercial settings incomplete",
  freight_conflict: "Price pending: commercial settings incomplete",
};
export interface AutoFlag { sku: string; code: AutoFlagCode; /** Internal detail for the Estimator / Manager (may name a currency or reason; never a cost value). */ internal: string }

export interface SettingsRef { version: number; enteredBy: string }
export interface AutoCostEntry {
  sku: string;
  input: SkuSubmission;
  provenance: { origin: "auto_cin7"; settingsVersion: number; rawCostE7: number; escalatedCostE7: number; escalationBps: number; ageDays: number; lastSupplied: string; currency: string; supplierId: string | null };
}

/** A Cin7 cost (a JSON number) as exact E7 units. A number with more than 7 decimals is REFUSED (null), never rounded. */
export function toCostE7(x: number | null | undefined): number | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return null;
  const fixed = x.toFixed(7);
  if (Number(fixed) !== x) return null;
  try { return cost7(fixed); } catch { return null; }
}

/** One SKU's Cin7 raw facts -> an auto cost entry, or the reason there is no price. */
export function autoCostFor(input: SurveyInput, master: ReadonlyMap<string, MasterSupplier>, settings: CommercialSettings | null, ref: SettingsRef, nowIso: string, categories: readonly string[] = []): AutoCostEntry | AutoFlag {
  const sku = input.sku;
  const flag = (code: AutoFlagCode, internal: string): AutoFlag => ({ sku, code, internal });
  if (!settings || !canPriceAnything(settings)) return flag("settings_incomplete", "No freight policy is set in the commercial settings.");
  // Freight: the product's CATEGORY policy, else the Manager's default, else an exception. It is never silently 1.0.
  const fr = resolveFreight(settings, categories);
  if (!fr.ok) return fr.reason === "conflict"
    ? flag("freight_conflict", `This product is used by more than one freight category (${fr.categories.join(", ")}) with different policies: a Manager must resolve it.`)
    : flag("freight_not_set", `No freight policy is configured for this product's category (${fr.categories.join(", ") || "none"}) and no default freight policy is set.`);
  const today = nowIso.slice(0, 10);
  const r = classifySku(input, master, today);
  if (r.tier === "missing") return flag("no_cost", `Cin7 has no usable supplier cost (${r.reasons.join(", ")}).`);
  // The survey's own 5-year flag is judged against the Manager's configured maximum below; any OTHER reason (undated, future-dated, ambiguous, supplier unknown / inactive, currency conflict) needs a person.
  const blocking = r.reasons.filter((x) => x !== "older_than_maximum");
  if (!r.selected || blocking.length > 0) {
    if (r.selected && blocking.every((x) => x === "currency_unknown" || x === "currency_conflict")) return flag("currency_unknown", `The supplier's currency in Cin7 is missing or conflicting (${blocking.join(", ")}).`);
    return flag("cost_needs_review", `The Cin7 supplier cost needs review (${blocking.join(", ")}).`);
  }
  const esc = escalationFor(r.selected.lastSupplied, nowIso, settings.ageBands, settings.maxAgeYears, settings.daysPerYearCenti);
  if (esc.status === "older_than_maximum") return flag("cost_too_old", `The Cin7 cost is ${esc.ageDays} days old, over the ${settings.maxAgeYears}-year maximum: no automatic price.`);
  if (esc.status !== "ok") return flag("cost_needs_review", `The Cin7 cost is ${esc.status === "undated" ? "undated" : "future-dated"}: no automatic price.`);
  const currency = r.currency;
  if (!currency) return flag("currency_unknown", "The supplier's own Cin7 record holds no currency.");
  const raw = toCostE7(r.selected.cost);
  if (raw === null) return flag("cost_precision", "The Cin7 cost cannot be held exactly (more than 7 decimals or out of range).");
  if (currency !== "ZAR") {
    const q = settings.fx[currency];
    if (!q) return flag("fx_missing", `The ${currency} exchange rate is not set in the commercial settings.`);
    if (!fxFresh(q, settings.fxMaxAgeDays, Date.parse(nowIso))) return flag("fx_stale", `The ${currency} exchange rate is older than ${settings.fxMaxAgeDays} day(s).`);
  }
  const escalated = escalateCostE7(raw, esc.factorBps);
  const pct = `${Math.floor(esc.escalationBps / 100)}.${String(esc.escalationBps % 100).padStart(2, "0")}`; // display text only
  const lastSupplied = r.selected.lastSupplied!.slice(0, 10);
  const src = `Auto from Cin7: ${formatCost7(raw)} ${currency} last supplied ${lastSupplied}, +${pct}% age escalation over ${esc.ageDays} days (commercial settings v${ref.version}). Needs verification.`;
  return {
    sku,
    input: {
      supplierId: r.selected.supplierId, supplierName: r.selected.supplierName, currency, nativeUnitCostE7: escalated, source: src.slice(0, 200),
      freight: { factorMicro: fr.policy.factorMicro, addOnCents: fr.policy.addOnCents, source: `Commercial settings v${ref.version}${fr.category ? ` (${fr.category})` : ""}: ${fr.policy.source}`.slice(0, 200) },
      currencySource: "cin7_supplier", costKind: "cin7_auto", costDate: lastSupplied,
    },
    provenance: { origin: "auto_cin7", settingsVersion: ref.version, rawCostE7: raw, escalatedCostE7: escalated, escalationBps: esc.escalationBps, ageDays: esc.ageDays, lastSupplied, currency, supplierId: r.selected.supplierId },
  };
}

export const isFlag = (x: AutoCostEntry | AutoFlag): x is AutoFlag => "code" in x;

/**
 * The submission that records these entries on top of what is already stored. `prior` (null = pricing is off) is carried over UNCHANGED: an existing SKU entry, rate, override or markup is never replaced
 * (only SKUs with no entry are added), so an Estimator's cost can never be overwritten. A foreign rate is added from the settings only where none is stored; the Manager's markup, when set, becomes an
 * attributed project markup only where none is stored. Pure.
 */
export function mergeAutoEntries(prior: PricingSubmission | null, entries: readonly AutoCostEntry[], settings: CommercialSettings, ref: SettingsRef, rulesId: string): PricingSubmission {
  const out: PricingSubmission = prior ? structuredClone(prior) : { ruleVersionId: rulesId, skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };
  for (const e of entries) {
    if (Object.prototype.hasOwnProperty.call(out.skus, e.sku)) continue; // idempotent: never overwrite
    out.skus[e.sku] = e.input;
    const c = e.input.currency;
    if (c !== "ZAR" && !out.fxQuotes[c] && settings.fx[c]) out.fxQuotes[c] = { rateMicro: settings.fx[c].rateMicro, source: settings.fx[c].source, asOf: settings.fx[c].asOf };
  }
  if (!out.projectMarkup && settings.markupBps !== null) out.projectMarkup = { markupBps: settings.markupBps, reason: `Manager-entered markup in commercial settings v${ref.version} (entered by ${ref.enteredBy})` };
  return out;
}
