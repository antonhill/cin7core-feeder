// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import type { BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import type { QuoteDraft } from "@/newquip/grower/draft";
import * as pricing from "../pricing-actions";
import { ActivationPanel } from "../[id]/ActivationPanel";
import { EstimatorWorkspace } from "../[id]/EstimatorWorkspace";
import { SkuCostForm } from "../[id]/WorkspaceEditors";

// UX correction pass: one write + one page read per save, the editor updating at once, exact cents, the activation path, the excluded-until-costed explanation and the evidence record.
vi.mock("../pricing-actions", () => ({
  getEstimatorPricingAction: vi.fn(), applyEstimatorPricingAction: vi.fn(), verifyEstimatorCostsAction: vi.fn(), attestEstimatorRatesAction: vi.fn(), recordManualPriceEvidenceAction: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bundle = (over: Record<string, unknown> = {}): WorkspaceBundle => ({
  view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [] },
  verification: { canReview: false, reviewerRoles: ["manager"], verifiableSkus: [] }, rateAttestation: { canReview: false, reviewerRoles: ["manager"], attestableCurrencies: [] },
  current: null, revisions: [], state: "ESTIMATOR_REVIEW", revision: 1, canEdit: true, ...over,
} as unknown as WorkspaceBundle);
const line = (o: Partial<BridgeLine> & { itemKey: string; label: string }): BridgeLine => ({ status: "priced", reason: "", sku: null, quantity: 1, unitPrice: null, revenueExTax: null, estimatedCost: null, estimatedGP: null, marginPct: null, pricedBy: null, ...o }) as unknown as BridgeLine;
const slatOpen = () => line({ itemKey: "concrete_slat", label: "Concrete slats", status: "not_in_price_source", sku: "NQ1161", quantity: 100 });
const slatPriced = () => line({ itemKey: "concrete_slat", label: "Concrete slats", sku: "NQ1161", quantity: 100, unitPrice: 232.32, revenueExTax: 23_232, pricedBy: "price_source" });
const tank = () => line({ itemKey: "bulk_tank", label: "Bulk tank", status: "not_in_price_source", sku: "SYSH-2750-3", quantity: 12 });
const budgetOf = (lines: BridgeLine[], subtotal: number): BudgetQuote => ({ lines, totals: { subtotalExTax: subtotal }, incomplete: true, charges: [] } as unknown as BudgetQuote);
const bare = (): QuoteDraft => { const d = readyDraft(); d.estimator.confirmedPackages = []; d.estimator.confirmedMappings = {}; return d; };
const type = (label: string | RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });

describe("exact cents in the supplier-cost editor", () => {
  it("R193.60 stays R193.60: landed cost, selling price and the line total show their cents", () => {
    render(createElement(SkuCostForm, { sku: "NQ1161", label: "Concrete slats", quantity: 100, bundle: bundle(), canEdit: true, save: vi.fn(async () => ({ ok: true })), onDirty: vi.fn() }));
    type("Unit cost (up to 7 decimals)", "193.60"); type("Where this cost comes from", "Supplier quote");
    const calc = screen.getByTestId("live-calc").textContent!;
    expect(calc).toMatch(/Landed cost each\s*R193\.60/);
    expect(calc).toMatch(/Selling price each\s*R232\.32/);
    expect(calc).toMatch(/× 100\s*R23,232\.00/);
    expect(screen.getByTestId("calc-price-inline").textContent).toBe("R232.32 each, ex VAT.");
  });
  it("R800 costs R960.00 each and the 7-decimal cost is untouched", () => {
    render(createElement(SkuCostForm, { sku: "NQ2114", label: "PVC SST door", quantity: 24, bundle: bundle(), canEdit: true, save: vi.fn(async () => ({ ok: true })), onDirty: vi.fn() }));
    type("Unit cost (up to 7 decimals)", "800"); type("Where this cost comes from", "Supplier quote");
    expect(screen.getByTestId("live-calc").textContent).toMatch(/Selling price each\s*R960\.00/);
    expect(screen.getByTestId("live-calc").textContent).toMatch(/× 24\s*R23,040\.00/);
  });
});

/** Behaves like the page: a reload re-reads the quotation (new budget, new refresh key) and settles when the figures are shown. */
function Host({ reloadMs = 0 }: { reloadMs?: number }) {
  const [budget, setBudget] = useState<BudgetQuote>(budgetOf([slatOpen(), tank()], 1_000));
  const [key, setKey] = useState("k0");
  const reload = async () => { await new Promise((r) => setTimeout(r, reloadMs)); setBudget(budgetOf([slatPriced(), tank()], 24_232)); setKey("k1"); };
  return createElement(EstimatorWorkspace, { quoteId: "q1", state: "ESTIMATOR_REVIEW", confirmedCents: 100_000, signedOff: false, draft: bare(), budget, pageDirty: false, canEdit: true, title: "T · Spark", subtitle: "s", refreshKey: key, saveDraft: async () => ({ ok: true }), reload, onGoSignoff: () => {}, onGoApproval: () => {}, reviewNeeded: false, onMarkReviewed: () => {} });
}
const applyOk = (ws: WorkspaceBundle) => ({ ok: true, data: { seq: 2, kind: "CHANGED", changedValues: 1, confirmation: null, workspace: ws } });

describe("a save is ONE write and ONE page read, and the whole editor is current when it finishes", () => {
  beforeEach(() => { vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle() }); });
  it("the supplier-cost save does not read the workspace before or after it (the write returns it), and the page's own change does not trigger another read", async () => {
    vi.mocked(pricing.applyEstimatorPricingAction).mockResolvedValue(applyOk(bundle({ view: { rows: [{ sku: "NQ1161", costState: "unverified", status: "priced", usedBy: [], quantity: 100 }], costs: { required: 1, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [] } })) as never);
    render(createElement(Host, { reloadMs: 20 }));
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Concrete slats/ }));
    type("Unit cost (up to 7 decimals)", "193.60"); type("Where this cost comes from", "Supplier quote");
    expect(pricing.getEstimatorPricingAction).toHaveBeenCalledTimes(1); // only the opening read
    fireEvent.click(screen.getByRole("button", { name: "Save cost" }));
    await waitFor(() => expect(screen.getByTestId("pricing-note").textContent).toMatch(/Saved as revision 2/));
    await waitFor(() => expect(screen.queryByTestId("refreshing-note")).toBeNull());
    expect(pricing.applyEstimatorPricingAction).toHaveBeenCalledTimes(1);
    expect(pricing.getEstimatorPricingAction).toHaveBeenCalledTimes(1); // still only the opening read: no pre-save read, no post-save read, no key-change read
  });
  it("the editor heading, task count, summary and next action show the new figures as soon as the save has finished", async () => {
    vi.mocked(pricing.applyEstimatorPricingAction).mockResolvedValue(applyOk(bundle({ view: { rows: [{ sku: "NQ1161", costState: "unverified", status: "priced", usedBy: [], quantity: 100 }], costs: { required: 1, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [] } })) as never);
    render(createElement(Host));
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Concrete slats/ }));
    expect(screen.getByText(/2 tasks open/)).toBeTruthy();
    type("Unit cost (up to 7 decimals)", "193.60"); type("Where this cost comes from", "Supplier quote");
    fireEvent.click(screen.getByRole("button", { name: "Save cost" }));
    await waitFor(() => expect(screen.getByText(/1 task open/)).toBeTruthy()); // the heading line
    expect(screen.getByText(/partial total R24,232\.00/)).toBeTruthy();
    expect(screen.getByTestId("header-total").textContent).toBe("R24,232.00");
    expect(screen.getByTestId("next-action").textContent).toMatch(/Open task 1 of 1|bulk tank/i);
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("193.60"); // the typed value stays
  });
  it("a refused write keeps everything typed, shows the reason, and reads nothing else", async () => {
    vi.mocked(pricing.applyEstimatorPricingAction).mockResolvedValue({ ok: false, error: "Someone else changed this cost.", errors: ["Someone else changed this cost."] });
    render(createElement(Host));
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Concrete slats/ }));
    type("Unit cost (up to 7 decimals)", "193.60"); type("Where this cost comes from", "Supplier quote");
    fireEvent.click(screen.getByRole("button", { name: "Save cost" }));
    await waitFor(() => expect(screen.getByTestId("save-errors").textContent).toMatch(/Someone else changed this cost/));
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("193.60");
    expect(pricing.getEstimatorPricingAction).toHaveBeenCalledTimes(1);
  });
  it("the write is made against the workspace as last read (its stored pricing), so a change by someone else is a refusal, not an overwrite", async () => {
    const stored = { ruleVersionId: "legacy-poc", skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };
    vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle({ current: stored }) });
    vi.mocked(pricing.applyEstimatorPricingAction).mockResolvedValue(applyOk(bundle()) as never);
    render(createElement(Host));
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Concrete slats/ }));
    type("Unit cost (up to 7 decimals)", "193.60"); type("Where this cost comes from", "Supplier quote");
    fireEvent.click(screen.getByRole("button", { name: "Save cost" }));
    await waitFor(() => expect(pricing.applyEstimatorPricingAction).toHaveBeenCalled());
    expect(vi.mocked(pricing.applyEstimatorPricingAction).mock.calls[0][3]).toEqual(stored); // base = what the edits were made against
  });
});

