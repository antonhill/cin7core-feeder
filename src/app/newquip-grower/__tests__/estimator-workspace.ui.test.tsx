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
import { ManualPriceForm, SkuCostForm } from "../[id]/WorkspaceEditors";

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
function mount(o: { saveDraft?: (m: (d: QuoteDraft) => void) => Promise<{ ok: boolean; errors?: string[] }>; canEdit?: boolean; bundleOver?: Partial<WorkspaceBundle>; state?: string } = {}) {
  vi.mocked(pricing.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle(o.bundleOver) });
  const saveDraft = o.saveDraft ?? vi.fn(async () => ({ ok: true }));
  render(createElement(EstimatorWorkspace, {
    quoteId: "q1", state: o.state ?? "ESTIMATOR_REVIEW", confirmedCents: 513_200_000, signedOff: false, draft: bareDraft(), budget: test12Budget(), pageDirty: false, canEdit: o.canEdit ?? true,
    title: "Test12 · Spark", subtitle: "12 rooms · Project pricing · Revision 1 · Supplier pricing on", refreshKey: "k1", saveDraft, reload: vi.fn(), onGoSignoff: vi.fn(), onGoApproval: vi.fn(), reviewNeeded: false, onMarkReviewed: vi.fn(),
  }));
  return { saveDraft: saveDraft as ReturnType<typeof vi.fn> };
}

describe("the workspace: header, exception-first tasks and compact indicators", () => {
  it("lists the decisions first, then the cost-only line, each with four labelled indicators", async () => {
    mount();
    const list = await screen.findByTestId("needs-you");
    const ids = [...list.querySelectorAll("[data-testid^='task-']")].map((e) => e.getAttribute("data-testid"));
    expect(ids).toEqual(["task-cup_drinker", "task-led_light", "task-pvc_door", "task-concrete_slat", "task-bulk_tank"]);
    const tank = within(screen.getByTestId("indicators-bulk_tank")).getAllByRole("img").map((i) => i.getAttribute("aria-label"));
    expect(tank).toEqual(["Mapping complete", "Selling price needed", "Supplier cost needed", "Verified not yet"]);
    expect(within(screen.getByTestId("indicators-pvc_door")).getAllByRole("img").map((i) => i.getAttribute("aria-label"))[0]).toBe("Mapping needed");
    expect(screen.getByTestId("indicator-legend").textContent).toMatch(/Mapping.*Selling price.*Supplier cost.*Verified/);
  });
  it("M75 and penning are completed Estimator-priced lines, not tasks", async () => {
    mount();
    await screen.findByTestId("needs-you");
    expect(screen.getByTestId("complete-flex_auger").textContent).toMatch(/not a product mapping/);
    expect(screen.getByTestId("complete-penning_package")).toBeTruthy();
    expect(screen.queryByTestId("task-flex_auger")).toBeNull();
  });
  it("a partial quotation is never a contract value and its margin is never verified", async () => {
    mount();
    await screen.findByTestId("commercial-summary");
    expect(screen.getByTestId("summary-kind").textContent).toBe("PARTIAL AND INDICATIVE. NOT A CONTRACT VALUE.");
    expect(screen.getByTestId("header-total-label").textContent).toBe("PARTIAL TOTAL, EX VAT");
    expect(screen.getByTestId("header-total").textContent).toBe("R7,607,144");
    expect(screen.getByTestId("summary-confirmed").textContent).toMatch(/R5,132,000/);
    expect(screen.getByTestId("summary-margin").textContent).not.toMatch(/verified$/);
    expect(screen.getByTestId("four-checks").textContent).toMatch(/FOUR SEPARATE CHECKS/);
  });
  it("one next action: open the first task", async () => {
    mount();
    expect((await screen.findByTestId("next-action")).textContent).toMatch(/Open task 1 of 5/);
  });
  it("a viewer who cannot edit gets disabled task buttons (nothing can be opened)", async () => {
    mount({ canEdit: false });
    await screen.findByTestId("needs-you");
    for (const b of within(screen.getByTestId("needs-you")).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the PVC door: choose one of five candidates, then price it", () => {
  it("shows the five Cin7 candidates; saving the product alone saves ONLY the mapping through the draft save; pricing waits until a product is chosen", async () => {
    const { saveDraft } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Choose and price: PVC SST door/ }));
    const choice = await screen.findByTestId("product-choice");
    expect(within(choice).getAllByRole("radio").map((r) => (r as HTMLInputElement).closest("label")!.textContent!.match(/NQ\d+/)![0])).toEqual(["NQ2114", "NQ2113", "NQ2112", "NQ2161", "NQ2281"]);
    expect(screen.getByTestId("door-pricing-wait")).toBeTruthy();
    const only = screen.getByRole("button", { name: "Save the product choice only" }) as HTMLButtonElement;
    expect(only.disabled).toBe(true);
    fireEvent.click(within(choice).getAllByRole("radio")[0]);
    expect(only.disabled).toBe(false);
    expect(screen.getByTestId("door-pricing").textContent).toMatch(/supplier cost for NQ2114/);
    fireEvent.click(only);
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    const d = readyDraft(); delete d.estimator.confirmedMappings.pvc_door;
    (saveDraft.mock.calls[0][0] as (d: QuoteDraft) => void)(d);
    expect(d.estimator.confirmedMappings.pvc_door).toBe("NQ2114");
    expect(pricing.applyEstimatorPricingAction).not.toHaveBeenCalled(); // the price part stays open
  });
});

