import { describe, expect, it } from "vitest";
import type { IndicativeSnapshot } from "../../pricing/indicative-snapshot";
import { compareRepRevisions, previousHandoffOf } from "../rep-revision-changes";

type CS = IndicativeSnapshot["customerSafe"];
type L = CS["lines"][number];
const line = (itemKey: string, label: string, quantity: number, unit: number, over: Partial<L> = {}): L => ({ itemKey, label, status: "priced", sku: `SECRET-SKU-${itemKey}`, quantity, unitPriceExVat: unit, revenueCents: Math.round(quantity * unit * 100), pricedBy: "estimator" as L["pricedBy"], ...over });
const snap = (lines: L[], charges: CS["charges"] = [], revision = 1): CS => {
  const sub = lines.reduce((a, l) => a + (l.revenueCents ?? 0), 0) + charges.reduce((a, c) => a + (c.amountCents ?? 0), 0);
  return { quoteRef: "NQ-Q-T", revision, quoteType: "project", completeness: "complete" as CS["completeness"], awaiting: ["internal cost wording"], lines, charges, subtotalCents: sub, taxCents: Math.round(sub * 0.15), totalCents: Math.round(sub * 1.15), taxRule: "VAT", taxRateBps: 1500, taxInclusive: false };
};
const cmp = (previous: CS | null, current: CS | null) => compareRepRevisions({ previous, previousCapturedAt: "2026-11-26T10:00:00Z", current, currentRevision: 2, currentDraftHash: "h2" });
const base = () => snap([line("a", "Feeder", 10, 100), line("b", "Drinker", 4, 50), line("c", "Light", 2, 25)], [{ key: "delivery", label: "Delivery", amountCents: 100000, status: "entered" }]);
const kinds = (r: ReturnType<typeof cmp>) => Object.fromEntries(r.lines.map((l) => [l.key, l.kind]));

