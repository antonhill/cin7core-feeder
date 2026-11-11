import { describe, expect, it } from "vitest";
import { readyDraft } from "../../grower/__tests__/golden";
import { compareToIndicative, type ComparisonInput } from "../comparison";
import { stampChanges } from "../change-stamps";
import type { QuoteDraft } from "../../grower/draft";
import { cloneDraft, evalOf, snapshotOf } from "./helpers";

const CAPTURED = "2026-11-12T07:00:00.000Z";
const WHEN = "2026-11-12T08:30:00.000Z";
const input = (original: QuoteDraft, current: QuoteDraft, over: Partial<ComparisonInput> = {}): ComparisonInput => ({
  snapshot: snapshotOf(original).snapshot, snapshotCapturedAt: CAPTURED, snapshotCapturedBy: "rep@x", confirmedCents: null, confirmedAt: null, confirmedBy: null,
  revision: 1, draft: current, currentEvaluation: evalOf(current, false), ...over,
});
/** The Estimator's edit as the server would store it: with its change stamps. */
const edit = (base: QuoteDraft, mutate: (d: QuoteDraft) => void, email = "est@x"): QuoteDraft =>
  stampChanges(cloneDraft(mutate, base), base, { state: "ESTIMATOR_REVIEW", revision: 1, email, nowIso: WHEN });

