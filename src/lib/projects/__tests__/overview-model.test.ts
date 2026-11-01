import { describe, expect, it } from "vitest";
import { buildProjectOverview, XERO_NOTE, STOCK_NOTE, type OverviewEstimateInput, type OverviewInput } from "../overview-model";
import { marginFigures } from "../margin-figures";
import { R, approvedVariation, claim, demoInput, physRow, physSection, posting, progress, project, scope, stage } from "./overview-fixtures";

const kpi = (o: ReturnType<typeof buildProjectOverview>, id: string) => o.kpis.find((k) => k.id === id);
const exId = (o: ReturnType<typeof buildProjectOverview>, id: string) => o.exceptions.find((e) => e.id === id);
const COST_MARK = 987_654_321; // a recognisable cost in cents, to prove it never leaks
const estimates = (over: Partial<OverviewEstimateInput> = {}): OverviewEstimateInput => ({ revised: marginFigures(R(10_572_000), COST_MARK), incomplete: false, uncostedSellingCents: 0, exceptions: [], ...over });

describe("C1 executive summary - the demo-shaped project", () => {
  const o = buildProjectOverview(demoInput());
  it("shows the contract position, ex VAT, with the variation counted ONCE", () => {
    expect(kpi(o, "original")?.cents).toBe(R(10_072_000));
    expect(kpi(o, "variations")?.cents).toBe(R(500_000));
    expect(kpi(o, "revised")?.cents).toBe(R(10_572_000));
  });
  it("billed = every reserving claim of the original project plus the variation, each once; nothing remains", () => {
    expect(kpi(o, "billed")?.cents).toBe(R(10_572_000));
    expect(kpi(o, "remaining")?.cents).toBe(0);
  });
  it("the cancelled claim is ignored everywhere", () => {
    expect(o.reconciliation.scopes[0].claims.map((c) => c.claimNumber)).toEqual(["C05", "C04", "C03", "C01"]);
  });
  it("no approved claim is waiting for Cin7 when every approved claim has an invoice", () => {
    expect(kpi(o, "outstanding")).toMatchObject({ cents: 0, count: 0 });
  });
  it("carries the header", () => expect(o.header).toMatchObject({ reference: "PRJ-T-0001", customer: "Synthetic Customer", status: "ACTIVE", originatingQuote: "NQ-Q-TEST" }));
});

describe("ex VAT consistency", () => {
  it("'Approved claims not yet in Cin7' uses the claim's ex-VAT subtotal, never its VAT-inclusive total", () => {
    const i = demoInput();
    const b = i.scopes[0];
    // replace the base posting of c5 with nothing: c5 is approved, not posted
    const base = project({ id: "p-base", project_reference: "PRJ-T-0001", original_contract_cents: R(1000) });
    const s = scope({ project: base, stages: [stage("s1", 1, "All", R(1000))], events: [progress("s1", 0, 10_000)], claims: [claim("c1", 1, "APPROVED", R(1000))] });
    const o = buildProjectOverview({ ...i, scopes: [s], unbilledApprovedVariations: [] });
    expect(b).toBeDefined();
    expect(kpi(o, "outstanding")).toMatchObject({ cents: R(1000), count: 1 }); // 100000, not 115000
    expect(o.reconciliation.scopes[0].summary.invoicedExVatCents).toBe(0);
  });
  it("invoiced in Cin7 sums ex-VAT claim amounts across Sales", () => {
    const o = buildProjectOverview(demoInput());
    expect(o.reconciliation.invoicedExVatCents).toBe(R(10_572_000));
  });
});

