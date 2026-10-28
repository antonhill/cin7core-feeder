import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../../grower/evaluate";
import { readyDraft } from "../../grower/__tests__/golden";
import { testPriceSource } from "../../grower/__tests__/test-snapshot";
import { assemblyUnitCost, buildMarginSheet, marginFigures, redactInternalFinancials, stampCostOverrides, validateCostOverride, type CostOverride } from "../margin";
import { buildAcceptedBaseline, baselineMatchesHash, hashOf } from "../baseline";
import { quoteToProjectBaseline } from "../to-project";
import { buildCustomerSummary } from "../../grower/customer-summary";

const ov = (lineCostCents: number, reason = "supplier quote"): CostOverride => ({ lineCostCents, reason, by: "est@x", at: "2026-10-28T08:00:00Z" });
const evalDraft = (withholdCost = false, draft = readyDraft()) => ({ draft, ev: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost }) });

describe("margin formulas", () => {
  it("gross profit, margin and markup are three different numbers", () => {
    expect(marginFigures(10_000, 7_000)).toEqual({ sellingCents: 10_000, costCents: 7_000, gpCents: 3_000, marginPct: 30, markupPct: 42.86 });
    expect(marginFigures(12_000, 10_000)).toMatchObject({ gpCents: 2_000, marginPct: 16.67, markupPct: 20 });
    expect(marginFigures(10_000, 12_000)).toMatchObject({ gpCents: -2_000, marginPct: -20, markupPct: -16.67 }); // a loss is shown, not hidden
  });
  it("an unknown cost shows NO margin (never 0); zero selling / zero cost give no percentage rather than a divide-by-zero", () => {
    expect(marginFigures(10_000, null)).toEqual({ sellingCents: 10_000, costCents: null, gpCents: null, marginPct: null, markupPct: null });
    expect(marginFigures(10_000, Number.NaN).gpCents).toBeNull();
    expect(marginFigures(0, 500)).toMatchObject({ marginPct: null, gpCents: -500 });
    expect(marginFigures(500, 0)).toMatchObject({ markupPct: null, marginPct: 100 });
    expect(() => marginFigures(Number.NaN, 1)).toThrow();
  });
});

describe("assembly cost", () => {
  const comps = [{ sku: "A", quantity: 2, unitCostCents: 1_000 }, { sku: "B", quantity: 5, unitCostCents: 200 }];
  it("= BOM components + labour + freight + other", () => {
    expect(assemblyUnitCost({ sku: "ASM", components: comps, labourCents: 500, freightCents: 150, otherCents: 50 })).toEqual({ ok: true, componentCents: 3_000, unitCostCents: 3_700 });
  });
  it("fails closed on an unknown component cost, empty BOM, bad quantity or fractional-cent labour", () => {
    expect(assemblyUnitCost({ sku: "ASM", components: [...comps, { sku: "C", quantity: 1, unitCostCents: null }], labourCents: 0, freightCents: 0, otherCents: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/C has no cost/) });
    expect(assemblyUnitCost({ sku: "ASM", components: [], labourCents: 0, freightCents: 0, otherCents: 0 })).toMatchObject({ ok: false });
    expect(assemblyUnitCost({ sku: "ASM", components: [{ sku: "A", quantity: 0, unitCostCents: 1 }], labourCents: 0, freightCents: 0, otherCents: 0 })).toMatchObject({ ok: false });
    expect(assemblyUnitCost({ sku: "ASM", components: comps, labourCents: 1.5, freightCents: 0, otherCents: 0 })).toMatchObject({ ok: false });
  });
});

describe("cost override audit", () => {
  it("needs a whole non-negative cost, a reason, who and when", () => {
    expect(validateCostOverride(ov(100))).toBeNull();
    expect(validateCostOverride(ov(100.5))).toMatch(/whole/);
    expect(validateCostOverride(ov(-1))).toMatch(/non-negative/);
    expect(validateCostOverride(ov(100, " "))).toMatch(/reason/);
    expect(validateCostOverride({ ...ov(100), by: "" })).toMatch(/who/);
  });
});

