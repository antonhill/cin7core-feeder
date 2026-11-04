import { describe, expect, it } from "vitest";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft, type QuoteEvaluation } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { applyMappingLibrary, effectiveScope } from "@/lib/projects/product-scope";
import { buildAcceptedBaseline, commercialLinesOf, type BaselineCommercialLine } from "../baseline";
import { buildPhysicalScope } from "../physical-scope";
import { baselineExceptionView, baselineMappingGate, estimatorPricedUnmapped, exceptionDecisionText, validateExceptionReason } from "../baseline-exception";

const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false };
const base = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const lines = commercialLinesOf(evaluateDraft(base, ctx).budget!);
// The LED package (a typed price) is MAPPED through the library; M75 and penning have no Cin7 SKU by design.
const LIB = new Map([["led_light", { packageKey: "led_light", version: 1, lines: [{ sku: "TEST-FORTIS-LED", factor: 1, unit: "each", role: "FINISHED_GOOD" as const }] }]]);
const scopeOf = (ls: readonly BaselineCommercialLine[], lib = true) => (lib ? applyMappingLibrary(buildPhysicalScope(ls), LIB, "2026-11-03T00:00:00.000Z") : buildPhysicalScope(ls));
const costsFor = (ls: readonly BaselineCommercialLine[], lib = true) => Object.fromEntries(effectiveScope(scopeOf(ls, lib)).lines.map((l) => [l.sku, { unitCostCents: 1000, source: "MANUAL_ESTIMATE" as const, retrievedAt: "t", reason: "r" }]));
const costed = { ...base, estimator: { ...base.estimator, physicalCosts: costsFor(lines) } } as typeof base;
const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "rep@a", estimatorSignoffBy: "est@a", estimatorSignoffAt: "t", managerApprovedBy: "mgr@a", managerApprovedAt: "2026-11-03T10:00:00.000Z" };
const REASON = "Estimator-priced by design; mapping follows the PO";
const freeze = (draft = costed, evaluation: QuoteEvaluation = evaluateDraft(draft, ctx), bx?: { reason: string; draftHash: string }, margin?: QuoteEvaluation, mappingLibrary: ReadonlyMap<string, never> | typeof LIB | undefined = LIB) =>
  buildAcceptedBaseline({ quoteRef: "NQ-Q-1", revision: 2, draft, evaluation, marginEvaluation: margin, mappingLibrary: mappingLibrary as typeof LIB, approvals, ...(bx ? { baselineException: bx } : {}) });

