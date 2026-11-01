// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectOverview } from "../ProjectOverview";
import { getProjectOverviewDataAction } from "../../overview-actions";
import { getPhysicalStatusAction } from "../../physical-actions";
import { formatCents } from "@/lib/projects/project-view";
import { marginFigures } from "@/lib/projects/margin-figures";
import { R, demoInput, physRow, project, scope } from "@/lib/projects/__tests__/overview-fixtures";

// The REAL component and the REAL view-model; only the two server actions are replaced.
vi.mock("../../overview-actions", () => ({ getProjectOverviewDataAction: vi.fn() }));
vi.mock("../../physical-actions", () => ({ getPhysicalStatusAction: vi.fn() }));

const overviewAction = vi.mocked(getProjectOverviewDataAction);
const physicalAction = vi.mocked(getPhysicalStatusAction);
const dataOf = (over: Partial<ReturnType<typeof demoInput>> = {}) => { const i = demoInput(over); return { ok: true as const, data: { scopes: i.scopes, unbilledApprovedVariations: i.unbilledApprovedVariations, deliveries: i.deliveries, estimates: i.estimates, viewer: i.viewer } }; };
const renderIt = (props: Partial<{ refreshKey: string; onOpenTab: (t: string) => void }> = {}) => render(<ProjectOverview projectId="p-base" refreshKey={props.refreshKey ?? "k1"} onOpenTab={(props.onOpenTab ?? vi.fn()) as never} />);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("Executive overview - populated", () => {
  beforeEach(() => { overviewAction.mockResolvedValue(dataOf({ estimates: { revised: marginFigures(R(10_572_000), R(7_000_000)), incomplete: false, uncostedSellingCents: 0, exceptions: [] } })); });

  it("shows a loading state first, then the summary, exceptions, milestones and reconciliation", async () => {
    renderIt();
    expect(screen.getByTestId("overview-loading")).toBeTruthy();
    const overview = await screen.findByTestId("overview");
    expect(within(overview).getByTestId("kpi-revised").textContent).toContain(formatCents(R(10_572_000)));
    expect(within(overview).getByTestId("kpi-billed").textContent).toContain(formatCents(R(10_572_000)));
    expect(within(overview).getByTestId("kpi-remaining").textContent).toContain(formatCents(0));
    expect(within(overview).getByTestId("kpi-cost").textContent).toContain(formatCents(R(7_000_000)));
    expect(within(overview).getByTestId("kpi-gp").textContent).toContain("33.79%");
    // commercial progress distinguishes the three measures
    expect(screen.getAllByText("Site progress (reported)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Approved for billing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Billed / committed").length).toBeGreaterThan(0);
    // reconciliation: Cin7 invoices, with the Xero statement
    const tables = screen.getAllByRole("table");
    expect(tables.some((t) => within(t).queryByText("INV-5") !== null)).toBe(true);
    expect(tables.some((t) => within(t).queryByText("INV-V1") !== null)).toBe(true);
    expect(screen.getByTestId("invoiced-total").textContent).toContain(formatCents(R(10_572_000)));
    expect(screen.getByText(/Xero bank and payment reconciliation is not connected or verified/)).toBeTruthy();
    // the unreconciled invoice needs attention
    expect(within(screen.getByTestId("exceptions")).getByText(/created but not reconciled/)).toBeTruthy();
  });

  it("does not read Cin7 until asked, and says quantities are unknown (not zero) until then", async () => {
    renderIt();
    await screen.findByTestId("overview");
    expect(physicalAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("physical-not-loaded").textContent).toMatch(/unknown until Cin7 is read; they are not zero/);
  });

  it("reads fulfilment on request: shows Unknown for an unreadable quantity, flags the shortage, and labels stock account-wide", async () => {
    physicalAction.mockResolvedValue({
      ok: true,
      data: { sections: [{ label: "Original contract", scope: "BASE", linked: true, saleNumber: "SO-27", scopeBlockers: [], exceptions: [], asOf: "2026-11-01T16:00:00Z",
        rows: [physRow("NQ-A", { ordered: 10, shipped: 4, remaining: 6, available: 2, shortfall: 4 }), physRow("NQ-B", { ordered: 5, shipped: null, remaining: null, shortfall: null, available: null })] }] },
    } as never);
    renderIt();
    await screen.findByTestId("overview");
    fireEvent.click(screen.getByRole("button", { name: "Read fulfilment from Cin7" }));
    const totals = await screen.findByTestId("physical-totals");
    expect(physicalAction).toHaveBeenCalledWith("p-base");
    expect(totals.textContent).toContain("Units still to ship");
    expect(totals.textContent).toContain("Unknown"); // one unreadable row makes the total unknown
    expect(screen.getByText("Free stock (whole account)")).toBeTruthy();
    expect(screen.getByText(/not reserved for this project/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh from Cin7" })).toBeTruthy();
  });

  it("a failed Cin7 read is a visible warning, never a silent zero", async () => {
    physicalAction.mockResolvedValue({ ok: false, error: "Cin7 is not reachable" } as never);
    renderIt();
    await screen.findByTestId("overview");
    fireEvent.click(screen.getByRole("button", { name: "Read fulfilment from Cin7" }));
    await waitFor(() => expect(screen.getAllByText("Cin7 is not reachable").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("physical-totals")).toBeNull();
  });

  it("exception links open the owning workflow tab", async () => {
    const onOpenTab = vi.fn();
    renderIt({ onOpenTab });
    await screen.findByTestId("overview");
    fireEvent.click(within(screen.getByTestId("exceptions")).getByRole("button", { name: "Reconcile with Cin7" }));
    expect(onOpenTab).toHaveBeenCalledWith("claims");
  });

  it("reloads when the project changes (refreshKey)", async () => {
    const { rerender } = renderIt({ refreshKey: "k1" });
    await screen.findByTestId("overview");
    rerender(<ProjectOverview projectId="p-base" refreshKey="k2" onOpenTab={vi.fn()} />);
    await waitFor(() => expect(overviewAction).toHaveBeenCalledTimes(2));
  });
});

describe("Executive overview - access, empty and error states", () => {
  it("hides cost and margin from a viewer who may not see cost and says why", async () => {
    overviewAction.mockResolvedValue(dataOf({ viewer: { isAdmin: false }, estimates: null }));
    renderIt();
    await screen.findByTestId("overview");
    expect(screen.queryByTestId("kpi-cost")).toBeNull();
    expect(screen.queryByTestId("kpi-gp")).toBeNull();
    expect(screen.queryByText("Estimated project cost")).toBeNull();
    expect(screen.getByTestId("cost-hidden").textContent).toMatch(/owners and administrators only/);
  });

  it("an empty project shows plain empty states, not blanks or zero-percent bars", async () => {
    const empty = project({ id: "p-empty", project_reference: "PRJ-T-0", original_contract_cents: 0 });
    overviewAction.mockResolvedValue({ ok: true, data: { scopes: [scope({ project: empty, stages: [], saleNumber: null })], unbilledApprovedVariations: [], deliveries: { total: 0, dispatched: 0, inProgress: 0, cancelled: 0, latestActivityAt: null }, estimates: null, viewer: { isAdmin: false } } });
    renderIt();
    await screen.findByTestId("overview");
    expect(screen.getByText("No billing milestones yet.")).toBeTruthy();
    expect(screen.getByText(/No claims have been raised against this Sale yet/)).toBeTruthy();
    expect(screen.getByTestId("no-exceptions").textContent).toMatch(/Nothing needs attention/);
    expect(screen.getByTestId("deliveries").textContent).toContain("None recorded");
  });

  it("deliveries that could not be read are Unknown, not zero", async () => {
    overviewAction.mockResolvedValue(dataOf({ deliveries: null }));
    renderIt();
    await screen.findByTestId("overview");
    const cell = (label: string) => within(screen.getByTestId("deliveries")).getByText(label).nextElementSibling?.textContent;
    expect(cell("Deliveries recorded")).toBe("Unknown");
    expect(cell("Dispatched")).toBe("Unknown");
    expect(cell("Latest delivery activity (Toolbox register)")).toBe("Unknown");
  });

  it("a failed load is a visible error with a working retry", async () => {
    overviewAction.mockResolvedValueOnce({ ok: false, error: "Project not found." }).mockResolvedValueOnce(dataOf());
    renderIt();
    const err = await screen.findByTestId("overview-error");
    expect(err.textContent).toContain("Project not found.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("overview")).toBeTruthy();
    expect(overviewAction).toHaveBeenCalledTimes(2);
  });

  it("a thrown load is also an error state, not an endless spinner", async () => {
    overviewAction.mockRejectedValueOnce(new Error("network"));
    renderIt();
    expect((await screen.findByTestId("overview-error")).textContent).toContain("could not be loaded");
  });

  it("an unbuildable overview (no original scope) is shown as an error, never a half-drawn page", async () => {
    const i = demoInput();
    overviewAction.mockResolvedValue({ ok: true, data: { scopes: [i.scopes[1]], unbilledApprovedVariations: [], deliveries: null, estimates: null, viewer: { isAdmin: true } } });
    renderIt();
    expect((await screen.findByTestId("overview-error")).textContent).toMatch(/exactly one original/);
  });
});
