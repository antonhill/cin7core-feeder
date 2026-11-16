import { describe, expect, it } from "vitest";
import { readyDraft } from "../../../grower/__tests__/golden";
import { redactEvaluationFinancials, redactInternalFinancials } from "../../../quote/margin";
import { type Viewer } from "../../model";
import { applyManualEvidence, applyPricingSubmission, buildPricingWorkspace, evidenceStateOf, keepServerOwnedPricing, manualEvidenceRows, manualPriceHash, normaliseSubmission, pricingFinality, skuLessManualItems, submissionFrom, type EstimatorPricing } from "..";
import { AT, equivalentInputs as equivalentInputsOn, evalOf, manualDraft, withPricing as withPricingOn } from "./helpers";
import { onCurrentTemplate } from "../../../grower/__tests__/current-template";
import type { QuoteDraft } from "../../../grower/draft";

// The base draft here carries the CONTROLLER with a typed price and no mapping: the LED package is SKU-backed now (Sean 2026-11), so it is governed by cost verification, not by this control.
const withPricing = (p: EstimatorPricing, base: QuoteDraft = manualDraft()) => withPricingOn(p, base);
const equivalentInputs = (over: Partial<EstimatorPricing> = {}, verification: "verified" | "unverified" = "verified") => equivalentInputsOn(over, verification, manualDraft());
// PRICING EVIDENCE FOR SKU-LESS MANUAL ITEMS (NQ-008B P2-E): M75, LED lighting, penning. No SKU is invented, no price changes, and the evidence is bound to the price it explains.
const roles = (...r: Array<"rep" | "estimator" | "manager">): Viewer["roles"] => new Set(r);
const EST_V: Viewer = { roles: roles("rep", "estimator"), canSeeCost: true };
const REP_V: Viewer = { roles: roles("rep"), canSeeCost: false };
const NOW = "2026-11-12T10:00:00.000Z";
const NOTE = "Basis: written quote Q-100 from the installer";
const unverified = () => equivalentInputs({}, "unverified");
const budgetOf = (p: EstimatorPricing, mod: (d: ReturnType<typeof readyDraft>) => void = () => undefined) => { const d = withPricing(p); mod(d); return evalOf(d).budget; };
const allItems = (b: ReturnType<typeof budgetOf>, note = NOTE) => skuLessManualItems(b).map((i) => ({ itemKey: i.itemKey, note }));
const done = (p: EstimatorPricing): EstimatorPricing => { const r = applyManualEvidence(p, budgetOf(p), allItems(budgetOf(p)), EST_V, "est@example.test", NOW); if (!r.ok) throw new Error(r.errors.join()); return r.next; };
const finalOf = (p: EstimatorPricing, mod?: (d: ReturnType<typeof readyDraft>) => void) => { const d = withPricing(p); mod?.(d); return pricingFinality(d.estimator.pricing, evalOf(d).budget, AT); };

describe("which items need evidence", () => {
  it("M75 (estimator_input), an optional element with a typed price and no mapping (the controller) and penning have no SKU of their own: they are listed, with their current unit price in cents; no SKU is invented", () => {
    const d = manualDraft();
    d.estimator.priceResolutions = { ...d.estimator.priceResolutions }; // the controller is a resolution in this fixture
    const items = skuLessManualItems(evalOf(withPricing(unverified(), d)).budget);
    expect(items.map((i) => [i.itemKey, i.pricedBy])).toEqual([["controller", "estimator_resolution"], ["flex_auger", "estimator_input"], ["penning_package", "penning_rate"]]);
    expect(items.map((i) => i.itemKey)).not.toContain("led_light"); // the LED package is SKU-backed (HNQ7046 / HNQ7093 / HNQ7088): cost verification governs it, not this control
    expect(items.every((i) => Number.isSafeInteger(i.unitPriceCents) && i.unitPriceCents > 0)).toBe(true);
  });
  it("legacy vs current template, same fixture: the ORIGINAL LED (no SKU, typed price) needs evidence; the current SKU-backed LED does not", () => {
    const legacy = readyDraft(); // unstamped = the original template
    expect(skuLessManualItems(evalOf(withPricingOn(unverified(), legacy)).budget).map((i) => i.itemKey)).toEqual(["flex_auger", "led_light", "penning_package"]);
    expect(skuLessManualItems(evalOf(withPricingOn(unverified(), onCurrentTemplate(legacy))).budget).map((i) => i.itemKey)).toEqual(["flex_auger", "penning_package"]);
  });
  it("a manual price on a SKU line is governed by cost verification, not by this control; supplier-priced lines never need it; no budget means none", () => {
    const d = manualDraft(); d.estimator.priceResolutions = { ...d.estimator.priceResolutions, feed_saver_mat: { unitPriceExVat: 919, reason: "Manual price: none in the workbook" } };
    expect(skuLessManualItems(evalOf(withPricing(unverified(), d)).budget).map((i) => i.itemKey)).not.toContain("feed_saver_mat");
    expect(skuLessManualItems(null)).toEqual([]);
  });
});

