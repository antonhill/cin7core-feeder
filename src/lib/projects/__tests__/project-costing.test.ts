import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { buildProfitability, type ScopeInput } from "../profitability";
import { invoiceLineCost } from "../physical-adapter";
import { randToCents, totalCosts, validateNewCost } from "../project-costs";
import { addCostEntry, indicativeScopeCost, loadCostLedger, loadNonStockTotals, markCostIncurred, voidCostEntry } from "../project-costs-store";

const scope = (over: Partial<ScopeInput> = {}): ScopeInput => ({
  scope: "BASE", label: "Original contract", projectId: "p", contractCents: 10_000_000, committedCents: 10_000_000, postedCents: 10_000_000, unpostedApprovedCents: 0, mismatchedPostings: 0,
  estimatedCostCents: 6_000_000, uncostedSellingCents: 0, saleNumber: "SO-1", cogsCents: 0, deliveryComplete: true, ...over,
});

describe("why recognised cost showed R0 (observed on SO-00023: INV-00028 line NQCP137 x1 at R0, average cost R50, invoice status DRAFT)", () => {
  it("invoice-line cost reads Quantity x AverageCost on non-voided invoices - available even on a DRAFT invoice", () => {
    expect(invoiceLineCost([{ Status: "DRAFT", Lines: [{ SKU: "NQCP137", Quantity: 1, AverageCost: 50 }] }])).toBe(5000);
    expect(invoiceLineCost([{ Status: "VOIDED", Lines: [{ Quantity: 9, AverageCost: 9 }] }, { Status: "AUTHORISED", Lines: [{ Quantity: 2, AverageCost: 107.4209 }] }])).toBe(21484);
  });
  it("is UNKNOWN (null) - never zero - when a line's cost or quantity is unreadable or Cin7's 'not configured' 0", () => {
    expect(invoiceLineCost([{ Status: "DRAFT", Lines: [{ Quantity: 1, AverageCost: 0 }] }])).toBeNull();
    expect(invoiceLineCost([{ Status: "DRAFT", Lines: [{ Quantity: 1 }] }])).toBeNull();
    expect(invoiceLineCost([{ Status: "DRAFT" }])).toBeNull();
    expect(invoiceLineCost([])).toBe(0);
  });
  it("R0 recognised COGS with costed invoice lines raises an exception and withholds the actual margin", () => {
    const r = buildProfitability([scope({ cogsCents: 0, invoiceLineCostCents: 5000, nonStock: { incurredCents: 0, committedCents: 0 } })], "2026-10-28T00:00:00Z");
    expect(r.exceptions.map((e) => e.code)).toContain("COGS_ZERO_BUT_LINES_COSTED");
    expect(r.actual.meaningful).toBe(false);
    expect(r.actual.projectMargin).toBeNull();
    expect(r.actual.reason).toMatch(/Zero recognised cost is not proof/);
    expect(r.actual.invoiceLineCostCents).toBe(5000);
    expect(r.actual.incurredCostCents).toBe(5000); // the larger of recognised (0) and line cost (5000) + R0 non-stock
  });
  it("once Cin7 recognises the cost the margin is produced on recognised COGS", () => {
    const r = buildProfitability([scope({ cogsCents: 6_500_000, invoiceLineCostCents: 6_500_000, nonStock: { incurredCents: 0, committedCents: 0 } })], "x");
    expect(r.actual.meaningful).toBe(true);
    expect(r.actual.projectMargin).toMatchObject({ costCents: 6_500_000, gpCents: 3_500_000 });
    expect(r.exceptions.map((e) => e.code)).not.toContain("COGS_ZERO_BUT_LINES_COSTED");
  });
  it("unknown line cost is flagged and incurred cost stays unknown rather than zero", () => {
    const r = buildProfitability([scope({ cogsCents: null, invoiceLineCostCents: null, nonStock: { incurredCents: 100, committedCents: 0 } })], "x");
    expect(r.exceptions.map((e) => e.code)).toEqual(expect.arrayContaining(["LINE_COST_UNKNOWN", "COGS_NOT_READ"]));
    expect(r.actual.incurredCostCents).toBeNull();
  });
});

describe("estimated vs committed vs incurred vs recognised are separate; a missing estimate is an exception, not a margin", () => {
  it("withholds the estimated margin without an estimate but still reports the indicative Cin7 product cost", () => {
    const r = buildProfitability([scope({ estimatedCostCents: null, indicativeCostCents: 5000, nonStock: null })], "x");
    expect(r.exceptions.map((e) => e.code)).toContain("COST_UNKNOWN");
    expect(r.estimated.original.marginPct ?? null).toBeNull();
    expect(r.estimated.indicativeProductCostCents).toBe(5000);
    expect(r.actual.nonStockIncurredCents).toBeNull(); // ledger unavailable = unknown
  });
  it("adds incurred non-stock cost to stock cost for incurred cost, and reports committed separately; consolidates BASE + variation", () => {
    const base = scope({ cogsCents: 6_000_000, invoiceLineCostCents: 6_000_000, nonStock: { incurredCents: 200_000, committedCents: 300_000 } });
    const v = scope({ scope: "VARIATION", label: "V001 variation", contractCents: 500_000, committedCents: 500_000, postedCents: 500_000, estimatedCostCents: 300_000, cogsCents: 107_42, invoiceLineCostCents: 107_42, nonStock: { incurredCents: 0, committedCents: 50_000 } });
    const r = buildProfitability([base, v], "x");
    expect(r.actual.incurredCostCents).toBe(6_000_000 + 200_000 + 10_742);
    expect(r.actual.nonStockCommittedCents).toBe(350_000);
    expect(r.contract.revisedCents).toBe(10_500_000);
  });
});