describe("original indicative price versus current price", () => {
  it("nothing changed: zero difference, no changed rows", () => {
    const d = readyDraft();
    const c = compareToIndicative(input(d, d));
    expect(c.basis).toBe("snapshot");
    expect(c.deltaCents).toBe(0);
    expect(c.originalTotalCents).toBe(c.currentTotalCents);
    expect(c.rows.filter((r) => r.changed)).toEqual([]);
    expect(c.basisChanges).toEqual([]);
  });
  it("an Estimator-entered charge: correct delta, the row, the reason placeholder and WHO and WHEN", () => {
    const base = readyDraft();
    const cur = edit(base, (d) => { d.estimator.charges.installation = 450_000; }); // was 400_000
    const c = compareToIndicative(input(base, cur));
    const row = c.rows.find((r) => r.key === "charge:installation")!;
    expect(row.changed).toBe(true);
    expect(row.deltaCents).toBe(5_000_000); // charge amounts are in rands: 450,000 - 400,000 = R50,000.00 = 5,000,000 cents
    expect(row.changes).toEqual([{ label: "Charge: installation", by: "est@x", at: WHEN }]);
    expect(row.reasons).toEqual(["No reason recorded"]);
    expect(c.deltaCents).toBe(5_000_000);
    expect(c.recordedChanges.map((x) => x.by)).toEqual(["est@x"]);
  });
  it("a price resolution carries its own recorded reason and its server-stamped actor", () => {
    const base = readyDraft();
    const cur = cloneDraft((d) => { d.estimator.priceResolutions.led_light = { unitPriceExVat: 1100, reason: "Supplier re-quoted after the site visit", by: "est@x", at: WHEN }; }, base);
    const c = compareToIndicative(input(base, cur));
    const row = c.rows.find((r) => r.key === "led_light")!;
    expect(row.changed).toBe(true);
    expect(row.reasons).toEqual(["Estimator price: Supplier re-quoted after the site visit"]);
    expect(row.changes).toEqual([{ label: "Estimator price", by: "est@x", at: WHEN }]);
    expect(row.deltaCents).toBeGreaterThan(0);
  });
  it("the per-row deltas explain the total difference (to within per-line cent rounding)", () => {
    const base = readyDraft();
    const cur = edit(base, (d) => { d.estimator.charges.installation = 123_456; d.config.estimatorQuantities!.feeder = 20; d.estimator.priceResolutions.led_light = { unitPriceExVat: 1234, reason: "r", by: "e", at: WHEN }; });
    const c = compareToIndicative(input(base, cur));
    const sum = c.rows.reduce((n, r) => n + r.deltaCents, 0);
    expect(Math.abs(sum - c.deltaCents!)).toBeLessThanOrEqual(c.rows.length);
    expect(c.rows.filter((r) => r.changed).length).toBeGreaterThanOrEqual(3);
  });
  it("a line that lost its price reads NOT PRICED now (never R0), is attributed, and its revenue leaves the total", () => {
    const base = readyDraft();
    const cur = edit(base, (d) => { delete d.estimator.confirmedMappings.pvc_door; });
    const c = compareToIndicative(input(base, cur));
    const row = c.rows.find((r) => r.key === "pvc_door")!;
    expect(row.original!.revenueCents).toBeGreaterThan(0);
    expect(row.current!.revenueCents).toBeNull();
    expect(row.current!.unitPriceExVat).toBeNull();
    expect(row.deltaCents).toBe(-row.original!.revenueCents!);
    expect(row.changes[0]).toMatchObject({ by: "est@x" });
    expect(c.currentCompleteness).toBe("provisional");
    expect(c.originalCompleteness).toBe("complete");
  });
  it("a figure that moved with no recorded edit is shown with NO attribution (not invented)", () => {
    const base = readyDraft();
    const cur = cloneDraft((d) => { d.estimator.charges.installation = 1_000_000; }, base); // not stamped
    const row = compareToIndicative(input(base, cur)).rows.find((r) => r.key === "charge:installation")!;
    expect(row.changed).toBe(true);
    expect(row.changes).toEqual([]);
  });
  it("stamps from another revision, or from before the snapshot, are not attributed to this handoff", () => {
    const base = readyDraft();
    const cur = cloneDraft((d) => { d.estimator.charges.installation = 1_000_000; d.estimator.changeStamps = { "charges.installation": { by: "old@x", at: WHEN, rev: 7 }, "charges.delivery": { by: "early@x", at: "2026-11-12T06:00:00.000Z", rev: 1 } }; }, base);
    const c = compareToIndicative(input(base, cur));
    expect(c.rows.find((r) => r.key === "charge:installation")!.changes).toEqual([]);
    expect(c.recordedChanges).toEqual([]);
  });
  it("a change of the calculation BASIS (price source / rules / quotation type) is surfaced even when nobody edited the quote", () => {
    const base = readyDraft();
    const snap = snapshotOf(base).snapshot;
    const tampered = structuredClone(snap);
    tampered.internal.priceSource = { ...tampered.internal.priceSource, provenance: "Older price file dated 2026-09-01" };
    tampered.internal.ruleSet = { ...tampered.internal.ruleSet, version: "grower-house-v0.old" };
    const c = compareToIndicative(input(base, base, { snapshot: tampered }));
    expect(c.basisChanges.join(" ")).toMatch(/Pricing rules changed.*grower-house-v0\.old/);
    expect(c.basisChanges.join(" ")).toMatch(/price source changed/i);
  });
  it("a quotation handed off before capture existed falls back to the customer-confirmed amount only, and says line detail is unavailable", () => {
    const d = readyDraft();
    const c = compareToIndicative(input(d, d, { snapshot: null, confirmedCents: 860_954_240, confirmedAt: CAPTURED, confirmedBy: "rep@x" }));
    expect(c.basis).toBe("amount_only");
    expect(c.rows).toEqual([]);
    expect(c.deltaCents).toBe(0);
    expect(c.note).toMatch(/Line-by-line comparison is not possible/);
  });
  it("a quotation never handed off has nothing to compare", () => {
    const d = readyDraft();
    const c = compareToIndicative(input(d, d, { snapshot: null }));
    expect(c.basis).toBe("none");
    expect(c.deltaCents).toBeNull();
  });
  it("the comparison never carries a cost: no cost, margin, ROE, freight or markup field or wording in its output", () => {
    const base = readyDraft();
    const c = compareToIndicative(input(base, edit(base, (d) => { d.estimator.charges.installation = 450_000; })));
    expect(JSON.stringify(c)).not.toMatch(/estimatedCost|margin|roe\b|freight|markup|landed/i);
  });
});