describe("the state is bound to the price the evidence explains", () => {
  it("missing -> recorded -> outdated when the price changes -> recorded again", () => {
    const p = unverified();
    const item = skuLessManualItems(budgetOf(p)).find((i) => i.itemKey === "controller")!;
    expect(evidenceStateOf(item, p)).toBe("missing");
    const q = done(p);
    expect(evidenceStateOf(item, q)).toBe("recorded");
    expect(q.manualEvidence!.controller).toMatchObject({ note: NOTE, by: "est@example.test", at: NOW, priceHash: manualPriceHash(item) });
    expect(evidenceStateOf({ ...item, unitPriceCents: item.unitPriceCents + 1 }, q)).toBe("outdated");
    expect(evidenceStateOf({ ...item, pricedBy: "penning_rate" }, q)).toBe("outdated");
    expect(manualPriceHash(item)).not.toBe(manualPriceHash({ ...item, itemKey: "other" }));
  });
  it("a real price change in the draft makes the stored evidence outdated and blocks again", () => {
    const q = equivalentInputs({}, "verified");
    expect(finalOf(q)).toEqual({ final: true, reasons: [] });
    const moved = finalOf(q, (d) => { d.estimator.priceResolutions = { ...d.estimator.priceResolutions, controller: { unitPriceExVat: 905, reason: "price moved" } }; });
    expect(moved.final).toBe(false);
    expect(moved.reasons.join(" ")).toMatch(/Thomas-CL1 controller.*the price changed after its evidence was recorded/);
  });
});

