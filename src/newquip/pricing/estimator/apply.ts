import { stableStringify } from "../../quote/baseline";
import { canEnterPricingInputs, selectRuleVersion, validateScenario, type ForwardCover, type FxQuote, type PricingScenario, type Viewer } from "../model";
import type { EstimatorPricing, SkuPricingInput } from "./types";

// APPLYING AN ESTIMATOR PRICING CHANGE (NQ-008B Phase 2). Pure. The form submits the inputs WITHOUT attribution; this decides who may change them, validates the whole
// result with the Phase 1 model, stamps who/when for exactly the entries that changed (never trusting a client's by/at), bumps the revision and lists every changed value
// (previous -> new) for the immutable revision record. Nothing is stored here.

type NoStamp<T> = Omit<T, "by" | "at">;
/** What the form submits for one SKU: the cost facts only. There is NO verification field (it is derived from an independent review) and no attribution (the server stamps it). */
export type SkuSubmission = Omit<SkuPricingInput, "by" | "at" | "review">;
export interface PricingSubmission {
  ruleVersionId: string;
  skus: Record<string, SkuSubmission>;
  fxQuotes: Record<string, FxQuote>;
  forwardCover: Record<string, NoStamp<ForwardCover>>;
  skuPriceOverrides: Record<string, { unitPriceCents: number; reason: string }>;
  projectMarkup: { markupBps: number; reason: string } | null;
  targetAdjustment: { targetTotalCents: number; reason: string } | null;
}
export interface PricingChange { path: string; previous: unknown; new: unknown }
export type RevisionKind = "ENABLED" | "CHANGED" | "DISABLED";
export type ApplyResult =
  | { ok: true; kind: RevisionKind; next: EstimatorPricing | null; changes: PricingChange[] }
  | { ok: false; errors: string[] };

export const MAX_PRICED_SKUS = 300;
const SKU = /^[A-Za-z0-9._\-/ ]{1,64}$/;
const content = (x: unknown): string => stableStringify(JSON.parse(JSON.stringify(x ?? null), (k, v) => (k === "by" || k === "at" ? undefined : k === "reason" && typeof v === "string" ? v.trim() : v)));

function keepOrStamp<T extends { by: string; at: string }>(sub: Omit<T, "by" | "at"> | null | undefined, prior: T | null | undefined, email: string, nowIso: string): T | null {
  if (!sub) return null;
  if (prior && content(prior) === content(sub)) return prior; // unchanged: the original who/when is kept, whatever the client sent
  const reason = (sub as { reason?: unknown }).reason;
  return { ...sub, ...(typeof reason === "string" ? { reason: reason.trim() } : {}), by: email, at: nowIso } as unknown as T;
}

/** Every leaf that differs, as dotted paths. Attribution and the bookkeeping fields (by, at, pricingDate, revision) are not "changes". */
export function diffPricing(prior: EstimatorPricing | null | undefined, next: EstimatorPricing | null | undefined): PricingChange[] {
  const flat = (v: unknown, base: string, out: Map<string, unknown>) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if ((k === "by" || k === "at") && !base.endsWith(".review")) continue; if (!base && (k === "pricingDate" || k === "revision" || k === "enabled")) continue; flat(x, base ? `${base}.${k}` : k, out); } }
    else if (v !== undefined) out.set(base, v);
  };
  const a = new Map<string, unknown>(), b = new Map<string, unknown>();
  flat(prior ?? {}, "", a); flat(next ?? {}, "", b);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => stableStringify(a.get(k) ?? null) !== stableStringify(b.get(k) ?? null)).map((path) => ({ path, previous: a.get(path) ?? null, new: b.get(path) ?? null }));
}

