// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { equivalentInputs, evalOf, withPricing } from "@/newquip/pricing/estimator/__tests__/helpers";
import { buildPricingWorkspace, submissionFrom, type EstimatorPricing } from "@/newquip/pricing/estimator";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import * as actions from "../pricing-actions";

// Estimator reliability: (2) unsaved typed input is NEVER discarded by the panel's own verify / attest / evidence actions and is unmistakably marked; (3) a failed read cannot leave the panel busy
// forever; stale-save conflicts keep the typed values. Server actions mocked; the view-model is built by the REAL pure builder.
vi.mock("../pricing-actions", () => ({ getEstimatorPricingAction: vi.fn(), applyEstimatorPricingAction: vi.fn(), disableEstimatorPricingAction: vi.fn(), verifyEstimatorCostsAction: vi.fn(), attestEstimatorRatesAction: vi.fn(), recordManualPriceEvidenceAction: vi.fn() }));
import { EstimatorPricingPanel } from "../[id]/EstimatorPricingPanel";

const FC = { rateMicro: 19_000_000, coverDays: 90, reference: "FEC-FIX", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day contract", by: "est@x", at: "2026-11-12T08:00:00.000Z" };
function bundle(p: EstimatorPricing, over: Partial<WorkspaceBundle> = {}): WorkspaceBundle {
  const pricing = { ...p, skus: { ...p.skus } };
  const view = buildPricingWorkspace({ quoteType: "project", pricing, budget: evalOf(withPricing(pricing)).budget, originalTotalCents: 860_954_240, originalCapturedAt: "2026-11-12T08:00:00.000Z", nowIso: "2026-11-12T09:00:00.000Z" });
  return { view, verification: { canReview: false, reviewerRoles: ["manager"], verifiableSkus: [] }, rateAttestation: { canReview: false, reviewerRoles: ["manager"], attestableCurrencies: [] }, current: submissionFrom(pricing), revisions: [], state: "ESTIMATOR_REVIEW", revision: 1, canEdit: true, ...over };
}
const reviewer = (b: WorkspaceBundle): WorkspaceBundle => ({ ...b, verification: { canReview: true, reviewerRoles: ["manager"], verifiableSkus: ["ERT053"] }, rateAttestation: { canReview: true, reviewerRoles: ["manager"], attestableCurrencies: ["EUR"] } });
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

const get = vi.mocked(actions.getEstimatorPricingAction);
const field = (label: string) => screen.getAllByLabelText(new RegExp(label))[0] as HTMLInputElement;
const typeIn = (label: string, value: string) => { const el = field(label); fireEvent.change(el, { target: { value } }); fireEvent.blur(el, { target: { value } }); };
const mount = async (b: WorkspaceBundle, props: { reload?: () => void; refreshKey?: string } = {}) => {
  get.mockResolvedValue({ ok: true, data: b });
  const r = render(createElement(EstimatorPricingPanel, { quoteId: "q1", ...props }));
  await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
  return r;
};
const row = (sku: string) => screen.getAllByTestId("pricing-row").find((r) => r.getAttribute("data-sku") === sku)!;
const stored = () => equivalentInputs({ forwardCover: { EUR: FC } }, "unverified");

describe("unsaved values are unmistakable and derived from the diff", { timeout: 60000 }, () => {
  it("an edit marks the field, the row and the panel (text + attribute, not colour alone); Discard restores the stored value", async () => {
    await mount(bundle(stored()));
    expect(screen.queryByTestId("unsaved-banner")).toBeNull();
    const before = field("PNQ082 supplier cost").value;
    typeIn("PNQ082 supplier cost", "61.5");
    const banner = screen.getByTestId("unsaved-banner");
    expect(within(banner).getByTestId("unsaved-count").textContent).toBe("1 unsaved change");
    expect(within(banner).getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(within(banner).getByRole("button", { name: "Discard changes" })).toBeTruthy();
    expect(within(row("PNQ082")).getByTestId("row-unsaved").textContent).toBe("Unsaved");
    expect(row("PNQ082").getAttribute("data-unsaved")).toBe("true");
    expect(field("PNQ082 supplier cost").getAttribute("data-unsaved")).toBe("true");
    expect(within(row("PNQ082")).getByText("Unsaved", { selector: "p" })).toBeTruthy(); // the field's own helper text
    expect(row("ERT053").getAttribute("data-unsaved")).toBeNull();
    fireEvent.click(screen.getByTestId("unsaved-discard"));
    await waitFor(() => expect(screen.queryByTestId("unsaved-banner")).toBeNull());
    expect(field("PNQ082 supplier cost").value).toBe(before);
    expect(row("PNQ082").getAttribute("data-unsaved")).toBeNull();
  });
  it("a no-op blur (nothing typed, or the same value typed back) is NOT an edit; reverting a changed value clears the mark", async () => {
    await mount(bundle(stored()));
    for (const l of ["PNQ082 supplier$", "PNQ082 currency", "PNQ082 freight factor", "PNQ082 cost source", "PNQ082 supplier cost"]) fireEvent.blur(field(l));
    fireEvent.blur(field("ERT053 supplier$")); fireEvent.blur(field("ERT053 supplier cost")); // another row, also untouched
    fireEvent.blur(screen.getByLabelText("Project markup percent")); fireEvent.blur(screen.getByLabelText("Target project price")); fireEvent.blur(screen.getByLabelText("EUR spot rate"));
    expect(screen.queryByTestId("unsaved-banner")).toBeNull();
    const orig = field("PNQ082 supplier cost").value;
    typeIn("PNQ082 supplier cost", "99");
    expect(screen.getByTestId("unsaved-banner")).toBeTruthy();
    typeIn("PNQ082 supplier cost", orig);
    await waitFor(() => expect(screen.queryByTestId("unsaved-banner")).toBeNull());
  });
  it("leaving the page asks for confirmation only while something is unsaved", async () => {
    await mount(bundle(stored()));
    const ev = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(ev()).toBe(false);
    typeIn("PNQ082 supplier cost", "61.5");
    expect(ev()).toBe(true);
  });
  it("the banner's Save asks for the reason first, then saves; the stored values replace the draft only after a successful save", async () => {
    await mount(bundle(stored()));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.click(screen.getByTestId("unsaved-save"));
    expect(screen.getByTestId("pricing-errors").textContent).toMatch(/Say why/);
    expect(actions.applyEstimatorPricingAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Supplier re-quoted" } });
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: true, data: { seq: 2, kind: "CHANGED", changedValues: 1, confirmation: null } });
    get.mockResolvedValue({ ok: true, data: bundle({ ...stored(), skus: { ...stored().skus, PNQ082: { ...stored().skus.PNQ082!, nativeUnitCostE7: 615_000_000 } } }) });
    fireEvent.click(screen.getByTestId("unsaved-save"));
    await waitFor(() => expect(actions.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("unsaved-banner")).toBeNull());
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
  });
  it("Switch off is refused while typed values are unsaved (it would replace the draft)", async () => {
    await mount(bundle(stored()));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Switching off" } });
    expect((screen.getByTestId("pricing-off") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("off-blocked").textContent).toBe("Save or discard your 1 unsaved change first.");
    expect(actions.disableEstimatorPricingAction).not.toHaveBeenCalled();
  });
});

describe("verify / attest / evidence NEVER discard unsaved typed input", { timeout: 60000 }, () => {
  const verifiedNext = () => bundle(equivalentInputs({ forwardCover: { EUR: FC } }, "verified"));
  const typedStillThere = async () => {
    await waitFor(() => expect(screen.getByTestId("pricing-note")).toBeTruthy());
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    expect(screen.getByTestId("unsaved-count").textContent).toBe("1 unsaved change");
    expect(row("PNQ082").getAttribute("data-unsaved")).toBe("true");
    expect(actions.applyEstimatorPricingAction).not.toHaveBeenCalled();
  };
  it("verify: the draft is kept, the verification view refreshes, a note says the typed change is not verified", async () => {
    const reload = vi.fn();
    await mount(reviewer(bundle(stored())), { reload });
    typeIn("PNQ082 supplier cost", "61.5");
    expect(screen.getByTestId("verify-unsaved-note").textContent).toMatch(/1 unsaved change is kept and is not verified/);
    fireEvent.click(screen.getByLabelText("Verify ERT053 cost"));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "SQ-1" } });
    vi.mocked(actions.verifyEstimatorCostsAction).mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    get.mockResolvedValue({ ok: true, data: reviewer(verifiedNext()) });
    fireEvent.click(screen.getByTestId("verify-save"));
    await typedStillThere();
    expect(screen.getByTestId("sum-verified").textContent).toMatch(/^(\d+) of \1$/); // the re-read DID refresh the view
    expect(reload).toHaveBeenCalled();
  });
  it("attest: the draft is kept", async () => {
    await mount(reviewer(bundle(stored())));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.click(screen.getByLabelText("Attest EUR forward-cover rate"));
    fireEvent.change(screen.getByLabelText(/Evidence checked \(for example the forward-exchange contract number\)/), { target: { value: "FEC-FIX confirmation" } });
    vi.mocked(actions.attestEstimatorRatesAction).mockResolvedValue({ ok: true, data: { seq: 2, attested: 1 } });
    fireEvent.click(screen.getByTestId("attest-save"));
    await typedStillThere();
  });
  it("record evidence: the draft is kept", async () => {
    await mount(bundle(equivalentInputs({}, "unverified")));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.change(screen.getByLabelText(/FORTIS.* evidence note/), { target: { value: "Basis: installer quote Q-7" } });
    vi.mocked(actions.recordManualPriceEvidenceAction).mockResolvedValue({ ok: true, data: { seq: 2, recorded: 1 } });
    fireEvent.click(screen.getByTestId("evidence-save"));
    await typedStillThere();
  });
  it("a REFUSED action also keeps everything typed", async () => {
    await mount(reviewer(bundle(stored())));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.click(screen.getByLabelText("Verify ERT053 cost"));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "SQ-1" } });
    vi.mocked(actions.verifyEstimatorCostsAction).mockResolvedValue({ ok: false, error: "You entered that cost yourself.", errors: ["You entered that cost yourself."] });
    fireEvent.click(screen.getByTestId("verify-save"));
    await waitFor(() => expect(screen.getByTestId("pricing-errors").textContent).toMatch(/entered that cost yourself/));
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    expect(screen.getByTestId("unsaved-count").textContent).toBe("1 unsaved change");
  });
});

