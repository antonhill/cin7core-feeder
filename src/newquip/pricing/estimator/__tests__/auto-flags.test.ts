import { describe, expect, it } from "vitest";
import { applyPricingSubmission, normaliseSubmission, sanitiseAutoFlags, submissionFrom, type PricingSubmission } from "../apply";
import { buildPricingWorkspace } from "../workspace-view";
import type { EstimatorPricing } from "../types";
import { SUPPLIER_AUTO_RULE_VERSION, type Viewer } from "../../model";
import type { QuoteRole } from "@/newquip/quote/roles";

// The automatic-pricing reasons stored inside estimator.pricing: server-owned, bounded, carried over by every pricing save, cleared once a SKU has a cost, never accepted from a browser. FICTITIOUS FIGURES.
const NOW = "2026-11-17T09:00:00Z";
const VIEWER: Viewer = { roles: new Set<QuoteRole>(["estimator"]), canSeeCost: true };
const sku = (): PricingSubmission["skus"][string] => ({ supplierId: "S", supplierName: "S", currency: "ZAR", nativeUnitCostE7: 100_000_000, source: "test", freight: { factorMicro: 1_000_000, addOnCents: 0, source: "test" }, costKind: "cin7_auto", currencySource: "cin7_supplier", costDate: "2026-06-16" });
const sub = (skus: string[]): PricingSubmission => ({ ruleVersionId: SUPPLIER_AUTO_RULE_VERSION.id, skus: Object.fromEntries(skus.map((s) => [s, sku()])), fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: { markupBps: 2500, reason: "test markup" }, targetAdjustment: null });
const FLAGS = { B: { code: "not_read", internal: "Not read from Cin7 in this run: it will be retried.", at: NOW }, C: { code: "no_cost", internal: "Cin7 has no usable supplier cost.", at: NOW } };
const apply = (prior: EstimatorPricing | undefined, s: PricingSubmission, flags?: typeof FLAGS): EstimatorPricing => {
  const r = applyPricingSubmission(prior, s, VIEWER, "auto-pricing", NOW, "automatic test", "project", flags);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.next!;
};

describe("autoFlags round-trip", () => {
  it("are stored with the pricing, survive an Estimator's later save, and are dropped for a SKU once it has a cost", () => {
    const p1 = apply(undefined, sub(["A"]), FLAGS);
    expect(p1.autoFlags).toEqual(FLAGS);
    const p2 = applyPricingSubmission(p1, { ...submissionFrom(p1), projectMarkup: { markupBps: 3000, reason: "estimator change" } }, VIEWER, "estimator@test", NOW, "change markup", "project");
    expect(p2.ok && p2.next!.autoFlags).toEqual(FLAGS); // carried over untouched by a pricing save that does not mention them
    const p3 = apply(p1, sub(["A", "B"])); // B now has a cost
    expect(p3.autoFlags).toEqual({ C: FLAGS.C });
    expect(apply(p3, sub(["A", "B", "C"])).autoFlags).toBeUndefined(); // none left: the key is absent
  });
  it("a replacement list REPLACES the stored one; a flags-only change is a real change (so it is recorded)", () => {
    const p1 = apply(undefined, sub(["A"]), FLAGS);
    const r = applyPricingSubmission(p1, submissionFrom(p1), VIEWER, "auto-pricing", NOW, "automatic test", "project", { B: { ...FLAGS.B, code: "no_cost", internal: "Cin7 has no usable supplier cost." } });
    expect(r.ok && r.next!.autoFlags).toEqual({ B: { ...FLAGS.B, code: "no_cost", internal: "Cin7 has no usable supplier cost." } });
    expect(r.ok && r.changes.some((c) => c.path.startsWith("autoFlags"))).toBe(true);
  });
  it("a browser submission can never set them: the strict normaliser keeps only known keys", () => {
    const n = normaliseSubmission({ ...sub(["A"]), autoFlags: { A: { code: "x", internal: "forged", at: NOW } } }, NOW);
    expect(n.ok && Object.keys(n.value)).not.toContain("autoFlags");
    const p = apply(undefined, sub(["A"])); // an Estimator's own first save carries none
    expect(p.autoFlags).toBeUndefined();
  });
  it("sanitising bounds and drops malformed or reserved entries", () => {
    const out = sanitiseAutoFlags(undefined, { ok: { code: "c".repeat(100), internal: "i".repeat(900), at: "t".repeat(90) }, "__proto__": { code: "x", internal: "x", at: "x" }, "bad key!": { code: "x", internal: "x", at: "x" }, num: { code: 1 as never, internal: "x", at: "x" } }, new Set());
    expect(Object.keys(out ?? {})).toEqual(["ok"]);
    expect(out!.ok.code).toHaveLength(40); expect(out!.ok.internal).toHaveLength(300); expect(out!.ok.at).toHaveLength(40);
  });
  it("the workspace row names the stored reason and the action for a SKU with no cost, and none once it is priced", () => {
    const p = apply(undefined, sub(["A"]), FLAGS);
    const budget = { lines: [{ itemKey: "x", label: "X", status: "priced", sku: "A", quantity: 1, unitPrice: 1, revenueExTax: 1, components: undefined }, { itemKey: "y", label: "Y", status: "not_in_price_source", sku: "B", quantity: 1 }], totals: { subtotalExTax: 1 }, incomplete: true, charges: [] };
    const v = buildPricingWorkspace({ quoteType: "project", pricing: p, budget: budget as never, originalTotalCents: null, originalCapturedAt: null, nowIso: NOW });
    expect(v.rows.find((r) => r.sku === "B")!.autoFlag).toMatchObject({ code: "not_read", text: FLAGS.B.internal });
    expect(v.rows.find((r) => r.sku === "A")!.autoFlag).toBeNull();
    expect(v.autoOwned).toBe(false); // the entry was stamped by 'auto-pricing', not the auto actor, in this fixture
    expect(v.attention.join(" ")).toContain("B: Not read from Cin7");
  });
});
