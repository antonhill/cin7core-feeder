// A documented Budget basis (door BOM cost, fixed panel price) cannot be FINAL without a recorded pricing-evidence note bound to its CURRENT price; a changed door size or panel selection makes the evidence outdated again.
// Neutral fixture amounts only.
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../../../grower/draft";
import { evaluateDraft } from "../../../grower/evaluate";
import { DOOR_SIZES } from "../../../grower/door-sizes";
import { UAT_PROVISIONAL_ENV, uatProvisionalRatesFromEnv } from "../../../grower/uat-provisional-basis";
import { createWorkbookPriceSource } from "../../../grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../../../grower/snapshot";
import { nqQ0002 } from "../../../grower/__tests__/nq-q-0002-fixture";
import { applyManualEvidence, EVIDENCE_STATE_TEXT, skuLessManualItems } from "../manual-evidence";
import { pricingFinality } from "../finality";
import type { EstimatorPricing } from "../types";
import { AT, EST } from "./helpers";

const rates = uatProvisionalRatesFromEnv({ [UAT_PROVISIONAL_ENV]: JSON.stringify({ [`pvc_door|${DOOR_SIZES["2.1x1.2"].specification}`]: { amount: 8000, asOf: "2026-11-24" }, [`pvc_door|${DOOR_SIZES["2.1x1.0"].specification}`]: { amount: 7500, asOf: "2026-11-24" } }) });
const pricing = (): EstimatorPricing => ({ enabled: true, ruleVersionId: "legacy-poc-v1", pricingDate: AT, revision: 1, skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: { markupBps: 2000, reason: "fixture", by: EST, at: AT } as never, targetAdjustment: null });
const draft = (size: string, p: EstimatorPricing): QuoteDraft => {
  const d = structuredClone(nqQ0002()) as QuoteDraft & { config: Record<string, unknown> };
  d.config.doorSize = size as never;
  d.config.optionalEquipment = { ...(d.config.optionalEquipment as object), controller: true, control_panel: true } as never;
  d.config.estimatorQuantities = { ...(d.config.estimatorQuantities as object), control_panel: 2 } as never;
  d.estimator.confirmedPackages = ["pvc_door", "control_panel"] as never; d.estimator.pricing = p;
  return d;
};
const budgetOf = (d: QuoteDraft) => evaluateDraft(d, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false, budgetAsOf: "2026-11-26", uatProvisionalRates: rates }).budget!;
const reasonsFor = (d: QuoteDraft) => pricingFinality(d.estimator.pricing, budgetOf(d), AT).reasons;
const record = (d: QuoteDraft): EstimatorPricing => { const r = applyManualEvidence(d.estimator.pricing, budgetOf(d), skuLessManualItems(budgetOf(d)).filter((i) => i.pricedBy === "budget_rate").map((i) => ({ itemKey: i.itemKey, note: "Documented basis checked against the supplied BOM sheet" })), { roles: new Set(["rep", "estimator"]), canSeeCost: true } as never, EST, AT); if (!r.ok) throw new Error(r.errors.join()); return r.next; };

describe("pricing evidence gates a documented Budget basis (supplier pricing on)", () => {
  it("confirmed but with no evidence: NOT final, naming both lines (never a price)", () => {
    const rs = reasonsFor(draft("2.1x1.2", pricing())).join("\n");
    expect(rs).toContain(EVIDENCE_STATE_TEXT.missing);
    expect(rs).toMatch(/door/i); expect(rs).toMatch(/control panel/i);
    expect(rs).not.toMatch(/\bR ?\d/);
  });
  it("once the Estimator records the evidence for both, neither is a reason", () => {
    const d = draft("2.1x1.2", pricing()); d.estimator.pricing = record(d);
    const rs = reasonsFor(d).join("\n");
    expect(rs).not.toMatch(/door/i); expect(rs).not.toMatch(/control panel/i);
  });
  it("a later change of door size (a different price) makes the recorded evidence outdated again", () => {
    const d = draft("2.1x1.2", pricing()); d.estimator.pricing = record(d);
    (d.config as unknown as Record<string, unknown>).doorSize = "2.1x1.0";
    const rs = reasonsFor(d).join("\n");
    expect(rs).toContain(EVIDENCE_STATE_TEXT.outdated);
    expect(rs).toMatch(/door/i); expect(rs).not.toMatch(/control panel/i);
  });
  it("a Rep or hand-off evaluation (nothing confirmed) prices neither line", () => {
    const d = draft("2.1x1.2", pricing()); d.estimator.confirmedPackages = [] as never;
    const b = budgetOf(d);
    for (const k of ["pvc_door", "control_panel"]) expect(b.lines.find((l) => l.itemKey === k)!.status).not.toBe("priced");
  });
});