describe("a failed read or action never leaves the panel busy, and never destroys the draft", { timeout: 60000 }, () => {
  async function verifyWith(readAfter: () => Promise<never> | Promise<{ ok: false; error: string }>) {
    const reload = vi.fn();
    await mount(reviewer(bundle(stored())), { reload });
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.click(screen.getByLabelText("Verify ERT053 cost"));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "SQ-1" } });
    vi.mocked(actions.verifyEstimatorCostsAction).mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    get.mockImplementationOnce(readAfter);
    fireEvent.click(screen.getByTestId("verify-save"));
    return reload;
  }
  it("a REJECTED post-action read: busy clears, a visible error offers Try again, the draft is kept, the page reload still runs, and Try again recovers", async () => {
    const reload = await verifyWith(() => Promise.reject(new Error("network down")));
    await waitFor(() => expect(screen.getByTestId("pricing-read-error").textContent).toMatch(/could not be read.*Nothing you typed was lost/));
    expect(reload).toHaveBeenCalled();
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    expect(screen.getByTestId("unsaved-count").textContent).toBe("1 unsaved change");
    expect(screen.getByTestId("pricing-table")).toBeTruthy(); // the panel did not disappear
    // busy is clear: the controls are usable again (evidence still there, selection cleared by the success)
    expect((screen.getByTestId("verify-all") as HTMLButtonElement).disabled).toBe(false);
    expect(field("PNQ082 supplier cost").disabled).toBe(false);
    get.mockResolvedValue({ ok: true, data: reviewer(bundle(equivalentInputs({ forwardCover: { EUR: FC } }, "verified"))) });
    fireEvent.click(screen.getByTestId("pricing-read-retry"));
    await waitFor(() => expect(screen.queryByTestId("pricing-read-error")).toBeNull());
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
  });
  it("a read that RETURNS an error behaves the same way", async () => {
    await verifyWith(() => Promise.resolve({ ok: false as const, error: "Supplier pricing could not be loaded." }));
    await waitFor(() => expect(screen.getByTestId("pricing-read-error").textContent).toBe("Supplier pricing could not be loaded."));
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    expect((screen.getByTestId("verify-all") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a REJECTED action: busy clears, a message is shown, the draft is kept", async () => {
    await mount(reviewer(bundle(stored())));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.click(screen.getByLabelText("Verify ERT053 cost"));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "SQ-1" } });
    vi.mocked(actions.verifyEstimatorCostsAction).mockRejectedValue(new Error("Failed to fetch"));
    fireEvent.click(screen.getByTestId("verify-save"));
    await waitFor(() => expect(screen.getByTestId("pricing-errors").textContent).toMatch(/did not complete.*Nothing you typed was lost/));
    expect((screen.getByTestId("verify-all") as HTMLButtonElement).disabled).toBe(false);
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
  });
  it("a rejected FIRST read shows the full error with Try again, and Try again loads the panel", async () => {
    get.mockRejectedValueOnce(new Error("offline"));
    render(createElement(EstimatorPricingPanel, { quoteId: "q1" }));
    await waitFor(() => expect(screen.getByTestId("pricing-error").textContent).toMatch(/could not be read/));
    get.mockResolvedValue({ ok: true, data: bundle(stored()) });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
  });
});

