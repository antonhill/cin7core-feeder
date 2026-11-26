// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CostReview } from "../[id]/CostReview";
import { buildCostReview, groupCostReview } from "@/newquip/quote/cost-review";

afterEach(cleanup);
const txt = (id: string) => screen.getByTestId(id).textContent!.replace(/[\u00a0\u202f]/g, " ");
// FICTITIOUS figures. A 45-component cooling package plus one single-product line.
const FR = "Commercial settings v8: TEST-ONLY freight assumption, not approved policy.";
const note = (i: number) => `Auto from Cin7: ${i}.00 USD last supplied 2026-05-01, +0.00% age escalation over 200 days (commercial settings v8). Needs verification.`;
const row = (sku: string, usedBy: string[], over: Record<string, unknown> = {}) => ({
  sku, usedBy, quantity: 2, status: "priced", supplier: "Fixture Supplier", supplierId: "s1", currency: "USD", nativeUnitCostE7: 100_000_000, costSource: note(1), costKind: "cin7_auto", costDate: "2026-05-01",
  costState: "unverified", costStateText: "x", enteredBy: null, enteredAt: null, review: null, priceBasis: "supplier_pricing", costHash: "h", currencySource: "cin7_supplier", currencyOverrideReason: null,
  rate: { currency: "USD", rateMicro: 18_000_000, kind: "spot", source: "feed", asOf: "2026-11-20T07:00:00Z", coverDays: null }, freightFactorMicro: 1_100_000, freightAddOnCents: null, freightSource: FR,
  unitLandedCostCents: 10_000, unitPriceCents: 12_000, priceOverride: null, lineRevenueCents: 24_000, lineCostCents: 20_000, margin: { marginPct: 16.7 }, issues: [], autoFlag: null, ...over,
});
const cooling = Array.from({ length: 45 }, (_, i) => row(`COOL${String(i + 1).padStart(3, "0")}`, ["cooling"], { costSource: note(i + 1) }));
const single = row("NQ1161", ["concrete_slat"], { freightSource: "Approved policy v3." });
const bundle = (rows: unknown[]) => ({ view: { rows } }) as never;
const budget = { lines: [{ itemKey: "cooling", label: "Sumpless pad cooling", sku: null, components: cooling.map((r) => ({ sku: r.sku, description: `Part ${r.sku}` })) }, { itemKey: "concrete_slat", label: "Concrete slats", sku: "NQ1161" }] } as never;

describe("Itemised cost review: grouped, compact, nothing hidden", () => {
  it("45 cooling products become ONE equipment-line summary with a record count, totals, and a single freight warning", () => {
    render(<CostReview bundle={bundle([...cooling, single])} budget={budget} />);
    expect(txt("cost-group-summary-0")).toContain("45 products · Total cost R 9 000,00 · Selling value R 10 800,00 ex VAT");
    expect(screen.getByTestId("cost-group-summary-0").textContent).toContain("0 verified · 45 need verification");
    expect(screen.getByTestId("cost-group-warnings-0").querySelectorAll("li").length).toBe(1);
    expect(screen.getByTestId("cost-group-warnings-0").textContent).toContain("TEST-ONLY assumption, not an approved policy.");
    expect(screen.queryByTestId("cost-group-warnings-1")).toBeNull(); // approved freight: no warning
    expect(screen.getByTestId("cost-group-details-0").querySelector("summary")!.textContent).toBe("View cost details · 45 records");
    expect((screen.getByTestId("cost-group-details-0") as HTMLDetailsElement).open).toBe(false);
  });
  it("the freight sentence is stated once per group, not once per product", () => {
    render(<CostReview bundle={bundle([...cooling, single])} budget={budget} />);
    expect((screen.getByTestId("cost-group-details-0").textContent!.match(/TEST-ONLY freight assumption/g) ?? []).length).toBe(1);
    expect(screen.getByTestId("cost-group-freight-0").textContent).toContain("all 45 products");
  });
  it("every product's row, supplier, cost, FX, freight, totals and its own cost note remain in the details", () => {
    render(<CostReview bundle={bundle([...cooling, single])} budget={budget} />);
    for (let i = 1; i <= 45; i++) {
      const t = txt(`cost-review-COOL${String(i).padStart(3, "0")}`);
      for (const x of ["Fixture Supplier (Cin7)", "USD 10", "USD 18.0000 · spot · 2026-11-20", "× 1.100", "R 200,00", "R 240,00", note(i)]) expect(t).toContain(x);
    }
  });
  it("a group with a missing cost opens by default and says so; a differing freight source stays beside its own product", () => {
    const miss = row("COOL999", ["cooling"], { status: "no_input", costState: "missing", supplier: null, currency: null, nativeUnitCostE7: null, costSource: null, rate: null, freightFactorMicro: null, freightSource: null, unitLandedCostCents: null, lineCostCents: null, lineRevenueCents: null, margin: null, autoFlag: { code: "no_cost", text: "No Cin7 cost.", action: "Enter one.", at: "x" } });
    render(<CostReview bundle={bundle([cooling[0], miss])} budget={budget} />);
    expect((screen.getByTestId("cost-group-details-0") as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId("cost-group-warnings-0").textContent).toContain("1 product has no supplier cost.");
    expect(screen.queryByTestId("cost-group-freight-0")).toBeNull();
    expect(screen.getByTestId("cost-review-COOL001").textContent).toContain(`Freight: ${FR}`);
  });
  it("groupCostReview totals are null (never partial) when a member's figure is unknown", () => {
    const rows = buildCostReview({ rows: [row("A", ["g"]), row("B", ["g"], { lineCostCents: null })] } as never, null).rows;
    const [g] = groupCostReview(rows);
    expect(g.totalCostCents).toBeNull(); expect(g.sellingCents).toBe(48_000);
  });
  it("a partly-unapproved group says how many; a shared SKU forms one combined group in a stable order; a cost with no supplier is not shown twice", () => {
    const rows = buildCostReview({ rows: [row("A", ["y", "x"]), row("B", ["x", "y"], { freightSource: "Approved policy v3." }), row("C", ["z"], { supplier: null, supplierId: null, costKind: null, costSource: "Quote Q-77" })] } as never, null).rows;
    const gs = groupCostReview(rows);
    expect(gs.map((g) => g.label)).toEqual(["x + y", "z"]);
    expect(gs[0].warnings).toEqual(["Freight uses a TEST-ONLY assumption, not an approved policy (1 of 2 products)."]);
    expect(gs[0].sharedFreightSource).toBeNull();
    expect(rows[2].sourceHead).toBe("Source recorded in the cost note");
  });
});
