import type { MarginFigures } from "@/lib/projects/margin-figures";
import type { BudgetQuote } from "../../grower/quote-bridge";
import { figures, type CalculatedLine, type RateUsed } from "../model";
import { internalAdjustmentView, type InternalAdjustmentView } from "./adjustment";
import { pricingFinality, type PricingFinality } from "./finality";
import { pricingForSku } from "./price-source";
import type { EstimatorPricing } from "./types";

// THE ESTIMATOR PRICING WORKSPACE, as data (NQ-008B Phase 2). Pure: a quotation's evaluation (cost visible) + its pricing inputs + the original indicative price in, a view-model
// out. INTERNAL ONLY: it carries supplier costs, rates, freight, markup and margin, so the server builds it for a cost-entitled Estimator/Manager and for nobody else. The screen
// only renders it; it does no arithmetic of its own.

export interface SkuNeed { sku: string; quantity: number; usedBy: string[] }
export interface SkuRow {
  sku: string; usedBy: string[]; quantity: number;
  /** "priced" | "no_input" (no supplier cost entered: the line is NOT priced) | "not_priced" (an input exists but cannot be priced, e.g. a rate is missing). */
  status: "priced" | "no_input" | "not_priced";
  supplier: string | null; currency: string | null; nativeUnitCostMicro: number | null; costSource: string | null; verification: "verified" | "unverified" | null;
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
  currencies: { currency: string; spot: { rateMicro: number; source: string; asOf: string } | null; forwardCover: { rateMicro: number; coverDays: number; reason: string; reference?: string; by: string; at: string } | null }[];
  totals: WorkspaceTotals;
  /** The Rep-confirmed indicative total (the latest NQ-008A snapshot) against the current total. */
  indicative: { originalTotalCents: number | null; currentTotalCents: number | null; deltaCents: number | null; capturedAt: string | null };
  adjustment: InternalAdjustmentView | null;
  finality: PricingFinality;
  /** Plain-language things the Estimator must resolve (no cost values). */
  attention: string[];
}

export function skuNeedsOf(budget: BudgetQuote | null): SkuNeed[] {
  const m = new Map<string, SkuNeed>();
  const add = (sku: string | null, qty: number | null, label: string) => { if (!sku) return; const n = m.get(sku) ?? { sku, quantity: 0, usedBy: [] }; n.quantity += qty ?? 0; if (!n.usedBy.includes(label)) n.usedBy.push(label); m.set(sku, n); };
  for (const l of budget?.lines ?? []) {
    if (l.status === "not_selected" || l.pricedBy === "penning_rate" || l.pricedBy === "estimator_input" || l.pricedBy === "estimator_resolution") continue;
    if (l.components) for (const c of l.components) { if (c.status !== "reference_only") add(c.sku, c.quantity, l.label); } else add(l.sku, l.quantity, l.label);
  }
  return [...m.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

export function buildPricingWorkspace(i: {
  quoteType: string; pricing: EstimatorPricing | undefined; budget: BudgetQuote | null; originalTotalCents: number | null; originalCapturedAt: string | null;
}): PricingWorkspaceView {
  const p = i.pricing;
  const needs = skuNeedsOf(i.budget);
  const skuSet = new Set([...needs.map((n) => n.sku), ...Object.keys(p?.skus ?? {})]);
  const rows: SkuRow[] = [...skuSet].sort().map((sku) => {
    const need = needs.find((n) => n.sku === sku);
    const input = p?.skus[sku];
    const r = p && input ? pricingForSku(p, sku) : null;
    const l = r?.lines[0];
    const qty = need?.quantity ?? 0;
    const ov = p?.skuPriceOverrides[sku] ?? null;
    const priced = !!l && l.status === "priced" && l.unitPriceCents !== null;
    const unit = priced ? l!.unitPriceCents : null;
    const rev = unit !== null && qty > 0 ? Math.round(unit * qty) : null;
    const cost = priced && l!.unitLandedCostCents !== null && qty > 0 ? Math.round(l!.unitLandedCostCents * qty) : null;
    return {
      sku, usedBy: need?.usedBy ?? [], quantity: qty,
      status: !input ? "no_input" : priced ? "priced" : "not_priced",
      supplier: input?.supplierName ?? null, currency: input?.currency ?? null, nativeUnitCostMicro: input?.nativeUnitCostMicro ?? null, costSource: input?.source ?? null, verification: input?.verification ?? null,
      rate: l?.rate ?? null, freightFactorMicro: input?.freight?.factorMicro ?? null, freightAddOnCents: input?.freight?.addOnCents ?? null,
      unitLandedCostCents: l?.unitLandedCostCents ?? null, calculatedUnitPriceCents: l?.calculatedUnitPriceCents ?? null, unitPriceCents: unit, priceOrigin: l?.priceOrigin ?? null,
      priceOverride: ov ? { unitPriceCents: ov.unitPriceCents, reason: ov.reason, by: ov.by, at: ov.at } : null,
      lineRevenueCents: rev, lineCostCents: cost, margin: rev !== null ? figures(rev, cost) : null,
      issues: (l?.issues ?? []).map((x) => x.message.replace(`${sku}: `, "")),
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
    forwardCover: p?.forwardCover[currency] ? { rateMicro: p.forwardCover[currency]!.rateMicro, coverDays: p.forwardCover[currency]!.coverDays, reason: p.forwardCover[currency]!.reason, reference: p.forwardCover[currency]!.reference, by: p.forwardCover[currency]!.by, at: p.forwardCover[currency]!.at } : null,
  }));
  const finality = pricingFinality(p, i.budget);
  const attention: string[] = [];
  for (const r of rows) {
    if (r.status === "no_input") attention.push(`${r.sku}: no supplier cost entered, so it is not priced.`);
    else if (r.status === "not_priced") attention.push(`${r.sku}: cannot be priced yet (${r.issues[0] ?? "check the rate and cost"}).`);
  }
  attention.push(...finality.reasons.map((x) => x.replace(" This cannot be waived by the incomplete-costing exception.", "")));
  const current = totalCents;
  return {
    enabled: !!p?.enabled, available: i.quoteType === "project",
    ruleVersionId: p?.ruleVersionId ?? null, revision: p?.revision ?? 0, pricingDate: p?.pricingDate ?? null,
    markup: { bps: p ? (p.projectMarkup?.markupBps ?? null) : null, changedBy: p?.projectMarkup ? { by: p.projectMarkup.by, at: p.projectMarkup.at, reason: p.projectMarkup.reason } : null },
    rows, currencies,
    totals: { totalCents, pricedSubtotalCents: Math.round((t?.subtotalExTax ?? 0) * 100), costOnCostedLinesCents: costOnCosted, costedRevenueCents: costedRevenue, margin: costedRevenue > 0 ? figures(costedRevenue, costOnCosted) : null, priceComplete },
    indicative: { originalTotalCents: i.originalTotalCents, currentTotalCents: current, deltaCents: i.originalTotalCents !== null && current !== null ? current - i.originalTotalCents : null, capturedAt: i.originalCapturedAt },
    adjustment: internalAdjustmentView(p, { totalCents: current, costCents: costOnCosted, costComplete: priceComplete && costedRevenue === current }),
    finality, attention: [...new Set(attention)],
  };
}