describe("another estimator changed the stored pricing: rebase, conflicts, and a refused stale save", { timeout: 60000 }, () => {
  const changedStored = (mut: (p: EstimatorPricing) => void) => { const p = structuredClone(stored()); mut(p); return bundle(p); };
  it("units the user did NOT touch take the current stored value; a unit they edited and someone else changed is a conflict that stays until resolved; reverting clears it", async () => {
    const r = await mount(bundle(stored()), { refreshKey: "h1" });
    typeIn("PNQ082 supplier cost", "61.5");
    const storedPnq = field("PNQ082 supplier cost").value; void storedPnq;
    get.mockResolvedValue({ ok: true, data: changedStored((p) => { p.skus.ERT053!.supplierName = "Elsewhere Ltd"; p.skus.PNQ082!.nativeUnitCostE7 = 777_000_000; }) });
    r.rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h2" }));
    await waitFor(() => expect(screen.getByTestId("changed-elsewhere")).toBeTruthy());
    expect(field("ERT053 supplier$").value).toBe("Elsewhere Ltd"); // untouched: took the new stored value (never reverted)
    expect(row("ERT053").getAttribute("data-unsaved")).toBeNull();
    expect(field("PNQ082 supplier cost").value).toBe("61.5"); // edited: the typed value is kept
    expect(screen.getByTestId("changed-elsewhere").textContent).toMatch(/SKU PNQ082 cost/);
    expect(screen.getAllByTestId("conflict-item")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Try saving" } });
    expect((screen.getByTestId("pricing-save") as HTMLButtonElement).disabled).toBe(true); // a save is refused until resolved
    // the marker survives a further unrelated re-read
    r.rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h3" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("changed-elsewhere")).toBeTruthy();
    // reverting to the stored value clears it
    typeIn("PNQ082 supplier cost", "77.7");
    await waitFor(() => expect(screen.queryByTestId("changed-elsewhere")).toBeNull());
  });
  it("'Keep my value' resolves the conflict (a deliberate overwrite, base = stored); 'Use the stored value' replaces mine", async () => {
    const r = await mount(bundle(stored()), { refreshKey: "h1" });
    typeIn("PNQ082 supplier cost", "61.5");
    get.mockResolvedValue({ ok: true, data: changedStored((p) => { p.skus.PNQ082!.nativeUnitCostE7 = 777_000_000; }) });
    r.rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h2" }));
    await screen.findByTestId("changed-elsewhere");
    fireEvent.click(screen.getByTestId("conflict-keep"));
    await waitFor(() => expect(screen.queryByTestId("changed-elsewhere")).toBeNull());
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    expect(screen.getByTestId("unsaved-banner")).toBeTruthy();
    // the save now carries the NEW base (stored 77), so the server accepts a deliberate overwrite
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Keep mine" } });
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: true, data: { seq: 3, kind: "CHANGED", changedValues: 1, confirmation: null } });
    fireEvent.click(screen.getByTestId("pricing-save"));
    await waitFor(() => expect(actions.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    const [, sent, , base] = vi.mocked(actions.applyEstimatorPricingAction).mock.calls[0];
    expect(sent.skus.PNQ082.nativeUnitCostE7).toBe(615_000_000);
    expect(base!.skus.PNQ082.nativeUnitCostE7).toBe(777_000_000);
  });
  it("'Reload stored values' needs a confirmation; the typed values are kept until it is given", async () => {
    const r = await mount(bundle(stored()), { refreshKey: "h1" });
    typeIn("PNQ082 supplier cost", "61.5");
    get.mockResolvedValue({ ok: true, data: changedStored((p) => { p.skus.PNQ082!.nativeUnitCostE7 = 777_000_000; }) });
    r.rerender(createElement(EstimatorPricingPanel, { quoteId: "q1", refreshKey: "h2" }));
    await screen.findByTestId("changed-elsewhere");
    fireEvent.click(screen.getByTestId("reload-stored"));
    expect(screen.getByTestId("reload-confirm").textContent).toMatch(/replaces your 1 unsaved change/);
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByTestId("reload-confirm")).toBeNull();
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    fireEvent.click(screen.getByTestId("reload-stored")); fireEvent.click(screen.getByTestId("reload-confirm-yes"));
    await waitFor(() => expect(screen.queryByTestId("unsaved-banner")).toBeNull());
    expect(field("PNQ082 supplier cost").value).toBe("77.7");
  });
  it("the save sends the base the edits were made against (per submission)", async () => {
    const b = bundle(stored());
    await mount(b);
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Supplier re-quoted" } });
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: true, data: { seq: 2, kind: "CHANGED", changedValues: 1, confirmation: null } });
    fireEvent.click(screen.getByTestId("pricing-save"));
    await waitFor(() => expect(actions.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    const [, sent, , base] = vi.mocked(actions.applyEstimatorPricingAction).mock.calls[0];
    expect(base).toEqual(b.current);
    expect(sent.skus.PNQ082.nativeUnitCostE7).toBe(615_000_000);
  });
  it("pricing OFF when loaded: the base sent is null", async () => {
    const off: WorkspaceBundle = { ...bundle(stored()), current: null };
    await mount(off);
    typeIn("PNQ082 supplier cost", "6.5454755");
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Enable" } });
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: true, data: { seq: 1, kind: "ENABLED", changedValues: 1, confirmation: null } });
    fireEvent.click(screen.getByTestId("pricing-save"));
    await waitFor(() => expect(actions.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(actions.applyEstimatorPricingAction).mock.calls[0][3]).toBeNull();
    expect(vi.mocked(actions.applyEstimatorPricingAction).mock.calls[0][1].skus.PNQ082.nativeUnitCostE7).toBe(65_454_755);
  });
  it("a save the SERVER refuses as stale shows its message, keeps every typed value, re-reads and lists the conflict", async () => {
    await mount(bundle(stored()));
    typeIn("PNQ082 supplier cost", "61.5");
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Supplier re-quoted" } });
    const msg = "Nothing was saved: SKU PNQ082 cost was changed by b@nq at 2026-11-15T09:00:00.000Z. Reload to review; your typed values are kept until you choose.";
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: false, error: msg, errors: [msg], conflicts: [{ key: "sku:PNQ082:nativeUnitCostE7", label: "SKU PNQ082 cost", by: "b@nq", at: "2026-11-15T09:00:00.000Z" }] });
    get.mockResolvedValue({ ok: true, data: changedStored((p) => { p.skus.PNQ082!.nativeUnitCostE7 = 777_000_000; }) });
    fireEvent.click(screen.getByTestId("pricing-save"));
    await waitFor(() => expect(screen.getByTestId("pricing-errors").textContent).toBe(msg));
    await waitFor(() => expect(screen.getByTestId("changed-elsewhere")).toBeTruthy());
    expect(field("PNQ082 supplier cost").value).toBe("61.5");
    expect((screen.getByTestId("pricing-save") as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByTestId("changed-elsewhere")).getAllByRole("button").length).toBeGreaterThan(1);
    await act(async () => {});
  });
});
