import { describe, expect, it } from "vitest";
import { micro, type Viewer } from "../../model";
import { applyPricingSubmission, diffPricing, disablePricing, type PricingSubmission } from "..";
import { AT, EST, equivalentInputs } from "./helpers";

const roles = (...r: Array<"rep" | "estimator" | "manager">): Viewer["roles"] => new Set(r);
const EST_V: Viewer = { roles: roles("rep", "estimator"), canSeeCost: true };
const NOW = "2026-11-13T09:00:00.000Z";
const strip = (p = equivalentInputs()): PricingSubmission => {
  const s = structuredClone(p);
  return {
    ruleVersionId: s.ruleVersionId,
    skus: Object.fromEntries(Object.entries(s.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, { ...rest, by: "forged@evil", at: "1999-01-01T00:00:00.000Z" } as never]; })),
    fxQuotes: s.fxQuotes as PricingSubmission["fxQuotes"], forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null,
  };
};
const apply = (sub: PricingSubmission, prior = undefined as ReturnType<typeof equivalentInputs> | undefined, v = EST_V, reason = "Initial supplier pricing", qt = "project") => applyPricingSubmission(prior, sub, v, "est@nq", NOW, reason, qt);

describe("who may change pricing, and what a valid change looks like", () => {
  it("refuses a Rep, an Estimator without cost visibility, a missing reason, a day-to-day quotation, a draft/unknown rule version and an empty submission", () => {
    for (const v of [{ roles: roles("rep"), canSeeCost: false }, { roles: roles("rep", "estimator"), canSeeCost: false }, { roles: roles("rep"), canSeeCost: true }]) {
      expect(apply(strip(), undefined, v)).toMatchObject({ ok: false });
    }
    expect(apply(strip(), undefined, EST_V, " ")).toMatchObject({ ok: false, errors: [expect.stringMatching(/Say why/)] });
    expect(apply(strip(), undefined, EST_V, "ok reason", "day_to_day")).toMatchObject({ ok: false, errors: [expect.stringMatching(/project quotations only/)] });
    expect(apply({ ...strip(), ruleVersionId: "fixture-draft-v0" })).toMatchObject({ ok: false, errors: [expect.stringMatching(/draft/)] });
    expect(apply({ ...strip(), ruleVersionId: "nope" })).toMatchObject({ ok: false });
    expect(apply({ ...strip(), skus: {} })).toMatchObject({ ok: false, errors: ["Enter at least one supplier cost."] });
  });
  it("the first valid change ENABLES: revision 1, server-stamped by/at (a client's forged attribution is discarded), every value listed as a change", () => {
    const r = apply(strip());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("ENABLED");
    expect(r.next!).toMatchObject({ enabled: true, ruleVersionId: "legacy-poc-v1", revision: 1, pricingDate: NOW });
    for (const s of Object.values(r.next!.skus)) expect(s).toMatchObject({ by: "est@nq", at: NOW });
    expect(r.changes.length).toBeGreaterThan(10);
    expect(r.changes.every((c) => c.previous === null)).toBe(true);
  });
  it("a later change keeps the ORIGINAL who/when of untouched entries, stamps only what changed, records previous -> new, and bumps the revision", () => {
    const first = apply(strip());
    if (!first.ok) throw new Error("setup");
    const sub = strip(first.next!);
    const sku = "PNQ082";
    sub.skus[sku] = { ...sub.skus[sku], nativeUnitCostMicro: micro("60") } as never;
    sub.forwardCover = { EUR: { rateMicro: micro("19"), coverDays: 90, validFrom: "2026-11-01", validUntil: "2026-12-31", reference: "FEC-9", reason: "  90-day forward contract  " } };
    const second = applyPricingSubmission(first.next!, sub, EST_V, "mgr@nq", "2026-11-14T09:00:00.000Z", "Forward cover booked", "project");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.kind).toBe("CHANGED");
    expect(second.next!.revision).toBe(2);
    expect(second.next!.skus[sku]).toMatchObject({ by: "mgr@nq" });
    const other = Object.keys(second.next!.skus).find((k) => k !== sku)!;
    expect(second.next!.skus[other]).toMatchObject({ by: "est@nq", at: NOW }); // untouched: original attribution
    expect(second.next!.forwardCover.EUR).toMatchObject({ reason: "90-day forward contract", coverDays: 90, by: "mgr@nq" });
    const c = Object.fromEntries(second.changes.map((x) => [x.path, x]));
    expect(c[`skus.${sku}.nativeUnitCostMicro`]).toMatchObject({ new: 60_000_000 });
    expect(c["forwardCover.EUR.rateMicro"]).toMatchObject({ previous: null, new: 19_000_000 });
    expect(second.changes.some((x) => x.path.startsWith("skus.") && !x.path.startsWith(`skus.${sku}.`))).toBe(false); // nothing else counts as changed
  });
  it("nothing changed is refused; an invalid input (bad rate, override without a reason, markup out of range, target without a reason) is refused with plain messages", () => {
    const first = apply(strip());
    if (!first.ok) throw new Error("setup");
    expect(applyPricingSubmission(first.next!, strip(first.next!), EST_V, "e", NOW, "No change", "project")).toMatchObject({ ok: false, errors: ["Nothing changed."] });
    const bad = (mut: (s: PricingSubmission) => void) => { const s = strip(); mut(s); const r = apply(s); return r.ok ? [] : r.errors.join(" "); };
    expect(bad((s) => { s.fxQuotes.EUR = { rateMicro: 0, source: "x", asOf: AT }; })).toMatch(/exchange rate is not valid/);
    expect(bad((s) => { s.skuPriceOverrides = { PNQ082: { unitPriceCents: 100, reason: " " } }; })).toMatch(/needs a reason/);
    expect(bad((s) => { s.skuPriceOverrides = { PNQ082: { unitPriceCents: 0, reason: "x" } }; })).toMatch(/never quoted at R0/);
    expect(bad((s) => { s.projectMarkup = { markupBps: 200_000, reason: "x" }; })).toMatch(/project markup must be a whole number between 0 and 100000/);
    expect(bad((s) => { s.targetAdjustment = { targetTotalCents: 5_000_000, reason: "" }; })).toMatch(/target price adjustment needs a reason/);
    expect(bad((s) => { s.skus["BAD SKU!!"] = Object.values(s.skus)[0] as never; })).toMatch(/not a valid key/);
  });
  it("switching OFF is a recorded change by an authorised person only", () => {
    const first = apply(strip());
    if (!first.ok) throw new Error("setup");
    expect(disablePricing(first.next!, { roles: roles("rep"), canSeeCost: false }, "x reason")).toMatchObject({ ok: false });
    expect(disablePricing(undefined, EST_V, "x reason")).toMatchObject({ ok: false });
    const off = disablePricing(first.next!, EST_V, "Back to the POC prices");
    expect(off).toMatchObject({ ok: true, kind: "DISABLED", next: null });
  });
  it("diff ignores attribution and bookkeeping", () => {
    const a = equivalentInputs(), b = structuredClone(a);
    b.revision = 9; b.pricingDate = "2030-01-01T00:00:00.000Z"; for (const s of Object.values(b.skus)) { s!.by = "x"; s!.at = "y"; }
    expect(diffPricing(a, b)).toEqual([]);
    expect(EST).toBeTruthy();
  });
});