describe("estimatorPricedUnmapped", () => {
  it("lists exactly the Estimator-priced-by-design whole-line systems with no Cin7 SKU (M75 and penning)", () => {
    const got = estimatorPricedUnmapped(lines, scopeOf(lines));
    expect(got.map((g) => g.item.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
    expect(got.map((g) => g.item.pricedBy).sort()).toEqual(["estimator_input", "penning_rate"]);
  });
  it("a package the Estimator merely TYPED a price for (estimator_resolution) is NOT waivable: it must be mapped", () => {
    const got = estimatorPricedUnmapped(lines, scopeOf(lines, false)); // LED unmapped, priced via an Estimator price resolution
    expect(got.map((g) => g.item.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
    expect(lines.find((l) => l.itemKey === "led_light")!.pricedBy).toBe("estimator_resolution");
  });
  it("never lists an unmapped product priced from the source, nor the remaining components of a partly mapped package", () => {
    const plain: BaselineCommercialLine = { itemKey: "feeder", label: "A product", sku: null, quantity: 1, unitPriceExVat: 10, revenueCents: 1000, pricedBy: "price_source", note: "" };
    expect(estimatorPricedUnmapped([plain], scopeOf([plain], false))).toEqual([]);
    const partial: BaselineCommercialLine = { itemKey: "flex_auger", label: "Pkg", sku: null, quantity: 1, unitPriceExVat: 10, revenueCents: 1000, pricedBy: "estimator_input", note: "",
      components: [{ sku: "REAL1", description: "real", quantity: 2, unitPriceExVat: 1, revenueCents: 200, status: "priced" }, { sku: null, description: "loose", quantity: null, unitPriceExVat: null, revenueCents: null, status: "identity_unresolved" }] };
    expect(estimatorPricedUnmapped([partial], scopeOf([partial], false))).toEqual([]); // "(remaining components)" is not a whole Estimator-priced system
  });
});

describe("the mapping gate", () => {
  const gate = (o: { lib?: boolean; costs?: Record<string, unknown>; costEx?: boolean } = {}) => {
    const lib = o.lib ?? true;
    return baselineMappingGate({ lines, scope: scopeOf(lines, lib), physicalCosts: (o.costs ?? costsFor(lines, lib)) as never, costExceptionAccepted: o.costEx ?? false });
  };
  it("blocked, and a Manager exception is required and sufficient, when only Estimator-priced-by-design systems are unmapped", () => {
    expect(gate()).toMatchObject({ blocked: true, required: true, remainingPackages: [], missingSkus: [] });
    expect(gate().items.map((i) => i.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
  });
  it("COST EXCEPTION + by-design unmapped systems => the Manager exception is STILL required", () => {
    expect(gate({ costEx: true })).toMatchObject({ blocked: true, required: true });
  });
  it("COST EXCEPTION + a genuinely unmapped product (typed price) => still blocked and an exception is not sufficient", () => {
    const g = gate({ lib: false, costEx: true });
    expect(g).toMatchObject({ blocked: true, required: false });
    expect(g.remainingPackages).toHaveLength(1);
    expect(baselineExceptionView(g).otherBlockers[0]).toMatch(/LED light/);
  });
  it("no cost exception + missing supplier cost => not sufficient (the costing gate / supplier cost still block)", () => {
    const missing = { ...costsFor(lines) }; delete missing[Object.keys(missing)[0]];
    expect(gate({ costs: missing })).toMatchObject({ blocked: true, required: false });
    expect(gate({ costs: missing }).missingSkus).toHaveLength(1);
  });
  it("the cost exception waives missing supplier costs (cost reasons only)", () => {
    const missing = { ...costsFor(lines) }; delete missing[Object.keys(missing)[0]];
    expect(gate({ costs: missing, costEx: true })).toMatchObject({ blocked: true, required: true, missingSkus: [] });
  });
  it("applies WHETHER OR NOT costing was ever started, and whether or not the Estimator recorded a cost exception", () => {
    expect(gate({ costs: {} })).toMatchObject({ estimate: undefined, blocked: true, required: true });
    expect(gate({ costs: {}, costEx: true })).toMatchObject({ estimate: undefined, blocked: true, required: true });
    expect(gate({ costs: {}, costEx: true }).items.map((i) => i.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
  });
  it("uncosted: a genuinely unmapped package still blocks and the exception is not sufficient", () => {
    expect(gate({ lib: false, costs: {}, costEx: true })).toMatchObject({ blocked: true, required: false });
  });
  it("the view carries the Estimator's cost exception read-only for context", () => {
    const ex = { reason: "Supplier choice follows the PO", by: "est@a", at: "t" };
    expect(baselineExceptionView(gate({ costEx: true }), ex).costException).toEqual(ex);
    expect(baselineExceptionView(gate()).costException).toBeNull();
  });
});

describe("buildAcceptedBaseline", () => {
  const withCostEx = { ...costed, estimator: { ...costed.estimator, costBasis: { incompleteAccepted: { reason: "r", by: "e", at: "t" } } } } as typeof costed;
  it("refuses with the existing message when there is no exception (the rule is unchanged)", () => {
    expect(() => freeze()).toThrow(/2 package\(s\) are not mapped to Cin7 SKUs/);
  });
  it("the Estimator's cost exception alone no longer frees unmapped packages", () => {
    expect(() => freeze(withCostEx)).toThrow(/2 package\(s\) are not mapped to Cin7 SKUs/);
  });
  it("freezes with a valid exception and seals the record (items, reason, approver, time, version) into the baseline hash", () => {
    const a = freeze(costed, undefined, { reason: REASON, draftHash: "abc123" });
    const ex = a.baseline.exceptions!;
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ reason: REASON, approvedBy: "mgr@a", approvedAt: "2026-11-03T10:00:00.000Z", version: { quoteRef: "NQ-Q-1", revision: 2, draftHash: "abc123" } });
    expect(ex[0].unresolved.map((u) => u.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
    expect(Object.isFrozen(ex[0])).toBe(true);
    const b = freeze(costed, undefined, { reason: REASON + " (edited)", draftHash: "abc123" });
    expect(b.hash).not.toBe(a.hash); // the record is part of the seal
    expect(exceptionDecisionText(ex[0])).toContain("Accepted incomplete: Estimator-priced systems without Cin7 SKU mapping");
  });
  it("cost exception + Manager exception freezes, both recorded", () => {
    const a = freeze(withCostEx, undefined, { reason: REASON, draftHash: "h" });
    expect(a.baseline.exceptions).toHaveLength(1);
    expect(a.baseline.physicalCostEstimate?.costBasis?.incompleteAccepted).toBeTruthy();
  });
  it("waives ONLY the Estimator-priced systems: a package with an Estimator-typed price still refuses, even with both exceptions", () => {
    expect(() => freeze(costed, undefined, { reason: REASON, draftHash: "h" }, undefined, undefined)).not.toThrow();
    const noLib = { ...costed, estimator: { ...costed.estimator, physicalCosts: costsFor(lines, false) } } as typeof costed;
    expect(() => freeze(noLib, undefined, { reason: REASON, draftHash: "h" }, undefined, new Map() as never)).toThrow(/1 package\(s\) are not mapped to Cin7 SKUs/);
    const noLibCost = { ...noLib, estimator: { ...noLib.estimator, costBasis: { incompleteAccepted: { reason: "r", by: "e", at: "t" } } } } as typeof costed;
    expect(() => freeze(noLibCost, undefined, { reason: REASON, draftHash: "h" }, undefined, new Map() as never)).toThrow(/1 package\(s\) are not mapped to Cin7 SKUs/);
    expect(() => freeze(noLibCost, undefined, undefined, undefined, new Map() as never)).toThrow(/3 package\(s\) are not mapped to Cin7 SKUs/);
  });
  it("does not waive a missing supplier cost", () => {
    const missing = { ...costed.estimator.physicalCosts! }; delete missing[Object.keys(missing)[0]];
    const d = { ...costed, estimator: { ...costed.estimator, physicalCosts: missing } } as typeof costed;
    expect(() => freeze(d, undefined, { reason: REASON, draftHash: "h" })).toThrow(/no supplier cost selected/);
  });
  it("needs a real reason, and refuses an exception that does not apply", () => {
    expect(() => freeze(costed, undefined, { reason: "short", draftHash: "h" })).toThrow(/written reason/);
    const allMapped = new Map([...LIB, ["flex_auger", { ...LIB.get("led_light")!, packageKey: "flex_auger" }], ["penning_package", { ...LIB.get("led_light")!, packageKey: "penning_package" }]]);
    const mappedDraft = { ...costed, estimator: { ...costed.estimator, costBasis: { incompleteAccepted: { reason: "r", by: "e", at: "t" } } } } as typeof costed; // cost exception waives the missing costs of the new SKUs
    expect(() => freeze(mappedDraft, undefined, { reason: REASON, draftHash: "h" }, undefined, allMapped)).toThrow(/No baseline exception applies/);
    expect(freeze(mappedDraft, undefined, undefined, undefined, allMapped).baseline.exceptions).toBeUndefined();
  });
  it("UNCOSTED quotation + Estimator cost exception: plain freeze refused; the Manager exception freezes it and SEALS the record", () => {
    const uncosted = { ...base, estimator: { ...base.estimator, costBasis: { incompleteAccepted: { reason: "r", by: "e", at: "t" } } } } as typeof base;
    expect(uncosted.estimator.physicalCosts).toBeUndefined();
    expect(() => freeze(uncosted)).toThrow(/2 package\(s\) are not mapped to Cin7 SKUs/);
    const f = freeze(uncosted, undefined, { reason: REASON, draftHash: "h9" });
    expect(f.baseline.physicalCostEstimate).toBeUndefined(); // nothing was costed, and nothing is invented
    expect(f.baseline.exceptions).toHaveLength(1);
    expect(f.baseline.exceptions![0]).toMatchObject({ reason: REASON, approvedBy: "mgr@a", version: { quoteRef: "NQ-Q-1", revision: 2, draftHash: "h9" } });
    expect(f.baseline.exceptions![0].unresolved.map((u) => u.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
    // a genuinely unmapped package is still blocking, even uncosted and with both exceptions
    expect(() => freeze(uncosted, undefined, { reason: REASON, draftHash: "h9" }, undefined, new Map() as never)).toThrow(/1 package\(s\) are not mapped to Cin7 SKUs/);
  });
  it("validateExceptionReason bounds the text", () => {
    expect(validateExceptionReason("x".repeat(9))).toBeTruthy();
    expect(validateExceptionReason("x".repeat(10))).toBeNull();
    expect(validateExceptionReason("x".repeat(1001))).toBeTruthy();
  });
});

describe("D-19: unmapped products no exception can cover are exposed by name", () => {
  const gateNoLib = () => baselineMappingGate({ lines, scope: scopeOf(lines, false), physicalCosts: costsFor(lines, false) as never, costExceptionAccepted: false });
  it("blocking lists the typed-price (estimator_resolution) LED line with its pricing route, never a value; by-design systems stay in items", () => {
    const g = gateNoLib();
    expect(g.blocking).toEqual([{ label: expect.stringMatching(/LED light/), pricedBy: "estimator_resolution" }]);
    expect(g.items.map((i) => i.itemKey).sort()).toEqual(["flex_auger", "penning_package"]);
    expect(g.required).toBe(false); // an exception is NOT offered while a blocking item exists
    expect(Object.keys(g.blocking[0]).sort()).toEqual(["label", "pricedBy"]); // labels + route only: no price, cost or quantity
  });
  it("nothing blocking when only by-design systems are unmapped, or when everything is mapped", () => {
    expect(baselineMappingGate({ lines, scope: scopeOf(lines), physicalCosts: costsFor(lines) as never, costExceptionAccepted: false }).blocking).toEqual([]);
  });
  it("the view carries blocking (and only while the freeze is blocked)", () => {
    expect(baselineExceptionView(gateNoLib()).blocking).toEqual([{ label: expect.stringMatching(/LED light/), pricedBy: "estimator_resolution" }]);
  });
  it("the freeze refusal NAMES the blocking items and says an exception cannot cover them", () => {
    const noLib = { ...base, estimator: { ...base.estimator, physicalCosts: costsFor(lines, false) } } as typeof base;
    let msg = "";
    try { freeze(noLib, undefined, undefined, undefined, new Map() as never); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/package\(s\) are not mapped to Cin7 SKUs \(.*LED light/);
    expect(msg).toMatch(/need an active library mapping/);
    let msg2 = "";
    try { freeze(noLib, undefined, { reason: REASON, draftHash: "h" }, undefined, new Map() as never); } catch (e) { msg2 = (e as Error).message; }
    expect(msg2).toMatch(/\(.*LED light/); // even when an exception was offered
  });
});

describe("ROUND 4: the recorded exception can be read back from its decision text (Approvals page line)", () => {
  it("round-trips exceptionDecisionText: count, labels and reason", async () => {
    const { parseBaselineExceptionDecision, baselineExceptionLine } = await import("../baseline-exception");
    const items = estimatorPricedUnmapped(lines, scopeOf(lines, true)).map((g) => g.item);
    const text = exceptionDecisionText({ unresolved: items, reason: "Because. Reason: nested text" });
    const p = parseBaselineExceptionDecision(text)!;
    expect(p.count).toBe(2);
    expect(p.labels.sort()).toEqual(items.map((i) => i.label).sort());
    expect(p.reason).toBe("Because. Reason: nested text");
    expect(baselineExceptionLine({ count: 1, labels: ["X"] })).toBe("Accepted exception: 1 unmapped Estimator-priced system (X)");
  });
  it("is null for any other reason", async () => {
    const { parseBaselineExceptionDecision } = await import("../baseline-exception");
    for (const t of [null, undefined, "", "Looks right", "Accepted incomplete: something else"]) expect(parseBaselineExceptionDecision(t)).toBeNull();
  });
});