describe("unsaved edits are never lost silently", () => {
  it("leaving an editor with typed values asks first; Keep editing keeps them; Discard leaves", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Enter cost: Bulk tank/ }));
    const cost = await screen.findByLabelText("Unit cost (up to 7 decimals)");
    fireEvent.change(cost, { target: { value: "120000" } });
    fireEvent.click(screen.getByRole("button", { name: "← Back to tasks" }));
    expect(screen.getByTestId("unsaved-warning")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("120000");
    fireEvent.click(screen.getByRole("button", { name: "← Back to tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and continue" }));
    expect(await screen.findByTestId("needs-you")).toBeTruthy();
  });
});

describe("the supplier-cost editor", () => {
  const form = (save = vi.fn(async () => ({ ok: true })), onDirty = vi.fn(), current: WorkspaceBundle["current"] = null) => {
    render(createElement(SkuCostForm, { sku: "NQ1161", label: "Concrete slats", quantity: 100, bundle: bundle({ current }), canEdit: true, save, onDirty }));
    return { save, onDirty };
  };
  const type = (label: string | RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
  const saveBtn = () => screen.getByRole("button", { name: "Save cost" }) as HTMLButtonElement;

  it("Save stays disabled until the cost and its source are given; the reason is named beside the button", () => {
    form();
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("save-why").textContent).toMatch(/Needs: Enter the supplier cost/);
    type("Unit cost (up to 7 decimals)", "193.60");
    expect(screen.getByTestId("save-why").textContent).toMatch(/Needs: Say where this cost comes from/);
    type("Where this cost comes from", "Supplier quote 12 Nov");
    expect(saveBtn().disabled).toBe(false);
  });
  it("more than 7 decimals is refused, never rounded", () => {
    form();
    type("Where this cost comes from", "Supplier quote");
    type("Unit cost (up to 7 decimals)", "6.54547551");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getAllByText(/At most 7 decimal places are allowed/).length).toBeGreaterThan(0);
    type("Unit cost (up to 7 decimals)", "6.5454755");
    expect(saveBtn().disabled).toBe(false);
  });
  it("shows the pricing model's own landed cost and selling price (20% rule) for the typed values, marked unverified", () => {
    form();
    type("Unit cost (up to 7 decimals)", "193.60");
    type("Where this cost comes from", "Supplier quote");
    const calc = screen.getByTestId("live-calc").textContent!;
    expect(calc).toMatch(/Landed cost each.*R194|Landed cost each.*R193/);
    expect(calc).toMatch(/Selling price each.*R232/);
    expect(calc).toMatch(/UNVERIFIED/);
  });
  it("a foreign currency asks for a rate and its source before it can be saved", () => {
    form();
    type("Unit cost (up to 7 decimals)", "6.5454755");
    type("Where this cost comes from", "Cin7 supplier price");
    type("Currency", "USD");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("save-why").textContent).toMatch(/USD spot rate/);
    type("USD spot rate", "16.5555");
    type("Rate source", "rate table");
    expect(saveBtn().disabled).toBe(false);
  });
  it("a refused save keeps every typed value and shows the server's reason", async () => {
    const save = vi.fn(async () => ({ ok: false, errors: ["Someone else changed this cost. Reload and try again."] }));
    form(save);
    type("Unit cost (up to 7 decimals)", "193.60");
    type("Where this cost comes from", "Supplier quote");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByTestId("save-errors").textContent).toMatch(/Someone else changed this cost/));
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("193.60");
    expect(saveBtn().disabled).toBe(false);
  });
  it("reports unsaved typing to the workspace", () => {
    const { onDirty } = form();
    type("Unit cost (up to 7 decimals)", "1");
    expect(onDirty).toHaveBeenLastCalledWith(true);
  });
});

