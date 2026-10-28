import { describe, expect, it } from "vitest";
import { buildProfitability, type ScopeInput } from "../profitability";
import { redactVariationCosts, type VariationRow } from "../variations";
import { baseCostFromBaseline } from "@/lib/newquip-quotes/project-estimated-cost";
import { loadProfitability } from "../profitability-store";
import type { PhysicalPort } from "../physical-store";
import { FakeDb } from "./fake-db";
import { createProjectFromBaseline } from "../project-store";
import { goldenFixtureBaseline } from "../baseline";
import { raiseVariation, setVariationEstimatedCost, approveVariation } from "../variation-store";
import { createVariationBillingProject } from "../variation-billing-store";
import { defaultVariationSchedule } from "../variation-schedule";

const R = (n: number) => n * 100;
const base = (o: Partial<ScopeInput> = {}): ScopeInput => ({
  scope: "BASE", label: "Original contract", projectId: "p1", contractCents: R(10_000_000), committedCents: R(3_450_000), postedCents: R(3_450_000), unpostedApprovedCents: 0, mismatchedPostings: 0,
  estimatedCostCents: R(6_500_000), uncostedSellingCents: R(500_000), saleNumber: "SO-1", cogsCents: R(900_000), deliveryComplete: false, ...o,
});
const variation = (o: Partial<ScopeInput> = {}): ScopeInput => ({
  scope: "VARIATION", label: "V001 variation", projectId: "p2", contractCents: R(480_000), committedCents: 0, postedCents: 0, unpostedApprovedCents: 0, mismatchedPostings: 0,
  estimatedCostCents: R(300_000), uncostedSellingCents: 0, saleNumber: "SO-2", cogsCents: 0, deliveryComplete: false, ...o,
});
const AT = "2026-10-28T12:00:00Z";

describe("profitability report", () => {
  it("consolidates contract, billing and estimated margins; the revised margin is the sum of both scopes", () => {
    const r = buildProfitability([base(), variation()], AT);
    expect(r.contract).toEqual({ originalCents: R(10_000_000), approvedVariationsCents: R(480_000), revisedCents: R(10_480_000) });
    expect(r.billing).toMatchObject({ committedCents: R(3_450_000), postedToCin7Cents: R(3_450_000), remainingToClaimCents: R(10_480_000) - R(3_450_000) });
    // services with no recorded cost are excluded from the estimated margin, and said so
    expect(r.estimated.original).toMatchObject({ sellingCents: R(9_500_000), costCents: R(6_500_000), gpCents: R(3_000_000), marginPct: 31.58, markupPct: 46.15 });
    expect(r.estimated.variations).toMatchObject({ sellingCents: R(480_000), costCents: R(300_000), gpCents: R(180_000), marginPct: 37.5 });
    expect(r.estimated.revised).toMatchObject({ sellingCents: R(9_980_000), costCents: R(6_800_000), gpCents: R(3_180_000) });
    expect(r.estimated.uncostedSellingCents).toBe(R(500_000));
    expect(r.reportingBasis).toMatch(/PROVISIONAL/);
    expect(r.asOf).toBe(AT);
  });
  it("a scope with an unknown estimated cost withholds its margin and the revised total (never a partial margin)", () => {
    const r = buildProfitability([base(), variation({ estimatedCostCents: null })], AT);
    expect(r.estimated.variations).toMatchObject({ costCents: null, gpCents: null, marginPct: null });
    expect(r.estimated.revised).toMatchObject({ costCents: null, marginPct: null });
    expect(r.estimated.original.marginPct).not.toBeNull();
    expect(r.estimated.incomplete).toBe(true);
    expect(r.exceptions.map((e) => e.code)).toContain("COST_UNKNOWN");
  });
  it("actual margin is NOT produced while delivery or billing is incomplete - only cost to date, with the reason", () => {
    const r = buildProfitability([base(), variation()], AT);
    expect(r.actual).toMatchObject({ meaningful: false, projectMargin: null, recognisedCostToDateCents: R(900_000), invoicedToDateCents: R(3_450_000) });
    expect(r.actual.reason).toMatch(/delivery is not complete/);
    const billingGap = buildProfitability([base({ deliveryComplete: true }), variation({ deliveryComplete: true })], AT);
    expect(billingGap.actual).toMatchObject({ meaningful: false, projectMargin: null });
    expect(billingGap.actual.reason).toMatch(/not fully billed/);
  });
  it("actual margin appears only when every scope is fully delivered, fully billed, fully posted and its cost was read", () => {
    const done = [base({ committedCents: R(10_000_000), postedCents: R(10_000_000), deliveryComplete: true, cogsCents: R(6_000_000) }), variation({ committedCents: R(480_000), postedCents: R(480_000), deliveryComplete: true, cogsCents: R(290_000) })];
    const r = buildProfitability(done, AT);
    expect(r.actual.meaningful).toBe(true);
    expect(r.actual.projectMargin).toMatchObject({ sellingCents: R(10_480_000), costCents: R(6_290_000), gpCents: R(4_190_000) });
    for (const tweak of [{ deliveryComplete: null }, { unpostedApprovedCents: 1 }, { mismatchedPostings: 1 }, { cogsCents: null }] as Array<Partial<ScopeInput>>) {
      expect(buildProfitability([{ ...done[0], ...tweak }, done[1]], AT).actual.projectMargin).toBeNull();
    }
  });
  it("unknown cost to date (any scope) makes the total unknown rather than a partial sum", () => {
    expect(buildProfitability([base(), variation({ cogsCents: null })], AT).actual.recognisedCostToDateCents).toBeNull();
  });
  it("reports the reconciliation exceptions", () => {
    const r = buildProfitability([base({ committedCents: R(10_000_001), unpostedApprovedCents: R(100), mismatchedPostings: 1, saleNumber: null, cogsCents: null })], AT);
    expect(r.exceptions.map((e) => e.code).sort()).toEqual(["NO_LINKED_SALE", "OVER_BILLED", "POSTING_MISMATCH", "UNPOSTED_APPROVED_CLAIM"].sort());
  });
});

