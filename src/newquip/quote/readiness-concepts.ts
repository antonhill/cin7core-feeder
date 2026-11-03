import type { QuoteDraft } from "../grower/draft";
import type { QuoteEvaluation } from "../grower/evaluate";
import type { Readiness } from "../grower/readiness";
import { buildMarginSheet } from "./margin";
import { commercialLinesOf } from "./baseline";
import { buildPhysicalScope } from "./physical-scope";
import { applyMappingLibrary, effectiveScope, type LibraryMapping } from "@/lib/projects/product-scope";
import { buildCostEstimate } from "@/lib/projects/latest-cost";

// THE THREE READINESS CONCEPTS (UX-006 owner correction). They are DERIVED values, never persisted statuses and never migrations:
//
//   REP_CONFIGURATION_READY    the Rep has entered everything only a Rep can supply (customer, site, valid engineering inputs, quantities and override reasons,
//                              Rep-owned charges and the M75 price, pig size). Gates the Rep -> Estimator handoff. Says NOTHING about mappings or costs.
//   ESTIMATOR_COSTING_COMPLETE the Estimator has resolved every product mapping / package / supplier-quote / manual-price exception AND every cost is known
//                              (or an authorised incomplete-cost exception is recorded). Gates Estimator sign-off.
//   MANAGER_APPROVAL_READY     everything above, plus the Estimator signed off THIS content and the customer-confirmed amount still equals the total. Gates approval.
//
// `readiness.state` / `readiness.reasons` are unchanged and still mean "everything is resolved" (the full READY): sign-off and approval keep using them.

export interface ConceptStatus { ready: boolean; reasons: string[] }

/** REP_CONFIGURATION_READY: only the Rep-owned reasons. */
export function repConfigurationReady(r: Pick<Readiness, "repReasons">): ConceptStatus {
  return { ready: r.repReasons.length === 0, reasons: [...r.repReasons] };
}

/** What is still waiting on an Estimator / Manager (mappings, package confirmation, supplier quotes, source prices). */
export function estimatorOpenItems(r: Pick<Readiness, "estimatorReasons">): { count: number; reasons: string[] } {
  return { count: r.estimatorReasons.length, reasons: [...r.estimatorReasons] };
}

export interface CostingStatus { complete: boolean; reasons: string[] }

/**
 * ESTIMATOR_COSTING_COMPLETE. Evaluate the draft with cost VISIBLE server-side and pass the result here; only this boolean / reason list may travel to a caller who
 * may not see cost (the reasons name counts and SKUs of lines, never a cost or margin value).
 *
 * Complete means: no Estimator-owned exception remains, every priced line has a known cost (the margin sheet's project total is complete), and the physical-SKU
 * cost estimate (supplier costs, captured by the cost actions) covers every SKU of the physical scope. An authorised, recorded `incompleteAccepted` exception on
 * the draft waives only the COST part (never an unresolved mapping or price) - the same exception the baseline freeze honours.
 */
export function estimatorCostingComplete(draft: QuoteDraft, costEvaluation: QuoteEvaluation, library?: ReadonlyMap<string, LibraryMapping>, asOfIso: string = new Date().toISOString()): CostingStatus {
  const reasons: string[] = [...costEvaluation.readiness.estimatorReasons];
  const b = costEvaluation.budget;
  const cost: string[] = [];
  if (!b) cost.push("Costing cannot be assessed until the configuration is valid.");
  else {
    const lines = commercialLinesOf(b);
    const scope = buildPhysicalScope(lines);
    const eff = effectiveScope(library && library.size ? applyMappingLibrary(scope, library, asOfIso) : scope);
    if (eff.lines.length > 0 || eff.blockers.length > 0) {
      const est = buildCostEstimate(eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity })), draft.estimator.physicalCosts ?? {}, eff.blockers);
      if (est.incomplete) {
        // Only catalogue / physical SKUs with no supplier cost count. Items with no Cin7 SKU because the Estimator prices them by design (M75, penning, a manual
        // price) are resolved PRICING, not an unresolved supplier cost; the baseline freeze keeps its own, stricter package rule.
        if (est.missingSkus.length) cost.push(`The cost estimate is incomplete: ${est.missingSkus.length} SKU(s) have no supplier cost selected (${est.missingSkus.slice(0, 5).join(", ")}${est.missingSkus.length > 5 ? ", ..." : ""}).`);
      }
    }
    try {
      const sheet = buildMarginSheet(b, draft.estimator.costOverrides ?? {});
      // Lines the Estimator prices by design (excluded from margin: M75, penning, manual prices) legitimately carry no cost: they do not count as missing.
      const byDesign = new Set(b.lines.filter((l) => l.pricedBy === "estimator_input" || l.pricedBy === "penning_rate" || l.pricedBy === "estimator_resolution").map((l) => l.itemKey as string));
      const missing = sheet.lines.filter((l) => l.costCents === null && !byDesign.has(l.itemKey)).map((l) => l.label);
      if (missing.length) cost.push(`Project margin not available: ${missing.length} line(s) have no cost (${missing.slice(0, 5).join("; ")}${missing.length > 5 ? "; ..." : ""}).`);
    } catch (e) {
      cost.push(`A cost override is invalid: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  if (!draft.estimator.costBasis?.incompleteAccepted) reasons.push(...cost);
  return { complete: reasons.length === 0, reasons };
}
