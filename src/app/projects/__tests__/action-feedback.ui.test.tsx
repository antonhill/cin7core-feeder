// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import * as actions from "../actions";
import type { ProjectView } from "@/lib/projects/project-view";

// UAT-025 / UAT-023 on the real Project screen: a claim near the BOTTOM of a long page must show what happened beside its own buttons.
// (jsdom has no layout, so "in the viewport" is asserted structurally: the message lives inside the claim card that holds the clicked button,
// has the right ARIA role, and the old page-top banner area stays empty.)

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: () => null }));
vi.mock("../actions", () => ({
  getProjectAction: vi.fn(), getViewerPermissionsAction: vi.fn(), approveClaimAction: vi.fn(), submitClaimForApprovalAction: vi.fn(), cancelDraftClaimAction: vi.fn(),
  createClaimDraftAction: vi.fn(), previewClaimAction: vi.fn(), recalculateStaleDraftAction: vi.fn(), recordProgressAction: vi.fn(),
}));
// The sibling panels have their own tests and their own server-action modules; here the claim cards and stage forms under test are real.
vi.mock("../[id]/Cin7SaleCreationPanel", () => ({ Cin7SaleCreationPanel: () => null }));
vi.mock("../[id]/Cin7PostingPanel", () => ({ Cin7PostingPanel: () => null }));
vi.mock("../[id]/OpeningCommitmentsPanel", () => ({ OpeningCommitmentsPanel: () => null }));
vi.mock("../[id]/VariationsPanel", () => ({ VariationsPanel: () => null }));
vi.mock("../[id]/DeliveryAllocationPanel", () => ({ DeliveryAllocationPanel: () => null }));
vi.mock("../[id]/PhysicalPanel", () => ({ PhysicalPanel: () => null }));
vi.mock("../[id]/ProcurementPanel", () => ({ ProcurementPanel: () => null }));
vi.mock("../[id]/ProfitabilityPanel", () => ({ ProfitabilityPanel: () => null }));

const SOD = "You do not hold the manager role. An administrator may approve at this stage only as an explicit override with a written reason.";
const stage = (i: number) => ({ id: `s${i}`, name: `Stage ${i}`, stageValueCents: 100_000, claimableCents: 0, remainingCents: 0, reportedBps: 0, approvedBps: 0, committedBps: 0, history: [] });
function claim(status: string) {
  return {
    id: "c1", claim_number: "PRJ-X-C01", claim_date: "2026-11-01", supersedes_claim_id: null, total_cents: 115_000, subtotal_cents: 100_000, tax_cents: 15_000, status, reserves: true,
    cin7: null, cin7Status: { kind: "NOT_SENT", tone: "neutral", label: "Not sent", invoiceNumber: null, reconciled: false, detail: null },
    approval: status === "READY_FOR_APPROVAL" ? { requestId: "req-1", stageRole: "MANAGER" } : null,
  };
}
// Many other claims above it: the one under test is at the bottom of a long list.
const view = (status: string): ProjectView => ({
  project: { id: "p1", project_reference: "PRJ-X", name: "Long page", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 100_000 },
  commercial: { originalContractCents: 100_000, approvedVariationsCents: 0, revisedContractCents: 100_000, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 100_000, approvedCompletionBps: 0, scheduleBalanced: true, uncertainClaimBlocking: false },
  stages: [stage(1), stage(2)], claims: [...Array.from({ length: 12 }, (_, i) => ({ ...claim("RECONCILED"), id: `old${i}`, claim_number: `PRJ-X-OLD${i}`, approval: null })), claim(status)],
  allocations: [], variations: [], openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [],
} as unknown as ProjectView);

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
async function openClaims() {
  render(<ProjectWorkspace id="p1" />);
  fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
  const articles = await waitFor(() => { const a = document.querySelectorAll("article"); expect(a.length).toBe(13); return a; });
  return articles[12] as HTMLElement; // the claim at the bottom
}

