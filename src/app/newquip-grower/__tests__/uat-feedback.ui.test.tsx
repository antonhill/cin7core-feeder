// @vitest-environment jsdom
// CUSTOMER UAT FEEDBACK UI: the INCOMPLETE ESTIMATE warning and the Budget quotation panel (unsaved-change warning, incomplete acknowledgement, UAT recipient, no premature send).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IncompleteEstimateBanner } from "../[id]/IncompleteEstimateBanner";
import { incompleteEstimateText } from "@/newquip/grower/incomplete-estimate";

const DONE = { ok: true, data: { stillToRead: 0, done: true, status: "applied" } };
const h = vi.hoisted(() => ({ send: vi.fn(), status: vi.fn(), complete: vi.fn() }));
vi.mock("../budget-actions", () => ({ getBudgetStatusAction: (...a: unknown[]) => h.status(...a), sendBudgetQuotationAction: (...a: unknown[]) => h.send(...a), completeBudgetPricingAction: (...a: unknown[]) => h.complete(...a) }));
import { BudgetQuotationPanel } from "../[id]/BudgetQuotationPanel";
h.complete.mockResolvedValue({ ok: true, data: { stillToRead: 0, done: true } });

afterEach(() => { cleanup(); h.send.mockReset(); h.status.mockReset(); h.complete.mockReset(); h.complete.mockResolvedValue(DONE); });

const est = { lines: [{ itemKey: "pvc_door", label: "PVC SST door (incl. frame)", quantity: 12, reason: "Product not yet confirmed" }, { itemKey: "controller", label: "Thomas-CL1 controller", quantity: 3, reason: "Product not yet confirmed" }], count: 2, text: incompleteEstimateText(2), chargesSubtotalExVat: 40500, pricedEquipmentExVat: 0, knownSubtotalExVat: 40500 };
const status = (over = {}) => ({ ok: true, data: { canSend: true, blockedReason: null, testMode: true, draftHash: "h1", draftRef: "abc123", complete: false, unpricedCount: 5, unpricedItems: ["PVC SST door x 12"], testRecipient: "anton@sparkconsulting.co.za", ...over } });

describe("IncompleteEstimateBanner", () => {
  it("shows the exact warning, the KNOWN charge subtotal separately, the project total as NOT available, and the unpriced lines", () => {
    render(<IncompleteEstimateBanner estimate={est} />);
    expect(screen.getByRole("alert").textContent).toContain("INCOMPLETE ESTIMATE — 2 equipment lines have no confirmed selling price. The displayed amount excludes these items and is not a complete quotation total.");
    expect(screen.getByTestId("incomplete-charges-subtotal").textContent).toMatch(/40[\s ]500/);
    expect(screen.getByTestId("incomplete-total-project").textContent).toBe("Not available");
    expect(screen.getByTestId("incomplete-lines").textContent).toContain("PVC SST door (incl. frame) × 12");
  });
  it("renders nothing for a complete estimate", () => { const { container } = render(<IncompleteEstimateBanner estimate={null} />); expect(container.textContent).toBe(""); });
  it("text mode is the sentence only; detail mode is the breakdown only", () => {
    const a = render(<IncompleteEstimateBanner estimate={est} mode="text" />);
    expect(a.container.textContent).toContain("INCOMPLETE ESTIMATE");
    expect(a.container.textContent).not.toContain("Total project estimate");
    a.unmount();
    const b = render(<IncompleteEstimateBanner estimate={est} mode="detail" />);
    expect(b.container.textContent).not.toContain("INCOMPLETE ESTIMATE");
    expect(b.container.textContent).toContain("Total project estimate");
  });
});

