// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { equivalentInputs, evalOf, withPricing } from "@/newquip/pricing/estimator/__tests__/helpers";
import { buildPricingWorkspace, submissionFrom, type EstimatorPricing } from "@/newquip/pricing/estimator";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import * as actions from "../pricing-actions";

// Cost & Verify workstream: the supplier-pricing workspace stays current without a reload (verification counts, SKU rows after a saved mapping change) and shows the provider's FX timestamp and the
// recorded time as two different facts. Server actions mocked; the view-model is built by the REAL pure builder.
vi.mock("../pricing-actions", () => ({ getEstimatorPricingAction: vi.fn(), applyEstimatorPricingAction: vi.fn(), disableEstimatorPricingAction: vi.fn(), verifyEstimatorCostsAction: vi.fn(), attestEstimatorRatesAction: vi.fn(), recordManualPriceEvidenceAction: vi.fn() }));
import { EstimatorPricingPanel } from "../[id]/EstimatorPricingPanel";

// The quotation now carries three more SKUs (the confirmed LED parts), so each rendered workspace has more rows: these full-workspace tests take ~3-4s on a fast machine and exceeded the 5s default on the CI runners.
vi.setConfig({ testTimeout: 20_000 });

function bundle(p: EstimatorPricing, over: Partial<WorkspaceBundle> = {}, skipSku?: string): WorkspaceBundle {
  const pricing = { ...p, skus: { ...p.skus } };
  if (skipSku) delete pricing.skus[skipSku];
  const view = buildPricingWorkspace({ quoteType: "project", pricing, budget: evalOf(withPricing(pricing)).budget, originalTotalCents: 860_954_240, originalCapturedAt: "2026-11-12T08:00:00.000Z", nowIso: "2026-11-12T09:00:00.000Z" });
  return { view, verification: { canReview: false, reviewerRoles: ["manager"], verifiableSkus: [] }, rateAttestation: { canReview: false, reviewerRoles: ["manager"], attestableCurrencies: [] }, current: submissionFrom(pricing), revisions: [], state: "ESTIMATOR_REVIEW", revision: 1, canEdit: true, ...over };
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe("verification counts and cost status update immediately (no reload)", () => {
  it("after a verification the tile, every row's cost state and the next read all follow the re-read bundle", async () => {
    const sku = "PNQ082";
    const before = bundle(equivalentInputs({}, "unverified"));
    const after = bundle(equivalentInputs({}, "verified"));
    vi.mocked(actions.getEstimatorPricingAction).mockResolvedValueOnce({ ok: true, data: { ...before, verification: { canReview: true, reviewerRoles: ["manager"], verifiableSkus: [sku] } } }).mockResolvedValue({ ok: true, data: after });
    vi.mocked(actions.verifyEstimatorCostsAction).mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    const reload = vi.fn();
    render(createElement(EstimatorPricingPanel, { quoteId: "q1", reload }));
    await waitFor(() => expect(screen.getByTestId("verify-block")).toBeTruthy());
    expect(screen.getByTestId("sum-verified").textContent).toMatch(/^0 of \d+$/);
    fireEvent.click(screen.getByLabelText(`Verify ${sku} cost`));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "Supplier quote SQ-77" } });
    fireEvent.click(screen.getByTestId("verify-save"));
    await waitFor(() => expect(screen.getByTestId("sum-verified").textContent).toBe(`${after.view.costs.required} of ${after.view.costs.required}`));
    expect(screen.getAllByTestId("cost-state").every((s) => s.getAttribute("data-cost-state") === "verified")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("a slower, OLDER read can never overwrite a newer one", async () => {
    const stale = bundle(equivalentInputs({}, "unverified"));
    const fresh = bundle(equivalentInputs({}, "verified"));
    let releaseStale: (v: { ok: true; data: WorkspaceBundle }) => void = () => {};
    vi.mocked(actions.getEstimatorPricingAction)
      .mockImplementationOnce(() => new Promise((res) => { releaseStale = res as typeof releaseStale; }))
      .mockResolvedValue({ ok: true, data: fresh });
    const { rerender } = render(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "a" }));
    rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "b" })); // a second read starts and finishes first
    await waitFor(() => expect(screen.getByTestId("sum-verified").textContent).toBe(`${fresh.view.costs.required} of ${fresh.view.costs.required}`));
    releaseStale({ ok: true, data: stale }); // the old one arrives late
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("sum-verified").textContent).toBe(`${fresh.view.costs.required} of ${fresh.view.costs.required}`);
  });
});