describe("strict submission shape (independent security review)", () => {
  const run = (mut: (s: Record<string, any>) => void, reason = "Initial supplier pricing") => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const sub = strip() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    mut(sub);
    return apply(sub as unknown as PricingSubmission, undefined, EST_V, reason);
  };
  const errs = (r: ReturnType<typeof run>) => (r.ok ? [] : r.errors).join(" | ");
  it("drops unknown keys: nothing but the known fields reaches the stored pricing", () => {
    const r = run((s) => { Object.values<any>(s.skus)[0].evil = { x: 1 }; s.fxQuotes.EUR.extra = "y"; s.surprise = true; }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.next)).not.toMatch(/evil|extra|surprise/);
  });
  it("refuses reserved object keys and malformed keys", () => {
    for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty", "a b!!"]) {
      const r = run((s) => { s.skus = { ...s.skus }; Object.defineProperty(s.skus, bad, { value: Object.values<any>(s.skus)[0], enumerable: true }); }); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(errs(r), bad).toMatch(/not a valid key/);
    }
  });
  it("refuses wrong types, non-integers, out-of-bound numbers, overlong text, a zero cost and a future rate date", () => {
    expect(errs(run((s) => { Object.values<any>(s.skus)[0].supplierName = 12345; }))).toMatch(/supplier must be text/); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(errs(run((s) => { Object.values<any>(s.skus)[0].nativeUnitCostMicro = 1.5; }))).toMatch(/supplier cost must be a whole number/); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(errs(run((s) => { Object.values<any>(s.skus)[0].nativeUnitCostMicro = 1e15; }))).toMatch(/supplier cost must be a whole number between 1 and 1000000000000/); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(errs(run((s) => { Object.values<any>(s.skus)[0].source = "x".repeat(201); }))).toMatch(/too long/); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(errs(run((s) => { Object.values<any>(s.skus)[0].nativeUnitCostMicro = 0; }))).toMatch(/a zero supplier cost is not a cost/); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(errs(run((s) => { s.fxQuotes.EUR.asOf = "2030-01-01T00:00:00.000Z"; }))).toMatch(/cannot be dated in the future/);
    expect(errs(run((s) => { s.fxQuotes.EUR.rateMicro = 1e12; }))).toMatch(/exchange rate must be a whole number/);
    expect(errs(run(() => undefined, "x".repeat(501)))).toMatch(/3 to 500 characters/);
    expect(errs(run(() => undefined, 42 as unknown as string))).toMatch(/Say why/);
  });
  it("a null, array or non-object submission is refused with a plain message (no exception)", () => {
    for (const bad of [null, [], "x", 5]) expect(applyPricingSubmission(undefined, bad as never, EST_V, "e", NOW, "A valid reason", "project")).toMatchObject({ ok: false });
  });
  it("the largest allowed inputs still calculate exactly (no overflow)", () => {
    const r = run((s) => { const k = Object.keys(s.skus)[0]; s.skus[k].nativeUnitCostMicro = 1e12; s.skus[k].currency = "EUR"; s.fxQuotes.EUR.rateMicro = 1e9; s.skus[k].freight = { factorMicro: 1e8, source: "max" }; });
    expect(r.ok).toBe(true);
  });
});