describe("margin sheet from a real evaluated quote", () => {
  it("reconciles with the quote engine's own totals and never reports a margin on a missing cost", () => {
    const { ev } = evalDraft();
    const sheet = buildMarginSheet(ev.budget!);
    const totals = ev.budget!.totals;
    expect(sheet.project.contractSellingCents).toBe(Math.round(totals.subtotalExTax * 100));
    // Every priced line that has a cost reports gp = selling - cost; sections roll up the same numbers
    for (const l of sheet.lines) if (l.costCents !== null) expect(l.gpCents).toBe(l.sellingCents - l.costCents);
    const secSelling = sheet.sections.reduce((n, s) => n + s.sellingCents, 0);
    expect(secSelling + sheet.project.uncostedChargesCents).toBe(sheet.project.contractSellingCents);
    expect(sheet.project.uncostedChargesCents).toBe(250_000 * 100 + 400_000 * 100 + 36_000 * 100);
    // a line with no cost keeps its selling value, shows no margin, and blocks the project total from claiming one
    const missing = sheet.lines.filter((l) => l.costCents === null);
    for (const l of missing) { expect(l.marginPct).toBeNull(); expect(l.gpCents).toBeNull(); }
    if (missing.length) { expect(sheet.project.incomplete).toBe(true); expect(sheet.project.gpCents).toBeNull(); expect(sheet.project.missingCostLines.length).toBe(missing.length); }
    expect(sheet.reportingBasis).toMatch(/PROVISIONAL/);
  });
  it("a package carries component-level margins; an estimator override replaces a line's cost, is labelled, and never changes selling value", () => {
    const { ev } = evalDraft();
    const base = buildMarginSheet(ev.budget!);
    const pkg = base.lines.find((l) => l.itemKey === "cup_drinker")!;
    expect(pkg.kind).toBe("ASSEMBLY_PACKAGE");
    expect(pkg.components).toHaveLength(7);
    expect(pkg.components!.every((c) => c.gpCents === c.sellingCents - (c.costCents as number))).toBe(true);
    const target = base.lines.find((l) => l.costCents === null)!;
    const withOv = buildMarginSheet(ev.budget!, { [target.itemKey]: ov(123_456) } as never);
    const l = withOv.lines.find((x) => x.itemKey === target.itemKey)!;
    expect(l).toMatchObject({ costCents: 123_456, costBasis: "OVERRIDE", overrideReason: "supplier quote", sellingCents: target.sellingCents });
    expect(() => buildMarginSheet(ev.budget!, { [target.itemKey]: ov(5, "") } as never)).toThrow(/reason/);
  });
  it("charges join the margin only when the estimator records an audited cost for them", () => {
    const { ev } = evalDraft();
    const s = buildMarginSheet(ev.budget!, { delivery: ov(200_000 * 100, "own trucks") } as never);
    expect(s.lines.find((l) => l.itemKey === "delivery")).toMatchObject({ sellingCents: 250_000 * 100, costCents: 200_000 * 100, costBasis: "OVERRIDE" });
    expect(s.project.uncostedChargesCents).toBe(400_000 * 100 + 36_000 * 100);
  });
  it("with cost withheld (a non-manager viewer) the sheet contains no costs and no margins", () => {
    const { ev } = evalDraft(true);
    const s = buildMarginSheet(ev.budget!);
    expect(s.lines.every((l) => l.costCents === null && l.marginPct === null && (l.components ?? []).every((c) => c.costCents === null))).toBe(true);
    expect(s.project.gpCents).toBeNull();
  });
});

describe("frozen at approval, kept internal", () => {
  const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
  const freeze = (draft = readyDraft()) => buildAcceptedBaseline({ quoteRef: "NQ-Q-0009", revision: 1, draft, evaluation: evalDraft(false, draft).ev, approvals });

  it("the accepted baseline carries the margin sheet, sealed by the hash; a changed cost changes the seal of a NEW baseline only", () => {
    const { baseline, hash } = freeze();
    expect(baseline.internalMargin?.project.contractSellingCents).toBe(baseline.contractCents);
    expect(baselineMatchesHash(baseline, hash)).toBe(true);
    expect(Object.isFrozen(baseline.internalMargin)).toBe(true);
    const tampered = structuredClone(baseline) as typeof baseline;
    tampered.internalMargin!.lines[0].costCents = 1;
    expect(baselineMatchesHash(tampered, hash)).toBe(false);
    const d = readyDraft();
    d.estimator.costOverrides = { delivery: ov(1) } as never;
    expect(freeze(d).hash).not.toBe(hash);
  });
  it("is NOT copied into the Project baseline and not reachable from the customer summary", () => {
    const { baseline, hash } = freeze();
    const proj = quoteToProjectBaseline(baseline, hash, "q1");
    expect(JSON.stringify(proj)).not.toMatch(/internalMargin|marginPct|markupPct|gpCents/);
    expect(proj.lines.every((l) => l.estimatedCostCents === null)).toBe(true);
    const { ev } = evalDraft(); // evaluated WITH cost visible: the summary must still carry none of it
    const summary = JSON.stringify(buildCustomerSummary(ev.budget!));
    expect(summary).not.toMatch(/margin|markup|gpCents|costCents|estimatedCost|landed/i);
  });
  it("a baseline sealed before margins existed still verifies (the field is optional)", () => {
    const { baseline } = freeze();
    const legacy = structuredClone(baseline) as unknown as Record<string, unknown>;
    delete legacy.internalMargin;
    expect(baselineMatchesHash(legacy, hashOf(legacy))).toBe(true);
  });
});

