import { evaluateDraft, type QuoteEvaluation } from "../../../grower/evaluate";
import { readyDraft } from "../../../grower/__tests__/golden";
import { TEST_SNAPSHOT, testPriceSource } from "../../../grower/__tests__/test-snapshot";
import type { QuoteDraft } from "../../../grower/draft";
import { micro, cost7 } from "../../model";
import type { EstimatorPricing, ManualPriceEvidence, SkuPricingInput } from "../types";
import { manualPriceHash, skuLessManualItems } from "../manual-evidence";
import { costInputHash } from "../verification";

export const AT = "2026-11-12T08:00:00.000Z";
export const EST = "estimator@example.test";
export const REVIEWER = "reviewer@example.test";
export const evalOf = (d: QuoteDraft, withholdCost = false): QuoteEvaluation => evaluateDraft(d, { priceSource: testPriceSource(), withholdCost });

/**
 * Supplier inputs that are EQUIVALENT to the synthetic POC snapshot: the same landed cost, but expressed as a native supplier cost in EUR, USD or ZAR at a rate.
 * (cost x roe x freight in the snapshot == native x rate x freight here), so a draft priced by the model must equal the legacy draft to the cent.
 */
export function equivalentInputs(over: Partial<EstimatorPricing> = {}, verification: "verified" | "unverified" = "verified"): EstimatorPricing {
  const skus: Record<string, SkuPricingInput> = {};
  const order = ["ZAR", "EUR", "USD"] as const;
  Object.values(TEST_SNAPSHOT.entries).filter((e) => e.cost > 0).forEach((e, i) => {
    const currency = order[i % 3];
    const rate = currency === "ZAR" ? 1 : 20;
    const entry: SkuPricingInput = {
      supplierId: `sup-${currency}`, supplierName: `${currency} Supplier`, currency, nativeUnitCostE7: cost7(String(e.cost / rate)),
      source: "Fixture supplier sheet", freight: { factorMicro: micro(String(e.freight)), source: "Fixture" }, by: EST, at: AT,
    };
    // "verified" = an INDEPENDENT review (a different person from the one who entered it) of exactly this cost
    skus[e.sku] = verification === "verified" ? { ...entry, review: { by: REVIEWER, at: AT, evidence: "Supplier quote SQ-FIXTURE", inputHash: costInputHash(entry) } } : entry;
  });
  // SKU-less manual items (LED lighting, penning) are priced by the Estimator with no SKU: "verified" inputs also carry their recorded pricing evidence.
  const manualEvidence: Record<string, ManualPriceEvidence> = {};
  if (verification === "verified") for (const it of skuLessManualItems(evalOf(readyDraft()).budget)) manualEvidence[it.itemKey] = { note: "Fixture pricing basis", by: EST, at: AT, priceHash: manualPriceHash(it) };
  return {
    enabled: true, ruleVersionId: "legacy-poc-v1", pricingDate: AT, revision: 1, skus, ...(Object.keys(manualEvidence).length ? { manualEvidence } : {}),
    fxQuotes: { EUR: { rateMicro: micro("20"), source: "Fixture spot", asOf: AT }, USD: { rateMicro: micro("20"), source: "Fixture spot", asOf: AT } },
    forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null,
    ...over,
  };
}
export const withPricing = (p: EstimatorPricing, base: QuoteDraft = readyDraft()): QuoteDraft => ({ ...base, estimator: { ...base.estimator, pricing: p } });
export const lineOf = (ev: QuoteEvaluation, key: string) => ev.budget!.lines.find((l) => l.itemKey === key)!;

/** What a reviewer submits: each SKU with the hash of the exact cost they were looking at. */
export const itemsOf = (p: EstimatorPricing | undefined, skus: readonly string[]) => skus.map((sku) => ({ sku, costHash: p && Object.prototype.hasOwnProperty.call(p.skus, sku) && p.skus[sku] ? costInputHash(p.skus[sku]!) : "unknown" }));

/** What an Estimator submits to record pricing evidence for every SKU-less manual item currently on the draft (LED lighting, penning, M75 ...). */
export const evidenceItemsFor = (d: QuoteDraft, note = "Basis: written quote Q-100 for this item") => skuLessManualItems(evalOf(d).budget).map((i) => ({ itemKey: i.itemKey, note }));