describe("SKU rows refresh after the saved quotation changes elsewhere (e.g. a confirmed mapping)", () => {
  it("a changed refreshKey re-reads the workspace; the same key does not", async () => {
    const p = equivalentInputs({}, "verified");
    const without = bundle(p, {}, "ERT053");
    const withIt = bundle(p);
    vi.mocked(actions.getEstimatorPricingAction).mockResolvedValueOnce({ ok: true, data: without }).mockResolvedValue({ ok: true, data: withIt });
    const { rerender } = render(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h1" }));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    const rowsBefore = screen.getAllByTestId("pricing-row").length;
    expect(screen.getAllByTestId("pricing-row").find((r) => r.getAttribute("data-sku") === "ERT053")?.getAttribute("data-status")).toBe("no_input");
    rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h1" }));
    expect(actions.getEstimatorPricingAction).toHaveBeenCalledTimes(1); // nothing changed: no extra read
    rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h2" })); // the mapping was saved: new draft hash
    await waitFor(() => expect(actions.getEstimatorPricingAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByTestId("pricing-row").find((r) => r.getAttribute("data-sku") === "ERT053")?.getAttribute("data-status")).toBe("priced"));
    expect(screen.getAllByTestId("pricing-row").length).toBeGreaterThanOrEqual(rowsBefore);
  });
});

describe("a refresh caused by the page never clobbers what the user is typing", () => {
  it("typed-but-unsaved input survives a refreshKey change; the view still refreshes; a SKU changed elsewhere is flagged", async () => {
    const p = equivalentInputs({}, "verified");
    const changed = { ...p, skus: { ...p.skus, PNQ082: { ...p.skus.PNQ082!, supplierName: "Changed Elsewhere Ltd" } } };
    vi.mocked(actions.getEstimatorPricingAction).mockResolvedValueOnce({ ok: true, data: bundle(p) }).mockResolvedValue({ ok: true, data: bundle(changed) });
    const { rerender } = render(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h1" }));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    const input = screen.getByLabelText("PNQ082 supplier") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My Typed Supplier" } }); fireEvent.blur(input, { target: { value: "My Typed Supplier" } });
    rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h2" }));
    await waitFor(() => expect(actions.getEstimatorPricingAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("changed-elsewhere").textContent).toMatch(/PNQ082/));
    expect((screen.getByLabelText("PNQ082 supplier") as HTMLInputElement).value).toBe("My Typed Supplier");
  });
  it("buttons stay disabled until the post-action re-read finishes", async () => {
    const before = bundle(equivalentInputs({}, "unverified"));
    let release: (v: { ok: true; data: WorkspaceBundle }) => void = () => {};
    vi.mocked(actions.getEstimatorPricingAction).mockResolvedValueOnce({ ok: true, data: { ...before, verification: { canReview: true, reviewerRoles: ["manager"], verifiableSkus: ["PNQ082"] } } })
      .mockImplementationOnce(() => new Promise((res) => { release = res as typeof release; }));
    vi.mocked(actions.verifyEstimatorCostsAction).mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    render(createElement(EstimatorPricingPanel, { quoteId: "q1" }));
    await waitFor(() => expect(screen.getByTestId("verify-block")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Verify PNQ082 cost"));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "SQ-1" } });
    fireEvent.click(screen.getByTestId("verify-save"));
    await waitFor(() => expect(actions.getEstimatorPricingAction).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId("verify-all") as HTMLButtonElement).disabled).toBe(true); // still refreshing
    release({ ok: true, data: bundle(equivalentInputs({}, "verified")) });
    await waitFor(() => expect(screen.getByTestId("sum-verified").textContent).toMatch(/^(\d+) of \1$/));
  });
});

describe("FX: provider timestamp and recorded time are distinct", () => {
  const withSource = (source: string, asOf = "2026-11-14T19:05:00.000Z") => equivalentInputs({ fxQuotes: { EUR: { rateMicro: 20_000_000, source, asOf }, USD: { rateMicro: 20_000_000, source: "Fixture spot", asOf } } }, "verified");
  const mount = (p: EstimatorPricing) => { vi.mocked(actions.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: bundle(p) }); render(createElement(EstimatorPricingPanel, { quoteId: "q1" })); };
  it("shows 'Provider timestamp' (from the source text) and 'Recorded' (save time) as two different values", async () => {
    mount(withSource("ECB reference rate; provider timestamp 2026-11-14T19:00:06Z; retrieved 2026-11-14T19:05:00Z"));
    await waitFor(() => expect(screen.getByTestId("fx-times-EUR")).toBeTruthy());
    const pt = screen.getByTestId("fx-provider-ts-EUR").textContent!; const rec = screen.getByTestId("fx-recorded-ts-EUR").textContent!;
    expect(pt).toMatch(/^Provider timestamp: 14 Nov 2026, 21:00 SAST$/);
    expect(rec).toMatch(/^Recorded: 14 Nov 2026, 21:05 SAST$/);
    expect(pt.replace("Provider timestamp: ", "")).not.toBe(rec.replace("Recorded: ", ""));
  });
  it("never fails when the source carries no provider timestamp: says so and still shows Recorded", async () => {
    mount(withSource("Fixture spot"));
    await waitFor(() => expect(screen.getByTestId("fx-times-EUR")).toBeTruthy());
    expect(screen.getByTestId("fx-provider-ts-EUR").textContent).toMatch(/Provider timestamp: not stated in the rate source/);
    expect(screen.getByTestId("fx-recorded-ts-EUR").textContent).toMatch(/Recorded: 14 Nov 2026/);
  });
  it("a malformed provider timestamp is ignored, not rendered or thrown", async () => {
    mount(withSource("provider timestamp 2026-99-99T99:99:99Z"));
    await waitFor(() => expect(screen.getByTestId("fx-times-EUR")).toBeTruthy());
    expect(screen.getByTestId("fx-provider-ts-EUR").textContent).toMatch(/not stated/);
  });
});