describe("evidence of a manual or Estimator-priced line is the real evidence record", () => {
  const m75 = () => line({ itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", quantity: 12, unitPrice: 200_000, revenueExTax: 2_400_000 });
  const ev = (state: string) => ({ itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", state, stateText: state === "missing" ? "no pricing evidence has been recorded" : "evidence recorded", note: null, reference: null, by: null, at: null });
  const mountWith = (state: string) => {
    vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle({ view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [ev(state)] } }) });
    render(createElement(EstimatorWorkspace, { quoteId: "q1", state: "ESTIMATOR_REVIEW", confirmedCents: 240_000_000, signedOff: false, draft: bare(), budget: { lines: [m75()], totals: { subtotalExTax: 2_400_000 }, incomplete: false, charges: [] } as unknown as BudgetQuote, pageDirty: false, canEdit: true, title: "T", subtitle: "s", refreshKey: "k", saveDraft: async () => ({ ok: true }), reload: async () => {}, onGoSignoff: () => {}, onGoApproval: () => {}, reviewNeeded: false, onMarkReviewed: () => {} }));
  };
  it("missing evidence is shown on the line and is the next action; the Estimator records it with the existing action, and no price changes", async () => {
    vi.mocked(pricing.recordManualPriceEvidenceAction).mockResolvedValue({ ok: true, data: { seq: 3, recorded: 1 } });
    mountWith("missing");
    const row = await screen.findByTestId("evidence-flex_auger");
    expect(row.getAttribute("data-state")).toBe("missing");
    expect(row.textContent).toMatch(/Evidence needed.*no pricing evidence has been recorded/);
    expect(screen.getByTestId("next-action").textContent).toMatch(/Record the pricing evidence for m75 feed system/i);
    fireEvent.click(within(row).getByRole("button", { name: "Record evidence" }));
    const save = within(row).getByRole("button", { name: "Save evidence" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(row).getByLabelText(/What this price is based on/), { target: { value: "short" } });
    expect(save.disabled).toBe(true); // at least 10 characters
    fireEvent.change(within(row).getByLabelText(/What this price is based on/), { target: { value: "Workbook sheet W1, 12 systems" } });
    fireEvent.click(save);
    await waitFor(() => expect(pricing.recordManualPriceEvidenceAction).toHaveBeenCalledWith("q1", [{ itemKey: "flex_auger", note: "Workbook sheet W1, 12 systems" }]));
    expect(pricing.applyEstimatorPricingAction).not.toHaveBeenCalled();
  });
  it("recorded evidence reads 'Evidence recorded' and is not the next action", async () => {
    mountWith("recorded");
    const row = await screen.findByTestId("evidence-flex_auger");
    expect(row.getAttribute("data-state")).toBe("recorded");
    expect(row.textContent).toMatch(/Evidence recorded/);
    expect(screen.getByTestId("next-action").textContent).not.toMatch(/Record the pricing evidence/);
  });
});

describe("excluded until costed: the summary names the lines that dropped out of the total", () => {
  it("lists each previously priced line with its previous amount, labelled partial", async () => {
    vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle() });
    const comparison = { rows: [{ key: "bulk_tank", kind: "line", label: "Bulk tank", original: { quantity: 12, unitPriceExVat: 36234, revenueCents: 43_480_800, status: "priced" }, current: { quantity: 12, unitPriceExVat: null, revenueCents: null, status: "not_in_price_source" } }] } as never;
    render(createElement(EstimatorWorkspace, { quoteId: "q1", state: "ESTIMATOR_REVIEW", confirmedCents: 100_000, signedOff: false, draft: bare(), budget: budgetOf([slatOpen(), tank()], 1_000), pageDirty: false, canEdit: true, title: "T", subtitle: "s", refreshKey: "k", saveDraft: async () => ({ ok: true }), reload: async () => {}, onGoSignoff: () => {}, onGoApproval: () => {}, reviewNeeded: false, onMarkReviewed: () => {}, comparison }));
    const box = await screen.findByTestId("excluded-lines");
    expect(box.textContent).toMatch(/Excluded from this total until costed/);
    expect(within(box).getByTestId("excluded-bulk_tank").textContent).toMatch(/Bulk tank.*needs a supplier cost.*was R434,808\.00/);
    expect(within(box).getByTestId("excluded-total").textContent).toBe("R434,808.00");
    expect(screen.getByTestId("summary-kind").textContent).toMatch(/PARTIAL AND INDICATIVE/);
  });
});

