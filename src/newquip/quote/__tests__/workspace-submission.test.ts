import { describe, expect, it } from "vitest";
import { emptySubmission, LEGACY_RULE_VERSION, type PricingSubmission } from "@/newquip/pricing/estimator";
import { applyEditor, blankEditor, editorFrom, editorProblems, fxContext, parseCostText, previewLine, revisionReason } from "../workspace-submission";

const NOW = "2026-11-15T10:00:00.000Z";
// A complete editor names a Cin7 supplier by id, takes its currency from that supplier's Cin7 record and says what kind of cost it is.
const filled = (over: Partial<ReturnType<typeof blankEditor>> = {}) => ({ ...blankEditor("ZAR"), supplierId: "S-LOCAL", currencySource: "cin7_supplier" as const, costKind: "manual_estimate" as const, costText: "193.60", source: "Supplier quote 12 Nov", supplierName: "Local Supplier", ...over });

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

describe("rates are stored per currency: one product's form never deletes another product's forward cover", () => {
  const sharedForward = (): PricingSubmission => {
    const s = emptySubmission(LEGACY_RULE_VERSION.id);
    for (const k of ["NQA", "NQB"]) s.skus[k] = { supplierId: null, supplierName: "X", currency: "USD", nativeUnitCostE7: 10_000_000, source: "old", freight: { factorMicro: 1_000_000, source: "old" } };
    s.forwardCover.USD = { rateMicro: 16_900_000, coverDays: 90, reason: "hedged", reference: "FEC-1", validFrom: "2026-11-01", validUntil: "2027-01-30" };
    return s;
  };
  const spot = (): ReturnType<typeof blankEditor> => ({ ...blankEditor("USD"), supplierId: "CUR-USD", supplierName: "Cin7 Supplier USD", currencySource: "cin7_supplier", costKind: "manual_estimate", costText: "6.5", source: "quote", fxMode: "spot", spotRateText: "16.5", spotSource: "rate table" });
  it("switching one product to a spot rate while another still uses the contract is refused in words, and nothing is applied", () => {
    const cur = sharedForward();
    expect(fxContext(cur, "NQA", "USD")).toEqual({ others: ["NQB"], hasForward: true });
    expect(editorProblems(spot(), fxContext(cur, "NQA", "USD")).join(" ")).toMatch(/forward-cover contract is in force for USD and also prices NQB/);
    expect(applyEditor(cur, "NQA", spot(), NOW)).toBeNull();
    expect(cur.forwardCover.USD).toBeDefined();
  });
  it("when no other product uses the currency, switching to spot does replace the contract", () => {
    const cur = sharedForward(); delete cur.skus.NQB;
    const next = applyEditor(cur, "NQA", spot(), NOW)!;
    expect(next.forwardCover.USD).toBeUndefined();
    expect(next.fxQuotes.USD.rateMicro).toBe(16_500_000);
  });
  it("editing the shared forward cover changes it for the currency (the form says so) and leaves the other product's own cost untouched", () => {
    const cur = sharedForward();
    const e = editorFrom(cur, "NQA");
    expect(e.fxMode).toBe("forward");
    expect(applyEditor(cur, "NQA", { ...e, forward: { ...e.forward, rateText: "17.1" } }, NOW)).toBeNull(); // an older entry has no Cin7 supplier: changing it means choosing one
    const next = applyEditor(cur, "NQA", { ...e, supplierId: "CUR-USD", supplierName: "Cin7 Supplier USD", currencySource: "cin7_supplier", costKind: "manual_estimate", forward: { ...e.forward, rateText: "17.1" } }, NOW)!;
    expect(next.forwardCover.USD.rateMicro).toBe(17_100_000);
    expect(next.skus.NQB).toEqual(cur.skus.NQB);
  });
});

describe("the supplier identity is part of the editor", () => {
  it("a blank editor has no supplier and NO currency (nothing is defaulted to ZAR)", () => {
    const b = blankEditor();
    expect([b.supplierId, b.currency, b.currencySource, b.costKind]).toEqual([null, "", null, null]);
    expect(editorProblems(b).join(" ")).toMatch(/Choose the supplier from Cin7/);
  });
  it("a supplier with a Cin7 currency needs no typed currency; one without needs the override reason and a chosen currency", () => {
    expect(editorProblems(filled({ currencySource: null }))[0]).toMatch(/currency is set from the supplier's Cin7 record/);
    const noCur = filled({ currency: "", currencySource: "override" as const });
    expect(editorProblems(noCur).join(" ")).toMatch(/say why you are setting it by hand/);
    expect(editorProblems({ ...noCur, currencyOverrideReason: "Cin7 record is empty; invoices in rand" }).join(" ")).toMatch(/Choose the currency the supplier invoices in/);
    expect(editorProblems({ ...noCur, currency: "ZAR", currencyOverrideReason: "Cin7 record is empty; invoices in rand" })).toEqual([]);
  });
  it("a cost needs its kind; a quotation needs a valid, not-future date; a manual estimate and a Cin7 price need none", () => {
    expect(editorProblems(filled({ costKind: null })).join(" ")).toMatch(/what kind of cost/);
    expect(editorProblems(filled({ costKind: "supplier_quotation" })).join(" ")).toMatch(/date of the supplier quotation/);
    expect(editorProblems(filled({ costKind: "supplier_quotation", costDate: "2999-01-01" })).join(" ")).toMatch(/cannot be in the future/);
    expect(editorProblems(filled({ costKind: "supplier_quotation", costDate: "2026-11-10" }))).toEqual([]);
    expect(editorProblems(filled({ costKind: "cin7_historical", costDate: "" }))).toEqual([]);
  });
  it("applying writes the Cin7 id, the currency basis (and the override reason only when it is one), the kind and the date; an undated Cin7 cost stays undated", () => {
    const quote = applyEditor(null, "NQ1161", filled({ costKind: "supplier_quotation", costDate: "2026-11-10" }), NOW)!.skus.NQ1161;
    expect(quote).toMatchObject({ supplierId: "S-LOCAL", supplierName: "Local Supplier", currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10" });
    expect(quote).not.toHaveProperty("currencyOverrideReason");
    const over = applyEditor(null, "NQ1161", filled({ currencySource: "override", currencyOverrideReason: " Cin7 holds none; invoices in rand " }), NOW)!.skus.NQ1161;
    expect(over).toMatchObject({ currencySource: "override", currencyOverrideReason: "Cin7 holds none; invoices in rand" });
    expect(applyEditor(null, "NQ1161", filled({ costKind: "cin7_historical", costDate: "" }), NOW)!.skus.NQ1161.costDate).toBeNull();
  });
  it("reopening reads the identity back exactly", () => {
    const stored = applyEditor(null, "NQ1161", filled({ costKind: "supplier_quotation", costDate: "2026-11-10" }), NOW)!;
    const e = editorFrom(stored, "NQ1161");
    expect(e).toMatchObject({ supplierId: "S-LOCAL", supplierName: "Local Supplier", currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10", currency: "ZAR" });
  });
});
