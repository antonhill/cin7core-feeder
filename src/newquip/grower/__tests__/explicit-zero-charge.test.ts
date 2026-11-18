import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../evaluate";
import type { QuoteDraft } from "../draft";
import { testPriceSource } from "./test-snapshot";
import { readyDraft } from "./golden";

// Explicit R0.00 is a deliberate "no charge"; blank is "not decided"; a negative is never accepted; an included PRODUCT still needs a real price.
const ctx = { priceSource: testPriceSource(), withholdCost: false };
const withEst = (d: QuoteDraft, e: Partial<QuoteDraft["estimator"]>): QuoteDraft => ({ ...d, estimator: { ...d.estimator, ...e } });
const charge = (ev: ReturnType<typeof evaluateDraft>, key: string) => ev.budget!.charges.find((c) => c.key === key);
const blockers = (ev: ReturnType<typeof evaluateDraft>) => ev.budget!.blockers.join("\n");

describe("delivery / installation: blank vs zero vs positive vs negative", () => {
  it("BLANK (null or absent) is not entered: the Rep still has to decide, and the quote is BLOCKED", () => {
    const d = readyDraft();
    for (const charges of [{ ...d.estimator.charges, delivery: null }, { installation: d.estimator.charges.installation, concrete_slat_delivery: d.estimator.charges.concrete_slat_delivery }]) {
      const ev = evaluateDraft(withEst(d, { charges }), ctx);
      expect(charge(ev, "delivery")).toMatchObject({ amountExTax: null, status: "required" });
      expect(ev.readiness.state).toBe("BLOCKED");
    }
  });
  it("an explicit ZERO is entered (status entered, amount 0), adds no priced line, and does not block", () => {
    const d = readyDraft();
    const zero = evaluateDraft(withEst(d, { charges: { ...d.estimator.charges, delivery: 0, installation: 0 } }), ctx);
    expect(charge(zero, "delivery")).toMatchObject({ amountExTax: 0, status: "entered" });
    expect(charge(zero, "installation")).toMatchObject({ amountExTax: 0, status: "entered" });
    expect(blockers(zero)).not.toMatch(/Delivery|Installation/);
    expect(zero.readiness.state).toBe("READY");
    expect(zero.budget!.warnings.join("\n")).toMatch(/Delivery: R0\.00 entered - no charge is quoted/);
    // zero adds nothing: it equals the same quote with the two charges at 0 versus the positive ones minus their amounts
    const positive = evaluateDraft(d, ctx).budget!.totals.subtotalExTax;
    expect(positive - zero.budget!.totals.subtotalExTax).toBeCloseTo(250_000 + 400_000, 6);
  });
  it("a POSITIVE charge still adds its line to the total", () => {
    const d = readyDraft();
    const a = evaluateDraft(withEst(d, { charges: { ...d.estimator.charges, delivery: 0 } }), ctx).budget!.totals.subtotalExTax;
    const b = evaluateDraft(withEst(d, { charges: { ...d.estimator.charges, delivery: 1_000 } }), ctx).budget!.totals.subtotalExTax;
    expect(b - a).toBeCloseTo(1_000, 6);
  });
  it("a NEGATIVE amount is never accepted (still required, quote blocked)", () => {
    const d = readyDraft();
    const ev = evaluateDraft(withEst(d, { charges: { ...d.estimator.charges, delivery: -5 } }), ctx);
    expect(charge(ev, "delivery")).toMatchObject({ amountExTax: null, status: "required" });
    expect(ev.readiness.state).toBe("BLOCKED");
    const nan = evaluateDraft(withEst(d, { charges: { ...d.estimator.charges, delivery: Number.NaN } }), ctx);
    expect(charge(nan, "delivery")).toMatchObject({ amountExTax: null, status: "required" });
  });
  it("an explicit zero survives a save and reload (JSON round trip) and re-evaluates identically", () => {
    const d = withEst(readyDraft(), { charges: { delivery: 0, installation: 0, concrete_slat_delivery: 0 }, unitPrices: { flex_auger: 150_000 } });
    const reloaded = JSON.parse(JSON.stringify(d)) as QuoteDraft;
    expect(reloaded.estimator.charges).toEqual({ delivery: 0, installation: 0, concrete_slat_delivery: 0 });
    expect(evaluateDraft(reloaded, ctx).budget).toEqual(evaluateDraft(d, ctx).budget);
  });
});

