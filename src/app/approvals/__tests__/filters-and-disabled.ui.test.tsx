// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ApprovalsPage from "../page";
import ApprovalDetailPage from "../[id]/page";
import * as actions from "../actions";
import type { ApprovalDetail } from "../actions";
import { filterQueue } from "@/lib/approvals/queue";

// F-10 (Approvals filters: clean default view, More filters, always-visible summary, Clear) and F-12 (every disabled decision control says why, beside the control).
// Presentation only: the filter STATE handed to the server action is what decides the rows, so these tests assert that state is unchanged.

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "req-1" }) }));
vi.mock("@/components/ApprovalTimeline", () => ({ ApprovalTimeline: () => null }));
vi.mock("../actions", () => ({
  decideApprovalAction: vi.fn(), getApprovalDetailAction: vi.fn(), reassignApprovalAction: vi.fn(), getApprovalsDashboardAction: vi.fn(), getMyNotificationsAction: vi.fn(),
  getEmailStatusAction: vi.fn(), retryEmailAction: vi.fn(), saveApprovalSettingsAction: vi.fn(), sendPendingNowAction: vi.fn(), sendTestEmailAction: vi.fn(), getDocumentApprovalAction: vi.fn(),
}));

const req = (over: Record<string, unknown> = {}) => ({
  id: "r1", org_id: "o", doc_type: "QUOTE", doc_id: "q1", doc_ref: "NQ-001", project_id: null, revision: 1, digest: "d".repeat(64), amount_cents: 100_000, status: "PENDING",
  prepared_by_email: "prep@x.co", submitted_at: "2026-10-29T10:00:00Z", due_at: null, first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null,
  admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, assigned_to_email: "mgr@x.co", assigned_at: null, stage: "MANAGER", stage_role: "MANAGER",
  customer_name: "Spark", project_ref: "PRJ", return_destination: null, ...over,
});
const dash = (over: Record<string, unknown> = {}) => ({
  available: true, me: "me@x.co", isManager: true, nowIso: "2026-11-02T10:00:00Z", unread: 0, managers: [], settings: { targetBusinessDays: 2, reminderEveryHours: 24, maxReminders: 3, escalationEmail: null },
  awaitingMeIds: [], summary: { awaitingMe: 0, pending: 1, overdue: 0, returned: 0, approvedToday: 0, approvedThisWeek: 0, rejected: 0, pendingValueCents: 0 }, needsPreparerAction: [],
  failedEmails: [], recentEmails: [], rows: [req({ id: "a", doc_ref: "NQ-A" })], ...over,
});
const lastFilters = () => vi.mocked(actions.getApprovalsDashboardAction).mock.calls.at(-1)![0];
const summary = () => screen.getByTestId("filter-summary");
const more = () => screen.getByRole("button", { name: /^(More|Fewer) filters/ });
const openMore = () => fireEvent.click(more());

