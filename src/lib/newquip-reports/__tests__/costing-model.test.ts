import { describe, expect, it } from "vitest";
import { costingRowOf, costingTotals, type CostingRow, type CostingSource } from "../costing-model";
import { emptyDraft } from "@/newquip/grower/draft";
import type { MarginSheet } from "@/newquip/quote/margin";

const sheet = (over: Partial<MarginSheet["project"]> = {}, lines: MarginSheet["lines"] = []): MarginSheet => ({
  reportingBasis: "x", costPolicy: "y", lines, sections: [{ section: "Delivery & installation", lineCount: 1, incomplete: false, sellingCents: 5_000, costCents: 4_000, gpCents: 1_000, marginPct: 20, markupPct: 25 }],
  project: { sellingCents: 100_000, costCents: 80_000, gpCents: 20_000, marginPct: 20, markupPct: 25, incomplete: false, missingCostLines: [], uncostedChargesCents: 0, contractSellingCents: 100_000, ...over },
});
const src = (o: Partial<CostingSource>): CostingSource => ({ id: "q1", quote_ref: "NQ-Q-1", revision: 1, customer_name: "C", state: "MANAGER_APPROVED_FINAL", draft: emptyDraft(), accepted_baseline: null, created_at: "2026-11-01T00:00:00Z", ...o });

describe("costing row: the engine's own figures, never recomputed", () => {
  it("an approved quotation reports the margin FROZEN at approval, unchanged", () => {
    const r = costingRowOf(src({ accepted_baseline: { internalMargin: sheet() } }), 0);
    expect(r).toMatchObject({ basis: "APPROVED", sellingCents: 100_000, costCents: 80_000, gpCents: 20_000, marginPct: 20, markupPct: 25, deliveryInstallCents: 5_000, incomplete: false, exceptions: [] });
  });
  it("an approved quotation with no frozen sheet is UNAVAILABLE: it is not re-derived from today's costs", () => {
    const r = costingRowOf(src({ accepted_baseline: null }), null);
    expect(r).toMatchObject({ basis: "UNAVAILABLE", costCents: null, gpCents: null, marginPct: null }); expect(r.exceptions[0]).toMatch(/not re-derived/);
  });
  it("incomplete costing is flagged with the missing-line count and unmapped products; margin is not invented", () => {
    const r = costingRowOf(src({ accepted_baseline: { internalMargin: sheet({ incomplete: true, costCents: null, gpCents: null, marginPct: null, markupPct: null, missingCostLines: ["Feeder", "Tank"] }) } }), 3);
    expect(r).toMatchObject({ incomplete: true, costCents: null, marginPct: null, lines: { missing: 2 } });
    expect(r.exceptions).toEqual(expect.arrayContaining(["Incomplete costing: 2 line(s) without a cost", "3 unmapped product(s)"]));
  });
  it("manual estimates are counted from the engine's line basis", () => {
    const line = (costBasis: "PROVISIONAL" | "OVERRIDE" | "VERIFIED" | null) => ({ itemKey: "feeder", label: "F", kind: "PRODUCT" as const, section: "Feeding", sellingCents: 10, costCents: 5, gpCents: 5, marginPct: 50, markupPct: 100, costBasis });
    const r = costingRowOf(src({ accepted_baseline: { internalMargin: sheet({}, [line("OVERRIDE"), line("OVERRIDE"), line("VERIFIED"), line("PROVISIONAL")]) } }), 0);
    expect(r.lines).toMatchObject({ override: 2, verified: 1, provisional: 1 }); expect(r.manualEstimates).toBe(2); expect(r.exceptions.join()).toMatch(/manual Estimator estimate/);
  });
});

describe("totals", () => {
  const row = (o: Partial<CostingRow>): CostingRow => ({ id: "x", quoteRef: "x", revision: 1, customer: "", state: "ESTIMATOR_REVIEW", basis: "VERIFIED", href: "", createdAt: "", sellingCents: 100, costCents: 60, gpCents: 40, marginPct: 40, markupPct: 66.67, deliveryInstallCents: null, uncostedChargesCents: 0, incomplete: false, lines: null, unverifiedSupplierCosts: 0, freightUnspecified: 0, fxOverrideCurrencies: [], skuPriceOverrides: 0, projectMarkupOverride: false, manualEstimates: 0, unmapped: 0, costExceptionAccepted: false, exceptions: [], ...o });
  it("margin covers only fully costed quotations; incomplete ones are reported as exposure, never blended in", () => {
    const t = costingTotals([row({ id: "a" }), row({ id: "b", sellingCents: 300, costCents: 180, gpCents: 120 }), row({ id: "c", sellingCents: 1000, costCents: null, gpCents: null, marginPct: null, incomplete: true, basis: "INDICATIVE", exceptions: ["Incomplete costing: 1 line(s) without a cost"] })]);
    expect(t).toMatchObject({ quotations: 3, sellingCents: 1400, costedSellingCents: 400, costCents: 240, gpCents: 160, marginPct: 40, exposureCents: 1000, withExceptions: 1 });
  });
  it("an empty set is zeros with an unknown margin", () => { expect(costingTotals([])).toMatchObject({ quotations: 0, sellingCents: 0, marginPct: null, exposureCents: 0 }); });
  it("an unavailable row is neither costed nor hidden", () => {
    const t = costingTotals([row({ basis: "UNAVAILABLE", costCents: null, gpCents: null, marginPct: null, incomplete: null, sellingCents: null })]);
    expect(t.unavailable).toBe(1); expect(t.exposureCents).toBe(0);
  });
});
