// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import type { BridgeLine, BudgetQuote } from "@/newquip/grower/quote-bridge";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { decodeManualReason } from "@/newquip/quote/estimator-workspace";
import * as pricing from "../pricing-actions";
import { EstimatorWorkspace } from "../[id]/EstimatorWorkspace";

vi.mock("../pricing-actions", () => ({
  getEstimatorPricingAction: vi.fn(),
  applyEstimatorPricingAction: vi.fn(),
  verifyEstimatorCostsAction: vi.fn(),
  attestEstimatorRatesAction: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bundle = (over: Partial<WorkspaceBundle> = {}): WorkspaceBundle => ({
  view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [] },
  verification: { canReview: false, reviewerRoles: ["manager"], verifiableSkus: [] },
  rateAttestation: { canReview: false, reviewerRoles: ["manager"], attestableCurrencies: [] },
  current: null, revisions: [], state: "ESTIMATOR_REVIEW", revision: 1, canEdit: true, ...over,
} as unknown as WorkspaceBundle);

const line = (o: Partial<BridgeLine> & { itemKey: string; label: string }): BridgeLine => ({ status: "priced", reason: "", sku: null, quantity: 1, unitPrice: null, revenueExTax: null, estimatedCost: null, estimatedGP: null, marginPct: null, pricedBy: null, ...o }) as unknown as BridgeLine;
const comp = (id: string, sku: string | null, status = "priced") => ({ id, sku, description: id, qtyPerUnit: 1, quantity: 648, status, reason: "", unitPrice: null, revenueExTax: null, estimatedCost: null });
const test12Budget = (): BudgetQuote => ({
  lines: [
    line({ itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", quantity: 12, unitPrice: 200000, revenueExTax: 2_400_000 }),
    line({ itemKey: "penning_package", label: "Penning", pricedBy: "penning_rate", quantity: 240, unitPrice: 1300, revenueExTax: 312_000 }),
    line({ itemKey: "concrete_slat", label: "Concrete slats", status: "not_in_price_source", sku: "NQ1161", quantity: 15840 }),
    line({ itemKey: "cup_drinker", label: "Cup drinker package", status: "package_unconfirmed", quantity: 648, components: [comp("cup", "QCA00003"), comp("pipe", "NQ1380")] as never }),
    line({ itemKey: "led_light", label: "FORTIS 1.2 LED light", status: "package_unconfirmed", quantity: 456, components: [comp("lum", null, "identity_unresolved"), comp("clip", null, "identity_unresolved")] as never }),
    line({ itemKey: "pvc_door", label: "PVC SST door", status: "unmapped", quantity: 24 }),
    line({ itemKey: "bulk_tank", label: "Bulk tank", status: "not_in_price_source", sku: "SYSH-2750-3", quantity: 12 }),
  ],
  totals: { subtotalExTax: 7_607_144 }, incomplete: true,
  charges: [{ key: "delivery", label: "Delivery", amountExTax: 1_000_000, status: "entered" }, { key: "installation", label: "Installation", amountExTax: 1_300_000, status: "entered" }, { key: "concrete_slat_delivery", label: "Slat delivery", amountExTax: 120_000, status: "entered" }],
} as unknown as BudgetQuote);

const bareDraft = (): QuoteDraft => { const d = readyDraft(); d.estimator.confirmedPackages = []; d.estimator.confirmedMappings = {}; return d; };
const props = (over: Record<string, unknown> = {}) => ({
  quoteId: "q1", state: "ESTIMATOR_REVIEW", confirmedCents: 513_200_000, signedOff: false, draft: bareDraft(), budget: test12Budget(), pageDirty: false, canEdit: true,
  title: "Test12 · Spark", subtitle: "s", siteName: "Test12", reference: "NQ-Q-0033 rev 2", customerName: "Spark", rooms: 12, basis: "Project pricing", refreshKey: "k1", saveDraft: vi.fn(async () => ({ ok: true })), reload: vi.fn(), onGoSignoff: vi.fn(), onGoApproval: vi.fn(), reviewNeeded: false, onMarkReviewed: vi.fn(), ...over,
});
const mount = (over: Record<string, unknown> = {}, b: Partial<WorkspaceBundle> = {}) => { vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle(b) }); render(createElement(EstimatorWorkspace, props(over) as never)); };

describe("final simplification: one compact header, one status per line, a compact sidebar", () => {
  it("shows ONE header with name, reference, customer, rooms, stage, the labelled amount, the Rep amount and the outstanding count", async () => {
    mount();
    const h = await screen.findByTestId("workspace-header");
    expect(h.textContent).toMatch(/Test12/);
    expect(screen.getByTestId("header-ref").textContent).toBe("NQ-Q-0033 rev 2");
    expect(h.textContent).toMatch(/Spark · 12 rooms · Project pricing/);
    expect(screen.getByTestId("header-stage").textContent).toBe("ESTIMATOR REVIEW");
    expect(screen.getByTestId("header-total-label").textContent).toBe("PARTIAL TOTAL, EX VAT");
    expect(screen.getByTestId("header-confirmed").textContent).toBe("R\u00a05\u00a0132\u00a0000,00");
    expect(screen.getByTestId("header-outstanding").textContent).toBe("5 items");
    expect(screen.queryByTestId("header-checks")).toBeNull();
    expect(screen.getAllByTestId("workspace-header")).toHaveLength(1);
  });
  it("puts the legacy detail behind ONE Details disclosure, closed by default", async () => {
    mount({ details: createElement("p", { "data-testid": "legacy-bit" }, "history") });
    const d = await screen.findByTestId("header-details");
    expect(d.hasAttribute("open")).toBe(false);
    expect(within(d).getByTestId("legacy-bit")).toBeTruthy();
  });
  it("each open line has ONE plain status and ONE button; no M/S/C/V legend or indicators", async () => {
    mount();
    const list = await screen.findByTestId("needs-you");
    for (const li of list.querySelectorAll("[data-testid^='task-']")) { expect(within(li as HTMLElement).getAllByTestId("row-status")).toHaveLength(1); expect(within(li as HTMLElement).getAllByRole("button")).toHaveLength(1); }
    expect(list.textContent).not.toMatch(/Mapping complete|Verified not yet/);
    expect(screen.queryByTestId("indicator-legend")).toBeNull();
  });
  it("the sidebar is compact: the long help (what happens next, the four checks) is optional and closed", async () => {
    mount();
    await screen.findByTestId("commercial-summary");
    const help = screen.getByTestId("how-it-works");
    expect(help.hasAttribute("open")).toBe(false);
    expect(screen.queryByTestId("what-next")).toBeNull();
    expect(within(screen.getByTestId("commercial-summary")).queryByTestId("four-checks")).toBeNull();
    expect(within(help).getByTestId("four-checks").textContent).toMatch(/Mapping complete/);
    expect(screen.getByTestId("summary-blockers").querySelectorAll("li").length).toBeLessThanOrEqual(3);
  });
  it("completed lines are collapsed with a count", async () => {
    mount();
    const g = await screen.findByTestId("complete-group");
    expect(g.tagName).toBe("DETAILS");
    expect(g.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("complete-count").textContent).toMatch(/\d+ lines? · 3 charges/);
  });
  it("the collapsed Complete header keeps provisional lines visible, and the editor header counts evidence lines like the list", async () => {
    const m75 = line({ itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", quantity: 12, unitPrice: 200_000, revenueExTax: 2_400_000 });
    const ev = { itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", state: "missing", stateText: "no pricing evidence has been recorded", note: null, reference: null, by: null, at: null };
    mount({ budget: { lines: [m75, line({ itemKey: "concrete_slat", label: "Concrete slats", status: "not_in_price_source", sku: "NQ1161", quantity: 10 })], totals: { subtotalExTax: 2_400_000 }, incomplete: true, charges: [] } }, { view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [ev] } } as never);
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Concrete slats/ }));
    expect(await screen.findByText(/2 tasks open/)).toBeTruthy(); // 1 task + 1 evidence line, as in the list header
  });
  it("shows 'N provisional' in the collapsed Complete header", async () => {
    mount({ draft: (() => { const d = bareDraft(); d.estimator.priceResolutions = { led_light: { unitPriceExVat: 100, reason: "REASON: x\nEVIDENCE: quote 1" } } as never; return d; })(), budget: { lines: [line({ itemKey: "led_light", label: "FORTIS 1.2 LED light", status: "priced", pricedBy: "estimator_resolution", quantity: 4, unitPrice: 100, revenueExTax: 400 })], totals: { subtotalExTax: 400 }, incomplete: false, charges: [] } });
    const p = await screen.findByTestId("complete-provisional");
    expect(p.textContent).toMatch(/1 provisional/);
    expect(screen.getByTestId("complete-group").hasAttribute("open")).toBe(false);
  });
  it("the product editor shows the four readiness checks as a small list", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Bulk tank/ }));
    const r = await screen.findByTestId("editor-readiness");
    expect(r.textContent).toMatch(/Mapping:.*done/);
    expect(r.textContent).toMatch(/Supplier cost:.*needed/);
  });
  it("long amounts with cents never wrap or collide: amounts are nowrap tabular figures that keep their label apart", async () => {
    mount();
    const t = await screen.findByTestId("summary-total");
    expect(t.className).toMatch(/whitespace-nowrap/);
    expect(t.className).toMatch(/tabular-nums/);
    expect(t.parentElement!.className).toMatch(/gap-3/);
    expect(screen.getByTestId("header-total").className).toMatch(/tabular-nums/);
  });
});