describe("recording evidence", () => {
  it("needs an Estimator or Manager with cost visibility; a Rep, or a role without cost visibility, is refused", () => {
    const p = unverified(); const items = allItems(budgetOf(p));
    expect(applyManualEvidence(p, budgetOf(p), items, REP_V, "rep@x", NOW)).toMatchObject({ ok: false });
    expect(applyManualEvidence(p, budgetOf(p), items, { roles: roles("estimator"), canSeeCost: false }, "e@x", NOW)).toMatchObject({ ok: false });
    expect(applyManualEvidence(undefined, budgetOf(p), items, EST_V, "e@x", NOW)).toMatchObject({ ok: false });
  });
  it("the note is 10 to 500 characters (trimmed); the reference at most 100; reserved, unknown and duplicate keys are refused; the WHOLE request fails if any part does", () => {
    const p = unverified(); const b = budgetOf(p);
    const one = (note: unknown, extra: Record<string, unknown> = {}) => applyManualEvidence(p, b, [{ itemKey: "controller", note: note as string, ...extra }], EST_V, "e@x", NOW);
    for (const bad of ["", "         ", "too short", "x".repeat(501), 5, null, undefined]) expect(one(bad)).toMatchObject({ ok: false });
    expect(one("x".repeat(500))).toMatchObject({ ok: true });
    expect(one(`  ${NOTE}  `)).toMatchObject({ ok: true, next: { manualEvidence: { controller: { note: NOTE } } } });
    expect(one(NOTE, { reference: "r".repeat(101) })).toMatchObject({ ok: false });
    expect(one(NOTE, { reference: 5 })).toMatchObject({ ok: false });
    expect(one(NOTE, { reference: " Q-100 " })).toMatchObject({ ok: true, next: { manualEvidence: { controller: { reference: "Q-100" } } } });
    for (const k of ["__proto__", "constructor", "prototype", "toString", "NO-SUCH", "feed_saver_mat"]) expect(applyManualEvidence(p, b, [{ itemKey: k, note: NOTE }], EST_V, "e@x", NOW)).toMatchObject({ ok: false, errors: [expect.stringMatching(/not an item that needs pricing evidence/)] });
    expect(applyManualEvidence(p, b, [{ itemKey: "controller", note: NOTE }, { itemKey: "controller", note: NOTE }], EST_V, "e@x", NOW)).toMatchObject({ ok: false });
    expect(applyManualEvidence(p, b, [{ itemKey: "controller", note: NOTE }, { itemKey: "penning_package", note: "short" }], EST_V, "e@x", NOW)).toMatchObject({ ok: false });
    expect(applyManualEvidence(p, b, [], EST_V, "e@x", NOW)).toMatchObject({ ok: false });
    expect(({} as Record<string, unknown>).controller).toBeUndefined(); // (the key refusal never polluted Object.prototype)
  });
  it("the hash is computed from the SERVER's budget, never from the client: a client-sent hash, by or at is ignored", () => {
    const p = unverified();
    const r = applyManualEvidence(p, budgetOf(p), [{ itemKey: "controller", note: NOTE, priceHash: "0".repeat(64), by: "forged@x", at: "2000-01-01T00:00:00.000Z" } as never], EST_V, "real@x", NOW);
    if (!r.ok) throw new Error("setup");
    const item = skuLessManualItems(budgetOf(p)).find((i) => i.itemKey === "controller")!;
    expect(r.next.manualEvidence!.controller).toEqual({ note: NOTE, by: "real@x", at: NOW, priceHash: manualPriceHash(item) });
  });
  it("changes NO price and not the pricing date; bumps the revision; lists the change; never mutates the prior", () => {
    const p = unverified(); const before = evalOf(withPricing(p)).budget!.totals.subtotalExTax;
    const r = applyManualEvidence(p, budgetOf(p), allItems(budgetOf(p)), EST_V, "e@x", NOW);
    if (!r.ok) throw new Error("setup");
    expect(r.next.pricingDate).toBe(p.pricingDate);
    expect(r.next.revision).toBe(p.revision + 1);
    expect(evalOf(withPricing(r.next)).budget!.totals.subtotalExTax).toBe(before);
    expect(r.changes.map((c) => c.path)).toContain("manualEvidence.controller.note");
    expect(p.manualEvidence).toBeUndefined();
    expect(applyManualEvidence(r.next, budgetOf(r.next), allItems(budgetOf(r.next)), EST_V, "e@x", NOW)).toMatchObject({ ok: false, errors: ["Nothing changed."] }); // identical evidence again
  });
});

describe("finality", () => {
  it("each SKU-less manual item without evidence blocks, naming the item only (never a price), and the incomplete-costing exception cannot waive it", () => {
    const f = finalOf(unverified());
    const txt = f.reasons.filter((r) => /no pricing evidence/.test(r));
    expect(f.final).toBe(false);
    expect(txt).toHaveLength(3);
    expect(txt.every((r) => r.endsWith("This cannot be waived by the incomplete-costing exception."))).toBe(true);
    expect(txt.join(" ")).toMatch(/M75 feed distribution system|flex_auger/);
    for (const price of ["90000", "150000", "1500", "900", "1 500", "R 900"]) expect(txt.join(" ")).not.toContain(price); // no price
    expect(withPricing(unverified()).estimator.costBasis?.incompleteAccepted).toBeDefined(); // the fixture accepts the exception, and still it blocks
  });
  it("legacy POC behaviour is unchanged: with supplier pricing OFF nothing needs evidence", () => {
    expect(pricingFinality(undefined, evalOf(manualDraft()).budget, AT)).toEqual({ final: true, reasons: [] });
    expect(manualEvidenceRows(undefined, evalOf(manualDraft()).budget)).toEqual([]);
  });
  it("all evidence recorded => final", () => {
    expect(finalOf(done(equivalentInputs({}, "verified")))).toEqual({ final: true, reasons: [] });
  });
});

