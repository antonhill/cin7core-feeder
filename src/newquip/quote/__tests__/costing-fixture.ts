import type { QuoteDraft } from "../../grower/draft";
import { evaluateDraft, type EvaluationContext } from "../../grower/evaluate";
import { commercialLinesOf } from "../baseline";
import { buildPhysicalScope } from "../physical-scope";
import { effectiveScope } from "@/lib/projects/product-scope";

/**
 * REAL complete costing for a fixture: captures a supplier cost for every physical SKU of the draft's scope (the same derivation the costing gate and the baseline use),
 * with no incomplete-cost exception. `skip` leaves chosen SKUs uncosted. Returns the draft and the SKUs it costed.
 */
export function withCapturedSupplierCosts(draft: QuoteDraft, ctx: EvaluationContext, skip: readonly string[] = []): { draft: QuoteDraft; skus: string[] } {
  const d = structuredClone(draft);
  delete d.estimator.costBasis;
  const ev = evaluateDraft(d, { ...ctx, withholdCost: false });
  const eff = effectiveScope(buildPhysicalScope(commercialLinesOf(ev.budget!)));
  const skus = [...new Set(eff.lines.map((l) => l.sku))].filter((s) => !skip.includes(s));
  d.estimator.physicalCosts = Object.fromEntries(skus.map((sku) => [sku, { unitCostCents: 1000, source: "MANUAL_ESTIMATE" as const, retrievedAt: "2026-01-01T00:00:00.000Z", reason: "fixture supplier cost", by: "est@nq", at: "2026-01-01T00:00:00.000Z" }]));
  return { draft: d, skus: eff.lines.map((l) => l.sku) };
}
