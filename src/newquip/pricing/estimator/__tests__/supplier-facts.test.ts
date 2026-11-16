import { describe, expect, it } from "vitest";
import { hashOf } from "../../../quote/baseline";
import { normaliseSubmission, submissionFrom } from "../apply";
import { costInputHash } from "../verification";
import type { SkuPricingInput } from "../types";
import { equivalentInputs } from "./helpers";

const NOW = "2026-11-17T08:00:00Z";
const base = () => submissionFrom(equivalentInputs({}, "unverified"));
const withFacts = (facts: Record<string, unknown>) => { const s = structuredClone(base()); const k = Object.keys(s.skus)[0]; Object.assign(s.skus[k] as object, facts); return { s, k }; };

describe("the supplier-identity facts of a submitted cost", () => {
  it("are kept when valid: the Cin7 id, the currency basis, the kind and the date", () => {
    const { s, k } = withFacts({ supplierId: "S-1", currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10" });
    const r = normaliseSubmission(s, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skus[k]).toMatchObject({ supplierId: "S-1", currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10" });
  });
  it("a currency set by hand needs a reason of at least ten characters, which is kept (trimmed)", () => {
    const bad = withFacts({ currencySource: "override", currencyOverrideReason: "short" });
    const r1 = normaliseSubmission(bad.s, NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.join(" ")).toMatch(/currency set by hand needs a reason/);
    const ok = withFacts({ currencySource: "override", currencyOverrideReason: "  Cin7 holds none; the supplier invoices in USD.  " });
    const r2 = normaliseSubmission(ok.s, NOW);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.skus[ok.k].currencyOverrideReason).toBe("Cin7 holds none; the supplier invoices in USD.");
  });
  it("unknown currency bases, kinds (an age-adjusted kind does not exist) and malformed dates are refused, never guessed", () => {
    for (const [facts, msg] of [[{ currencySource: "zar_default" }, /currency basis is not valid/], [{ costKind: "age_adjusted" }, /kind of cost is not valid/], [{ costDate: "10/11/2026" }, /cost date must be a date/]] as const) {
      const { s } = withFacts(facts as Record<string, unknown>);
      const r = normaliseSubmission(s, NOW);
      expect(r.ok, JSON.stringify(facts)).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(msg);
    }
  });
  it("an older submission without any of these facts is still valid", () => { expect(normaliseSubmission(base(), NOW).ok).toBe(true); });
});

describe("the cost hash (what an independent verification covers)", () => {
  const legacy: SkuPricingInput = { supplierId: null, supplierName: "Old", currency: "EUR", nativeUnitCostE7: 268_440_995, source: "Quote", freight: { factorMicro: 1_100_000, source: "x" }, by: "e@x", at: "2026-11-10T00:00:00Z" };
  it("is EXACTLY what it always was for an entry without the new facts (every existing verification keeps applying)", () => {
    expect(costInputHash(legacy)).toBe(hashOf({ supplierId: null, supplierName: "Old", currency: "EUR", nativeUnitCostE7: 268_440_995, source: "Quote", freight: { factorMicro: 1_100_000, source: "x" } }));
  });
  it("changes when the supplier, the currency basis, the kind or the date changes, so an earlier verification stops applying", () => {
    const h = costInputHash(legacy);
    const withId = { ...legacy, supplierId: "S-1", currencySource: "cin7_supplier" as const, costKind: "supplier_quotation" as const, costDate: "2026-11-10" };
    expect(costInputHash(withId)).not.toBe(h);
    expect(costInputHash({ ...withId, supplierId: "S-2" })).not.toBe(costInputHash(withId));
    expect(costInputHash({ ...withId, costKind: "manual_estimate" })).not.toBe(costInputHash(withId));
    expect(costInputHash({ ...withId, costDate: "2026-11-11" })).not.toBe(costInputHash(withId));
    expect(costInputHash({ ...withId, currencySource: "override", currencyOverrideReason: "Cin7 holds none; invoices in EUR" })).not.toBe(costInputHash(withId));
  });
});