describe("switching supplier pricing on from the new experience", () => {
  const b = () => budgetOf([line({ itemKey: "bulk_tank", label: "Bulk tank", sku: "SYSH-2750-3", quantity: 12, unitPrice: 36_234, revenueExTax: 434_808, pricedBy: "price_source" }), line({ itemKey: "feeder", label: "CCM feeder", sku: "PNQ082", quantity: 216, unitPrice: 9_446, revenueExTax: 2_040_336, pricedBy: "price_source" }), line({ itemKey: "flex_auger", label: "M75", quantity: 12, unitPrice: 200_000, revenueExTax: 2_400_000, pricedBy: "estimator_input" })], 4_875_144);
  const mountAct = (canEdit = true) => { const reload = vi.fn(async () => {}); render(createElement(ActivationPanel, { quoteId: "q1", budget: b(), confirmedCents: 487_514_400, canEdit, reload })); return { reload }; };
  beforeEach(() => { vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle() }); });
  it("shows the entry and, before anything happens, the preview: which lines leave the total, their amounts, the partial total after, and that the Rep's confirmation may be withdrawn", async () => {
    mountAct();
    expect(screen.getByTestId("activation-panel").textContent).toMatch(/supplier pricing is off/);
    expect(screen.queryByTestId("activation-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("activation-start"));
    const pv = await screen.findByTestId("activation-preview");
    expect(within(pv).getByTestId("activation-excluded-bulk_tank").textContent).toMatch(/now R434,808\.00/);
    expect(within(pv).getByTestId("activation-excluded-feeder").textContent).toMatch(/now R2,040,336\.00/);
    expect(within(pv).getByTestId("activation-excluded-total").textContent).toBe("R2,475,144.00");
    expect(within(pv).getByTestId("activation-total-after").textContent).toBe("R2,400,000.00");
    expect(pv.textContent).toMatch(/partial, indicative total, never a completed quotation value/);
    expect(pv.textContent).toMatch(/Rep's confirmation is withdrawn/);
  });
  it("the first supplier cost is the activation: it uses the existing action with NO stored pricing as its base, then the page is re-read", async () => {
    vi.mocked(pricing.applyEstimatorPricingAction).mockResolvedValue(applyOk(bundle()) as never);
    const { reload } = mountAct();
    fireEvent.click(screen.getByTestId("activation-start"));
    await screen.findByTestId("activation-form");
    type("Unit cost (up to 7 decimals)", "30195"); type("Where this cost comes from", "Supplier quote");
    fireEvent.click(screen.getByRole("button", { name: "Save cost and switch on supplier pricing" }));
    await waitFor(() => expect(pricing.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    const [qid, sub, reason, base] = vi.mocked(pricing.applyEstimatorPricingAction).mock.calls[0];
    expect(qid).toBe("q1"); expect(base).toBeNull(); expect(reason).toMatch(/switch on supplier pricing/);
    expect(Object.keys((sub as { skus: object }).skus)).toEqual(["SYSH-2750-3"]);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
  it("a refusal keeps the typed cost and says why; a viewer who cannot edit gets no button", async () => {
    vi.mocked(pricing.applyEstimatorPricingAction).mockResolvedValue({ ok: false, error: "Supplier pricing applies to project quotations only.", errors: ["Supplier pricing applies to project quotations only."] });
    const { reload } = mountAct();
    fireEvent.click(screen.getByTestId("activation-start"));
    await screen.findByTestId("activation-form");
    type("Unit cost (up to 7 decimals)", "30195"); type("Where this cost comes from", "Supplier quote");
    fireEvent.click(screen.getByRole("button", { name: "Save cost and switch on supplier pricing" }));
    await waitFor(() => expect(screen.getByTestId("save-errors").textContent).toMatch(/project quotations only/));
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("30195");
    expect(reload).not.toHaveBeenCalled();
    cleanup();
    mountAct(false);
    expect(screen.queryByTestId("activation-start")).toBeNull();
  });
});

describe("saving a manual price records its evidence only where the server needs it, and never reports a false failure", () => {
  const led = () => line({ itemKey: "led_light", label: "FORTIS 1.2 LED light", status: "package_unconfirmed", quantity: 456, components: [{ id: "lum", sku: null, description: "lum", qtyPerUnit: 1, quantity: 456, status: "identity_unresolved", reason: "", unitPrice: null, revenueExTax: null, estimatedCost: null }] as never });
  const row = (state: string, note: string | null) => ({ itemKey: "led_light", label: "FORTIS 1.2 LED light", pricedBy: "estimator_resolution", state, stateText: state, note, reference: null, by: "e", at: "t" });
  const ws = (rows: unknown[]) => bundle({ view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: rows } });
  const EVID = "Supplier quote UXT-001 dated 15 Nov";
  async function saveLed(rows: unknown[], fresh: unknown[] = rows) {
    vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValueOnce({ ok: true, data: ws(rows) }).mockResolvedValue({ ok: true, data: ws(fresh) });
    render(createElement(EstimatorWorkspace, { quoteId: "q1", state: "ESTIMATOR_REVIEW", confirmedCents: 100_000, signedOff: false, draft: bare(), budget: budgetOf([led()], 1_000), pageDirty: false, canEdit: true, title: "T", subtitle: "s", refreshKey: "k", saveDraft: async () => ({ ok: true }), reload: async () => {}, onGoSignoff: () => {}, onGoApproval: () => {}, reviewNeeded: false, onMarkReviewed: () => {} }));
    fireEvent.click(await screen.findByRole("button", { name: /Quote price: FORTIS/ }));
    type("Price each (R)", "881"); type("Reason", "No SKU yet"); type("Pricing evidence", EVID);
    fireEvent.click(screen.getByRole("button", { name: "Save manual price" }));
  }
  it("a reason-only re-save (same price, evidence already recorded and matching) calls no evidence action and shows success", async () => {
    await saveLed([row("recorded", EVID)]);
    await waitFor(() => expect(screen.getByTestId("save-why").textContent).toMatch(/Saved\./));
    expect(pricing.recordManualPriceEvidenceAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("save-errors")).toBeNull();
  });
  it("a changed price (evidence outdated) re-records the evidence", async () => {
    vi.mocked(pricing.recordManualPriceEvidenceAction).mockResolvedValue({ ok: true, data: { seq: 4, recorded: 1 } });
    await saveLed([row("outdated", EVID)]);
    await waitFor(() => expect(pricing.recordManualPriceEvidenceAction).toHaveBeenCalledWith("q1", [{ itemKey: "led_light", note: EVID }]));
    await waitFor(() => expect(screen.getByTestId("save-why").textContent).toMatch(/Saved\./));
  });
  it("'Nothing changed.' from the server means already recorded: success, not a false partial failure", async () => {
    vi.mocked(pricing.recordManualPriceEvidenceAction).mockResolvedValue({ ok: false, error: "Nothing changed.", errors: ["Nothing changed."] });
    await saveLed([row("missing", null)]);
    await waitFor(() => expect(screen.getByTestId("save-why").textContent).toMatch(/Saved\./));
    expect(screen.queryByTestId("save-errors")).toBeNull();
  });
  it("a genuine refusal still says honestly that the price was saved but the evidence was not", async () => {
    vi.mocked(pricing.recordManualPriceEvidenceAction).mockResolvedValue({ ok: false, error: "The note is too short.", errors: ["The note is too short."] });
    await saveLed([row("missing", null)]);
    await waitFor(() => expect(screen.getByTestId("save-errors").textContent).toMatch(/The price was saved, but its evidence could not be recorded.*too short/));
  });
  it("a mixed package (the server lists no evidence row for it): no evidence call, no evidence gate", async () => {
    await saveLed([], []);
    await waitFor(() => expect(screen.getByTestId("save-why").textContent).toMatch(/Saved\./));
    expect(pricing.recordManualPriceEvidenceAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("evidence-led_light")).toBeNull();
  });
});
