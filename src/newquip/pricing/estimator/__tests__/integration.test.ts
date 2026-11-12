import { describe, expect, it } from "vitest";
import { readyDraft } from "../../../grower/__tests__/golden";
import { hashOf } from "../../../quote/baseline";
import { redactEvaluationFinancials, redactInternalFinancials } from "../../../quote/margin";
import { micro } from "../../model";
import { createEstimatorPriceSource, internalAdjustmentView, keepServerOwnedPricing, pricingFinality, pricingForSku } from "..";
import { AT, EST, equivalentInputs, evalOf, lineOf, withPricing } from "./helpers";

const legacy = evalOf(readyDraft());

describe("1. legacy quotations are unchanged (opt-in only)", () => {
  it("a draft with no pricing key, or with it explicitly absent, evaluates identically and hashes identically", () => {
    const d = readyDraft();
    const explicit = { ...d, estimator: { ...d.estimator, pricing: undefined } };
    expect(JSON.stringify(evalOf(explicit))).toBe(JSON.stringify(legacy));
    expect(hashOf(explicit)).toBe(hashOf(d)); // an undefined key does not change the draft hash
    expect(legacy.budget!.priceSource.id).toBe("newquip_master_workbook_snapshot");
  });
  it("the draft's price source is the model ONLY when pricing is present AND enabled", () => {
    expect(evalOf(withPricing(equivalentInputs())).budget!.priceSource.id).toBe("estimator_supplier_pricing");
    expect(evalOf({ ...readyDraft(), estimator: { ...readyDraft().estimator, pricing: { ...equivalentInputs(), enabled: false as never } } }).budget!.priceSource.id).toBe("newquip_master_workbook_snapshot");
  });
  it("a day-to-day quotation is never priced by the model (it applies to project quotations only)", () => {
    const ev = evalOf(withPricing(equivalentInputs(), readyDraft({ quoteType: "day_to_day" })));
    expect(lineOf(ev, "feeder").status).toBe("not_in_price_source");
  });
});

describe("2. EUR, USD and ZAR supplier costs price the quotation to the cent", () => {
  const ev = evalOf(withPricing(equivalentInputs()));
  it("equivalent inputs in EUR / USD / ZAR give exactly the legacy price on every line and in the total", () => {
    for (const l of legacy.budget!.lines) expect([lineOf(ev, l.itemKey).unitPrice, lineOf(ev, l.itemKey).revenueExTax, lineOf(ev, l.itemKey).status]).toEqual([l.unitPrice, l.revenueExTax, l.status]);
    expect(ev.budget!.totals.subtotalExTax).toBe(legacy.budget!.totals.subtotalExTax);
    expect(ev.budget!.totals.estimatedCost).toBe(legacy.budget!.totals.estimatedCost);
  });
  it("really uses all three currencies", () => {
    const p = equivalentInputs();
    expect(new Set(Object.values(p.skus).map((s) => s!.currency))).toEqual(new Set(["ZAR", "EUR", "USD"]));
  });
  it("the price source says what it is, with no cost in it", () => {
    const d = createEstimatorPriceSource(equivalentInputs()).descriptor;
    expect(d.provenance).toMatch(/^Estimator pricing revision 1 · rules legacy-poc-v1 · inputs [0-9a-f]{12}$/);
    expect(`${d.label} ${d.provenance} ${d.notice}`).not.toMatch(/R\s?\d|\d+\.\d{2}|rate|markup|freight|landed/i);
  });
});

describe("3. forward cover with a recorded reason", () => {
  const p = equivalentInputs({ forwardCover: { EUR: { rateMicro: micro("19"), coverDays: 90, reference: "FEC-9", reason: "90-day forward contract", by: EST, at: AT } } });
  it("re-prices only the EUR SKUs, and the model says which rate and why", () => {
    const eurSku = Object.entries(p.skus).find(([, s]) => s!.currency === "EUR")![0];
    const usdSku = Object.entries(p.skus).find(([, s]) => s!.currency === "USD")![0];
    const before = pricingForSku(equivalentInputs(), eurSku)!.lines[0];
    const after = pricingForSku(p, eurSku)!.lines[0];
    expect(after.rate).toMatchObject({ kind: "forward_cover", coverDays: 90, rateMicro: 19_000_000 });
    expect(after.unitLandedCostCents!).toBeLessThan(before.unitLandedCostCents!);
    expect(pricingForSku(p, usdSku)!.lines[0].rate!.kind).toBe("spot");
    expect(p.forwardCover.EUR!.reason).toBe("90-day forward contract");
    expect(evalOf(withPricing(p)).budget!.totals.subtotalExTax).toBeLessThan(legacy.budget!.totals.subtotalExTax);
  });
});

