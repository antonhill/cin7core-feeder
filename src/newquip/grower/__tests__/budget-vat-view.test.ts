import { describe, expect, it } from "vitest";
import { buildBudgetQuote, type ProductCommercials } from "../quote-bridge";
import { resolveMapping } from "../mapping";
import { resolveVat } from "../tax";
import { splitBomLines, quantityProvenance } from "../bom-view";
import { calculateGrowerHouse } from "../calculate";
import { TOPIGS_GROWER_INPUT } from "../fixture";
import { computeLine } from "@/lib/quote-margin";

const prod = (sku: string, cost: number | null, price: number): ProductCommercials => ({ sku, name: sku, active: true, averageCost: cost, tierPrices: { Tier1: price } });
const cat = new Set(["F", "M"]);
const opts = { tierCode: "Tier1", taxRatePct: 15, taxInclusive: false };
const mapped = (keys: Record<string, string>) => new Map(Object.entries(keys).map(([k, sku]) => [k, resolveMapping(k as never, [], sku, cat)]));

describe("budget state (no misleading R0.00 quote)", () => {
  it("nothing priced → awaiting_pricing, not complete, zero priced lines", () => {
    const calc = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
    const b = buildBudgetQuote(calc.lines, new Map(), new Map(), opts);
    expect(b.state).toBe("awaiting_pricing");
    expect(b.pricedLineCount).toBe(0);
    expect(b.incomplete).toBe(true);
    expect(b.blockers.length).toBeGreaterThan(0);
  });
  it("some lines priced → partial (priced lines only), still incomplete", () => {
    const calc = calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, quantityOverrides: { feeder: 18 } });
    const b = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), new Map([["F", prod("F", 100, 200)]]), opts);
    expect(b.state).toBe("partial");
    expect(b.pricedLineCount).toBe(1);
    expect(b.incomplete).toBe(true);
    expect(b.totals.subtotalExTax).toBeGreaterThan(0);
  });
  it("all lines priced → complete", () => {
    const calc = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
    const only = calc.lines.filter((l) => l.itemKey === "feeder").map((l) => ({ ...l, projectQuantity: 216, quantityPerRoom: 18, basis: "manual_override" as const }));
    const b = buildBudgetQuote(only, mapped({ feeder: "F" }), new Map([["F", prod("F", 100, 200)]]), opts);
    expect(b.state).toBe("complete");
    expect(b.incomplete).toBe(false);
  });
  it("missing price / cost / quantity never become zero revenue", () => {
    const calc = calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, quantityOverrides: { feeder: 18 } });
    const noPrice = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), new Map([["F", { ...prod("F", 100, 200), tierPrices: {} }]]), opts);
    expect(noPrice.state).toBe("awaiting_pricing");
    expect(noPrice.lines.find((l) => l.itemKey === "feeder")!.revenueExTax).toBeNull();
    const noCost = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), new Map([["F", prod("F", null, 200)]]), opts);
    expect(noCost.lines.find((l) => l.itemKey === "feeder")!.estimatedCost).toBeNull();
    expect(noCost.incomplete).toBe(true);
  });
});

describe("VAT comes from the customer's Cin7 tax rule via the existing engine", () => {
  const rules = [{ name: "Standard Rate Sales", rate: 15 }, { name: "Standard Rate Purchases", rate: 14 }, { name: "Zero Rated", rate: 0 }];
  it("resolves by exact customer rule name — a fuzzy 'standard' match could pick the wrong rule", () => {
    expect(resolveVat("Standard Rate Sales", rules)).toEqual({ status: "resolved", ratePct: 15, ruleName: "Standard Rate Sales" });
    expect(resolveVat("Standard Rate Purchases", rules)).toMatchObject({ ratePct: 14 });
    // the old heuristic (first rule matching /standard/i) is order-dependent:
    const reordered = [rules[1], rules[0]];
    expect(reordered.find((r) => /standard/i.test(r.name))!.rate).toBe(14);
    expect(resolveVat("Standard Rate Sales", reordered)).toMatchObject({ ratePct: 15 });
  });
  it("no customer rule / unknown rule is surfaced, never defaulted to a rate", () => {
    expect(resolveVat(null, rules)).toEqual({ status: "no_customer_rule" });
    expect(resolveVat("  ", rules)).toEqual({ status: "no_customer_rule" });
    expect(resolveVat("Nope", rules)).toEqual({ status: "rule_not_found", ruleName: "Nope" });
  });
  it("tax arithmetic is the existing engine's: 15% on a line", () => {
    const vat = resolveVat("Standard Rate Sales", rules);
    if (vat.status !== "resolved") throw new Error("unreachable");
    const b = buildBudgetQuote(
      calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, quantityOverrides: { feeder: 10 } }).lines,
      mapped({ feeder: "F" }), new Map([["F", prod("F", 100, 200)]]), { ...opts, taxRatePct: vat.ratePct },
    );
    const expected = computeLine({ quantity: 120, unitPrice: 200, taxRatePct: 15, averageCost: 100 });
    expect(b.totals.taxTotal).toBeCloseTo(expected.taxAmount, 6);
    expect(b.totals.totalIncTax).toBeCloseTo(expected.totalIncTax, 6);
  });
});

describe("BOM view", () => {
  const calc = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
  it("unselected optional items are out of the primary BOM and counted", () => {
    const { primary, optionalNotSelected } = splitBomLines(calc.lines);
    expect(optionalNotSelected).toBe(7);
    expect(primary.some((l) => l.basis === "not_selected")).toBe(false);
    expect(primary.map((l) => l.itemKey)).toContain("feeder");
    expect(primary.map((l) => l.itemKey)).not.toContain("manure_plug");
  });
  it("a selected optional item appears in the primary BOM", () => {
    const c = calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, optionalEquipment: { ...TOPIGS_GROWER_INPUT.optionalEquipment, cone_fans: true } });
    expect(splitBomLines(c.lines).primary.map((l) => l.itemKey)).toContain("cone_fans");
    expect(splitBomLines(c.lines).optionalNotSelected).toBe(6);
  });
  it("a Topigs-reference override is explicitly manual and never a verified calculation", () => {
    const c = calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, quantityOverrides: { feeder: 18 } });
    const feeder = c.lines.find((l) => l.itemKey === "feeder")!;
    expect(quantityProvenance(feeder, "historic")).toBe("manual_topigs_reference");
    expect(quantityProvenance(feeder, "typed")).toBe("manual_entry");
    expect(quantityProvenance(feeder, "historic")).not.toBe("verified_calculation");
    expect(feeder.ruleStatus).toBe("requires_validation");
    expect(feeder.basis).not.toBe("system_calculated");
    expect(quantityProvenance(c.lines.find((l) => l.itemKey === "cup_drinker")!, undefined)).toBe("awaiting_validation");
  });
});