describe("variations are never double counted", () => {
  it("revised contract does not grow when the variation's own billing scope is supplied", () => {
    const withScope = buildProjectOverview(demoInput());
    const baseOnly = buildProjectOverview(demoInput({ scopes: [demoInput().scopes[0]], unbilledApprovedVariations: [{ code: "V001", amountCents: R(500_000) }] }));
    expect(kpi(withScope, "revised")?.cents).toBe(R(10_572_000));
    expect(kpi(baseOnly, "revised")?.cents).toBe(R(10_572_000));
  });
  it("an approved variation with no billing scope yet is in the revised contract and is remaining, not billed", () => {
    const o = buildProjectOverview(demoInput({ scopes: [demoInput().scopes[0]], unbilledApprovedVariations: [{ code: "V001", amountCents: R(500_000) }] }));
    expect(kpi(o, "billed")?.cents).toBe(R(10_072_000));
    expect(kpi(o, "remaining")?.cents).toBe(R(500_000));
    expect(exId(o, "unbilled-variations")).toBeTruthy();
    expect(exId(o, "variation-mismatch")).toBeUndefined();
  });
  it("flags a variation scope that does not reconcile to the approved variations", () => {
    const i = demoInput();
    const base = project({ id: "p-base", project_reference: "PRJ-T-0001", original_contract_cents: R(1000) });
    const bad = scope({ project: base, stages: [stage("s1", 1, "All", R(1000))], variations: [approvedVariation(R(500))] }); // approved R500, but no scope and nothing unbilled
    const o = buildProjectOverview({ ...i, scopes: [bad], unbilledApprovedVariations: [] });
    expect(exId(o, "variation-mismatch")?.severity).toBe("critical");
  });
  it("rejects a missing or duplicated original scope and a repeated project", () => {
    const i = demoInput();
    expect(() => buildProjectOverview({ ...i, scopes: [i.scopes[1]] })).toThrow(/exactly one original/);
    expect(() => buildProjectOverview({ ...i, scopes: [i.scopes[0], i.scopes[0]] })).toThrow();
  });
});

describe("C2 commercial progress keeps three measures apart", () => {
  it("reports site progress, approved-for-billing and billed separately, and the claimable amount", () => {
    const base = project({ id: "p", project_reference: "PRJ-T-2", original_contract_cents: R(1000) });
    const s = scope({
      project: base, stages: [stage("s1", 1, "Delivery", R(1000))], events: [progress("s1", 3000, 5000)], claims: [claim("c1", 1, "APPROVED", R(200))],
      lines: [{ claim_id: "c1", stage_id: "s1", current_claim_cents: R(200) }],
    });
    const o = buildProjectOverview({ ...demoInput(), scopes: [s], unbilledApprovedVariations: [] });
    expect(o.milestones[0].rows[0]).toMatchObject({ reportedBps: 3000, approvedBps: 5000, valueCents: R(1000), earnedCents: R(500), committedCents: R(200), remainingCents: R(800), claimableCents: R(300) });
    expect(o.milestones[0].totals).toMatchObject({ valueCents: R(1000), committedCents: R(200), claimableCents: R(300) });
  });
  it("a PARTIAL claim reserves only its partial amount", () => {
    const base = project({ id: "p", project_reference: "PRJ-T-3", original_contract_cents: R(1000) });
    const s = scope({ project: base, stages: [stage("s1", 1, "Delivery", R(1000))], events: [progress("s1", 10_000, 10_000)], claims: [claim("c1", 1, "APPROVED", R(400))], lines: [{ claim_id: "c1", stage_id: "s1", current_claim_cents: R(400) }] });
    const o = buildProjectOverview({ ...demoInput(), scopes: [s], unbilledApprovedVariations: [] });
    expect(o.milestones[0].rows[0]).toMatchObject({ committedCents: R(400), remainingCents: R(600), claimableCents: R(600) });
    expect(exId(o, "claimable-now")).toBeTruthy();
    expect(exId(o, "open-milestones")).toBeTruthy();
  });
  it("fully billed: nothing claimable and no 'ready to claim' item (scenario 5: billing complete, delivery separate)", () => {
    const o = buildProjectOverview(demoInput({ physical: { state: "loaded", asOf: "2026-11-01T16:00:00Z", sections: [physSection([physRow("A", { ordered: 10, shipped: 4, remaining: 6, shortfall: 0 })])] } }));
    expect(o.milestones[0].totals.claimableCents).toBe(0);
    expect(exId(o, "claimable-now")).toBeUndefined();
    expect(exId(o, "open-milestones")).toBeUndefined();
    expect(exId(o, "outstanding-delivery")?.title).toMatch(/6 units still to ship/);
  });
});