describe("4. a single component price override, and 5. project markup", () => {
  it("a SKU price override changes that SKU's price wherever it is used, keeps its cost, and needs a reason (model validation)", () => {
    const ev = evalOf(withPricing(equivalentInputs({ skuPriceOverrides: { PNQ082: { unitPriceCents: 150_000, reason: "Agreed with customer", by: EST, at: AT } } })));
    expect(lineOf(ev, "feeder")).toMatchObject({ unitPrice: 1500, estimatedCost: lineOf(legacy, "feeder").estimatedCost });
    const blank = pricingForSku(equivalentInputs({ skuPriceOverrides: { PNQ082: { unitPriceCents: 150_000, reason: " ", by: EST, at: AT } } }), "PNQ082");
    expect(blank).toBeNull(); // an invalid input prices nothing
  });
  it("a project markup change re-prices every line from landed cost (25% instead of 20%)", () => {
    const ev = evalOf(withPricing(equivalentInputs({ projectMarkup: { markupBps: 2500, reason: "Longer payment terms", by: EST, at: AT } })));
    expect(lineOf(ev, "feeder").unitPrice).toBe(1500); // 1 200 landed x 1.25
    expect(lineOf(legacy, "feeder").unitPrice).toBe(1440);
  });
});

describe("5b. the target-price adjustment is INTERNAL: it never changes the quotation", () => {
  const p = equivalentInputs({ targetAdjustment: { targetTotalCents: 8_000_000, reason: "Round figure", by: EST, at: AT } });
  it("does not move any price or the total, and is shown only as what it would be", () => {
    const ev = evalOf(withPricing(p));
    expect(ev.budget!.totals.subtotalExTax).toBe(legacy.budget!.totals.subtotalExTax);
    const total = Math.round(ev.budget!.totals.subtotalExTax * 100), cost = Math.round(ev.budget!.totals.estimatedCost * 100);
    const v = internalAdjustmentView(p, { totalCents: total, costCents: cost, costComplete: true })!;
    expect(v).toMatchObject({ applied: false, targetTotalCents: 8_000_000, currentTotalCents: total, wouldAdjustByCents: 8_000_000 - total });
    expect(v.atTarget!.marginPct).not.toBeNull();
  });
  it("is not compared with a partial total", () => expect(internalAdjustmentView(p, { totalCents: null, costCents: null, costComplete: false })).toBeNull());
});

describe("6. missing and unverified supplier costs are visible and block finality", () => {
  it("a SKU with no supplier cost is NOT priced (never zero, never taken from the POC workbook): the quotation is BLOCKED and the blocker is the Estimator's", () => {
    const p = equivalentInputs(); delete p.skus.ERT053;
    const ev = evalOf(withPricing(p));
    expect(lineOf(ev, "feed_saver_mat")).toMatchObject({ status: "not_in_price_source", unitPrice: null, revenueExTax: null });
    expect(ev.readiness.state).toBe("BLOCKED");
    expect(ev.budget!.estimatorBlockers.join()).toMatch(/ERT053/);
    expect(ev.budget!.state).not.toBe("complete");
  });
  it("a Rep-visible reason for the missing price names no cost", () => {
    const p = equivalentInputs(); delete p.skus.ERT053;
    const l = lineOf(evalOf(withPricing(p), true), "feed_saver_mat");
    expect(l.reason).toBe("ERT053 has no price yet (awaiting the Estimator).");
  });
  it("an unverified supplier cost prices the quotation (indicative) but is NOT final", () => {
    const d = withPricing(equivalentInputs({}, "unverified"));
    const ev = evalOf(d);
    expect(ev.budget!.totals.subtotalExTax).toBe(legacy.budget!.totals.subtotalExTax); // still a usable indicative price
    const f = pricingFinality(d.estimator.pricing, ev.budget);
    expect(f.final).toBe(false);
    expect(f.reasons.length).toBeGreaterThan(0);
    expect(f.reasons.join(" ")).toMatch(/not verified.*indicative only.*cannot be waived/);
    expect(f.reasons.join(" ")).not.toMatch(/R\s?\d|\d+\.\d{2}/); // SKUs only, never a cost or rate
  });
  it("verified costs with a recorded freight assumption are final; no pricing at all is final (legacy)", () => {
    const d = withPricing(equivalentInputs());
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget)).toEqual({ final: true, reasons: [] });
    expect(pricingFinality(undefined, legacy.budget)).toEqual({ final: true, reasons: [] });
  });
  it("an unspecified freight assumption and a stale rate are not final either", () => {
    const p = equivalentInputs(); p.skus.PNQ082 = { ...p.skus.PNQ082!, freight: null };
    expect(pricingFinality(p, evalOf(withPricing(p)).budget).reasons.join()).toMatch(/PNQ082: no freight/);
  });
});