beforeEach(() => {
  vi.mocked(actions.getViewerPermissionsAction).mockResolvedValue({ ok: true, data: { canApprove: true, newquip: false } } as never);
  vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: true, data: view("READY_FOR_APPROVAL") } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("claim approval near the bottom of a long Project page", () => {
  it("shows progress, then the success AND the resulting status, inside the claim card; nothing appears at the top", async () => {
    const card = await openClaims();
    const d = deferred<{ ok: boolean }>();
    vi.mocked(actions.approveClaimAction).mockReturnValue(d.promise as never);
    vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: true, data: view("APPROVED") } as never);

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const pending = await within(card).findByText(/Working/);
    expect(pending.closest("[role=status]")).not.toBeNull();
    expect((within(card).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => d.resolve({ ok: true }));
    const ok = await within(card).findByText(/approved — value reserved/i);
    expect(ok.textContent).toMatch(/Status now: approved/i);
    expect(ok.closest("[role=status]")).not.toBeNull();
    // The old behaviour put the message in a banner above the tabs. Nothing is rendered there any more.
    expect(document.querySelector("main > [role=alert]")).toBeNull();
    expect(screen.queryAllByText(/value reserved/i)).toHaveLength(1);
  });

  it("a refusal (administrator without the manager role) is shown beside the Approve button, takes focus, and points to the override route", async () => {
    const card = await openClaims();
    vi.mocked(actions.approveClaimAction).mockResolvedValue({ ok: false, error: SOD } as never);
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain(SOD);
    expect(document.activeElement).toBe(alert);
    const link = within(alert).getByRole("link", { name: /Open this claim in Approvals/ });
    expect(link.getAttribute("href")).toBe("/approvals/req-1");
    // no page-level duplicate
    expect(screen.getAllByText(SOD)).toHaveLength(1);
    // and the button is usable again
    expect((within(card).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a double-click submits the approval ONCE", async () => {
    const card = await openClaims();
    const d = deferred<{ ok: boolean }>();
    vi.mocked(actions.approveClaimAction).mockReturnValue(d.promise as never);
    const btn = within(card).getByRole("button", { name: "Approve" });
    act(() => { fireEvent.click(btn); fireEvent.click(btn); }); // both land before React re-renders
    expect(actions.approveClaimAction).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ ok: true }));
  });

  it("a lost response re-reads the claim first: recorded -> reported as done; not recorded -> only then a retry is suggested", async () => {
    const card = await openClaims();
    vi.mocked(actions.approveClaimAction).mockRejectedValue(new Error("network down"));
    // 1. the decision DID land
    vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: true, data: view("APPROVED") } as never);
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const done = await within(card).findByText(/lost, but the current status shows it was recorded/i);
    expect(done.closest("[role=status]")).not.toBeNull();
    expect(vi.mocked(actions.getProjectAction).mock.calls.length).toBeGreaterThan(1); // it re-read before saying so
  });
  it("a lost response where the re-read shows NOT approved: told it did not complete and may be retried", async () => {
    const card = await openClaims();
    vi.mocked(actions.approveClaimAction).mockRejectedValue(new Error("timeout"));
    vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: true, data: view("READY_FOR_APPROVAL") } as never);
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toMatch(/did not complete and nothing was changed\. You can try again/);
  });
  it("a lost response whose re-read also fails: told to check the status, not to retry", async () => {
    const card = await openClaims();
    vi.mocked(actions.approveClaimAction).mockRejectedValue(new Error("offline"));
    vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: false, error: "offline" } as never);
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toMatch(/could not confirm/i);
    expect(alert.textContent).not.toMatch(/you can try again/i);
  });
});

describe("authorisation is unchanged by the feedback work", () => {
  it("the Approve button is still offered only to administrators (the server decides everything else)", async () => {
    vi.mocked(actions.getViewerPermissionsAction).mockResolvedValue({ ok: true, data: { canApprove: false, newquip: false } } as never);
    const card = await openClaims();
    expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(actions.approveClaimAction).not.toHaveBeenCalled();
  });
});

describe("stage progress updates (commercial approval)", () => {
  async function openStage() {
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Stages/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Update progress" }))[0]);
    // the stage's own panel = the nearest ancestor of its comment field that also holds its "Hide" toggle
    let el: HTMLElement | null = screen.getByLabelText(/Comment \/ reason/);
    while (el && !Array.from(el.querySelectorAll("button")).some((b) => b.textContent === "Hide")) el = el.parentElement;
    return { stagePanel: el as HTMLElement };
  }
  const comment = () => screen.getByLabelText(/Comment \/ reason/) as HTMLInputElement;
  const approved = () => screen.getByLabelText(/Approved commercial completion/) as HTMLInputElement;
  const submit = () => screen.getByRole("button", { name: "Approve commercial progress" });
  const invalid = (el: HTMLElement) => el.getAttribute("aria-invalid") === "true";

  it("validation is shown beside each field (not in one alert below), nothing is submitted, and nothing typed is lost", async () => {
    await openStage();
    fireEvent.click(submit()); // unchanged percentage and no reason
    expect(invalid(approved())).toBe(true);
    expect(invalid(comment())).toBe(true);
    expect(document.getElementById(approved().getAttribute("aria-describedby")!)?.textContent).toMatch(/different approved percentage/);
    expect(document.getElementById(comment().getAttribute("aria-describedby")!)?.textContent).toMatch(/reason is required/);
    expect(actions.recordProgressAction).not.toHaveBeenCalled();
    fireEvent.change(approved(), { target: { value: "40" } });
    expect(invalid(approved())).toBe(false); // clears as soon as it is fixed
    expect(invalid(comment())).toBe(true);
  });

  it("a server failure appears in the stage's own panel and keeps the percentage and the reason", async () => {
    const { stagePanel } = await openStage();
    vi.mocked(actions.recordProgressAction).mockResolvedValue({ ok: false, error: "Approved completion cannot exceed what the schedule allows." } as never);
    fireEvent.change(approved(), { target: { value: "40" } });
    fireEvent.change(comment(), { target: { value: "Milestone met" } });
    fireEvent.click(submit());
    const alert = await waitFor(() => { const e = document.querySelector('[data-testid="action-feedback"][data-kind="error"]') as HTMLElement; expect(e).not.toBeNull(); return e; });
    expect(stagePanel.contains(alert)).toBe(true);
    expect(alert.textContent).toMatch(/cannot exceed/);
    expect(approved().value).toBe("40");
    expect(comment().value).toBe("Milestone met");
  });

  it("success is reported in the stage's panel and closes the form", async () => {
    const { stagePanel } = await openStage();
    vi.mocked(actions.recordProgressAction).mockResolvedValue({ ok: true } as never);
    fireEvent.change(approved(), { target: { value: "40" } });
    fireEvent.change(comment(), { target: { value: "Milestone met" } });
    fireEvent.click(submit());
    const ok = await screen.findByText(/Commercial approval recorded for Stage 1/);
    expect(stagePanel.contains(ok)).toBe(true);
    await waitFor(() => expect(screen.queryByLabelText(/Comment \/ reason/)).toBeNull());
  });
});
