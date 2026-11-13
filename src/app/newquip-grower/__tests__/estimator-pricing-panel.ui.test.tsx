// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { equivalentInputs, evalOf, withPricing } from "@/newquip/pricing/estimator/__tests__/helpers";
import { buildPricingWorkspace, manualEvidenceRows, submissionFrom, type EstimatorPricing } from "@/newquip/pricing/estimator";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import * as actions from "../pricing-actions";
import { ManualEvidencePanel } from "../[id]/ManualEvidencePanel";

// NQ-008B Phase 2 (P2-C): the Estimator pricing workspace as rendered. The server actions are mocked; the view-model is built by the REAL pure builder from a real
// evaluation, so what is rendered is what the server would send.
vi.mock("../pricing-actions", () => ({ getEstimatorPricingAction: vi.fn(), applyEstimatorPricingAction: vi.fn(), disableEstimatorPricingAction: vi.fn(), verifyEstimatorCostsAction: vi.fn(), attestEstimatorRatesAction: vi.fn(), recordManualPriceEvidenceAction: vi.fn() }));
import { EstimatorPricingPanel } from "../[id]/EstimatorPricingPanel";

function bundle(p: EstimatorPricing | undefined, over: Partial<WorkspaceBundle> = {}, skipSku?: string): WorkspaceBundle {
  const pricing = p ? { ...p, skus: { ...p.skus } } : undefined;
  if (pricing && skipSku) delete pricing.skus[skipSku];
  const d = pricing ? withPricing(pricing) : readyDraft();
  const view = buildPricingWorkspace({ quoteType: "project", pricing, budget: evalOf(d).budget, originalTotalCents: 860_954_240, originalCapturedAt: "2026-11-12T08:00:00.000Z", nowIso: "2026-11-12T09:00:00.000Z" });
  return { view, verification: { canReview: false, reviewerRoles: ["manager"], verifiableSkus: [] }, rateAttestation: { canReview: false, reviewerRoles: ["manager"], attestableCurrencies: [] }, current: pricing ? submissionFrom(pricing) : null, revisions: [], state: "ESTIMATOR_REVIEW", revision: 1, canEdit: true, ...over };
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());
const mount = (b: WorkspaceBundle, reload = vi.fn()) => {
  vi.mocked(actions.getEstimatorPricingAction).mockResolvedValue({ ok: true, data: b });
  render(createElement(EstimatorPricingPanel, { quoteId: "q1", reload }));
  return reload;
};