// ── STRICT SHAPE (security review): the submission comes from a browser, so nothing is trusted to be the shape the types claim. Only known keys are kept (extra keys never reach
// the stored draft), every value is type-checked and bounded, and reserved object keys are refused. Bounds are far above any real price and keep every product below 2^53.
const RESERVED = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]);
const MAX = { text: 200, reason: 500, costMicro: 1e12, rateMicro: 1e9, factorMicro: 1e8, addOnCents: 1e10, priceCents: 1e11, targetCents: 1e13, days: 3650, maps: 300, currencies: 20 } as const;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function normaliseSubmission(raw: unknown, nowIso: string): { ok: true; value: PricingSubmission } | { ok: false; errors: string[] } {
  const e: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["The pricing submission is not valid."] };
  const text = (v: unknown, max: number, label: string, opts: { nullable?: boolean } = {}): string | null => {
    if (v === null || v === undefined) { if (opts.nullable) return null; e.push(`${label} is required.`); return ""; }
    if (typeof v !== "string") { e.push(`${label} must be text.`); return ""; }
    if (v.length > max) { e.push(`${label} is too long (at most ${max} characters).`); return v.slice(0, max); }
    return v;
  };
  const int = (v: unknown, min: number, max: number, label: string): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) { e.push(`${label} must be a whole number between ${min} and ${max}.`); return min; }
    return v;
  };
  const keys = (o: unknown, label: string, max: number, ok: (k: string) => boolean): string[] => {
    if (!isObj(o)) { e.push(`${label} is not valid.`); return []; }
    const ks = Object.keys(o);
    if (ks.length > max) e.push(`${label} has too many entries (at most ${max}).`);
    for (const k of ks) if (RESERVED.has(k) || !ok(k)) e.push(`${label}: "${k.slice(0, 40)}" is not a valid key.`);
    return ks.filter((k) => !RESERVED.has(k) && ok(k)).slice(0, max);
  };
  const out: PricingSubmission = { ruleVersionId: text(raw.ruleVersionId, 64, "The rule version") ?? "", skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };

  const raws = raw.skus;
  for (const k of keys(raws, "Supplier costs", MAX.maps, (x) => SKU.test(x))) {
    const v = (raws as Record<string, unknown>)[k];
    if (!isObj(v)) { e.push(`${k}: the supplier cost entry is not valid.`); continue; }
    const f = v.freight;
    if (f !== null && !isObj(f)) e.push(`${k}: the freight entry is not valid.`);
    const cur = text(v.currency, 3, `${k}: the currency`) ?? "";
    if (!/^[A-Z]{3}$/.test(cur)) e.push(`${k}: the currency must be a three-letter code.`);
    out.skus[k] = {
      supplierId: text(v.supplierId, 64, `${k}: the supplier id`, { nullable: true }), supplierName: text(v.supplierName, 120, `${k}: the supplier`, { nullable: true }),
      currency: cur, nativeUnitCostMicro: v.nativeUnitCostMicro === 0 ? (e.push(`${k}: a zero supplier cost is not a cost. Clear the cost to remove it, or enter the quoted cost.`), 0) : int(v.nativeUnitCostMicro, 1, MAX.costMicro, `${k}: the supplier cost`),
      source: text(v.source, MAX.text, `${k}: the cost source`) ?? "",
      freight: isObj(f) ? { factorMicro: int(f.factorMicro, 1, MAX.factorMicro, `${k}: the freight factor`), ...(f.addOnCents === undefined || f.addOnCents === null ? {} : { addOnCents: int(f.addOnCents, 0, MAX.addOnCents, `${k}: the landed-cost add-on`) }), source: text(f.source, MAX.text, `${k}: the freight source`, { nullable: true }) ?? "" } : null,
    } as PricingSubmission["skus"][string];
  }
  for (const c of keys(raw.fxQuotes, "Exchange rates", MAX.currencies, (x) => /^[A-Z]{3}$/.test(x))) {
    const v = (raw.fxQuotes as Record<string, unknown>)[c];
    if (!isObj(v)) { e.push(`The ${c} exchange rate is not valid.`); continue; }
    const asOf = text(v.asOf, 40, `The ${c} rate date`) ?? "";
    const t = Date.parse(asOf);
    if (!Number.isFinite(t)) e.push(`The ${c} rate date is not a valid date.`);
    else if (t > Date.parse(nowIso) + 5 * 60_000) e.push(`The ${c} rate cannot be dated in the future.`);
    out.fxQuotes[c] = { rateMicro: int(v.rateMicro, 0, MAX.rateMicro, `The ${c} exchange rate`), source: text(v.source, MAX.text, `The ${c} rate source`) ?? "", asOf };
  }
  for (const c of keys(raw.forwardCover, "Forward cover", MAX.currencies, (x) => /^[A-Z]{3}$/.test(x))) {
    const v = (raw.forwardCover as Record<string, unknown>)[c];
    if (!isObj(v)) { e.push(`The ${c} forward-cover entry is not valid.`); continue; }
    out.forwardCover[c] = { rateMicro: int(v.rateMicro, 0, MAX.rateMicro, `The ${c} forward-cover rate`), coverDays: int(v.coverDays, 0, MAX.days, `The ${c} cover period`), reason: text(v.reason, MAX.reason, `The ${c} forward-cover reason`) ?? "", ...(v.reference === undefined || v.reference === null || v.reference === "" ? {} : { reference: text(v.reference, 100, `The ${c} contract reference`) ?? "" }), ...(v.validFrom ? { validFrom: text(v.validFrom, 40, `The ${c} forward-cover start date`) ?? "" } : {}), ...(v.validUntil ? { validUntil: text(v.validUntil, 40, `The ${c} forward-cover end date`) ?? "" } : {}) };
  }
  for (const k of keys(raw.skuPriceOverrides, "Price overrides", MAX.maps, (x) => SKU.test(x))) {
    const v = (raw.skuPriceOverrides as Record<string, unknown>)[k];
    if (!isObj(v)) { e.push(`${k}: the price override is not valid.`); continue; }
    out.skuPriceOverrides[k] = { unitPriceCents: int(v.unitPriceCents, 0, MAX.priceCents, `${k}: the overridden price`), reason: text(v.reason, MAX.reason, `${k}: the override reason`) ?? "" };
  }
  if (raw.projectMarkup !== null && raw.projectMarkup !== undefined) {
    if (!isObj(raw.projectMarkup)) e.push("The project markup is not valid.");
    else out.projectMarkup = { markupBps: int(raw.projectMarkup.markupBps, 0, 100_000, "The project markup"), reason: text(raw.projectMarkup.reason, MAX.reason, "The markup reason") ?? "" };
  }
  if (raw.targetAdjustment !== null && raw.targetAdjustment !== undefined) {
    if (!isObj(raw.targetAdjustment)) e.push("The target price is not valid.");
    else out.targetAdjustment = { targetTotalCents: int(raw.targetAdjustment.targetTotalCents, 0, MAX.targetCents, "The target project price"), reason: text(raw.targetAdjustment.reason, MAX.reason, "The target price reason") ?? "" };
  }
  return e.length ? { ok: false, errors: [...new Set(e)] } : { ok: true, value: out };
}