describe("internal figures stay internal", () => {
  const v = (cost: number | null): VariationRow => ({ id: "v", code: "V001", title: "t", description: null, amount_cents: 1, estimated_cost_cents: cost, status: "DRAFT", raised_by_email: "a", priced_by_email: null, decided_by_email: null, decided_at: null, decision_reason: null, created_at: "" });
  it("redacts variation costs for a viewer who may not see cost, without mutating the original", () => {
    const view = { variations: [v(500)] };
    expect(redactVariationCosts(view, false).variations[0].estimated_cost_cents).toBeNull();
    expect(view.variations[0].estimated_cost_cents).toBe(500);
    expect(redactVariationCosts(view, true)).toBe(view);
  });
  it("the BASE estimate comes only from the frozen baseline sheet; an incomplete or missing sheet gives no cost", () => {
    const sheet = (incomplete: boolean) => ({ internalMargin: { project: { incomplete, costCents: 700, uncostedChargesCents: 50 } } }) as never;
    expect(baseCostFromBaseline(sheet(false))).toEqual({ estimatedCostCents: 700, uncostedSellingCents: 50 });
    expect(baseCostFromBaseline(sheet(true))).toEqual({ estimatedCostCents: null, uncostedSellingCents: 50 });
    expect(baseCostFromBaseline(null)).toEqual({ estimatedCostCents: null, uncostedSellingCents: 0 });
    expect(baseCostFromBaseline({} as never)).toEqual({ estimatedCostCents: null, uncostedSellingCents: 0 });
  });
});

describe("profitability store (read-only)", () => {
  it("joins BASE + variation billing projects and Cin7 COGS/delivery; writes nothing", async () => {
    const db = new FakeDb();
    const parent = await createProjectFromBaseline(db as never, "o", "m@x", goldenFixtureBaseline(), { reference: "PRJ-1", name: "n" });
    const { variationId } = await raiseVariation(db as never, "o", "e@x", { projectId: parent, title: "Vent", description: "", amountCents: R(480_000), estimatedCostCents: R(300_000) });
    await approveVariation(db as never, "o", "m@x", parent, variationId);
    await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: "o", projectId: parent, variationId });
    const child = db.rows("projects").find((p) => p.variation_id === variationId)!;
    db.rows("project_cin7_sale_links").push({ id: "l1", org_id: "o", project_id: parent, instance_id: "i", cin7_sale_id: "S1", cin7_sale_number: "SO-1" });
    db.rows("project_cin7_sale_links").push({ id: "l2", org_id: "o", project_id: child.id, instance_id: "i", cin7_sale_id: "S2", cin7_sale_number: "SO-2" });
    const port: PhysicalPort = {
      async readSale(id) { return { cogsCents: id === "S1" ? R(10) : R(5), ordered: [{ sku: "A", name: "a", quantity: 2 }], invoices: [], fulfilments: [{ number: 1, packLines: [{ sku: "A", quantity: 2 }], shipped: id === "S1" }] }; },
      async readStock() { return null; }, async readAssemblies() { return []; },
    };
    const writesBefore = db.writes.length;
    const r = (await loadProfitability(db as never, () => port, { orgId: "o", projectId: parent, base: { estimatedCostCents: R(6_500_000), uncostedSellingCents: 0 } }))!;
    expect(db.writes.length).toBe(writesBefore);
    expect(r.contract.revisedCents).toBe(R(10_000_000) + R(480_000));
    expect(r.estimated.variations).toMatchObject({ costCents: R(300_000), marginPct: 37.5 });
    expect(r.actual).toMatchObject({ recognisedCostToDateCents: R(15), meaningful: false });
    expect(r.exceptions.some((e) => e.code === "COGS_NOT_READ")).toBe(false);
  });
  it("a variation's estimated cost can be set only while DRAFT", async () => {
    const db = new FakeDb();
    const parent = await createProjectFromBaseline(db as never, "o", "m@x", goldenFixtureBaseline(), { reference: "PRJ-1", name: "n" });
    const { variationId } = await raiseVariation(db as never, "o", "e@x", { projectId: parent, title: "V", description: "", amountCents: 100 });
    await setVariationEstimatedCost(db as never, "o", parent, variationId, 40);
    expect(db.rows("project_variations")[0].estimated_cost_cents).toBe(40);
    await approveVariation(db as never, "o", "m@x", parent, variationId);
    await expect(setVariationEstimatedCost(db as never, "o", parent, variationId, 50)).rejects.toThrow(/DRAFT/);
    await expect(setVariationEstimatedCost(db as never, "o", parent, variationId, -1)).rejects.toThrow(/non-negative/);
    void defaultVariationSchedule;
  });
});