describe("the panel never disappears", () => {
  it("says it is loading, and shows the server's refusal with a retry", async () => {
    vi.mocked(actions.getEstimatorPricingAction).mockResolvedValue({ ok: false, error: "Supplier pricing is internal: only an Estimator or Manager who can see costs can open it." });
    render(createElement(EstimatorPricingPanel, { quoteId: "q1" }));
    expect(screen.getByTestId("pricing-loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("pricing-error").textContent).toMatch(/internal/));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("what the Estimator sees", () => {
  it("OFF: says the quotation keeps its POC prices and offers to switch on", async () => {
    mount(bundle(undefined));
    await waitFor(() => expect(screen.getByTestId("estimator-pricing-panel")).toBeTruthy());
    expect(screen.getByText(/Off: priced from the POC workbook/)).toBeTruthy();
    expect(screen.getByText(/nothing changes/)).toBeTruthy();
    expect(screen.getByTestId("pricing-save").textContent).toBe("Switch on supplier pricing");
  });
  it("ON: per-SKU supplier, currency, cost, source, verification, rate, freight, landed cost, price, margin and markup; original vs revised; markup and margin separate", async () => {
    mount(bundle(equivalentInputs({ forwardCover: { EUR: { rateMicro: 19_000_000, coverDays: 90, reference: "FEC-FIX", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day contract", by: "est@x", at: "2026-11-12T08:00:00.000Z" } } })));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    const rows = screen.getAllByTestId("pricing-row");
    expect(rows.length).toBeGreaterThan(10);
    const eur = rows.find((r) => within(r).queryByText(/Forward cover \(90 d\)/))!;
    expect(eur).toBeTruthy();
    expect(within(eur).getByText("Priced")).toBeTruthy();
    expect(screen.getByTestId("sum-original").textContent).toMatch(/8\s609\s542/);
    expect(screen.getByTestId("sum-margin").textContent).toMatch(/%/);
    expect(screen.getByTestId("sum-markup").textContent).toMatch(/%/);
    expect(screen.getByTestId("sum-margin").textContent).not.toBe(screen.getByTestId("sum-markup").textContent); // margin and markup are different numbers
    expect(screen.getByTestId("fx-EUR").textContent).toMatch(/Forward cover in force: 90 days, contract FEC-FIX, valid until 2026-12-31/);
  });
  it("a SKU with no supplier cost is NOT priced (never R0) and is called out; unverified costs say indicative only", async () => {
    mount(bundle(equivalentInputs({}, "unverified"), {}, "ERT053"));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    const row = screen.getAllByTestId("pricing-row").find((r) => r.getAttribute("data-sku") === "ERT053")!;
    expect(row.getAttribute("data-status")).toBe("no_input");
    expect(within(row).getByText(/No supplier cost: NOT priced/)).toBeTruthy();
    expect(within(row).getAllByText("Not priced").length).toBeGreaterThan(0);
    expect(screen.getByTestId("sum-current").textContent).toBe("Not priced yet");
    expect(screen.getByTestId("sum-complete").textContent).toMatch(/NOT priced: there is no project total yet/);
    const att = screen.getByTestId("pricing-attention").textContent!;
    expect(att).toMatch(/ERT053: no supplier cost entered/);
    expect(att).toMatch(/indicative price only/);
    expect(att).toMatch(/does not cover them/);
  });
  it("the target price is shown as what it WOULD be, and explicitly not applied", async () => {
    mount(bundle(equivalentInputs({ targetAdjustment: { targetTotalCents: 800_000_000 / 100, reason: "Round figure", by: "est@x", at: "2026-11-12T08:00:00.000Z" } })));
    await waitFor(() => expect(screen.getByTestId("adjustment-view")).toBeTruthy());
    expect(screen.getByTestId("adjustment-view").textContent).toMatch(/Would adjust the quotation by/);
    expect(screen.getByTestId("adjustment-view").textContent).toMatch(/Not applied to the customer quotation/);
  });
});

describe("saving", () => {
  it("needs a reason; saves the edited inputs as ONE submission with that reason; and tells the Estimator the Rep must reconfirm when the total moved", async () => {
    const reload = mount(bundle(equivalentInputs()));
    await waitFor(() => expect(screen.getByTestId("pricing-save")).toBeTruthy());
    const save = screen.getByTestId("pricing-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // no reason yet
    const cost = screen.getAllByLabelText(/PNQ082 supplier cost/)[0] as HTMLInputElement;
    fireEvent.change(cost, { target: { value: "60" } }); fireEvent.blur(cost, { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Supplier re-quoted" } });
    expect(save.disabled).toBe(false);
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: true, data: { seq: 2, kind: "CHANGED", changedValues: 1, confirmation: { confirmationCleared: true, signoffCleared: true, returnedToRep: true, previousCents: 1, newCents: 2 } } });
    fireEvent.click(save);
    await waitFor(() => expect(actions.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    const [qid, submission, reason] = vi.mocked(actions.applyEstimatorPricingAction).mock.calls[0];
    expect(qid).toBe("q1"); expect(reason).toBe("Supplier re-quoted");
    expect(submission.skus.PNQ082.nativeUnitCostMicro).toBe(60_000_000);
    expect(JSON.stringify(submission)).not.toMatch(/"by"|"at"/); // attribution is the server's, never the browser's
    await waitFor(() => expect(screen.getByTestId("pricing-note").textContent).toMatch(/Rep&apos;s|Rep's confirmation was withdrawn.*back with the Rep/));
    expect(reload).toHaveBeenCalled();
  });
  it("shows the server's plain validation messages and keeps the entries", async () => {
    mount(bundle(equivalentInputs()));
    await waitFor(() => expect(screen.getByTestId("pricing-save")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Try it" } });
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: false, error: "x", errors: ["The EUR exchange rate is not valid (ZAR is always 1).", "ERT053: a price override needs a reason."] });
    fireEvent.click(screen.getByTestId("pricing-save"));
    await waitFor(() => expect(screen.getByTestId("pricing-errors").textContent).toMatch(/EUR exchange rate is not valid.*needs a reason/));
    expect((screen.getByLabelText("Reason for this pricing revision") as HTMLInputElement).value).toBe("Try it");
  });
  it("is read-only when the quotation cannot be edited (approved) or unsaved edits exist", async () => {
    mount(bundle(equivalentInputs(), { canEdit: false, state: "MANAGER_APPROVED_FINAL" }));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    expect(screen.queryByTestId("pricing-save")).toBeNull();
    expect((screen.getAllByLabelText(/PNQ082 supplier cost/)[0] as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Approved: the pricing is frozen/)).toBeTruthy();
  });
  it("shows the immutable revision history with who, why and previous -> new", async () => {
    mount(bundle(equivalentInputs(), { revisions: [{ id: "r1", seq: 1, quoteRevision: 1, kind: "ENABLED", ruleVersion: "legacy-poc-v1", reason: "Initial pricing", changes: [{ path: "skus.PNQ082.nativeUnitCostMicro", previous: null, new: 50_000_000 }], changedBy: "est@nq", at: "2026-11-12T08:00:00.000Z", newPricingHash: "a".repeat(64) }] }));
    await waitFor(() => expect(screen.getByTestId("pricing-history")).toBeTruthy());
    const h = screen.getByTestId("pricing-history").textContent!;
    expect(h).toMatch(/Revision 1.*enabled.*legacy-poc-v1.*est@nq/);
    expect(h).toMatch(/Why: Initial pricing/);
    expect(h).toMatch(/skus\.PNQ082\.nativeUnitCostMicro: null → 50000000/);
  });
});

describe("only an Estimator or Manager is shown the workspace", () => {
  it("the page mounts it inside the cost-visible step and only for the Estimator / Manager role", () => {
    const src = readFileSync(path.resolve(__dirname, "../[id]/page.tsx"), "utf8");
    const at = src.indexOf("<EstimatorPricingPanel");
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 1400), at);
    expect(before).toMatch(/canCommercials && \(\s*<StepPanel/); // inside the cost-visible step
    expect(before).toMatch(/roles\.has\("estimator"\) \|\| roles\.has\("manager"\)/);
  });
});

describe("hardening: cost verification, expiry, clearing and rate fields (rendered)", () => {
  it("each supplier cost shows its own verification state, entered-by and review, and the verified count is separate from price completeness", async () => {
    mount(bundle(equivalentInputs({}, "verified")));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    const states = screen.getAllByTestId("cost-state");
    expect(states.length).toBeGreaterThan(5);
    expect(states.every((s) => s.getAttribute("data-cost-state") === "verified")).toBe(true);
    expect(states[0].textContent).toMatch(/Verified.*by reviewer@example\.test.*Supplier quote SQ-FIXTURE.*entered by estimator@example\.test/);
    expect(screen.getByTestId("sum-verified").textContent).toMatch(/^\d+ of \d+$/);
    expect(screen.getByTestId("sum-complete").textContent).toMatch(/Every line has a price/);
    cleanup();
    mount(bundle(equivalentInputs({}, "unverified")));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    expect(screen.getAllByTestId("cost-state").every((s) => s.getAttribute("data-cost-state") === "unverified")).toBe(true);
    expect(screen.getByTestId("sum-verified").textContent).toMatch(/^0 of \d+$/);
    expect(screen.getByTestId("sum-complete").textContent).toMatch(/Every line has a price/); // priced, yet not verified: two different things
    expect(screen.queryByLabelText(/^Verify .* cost$/)).toBeNull(); // an Estimator without the reviewer role sees no verify controls
    expect(screen.queryByTestId("verify-block")).toBeNull();
  });
  it("there is NO control to mark a cost verified yourself", async () => {
    mount(bundle(equivalentInputs({}, "unverified")));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    expect(screen.queryByLabelText(/verification$/i)).toBeNull();
    expect(document.querySelectorAll("select").length).toBe(0);
  });
  it("a reviewer sees the verify block, can tick only the costs they may verify, must give evidence, and the request carries the cost hash they saw", async () => {
    const p = equivalentInputs({}, "unverified");
    const b0 = bundle(p);
    const sku = "PNQ082";
    mount({ ...b0, verification: { canReview: true, reviewerRoles: ["manager"], verifiableSkus: [sku] } });
    await waitFor(() => expect(screen.getByTestId("verify-block")).toBeTruthy());
    const save = screen.getByTestId("verify-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getAllByLabelText(/^Verify .* cost$/).length).toBe(1); // only the one they may verify
    fireEvent.click(screen.getByLabelText(`Verify ${sku} cost`));
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "Supplier quote SQ-77" } });
    expect(save.disabled).toBe(false);
    vi.mocked(actions.verifyEstimatorCostsAction).mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    fireEvent.click(save);
    await waitFor(() => expect(actions.verifyEstimatorCostsAction).toHaveBeenCalledTimes(1));
    const [qid, items, evidence] = vi.mocked(actions.verifyEstimatorCostsAction).mock.calls[0];
    expect(qid).toBe("q1"); expect(evidence).toBe("Supplier quote SQ-77");
    expect(items).toEqual([{ sku, costHash: b0.view.rows.find((r) => r.sku === sku)!.costHash }]);
    await waitFor(() => expect(screen.getByTestId("pricing-note").textContent).toMatch(/1 supplier cost independently verified. No price changed/));
  });
  it("exchange-rate fields appear as soon as a SKU is given a foreign currency, before any save", async () => {
    mount(bundle(undefined));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    expect(screen.queryByTestId("pricing-fx")).toBeNull();
    const cur = screen.getAllByLabelText(/PNQ082 currency/)[0] as HTMLInputElement;
    fireEvent.change(cur, { target: { value: "EUR" } }); fireEvent.blur(cur, { target: { value: "EUR" } });
    await waitFor(() => expect(screen.getByTestId("fx-EUR")).toBeTruthy());
    expect(screen.getByLabelText("EUR spot rate")).toBeTruthy();
    expect(screen.getByTestId("pricing-fx").textContent).toMatch(/older than 24 hours is expired/);
  });
  it("an expired spot rate and an expired forward cover are called out in words", async () => {
    const b = bundle(equivalentInputs({}, "verified"));
    b.view.rates = b.view.rates.map((r) => (r.currency === "USD" ? { ...r, spotExpired: true, spotAgeHours: 30 } : { ...r, forwardExpired: true }));
    mount(b);
    await waitFor(() => expect(screen.getByTestId("fx-USD")).toBeTruthy());
    expect(screen.getByTestId("fx-note-USD").textContent).toMatch(/\(30 h ago\)\. EXPIRED: record a current rate/);
    expect(screen.getByTestId("fx-note-EUR").textContent).toMatch(/forward-cover rate has EXPIRED/);
  });
  it("Clear supplier cost removes the SKU from the submission (never a zero); a blank cost field does not become zero", async () => {
    mount(bundle(equivalentInputs({}, "verified")));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    const row = screen.getAllByTestId("pricing-row").find((r) => r.getAttribute("data-sku") === "PNQ082")!;
    const extra = row.nextElementSibling as HTMLElement;
    const cost = screen.getAllByLabelText(/PNQ082 supplier cost/)[0] as HTMLInputElement;
    fireEvent.change(cost, { target: { value: "" } }); fireEvent.blur(cost, { target: { value: "" } }); // blank is ignored, not zero
    fireEvent.click(within(extra).getByTestId("clear-cost"));
    fireEvent.change(screen.getByLabelText("Reason for this pricing revision"), { target: { value: "Cleared the feeder cost" } });
    vi.mocked(actions.applyEstimatorPricingAction).mockResolvedValue({ ok: true, data: { seq: 2, kind: "CHANGED", changedValues: 1, confirmation: null } });
    fireEvent.click(screen.getByTestId("pricing-save"));
    await waitFor(() => expect(actions.applyEstimatorPricingAction).toHaveBeenCalledTimes(1));
    const submission = vi.mocked(actions.applyEstimatorPricingAction).mock.calls[0][1];
    expect(Object.keys(submission.skus)).not.toContain("PNQ082");
    expect(Object.values(submission.skus).every((s) => s.nativeUnitCostMicro > 0)).toBe(true);
    expect(JSON.stringify(submission)).not.toMatch(/"review"|"verification"/);
  });
});

// NQ-008B P2-E: independent forward-cover rate attestation and pricing evidence for SKU-less manual items.
const FC = { rateMicro: 19_000_000, coverDays: 90, reference: "FEC-FIX", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day contract", by: "est@x", at: "2026-11-12T08:00:00.000Z" };
describe("forward-cover rate attestation", () => {
  it("shows each forward-cover rate's attestation state; an unattested rate says it is not final", async () => {
    mount(bundle(equivalentInputs({ forwardCover: { EUR: FC } })));
    await waitFor(() => expect(screen.getByTestId("rate-state-EUR")).toBeTruthy());
    expect(screen.getByTestId("rate-state-EUR").getAttribute("data-rate-state")).toBe("unattested");
    expect(screen.getByTestId("rate-state-EUR").textContent).toMatch(/Not attested.*has not been independently attested/);
    expect(screen.queryByTestId("attest-block")).toBeNull(); // this viewer is not a permitted reviewer
  });
  it("a permitted reviewer attests the rate they did not enter: the action gets the currency, the hash of the rate on screen and the evidence (never by / at)", async () => {
    const b = bundle(equivalentInputs({ forwardCover: { EUR: FC } }), { rateAttestation: { canReview: true, reviewerRoles: ["manager"], attestableCurrencies: ["EUR"] } });
    const reload = mount(b);
    await waitFor(() => expect(screen.getByTestId("attest-block")).toBeTruthy());
    const btn = screen.getByTestId("attest-save") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Attest EUR forward-cover rate"));
    expect(btn.disabled).toBe(true); // no evidence yet
    fireEvent.change(screen.getByLabelText(/Evidence checked \(for example the forward-exchange contract number\)/), { target: { value: "FEC-FIX bank confirmation" } });
    expect(btn.disabled).toBe(false);
    vi.mocked(actions.attestEstimatorRatesAction).mockResolvedValue({ ok: true, data: { seq: 2, attested: 1 } });
    fireEvent.click(btn);
    await waitFor(() => expect(actions.attestEstimatorRatesAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(actions.attestEstimatorRatesAction).mock.calls[0]).toEqual(["q1", [{ currency: "EUR", rateHash: b.view.currencies.find((c) => c.currency === "EUR")!.forwardCover!.rateHash }], "FEC-FIX bank confirmation"]);
    await waitFor(() => expect(screen.getByTestId("pricing-note").textContent).toMatch(/1 forward-cover rate independently attested.*No price changed/));
    expect(reload).toHaveBeenCalled();
  });
  it("a viewer who entered the rate holds the role but may attest none: the block says so", async () => {
    mount(bundle(equivalentInputs({ forwardCover: { EUR: FC } }), { rateAttestation: { canReview: true, reviewerRoles: ["manager"], attestableCurrencies: [] } }));
    await waitFor(() => expect(screen.getByTestId("attest-none").textContent).toMatch(/need another reviewer/));
    expect((screen.getByTestId("attest-save") as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows the refusal the server gives, and no block once the quotation is approved", async () => {
    mount(bundle(equivalentInputs({ forwardCover: { EUR: FC } }), { rateAttestation: { canReview: true, reviewerRoles: ["manager"], attestableCurrencies: ["EUR"] } }));
    await waitFor(() => expect(screen.getByTestId("attest-block")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Attest EUR forward-cover rate"));
    fireEvent.change(screen.getByLabelText(/Evidence checked \(for example the forward-exchange contract number\)/), { target: { value: "FEC-FIX" } });
    vi.mocked(actions.attestEstimatorRatesAction).mockResolvedValue({ ok: false, error: "x", errors: ["EUR: the rate changed after you opened it. Open the current rate and review that."] });
    fireEvent.click(screen.getByTestId("attest-save"));
    await waitFor(() => expect(screen.getByTestId("pricing-errors").textContent).toMatch(/EUR: the rate changed after you opened it/));
    cleanup();
    mount(bundle(equivalentInputs({ forwardCover: { EUR: FC } }), { state: "MANAGER_APPROVED_FINAL", canEdit: false, rateAttestation: { canReview: true, reviewerRoles: ["manager"], attestableCurrencies: ["EUR"] } }));
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeTruthy());
    expect(screen.queryByTestId("attest-block")).toBeNull();
  });
});

describe("pricing evidence for manual items", () => {
  it("lists each SKU-less manual item with its state; a note is needed; the action gets only the key, note and reference (never a hash, by or at)", async () => {
    const reload = mount(bundle(equivalentInputs({}, "unverified")));
    await waitFor(() => expect(screen.getByTestId("evidence-block")).toBeTruthy());
    const items = screen.getAllByTestId("evidence-item");
    expect(items.map((i) => i.getAttribute("data-item"))).toEqual(["flex_auger", "led_light", "penning_package"]);
    expect(items.every((i) => i.getAttribute("data-evidence-state") === "missing")).toBe(true);
    expect(screen.getByTestId("evidence-block").textContent).toMatch(/M75 feed distribution system.*No evidence/);
    const save = screen.getByTestId("evidence-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/FORTIS.* evidence note/), { target: { value: "short" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/FORTIS.* evidence note/), { target: { value: "Basis: installer quote Q-7" } });
    fireEvent.change(screen.getByLabelText(/FORTIS.* evidence reference/), { target: { value: "Q-7" } });
    expect(save.disabled).toBe(false);
    vi.mocked(actions.recordManualPriceEvidenceAction).mockResolvedValue({ ok: true, data: { seq: 2, recorded: 1 } });
    fireEvent.click(save);
    await waitFor(() => expect(actions.recordManualPriceEvidenceAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(actions.recordManualPriceEvidenceAction).mock.calls[0]).toEqual(["q1", [{ itemKey: "led_light", note: "Basis: installer quote Q-7", reference: "Q-7" }]]);
    await waitFor(() => expect(screen.getByTestId("pricing-note").textContent).toMatch(/pricing evidence for 1 item.*No price changed/));
    expect(reload).toHaveBeenCalled();
  });
  it("shows recorded evidence with who and when, and an outdated one as such; it is read-only when the quotation is approved", async () => {
    const p = equivalentInputs({}, "verified");
    p.manualEvidence!.led_light = { ...p.manualEvidence!.led_light!, note: "Basis: installer quote Q-7", by: "est@x" };
    p.manualEvidence!.penning_package = { ...p.manualEvidence!.penning_package!, priceHash: "0".repeat(64) }; // the price it covered is not the current one
    mount(bundle(p));
    await waitFor(() => expect(screen.getByTestId("evidence-block")).toBeTruthy());
    const led = screen.getAllByTestId("evidence-item").find((i) => i.getAttribute("data-item") === "led_light")!;
    expect(led.getAttribute("data-evidence-state")).toBe("recorded");
    expect(within(led).getByTestId("evidence-text").textContent).toMatch(/Basis: installer quote Q-7.*est@x/);
    expect(screen.getAllByTestId("evidence-item").find((i) => i.getAttribute("data-item") === "penning_package")!.textContent).toMatch(/Price changed since.*price changed after its evidence was recorded/);
    cleanup();
    mount(bundle(p, { canEdit: false, state: "MANAGER_APPROVED_FINAL" }));
    await waitFor(() => expect(screen.getByTestId("evidence-block")).toBeTruthy());
    expect(screen.queryByTestId("evidence-save")).toBeNull();
  });
  it("supplier pricing OFF: nothing needs evidence and the block is absent (legacy POC behaviour unchanged)", async () => {
    mount(bundle(undefined));
    await waitFor(() => expect(screen.getByTestId("estimator-pricing-panel")).toBeTruthy());
    expect(screen.queryByTestId("evidence-block")).toBeNull();
  });
});

describe("what the Manager sees at approval (cost-entitled viewers only)", () => {
  const rows = manualEvidenceRows(equivalentInputs({}, "verified"), evalOf(withPricing(equivalentInputs({}, "verified"))).budget);
  it("shows the evidence note, who recorded it and when, and whether it still covers the price; nothing when there is nothing to show", () => {
    render(createElement(ManualEvidencePanel, { rows }));
    const r = screen.getAllByTestId("manual-evidence-row");
    expect(r).toHaveLength(3);
    expect(screen.getByTestId("manual-evidence-summary").textContent).toMatch(/Fixture pricing basis.*recorded by estimator@example\.test/);
    cleanup();
    const { container } = render(createElement(ManualEvidencePanel, { rows: [] }));
    expect(container.textContent).toBe("");
  });
  it("is wired into the page for cost-entitled viewers only, outside POC presentation, and the server puts the rows in the view for them alone", () => {
    const page = readFileSync(path.resolve(__dirname, "../[id]/page.tsx"), "utf8");
    expect(page.match(/canCommercials && !poc && view\.manualPriceEvidence && <ManualEvidencePanel/g)?.length).toBe(2); // Stage 2 and Stage 3
    const actionsSrc = readFileSync(path.resolve(__dirname, "../actions.ts"), "utf8");
    const at = actionsSrc.indexOf("let manualPriceEvidence");
    expect(actionsSrc.slice(at, at + 400)).toMatch(/if \(canViewCommercials\) \{\s*if \(quote\.draft\.estimator\.pricing\?\.enabled\)/);
  });
});
