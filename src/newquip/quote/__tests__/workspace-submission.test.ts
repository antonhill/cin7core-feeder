import { describe, expect, it } from "vitest";
import { emptySubmission, LEGACY_RULE_VERSION, type PricingSubmission } from "@/newquip/pricing/estimator";
import { applyEditor, blankEditor, editorFrom, editorProblems, parseCostText, previewLine, revisionReason } from "../workspace-submission";

const NOW = "2026-11-15T10:00:00.000Z";
const filled = (over: Partial<ReturnType<typeof blankEditor>> = {}) => ({ ...blankEditor("ZAR"), costText: "193.60", source: "Supplier quote 12 Nov", supplierName: "Local Supplier", ...over });

describe("typed costs are exact and never rounded", () => {
  it("accepts up to 7 decimals and refuses more, zero and junk", () => {
    expect(parseCostText("6.5454755")).toEqual({ kind: "ok", value: 65_454_755 });
    expect(parseCostText("")).toEqual({ kind: "empty" });
    expect(parseCostText("6.54547551").kind).toBe("bad");
    expect(parseCostText("1,5").kind).toBe("bad");
    expect(editorProblems(filled({ costText: "0" }))[0]).toMatch(/zero cost/);
  });
});

describe("editor problems are plain words, and a foreign currency needs its rate", () => {
  it("a complete ZAR editor has none", () => { expect(editorProblems(filled())).toEqual([]); });
  it("USD without a rate names it; with a documented forward cover it needs contract, dates and reason", () => {
    expect(editorProblems(filled({ currency: "USD" })).join(" ")).toMatch(/USD spot rate/);
    const fwd = filled({ currency: "USD", fxMode: "forward" });
    expect(editorProblems(fwd).join(" ")).toMatch(/forward-cover rate.*contract reference.*YYYY-MM-DD.*why/);
    fwd.forward = { rateText: "16.9", coverDaysText: "90", reference: "FEC-1", validFrom: "2026-11-01", validUntil: "2027-01-30", reason: "Hedged for the order" };
    expect(editorProblems(fwd)).toEqual([]);
  });
  it("a selling-price override needs a price above zero and a reason", () => {
    expect(editorProblems(filled({ override: { on: true, priceText: "0", reason: "" } })).length).toBe(2);
  });
});

describe("applying the editor changes only this product", () => {
  const stored = (): PricingSubmission => { const s = emptySubmission(LEGACY_RULE_VERSION.id); s.skus["OTHER"] = { supplierId: null, supplierName: "X", currency: "ZAR", nativeUnitCostE7: 10_000_000, source: "old", freight: { factorMicro: 1_000_000, source: "old" } }; return s; };
  it("adds one SKU and leaves the others and the rule version untouched; the first save uses the legacy rule when pricing was off", () => {
    const next = applyEditor(stored(), "NQ1161", filled(), NOW)!;
    expect(Object.keys(next.skus).sort()).toEqual(["NQ1161", "OTHER"]);
    expect(next.skus.OTHER).toEqual(stored().skus.OTHER);
    expect(next.skus.NQ1161).toMatchObject({ currency: "ZAR", nativeUnitCostE7: 1_936_000_000, source: "Supplier quote 12 Nov", supplierName: "Local Supplier" });
    expect(applyEditor(null, "NQ1161", filled(), NOW)!.ruleVersionId).toBe(LEGACY_RULE_VERSION.id);
  });
  it("returns null while the editor has problems", () => { expect(applyEditor(stored(), "NQ1161", filled({ costText: "" }), NOW)).toBeNull(); });
  it("an unchanged spot rate keeps its recorded date; a changed one is dated now", () => {
    const e = filled({ currency: "USD", spotRateText: "16.5555", spotSource: "rate table" });
    const first = applyEditor(stored(), "NQ1161", e, "2026-11-14T08:00:00.000Z")!;
    const again = applyEditor(first, "NQ1161", e, NOW)!;
    expect(again.fxQuotes.USD.asOf).toBe("2026-11-14T08:00:00.000Z");
    const changed = applyEditor(first, "NQ1161", { ...e, spotRateText: "16.6" }, NOW)!;
    expect(changed.fxQuotes.USD.asOf).toBe(NOW);
  });
  it("an override is written, and removed again when switched off", () => {
    const on = applyEditor(stored(), "NQ1161", filled({ override: { on: true, priceText: "250", reason: "Customer deal" } }), NOW)!;
    expect(on.skuPriceOverrides.NQ1161).toEqual({ unitPriceCents: 25_000, reason: "Customer deal" });
    expect(applyEditor(on, "NQ1161", filled(), NOW)!.skuPriceOverrides.NQ1161).toBeUndefined();
  });
  it("reopening reads back exactly what was stored", () => {
    const sub = applyEditor(stored(), "NQ1161", filled({ addOnText: "12.50", freightFactorText: "1.15" }), NOW)!;
    const e = editorFrom(sub, "NQ1161");
    expect(e).toMatchObject({ costText: "193.6", source: "Supplier quote 12 Nov", supplierName: "Local Supplier", freightFactorText: "1.15", addOnText: "12.50" });
  });
});

describe("the preview is the pricing model's own result", () => {
  it("193.60 landed at the 20% rule prices at R232.32 each and never from partly typed values", () => {
    const sub = applyEditor(null, "NQ1161", filled(), NOW)!;
    const pv = previewLine(sub, "NQ1161", 100, NOW)!;
    expect(pv.landedCents).toBe(19_360);
    expect(pv.priceCents).toBe(23_232);
    expect(pv.lineRevenueCents).toBe(2_323_200);
    expect(pv.margin?.marginPct).toBeCloseTo(16.67, 1);
    expect(previewLine(null, "NQ1161", 1, NOW)).toBeNull();
  });
});

it("the revision reason is deterministic and bounded", () => {
  expect(revisionReason("supplier cost for NQ1161")).toBe("Estimator workspace: supplier cost for NQ1161");
  expect(revisionReason("x".repeat(900)).length).toBe(500);
});
