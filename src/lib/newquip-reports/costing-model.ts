// NewQuip Reports: the COMMERCIALLY SENSITIVE costing row. Only the server loader for Estimator / Manager viewers ever calls this; a Sales Rep path never imports,
// calls or receives anything from here. Every figure comes from the quotation engine's own functions (evaluateDraft -> buildMarginSheet, the frozen internalMargin at
// approval, pricingFinality): there is NO second profitability formula in this file.
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { buildMarginSheet, type MarginSheet } from "@/newquip/quote/margin";
import { pricingFinality } from "@/newquip/pricing/estimator/finality";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { QuoteState } from "./ops";

export type MarginBasis = "APPROVED" | "VERIFIED" | "COSTED_UNVERIFIED" | "INDICATIVE" | "UNAVAILABLE";
export const MARGIN_BASIS_LABEL: Record<MarginBasis, string> = {
  APPROVED: "Approved (frozen at Manager approval)", VERIFIED: "Costed and verified", COSTED_UNVERIFIED: "Costed, not yet verified", INDICATIVE: "Indicative (costing incomplete)", UNAVAILABLE: "Unavailable",
};

export interface CostingSource {
  id: string; quote_ref: string; revision: number; customer_name: string; state: QuoteState; draft: QuoteDraft; accepted_baseline: Pick<AcceptedBaseline, "internalMargin"> | null; created_at: string;
}
export interface CostingRow {
  id: string; quoteRef: string; revision: number; customer: string; state: QuoteState; basis: MarginBasis; href: string; createdAt: string;
  sellingCents: number | null; costCents: number | null; gpCents: number | null; marginPct: number | null; markupPct: number | null;
  deliveryInstallCents: number | null; uncostedChargesCents: number | null; incomplete: boolean | null;
  lines: { provisional: number; override: number; verified: number; missing: number } | null;
  unverifiedSupplierCosts: number | null; freightUnspecified: number | null; fxOverrideCurrencies: string[]; skuPriceOverrides: number; projectMarkupOverride: boolean; manualEstimates: number | null;
  unmapped: number | null; costExceptionAccepted: boolean;
  exceptions: string[];
}

const sheetOf = (s: CostingSource): { sheet: MarginSheet | null; frozen: boolean } => {
  const frozen = s.state === "MANAGER_APPROVED_FINAL" ? s.accepted_baseline?.internalMargin ?? null : null;
  if (frozen) return { sheet: frozen, frozen: true };
  if (s.state === "MANAGER_APPROVED_FINAL") return { sheet: null, frozen: true }; // an approved quotation with no frozen margin sheet: never re-derived from today's costs
  try {
    const b = evaluateDraft(s.draft, evaluationContext(false)).budget;
    return { sheet: b ? buildMarginSheet(b, s.draft.estimator.costOverrides ?? {}) : null, frozen: false };
  } catch { return { sheet: null, frozen: false }; }
};

