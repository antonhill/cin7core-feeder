import { describe, expect, it } from "vitest";
import { readyDraft } from "../../grower/__tests__/golden";
import { emptyDraft } from "../../grower/draft";
import { hashOf } from "../../quote/baseline";
import { buildIndicativeSnapshot, repViewOf } from "../indicative-snapshot";
import { cloneDraft, evalOf, snapshotOf } from "./helpers";

describe("the indicative snapshot", () => {
  it("records the total, completeness, rule version and price-source identity as indexed facts", () => {
    const { snapshot, index, hash } = snapshotOf(readyDraft());
    expect(index.totalExVatCents).toBe(Math.round(8609542.4 * 100));
    expect(index.completeness).toBe("complete");
    expect(index.rulesetId).toBe("newquip-grower-pricing");
    expect(index.rulesetVersion).toMatch(/^grower-house-v1/);
    expect(index.priceSourceId).toBeTruthy();
    expect(index.priceSourceFingerprint).toBeTruthy();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashOf(snapshot));
    expect(snapshot.internal.ruleSet.projectMarkupPctOnLandedCost).toBe(20); // the existing rule, reconstructable from the record
  });
  it("is deterministic: the same quotation captured twice gives the same hash", () => {
    expect(snapshotOf(readyDraft()).hash).toBe(snapshotOf(readyDraft()).hash);
  });
  it("the Rep's section carries no cost, margin, ROE, freight, markup or landed-cost wording or figure; the cost lives only in `internal`", () => {
    const { snapshot } = snapshotOf(readyDraft());
    expect(JSON.stringify(repViewOf(snapshot))).not.toMatch(/cost|margin|roe|freight|markup|landed|mu\b|workbook/i);
    expect(JSON.stringify(snapshot.internal)).toMatch(/estimatedCostCents/);
    expect(snapshot.internal.estimatedCostCents).toBe(334195200);
  });
  it("a line that is not priced is recorded as NOT PRICED (null), never as R0; completeness is provisional and says what is outstanding", () => {
    const d = cloneDraft((x) => { x.estimator.confirmedMappings = {}; x.estimator.priceResolutions = {}; });
    const { snapshot } = snapshotOf(d);
    const unpriced = snapshot.customerSafe.lines.filter((l) => l.status !== "priced" && l.status !== "not_selected");
    expect(unpriced.length).toBeGreaterThan(0);
    for (const l of unpriced) { expect(l.revenueCents).toBeNull(); expect(l.unitPriceExVat).toBeNull(); }
    expect(snapshot.customerSafe.completeness).toBe("provisional");
    expect(snapshot.customerSafe.awaiting.length).toBeGreaterThan(0);
    const pricedSum = snapshot.customerSafe.lines.reduce((n, l) => n + (l.revenueCents ?? 0), 0) + snapshot.customerSafe.charges.reduce((n, c) => n + (c.amountCents ?? 0), 0);
    expect(Math.abs(pricedSum - snapshot.customerSafe.subtotalCents)).toBeLessThanOrEqual(snapshot.customerSafe.lines.length + snapshot.customerSafe.charges.length); // rounding only
  });
  it("refuses to capture when nothing is priced, and when the cost-visible evaluation disagrees with what the Rep saw", () => {
    expect(() => buildIndicativeSnapshot({ quoteRef: "x", revision: 1, draft: emptyDraft(), repEvaluation: { ...evalOf(emptyDraft(), true), budget: null }, internalEvaluation: evalOf(emptyDraft(), false) })).toThrow(/Nothing is priced/);
    const d = readyDraft();
    const other = cloneDraft((x) => { x.estimator.charges.installation = 1; }, d);
    expect(() => buildIndicativeSnapshot({ quoteRef: "x", revision: 1, draft: d, repEvaluation: evalOf(d, true), internalEvaluation: evalOf(other, false) })).toThrow(/does not match/);
  });
  it("is UNCHANGED by any later recalculation: editing the draft afterwards yields a different NEW snapshot and leaves the first byte-identical", () => {
    const d = readyDraft();
    const first = snapshotOf(d);
    const frozen = JSON.stringify(first.snapshot);
    const later = snapshotOf(cloneDraft((x) => { x.estimator.charges.installation = 9_999_999; x.estimator.priceResolutions = {}; }, d));
    expect(later.hash).not.toBe(first.hash);
    expect(JSON.stringify(first.snapshot)).toBe(frozen);
    expect(hashOf(first.snapshot)).toBe(first.hash);
  });
});