describe("slat delivery: required only for an included slat line", () => {
  it("included slats: blank blocks, zero is accepted", () => {
    const d = readyDraft();
    const blank = evaluateDraft(withEst(d, { charges: { delivery: 1, installation: 1 } }), ctx);
    expect(blockers(blank)).toMatch(/slat delivery/i);
    const zero = evaluateDraft(withEst(d, { charges: { delivery: 1, installation: 1, concrete_slat_delivery: 0 } }), ctx);
    expect(blockers(zero)).not.toMatch(/slat delivery/i);
    expect(charge(zero, "concrete_slat_delivery")).toMatchObject({ amountExTax: 0, status: "entered" });
  });
  it("EXCLUDED slats: no slat-delivery charge is required or listed", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...withEst(d, { charges: { delivery: 0, installation: 0 } }), config: { ...d.config, exclusions: { ...d.config.exclusions, concrete_slat: "Acceptance test: excluded" } } }, ctx);
    expect(charge(ev, "concrete_slat_delivery")).toBeUndefined();
    expect(blockers(ev)).not.toMatch(/slat/i);
  });
});

describe("M75 system price: a PRODUCT price is never satisfied by zero", () => {
  it("included M75 (quantity > 0): blank and zero both block; a positive price passes", () => {
    const d = readyDraft();
    for (const unitPrices of [{}, { flex_auger: null }, { flex_auger: 0 }]) {
      const ev = evaluateDraft(withEst(d, { unitPrices }), ctx);
      expect(ev.budget!.lines.find((l) => l.itemKey === "flex_auger")!.status).toBe("estimator_price_required");
      expect(ev.readiness.state).toBe("BLOCKED");
    }
    expect(evaluateDraft(withEst(d, { unitPrices: { flex_auger: 1 } }), ctx).budget!.lines.find((l) => l.itemKey === "flex_auger")!.status).toBe("priced");
  });
  it("EXCLUDED M75 needs no price at all", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...withEst(d, { unitPrices: {} }), config: { ...d.config, exclusions: { ...d.config.exclusions, flex_auger: "Acceptance test: excluded" } } }, ctx);
    expect(ev.budget!.lines.find((l) => l.itemKey === "flex_auger")!.status).toBe("not_selected");
    expect(blockers(ev)).not.toMatch(/M75|flex|commercial price/i);
  });
});

describe("the acceptance shape: tank + feeder only, every other package excluded, no delivery or installation", () => {
  it("is READY with explicit R0.00 delivery and installation, no M75 price and no slat delivery, and the totals come only from the two products", () => {
    const d = readyDraft();
    const reasons = Object.fromEntries(["flex_auger", "feed_saver_mat", "cup_drinker", "concrete_slat", "penning_package", "led_light", "pvc_door"].map((k) => [k, "Acceptance test: excluded"]));
    const draft: QuoteDraft = { ...withEst(d, { charges: { delivery: 0, installation: 0 }, unitPrices: {} }), config: { ...d.config, exclusions: reasons, estimatorQuantities: { bulk_tank: 1, feeder: 2 } } };
    const ev = evaluateDraft(draft, ctx);
    expect(blockers(ev)).not.toMatch(/Delivery|Installation|M75|slat/i);
    expect(ev.budget!.charges.map((c) => [c.key, c.amountExTax, c.status])).toEqual([["delivery", 0, "entered"], ["installation", 0, "entered"]]);
    const priced = ev.budget!.lines.filter((l) => l.status === "priced").map((l) => l.itemKey).sort();
    expect(priced).toEqual(["bulk_tank", "feeder"]);
  });
});