/** `unmapped` = the count of physical products with no mapping (from the scope view; null when it could not be read). */
export function costingRowOf(s: CostingSource, unmapped: number | null): CostingRow {
  const { sheet, frozen } = sheetOf(s);
  const pricing = s.draft.estimator.pricing;
  const fin = (() => { try { const b = evaluateDraft(s.draft, evaluationContext(false)).budget; return pricingFinality(pricing, b); } catch { return null; } })();
  const base = {
    id: s.id, quoteRef: s.quote_ref, revision: s.revision, customer: s.customer_name, state: s.state, href: `/newquip-grower/${s.id}`, createdAt: s.created_at,
    fxOverrideCurrencies: pricing?.enabled ? Object.keys(pricing.forwardCover ?? {}).filter((k) => pricing.forwardCover[k]).sort() : [],
    skuPriceOverrides: pricing?.enabled ? Object.values(pricing.skuPriceOverrides ?? {}).filter(Boolean).length : 0,
    projectMarkupOverride: !!(pricing?.enabled && pricing.projectMarkup),
    unverifiedSupplierCosts: fin ? fin.reasons.filter((r) => /indicative only|manual price/.test(r)).length : null,
    freightUnspecified: fin ? fin.reasons.filter((r) => /freight/i.test(r)).length : null,
    unmapped, costExceptionAccepted: !!s.draft.estimator.costBasis?.incompleteAccepted,
  };
  if (!sheet) return { ...base, basis: "UNAVAILABLE", sellingCents: null, costCents: null, gpCents: null, marginPct: null, markupPct: null, deliveryInstallCents: null, uncostedChargesCents: null, incomplete: null, lines: null, manualEstimates: null, exceptions: [frozen ? "Approved, but no frozen margin sheet is recorded: not re-derived from current costs" : "Margin cannot be derived for this quotation"] };
  const p = sheet.project;
  const lines = { provisional: 0, override: 0, verified: 0, missing: 0 };
  for (const l of sheet.lines) { if (l.costBasis === "PROVISIONAL") lines.provisional++; else if (l.costBasis === "OVERRIDE") lines.override++; else if (l.costBasis === "VERIFIED") lines.verified++; }
  lines.missing = p.missingCostLines.length;
  const di = sheet.sections.find((x) => x.section === "Delivery & installation");
  const basis: MarginBasis = s.state === "MANAGER_APPROVED_FINAL" ? "APPROVED" : p.incomplete ? "INDICATIVE" : fin?.final ? "VERIFIED" : "COSTED_UNVERIFIED";
  const exceptions: string[] = [];
  if (p.incomplete) exceptions.push(`Incomplete costing: ${lines.missing} line(s) without a cost`);
  if ((base.unverifiedSupplierCosts ?? 0) > 0) exceptions.push(`${base.unverifiedSupplierCosts} supplier cost(s) unverified`);
  if (lines.provisional > 0 && s.state !== "MANAGER_APPROVED_FINAL") exceptions.push(`${lines.provisional} line(s) on estimated or historical cost`);
  if (lines.override > 0) exceptions.push(`${lines.override} line(s) on a manual Estimator estimate`);
  if ((base.freightUnspecified ?? 0) > 0) exceptions.push("Freight / landed-cost assumption not recorded");
  if ((unmapped ?? 0) > 0) exceptions.push(`${unmapped} unmapped product(s)`);
  if (base.costExceptionAccepted) exceptions.push("Incomplete costing accepted by exception");
  return {
    ...base, basis, sellingCents: p.sellingCents, costCents: p.costCents, gpCents: p.gpCents, marginPct: p.marginPct, markupPct: p.markupPct,
    deliveryInstallCents: di ? di.sellingCents : null, uncostedChargesCents: p.uncostedChargesCents, incomplete: p.incomplete, lines, manualEstimates: lines.override, exceptions,
  };
}

export interface CostingTotals {
  quotations: number; sellingCents: number; costedSellingCents: number; costCents: number; gpCents: number; marginPct: number | null; unavailable: number;
  byBasis: Array<{ basis: MarginBasis; label: string; count: number }>; exposureCents: number; withExceptions: number;
}
/** Totals are built ONLY from the rows' own engine figures. GP / margin cover quotations whose cost is complete; the rest are reported as exposure, never blended in. */
export function costingTotals(rows: readonly CostingRow[]): CostingTotals {
  const complete = rows.filter((r) => r.incomplete === false && r.costCents != null && r.sellingCents != null);
  const costedSelling = complete.reduce((n, r) => n + (r.sellingCents ?? 0), 0); const cost = complete.reduce((n, r) => n + (r.costCents ?? 0), 0);
  const counts = new Map<MarginBasis, number>(); for (const r of rows) counts.set(r.basis, (counts.get(r.basis) ?? 0) + 1);
  return {
    quotations: rows.length, sellingCents: rows.reduce((n, r) => n + (r.sellingCents ?? 0), 0), costedSellingCents: costedSelling, costCents: cost, gpCents: costedSelling - cost,
    marginPct: costedSelling > 0 ? Math.round(((costedSelling - cost) / costedSelling) * 10000) / 100 : null, unavailable: rows.filter((r) => r.basis === "UNAVAILABLE").length,
    byBasis: [...counts.entries()].map(([basis, count]) => ({ basis, label: MARGIN_BASIS_LABEL[basis], count })).sort((a, b) => b.count - a.count),
    exposureCents: rows.filter((r) => r.incomplete !== false).reduce((n, r) => n + (r.sellingCents ?? 0), 0), withExceptions: rows.filter((r) => r.exceptions.length > 0).length,
  };
}