describe("server ownership: the client can never write evidence", () => {
  it("a submitted draft's estimator.pricing (with manualEvidence or review) is discarded; the stored pricing is kept", () => {
    const stored = done(equivalentInputs({}, "verified"));
    const forged = structuredClone(stored); forged.manualEvidence!.controller = { note: "forged note", by: "me@x", at: AT, priceHash: "0".repeat(64) };
    const draft = withPricing(forged);
    expect(keepServerOwnedPricing(draft, withPricing(stored)).estimator.pricing!.manualEvidence!.controller!.note).toBe(stored.manualEvidence!.controller!.note);
    expect(keepServerOwnedPricing(draft, manualDraft()).estimator.pricing).toBeUndefined();
  });
  it("the pricing form never submits evidence and a client's extra keys never reach the stored pricing; a save carries stored evidence over untouched", () => {
    const p = done(unverified());
    const s = submissionFrom(p);
    expect(JSON.stringify(s)).not.toMatch(/manualEvidence|Basis: written/);
    const forged = { ...structuredClone(s), manualEvidence: { controller: { note: "forged note here", by: "x", at: AT, priceHash: "0" } } };
    const n = normaliseSubmission(forged, NOW);
    expect(n.ok && JSON.stringify(n.value)).not.toMatch(/forged/);
    const r = applyPricingSubmission(p, { ...structuredClone(s), projectMarkup: { markupBps: 2500, reason: "markup" } }, EST_V, "e2@x", NOW, "Change markup", "project");
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.next!.manualEvidence).toEqual(p.manualEvidence);
  });
});

describe("evidence is internal: it never reaches a Rep or the customer", () => {
  const q = done(equivalentInputs({}, "verified"));
  const SECRET = q.manualEvidence!.controller!.note;
  it("the Rep's view of the quote record drops the whole pricing (evidence, supplier costs and rates) and the accepted baseline's copy", () => {
    const d = withPricing(q);
    const quote = { draft: d, accepted_baseline: { estimator: { pricing: q } } };
    const rep = JSON.stringify(redactInternalFinancials(quote as never, false));
    expect(rep).not.toContain(SECRET);
    expect(rep).not.toMatch(/manualEvidence|nativeUnitCostE7|forwardCover|fxQuotes|priceHash/);
    expect(JSON.stringify(redactInternalFinancials(quote as never, true))).toContain(SECRET); // a cost-entitled viewer keeps it (the Manager sees it at approval)
  });
  it("the Rep's evaluation and the finality reasons a Rep could see carry no evidence text, supplier cost or rate", () => {
    const d = withPricing(q);
    const rep = JSON.stringify(redactEvaluationFinancials(evalOf(d, true), false));
    expect(rep).not.toContain(SECRET);
    expect(rep).not.toMatch(/supplier cost|manualEvidence|nativeUnitCostE7/);
    const blocked = JSON.stringify(finalOf(unverified()).reasons);
    expect(blocked).not.toContain(SECRET);
  });
  it("the cost-entitled workspace and the approval rows show who recorded what, and when", () => {
    const rows = manualEvidenceRows(q, evalOf(withPricing(q)).budget);
    expect(rows.find((r) => r.itemKey === "controller")).toMatchObject({ state: "recorded", note: SECRET, by: "est@example.test", at: NOW });
    const v = buildPricingWorkspace({ quoteType: "project", pricing: q, budget: evalOf(withPricing(q)).budget, originalTotalCents: null, originalCapturedAt: null, nowIso: AT });
    expect(v.manualEvidence).toEqual(rows);
  });
});