describe("evidence needed is an open line, not a hidden completed one", () => {
  it("lists the line with 'Evidence needed' and 'Record evidence', counts it in the header, and never alters the gate", async () => {
    const ev = { itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", state: "missing", stateText: "no pricing evidence has been recorded", note: null, reference: null, by: null, at: null };
    mount({ budget: { lines: [line({ itemKey: "flex_auger", label: "M75 feed system", pricedBy: "estimator_input", quantity: 12, unitPrice: 200_000, revenueExTax: 2_400_000 })], totals: { subtotalExTax: 2_400_000 }, incomplete: false, charges: [] } }, { view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [ev] } } as never);
    const row = await screen.findByTestId("evidence-flex_auger");
    expect(within(row).getByTestId("row-status").textContent).toBe("Evidence needed");
    expect(within(row).getByRole("button", { name: "Record evidence" })).toBeTruthy();
    expect(screen.getByTestId("header-outstanding").textContent).toBe("1 item");
    expect(screen.getByTestId("needs-you").contains(row)).toBe(true);
    expect(screen.getByTestId("next-action").textContent).toMatch(/Record the pricing evidence/i);
  });
});

describe("with the Rep: the one next action is to wait, never an Estimator instruction", () => {
  it("a read-only workspace on a Rep-draft quotation says it is waiting for the Rep", async () => {
    mount({ state: "REP_DRAFT", canEdit: false });
    const na = await screen.findByTestId("next-action");
    expect(na.textContent).toMatch(/Waiting for the Rep to reconfirm the amount and submit it again/);
    expect(na.textContent).not.toMatch(/The Estimator records/);
  });
});