describe("Rep revision comparison scenarios", () => {
  it("1 selling price only", () => {
    const r = cmp(base(), snap([line("a", "Feeder", 10, 110), line("b", "Drinker", 4, 50), line("c", "Light", 2, 25)], base().charges));
    expect(kinds(r)).toEqual({ a: "changed", b: "unchanged", c: "unchanged" });
    expect(r.lines[0].fields).toEqual(["Selling unit price", "Selling line total"]);
    expect(r.lines[0].deltaCents).toBe(10000);
    expect(r.deltaExVatCents).toBe(10000);
    expect(r.deltaPercent).toBe(Math.round((10000 / r.before!.subtotalExVatCents) * 1000) / 10);
    expect(r.anyChange).toBe(true);
  });
  it("2 quantity", () => {
    const r = cmp(base(), snap([line("a", "Feeder", 12, 100), line("b", "Drinker", 4, 50), line("c", "Light", 2, 25)], base().charges));
    expect(r.lines[0].fields).toEqual(["Quantity", "Selling line total"]);
    expect(r.lines[0].before?.quantity).toBe(10); expect(r.lines[0].after?.quantity).toBe(12);
  });
  it("3 added and 4 removed", () => {
    const r = cmp(base(), snap([line("a", "Feeder", 10, 100), line("b", "Drinker", 4, 50), line("d", "Heater", 1, 500)], base().charges));
    expect(kinds(r)).toEqual({ d: "added", c: "removed", a: "unchanged", b: "unchanged" });
    expect(r.lines.slice(0, 2).map((l) => l.kind)).toEqual(["added", "removed"]); // changed first, unchanged last
    expect(r.lines.find((l) => l.key === "c")!.deltaCents).toBe(-5000);
  });
  it("5 specification (selection) change", () => {
    const r = cmp(base(), snap([line("a", "Feeder (stainless)", 10, 100), line("b", "Drinker", 4, 50), line("c", "Light", 2, 25)], base().charges));
    expect(r.lines[0].fields).toEqual(["Equipment selection"]);
  });
  it("6 several lines together", () => {
    const r = cmp(base(), snap([line("a", "Feeder", 11, 100), line("b", "Drinker", 4, 55), line("d", "Heater", 1, 500)], base().charges));
    expect(r.counts).toMatchObject({ added: 1, removed: 1, changed: 2, unchanged: 0 });
  });
  it("7 delivery / installation charge", () => {
    const r = cmp(base(), snap(base().lines, [{ key: "delivery", label: "Delivery", amountCents: 150000, status: "entered" }, { key: "installation", label: "Installation", amountCents: 400000, status: "entered" }]));
    expect(r.charges.map((c) => [c.key, c.kind, c.deltaCents])).toEqual([["installation", "added", 400000], ["delivery", "changed", 50000]]);
    expect(r.counts.charges).toBe(2); expect(r.anyChange).toBe(true);
  });
  it("9 nothing changed, even when the order and whitespace differ", () => {
    const shuffled = snap([line("c", "Light ", 2, 25), line("a", "Feeder", 10, 100), line("b", "Drinker", 4, 50.0000001)], base().charges);
    const r = cmp(base(), shuffled);
    expect(r.anyChange).toBe(false); expect(r.counts).toMatchObject({ added: 0, removed: 0, changed: 0, unchanged: 3, charges: 0 }); expect(r.deltaExVatCents).toBe(0);
  });
  it("a not_selected line is not on either quotation", () => {
    const r = cmp(snap([line("a", "Feeder", 1, 10), line("z", "Off", 0, 0, { status: "not_selected", revenueCents: null, unitPriceExVat: null })]), snap([line("a", "Feeder", 1, 10)]));
    expect(r.lines).toHaveLength(1); expect(r.anyChange).toBe(false);
  });
  it("a line that loses its price is a status change, never a false zero", () => {
    const r = cmp(snap([line("a", "Feeder", 1, 10)]), snap([line("a", "Feeder", 1, 0, { status: "needs_input", revenueCents: null, unitPriceExVat: null })]));
    expect(r.lines[0].fields).toContain("Price status"); expect(r.lines[0].deltaCents).toBeNull(); expect(r.lines[0].after?.lineTotalCents).toBeNull();
  });
  it("no previous snapshot: unavailable, never invented", () => {
    const r = cmp(null, base());
    expect(r).toMatchObject({ available: false, unavailableReason: "NO_SNAPSHOT", lines: [], anyChange: false, before: null, deltaExVatCents: null });
  });
  it("nothing priced now", () => expect(cmp(base(), null)).toMatchObject({ available: false, unavailableReason: "NOT_PRICED" }));
});

describe("previousHandoffOf (multiple returns)", () => {
  const s = (seq: number, revision: number) => ({ seq, revision });
  it("picks the latest handoff before the current revision", () => {
    expect(previousHandoffOf([s(1, 1), s(2, 2), s(3, 3)], 3)).toEqual({ snapshot: s(2, 2), gap: false });
    expect(previousHandoffOf([s(1, 1), s(2, 2)], 2)).toEqual({ snapshot: s(1, 1), gap: false });
  });
  it("ignores a snapshot of the current or a later revision", () => expect(previousHandoffOf([s(1, 1), s(2, 2)], 2).snapshot).toEqual(s(1, 1)));
  it("flags a gap when the immediately previous revision has no snapshot", () => expect(previousHandoffOf([s(1, 1)], 3)).toEqual({ snapshot: s(1, 1), gap: true }));
  it("none", () => expect(previousHandoffOf([], 2)).toEqual({ snapshot: null, gap: false }));
});

describe("confidentiality by construction", () => {
  it("the output carries no sku, pricedBy, awaiting, cost or internal field", () => {
    const withInternal = { ...base(), internal: { estimatedCostCents: 99999999, lineCosts: [{ itemKey: "a", estimatedCostCents: 123456 }], priceSource: { provenance: "SECRET-WORKBOOK" } } } as unknown as CS;
    const out = JSON.stringify(cmp(withInternal, snap([line("a", "Feeder", 11, 100), line("b", "Drinker", 4, 50), line("c", "Light", 2, 25)], base().charges)));
    for (const bad of ["SECRET-SKU", "SECRET-WORKBOOK", "internal cost wording", "pricedBy", "estimatedCost", "lineCosts", "99999999", "123456", "sku", "estimator\""]) expect(out).not.toContain(bad);
  });
});
