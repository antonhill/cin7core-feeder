import { describe, expect, it } from "vitest";
import { micro } from "../../model";
import { legacyCostCoveredBy, legacyCostCoverageFor } from "../legacy-cost-coverage";
import { rateInputHash } from "../attestation";
import { costInputHash } from "../verification";
import type { EstimatorPricing, SkuPricingInput, StoredForwardCover } from "../types";
import { AT, EST, REVIEWER, equivalentInputs } from "./helpers";

// WHICH LEGACY "NO SUPPLIER COST SELECTED" REASONS THE PHASE 2 PRICING SATISFIES. Covered only by the CURRENT, independently verified, complete cost of exactly that SKU. Every other case stays listed.

const NOW = "2026-11-12T10:00:00.000Z"; // two hours after the fixtures' AT
const base = (): EstimatorPricing => equivalentInputs({}, "verified");
const sku = (p: EstimatorPricing, s: string): SkuPricingInput => p.skus[s]!;
const firstOf = (p: EstimatorPricing, currency: string) => Object.keys(p.skus).find((k) => p.skus[k]!.currency === currency)!;
const covers = (p: EstimatorPricing | undefined, skus: string[], now = NOW) => [...legacyCostCoveredBy(p, skus, now)].sort();
const reviewed = (e: SkuPricingInput, by = REVIEWER): SkuPricingInput => ({ ...e, review: { by, at: AT, evidence: "Supplier quote", inputHash: costInputHash(e) } });
const attested = (cur: string, f: StoredForwardCover, by = REVIEWER): StoredForwardCover => ({ ...f, review: { by, at: AT, evidence: "Bank FEC confirmation", inputHash: rateInputHash(cur, f) } });
const fc = (over: Partial<StoredForwardCover> = {}): StoredForwardCover => ({ rateMicro: micro("19"), coverDays: 90, reference: "FEC-1", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day contract", by: EST, at: AT, ...over });

describe("covered: complete, independently verified supplier costs of exactly the requested SKUs", () => {
  it("covers every SKU whose current cost is verified, has freight and a usable rate", () => {
    const p = base();
    const all = Object.keys(p.skus);
    expect(covers(p, all)).toEqual([...all].sort());
  });
  it("returns ONLY SKUs it was asked about, never more (the caller derives the list from the current scope)", () => {
    const p = base();
    const [a, b] = Object.keys(p.skus);
    expect(covers(p, [a])).toEqual([a]);
    expect(covers(p, [a, b, "NOT-A-SKU"])).toEqual([a, b].sort());
  });
  it("an attested, documented, in-validity forward-cover rate is usable (and is the only rate considered)", () => {
    const p = base();
    const eur = firstOf(p, "EUR");
    p.forwardCover = { EUR: attested("EUR", fc()) };
    expect(covers(p, [eur])).toEqual([eur]);
  });
  it("the binding to the curried helper gives the same answer", () => {
    const p = base();
    const k = Object.keys(p.skus)[0];
    expect([...legacyCostCoverageFor(p, NOW)([k])]).toEqual([k]);
  });
});

describe("NOT covered: missing, unverified, stale, unrelated or incomplete costs never count", () => {
  it("supplier pricing off or absent: nothing is covered (legacy quotations are judged exactly as before)", () => {
    expect(covers(undefined, ["PNQ082"])).toEqual([]);
    expect(covers({ ...base(), enabled: false as unknown as true }, Object.keys(base().skus))).toEqual([]);
  });
  it("no entry for the SKU, or an entry for a different SKU", () => {
    const p = base();
    const [a, b] = Object.keys(p.skus);
    delete p.skus[a];
    expect(covers(p, [a])).toEqual([]);
    expect(covers(p, [a, b])).toEqual([b]);
    expect(covers(p, ["UNRELATED-SKU"])).toEqual([]);
  });
  it("unverified (never reviewed)", () => {
    const p = equivalentInputs({}, "unverified");
    expect(covers(p, Object.keys(p.skus))).toEqual([]);
  });
  it("verified by the person who entered it (not independent)", () => {
    const p = base();
    const k = firstOf(p, "ZAR");
    p.skus[k] = reviewed({ ...sku(p, k), review: undefined }, EST);
    expect(covers(p, [k])).toEqual([]);
  });
  it("the cost changed after it was verified (stale review)", () => {
    const p = base();
    const k = firstOf(p, "ZAR");
    p.skus[k] = { ...sku(p, k), nativeUnitCostE7: sku(p, k).nativeUnitCostE7 + 1 };
    expect(covers(p, [k])).toEqual([]);
  });
  it("a changed currency, supplier, source or freight also stops the review applying", () => {
    for (const change of [(s: SkuPricingInput) => ({ ...s, supplierName: "Other Supplier" }), (s: SkuPricingInput) => ({ ...s, source: "Another sheet" }), (s: SkuPricingInput) => ({ ...s, freight: { ...s.freight!, factorMicro: s.freight!.factorMicro + 1 } })]) {
      const p = base(); const k = firstOf(p, "ZAR");
      p.skus[k] = change(sku(p, k));
      expect(covers(p, [k])).toEqual([]);
    }
  });
  it("no freight / landed-cost assumption recorded", () => {
    const p = base(); const k = firstOf(p, "ZAR");
    p.skus[k] = reviewed({ ...sku(p, k), freight: null, review: undefined });
    expect(covers(p, [k])).toEqual([]);
  });
  it("a zero, negative or non-integer cost, a bad currency or an empty source", () => {
    for (const bad of [{ nativeUnitCostE7: 0 }, { nativeUnitCostE7: -5 }, { nativeUnitCostE7: 1.5 }, { currency: "eur" }, { currency: "EU" }, { source: "  " }]) {
      const p = base(); const k = firstOf(p, "EUR");
      p.skus[k] = reviewed({ ...sku(p, k), ...bad, review: undefined });
      expect(covers(p, [k])).toEqual([]);
    }
  });
  it("a foreign-currency cost with no exchange rate", () => {
    const p = base(); const eur = firstOf(p, "EUR");
    p.fxQuotes = { USD: p.fxQuotes.USD };
    expect(covers(p, [eur])).toEqual([]);
  });
  it("a stale spot rate (older than the rule's freshness limit)", () => {
    const p = base(); const eur = firstOf(p, "EUR");
    expect(covers(p, [eur], "2026-11-13T07:59:00.000Z")).toEqual([eur]); // 23h59m after the rate: fresh
    expect(covers(p, [eur], "2026-11-13T09:00:00.000Z")).toEqual([]); // 25h after the rate: stale
  });
  it("forward cover: unattested, self-attested, undocumented, expired, not yet valid, outdated after a change: all NOT covered, and never a fall-back to spot", () => {
    const eurOf = (p: EstimatorPricing) => firstOf(p, "EUR");
    const cases: Array<[string, StoredForwardCover]> = [
      ["unattested", fc()],
      ["self-attested", attested("EUR", fc(), EST)],
      ["undocumented", attested("EUR", fc({ reference: "" }))],
      ["no validity dates", attested("EUR", fc({ validFrom: undefined, validUntil: undefined }))],
      ["expired", attested("EUR", fc({ validFrom: "2026-10-01", validUntil: "2026-11-05" }))],
      ["not yet valid", attested("EUR", fc({ validFrom: "2026-12-01", validUntil: "2026-12-31" }))],
      ["changed after attestation", { ...attested("EUR", fc()), rateMicro: micro("18.5") }],
    ];
    for (const [name, f] of cases) {
      const p = base();
      p.forwardCover = { EUR: f };
      expect(covers(p, [eurOf(p)]), name).toEqual([]);
    }
  });
  it("prototype-ish SKU names never match an inherited property", () => {
    const p = base();
    expect(covers(p, ["__proto__", "constructor", "toString", "hasOwnProperty"])).toEqual([]);
  });
  it("an unknown or unusable rule version covers nothing", () => {
    const p = { ...base(), ruleVersionId: "no-such-rules" };
    expect(covers(p, Object.keys(p.skus))).toEqual([]);
  });
  it("an invalid clock covers nothing (fails closed)", () => {
    const p = base();
    expect(covers(p, Object.keys(p.skus), "not-a-date")).toEqual([]);
  });
});
