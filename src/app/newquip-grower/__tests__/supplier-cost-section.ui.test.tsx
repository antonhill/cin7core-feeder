// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import { SkuCostForm } from "../[id]/WorkspaceEditors";
import * as supplier from "../supplier-actions";

// THE ONE SUPPLIER COST FORM (the first-task form and every product editor are this component): the supplier is CHOSEN from Cin7 (the product's own suppliers first, then a search), the currency is DERIVED from the
// supplier's Cin7 record, a missing Cin7 currency is the one marked exception (a reason, never a silent default), what Cin7 already holds is shown first, and the kinds of cost are never blurred.
vi.mock("../supplier-actions", () => ({ getSkuCostContextAction: vi.fn(), searchCin7SuppliersAction: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const rec = (id: string, name: string, cost: string | null, currency: string | null, lastSupplied: string | null, over: Record<string, unknown> = {}) => ({ supplierId: id, supplierName: name, active: true, cost, currency, currencySource: currency ? ("cin7_supplier" as const) : null, productCurrency: null as string | null, lastSupplied, ...over });
const ctx = (suppliers: ReturnType<typeof rec>[], over: Record<string, unknown> = {}) => ({ ok: true, data: { sku: "ERT053", found: true, productName: "Feed saver mat", averageCostUndated: null, suppliers, retrievedAt: "2026-11-17T08:00:00Z", ...over } });
const hit = (id: string, name: string, currency: string | null) => ({ supplierId: id, name, currency });
const bundle = (current: PricingSubmission | null = null): WorkspaceBundle => ({
  view: { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, currencies: [], manualEvidence: [] },
  verification: { canReview: false, reviewerRoles: ["manager"], verifiableSkus: [] }, rateAttestation: { canReview: false, reviewerRoles: ["manager"], attestableCurrencies: [] },
  current, revisions: [], state: "ESTIMATOR_REVIEW", revision: 1, canEdit: true,
} as unknown as WorkspaceBundle);
const ALPINE = rec("S2", "Alpine Imports", "26.8440995", "EUR", "2026-03-02");
const mount = (over: { canEdit?: boolean; current?: PricingSubmission | null; save?: ReturnType<typeof vi.fn> } = {}) => {
  const save = over.save ?? vi.fn(async () => ({ ok: true }));
  render(createElement(SkuCostForm, { quoteId: "q1", sku: "ERT053", label: "Feed saver mat", quantity: 216, bundle: bundle(over.current ?? null), canEdit: over.canEdit ?? true, save: save as never, onDirty: vi.fn() }));
  return save;
};
const typeIn = (label: string | RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
const saveBtn = () => screen.getByRole("button", { name: "Save cost" }) as HTMLButtonElement;

beforeEach(() => {
  vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([ALPINE, rec("S1", "Alpha Plastics", "10", "ZAR", null)]) as never);
  vi.mocked(supplier.searchCin7SuppliersAction).mockResolvedValue({ ok: true, data: { hits: [hit("S7", "Zeta Foods", "USD"), hit("S8", "Zeta Nocur", null)], total: 2, truncated: false } });
});

describe("the supplier is chosen from Cin7, never typed", () => {
  it("there is no free-text supplier box or typed currency: just a search over Cin7 and the product's own suppliers", async () => {
    mount();
    await screen.findByTestId("cin7-supplier-records");
    expect(screen.queryByLabelText("Supplier")).toBeNull();
    expect(screen.queryByLabelText("Currency")).toBeNull();
    expect(screen.getByLabelText(/Search all active Cin7 suppliers/)).toBeTruthy();
  });

  it("the product's OWN Cin7 suppliers are offered first, with Cin7's price, currency and last-supplied date", async () => {
    mount();
    const list = await screen.findByTestId("cin7-supplier-records");
    const first = within(list).getAllByRole("button")[0];
    expect(first.textContent).toMatch(/Alpine Imports/);
    expect(first.textContent).toMatch(/EUR 26\.8440995/);
    expect(first.textContent).toMatch(/last supplied 2026-03-02/);
    expect(within(list).getAllByRole("button")[1].textContent).toMatch(/date not recorded/); // an undated price stays undated
  });

  it("searching other active Cin7 suppliers: two letters, debounced, results show each supplier's Cin7 currency", async () => {
    mount();
    await screen.findByTestId("cin7-supplier-records");
    typeIn(/Search all active Cin7 suppliers/, "z");
    await new Promise((r) => setTimeout(r, 450));
    expect(supplier.searchCin7SuppliersAction).not.toHaveBeenCalled(); // under two characters
    typeIn(/Search all active Cin7 suppliers/, "zeta");
    const hits = await screen.findByTestId("supplier-hits");
    expect(within(hits).getAllByRole("button").map((b) => b.textContent)).toEqual(["Zeta FoodsUSD", "Zeta Nocurno currency in Cin7"]);
    expect(supplier.searchCin7SuppliersAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("supplier-search-status").textContent).toBe("2 matching suppliers");
  });

  it("a search with no match says so; a Cin7 failure in the search says so and keeps the form usable", async () => {
    mount();
    await screen.findByTestId("cin7-supplier-records");
    vi.mocked(supplier.searchCin7SuppliersAction).mockResolvedValueOnce({ ok: true, data: { hits: [], total: 0, truncated: false } });
    typeIn(/Search all active Cin7 suppliers/, "nothing");
    await waitFor(() => expect(screen.getByTestId("supplier-search-status").textContent).toBe("No active Cin7 supplier matches."));
    vi.mocked(supplier.searchCin7SuppliersAction).mockResolvedValueOnce({ ok: false, error: "Cin7 supplier data is not available right now. Nothing was changed." });
    typeIn(/Search all active Cin7 suppliers/, "nothing2");
    await waitFor(() => expect(screen.getByTestId("supplier-search-status").textContent).toMatch(/not available right now/));
  });
});

describe("the currency is derived from the supplier's Cin7 record", () => {
  it("choosing a supplier sets the currency and says where it came from; it cannot be typed over", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    expect(screen.getByTestId("derived-currency").textContent).toMatch(/Currency: EUR, from Alpine Imports's Cin7 supplier record. It is not typed./);
    expect(screen.queryByTestId("currency-override-select")).toBeNull();
    expect(screen.getByTestId("fx-shared-note").textContent).toMatch(/EUR/); // the exchange-rate block follows the derived currency
  });

  it("Cin7 holds NO currency: one clearly marked exception, a reasoned override; nothing is defaulted to rand, and saving needs both", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    fireEvent.click(screen.getByTestId("supplier-change"));
    typeIn(/Search all active Cin7 suppliers/, "zeta");
    fireEvent.click(await screen.findByTestId("supplier-hit-S8"));
    const ex = screen.getByTestId("currency-exception");
    expect(ex.textContent).toMatch(/Exception: Cin7 holds no currency for Zeta Nocur/);
    expect((screen.getByTestId("currency-override-select") as HTMLSelectElement).value).toBe(""); // no silent ZAR
    fireEvent.click(screen.getByTestId("kind-manual_estimate"));
    typeIn("Unit cost (up to 7 decimals)", "50"); typeIn("Where this cost comes from", "Estimated from NQ1161");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("save-why").textContent).toMatch(/say why you are setting it by hand/);
    fireEvent.change(within(screen.getByTestId("currency-exception")).getByLabelText("Why is the currency set by hand?"), { target: { value: "Cin7 record is empty; invoices are in USD" } });
    await waitFor(() => expect(screen.getByTestId("save-why").textContent).toMatch(/Choose the currency the supplier invoices in/));
    fireEvent.change(screen.getByTestId("currency-override-select"), { target: { value: "USD" } });
    typeIn("USD spot rate", "16.5555"); typeIn("Rate source", "rate table");
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
  });
});

describe("what Cin7 already holds is shown first, and the kinds of cost are never blurred", () => {
  it("shows the product's Cin7 supplier records and the UNDATED average cost as reference only (it is never a supplier cost, never given a date)", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([ALPINE], { averageCostUndated: "31.5" }) as never);
    mount();
    expect((await screen.findByTestId("cin7-average-cost")).textContent).toMatch(/average cost of 31.5. It has no date or supplier, so it is shown for reference only and is never used as a supplier cost/);
  });

  it("'Cin7 historical cost' takes Cin7's exact price and date, locks the figure, and the cost date is Cin7's (or 'not recorded')", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    const cost = screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement;
    expect(cost.value).toBe("26.8440995");
    expect(cost.readOnly).toBe(true);
    expect(screen.getByTestId("historical-date").textContent).toMatch(/2026-03-02/);
    expect((screen.getByLabelText("Where this cost comes from") as HTMLInputElement).value).toMatch(/Cin7 latest supplier price from Alpine Imports \(last supplied 2026-03-02\)/);
  });

  it("an undated Cin7 price says the date is not recorded; no date is invented", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S1", "Alpha Plastics", "10", "ZAR", null)]) as never);
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S1"));
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    expect(screen.getByTestId("historical-date").textContent).toMatch(/date not recorded in Cin7/);
  });

  it("'Cin7 historical cost' is not offered for a supplier Cin7 holds no price from", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([]) as never);
    mount();
    typeIn(/Search all active Cin7 suppliers/, "zeta");
    fireEvent.click(await screen.findByTestId("supplier-hit-S7"));
    expect((screen.getByTestId("kind-cin7_historical") as HTMLInputElement).disabled).toBe(true);
  });

  it("'New supplier quotation' needs its date; 'Manually estimated cost' is labelled an estimate; an age-adjusted estimate is shown as unavailable (no policy), never calculated", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    fireEvent.click(screen.getByTestId("kind-supplier_quotation"));
    typeIn("Unit cost (up to 7 decimals)", "27"); typeIn("Where this cost comes from", "Quote Q-9");
    typeIn("EUR spot rate", "18.4195"); typeIn("Rate source", "bank");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("save-why").textContent).toMatch(/date of the supplier quotation/);
    typeIn("Quotation date", "2999-01-01");
    expect(screen.getByTestId("save-why").textContent).toMatch(/cannot be in the future/);
    typeIn("Quotation date", "2026-11-10");
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
    fireEvent.click(screen.getByTestId("kind-manual_estimate"));
    expect(screen.getByTestId("estimate-note").textContent).toMatch(/your estimate, not a supplier price/);
    expect(screen.getByTestId("kind-aged-unavailable").textContent).toMatch(/Not available. There is no approved policy for ageing an old cost/);
  });
});

