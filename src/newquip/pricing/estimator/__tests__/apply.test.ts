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
    sub.forwardCover = { EUR: { rateMicro: micro("19"), coverDays: 90, reference: "FEC-9", reason: "  90-day forward contract  " } };
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
    expect(bad((s) => { s.projectMarkup = { markupBps: 200_000, reason: "x" }; })).toMatch(/between 0% and 1000%/);
    expect(bad((s) => { s.targetAdjustment = { targetTotalCents: 5_000_000, reason: "" }; })).toMatch(/target price adjustment needs a reason/);
    expect(bad((s) => { s.skus["BAD SKU!!"] = Object.values(s.skus)[0] as never; })).toMatch(/Not a valid SKU/);
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