describe("C3 physical fulfilment - unknown is never zero", () => {
  it("before Cin7 is read: no totals at all, and a plain 'not loaded' state", () => {
    const o = buildProjectOverview(demoInput());
    expect(o.physical).toMatchObject({ state: "not_loaded", totals: null, shortages: [] });
    expect(exId(o, "outstanding-delivery")).toBeUndefined();
  });
  it("one unreadable product line makes the totals unknown, not a partial sum", () => {
    const o = buildProjectOverview(demoInput({ physical: { state: "loaded", asOf: "t", sections: [physSection([physRow("A"), physRow("B", { shipped: null, remaining: null, shortfall: null })])] } }));
    expect(o.physical.totals).toMatchObject({ orderedUnits: 20, shippedUnits: null, remainingUnits: null, unknownRowCount: 1 });
    expect(exId(o, "physical-unknown")).toBeTruthy();
    expect(exId(o, "outstanding-delivery")).toBeUndefined();
  });
  it("a Sale that is not linked has unknown ordered/shipped quantities, never zero", () => {
    const o = buildProjectOverview(demoInput({ physical: { state: "loaded", asOf: "t", sections: [physSection([physRow("A", { ordered: null, shipped: null, remaining: null, shortfall: null, quoted: 7 })], { linked: false, saleNumber: null })] } }));
    expect(o.physical.totals).toMatchObject({ orderedUnits: null, remainingUnits: null });
    expect(o.physical.sections[0].rows[0]).toMatchObject({ approved: 7, ordered: null, shipped: null, remaining: null });
  });
  it("a commercial-only scope has no physical products; that is known and contributes nothing", () => {
    const o = buildProjectOverview(demoInput({ physical: { state: "loaded", asOf: "t", sections: [physSection([physRow("A", { shipped: 10, remaining: 0, shortfall: 0 })]), physSection([], { label: "V001 variation", scope: "VARIATION", saleNumber: "SO-28" })] } }));
    expect(o.physical.totals).toMatchObject({ orderedUnits: 10, shippedUnits: 10, remainingUnits: 0 });
    expect(exId(o, "outstanding-delivery")).toBeUndefined();
  });
  it("stock is labelled account-wide, and shortages are listed with the account-wide figure", () => {
    const o = buildProjectOverview(demoInput({ physical: { state: "loaded", asOf: "t", sections: [physSection([physRow("A", { remaining: 6, available: 2, shortfall: 4 })])] } }));
    expect(o.physical.notes).toContain(STOCK_NOTE);
    expect(o.physical.shortages).toEqual([{ section: "Original contract", sku: "A", name: "Product A", remaining: 6, availableAccountWide: 2, shortfall: 4 }]);
    expect(exId(o, "stock-shortages")?.detail).toMatch(/account-wide/);
  });
  it("a failed Cin7 read is an error state with an exception, not a silent zero", () => {
    const o = buildProjectOverview(demoInput({ physical: { state: "error", error: "Cin7 is unavailable" } }));
    expect(o.physical).toMatchObject({ state: "error", error: "Cin7 is unavailable", totals: null });
    expect(exId(o, "physical-unreadable")?.detail).toBe("Cin7 is unavailable");
  });
  it("deliveries unreadable stays unknown (null), and a planned delivery is surfaced", () => {
    expect(buildProjectOverview(demoInput({ deliveries: null })).physical.deliveries).toBeNull();
    expect(exId(buildProjectOverview(demoInput()), "deliveries-in-progress")).toBeTruthy();
  });
});