describe("supplier changes, save and reload", () => {
  it("changing the supplier clears what depended on it (a Cin7 historical cost) and re-derives the currency", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    fireEvent.click(screen.getByTestId("supplier-change"));
    fireEvent.click(await screen.findByTestId("cin7-record-S1"));
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe(""); // the old supplier's price is gone
    expect(screen.getByTestId("derived-currency").textContent).toMatch(/Currency: ZAR/);
    expect((screen.getByTestId("kind-cin7_historical") as HTMLInputElement).checked).toBe(false);
  });

  it("saves the Cin7 supplier id, name, derived currency basis, kind and date through the existing save, and a reopened editor shows exactly that", async () => {
    const save = mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    fireEvent.click(screen.getByTestId("kind-supplier_quotation"));
    typeIn("Unit cost (up to 7 decimals)", "27.1234567"); typeIn("Where this cost comes from", "Quote Q-9"); typeIn("Quotation date", "2026-11-10");
    typeIn("EUR spot rate", "18.4195"); typeIn("Rate source", "bank");
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const ed = save.mock.calls[0][1] as { supplierId: string; supplierName: string; currency: string; currencySource: string; costKind: string; costDate: string; costText: string };
    expect(ed).toMatchObject({ supplierId: "S2", supplierName: "Alpine Imports", currency: "EUR", currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10", costText: "27.1234567" });
    cleanup();
    const stored = { ruleVersionId: "r", skus: { ERT053: { supplierId: "S2", supplierName: "Alpine Imports", currency: "EUR", nativeUnitCostE7: 271_234_567, source: "Quote Q-9", freight: { factorMicro: 1_000_000, source: "Quote Q-9" }, currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10" } }, fxQuotes: { EUR: { rateMicro: 18_419_500, source: "bank", asOf: "2026-11-10T08:00:00Z" } }, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null } as unknown as PricingSubmission;
    mount({ current: stored });
    expect((await screen.findByTestId("supplier-selected")).textContent).toMatch(/Alpine Imports/);
    expect(screen.getByTestId("derived-currency").textContent).toMatch(/EUR/);
    expect((screen.getByTestId("kind-supplier_quotation") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Quotation date") as HTMLInputElement).value).toBe("2026-11-10");
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("27.1234567"); // 7-decimal precision preserved
  });
});

describe("failure and permissions", () => {
  it("when Cin7 cannot be read the form says so, offers Try again, and cannot be saved (no supplier can be chosen)", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValueOnce({ ok: false, error: "Cin7 supplier data is not available right now. Nothing was changed." });
    mount();
    expect((await screen.findByTestId("cin7-context-error")).textContent).toMatch(/not available right now/);
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(within(screen.getByTestId("cin7-context-error")).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("cin7-supplier-records")).toBeTruthy();
  });

  it("a viewer who cannot edit sees the choices but cannot change anything (no supplier, kind or cost control is live)", async () => {
    mount({ canEdit: false });
    const list = await screen.findByTestId("cin7-supplier-records");
    for (const b of within(list).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Search all active Cin7 suppliers/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("stale Cin7 prices", () => {
  it("a Cin7 price last supplied a year or more ago shows its age and a prompt to confirm it; nothing is adjusted; a recent or undated price shows no warning", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S2", "Alpine Imports", "26.8440995", "EUR", "2024-02-10"), rec("S1", "Alpha Plastics", "10", "ZAR", null)]) as never);
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    expect(screen.getByTestId("cin7-record-S2").textContent).toMatch(/last supplied 2024-02-10 \(\d+ (months|years) ago\)/);
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    expect(screen.getByTestId("stale-cost-warning").textContent).toMatch(/Confirm it is still current, or enter a new supplier quotation instead. Nothing is adjusted for its age/);
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("26.8440995"); // the Cin7 figure, unchanged
    fireEvent.click(screen.getByTestId("supplier-change"));
    fireEvent.click(await screen.findByTestId("cin7-record-S1"));
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    expect(screen.queryByTestId("stale-cost-warning")).toBeNull(); // undated: no age, no warning
    expect(screen.getByTestId("cin7-record-S1").textContent).not.toMatch(/ago/);
  });
});

describe("Cin7 data that disagrees or has moved", () => {
  it("a supplier inactive in Cin7 is listed but cannot be chosen", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S3", "Old Co", "5", "ZAR", null, { active: false })]) as never);
    mount();
    const b = (await screen.findByTestId("cin7-record-S3")) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.textContent).toMatch(/inactive in Cin7: cannot be chosen/);
  });

  it("when Cin7's price record is in a different currency from the supplier's own, 'Cin7 historical cost' is unavailable with the reason (a quotation or estimate remains)", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S2", "Alpine Imports", "26.8440995", "ZAR", "2026-03-02", { productCurrency: "USD" })]) as never);
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    expect((screen.getByTestId("kind-cin7_historical") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("cost-kind").textContent).toMatch(/Cin7 prices this product from Alpine Imports in USD, but the supplier's own currency is ZAR/);
    expect((screen.getByTestId("kind-supplier_quotation") as HTMLInputElement).disabled).toBe(false);
  });

  it("the supplier has no Cin7 currency but its price record states one: the exception form pre-selects that currency for a historical cost (the reason is still required)", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S5", "Gamma Supplies", "5", null, "2026-03-02", { productCurrency: "USD" })]) as never);
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S5"));
    expect(screen.getByTestId("currency-exception")).toBeTruthy();
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    expect((screen.getByTestId("currency-override-select") as HTMLSelectElement).value).toBe("USD");
    expect(screen.getByTestId("save-why").textContent).toMatch(/say why you are setting it by hand/);
  });

  it("a saved Cin7 historical cost whose Cin7 price has since moved offers 'Use Cin7's current price'", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("cin7-record-S2"));
    fireEvent.click(screen.getByTestId("kind-cin7_historical"));
    expect(screen.queryByTestId("historical-refresh")).toBeNull();
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S2", "Alpine Imports", "28.5", "EUR", "2026-10-01")]) as never);
    cleanup();
    const stored = { ruleVersionId: "r", skus: { ERT053: { supplierId: "S2", supplierName: "Alpine Imports", currency: "EUR", nativeUnitCostE7: 268_440_995, source: "Cin7", freight: { factorMicro: 1_000_000, source: "Cin7" }, currencySource: "cin7_supplier", costKind: "cin7_historical", costDate: "2026-03-02" } }, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null } as unknown as PricingSubmission;
    mount({ current: stored });
    const note = await screen.findByTestId("historical-refresh");
    expect(note.textContent).toMatch(/Cin7 now holds 28.5/);
    fireEvent.click(within(note).getByRole("button", { name: "Use Cin7's current price" }));
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("28.5");
    expect(screen.getByTestId("historical-date").textContent).toMatch(/2026-10-01/);
  });

  it("a read-only viewer cannot change the displayed cost through 'Use Cin7's current price' (the control is disabled and does nothing)", async () => {
    vi.mocked(supplier.getSkuCostContextAction).mockResolvedValue(ctx([rec("S2", "Alpine Imports", "28.5", "EUR", "2026-10-01")]) as never);
    const stored = { ruleVersionId: "r", skus: { ERT053: { supplierId: "S2", supplierName: "Alpine Imports", currency: "EUR", nativeUnitCostE7: 268_440_995, source: "Cin7", freight: { factorMicro: 1_000_000, source: "Cin7" }, currencySource: "cin7_supplier", costKind: "cin7_historical", costDate: "2026-03-02" } }, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null } as unknown as PricingSubmission;
    mount({ current: stored, canEdit: false });
    const note = await screen.findByTestId("historical-refresh");
    const btn = within(note).getByRole("button", { name: "Use Cin7's current price" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect((screen.getByLabelText("Unit cost (up to 7 decimals)") as HTMLInputElement).value).toBe("26.8440995"); // unchanged
    expect(screen.getByTestId("historical-date").textContent).toMatch(/2026-03-02/);
  });
});