describe("the LED manual quotation price: provisional, with a mandatory reason and evidence", () => {
  const render2 = (existing?: { unitPriceExVat: number; reason: string }, save = vi.fn(async () => ({ ok: true }))) => {
    render(createElement(ManualPriceForm, { itemKey: "led_light", label: "FORTIS 1.2 LED light", quantity: 456, existing, canEdit: true, save, onDirty: vi.fn() }));
    return save;
  };
  it("is labelled provisional and needs price, reason AND evidence", () => {
    render2();
    expect(screen.getByTestId("provisional-banner").textContent).toMatch(/PROVISIONAL.*Manual quotation price/);
    const btn = screen.getByRole("button", { name: "Save manual price" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Price each (R)"), { target: { value: "881" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "No SKU exists yet" } });
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("save-why").textContent).toMatch(/Enter the pricing evidence/);
    fireEvent.change(screen.getByLabelText("Pricing evidence"), { target: { value: "Supplier quote 7, dated 12 Nov" } });
    expect(btn.disabled).toBe(false);
  });
  it("stores both inputs in the labelled format in the existing reason field", async () => {
    const save = render2();
    fireEvent.change(screen.getByLabelText("Price each (R)"), { target: { value: "881" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "No SKU exists yet" } });
    fireEvent.change(screen.getByLabelText("Pricing evidence"), { target: { value: "Supplier quote 7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save manual price" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("led_light", 881, "REASON: No SKU exists yet\nEVIDENCE: Supplier quote 7"));
  });
  it("reopens with both inputs decoded; an earlier free-text reason is shown whole with a note that evidence is missing", () => {
    render2({ unitPriceExVat: 881, reason: "REASON: No SKU exists yet\nEVIDENCE: Supplier quote 7" });
    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("No SKU exists yet");
    expect((screen.getByLabelText("Pricing evidence") as HTMLTextAreaElement).value).toBe("Supplier quote 7");
    cleanup();
    render2({ unitPriceExVat: 881, reason: "Phoned the supplier" });
    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("Phoned the supplier");
    expect((screen.getByLabelText("Pricing evidence") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("legacy-reason")).toBeTruthy();
    expect(decodeManualReason("Phoned the supplier").legacy).toBe(true);
  });
});

describe("the cup drinker: confirm the seven-component package, then cost the components", () => {
  it("the component table appears only once the package is confirmed", async () => {
    const { saveDraft } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /Map and price: Cup drinker package/ }));
    const confirm = await screen.findByTestId("package-confirm");
    expect(screen.queryByTestId("component-table")).toBeNull();
    fireEvent.click(within(confirm).getByRole("checkbox"));
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    const d = readyDraft(); d.estimator.confirmedPackages = [];
    (saveDraft.mock.calls[0][0] as (d: QuoteDraft) => void)(d);
    expect(d.estimator.confirmedPackages).toContain("cup_drinker");
    expect(screen.getByRole("button", { name: /manual price for the whole cup drinker package/i })).toBeTruthy();
  });
});