describe("C4 reconciliation - Cin7 invoices, not Xero", () => {
  const o = buildProjectOverview(demoInput());
  it("lists each Sale with its claims, invoice numbers and reconciliation state", () => {
    const base = o.reconciliation.scopes[0];
    expect(base).toMatchObject({ saleNumber: "SO-27", saleLinked: true });
    expect(base.summary).toMatchObject({ invoiceCount: 4, reconciledCount: 3, notPostedCount: 0, problemCount: 0, invoicedExVatCents: R(10_072_000) });
    expect(base.claims.find((c) => c.claimNumber === "C05")).toMatchObject({ invoiceNumber: "INV-5", cin7Label: "Draft invoice created", reconciled: false });
    expect(o.reconciliation.scopes[1]).toMatchObject({ saleNumber: "SO-28", label: "V001 variation" });
    expect(o.reconciliation.scopes[1].summary.invoicedExVatCents).toBe(R(500_000));
  });
  it("flags the created-but-unreconciled invoice", () => {
    expect(exId(o, "unreconciled-p-base")).toMatchObject({ severity: "attention", detail: "INV-5" });
  });
  it("states plainly that Xero reconciliation is not verified here", () => {
    expect(o.reconciliation.xeroNote).toBe(XERO_NOTE);
    expect(XERO_NOTE).toMatch(/Xero/);
    expect(XERO_NOTE).toMatch(/not connected or verified/);
  });
  it("failed and uncertain postings are critical; a missing Sale link is called out", () => {
    const i = demoInput();
    const base = project({ id: "p-base", project_reference: "PRJ-T-0001", original_contract_cents: R(1000) });
    const s = scope({ project: base, stages: [stage("s1", 1, "All", R(1000))], events: [progress("s1", 0, 10_000)], claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(1000))], postings: [posting("c1", "FAILED_UNCERTAIN", null, null, false, "timeout")], saleNumber: null });
    const x = buildProjectOverview({ ...i, scopes: [s], unbilledApprovedVariations: [] });
    expect(exId(x, "posting-problem-p-base")?.severity).toBe("critical");
    expect(exId(x, "no-sale-p-base")).toBeTruthy();
    expect(x.exceptions[0].severity).toBe("critical");
  });
});

describe("C5 exceptions", () => {
  it("a clean project has none", () => {
    const base = project({ id: "p", project_reference: "PRJ-T-9", original_contract_cents: R(1000) });
    const s = scope({ project: base, stages: [stage("s1", 1, "All", R(1000))], events: [progress("s1", 10_000, 10_000)], claims: [claim("c1", 1, "RECONCILED", R(1000))], postings: [posting("c1", "RECONCILED", "INV-9", "AUTHORISED", true)] });
    expect(buildProjectOverview({ ...demoInput(), scopes: [s], unbilledApprovedVariations: [], deliveries: { total: 1, dispatched: 1, inProgress: 0, cancelled: 0, latestActivityAt: null } }).exceptions).toEqual([]);
  });
  it("claims awaiting approval link to their Approvals request, ex VAT-free of money, and approved-unposted claims are listed", () => {
    const base = project({ id: "p", project_reference: "PRJ-T-4", original_contract_cents: R(1000) });
    const s = scope({
      project: base, stages: [stage("s1", 1, "A", R(500)), stage("s2", 2, "B", R(500))], events: [progress("s1", 0, 10_000), progress("s2", 0, 10_000)],
      claims: [claim("c1", 1, "READY_FOR_APPROVAL", R(500)), claim("c2", 2, "APPROVED", R(500))],
      lines: [{ claim_id: "c1", stage_id: "s1", current_claim_cents: R(500) }, { claim_id: "c2", stage_id: "s2", current_claim_cents: R(500) }],
      approvals: [{ claimId: "c1", requestId: "req-9", stage: "MANAGER", stageRole: "MANAGER", assignedToEmail: null }],
    });
    const o = buildProjectOverview({ ...demoInput(), scopes: [s], unbilledApprovedVariations: [] });
    expect(exId(o, "claims-awaiting-approval")).toMatchObject({ link: { kind: "href", href: "/approvals/req-9" }, detail: "C01" });
    expect(exId(o, "approved-not-posted")?.detail).toBe("C02");
  });
  it("unmapped products block and link to the product register, de-duplicated across the register and the Cin7 read", () => {
    const i = demoInput({ physical: { state: "loaded", asOf: "t", sections: [physSection([], { scopeBlockers: ["Cooler: not mapped"] })] } });
    i.scopes[0].scopeBlockers = ["Cooler: not mapped"];
    const e = exId(buildProjectOverview(i), "unmapped-products");
    expect(e).toMatchObject({ severity: "critical", title: "1 product not mapped to Cin7", link: { kind: "tab", tab: "components" } });
  });
  it("is ordered most severe first", () => {
    const i = demoInput({ physical: { state: "loaded", asOf: "t", sections: [physSection([physRow("A")])] } });
    i.scopes[0].scopeBlockers = ["X: not mapped"];
    const sev = buildProjectOverview(i).exceptions.map((e) => e.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ({ critical: 0, attention: 1, info: 2 }[a] - { critical: 0, attention: 1, info: 2 }[b])));
    expect(sev[0]).toBe("critical");
  });
  it("an unbalanced schedule is critical", () => {
    const base = project({ id: "p", project_reference: "PRJ-T-5", original_contract_cents: R(1000) });
    const o = buildProjectOverview({ ...demoInput(), scopes: [scope({ project: base, stages: [stage("s1", 1, "A", R(900))] })], unbilledApprovedVariations: [] });
    expect(exId(o, "schedule-unbalanced")?.severity).toBe("critical");
  });
});

