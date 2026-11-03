// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaselineExceptionBlock, BaselineExceptionNote, BaselineExceptionsSummary } from "../[id]/BaselineExceptionBlock";
import type { BaselineException, BaselineExceptionView } from "@/newquip/quote/baseline-exception";

afterEach(cleanup);
const items = [
  { itemKey: "flex_auger", label: "M75 feed distribution system", pricedBy: "estimator_input" as const, pricing: "priced by the Estimator (entered price)" },
  { itemKey: "penning_package", label: "PP penning", pricedBy: "penning_rate" as const, pricing: "priced per running metre (penning rate)" },
];
const view = (over: Partial<BaselineExceptionView> = {}): BaselineExceptionView => ({ baselineExceptionRequired: true, items, otherBlockers: [], ...over });
const mount = (over: Partial<Parameters<typeof BaselineExceptionBlock>[0]> = {}) => {
  const onApprove = vi.fn();
  render(<BaselineExceptionBlock view={view()} revision={3} draftHash="h1" canDecide pending={false} onApprove={onApprove} {...over} />);
  return onApprove;
};
const btn = () => screen.getByRole("button", { name: "Approve with recorded exception" }) as HTMLButtonElement;
const described = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");

describe("Stage 3 Manager: the approval exception block", () => {
  it("lists the unmapped Estimator-priced systems and offers ONE primary action", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Approval exception required" })).toBeTruthy();
    expect(screen.getByText("M75 feed distribution system")).toBeTruthy();
    expect(screen.getByText("PP penning")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
  it("renders nothing when no exception is required", () => {
    mount({ view: view({ baselineExceptionRequired: false }) });
    expect(screen.queryByRole("heading", { name: "Approval exception required" })).toBeNull();
  });
  it("is disabled with the reason until a written reason is given AND the box is ticked; then sends the version it was shown", () => {
    const onApprove = mount();
    expect(btn().disabled).toBe(true);
    expect(described(btn())).toMatch(/at least 10 characters/);
    fireEvent.change(screen.getByLabelText("Reason for the exception"), { target: { value: "Library mapping follows the PO" } });
    expect(btn().disabled).toBe(true);
    expect(described(btn())).toMatch(/Tick the box/);
    fireEvent.click(screen.getByLabelText(/I accept this exception/));
    expect(btn().disabled).toBe(false);
    expect(btn().getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(btn());
    expect(onApprove).toHaveBeenCalledWith({ reason: "Library mapping follows the PO", expectedRevision: 3, expectedDraftHash: "h1" });
  });
  it("stays disabled, saying why, when the viewer cannot decide (not a Manager / not signed off / unsaved edits)", () => {
    mount({ canDecide: false, blockedWhy: "Only a Manager can accept this exception." });
    fireEvent.change(screen.getByLabelText("Reason for the exception"), { target: { value: "Library mapping follows the PO" } });
    fireEvent.click(screen.getByLabelText(/I accept this exception/));
    expect(btn().disabled).toBe(true);
    expect(described(btn())).toMatch(/Only a Manager/);
  });
});

describe("version keyed state, hint and the Estimator's cost exception", () => {
  it("a reason and acceptance entered for one version are cleared when the version changes (cannot submit against a new hash)", () => {
    const onApprove = vi.fn();
    const props = { view: view(), revision: 3, draftHash: "h1", canDecide: true, pending: false, onApprove };
    const { rerender } = render(<BaselineExceptionBlock {...props} />);
    fireEvent.change(screen.getByLabelText("Reason for the exception"), { target: { value: "Library mapping follows the PO" } });
    fireEvent.click(screen.getByLabelText(/I accept this exception/));
    expect(btn().disabled).toBe(false);
    rerender(<BaselineExceptionBlock {...props} draftHash="h2" />);
    expect((screen.getByLabelText("Reason for the exception") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText(/I accept this exception/) as HTMLInputElement).checked).toBe(false);
    expect(btn().disabled).toBe(true);
    rerender(<BaselineExceptionBlock {...props} draftHash="h2" revision={4} />);
    expect(btn().disabled).toBe(true);
    expect(onApprove).not.toHaveBeenCalled();
  });
  it("warns that the reason is visible to the Rep", () => {
    mount();
    expect(screen.getByText("Visible to the Rep in the frozen baseline: do not include costs or margins.")).toBeTruthy();
  });
  it("shows the Estimator's cost exception read-only, saying it covers costs only", () => {
    mount({ view: view({ costException: { reason: "Supplier choice follows the PO", by: "est@a", at: "2026-11-01T08:00:00.000Z" } }) });
    expect(screen.getByText(/Supplier choice follows the PO/).textContent).toMatch(/est@a.*covers supplier costs only/);
  });
});

describe("Stage 2 Estimator note and the frozen baseline", () => {
  it("the Estimator sees a read-only note that the Manager will be asked, only when it applies", () => {
    const { rerender } = render(<BaselineExceptionNote view={view()} />);
    expect(screen.getByText(/The Manager will be asked to accept an exception/)).toBeTruthy();
    expect(screen.getByText("PP penning")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    rerender(<BaselineExceptionNote view={view({ baselineExceptionRequired: false })} />);
    expect(screen.queryByText(/The Manager will be asked/)).toBeNull();
    rerender(<BaselineExceptionNote view={undefined} />);
    expect(screen.queryByText(/The Manager will be asked/)).toBeNull();
  });
  it("the frozen baseline shows the exception: items, reason, who, when and version", () => {
    const ex: BaselineException = { kind: "ESTIMATOR_PRICED_WITHOUT_CIN7_SKU", title: "Accepted incomplete: Estimator-priced systems without Cin7 SKU mapping", unresolved: items, reason: "Library mapping follows the PO", approvedBy: "mgr@a", approvedAt: "2026-11-03T10:00:00.000Z", version: { quoteRef: "NQ-Q-0009", revision: 3, draftHash: "0123456789abcdef" } };
    render(<BaselineExceptionsSummary exceptions={[ex]} />);
    const box = screen.getByRole("group", { name: "Recorded baseline exceptions" });
    for (const t of [/Accepted incomplete: Estimator-priced systems without Cin7 SKU mapping/, /M75 feed distribution system/, /Library mapping follows the PO/, /mgr@a/, /NQ-Q-0009 revision 3/, /0123456789ab/]) expect(box.textContent).toMatch(t);
  });
  it("renders nothing when a baseline has no exception", () => {
    const { container } = render(<BaselineExceptionsSummary exceptions={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