describe("override stamping and viewer redaction", () => {
  const withOv = (o: unknown) => { const d = readyDraft(); d.estimator.costOverrides = o as never; return d; };
  it("stamps who/when server-side, ignoring any stamp the browser sent; unchanged overrides keep their original stamp", () => {
    const forged = { delivery: { lineCostCents: 500, reason: "own trucks", by: "forged@x", at: "1999-01-01" } };
    const a = stampCostOverrides(withOv(forged), undefined, true, "mgr@x", "2026-10-28T09:00:00Z");
    expect(a.estimator.costOverrides!.delivery).toEqual({ lineCostCents: 500, reason: "own trucks", by: "mgr@x", at: "2026-10-28T09:00:00Z" });
    const b = stampCostOverrides(withOv({ delivery: { lineCostCents: 500, reason: "own trucks", by: "x", at: "y" } }), a.estimator.costOverrides, true, "other@x", "2026-10-29T00:00:00Z");
    expect(b.estimator.costOverrides!.delivery).toMatchObject({ by: "mgr@x", at: "2026-10-28T09:00:00Z" });
    const c = stampCostOverrides(withOv({ delivery: { lineCostCents: 600, reason: "own trucks", by: "x", at: "y" } }), a.estimator.costOverrides, true, "other@x", "2026-10-29T00:00:00Z");
    expect(c.estimator.costOverrides!.delivery).toMatchObject({ lineCostCents: 600, by: "other@x" });
  });
  it("refuses invalid overrides; a viewer who cannot see cost cannot add, change or remove them", () => {
    expect(() => stampCostOverrides(withOv({ delivery: { lineCostCents: 1.5, reason: "r", by: "", at: "" } }), undefined, true, "m@x", "t")).toThrow(/whole/);
    expect(() => stampCostOverrides(withOv({ delivery: { lineCostCents: 5, reason: " ", by: "", at: "" } }), undefined, true, "m@x", "t")).toThrow(/reason/);
    const prior = { delivery: ov(700) };
    expect(stampCostOverrides(withOv({ delivery: ov(1) }), prior, false, "rep@x", "t").estimator.costOverrides).toEqual(prior);
    expect(stampCostOverrides(readyDraft(), prior, false, "rep@x", "t").estimator.costOverrides).toEqual(prior);
    expect(stampCostOverrides(withOv({ delivery: ov(1) }), undefined, false, "rep@x", "t").estimator.costOverrides).toBeUndefined();
  });
  it("redacts cost overrides and the frozen margin sheet for a viewer who may not see cost, and leaves the contract figures intact", () => {
    const draft = withOv({ delivery: ov(100) });
    const { baseline } = buildAcceptedBaseline({ quoteRef: "Q", revision: 1, draft, evaluation: evalDraft(false, draft).ev, approvals: { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" } });
    const q = { draft, accepted_baseline: baseline };
    const red = redactInternalFinancials(q, false);
    expect(JSON.stringify(red)).not.toMatch(/internalMargin|costOverrides|lineCostCents/);
    expect(red.accepted_baseline!.contractCents).toBe(baseline.contractCents);
    expect(redactInternalFinancials(q, true)).toBe(q);
    expect(q.accepted_baseline.internalMargin).toBeDefined(); // the original is not mutated
  });
  it("approval freezes the margin from a cost-visible evaluation even though the approval itself evaluates cost-withheld", () => {
    const draft = readyDraft();
    const withheld = evalDraft(true, draft).ev;
    const visible = evalDraft(false, draft).ev;
    const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
    const naive = buildAcceptedBaseline({ quoteRef: "Q", revision: 1, draft, evaluation: withheld, approvals }).baseline;
    expect(naive.internalMargin!.lines.every((l) => l.costCents === null)).toBe(true);
    const good = buildAcceptedBaseline({ quoteRef: "Q", revision: 1, draft, evaluation: withheld, marginEvaluation: visible, approvals }).baseline;
    expect(good.internalMargin!.lines.some((l) => l.costCents !== null)).toBe(true);
    expect(good.contractCents).toBe(naive.contractCents);
    const mismatched = evalDraft(false, { ...draft, estimator: { ...draft.estimator, charges: { ...draft.estimator.charges, delivery: 1 } } }).ev;
    expect(() => buildAcceptedBaseline({ quoteRef: "Q", revision: 1, draft, evaluation: withheld, marginEvaluation: mismatched, approvals })).toThrow(/does not match/);
  });
});