describe("non-stock project costs", () => {
  it("parses rand amounts exactly and validates entries", () => {
    expect([randToCents("1 250.50"), randToCents("R1,250.5"), randToCents("0.01")]).toEqual([125050, 125050, 1]);
    expect([randToCents("0"), randToCents("-5"), randToCents("1.234"), randToCents("abc")]).toEqual([null, null, null, null]);
    const ok = validateNewCost({ category: "TRANSPORT_DELIVERY", description: "Truck 1", amountRand: "12000", state: "INCURRED" }, "2026-10-28");
    expect(ok).toMatchObject({ ok: true, row: { amount_cents: 1_200_000, state: "INCURRED", incurred_on: "2026-10-28" } });
    expect(validateNewCost({ category: "X", description: "d", amountRand: "1", state: "COMMITTED" }, "2026-10-28")).toMatchObject({ ok: false });
    expect(validateNewCost({ category: "OTHER_DIRECT", description: " ", amountRand: "1", state: "COMMITTED" }, "t")).toMatchObject({ ok: false });
    expect(validateNewCost({ category: "OTHER_DIRECT", description: "d", amountRand: "1", state: "INCURRED", incurredOn: "2027-01-01" }, "2026-10-28")).toMatchObject({ ok: false, error: expect.stringMatching(/future/) });
    expect(validateNewCost({ category: "OTHER_DIRECT", description: "d", amountRand: "1", state: "COMMITTED", incurredOn: "2026-01-01" }, "2026-10-28")).toMatchObject({ ok: false });
  });
  it("totals committed and incurred by category; excludes voided entries and entries already inside a Cin7 valuation (no double counting)", () => {
    const e = (category: string, cents: number, state: string, extra: Record<string, unknown> = {}) => ({ category, amount_cents: cents, state, in_cin7_valuation: false, voided_at: null, ...extra }) as never;
    const t = totalCosts([e("SUBCONTRACTOR", 100, "INCURRED"), e("SUBCONTRACTOR", 50, "COMMITTED"), e("TRANSPORT_DELIVERY", 25, "INCURRED"), e("SITE_EXPENSE", 999, "INCURRED", { voided_at: "x" }), e("OTHER_DIRECT", 700, "INCURRED", { in_cin7_valuation: true })]);
    expect(t).toMatchObject({ incurredCents: 125, committedCents: 50, excludedCents: 700 });
    expect(t.byCategory.SUBCONTRACTOR).toEqual({ incurredCents: 100, committedCents: 50 });
  });
  it("store: records, marks incurred, voids with a reason, and reports an unavailable ledger as unknown", async () => {
    const db = new FakeDb();
    db.rows("projects").push({ id: "p", org_id: "o", status: "ACTIVE", baseline_snapshot: {} });
    const a = { orgId: "o", projectId: "p", actor: "m@x", now: new Date("2026-10-28T10:00:00Z") };
    const c = await addCostEntry(db as never, { ...a, cost: { category: "SUBCONTRACTOR", description: "Erectors", amountRand: "50 000", state: "COMMITTED" } });
    expect(await loadNonStockTotals(db as never, "o", "p")).toEqual({ incurredCents: 0, committedCents: 5_000_000 });
    await markCostIncurred(db as never, { orgId: "o", projectId: "p", entryId: c.id, now: a.now });
    expect(await loadNonStockTotals(db as never, "o", "p")).toEqual({ incurredCents: 5_000_000, committedCents: 0 });
    await expect(markCostIncurred(db as never, { orgId: "o", projectId: "p", entryId: c.id, now: a.now })).rejects.toThrow(/open COMMITTED/);
    await expect(voidCostEntry(db as never, { orgId: "o", projectId: "p", entryId: c.id, actor: "m@x", reason: " " })).rejects.toThrow(/reason/);
    await voidCostEntry(db as never, { orgId: "o", projectId: "p", entryId: c.id, actor: "m@x", reason: "duplicate invoice", now: a.now });
    expect((await loadCostLedger(db as never, "o", "p"))!.totals.incurredCents).toBe(0);
    db.rows("projects")[0].status = "CLOSED";
    await expect(addCostEntry(db as never, { ...a, cost: { category: "OTHER_DIRECT", description: "x", amountRand: "1", state: "COMMITTED" } })).rejects.toThrow(/ACTIVE/);
  });
  it("indicative cost = Cin7 average cost x scope quantity; unknown (null) if any SKU has no positive cost", async () => {
    const db = new FakeDb();
    db.rows("projects").push({ id: "p", org_id: "o", status: "ACTIVE", baseline_snapshot: { lines: [{ lineRef: "1", sku: "NQCP137", description: "c", quantity: 1 }, { lineRef: "2", sku: "KNQPP014", description: "v", quantity: 2 }] } });
    db.rows("products").push({ org_id: "o", sku: "NQCP137", average_cost: "50" }, { org_id: "o", sku: "KNQPP014", average_cost: "107.4209" });
    expect(await indicativeScopeCost(db as never, "o", "p")).toBe(Math.round((50 + 2 * 107.4209) * 100));
    db.rows("products")[1].average_cost = "0";
    expect(await indicativeScopeCost(db as never, "o", "p")).toBeNull();
  });
});