describe("BudgetQuotationPanel", () => {
  it("offers a prominent Preview link to the saved-draft PDF and warns about unsaved changes", async () => {
    h.status.mockResolvedValue(status());
    render(<BudgetQuotationPanel quoteId="q1" canAct dirty refreshKey="k" />);
    expect(screen.getByTestId("preview-budget-quotation").getAttribute("href")).toBe("/api/newquip-budget-preview/q1");
    expect(screen.getByTestId("budget-unsaved").textContent).toContain("unsaved changes");
    await waitFor(() => expect(screen.getByTestId("budget-incomplete").textContent).toContain("Price to be confirmed"));
  });
  it("cannot send with unsaved changes or without the incomplete acknowledgement; sends once to the UAT mailbox with the previewed draft hash", async () => {
    h.status.mockResolvedValue(status());
    h.send.mockResolvedValue({ ok: true, data: { status: "ACCEPTED", to: "anton@sparkconsulting.co.za", reused: false, testMode: true, incompleteCount: 5 } });
    const { rerender } = render(<BudgetQuotationPanel quoteId="q1" canAct dirty refreshKey="k" />);
    await waitFor(() => expect(screen.getByTestId("budget-incomplete")).toBeTruthy());
    fireEvent.click(screen.getByTestId("send-budget-quotation"));
    expect(screen.getByTestId("budget-send-why").textContent).toContain("Save your changes first");
    rerender(<BudgetQuotationPanel quoteId="q1" canAct dirty={false} refreshKey="k" />);
    expect(screen.getByTestId("budget-send-why").textContent).toContain("Tick the confirmation");
    expect(screen.getByTestId("budget-test-recipient").textContent).toContain("anton@sparkconsulting.co.za");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Send Budget Quotation now"));
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.send.mock.calls[0][1]).toMatchObject({ to: "anton@sparkconsulting.co.za", expectedDraftHash: "h1", acknowledgeIncomplete: true });
    await waitFor(() => expect(screen.getByTestId("budget-sent").textContent).toContain("nothing was approved or issued"));
  });
  it("a non-Rep (Estimator / Manager) sees Preview but no Send", async () => {
    h.status.mockResolvedValue(status({ canSend: false, blockedReason: "Only a Rep sends a budget quotation." }));
    render(<BudgetQuotationPanel quoteId="q1" canAct={false} dirty={false} refreshKey="k" />);
    expect(screen.getByTestId("preview-budget-quotation")).toBeTruthy();
    expect(screen.queryByTestId("send-budget-quotation")).toBeNull();
  });
  it("a blocked environment shows the reason and keeps Send disabled", async () => {
    h.status.mockResolvedValue(status({ canSend: false, blockedReason: "Production email is not enabled" }));
    render(<BudgetQuotationPanel quoteId="q1" canAct dirty={false} refreshKey="k" />);
    await waitFor(() => expect(h.status).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("send-budget-quotation"));
    await waitFor(() => expect(screen.getByTestId("budget-send-why").textContent).toContain("Production email is not enabled"));
    expect((screen.getByText("Send Budget Quotation now").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BudgetQuotationPanel completes a Rep's supplier prices by itself (P0: no 'not yet priced' for a price that is obtainable)", () => {
  it("a Rep's saved draft with unpriced lines triggers the completion; the Preview waits for it and returns afterwards", async () => {
    let release: (v: unknown) => void = () => undefined;
    h.complete.mockReturnValue(new Promise((r) => { release = r; }));
    h.status.mockResolvedValue(status());
    render(<BudgetQuotationPanel quoteId="q1" canAct dirty={false} refreshKey="k" />);
    await waitFor(() => expect(h.complete).toHaveBeenCalledWith("q1"));
    expect(screen.getByTestId("budget-pricing-progress")).toBeTruthy();
    expect(screen.queryByTestId("preview-budget-quotation")).toBeNull();
    release({ ok: true, data: { stillToRead: 0, done: true, status: "applied" } });
    await waitFor(() => expect(screen.getByTestId("preview-budget-quotation")).toBeTruthy());
  });
  it("it does not run for a viewer who is not the Rep, with unsaved changes, or when nothing is unpriced", async () => {
    h.status.mockResolvedValue(status());
    // each case waits for the STATUS TO RENDER (the incomplete banner / the preview link), so the effect has had its chance to run before we assert it did not
    const a = render(<BudgetQuotationPanel quoteId="q1" canAct={false} dirty={false} refreshKey="k" />);
    await waitFor(() => expect(screen.getByTestId("budget-incomplete")).toBeTruthy());
    a.unmount();
    h.status.mockResolvedValue(status());
    const b = render(<BudgetQuotationPanel quoteId="q1" canAct dirty refreshKey="k2" />);
    await waitFor(() => expect(screen.getByTestId("budget-incomplete")).toBeTruthy());
    b.unmount();
    h.status.mockResolvedValue(status({ unpricedCount: 0, complete: true, unpricedItems: [] }));
    render(<BudgetQuotationPanel quoteId="q1" canAct dirty={false} refreshKey="k3" />);
    await waitFor(() => expect(screen.getByTestId("preview-budget-quotation")).toBeTruthy());
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe("BudgetQuotationPanel: unfinished retrieval is never hidden", () => {
  it("when retrieval keeps making no progress the panel says so plainly, offers a retry, and the retry runs the completion again", async () => {
    h.complete.mockResolvedValue({ ok: true, data: { stillToRead: 7, done: false, status: "applied" } });
    h.status.mockImplementation(async () => status()); // a FRESH status object per read, like the real action
    render(<BudgetQuotationPanel quoteId="q1" canAct dirty={false} refreshKey="kx" />);
    await waitFor(() => expect(screen.getByTestId("budget-retrieval-unfinished")).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByTestId("budget-retrieval-unfinished").textContent).toMatch(/NOT complete/);
    const callsBefore = h.complete.mock.calls.length;
    expect(callsBefore).toBeLessThanOrEqual(6); // the round cap is honoured
    h.complete.mockResolvedValue({ ok: true, data: { stillToRead: 0, done: true, status: "applied" } });
    fireEvent.click(screen.getByTestId("budget-retry-pricing"));
    await waitFor(() => expect(h.complete.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.queryByTestId("budget-retrieval-unfinished")).toBeNull());
  });
});

describe("BudgetQuotationPanel: a status a retry cannot change is not blamed on Cin7", () => {
  it("settings_incomplete stops at once with its own message and no retry button", async () => {
    h.complete.mockResolvedValue({ ok: true, data: { stillToRead: 0, done: false, status: "settings_incomplete" } });
    h.status.mockImplementation(async () => status());
    render(<BudgetQuotationPanel quoteId="q1" canAct dirty={false} refreshKey="ky" />);
    await waitFor(() => expect(screen.getByTestId("budget-retrieval-not-applicable")).toBeTruthy());
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("budget-retrieval-unfinished")).toBeNull();
    expect(screen.queryByTestId("budget-retry-pricing")).toBeNull();
  });
});