describe("authorisation-based redaction (cost and margin)", () => {
  const cost: OverviewInput = demoInput({ estimates: estimates({ exceptions: [{ code: "COST_UNKNOWN", scope: "V001 variation", message: "V001 variation has no estimated cost" }] }) });
  it("an administrator sees estimated cost, gross profit and margin", () => {
    const o = buildProjectOverview(cost);
    expect(o.costVisible).toBe(true);
    expect(kpi(o, "cost")?.cents).toBe(COST_MARK);
    expect(kpi(o, "gp")).toMatchObject({ cents: R(10_572_000) - COST_MARK });
    expect(kpi(o, "gp")?.percent).not.toBeNull();
    expect(exId(o, "cost-COST_UNKNOWN-V001 variation")).toBeTruthy();
  });
  it("anyone else sees NO cost, margin or cost exceptions even if estimates were supplied", () => {
    const o = buildProjectOverview({ ...cost, viewer: { isAdmin: false } });
    expect(o.costVisible).toBe(false);
    expect(kpi(o, "cost")).toBeUndefined();
    expect(kpi(o, "gp")).toBeUndefined();
    expect(o.exceptions.some((e) => e.area === "Cost")).toBe(false);
    const json = JSON.stringify(o);
    expect(json).not.toContain(String(COST_MARK));
    expect(json).not.toContain(String(R(10_572_000) - COST_MARK));
  });
  it("an administrator whose estimate is incomplete sees Unknown with the reason, not a partial or zero cost", () => {
    const o = buildProjectOverview(demoInput({ estimates: estimates({ revised: marginFigures(R(10_572_000), null), incomplete: true }) }));
    expect(kpi(o, "cost")).toMatchObject({ cents: null, unknown: expect.stringMatching(/no estimated cost/) });
    expect(kpi(o, "gp")).toMatchObject({ cents: null, percent: null });
  });
  it("an administrator whose estimate could not be loaded sees Unknown, not zero", () => {
    const o = buildProjectOverview(demoInput({ estimates: null }));
    expect(kpi(o, "cost")).toMatchObject({ cents: null, unknown: expect.stringMatching(/could not be loaded/) });
  });
  it("a negative estimated margin is a critical cost exception (administrators only)", () => {
    const o = buildProjectOverview(demoInput({ estimates: estimates({ revised: marginFigures(R(100), R(150)) }) }));
    expect(exId(o, "negative-margin")?.severity).toBe("critical");
  });
});
