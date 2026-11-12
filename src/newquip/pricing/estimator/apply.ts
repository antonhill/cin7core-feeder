import { stableStringify } from "../../quote/baseline";
import { canEnterPricingInputs, selectRuleVersion, validateScenario, type ForwardCover, type FxQuote, type PricingScenario, type Viewer } from "../model";
import type { EstimatorPricing, SkuPricingInput } from "./types";

// APPLYING AN ESTIMATOR PRICING CHANGE (NQ-008B Phase 2). Pure. The form submits the inputs WITHOUT attribution; this decides who may change them, validates the whole
// result with the Phase 1 model, stamps who/when for exactly the entries that changed (never trusting a client's by/at), bumps the revision and lists every changed value
// (previous -> new) for the immutable revision record. Nothing is stored here.

type NoStamp<T> = Omit<T, "by" | "at">;
export interface PricingSubmission {
  ruleVersionId: string;
  skus: Record<string, NoStamp<SkuPricingInput>>;
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
    if (v !== null && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "by" || k === "at") continue; if (!base && (k === "pricingDate" || k === "revision" || k === "enabled")) continue; flat(x, base ? `${base}.${k}` : k, out); } }
    else if (v !== undefined) out.set(base, v);
  };
  const a = new Map<string, unknown>(), b = new Map<string, unknown>();
  flat(prior ?? {}, "", a); flat(next ?? {}, "", b);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => stableStringify(a.get(k) ?? null) !== stableStringify(b.get(k) ?? null)).map((path) => ({ path, previous: a.get(path) ?? null, new: b.get(path) ?? null }));
}

export function applyPricingSubmission(prior: EstimatorPricing | undefined, sub: PricingSubmission, viewer: Viewer, email: string, nowIso: string, reason: string, quoteType: string): ApplyResult {
  if (!canEnterPricingInputs(viewer)) return { ok: false, errors: ["Only an Estimator or Manager who can see costs can enter or change pricing inputs."] };
  if (reason.trim().length < 3) return { ok: false, errors: ["Say why the pricing is being changed (it is kept with the revision)."] };
  if (quoteType !== "project") return { ok: false, errors: ["Supplier pricing applies to project quotations only."] };
  const rules = selectRuleVersion(sub.ruleVersionId);
  if (!rules.ok) return { ok: false, errors: [rules.error] };
  const skuKeys = Object.keys(sub.skus);
  if (skuKeys.length === 0) return { ok: false, errors: ["Enter at least one supplier cost."] };
  if (skuKeys.length > MAX_PRICED_SKUS) return { ok: false, errors: [`At most ${MAX_PRICED_SKUS} SKUs can be priced.`] };
  const bad = skuKeys.filter((k) => !SKU.test(k));
  if (bad.length) return { ok: false, errors: [`Not a valid SKU: ${bad.slice(0, 3).join(", ")}.`] };

  const skus: EstimatorPricing["skus"] = {};
  for (const [k, v] of Object.entries(sub.skus)) skus[k] = keepOrStamp<SkuPricingInput>(v as NoStamp<SkuPricingInput>, prior?.skus[k], email, nowIso)!;
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
    lines: Object.entries(next.skus).map(([sku, s]) => { const { freight, by: _b, at: _a, ...cost } = s!; void _b; void _a; return { key: sku, label: sku, sku, quantity: 1, cost, freight }; }),
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
  if (reason.trim().length < 3) return { ok: false, errors: ["Say why the pricing is being switched off."] };
  if (!prior) return { ok: false, errors: ["Supplier pricing is not switched on for this quotation."] };
  return { ok: true, kind: "DISABLED", next: null, changes: diffPricing(prior, null) };
}

/** The stored pricing as the form edits it: every input, without the server's attribution (which is decided again on save). */
export function submissionFrom(p: EstimatorPricing): PricingSubmission {
  const strip = <T extends { by?: string; at?: string }>(x: T): Omit<T, "by" | "at"> => { const { by: _b, at: _a, ...rest } = x; void _b; void _a; return rest; };
  return {
    ruleVersionId: p.ruleVersionId,
    skus: Object.fromEntries(Object.entries(p.skus).map(([k, v]) => [k, strip(v!)])) as PricingSubmission["skus"],
    fxQuotes: structuredClone(p.fxQuotes) as PricingSubmission["fxQuotes"],
    forwardCover: Object.fromEntries(Object.entries(p.forwardCover).map(([k, v]) => [k, strip(v!)])) as PricingSubmission["forwardCover"],
    skuPriceOverrides: Object.fromEntries(Object.entries(p.skuPriceOverrides).map(([k, v]) => [k, { unitPriceCents: v!.unitPriceCents, reason: v!.reason }])),
    projectMarkup: p.projectMarkup ? { markupBps: p.projectMarkup.markupBps, reason: p.projectMarkup.reason } : null,
    targetAdjustment: p.targetAdjustment ? { targetTotalCents: p.targetAdjustment.targetTotalCents, reason: p.targetAdjustment.reason } : null,
  };
}
