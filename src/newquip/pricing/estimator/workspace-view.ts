import type { MarginFigures } from "@/lib/projects/margin-figures";
import type { BudgetQuote } from "../../grower/quote-bridge";
import { figures, type CalculatedLine, type RateUsed } from "../model";
import { internalAdjustmentView, type InternalAdjustmentView } from "./adjustment";
import { pricingFinality, type PricingFinality } from "./finality";
import { pricingForSku } from "./price-source";
import { RATE_STATE_TEXT, rateInputHash, rateStateOf, type RateState } from "./attestation";
import { EVIDENCE_STATE_TEXT, evidenceStateOf, skuLessManualItems, type EvidenceState } from "./manual-evidence";
import { COST_STATE_TEXT, costInputHash, costStateOf, type CostState } from "./verification";
import { LEGACY_RULE_VERSION, selectRuleVersion } from "../model";
import type { EstimatorPricing } from "./types";

// THE ESTIMATOR PRICING WORKSPACE, as data (NQ-008B Phase 2). Pure: a quotation's evaluation (cost visible) + its pricing inputs + the original indicative price in, a view-model
// out. INTERNAL ONLY: it carries supplier costs, rates, freight, markup and margin, so the server builds it for a cost-entitled Estimator/Manager and for nobody else. The screen
// only renders it; it does no arithmetic of its own.

/** A forward-cover rate and its INDEPENDENT attestation. `rateHash` identifies the exact rate shown: a reviewer submits it so a rate that changed since they opened it is never covered by mistake. */
export interface ForwardCoverView {
  rateMicro: number; coverDays: number; reason: string; reference?: string; validFrom?: string; validUntil?: string; by: string; at: string;
  state: RateState; stateText: string; rateHash: string; review: { by: string; at: string; evidence: string } | null;
}
export interface ManualEvidenceRow { itemKey: string; label: string; pricedBy: string; state: EvidenceState; stateText: string; note: string | null; reference: string | null; by: string | null; at: string | null }

export interface SkuNeed { sku: string; quantity: number; usedBy: string[]; /** The SKU's line carries a MANUAL selling price: its supplier cost still has to be recorded and verified. */ manual: boolean }
export interface SkuRow {
  sku: string; usedBy: string[]; quantity: number;
  /** "priced" | "no_input" (no supplier cost entered: the line is NOT priced) | "not_priced" (an input exists but cannot be priced, e.g. a rate is missing). */
  status: "priced" | "no_input" | "not_priced";
  supplier: string | null; currency: string | null; nativeUnitCostE7: number | null; costSource: string | null;
  /** COST verification (separate from price completeness): derived from an independent review, never from a flag a person set. */
  costState: CostState; costStateText: string;
  /** Who entered / last changed the cost, and the independent review of exactly that cost, if any. */
  enteredBy: string | null; enteredAt: string | null; review: { by: string; at: string; evidence: string } | null;
  /** What produced the SELLING price: the supplier-pricing model, an item price override, or a MANUAL price (which does not remove the need for a verified supplier cost). */
  priceBasis: "supplier_pricing" | "price_override" | "manual_price" | "none";
  /** Identifies the EXACT cost shown. A reviewer submits it with their verification so a cost that changed since they opened it can never be covered by mistake. */
  costHash: string | null;
  rate: RateUsed | null; freightFactorMicro: number | null; freightAddOnCents: number | null;
  unitLandedCostCents: number | null; calculatedUnitPriceCents: number | null; unitPriceCents: number | null; priceOrigin: CalculatedLine["priceOrigin"];
  priceOverride: { unitPriceCents: number; reason: string; by: string; at: string } | null;
  lineRevenueCents: number | null; lineCostCents: number | null; margin: MarginFigures | null;
  issues: string[];
}
export interface WorkspaceTotals { totalCents: number | null; pricedSubtotalCents: number; costOnCostedLinesCents: number; costedRevenueCents: number; margin: MarginFigures | null; priceComplete: boolean }
export interface PricingWorkspaceView {
  enabled: boolean;
  /** false: supplier pricing applies to project quotations only. */
  available: boolean;
  ruleVersionId: string | null; revision: number; pricingDate: string | null;
  markup: { bps: number | null; changedBy: { by: string; at: string; reason: string } | null };
  rows: SkuRow[];
  /** One row per supplier currency in use: the spot rate and the forward cover, if any. */
  currencies: { currency: string; spot: { rateMicro: number; source: string; asOf: string } | null; forwardCover: ForwardCoverView | null }[];
  /** SKU-less manual items (M75, LED lighting, penning, any manual item) and whether their pricing evidence is recorded. Cost-entitled viewers only (this whole view is). */
  manualEvidence: ManualEvidenceRow[];
  totals: WorkspaceTotals;
  /** The Rep-confirmed indicative total (the latest NQ-008A snapshot) against the current total. */
  indicative: { originalTotalCents: number | null; currentTotalCents: number | null; deltaCents: number | null; capturedAt: string | null };
  adjustment: InternalAdjustmentView | null;
  finality: PricingFinality;
  /** How many of the supplier costs this quotation relies on are independently verified (separate from whether every line has a price). */
  costs: { required: number; verified: number };
  /** Rate freshness per currency, judged at the time the view was built. */
  rates: { currency: string; spotAgeHours: number | null; spotExpired: boolean; maxAgeHours: number | null; forwardExpired: boolean }[];
  /** Plain-language things the Estimator must resolve (no cost values). */
  attention: string[];
}

