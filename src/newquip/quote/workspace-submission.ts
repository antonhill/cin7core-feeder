// What the focused product editor types, and how it becomes ONE change to the stored supplier-pricing submission. Pure: no React, no I/O, no pricing arithmetic (the model prices; this only
// parses typed text exactly and merges one product's inputs onto the CURRENT stored pricing). Validation here only says what is missing in plain words; the server and the Phase 1 model
// remain the authority and re-check everything.

import { cost7, emptySubmission, formatCost7, fromMicro, LEGACY_RULE_VERSION, micro, type PricingSubmission } from "@/newquip/pricing/estimator";

export interface ForwardCoverEditor { rateText: string; coverDaysText: string; reference: string; validFrom: string; validUntil: string; reason: string }
export interface SkuEditor {
  supplierName: string;
  currency: string;
  costText: string;
  source: string;
  freightFactorText: string;
  addOnText: string;
  freightSource: string;
  fxMode: "spot" | "forward";
  spotRateText: string;
  spotSource: string;
  forward: ForwardCoverEditor;
  override: { on: boolean; priceText: string; reason: string };
}

export type CostParse = { kind: "empty" } | { kind: "ok"; value: number } | { kind: "bad"; message: string };
/** A typed supplier cost: the exact value in units of 1e-7, nothing, or the reason it is refused. Never rounds or truncates. */
export function parseCostText(text: string): CostParse {
  const t = text.trim();
  if (t === "") return { kind: "empty" };
  try { return { kind: "ok", value: cost7(t) }; } catch (e) {
    if (/^\d+\.\d{8,}$/.test(t)) return { kind: "bad", message: "At most 7 decimal places are allowed (Cin7 supplies up to 7). Nothing is rounded: shorten or correct the value." };
    if (e instanceof Error && /too large/.test(e.message)) return { kind: "bad", message: "That cost is too large." };
    return { kind: "bad", message: "Enter the cost as a plain number such as 6.5454755 (digits and one decimal point, no commas or units)." };
  }
}
const toMicro = (s: string): number | null => { try { return s.trim() === "" ? null : micro(s.trim()); } catch { return null; } };
const toCents = (s: string): number | null => { const n = Number(s.replace(/\s/g, "").replace(",", ".")); return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dec = (m: number | null | undefined): string => (m == null ? "" : String(fromMicro(m)));

export function blankEditor(currency = "ZAR"): SkuEditor {
  return { supplierName: "", currency, costText: "", source: "", freightFactorText: "1", addOnText: "", freightSource: "", fxMode: "spot", spotRateText: "", spotSource: "", forward: { rateText: "", coverDaysText: "90", reference: "", validFrom: "", validUntil: "", reason: "" }, override: { on: false, priceText: "", reason: "" } };
}
/** The editor's starting values for one SKU, read from the stored submission (so reopening an editor shows exactly what was saved). */
export function editorFrom(current: PricingSubmission | null, sku: string): SkuEditor {
  const s = current?.skus[sku];
  const e = blankEditor(s?.currency ?? "ZAR");
  if (!s) return e;
  e.supplierName = s.supplierName ?? ""; e.costText = formatCost7(s.nativeUnitCostE7); e.source = s.source;
  e.freightFactorText = dec(s.freight?.factorMicro ?? 1_000_000); e.addOnText = s.freight?.addOnCents ? (s.freight.addOnCents / 100).toFixed(2) : ""; e.freightSource = s.freight?.source ?? "";
  const fc = current?.forwardCover[s.currency], spot = current?.fxQuotes[s.currency];
  if (fc) { e.fxMode = "forward"; e.forward = { rateText: dec(fc.rateMicro), coverDaysText: String(fc.coverDays), reference: fc.reference ?? "", validFrom: fc.validFrom ?? "", validUntil: fc.validUntil ?? "", reason: fc.reason }; }
  if (spot) { e.spotRateText = dec(spot.rateMicro); e.spotSource = spot.source; }
  const ov = current?.skuPriceOverrides[sku];
  if (ov) e.override = { on: true, priceText: (ov.unitPriceCents / 100).toFixed(2), reason: ov.reason };
  return e;
}
export const isForeign = (currency: string): boolean => /^[A-Z]{3}$/.test(currency) && currency !== "ZAR";

/** Rates are stored PER CURRENCY: which other products use this currency, and whether a forward-cover contract is already in force for it. */
export function fxContext(current: PricingSubmission | null, sku: string, currency: string): { others: string[]; hasForward: boolean } {
  const others = Object.entries(current?.skus ?? {}).filter(([k, v]) => k !== sku && v?.currency === currency).map(([k]) => k).sort();
  return { others, hasForward: !!current?.forwardCover[currency] };
}

/** Plain-language problems that stop a save. Empty = the editor can be saved. `fx` says who else shares this currency's rate (see fxContext). */
export function editorProblems(e: SkuEditor, fx: { others: string[]; hasForward: boolean } = { others: [], hasForward: false }): string[] {
  const p: string[] = [];
  const c = parseCostText(e.costText);
  if (c.kind === "empty") p.push("Enter the supplier cost.");
  else if (c.kind === "bad") p.push(c.message);
  else if (c.value <= 0) p.push("A zero cost is not a cost. Enter the quoted cost.");
  if (!/^[A-Z]{3}$/.test(e.currency)) p.push("Choose a three-letter currency such as ZAR, USD or EUR.");
  if (e.source.trim().length < 3) p.push("Say where this cost comes from (a supplier quote or Cin7 price).");
  const f = toMicro(e.freightFactorText);
  if (f === null || f <= 0) p.push("Enter the freight factor as a number above zero (1 means none).");
  if (e.addOnText.trim() !== "" && toCents(e.addOnText) === null) p.push("Enter the fixed add-on as a rand amount, or leave it empty.");
  if (isForeign(e.currency)) {
    if (e.fxMode === "spot") {
      if (fx.hasForward && fx.others.length > 0) p.push(`A forward-cover contract is in force for ${e.currency} and also prices ${fx.others.join(", ")}. Keep using it here, or have it removed from those products first: this form never deletes another product's forward cover.`);
      const r = toMicro(e.spotRateText);
      if (r === null || r <= 0) p.push(`Enter the ${e.currency} spot rate.`);
      if (e.spotSource.trim().length < 3) p.push(`Say where the ${e.currency} rate comes from.`);
    } else {
      const r = toMicro(e.forward.rateText), d = Number(e.forward.coverDaysText);
      if (r === null || r <= 0) p.push("Enter the forward-cover rate.");
      if (!Number.isInteger(d) || d < 1 || d > 366) p.push("Enter the cover period in days (1 to 366).");
      if (e.forward.reference.trim().length < 3) p.push("Enter the forward-cover contract reference.");
      if (!isDate(e.forward.validFrom) || !isDate(e.forward.validUntil)) p.push("Enter the contract validity dates as YYYY-MM-DD.");
      if (e.forward.reason.trim().length < 3) p.push("Say why the forward-cover rate applies.");
    }
  }
  if (e.override.on) {
    const c2 = toCents(e.override.priceText);
    if (c2 === null || c2 <= 0) p.push("Enter the overriding selling price above zero.");
    if (e.override.reason.trim().length < 3) p.push("Say why the selling price is overridden.");
  }
  return p;
}

/** The stored submission with exactly this product's inputs applied. `currentRule` is only used when pricing was off (the first save switches the model on). Returns null when the editor has problems. */
export function applyEditor(current: PricingSubmission | null, sku: string, e: SkuEditor, nowIso: string): PricingSubmission | null {
  const sub = structuredClone(current ?? emptySubmission(LEGACY_RULE_VERSION.id));
  if (editorProblems(e, fxContext(current, sku, e.currency)).length > 0) return null;
  const prior = sub.skus[sku];
  const cost = parseCostText(e.costText) as { kind: "ok"; value: number };
  sub.skus[sku] = {
    supplierId: prior?.supplierId ?? null, supplierName: e.supplierName.trim() || null, currency: e.currency, nativeUnitCostE7: cost.value, source: e.source.trim(),
    freight: { factorMicro: toMicro(e.freightFactorText)!, ...(e.addOnText.trim() !== "" && toCents(e.addOnText)! > 0 ? { addOnCents: toCents(e.addOnText)! } : {}), source: e.freightSource.trim() || e.source.trim() },
  };
  if (isForeign(e.currency)) {
    if (e.fxMode === "spot") {
      const rate = toMicro(e.spotRateText)!;
      const stored = sub.fxQuotes[e.currency];
      sub.fxQuotes[e.currency] = stored && stored.rateMicro === rate && stored.source === e.spotSource.trim() ? stored : { rateMicro: rate, source: e.spotSource.trim(), asOf: nowIso };
      if (fxContext(current, sku, e.currency).others.length === 0) delete sub.forwardCover[e.currency]; // only when no other product relies on it
    } else {
      sub.forwardCover[e.currency] = { rateMicro: toMicro(e.forward.rateText)!, coverDays: Number(e.forward.coverDaysText), reference: e.forward.reference.trim(), validFrom: e.forward.validFrom, validUntil: e.forward.validUntil, reason: e.forward.reason.trim() };
    }
  }
  if (e.override.on) sub.skuPriceOverrides[sku] = { unitPriceCents: toCents(e.override.priceText)!, reason: e.override.reason.trim() };
  else delete sub.skuPriceOverrides[sku];
  return sub;
}
/** The deterministic revision reason for a workspace save. */
export const revisionReason = (what: string): string => `Estimator workspace: ${what}`.slice(0, 500);

// ── a preview of ONE product's result, computed by the existing pricing model (never by this file) ───────────────────────────────────────────────────────────────────────────────────────
import { pricingForSku, type EstimatorPricing } from "@/newquip/pricing/estimator";
import { marginFigures, type MarginFigures } from "@/lib/projects/margin-figures";

export interface LinePreview { status: string; landedCents: number | null; priceCents: number | null; lineRevenueCents: number | null; margin: MarginFigures | null; issues: string[] }
/** What the model says this product would price at if the typed inputs were saved. Null when the inputs are not complete enough to price. */
export function previewLine(sub: PricingSubmission | null, sku: string, quantity: number, nowIso: string): LinePreview | null {
  if (!sub || !sub.skus[sku]) return null;
  const st = { by: "preview", at: nowIso };
  const stamp = <T extends object>(m: Record<string, T | undefined>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ? { ...v, ...st } : v]));
  const p = { enabled: true, ruleVersionId: sub.ruleVersionId, pricingDate: nowIso, revision: 0, skus: stamp(sub.skus), fxQuotes: sub.fxQuotes, forwardCover: stamp(sub.forwardCover), skuPriceOverrides: stamp(sub.skuPriceOverrides), projectMarkup: sub.projectMarkup ? { ...sub.projectMarkup, ...st } : null, targetAdjustment: sub.targetAdjustment ? { ...sub.targetAdjustment, ...st } : null } as unknown as EstimatorPricing;
  const r = pricingForSku(p, sku);
  const l = r?.lines[0];
  if (!l) return null;
  const priced = l.status === "priced" && l.unitPriceCents != null && l.unitPriceCents > 0;
  const rev = priced && quantity > 0 ? Math.round(l.unitPriceCents! * quantity) : null;
  const cost = priced && l.unitLandedCostCents != null && quantity > 0 ? Math.round(l.unitLandedCostCents * quantity) : null;
  return { status: l.status, landedCents: l.unitLandedCostCents ?? null, priceCents: priced ? l.unitPriceCents : null, lineRevenueCents: rev, margin: rev !== null && cost !== null ? marginFigures(rev, cost) : null, issues: (l.issues ?? []).map((x: { message: string }) => x.message.replace(`${sku}: `, "")) };
}
