import { describe, expect, it } from "vitest";
import type { BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { PricingWorkspaceView, SkuRow } from "@/newquip/pricing/estimator";
import { autoFlagAction } from "@/newquip/pricing/auto-costing";
import { buildWorkspace, money, taskStatusWord, type WorkspaceFacts } from "../estimator-workspace";

// A quotation priced automatically from Cin7: the Estimator sees THREE separate groups, and only genuine outstanding actions are counted. FICTITIOUS FIGURES.
const line = (o: Partial<BridgeLine> & { itemKey: string; label: string }): BridgeLine => ({ status: "priced", reason: "", sku: null, quantity: 1, unitPrice: null, revenueExTax: null, estimatedCost: null, estimatedGP: null, marginPct: null, pricedBy: null, ...o } as BridgeLine);
const comp = (id: string, sku: string | null) => ({ id, sku, description: id, qtyPerUnit: 1, quantity: 10, status: "priced", reason: "", unitPrice: null, revenueExTax: null, estimatedCost: null });
type Over = Partial<SkuRow> & { sku: string };
const autoRow = (o: Over): SkuRow => ({
  usedBy: ["x"], quantity: 1, status: "priced", costState: "unverified", costKind: "cin7_auto", supplier: "Fixture Supplier", currency: "EUR", nativeUnitCostE7: 100_000_000, costDate: "2026-06-16", costSource: "Auto from Cin7: 10.00 EUR last supplied 2026-06-16",
  rate: { currency: "EUR", rateMicro: 20_000_000, kind: "spot", source: "fix", asOf: "2026-11-16T07:00:00Z", coverDays: null }, freightFactorMicro: 1_150_000, freightAddOnCents: 0, unitLandedCostCents: 23_000, unitPriceCents: 28_750, autoFlag: null, issues: [], ...o,
} as unknown as SkuRow);
const missingRow = (sku: string, autoFlag: SkuRow["autoFlag"]): SkuRow => ({ sku, usedBy: ["x"], quantity: 1, status: "no_input", costState: "missing", costKind: null, supplier: null, currency: null, nativeUnitCostE7: null, costDate: null, costSource: null, rate: null, autoFlag, issues: [] } as unknown as SkuRow);
const flag = (code: string, text: string): NonNullable<SkuRow["autoFlag"]> => ({ code, text, action: autoFlagAction(code), at: "2026-11-17T09:00:00Z" });

function build(o: { rows: SkuRow[]; lines: BridgeLine[]; autoOwned?: boolean; canEdit?: boolean; confirmedPackages?: string[]; cin7?: { available: boolean; reason: string | null } }) {
  const budget = { lines: o.lines, totals: { subtotalExTax: 1000 }, incomplete: true, charges: [] } as unknown as BudgetQuote;
  const view = { rows: o.rows, costs: { required: o.rows.length, verified: 0 }, totals: { margin: null }, manualEvidence: [], autoOwned: o.autoOwned ?? true } as unknown as PricingWorkspaceView;
  const facts: WorkspaceFacts = { state: "ESTIMATOR_REVIEW", confirmedCents: null, signedOff: false, canEdit: o.canEdit ?? true, canReview: false, confirmedPackages: o.confirmedPackages ?? [], confirmedMappings: {}, ...(o.cin7 ? { cin7Pricing: o.cin7 } : {}) };
  return buildWorkspace({ budget, view, facts });
}
const priced = (itemKey: BridgeLine["itemKey"], label: string, sku: string) => line({ itemKey, label, status: "priced", sku, quantity: 10, unitPrice: 287.5, revenueExTax: 2875 });
const costNeeded = (itemKey: BridgeLine["itemKey"], label: string, sku: string) => line({ itemKey, label, status: "not_in_price_source", sku, quantity: 1 });

describe("Estimator workspace: automatic pricing is three clear groups with honest counts", () => {
  const rows = [autoRow({ sku: "NQ1161" }), autoRow({ sku: "PNQ082" }), missingRow("SYSH-2750-3", flag("not_read", "Not read from Cin7 in this run (out of time): it will be retried when the quotation is submitted, or use Price from Cin7."))];
  const lines = [priced("concrete_slat", "Concrete slats", "NQ1161"), priced("feeder", "CCM feeder", "PNQ082"), costNeeded("bulk_tank", "Bulk tank", "SYSH-2750-3")];
  const w = build({ rows, lines });

  it("an automatically priced product is under 'Ready for verification' with its supplier, cost, date, FX, freight, landed and selling price, and is NEVER a task", () => {
    expect(w.auto.ready.map((r) => r.id)).toEqual(["concrete_slat", "feeder"]);
    expect(w.auto.ready[0].skus[0]).toEqual({ sku: "NQ1161", supplier: "Fixture Supplier", currency: "EUR", cost: "EUR 10.00", costDate: "2026-06-16", fx: "EUR 20.0000 as of 2026-11-16", freight: "× 1.15", landed: money(230), selling: money(287.5), provenance: "Auto from Cin7: 10.00 EUR last supplied 2026-06-16 Exchange rate: fix." });
    expect(w.complete.filter((c) => c.autoReady).map((c) => c.id)).toEqual(["concrete_slat", "feeder"]);
    expect(w.complete[0].how).toContain("Automatically priced — awaiting Manager verification");
    expect(w.tasks.map((t) => t.id)).toEqual(["bulk_tank"]); // not 'supplier cost needed' for NQ1161 / PNQ082
  });
  it("the counts: 2 automatically priced, 0 need confirmation, 1 pricing exception", () => {
    expect(w.auto).toMatchObject({ autoPriced: 2, needConfirmation: 0 });
    expect(w.auto.exceptions).toHaveLength(1);
  });
  it("the exception carries the SPECIFIC stored reason and the corrective action", () => {
    expect(w.auto.exceptions[0]).toMatchObject({ sku: "SYSH-2750-3", taskId: "bulk_tank", retryable: true });
    expect(w.auto.exceptions[0].reason).toMatch(/Not read from Cin7 in this run/);
    expect(w.auto.exceptions[0].action).toMatch(/Price from Cin7/);
  });
  it("ONE obvious next action: price the retryable exception from Cin7", () => {
    expect(w.next).toMatchObject({ kind: "price_from_cin7", button: "Price from Cin7", headline: "Price 1 product from Cin7" });
    expect(w.auto.retryable).toBe(1);
  });
  it("a reason Cin7 cannot fix (no supplier cost) is NOT retryable: the next action is to enter the cost, with its own specific text", () => {
    const x = build({ rows: [missingRow("SYSH-2750-3", flag("no_cost", "Cin7 has no usable supplier cost (no_positive_cost)."))], lines: [costNeeded("bulk_tank", "Bulk tank", "SYSH-2750-3")] });
    expect(x.auto.exceptions[0]).toMatchObject({ retryable: false, reason: "Cin7 has no usable supplier cost (no_positive_cost)." });
    expect(x.auto.exceptions[0].action).toMatch(/enter a supplier quotation cost/);
    expect(x.next.kind).toBe("open_task");
  });
  it("each stored reason has its own corrective action (currency, rate, too old, freight policy)", () => {
    expect(autoFlagAction("currency_unknown")).toMatch(/currency/);
    expect(autoFlagAction("fx_missing")).toMatch(/exchange rate/);
    expect(autoFlagAction("cost_too_old")).toMatch(/current supplier quotation/);
    expect(autoFlagAction("settings_incomplete")).toMatch(/freight policy/);
  });
  it("the Price from Cin7 action is offered only to an Estimator on an automatically-owned quotation", () => {
    expect(build({ rows, lines, canEdit: false }).next.kind).not.toBe("price_from_cin7");
    expect(build({ rows, lines, autoOwned: false }).next.kind).not.toBe("price_from_cin7");
    expect(build({ rows, lines, autoOwned: false }).auto.canPrice).toBe(false);
  });
});

describe("decisions come first and cost-bearing components are never asked for again", () => {
  const rows = [autoRow({ sku: "NQ1380" }), autoRow({ sku: "NQ2784" }), missingRow("QCA00003", flag("not_read", "Not read from Cin7 in this run (out of time): it will be retried."))];
  const cup = line({ itemKey: "cup_drinker", label: "Cup drinker package", status: "package_unconfirmed", quantity: 648, components: [comp("cup", "QCA00003"), comp("pipe", "NQ1380"), comp("plate", "NQ2784")] as never });
  it("a package with one flagged component: needs confirmation (one count), the component is a pricing exception with its reason, and only that component is named as uncosted", () => {
    const w = build({ rows, lines: [cup] });
    expect(w.auto.needConfirmation).toBe(1);
    expect(w.auto.exceptions.map((e) => [e.sku, e.taskId, e.usedBy])).toEqual([["QCA00003", "cup_drinker", ["Cup drinker package"]]]);
    expect(w.tasks[0].why).toMatch(/cost the 1 component without a cost \(the others are already costed\)/);
    expect(w.next).toMatchObject({ kind: "open_task", taskId: "cup_drinker" }); // the confirmation comes before pricing from Cin7
  });
  it("a package whose components ALL have an automatic cost needs only its confirmation: status 'Confirmation needed', no cost asked", () => {
    const all = [autoRow({ sku: "NQ1380" }), autoRow({ sku: "NQ2784" }), autoRow({ sku: "QCA00003" })];
    const w = build({ rows: all, lines: [cup] });
    expect(w.tasks[0]).toMatchObject({ kind: "package", confirmOnly: true, action: "Confirm package" });
    expect(taskStatusWord(w.tasks[0])).toBe("Confirmation needed");
    expect(w.tasks[0].why).toMatch(/none is asked for again/);
    expect(w.auto.exceptions).toHaveLength(0);
    expect(w.next.headline).toBe("Confirm cup drinker package");
  });
  it("a chosen door whose SKU has no cost yet is an exception that Cin7 may price (the one next action once nothing else needs confirming)", () => {
    const door = line({ itemKey: "pvc_door", label: "PVC door", status: "not_in_price_source", sku: "NQ3444", quantity: 24 });
    const w = build({ rows: [autoRow({ sku: "NQ1161" }), missingRow("NQ3444", null)], lines: [priced("concrete_slat", "Concrete slats", "NQ1161"), door] });
    expect(w.auto.exceptions[0]).toMatchObject({ sku: "NQ3444", retryable: true });
    expect(w.auto.exceptions[0].reason).toBe("No supplier cost has been recorded for this product.");
    expect(w.next.kind).toBe("price_from_cin7");
  });
  const srvRows = [autoRow({ sku: "NQ1161" }), autoRow({ sku: "PNQ082" }), missingRow("SYSH-2750-3", flag("not_read", "Not read from Cin7 in this run (out of time): it will be retried."))];
  const srvLines = [priced("concrete_slat", "Concrete slats", "NQ1161"), priced("feeder", "CCM feeder", "PNQ082"), costNeeded("bulk_tank", "Bulk tank", "SYSH-2750-3")];
  it("the SERVER decides: where it says Price from Cin7 can run (even on a quotation a person has edited, flag or no flag) the action is offered; where it cannot, no action is offered and the plain-words reason is shown instead", () => {
    const on = build({ rows: srvRows, lines: srvLines, autoOwned: false, cin7: { available: true, reason: null } });
    expect(on.next.kind).toBe("price_from_cin7"); expect(on.auto.canPrice).toBe(true); expect(on.auto.unavailableReason).toBeNull();
    const why = "A Manager must complete the commercial settings (freight policy and exchange rates) before costs can be priced from Cin7.";
    const off = build({ rows: srvRows, lines: srvLines, autoOwned: true, cin7: { available: false, reason: why } });
    expect(off.next.kind).not.toBe("price_from_cin7"); expect(off.auto.canPrice).toBe(false); expect(off.auto.retryable).toBe(0);
    expect(off.auto.unavailableReason).toBe(why);
    const none = build({ rows: [missingRow("SYSH-2750-3", undefined as never)], lines: [costNeeded("bulk_tank", "Bulk tank", "SYSH-2750-3")], autoOwned: false, cin7: { available: false, reason: why } });
    expect(none.auto.exceptions[0].action).toBe("Enter the supplier cost yourself."); // never "Use Price from Cin7" where it cannot run
  });
});
