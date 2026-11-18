// BUDGET -> FINAL VARIANCE ATTRIBUTION (pure; INTERNAL, cost-bearing: Estimator / Manager only). It compares the saved draft a Budget Quotation was built from with the quotation as it stands now (typically the
// approved one) and splits the difference, line by line, into WHY it moved. It prices nothing itself: every step is the EXISTING calculation (evaluateDraft) run on a draft that has had ONE more group of inputs
// moved from its budget value to its final value, so the steps always add up exactly to the total difference:
//   1 specification   product mappings, package confirmations, configuration and quantities
//   2 supplier costs  the Cin7 / Estimator cost of each product (new or changed supplier evidence)
//   3 fx              exchange rates
//   4 freight         freight factors and add-ons
//   5 markup          the project markup
//   6 other           everything else: price overrides, target adjustment, charges (delivery, installation, commissioning), unit prices, price resolutions
import type { QuoteDraft } from "@/newquip/grower/draft";
import { evaluateDraft, type EvaluationContext } from "@/newquip/grower/evaluate";
import type { EstimatorPricing } from "./estimator/types";

export const VARIANCE_STEPS = ["specification", "supplier_costs", "fx", "freight", "markup", "other"] as const;
export type VarianceStep = (typeof VARIANCE_STEPS)[number];
export const VARIANCE_LABEL: Record<VarianceStep, string> = { specification: "Product specification", supplier_costs: "Supplier costs", fx: "Exchange rates", freight: "Freight", markup: "Markup", other: "Other adjustments (price overrides, charges, manual prices)" };

export interface VarianceLine { key: string; label: string; budgetExVat: number | null; finalExVat: number | null; deltaExVat: number; byStep: Record<VarianceStep, number>; budgetStatus: string; finalStatus: string }
export interface VarianceReport { lines: VarianceLine[]; totals: { budgetExVat: number; finalExVat: number; deltaExVat: number; byStep: Record<VarianceStep, number> } }

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const zeroSteps = (): Record<VarianceStep, number> => ({ specification: 0, supplier_costs: 0, fx: 0, freight: 0, markup: 0, other: 0 });

type Row = { revenue: number; status: string; label: string };
function evaluateRows(draft: QuoteDraft, ctx: EvaluationContext): { rows: Map<string, Row>; subtotal: number } {
  const b = evaluateDraft(draft, { ...ctx, withholdCost: false, provisionalPackages: true }).budget;
  const rows = new Map<string, Row>();
  for (const l of b?.lines ?? []) if (l.status !== "not_selected") rows.set(l.itemKey, { revenue: l.status === "priced" ? (l.revenueExTax ?? 0) : 0, status: l.provisional ? "provisional" : l.status, label: l.label });
  for (const c of b?.charges ?? []) rows.set(`charge:${c.key}`, { revenue: c.amountExTax ?? 0, status: c.status, label: c.label });
  return { rows, subtotal: b?.totals.subtotalExTax ?? 0 };
}

const withPricing = (d: QuoteDraft, f: (p: EstimatorPricing) => void): QuoteDraft => { const x = structuredClone(d); if (x.estimator.pricing) f(x.estimator.pricing); return x; };

/** The budget draft with each group of inputs moved, in order, to its value in the final draft. The LAST state is the final draft's own inputs, so the steps sum to the full difference. */
export function varianceStates(budget: QuoteDraft, final: QuoteDraft): QuoteDraft[] {
  const fp = final.estimator.pricing;
  const s1 = structuredClone(budget); s1.config = structuredClone(final.config); s1.quoteType = final.quoteType; s1.estimator.confirmedMappings = structuredClone(final.estimator.confirmedMappings); s1.estimator.confirmedPackages = [...final.estimator.confirmedPackages]; s1.estimator.templateRevision = final.estimator.templateRevision;
  const s2 = withPricing(s1, (p) => {
    for (const [sku, fin0] of Object.entries(fp?.skus ?? {})) {
      const fin = fin0!;
      const cur = p.skus[sku];
      p.skus[sku] = cur ? { ...cur, supplierId: fin.supplierId, supplierName: fin.supplierName, currency: fin.currency, nativeUnitCostE7: fin.nativeUnitCostE7, source: fin.source, costKind: fin.costKind, costDate: fin.costDate, currencySource: fin.currencySource, ...(fin.review ? { review: fin.review } : {}) } : structuredClone(fin);
    }
    for (const [cur, q] of Object.entries(fp?.fxQuotes ?? {})) if (!p.fxQuotes[cur]) p.fxQuotes[cur] = structuredClone(q);
  });
  const s3 = withPricing(s2, (p) => { p.fxQuotes = structuredClone(fp?.fxQuotes ?? {}); });
  const s4 = withPricing(s3, (p) => { for (const [sku, fin] of Object.entries(fp?.skus ?? {})) if (p.skus[sku] && fin) p.skus[sku] = { ...p.skus[sku], freight: structuredClone(fin.freight) }; });
  const s5 = withPricing(s4, (p) => { p.projectMarkup = fp?.projectMarkup ? structuredClone(fp.projectMarkup) : null; });
  const s6 = structuredClone(final);
  return [structuredClone(budget), s1, s2, s3, s4, s5, s6];
}

export function attributeVariance(budget: QuoteDraft, final: QuoteDraft, ctx: EvaluationContext): VarianceReport {
  const states = varianceStates(budget, final).map((d) => evaluateRows(d, ctx));
  const keys = new Set<string>(); for (const s of states) for (const k of s.rows.keys()) keys.add(k);
  const lines: VarianceLine[] = [...keys].map((key) => {
    const byStep = zeroSteps();
    VARIANCE_STEPS.forEach((step, i) => { byStep[step] = round2((states[i + 1].rows.get(key)?.revenue ?? 0) - (states[i].rows.get(key)?.revenue ?? 0)); });
    const first = states[0].rows.get(key), last = states[6].rows.get(key);
    return { key, label: (last ?? first)!.label, budgetExVat: first && first.revenue > 0 ? round2(first.revenue) : null, finalExVat: last && last.revenue > 0 ? round2(last.revenue) : null, deltaExVat: round2((last?.revenue ?? 0) - (first?.revenue ?? 0)), byStep, budgetStatus: first?.status ?? "absent", finalStatus: last?.status ?? "absent" };
  });
  const totalsByStep = zeroSteps(); for (const l of lines) for (const s of VARIANCE_STEPS) totalsByStep[s] = round2(totalsByStep[s] + l.byStep[s]);
  return { lines, totals: { budgetExVat: round2(states[0].subtotal), finalExVat: round2(states[6].subtotal), deltaExVat: round2(states[6].subtotal - states[0].subtotal), byStep: totalsByStep } };
}