beforeEach(() => { vi.mocked(actions.getApprovalsDashboardAction).mockResolvedValue({ ok: true, data: dash() } as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("F-10 Approvals filters", () => {
  it("the default view shows only Show and Status; Type, Sort and the other filters are collapsed behind 'More filters'", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-A");
    for (const l of ["Show", "Status"]) expect(screen.getByLabelText(l)).toBeTruthy();
    expect(document.getElementById(more().getAttribute("aria-controls")!)!.contains(screen.getByLabelText("Type"))).toBe(true);
    expect(document.getElementById(more().getAttribute("aria-controls")!)!.contains(screen.getByLabelText("Sort"))).toBe(true);
    const panel = document.getElementById(more().getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(true);
    expect(more().getAttribute("aria-expanded")).toBe("false");
    expect(more().textContent).toBe("More filters"); // nothing hidden is active, so no count
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull(); // nothing to clear in the default view
    expect(summary().textContent).toMatch(/Status: Pending approval/);
    expect(lastFilters()).toEqual({ status: "PENDING" }); // the server is asked for exactly what it was before
  });

  it("opening the disclosure reveals the secondary filters and toggles aria-expanded", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-A");
    openMore();
    expect(more().getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(more().getAttribute("aria-controls")!)!;
    expect(panel.hidden).toBe(false);
    for (const l of ["Type", "Sort", "Customer", "Project / reference", "Submitted by", "Assigned manager", "Submitted from", "Submitted to"]) expect(within(panel).getByLabelText(l)).toBeTruthy();
    expect(within(panel).getByLabelText("Overdue only")).toBeTruthy();
  });

  it("an active filter inside the closed disclosure is counted on the button AND listed in the always-visible summary", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-A");
    openMore();
    fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Spark" } });
    fireEvent.click(screen.getByLabelText("Overdue only"));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "CLAIM" } });
    openMore(); // collapse again
    expect(more().textContent).toBe("More filters (3)");
    expect(summary().textContent).toMatch(/Type: claim/);
    expect(document.getElementById(more().getAttribute("aria-controls")!)!.hidden).toBe(true);
    expect(summary().textContent).toMatch(/Customer: Spark/);
    expect(summary().textContent).toMatch(/Overdue only/);
    await waitFor(() => expect(lastFilters()).toMatchObject({ status: "PENDING", customer: "Spark", overdueOnly: true, docType: "CLAIM" }));
  });

  it("Clear filters appears only when something differs from the default, resets every filter and the sort to the page defaults, and moves focus to the summary", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-A");
    openMore();
    fireEvent.change(screen.getByLabelText("Assigned manager"), { target: { value: "mgr" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "ANY" } });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "amount_desc" } });
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "mine" } });
    expect(summary().textContent).toMatch(/Status: Any/);
    expect(summary().textContent).toMatch(/Sorted: Amount, high to low/);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastFilters()).toEqual({ status: "PENDING" }));
    expect(vi.mocked(actions.getApprovalsDashboardAction).mock.calls.at(-1)![1]).toBe("submitted_asc");
    expect((screen.getByLabelText("Assigned manager") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(document.activeElement).toBe(summary());
  });

  it("is operable from the keyboard: the disclosure is a native button (Enter/Space activate it) in tab order after the two visible controls", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-A");
    expect(more().tagName).toBe("BUTTON");
    expect(more().tabIndex).toBe(0);
    const order = [...document.querySelectorAll<HTMLElement>("[data-testid='queue-filters'] select, [data-testid='queue-filters'] button")].filter((e) => !e.closest("[hidden]")).map((e) => e.textContent!.trim() || e.getAttribute("id"));
    expect(order.at(-1)).toBe("More filters");
    expect(order).toHaveLength(3);
    // hidden controls are not focusable until the disclosure is open (the panel uses the hidden attribute)
    expect(document.getElementById(more().getAttribute("aria-controls")!)!.hidden).toBe(true);
  });

  it("results are identical to before: the same filter state yields the same rows from the unchanged predicate", () => {
    const rows = [req({ id: "1", customer_name: "Spark" }), req({ id: "2", customer_name: "Better", doc_type: "VARIATION" }), req({ id: "3", status: "APPROVED" })] as never[];
    const f = { status: "PENDING" as const, customer: "spark", docType: "QUOTE" as const };
    expect(filterQueue(rows, f, "x", "2026-11-02T00:00:00Z").map((r) => r.id)).toEqual(["1"]);
  });

  it("an empty result under filters points at Clear filters", async () => {
    vi.mocked(actions.getApprovalsDashboardAction).mockResolvedValue({ ok: true, data: dash({ rows: [] }) } as never);
    render(<ApprovalsPage />);
    await screen.findByText(/Nothing matches these filters/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const detail = (can: Partial<ApprovalDetail["can"]> = {}): ApprovalDetail => ({
  request: req({ doc_type: "CLAIM", doc_ref: "PRJ-X-C01", assigned_to_email: null }), history: [], docHistoryAll: [], review: { sections: [] }, isManager: true, me: "admin@x.co", managers: ["a@x.co"], stage: { stage: "MANAGER", label: "Manager approval", role: "MANAGER" },
  can: { decide: true, withdraw: false, reassign: false, needsOverride: true, ...can },
} as unknown as ApprovalDetail);
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const described = (el: HTMLElement) => el.getAttribute("aria-describedby")!.split(" ").map((i) => document.getElementById(i)?.textContent ?? "").join(" ");

describe("F-12 approval decision controls say why they are disabled", () => {
  beforeEach(() => { vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail() } as never); });

  it("override: Confirm is disabled until the tick is given, and says so beside the button; the override reason field says it needs 10 characters", async () => {
    render(<ApprovalDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(described(confirm)).toMatch(/Tick the administrator override confirmation/);
    expect(described(screen.getByLabelText("Override reason (required)"))).toMatch(/at least 10 characters/);
    fireEvent.change(screen.getByLabelText("Override reason (required)"), { target: { value: "Owner authorised" } });
    expect(screen.queryByText(/before it can be recorded/)).toBeNull(); // 16 characters: the hint is gone
    fireEvent.click(screen.getByLabelText(/I confirm this is an administrator override/));
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
  });

  it("reject / return: Confirm says a written reason is needed until 3 characters are entered", async () => {
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ needsOverride: false }) } as never);
    render(<ApprovalDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(described(confirm)).toMatch(/Enter a reason \(at least 3 characters\) to reject/);
    fireEvent.change(screen.getByLabelText("Reason for rejection (required)"), { target: { value: "no" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for rejection (required)"), { target: { value: "Too low" } });
    expect(confirm.disabled).toBe(false);
  });

  it("while a decision is being recorded every decision button is disabled and the page says why (naming nobody)", async () => {
    const d = deferred<unknown>();
    vi.mocked(actions.decideApprovalAction).mockReturnValue(d.promise as never);
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ needsOverride: false }) } as never);
    render(<ApprovalDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Reject…" }) as HTMLButtonElement).disabled).toBe(true));
    const reject = screen.getByRole("button", { name: "Reject…" });
    expect(described(reject)).toMatch(/A decision is being recorded/);
    expect(document.getElementById("decision-busy-why")!.className).toContain("text-slate-700"); // 4.5:1+ on white, unlike the muted disabled button
    d.resolve({ ok: false, error: "x" });
  });

  it("when this account cannot decide there are no decision buttons and the page says it is waiting without naming anyone beyond the existing text", async () => {
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ decide: false, needsOverride: false }) } as never);
    render(<ApprovalDetailPage />);
    await screen.findByText(/You cannot decide it from this account/);
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/a@x\.co/); // the approver list is never rendered to someone who cannot decide
  });

  it("Reassign says an approver must be chosen", async () => {
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ reassign: true, needsOverride: false }) } as never);
    render(<ApprovalDetailPage />);
    const btn = (await screen.findByRole("button", { name: "Reassign" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(described(btn)).toMatch(/Choose an approver/);
    fireEvent.change(screen.getByLabelText("Reassign to"), { target: { value: "a@x.co" } });
    expect(btn.disabled).toBe(false);
  });
});