/** Evidence state of each SKU-less manual item. Empty while supplier pricing is off (the legacy POC behaviour is unchanged). INTERNAL: the notes are for cost-entitled roles only. */
export function manualEvidenceRows(p: EstimatorPricing | undefined, budget: BudgetQuote | null): ManualEvidenceRow[] {
  if (!p?.enabled) return [];
  return skuLessManualItems(budget).map((it): ManualEvidenceRow => {
    const st = evidenceStateOf(it, p);
    const e = p.manualEvidence && Object.prototype.hasOwnProperty.call(p.manualEvidence, it.itemKey) ? p.manualEvidence[it.itemKey] : undefined;
    return { itemKey: it.itemKey, label: it.label, pricedBy: it.pricedBy, state: st, stateText: EVIDENCE_STATE_TEXT[st], note: e?.note ?? null, reference: e?.reference ?? null, by: e?.by ?? null, at: e?.at ?? null };
  });
}

export function skuNeedsOf(budget: BudgetQuote | null): SkuNeed[] {
  const m = new Map<string, SkuNeed>();
  const add = (sku: string | null, qty: number | null, label: string, manual: boolean) => { if (!sku) return; const n = m.get(sku) ?? { sku, quantity: 0, usedBy: [], manual }; n.quantity += qty ?? 0; n.manual = n.manual || manual; if (!n.usedBy.includes(label)) n.usedBy.push(label); m.set(sku, n); };
  for (const l of budget?.lines ?? []) {
    // Lines the Estimator prices by design (penning rate, M75) carry no supplier cost. A line with a MANUAL resolution price is different: it still needs its supplier cost.
    if (l.status === "not_selected" || l.pricedBy === "penning_rate" || l.pricedBy === "estimator_input") continue;
    const manual = l.pricedBy === "estimator_resolution";
    if (l.components) for (const c of l.components) { if (c.status !== "reference_only") add(c.sku, c.quantity, l.label, manual); } else add(l.sku, l.quantity, l.label, manual);
  }
  return [...m.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

export function buildPricingWorkspace(i: {
  quoteType: string; pricing: EstimatorPricing | undefined; budget: BudgetQuote | null; originalTotalCents: number | null; originalCapturedAt: string | null;
  /** The instant rate freshness is judged against (default: now). */
  nowIso?: string;
}): PricingWorkspaceView {
  const p = i.pricing;
  const nowIso = i.nowIso ?? new Date().toISOString();
  const sel = selectRuleVersion(p?.ruleVersionId ?? null);
  const rules = sel.ok ? sel.rules : LEGACY_RULE_VERSION;
  const needs = skuNeedsOf(i.budget);
  const skuSet = new Set([...needs.map((n) => n.sku), ...Object.keys(p?.skus ?? {})]);
  const rows: SkuRow[] = [...skuSet].sort().map((sku) => {
    const need = needs.find((n) => n.sku === sku);
    const input = p?.skus[sku];
    const r = p && input ? pricingForSku(p, sku) : null;
    const l = r?.lines[0];
    const qty = need?.quantity ?? 0;
    const ov = p?.skuPriceOverrides[sku] ?? null;
    // A zero price or zero landed cost is never a price (the price source says "supplier quote required"): the row must say so, never "priced R 0,00".
    const zero = !!l && l.status === "priced" && ((l.unitPriceCents ?? 0) <= 0 || (l.unitLandedCostCents ?? 0) <= 0);
    const priced = !!l && l.status === "priced" && l.unitPriceCents !== null && !zero;
    const unit = priced ? l!.unitPriceCents : null;
    const costState = costStateOf(input, rules);
    const rev = unit !== null && qty > 0 ? Math.round(unit * qty) : null;
    const cost = priced && l!.unitLandedCostCents !== null && qty > 0 ? Math.round(l!.unitLandedCostCents * qty) : null;
    return {
      sku, usedBy: need?.usedBy ?? [], quantity: qty,
      status: !input ? "no_input" : priced ? "priced" : "not_priced",
      supplier: input?.supplierName ?? null, currency: input?.currency ?? null, nativeUnitCostE7: input?.nativeUnitCostE7 ?? null, costSource: input?.source ?? null,
      costHash: input ? costInputHash(input) : null, costState, costStateText: COST_STATE_TEXT[costState], enteredBy: input?.by ?? null, enteredAt: input?.at ?? null,
      review: input?.review ? { by: input.review.by, at: input.review.at, evidence: input.review.evidence } : null,
      priceBasis: priced ? (ov ? "price_override" : "supplier_pricing") : need?.manual ? "manual_price" : "none",
      rate: l?.rate ?? null, freightFactorMicro: input?.freight?.factorMicro ?? null, freightAddOnCents: input?.freight?.addOnCents ?? null,
      unitLandedCostCents: zero ? null : (l?.unitLandedCostCents ?? null), calculatedUnitPriceCents: zero ? null : (l?.calculatedUnitPriceCents ?? null), unitPriceCents: unit, priceOrigin: zero ? null : (l?.priceOrigin ?? null),
      priceOverride: ov ? { unitPriceCents: ov.unitPriceCents, reason: ov.reason, by: ov.by, at: ov.at } : null,
      lineRevenueCents: rev, lineCostCents: cost, margin: rev !== null ? figures(rev, cost) : null,
      issues: [...(zero ? ["the supplier cost is zero, so a supplier quote is required (a zero price is never quoted)"] : []), ...(l?.issues ?? []).map((x) => x.message.replace(`${sku}: `, ""))],
    };
  });

  const t = i.budget?.totals;
  const priceComplete = !!i.budget && !i.budget.incomplete;
  const totalCents = i.budget && priceComplete ? Math.round(t!.subtotalExTax * 100) : null;
  const costOnCosted = Math.round((t?.estimatedCost ?? 0) * 100);
  const costedRevenue = Math.round((t?.marginRevenueExTax ?? 0) * 100);
  const currencies = [...new Set(Object.values(p?.skus ?? {}).map((s) => s!.currency).filter((c) => c !== "ZAR"))].sort().map((currency) => ({
    currency,
    spot: p?.fxQuotes[currency] ? { ...p.fxQuotes[currency]! } : null,
    forwardCover: p?.forwardCover[currency] ? ((f): ForwardCoverView => { const st = rateStateOf(currency, f, rules); return { rateMicro: f.rateMicro, coverDays: f.coverDays, reason: f.reason, reference: f.reference, validFrom: f.validFrom, validUntil: f.validUntil, by: f.by, at: f.at, state: st, stateText: RATE_STATE_TEXT[st], rateHash: rateInputHash(currency, f), review: f.review ? { by: f.review.by, at: f.review.at, evidence: f.review.evidence } : null }; })(p.forwardCover[currency]!) : null,
  }));
  const finality = pricingFinality(p, i.budget, nowIso);
  const attention: string[] = [];
  for (const r of rows) {
    if (r.status === "no_input" && r.priceBasis !== "manual_price") attention.push(`${r.sku}: no supplier cost entered, so it is not priced.`);
    else if (r.status === "not_priced") attention.push(`${r.sku}: cannot be priced yet (${r.issues[0] ?? "check the rate and cost"}).`);
  }
  attention.push(...finality.reasons.map((x) => x.replace(" This cannot be waived by the incomplete-costing exception.", "")));
  const current = totalCents;
  return {
    enabled: !!p?.enabled, available: i.quoteType === "project",
    ruleVersionId: p?.ruleVersionId ?? null, revision: p?.revision ?? 0, pricingDate: p?.pricingDate ?? null,
    markup: { bps: p ? (p.projectMarkup?.markupBps ?? null) : null, changedBy: p?.projectMarkup ? { by: p.projectMarkup.by, at: p.projectMarkup.at, reason: p.projectMarkup.reason } : null },
    rows, currencies,
    manualEvidence: manualEvidenceRows(p, i.budget),
    totals: { totalCents, pricedSubtotalCents: Math.round((t?.subtotalExTax ?? 0) * 100), costOnCostedLinesCents: costOnCosted, costedRevenueCents: costedRevenue, margin: costedRevenue > 0 ? figures(costedRevenue, costOnCosted) : null, priceComplete },
    indicative: { originalTotalCents: i.originalTotalCents, currentTotalCents: current, deltaCents: i.originalTotalCents !== null && current !== null ? current - i.originalTotalCents : null, capturedAt: i.originalCapturedAt },
    adjustment: internalAdjustmentView(p, { totalCents: current, costCents: costOnCosted, costComplete: priceComplete && costedRevenue === current }),
    finality, attention: [...new Set(attention)],
    costs: { required: rows.filter((r) => r.usedBy.length > 0).length, verified: rows.filter((r) => r.usedBy.length > 0 && r.costState === "verified").length },
    rates: currencies.map((c) => {
      const hours = c.spot ? (Date.parse(nowIso) - Date.parse(c.spot.asOf)) / 3_600_000 : null;
      const until = c.forwardCover && p?.forwardCover[c.currency]?.validUntil ? p.forwardCover[c.currency]!.validUntil! : null;
      const untilMs = until ? Date.parse(until) + (until.length <= 10 ? 86_400_000 - 1 : 0) : null;
      return { currency: c.currency, spotAgeHours: hours === null ? null : Math.round(hours * 10) / 10, spotExpired: !c.forwardCover && hours !== null && rules.spotRateMaxAgeHours !== null && hours > rules.spotRateMaxAgeHours, maxAgeHours: rules.spotRateMaxAgeHours, forwardExpired: untilMs !== null && Date.parse(nowIso) > untilMs };
    }),
  };
}
