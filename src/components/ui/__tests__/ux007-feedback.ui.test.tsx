// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionFeedback, useKeyedActions } from "../action-feedback";
import { LongRunningStatus } from "../LongRunningStatus";
import { OP, stillWaitingText, switchingTo } from "../operation-labels";

// UX-007: operation-specific labels, an honest "still waiting" status after ~2s, no duplicate submissions, and a lost response never reads as success.

let release: (v: { ok: boolean; error?: string }) => void = () => {};
const slow = vi.fn(() => new Promise<{ ok: boolean; error?: string }>((res) => { release = res; }));

function Harness({ label = OP.submitToEstimator }: { label?: string }) {
  const acts = useKeyedActions();
  return createElement("div", null,
    createElement("button", { onClick: () => void acts.run("send", slow, { pending: label, success: "Submitted." }) }, "Go"),
    createElement(ActionFeedback, { state: acts.stateOf("send") }),
    createElement(LongRunningStatus, { label: acts.currentLabel }));
}

beforeEach(() => { vi.useFakeTimers(); slow.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("operation labels", () => {
  it("never uses a generic label for the workflow operations", () => {
    for (const v of Object.values(OP)) expect(v).toMatch(/…$/);
    for (const k of ["submitToEstimator", "approveQuotation", "generatePdf", "sendCustomerEmail", "createProject", "createSalesOrder", "postClaim", "createInvoice"] as const) expect(OP[k]).not.toMatch(/^(Working|Loading)…$/);
    expect(switchingTo("Estimator")).toBe("Switching to Estimator…");
  });
});

describe("pending feedback", () => {
  it("shows the operation's own label immediately, and the control is not re-fired by a double click", async () => {
    render(createElement(Harness));
    await act(async () => { fireEvent.click(screen.getByText("Go")); fireEvent.click(screen.getByText("Go")); });
    expect(screen.getByText("Submitting to Estimator…")).toBeTruthy();
    expect(slow).toHaveBeenCalledTimes(1);
    await act(async () => { release({ ok: true }); });
  });

  it("adds a still-waiting line only after ~2s, with real elapsed seconds and no percentage", async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("Go"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId("action-feedback-slow")).toBeNull();
    expect(screen.queryByTestId("long-running-status")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByTestId("action-feedback-slow").textContent).toBe(stillWaitingText(3));
    expect(screen.getByTestId("long-running-status").textContent).toMatch(/Submitting to Estimator · still waiting \(3s\)/);
    expect(document.body.textContent).not.toMatch(/\d+\s?%/);
    expect(screen.getByTestId("long-running-status").className).toMatch(/pointer-events-none/); // never blocks a click
  });

  it("says success only after the operation succeeds, and removes the waiting status", async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("Go"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByText("Submitted.")).toBeNull();
    await act(async () => { release({ ok: true }); });
    expect(screen.getByText("Submitted.")).toBeTruthy();
    expect(screen.queryByTestId("long-running-status")).toBeNull();
  });

  it("a failure is an alert that keeps the user's place and says nothing was changed", async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByText("Go"));
    await act(async () => { release({ ok: false, error: "The Estimator could not be notified. Nothing was changed." }); });
    expect(screen.getByRole("alert").textContent).toMatch(/Nothing was changed/);
  });

  it("a lost response is reported as unconfirmed, never as success", async () => {
    slow.mockImplementationOnce(() => Promise.reject(new Error("network")));
    render(createElement(Harness));
    await act(async () => { fireEvent.click(screen.getByText("Go")); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/could not confirm/i);
    expect(screen.queryByText("Submitted.")).toBeNull();
  });
});