export function applyPricingSubmission(prior: EstimatorPricing | undefined, sub: PricingSubmission, viewer: Viewer, email: string, nowIso: string, reason: string, quoteType: string): ApplyResult {
  if (!canEnterPricingInputs(viewer)) return { ok: false, errors: ["Only an Estimator or Manager who can see costs can enter or change pricing inputs."] };
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) return { ok: false, errors: ["Say why the pricing is being changed (3 to 500 characters; it is kept with the revision)."] };
  if (quoteType !== "project") return { ok: false, errors: ["Supplier pricing applies to project quotations only."] };
  const shaped = normaliseSubmission(sub, nowIso);
  if (!shaped.ok) return { ok: false, errors: shaped.errors };
  sub = shaped.value;
  if (typeof reason !== "string") return { ok: false, errors: ["Say why the pricing is being changed (it is kept with the revision)."] };
  const rules = selectRuleVersion(sub.ruleVersionId);
  if (!rules.ok) return { ok: false, errors: [rules.error] };
  const skuKeys = Object.keys(sub.skus);
  if (skuKeys.length === 0) return { ok: false, errors: ["Enter at least one supplier cost."] };
  if (skuKeys.length > MAX_PRICED_SKUS) return { ok: false, errors: [`At most ${MAX_PRICED_SKUS} SKUs can be priced.`] };
  const bad = skuKeys.filter((k) => !SKU.test(k));
  if (bad.length) return { ok: false, errors: [`Not a valid SKU: ${bad.slice(0, 3).join(", ")}.`] };

  const skus: EstimatorPricing["skus"] = {};
  for (const [k, v] of Object.entries(sub.skus)) {
    const before = prior && Object.prototype.hasOwnProperty.call(prior.skus, k) ? prior.skus[k] : undefined;
    // An UNCHANGED cost keeps its original who/when AND its independent review; any change re-stamps it and drops the review (it covered a different cost).
    const { review: _r, ...beforeCost } = (before ?? {}) as SkuPricingInput; void _r;
    const kept = before && content(beforeCost) === content(v) ? before : null;
    skus[k] = kept ?? ({ ...v, by: email, at: nowIso } as SkuPricingInput);
  }
  const forwardCover: EstimatorPricing["forwardCover"] = {};
  for (const [c, v] of Object.entries(sub.forwardCover)) forwardCover[c] = keepOrStamp<ForwardCover>(v, prior?.forwardCover[c], email, nowIso)!;
  const skuPriceOverrides: EstimatorPricing["skuPriceOverrides"] = {};
  for (const [k, v] of Object.entries(sub.skuPriceOverrides)) skuPriceOverrides[k] = keepOrStamp(v, prior?.skuPriceOverrides[k], email, nowIso)!;
  const next: EstimatorPricing = {
    enabled: true, ruleVersionId: rules.rules.id, pricingDate: nowIso, revision: (prior?.revision ?? 0) + 1,
    skus, fxQuotes: structuredClone(sub.fxQuotes), forwardCover, skuPriceOverrides,
    projectMarkup: keepOrStamp(sub.projectMarkup, prior?.projectMarkup, email, nowIso),
    targetAdjustment: keepOrStamp(sub.targetAdjustment, prior?.targetAdjustment, email, nowIso),
  };

  // Validate the WHOLE result with the Phase 1 model (rates, costs, freight, overrides, reasons, markup bounds).
  const scenario: PricingScenario = {
    pricingDate: nowIso, fxQuotes: next.fxQuotes, forwardCover: next.forwardCover, projectMarkup: next.projectMarkup, projectAdjustment: null,
    lines: Object.entries(next.skus).map(([sku, s]) => { const { freight, by: _b, at: _a, review: _r, ...cost } = s!; void _b; void _a; void _r; return { key: sku, label: sku, sku, quantity: 1, cost: { ...cost, verification: "unverified" as const }, freight }; }),
    itemOverrides: Object.fromEntries(Object.entries(next.skuPriceOverrides).map(([k, v]) => [k, { price: v! }])),
  };
  const errors = validateScenario(scenario);
  const t = next.targetAdjustment;
  if (t) {
    if (!Number.isSafeInteger(t.targetTotalCents) || t.targetTotalCents <= 0) errors.push("The target project price must be greater than zero.");
    if (t.reason.trim().length < 3) errors.push("A target price adjustment needs a reason.");
  }
  if (errors.length) return { ok: false, errors };

  const changes = diffPricing(prior, next);
  if (changes.length === 0) return { ok: false, errors: ["Nothing changed."] };
  return { ok: true, kind: prior ? "CHANGED" : "ENABLED", next, changes };
}

