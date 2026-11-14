import { describe, expect, it } from "vitest";
import { emptyDraft, type QuoteDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { applyMappingLibrary, effectiveScope } from "@/lib/projects/product-scope";
import { buildAcceptedBaseline, commercialLinesOf, type BaselineCommercialLine } from "../baseline";
import { buildPhysicalScope } from "../physical-scope";

// An explicit R0.00 charge is not a commercial charge line: it must not reach the sealed baseline (and so no project or invoice line); a positive charge is carried exactly as before.
const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false };
const base = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const lines = commercialLinesOf(evaluateDraft(base, ctx).budget!);
const LIB = new Map([["led_light", { packageKey: "led_light", version: 1, lines: [{ sku: "TEST-FORTIS-LED", factor: 1, unit: "each", role: "FINISHED_GOOD" as const }] }]]);
const scopeOf = (ls: readonly BaselineCommercialLine[]) => applyMappingLibrary(buildPhysicalScope(ls), LIB, "2026-11-03T00:00:00.000Z");
const costs = Object.fromEntries(effectiveScope(scopeOf(lines)).lines.map((l) => [l.sku, { unitCostCents: 1000, source: "MANUAL_ESTIMATE" as const, retrievedAt: "t", reason: "r" }]));
const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "rep@a", estimatorSignoffBy: "est@a", estimatorSignoffAt: "t", managerApprovedBy: "mgr@a", managerApprovedAt: "2026-11-03T10:00:00.000Z" };
const freezeWith = (charges: QuoteDraft["estimator"]["charges"]) => {
  const draft = { ...base, estimator: { ...base.estimator, charges, physicalCosts: costs } } as QuoteDraft;
  return buildAcceptedBaseline({ quoteRef: "NQ-Q-1", revision: 2, draft, evaluation: evaluateDraft(draft, ctx), mappingLibrary: LIB as never, approvals, baselineException: { reason: "Estimator-priced by design; mapping follows the PO", draftHash: "h" } as never });
};

describe("sealed baseline and explicit zero charges", () => {
  it("omits a zero charge, keeps a positive one with the same entry", () => {
    const zero = freezeWith({ ...base.estimator.charges, delivery: 0, installation: 0 }).baseline.commercial.charges;
    expect(zero.map((c) => c.key)).not.toContain("delivery");
    expect(zero.map((c) => c.key)).not.toContain("installation");
    const pos = freezeWith({ ...base.estimator.charges, delivery: 250_000, installation: 0 }).baseline.commercial.charges;
    expect(pos.find((c) => c.key === "delivery")).toEqual({ key: "delivery", label: "Delivery", amountCents: 25_000_000 });
    expect(pos.map((c) => c.key)).not.toContain("installation");
  });
});