describe("9. role-based confidentiality of the pricing inputs and the cost basis", () => {
  const d = withPricing(equivalentInputs({ targetAdjustment: { targetTotalCents: 1, reason: "secret target reason", by: EST, at: AT } }));
  it("a viewer without cost visibility gets no pricing inputs (draft or sealed baseline), no cost, and a neutral price-source basis", () => {
    const quote = { draft: d, accepted_baseline: { internalMargin: {}, physicalCostEstimate: {}, estimator: { pricing: d.estimator.pricing, costBasis: {} } } } as never;
    const red = redactInternalFinancials(quote, false) as unknown as { draft: { estimator: Record<string, unknown> }; accepted_baseline: { estimator: Record<string, unknown> } };
    expect(red.draft.estimator.pricing).toBeUndefined();
    expect(red.accepted_baseline.estimator.pricing).toBeUndefined();
    expect(JSON.stringify(red)).not.toMatch(/secret target reason|Fixture supplier sheet|nativeUnitCost|skuPriceOverrides|forwardCover/);
    const rep = redactEvaluationFinancials(evalOf(d, true), false);
    expect(rep.budget!.priceSource.basis).toBe("Project pricing: quoted at the project price basis, ex VAT.");
    expect(rep.budget!.totals.estimatedCost).toBe(0);
    expect(rep.budget!.lines.every((l) => l.estimatedCost === null)).toBe(true);
  });
  it("a cost-entitled viewer keeps everything", () => {
    const q = { draft: d, accepted_baseline: null } as never;
    expect((redactInternalFinancials(q, true) as unknown as { draft: typeof d }).draft.estimator.pricing).toBeDefined();
  });
});

describe("server ownership", () => {
  it("a submitted draft can never add, change or remove the pricing; the stored pricing is kept", () => {
    const stored = withPricing(equivalentInputs());
    const forged = withPricing(equivalentInputs({ projectMarkup: { markupBps: 0, reason: "forged", by: "x", at: AT } }));
    expect(hashOf(keepServerOwnedPricing(forged, stored).estimator.pricing)).toBe(hashOf(stored.estimator.pricing));
    expect(keepServerOwnedPricing(forged, readyDraft()).estimator.pricing).toBeUndefined(); // cannot switch the model ON
    expect(keepServerOwnedPricing(readyDraft(), stored).estimator.pricing).toBeDefined(); // cannot switch it OFF
  });
});

describe("found in the isolated Preview run: a zero supplier cost is never shown as a price", () => {
  it("the workspace row is NOT priced (no R 0,00), says a supplier quote is required, and the attention list names it", async () => {
    const { buildPricingWorkspace } = await import("..");
    const p = equivalentInputs(); p.skus.PNQ082 = { ...p.skus.PNQ082!, nativeUnitCostMicro: 0 };
    const d = withPricing(p);
    const v = buildPricingWorkspace({ quoteType: "project", pricing: p, budget: evalOf(d).budget, originalTotalCents: null, originalCapturedAt: null });
    const row = v.rows.find((r) => r.sku === "PNQ082")!;
    expect(row).toMatchObject({ status: "not_priced", unitPriceCents: null, lineRevenueCents: null, lineCostCents: null, unitLandedCostCents: null, margin: null });
    expect(row.issues[0]).toMatch(/supplier cost is zero.*supplier quote is required/);
    expect(v.attention.join(" ")).toMatch(/PNQ082: cannot be priced yet \(the supplier cost is zero/);
    expect(v.totals.totalCents).toBeNull();
  });
});
