import { describe, expect, it } from "vitest";
import type { BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { PricingWorkspaceView } from "@/newquip/pricing/estimator";
import { activationPreview, buildWorkspace, costText, encodeManualReason, money, plainManualText, type WorkspaceFacts } from "../estimator-workspace";

// UX correction pass: exact cents (never whole rand), plain reason/evidence text, the "excluded until costed" explanation, the activation preview and the evidence state of manual lines.
const line = (o: Partial<BridgeLine> & { itemKey: string; label: string }): BridgeLine => ({ status: "priced", reason: "", sku: null, quantity: 1, unitPrice: null, revenueExTax: null, estimatedCost: null, estimatedGP: null, marginPct: null, pricedBy: null, ...o }) as BridgeLine;
const facts = (o: Partial<WorkspaceFacts> = {}): WorkspaceFacts => ({ state: "ESTIMATOR_REVIEW", confirmedCents: 3_257_786_880, signedOff: false, canEdit: true, canReview: false, confirmedPackages: [], confirmedMappings: {}, ...o });
const view = (o: Record<string, unknown> = {}) => ({ rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, manualEvidence: [], ...o }) as unknown as PricingWorkspaceView;

describe("money keeps its cents", () => {
  it("R193.60 stays R193.60, R232.32 stays R232.32, 800 -> R960.00, R881.00, totals to cents", () => {
    expect(money(193.6)).toBe("R193.60");
    expect(money(232.32)).toBe("R232.32");
    expect(money(960)).toBe("R960.00");
    expect(money(881)).toBe("R881.00");
    expect(money(3_679_948.8)).toBe("R3,679,948.80");
    expect(money(34_426_756.8)).toBe("R34,426,756.80");
    expect(money(0.1 + 0.2)).toBe("R0.30");
    expect(money(-1)).toBe("-R1.00");
    expect(money(-2_475_144.5)).toBe("-R2,475,144.50");
    expect(money(-0.001)).toBe("R0.00");
  });
  it("a supplier cost shows its exact decimals, at least two", () => {
    expect(costText(1_936_000_000)).toBe("193.60");
    expect(costText(65_454_755)).toBe("6.5454755");
    expect(costText(268_440_995)).toBe("26.8440995");
    expect(costText(8_000_000_000)).toBe("800.00");
  });
});

describe("a stored reason is never shown with its raw labels", () => {
  it("plainManualText decodes the pair wherever it appears and leaves other text byte-identical", () => {
    const stored = encodeManualReason("No SKU yet", "Quote UXT-001, 15 Nov");
    expect(plainManualText(`Estimator price: ${stored}`)).toBe("Estimator price: No SKU yet (evidence: Quote UXT-001, 15 Nov)");
    expect(plainManualText("MANUAL QUOTATION PRICE - reason: " + stored)).not.toMatch(/REASON:|EVIDENCE:/);
    expect(plainManualText("an earlier free-text reason")).toBe("an earlier free-text reason");
    expect(plainManualText(encodeManualReason("a\nb", "c\\d"))).toBe("a\nb (evidence: c\\d)");
  });
});

describe("lines excluded until costed (switching from reference pricing to supplier pricing)", () => {
  const budget = (lines: BridgeLine[]): BudgetQuote => ({ lines, totals: { subtotalExTax: 30_746_808 }, incomplete: true, charges: [] } as unknown as BudgetQuote);
  const cmp = { rows: [
    { key: "feeder", kind: "line", label: "CCM feeder", original: { quantity: 216, unitPriceExVat: 9446, revenueCents: 204_033_600, status: "priced" }, current: { quantity: 216, unitPriceExVat: null, revenueCents: null, status: "not_in_price_source" } },
    { key: "bulk_tank", kind: "line", label: "Bulk tank", original: { quantity: 12, unitPriceExVat: 36234, revenueCents: 43_480_800, status: "priced" }, current: { quantity: 12, unitPriceExVat: 36234, revenueCents: 43_480_800, status: "priced" } },
    { key: "delivery", kind: "charge", label: "Delivery", original: null, current: null },
  ] } as never;
  const lines = [line({ itemKey: "feeder", label: "CCM feeder", status: "not_in_price_source", sku: "PNQ082", quantity: 216 }), line({ itemKey: "bulk_tank", label: "Bulk tank", sku: "SYSH-2750-3", quantity: 12, unitPrice: 36234, revenueExTax: 434_808, pricedBy: "price_source" })];
  it("names each previously priced line that now waits for a cost, with its previous amount; a still-priced line is not listed", () => {
    const w = buildWorkspace({ budget: budget(lines), view: view(), facts: facts({ reference: cmp }) });
    expect(w.summary.excluded).toEqual([{ id: "feeder", label: "CCM feeder", previous: 2_040_336, why: "needs a supplier cost" }]);
    expect(w.summary.excludedPreviousTotal).toBe(2_040_336);
    expect(w.summary.totalKind).toBe("partial"); // never presented as a completed quotation value
  });
  it("without handoff data nothing is invented", () => {
    expect(buildWorkspace({ budget: budget(lines), view: view(), facts: facts() }).summary.excluded).toEqual([]);
  });
});

describe("the activation preview", () => {
  it("lists the reference-priced lines that will have no price until costed, the partial total after, and the single-SKU lines that can take the first cost", () => {
    const b = { lines: [
      line({ itemKey: "bulk_tank", label: "Bulk tank", sku: "SYSH-2750-3", quantity: 12, revenueExTax: 434_808, pricedBy: "price_source" }),
      line({ itemKey: "feeder", label: "CCM feeder", sku: "PNQ082", quantity: 216, revenueExTax: 2_040_336, pricedBy: "price_source" }),
      line({ itemKey: "flex_auger", label: "M75", revenueExTax: 2_400_000, pricedBy: "estimator_input" }),
      line({ itemKey: "cup_drinker", label: "Cup drinker", status: "package_unconfirmed" }),
    ], totals: { subtotalExTax: 5_000_000 } } as unknown as BudgetQuote;
    const p = activationPreview(b);
    expect(p.excluded.map((e) => [e.id, e.previous])).toEqual([["bulk_tank", 434_808], ["feeder", 2_040_336]]);
    expect(p.excludedTotal).toBe(2_475_144);
    expect(p.totalAfter).toBe(2_524_856);
    expect(p.starters.map((s) => s.sku)).toEqual(["SYSH-2750-3", "PNQ082"]);
  });
});

describe("evidence of a manual line reflects the real evidence record", () => {
  const manual = line({ itemKey: "led_light", label: "LED light", pricedBy: "estimator_resolution", unitPrice: 881, revenueExTax: 401_736, quantity: 456 });
  const b = { lines: [manual, line({ itemKey: "flex_auger", label: "M75", pricedBy: "estimator_input", unitPrice: 200_000, revenueExTax: 2_400_000 })], totals: { subtotalExTax: 2_801_736 }, incomplete: false, charges: [] } as unknown as BudgetQuote;
  it("missing evidence is shown per line, is a gate, and becomes the next action; recorded evidence clears it", () => {
    const missing = view({ manualEvidence: [{ itemKey: "led_light", label: "LED light", pricedBy: "estimator_resolution", state: "missing", stateText: "no pricing evidence has been recorded", note: null, reference: null, by: null, at: null }, { itemKey: "flex_auger", label: "M75", pricedBy: "estimator_input", state: "recorded", stateText: "evidence recorded", note: "Workbook sheet W1", reference: null, by: "e", at: "t" }] });
    const w = buildWorkspace({ budget: b, view: missing, facts: facts({ confirmedCents: 280_173_600, priceResolutionReasons: { led_light: encodeManualReason("No SKU", "Quote UXT-001 dated 15 Nov") } }) });
    const led = w.complete.find((c) => c.id === "led_light")!;
    expect(led.evidence?.state).toBe("missing");
    expect(led.how).toMatch(/pricing evidence still to record/);
    expect(w.complete.find((c) => c.id === "flex_auger")!.evidence?.state).toBe("recorded");
    expect(w.summary.blockers[0]).toMatch(/Pricing evidence to record: LED light/);
    expect(w.next.kind).toBe("record_evidence");
    const ok = buildWorkspace({ budget: b, view: view({ manualEvidence: missing.manualEvidence.map((m) => ({ ...m, state: "recorded" })) }), facts: facts({ confirmedCents: 280_173_600 }) });
    expect(ok.complete.find((c) => c.id === "led_light")!.how).toMatch(/evidence recorded/);
    expect(ok.next.kind).not.toBe("record_evidence");
  });
});