/** Switching the model OFF is itself a recorded, authorised change (the quotation returns to the POC price source). */
export function disablePricing(prior: EstimatorPricing | undefined, viewer: Viewer, reason: string): ApplyResult {
  if (!canEnterPricingInputs(viewer)) return { ok: false, errors: ["Only an Estimator or Manager who can see costs can change pricing inputs."] };
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) return { ok: false, errors: ["Say why the pricing is being switched off."] };
  if (!prior) return { ok: false, errors: ["Supplier pricing is not switched on for this quotation."] };
  return { ok: true, kind: "DISABLED", next: null, changes: diffPricing(prior, null) };
}

/** The stored pricing as the form edits it: every input, without the server's attribution (which is decided again on save). */
export function submissionFrom(p: EstimatorPricing): PricingSubmission {
  const strip = <T extends { by?: string; at?: string }>(x: T): Omit<T, "by" | "at"> => { const { by: _b, at: _a, ...rest } = x; void _b; void _a; return rest; };
  return {
    ruleVersionId: p.ruleVersionId,
    skus: Object.fromEntries(Object.entries(p.skus).map(([k, v]) => { const { review: _r, ...rest } = v!; void _r; return [k, strip(rest)]; })) as PricingSubmission["skus"],
    fxQuotes: structuredClone(p.fxQuotes) as PricingSubmission["fxQuotes"],
    forwardCover: Object.fromEntries(Object.entries(p.forwardCover).map(([k, v]) => [k, strip(v!)])) as PricingSubmission["forwardCover"],
    skuPriceOverrides: Object.fromEntries(Object.entries(p.skuPriceOverrides).map(([k, v]) => [k, { unitPriceCents: v!.unitPriceCents, reason: v!.reason }])),
    projectMarkup: p.projectMarkup ? { markupBps: p.projectMarkup.markupBps, reason: p.projectMarkup.reason } : null,
    targetAdjustment: p.targetAdjustment ? { targetTotalCents: p.targetAdjustment.targetTotalCents, reason: p.targetAdjustment.reason } : null,
  };
}
