// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "../ProjectWorkspace";
import { getProjectAction, getViewerPermissionsAction } from "@/app/projects/actions";
import { getProjectOverviewDataAction } from "@/app/projects/overview-actions";
import { demoInput, project, stage, view } from "@/lib/projects/__tests__/overview-fixtures";

// The REAL ProjectWorkspace (tabs, banners, the integration point) and the REAL overview; only server actions and the router are replaced. Panels that
// belong to other tabs are never mounted on these tabs, so their action modules are stubbed empty.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useParams: () => ({}) }));
vi.mock("@/app/projects/actions", () => ({ getProjectAction: vi.fn(), getViewerPermissionsAction: vi.fn() }));
vi.mock("@/app/projects/overview-actions", () => ({ getProjectOverviewDataAction: vi.fn() }));
vi.mock("@/app/projects/physical-actions", () => ({ getPhysicalStatusAction: vi.fn() }));
vi.mock("@/app/projects/cin7-actions", () => ({}));
vi.mock("@/app/projects/profitability-actions", () => ({}));
vi.mock("@/app/projects/procurement-actions", () => ({}));
vi.mock("@/app/projects/variation-billing-actions", () => ({}));
vi.mock("@/app/projects/delivery-actions", () => ({}));
vi.mock("@/app/approvals/actions", () => ({ getDocumentApprovalAction: vi.fn() }));

const projectAction = vi.mocked(getProjectAction);
const overviewAction = vi.mocked(getProjectOverviewDataAction);
const perms = vi.mocked(getViewerPermissionsAction);
const baseView = () => view({ project: project({ id: "p-base", project_reference: "PRJ-T-0001", original_contract_cents: 100_000 }), stages: [stage("s1", 1, "Deposit", 100_000)] });
const variationView = () => view({ project: project({ id: "p-var", project_reference: "PRJ-T-0001-V001", original_contract_cents: 50_000, billing_scope: "VARIATION", parent_project_id: "p-base", variation_id: "v1" }), stages: [stage("v1", 1, "Variation", 50_000)] });
const demoData = () => { const i = demoInput(); return { ok: true as const, data: { scopes: i.scopes, unbilledApprovedVariations: [], deliveries: i.deliveries, estimates: null, viewer: i.viewer } }; };

beforeEach(() => {
  vi.clearAllMocks();
  perms.mockResolvedValue({ ok: true, data: { canApprove: true, newquip: true } });
  overviewAction.mockResolvedValue(demoData());
});
afterEach(() => cleanup());

describe("ProjectWorkspace integration of the executive overview", () => {
  it("renders on a base NewQuip project's Overview tab", async () => {
    projectAction.mockResolvedValue({ ok: true, data: baseView() });
    render(<ProjectWorkspace id="p-base" />);
    expect(await screen.findByTestId("overview")).toBeTruthy();
    expect(overviewAction).toHaveBeenCalledWith("p-base");
  });

  it("an admin opening a VARIATION billing-scope page sees NO overview and NO error banner (the overview is for the original project)", async () => {
    projectAction.mockResolvedValue({ ok: true, data: variationView() });
    // what the real action says for a variation scope
    overviewAction.mockResolvedValue({ ok: false, error: "Load the BASE project; this is a variation billing project." });
    render(<ProjectWorkspace id="p-var" />);
    expect(await screen.findByText(/internal billing scope of a variation/)).toBeTruthy(); // the workspace itself rendered
    await waitFor(() => expect(perms).toHaveBeenCalled());
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(screen.queryByTestId("overview-error")).toBeNull();
    expect(screen.queryByText(/Load the BASE project/)).toBeNull();
    expect(overviewAction).not.toHaveBeenCalled();
  });

  it("is shown ONLY on the Overview tab: leaving it removes it and does not refetch; returning shows it again", async () => {
    projectAction.mockResolvedValue({ ok: true, data: baseView() });
    render(<ProjectWorkspace id="p-base" />);
    await screen.findByTestId("overview");
    const calls = overviewAction.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Stages/ }));
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(overviewAction).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole("button", { name: /^Overview/ }));
    expect(await screen.findByTestId("overview")).toBeTruthy();
  });

  it("not shown for a non-NewQuip organisation", async () => {
    perms.mockResolvedValue({ ok: true, data: { canApprove: true, newquip: false } });
    projectAction.mockResolvedValue({ ok: true, data: baseView() });
    render(<ProjectWorkspace id="p-base" />);
    await waitFor(() => expect(perms).toHaveBeenCalled());
    expect((await screen.findAllByText(/Revised contract value/)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(overviewAction).not.toHaveBeenCalled();
  });
});
