// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ApprovalsPage from "../page";
import ApprovalDetailPage from "../[id]/page";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import * as actions from "../actions";

// D3-C: the Approvals list shows what needs the current user (and which items are pending versus completed), every admin action reports BESIDE its own button and
// cannot be submitted twice, and no loading state can spin forever.

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
  awaitingMeIds: ["mine"], summary: { awaitingMe: 1, pending: 2, overdue: 0, returned: 0, approvedToday: 0, approvedThisWeek: 0, rejected: 0, pendingValueCents: 0 }, needsPreparerAction: [],
  failedEmails: [], recentEmails: [], rows: [req({ id: "mine", doc_ref: "NQ-MINE", assigned_to_email: "me@x.co" }), req({ id: "other", doc_ref: "NQ-OTHER" }), req({ id: "done", doc_ref: "NQ-DONE", status: "APPROVED" })], ...over,
});
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const openAdmin = async () => { render(<ApprovalsPage />); await screen.findByText("NQ-MINE"); fireEvent.click(screen.getByRole("button", { name: /Delivery & settings/ })); };

beforeEach(() => { vi.mocked(actions.getApprovalsDashboardAction).mockResolvedValue({ ok: true, data: dash() } as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Approvals list: what needs me, pending versus completed", () => {
  it("marks only the item assigned to the current user, says how many are waiting, and counts pending versus completed", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-MINE");
    const mineRow = screen.getByText("NQ-MINE").closest("tr")!;
    expect(within(mineRow).getByText("Your decision")).toBeTruthy();
    expect(screen.getAllByText("Your decision")).toHaveLength(1);
    expect(screen.getByTestId("awaiting-me").textContent).toMatch(/1 approval is waiting for your decision/);
    expect(screen.getByTestId("queue-count").textContent).toMatch(/3 approvals: 2 pending, 1 completed or returned/);
  });
  it("a role-based, unassigned item that I may decide is marked too (the badge agrees with the count and the filter, which are role-aware)", async () => {
    vi.mocked(actions.getApprovalsDashboardAction).mockResolvedValue({ ok: true, data: dash({ awaitingMeIds: ["byrole"], summary: { ...dash().summary, awaitingMe: 1 }, rows: [req({ id: "byrole", doc_ref: "NQ-ROLE", assigned_to_email: null }), req({ id: "other", doc_ref: "NQ-OTHER", assigned_to_email: null })] }) } as never);
    render(<ApprovalsPage />);
    await screen.findByText("NQ-ROLE");
    expect(within(screen.getByText("NQ-ROLE").closest("tr")!).getByText("Your decision")).toBeTruthy();
    expect(within(screen.getByText("NQ-OTHER").closest("tr")!).queryByText("Your decision")).toBeNull();
  });
  it("'Show what needs my decision' filters to my pending approvals", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-MINE");
    fireEvent.click(screen.getByRole("button", { name: "Show what needs my decision" }));
    await waitFor(() => expect(vi.mocked(actions.getApprovalsDashboardAction).mock.calls.at(-1)![0]).toMatchObject({ mine: true, status: "PENDING" }));
  });
  it("shows no 'waiting for you' band when nothing is waiting", async () => {
    vi.mocked(actions.getApprovalsDashboardAction).mockResolvedValue({ ok: true, data: dash({ summary: { ...dash().summary, awaitingMe: 0 }, rows: [req({ id: "other", doc_ref: "NQ-OTHER" })] }) } as never);
    render(<ApprovalsPage />);
    await screen.findByText("NQ-OTHER");
    expect(screen.queryByTestId("awaiting-me")).toBeNull();
    expect(screen.queryByText("Your decision")).toBeNull();
  });
});

describe("D4 F-05: the queue table scrolls inside its own labelled region and says so", () => {
  it("a keyboard-reachable, named scroll region with a visible cue; Rev and Submitted by/at are folded into Reference and Submitted (no data dropped)", async () => {
    render(<ApprovalsPage />);
    await screen.findByText("NQ-MINE");
    const region = screen.getByRole("region", { name: "Approvals queue" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toContain("overflow-x-auto");
    expect(screen.getByTestId("table-scroll-cue").textContent).toMatch(/Scroll sideways/);
    const heads = within(region).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toContain("Submitted");
    expect(heads).not.toContain("Rev");
    expect(heads).not.toContain("Submitted by");
    const row = within(region).getByText("NQ-MINE").closest("tr") as HTMLElement;
    expect(row.textContent).toContain("rev 1");
    expect(row.textContent).toContain("prep@x.co");
  });
});

describe("admin actions report beside the button and cannot be double-submitted", () => {
  it("Save settings: a fast double click saves once, shows progress then the result next to the button", async () => {
    const d = deferred<{ ok: boolean }>();
    vi.mocked(actions.saveApprovalSettingsAction).mockReturnValue(d.promise as never);
    await openAdmin();
    const save = screen.getByRole("button", { name: "Save settings" });
    act(() => { save.click(); save.click(); }); // both clicks land before React re-renders: only the in-flight guard can stop the second
    expect(actions.saveApprovalSettingsAction).toHaveBeenCalledTimes(1);
    const pending = await waitFor(() => { const e = document.querySelector('[data-testid="action-feedback"][data-kind="pending"]') as HTMLElement; expect(e).not.toBeNull(); return e; });
    expect(pending.previousElementSibling).toBe(save.parentElement);
    d.resolve({ ok: true });
    await waitFor(() => expect(document.querySelector('[data-testid="action-feedback"][data-kind="success"]')?.textContent).toBe("Settings saved."));
  });
  it("Save settings failure: the server's reason appears beside the button as an alert", async () => {
    vi.mocked(actions.saveApprovalSettingsAction).mockResolvedValue({ ok: false, error: "Target must be at least 1 business day." } as never);
    await openAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Target must be at least 1 business day.");
  });
  it("Retry on a failed email: feedback appears on that email's own row", async () => {
    const note = { id: "n1", subject: "Approval needed", recipient_email: "a@x.co", created_at: "2026-11-01T10:00:00Z", sent_at: null, attempts: 3, last_error: "boom", status: "FAILED" };
    vi.mocked(actions.getApprovalsDashboardAction).mockResolvedValue({ ok: true, data: dash({ recentEmails: [note], failedEmails: [note] }) } as never);
    vi.mocked(actions.retryEmailAction).mockResolvedValue({ ok: true, data: { sent: 0, failed: 1, suppressed: 0 } } as never);
    await openAdmin();
    const li = (await screen.findByText(/Approval needed to a@x.co/)).closest("li")!;
    fireEvent.click(within(li).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(li).getByText(/the provider did not accept it/)).toBeTruthy());
  });
});

describe("no indefinite spinners", () => {
  it("a failed notifications load says so with a way to retry (not 'No notifications.' and not a spinner)", async () => {
    vi.mocked(actions.getMyNotificationsAction).mockRejectedValue(new Error("offline"));
    render(<ApprovalsPage />);
    await screen.findByText("NQ-MINE");
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect((await screen.findByText(/Could not load your notifications/)).textContent).toMatch(/Try again/);
    expect(screen.queryByText("No notifications.")).toBeNull();
  });
  it("the document approval history ends in an error (and can be retried) when its request rejects", async () => {
    vi.mocked(actions.getDocumentApprovalAction).mockRejectedValue(new Error("offline"));
    const { container } = render(<ApprovalHistory docType="QUOTE" docId="q1" />);
    const details = container.querySelector("details")!;
    details.open = true; fireEvent(details, new Event("toggle"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not load the approval history/);
    expect(screen.queryByText(/Loading the approval history/)).toBeNull();
  });
});

describe("approval detail: tells the user whether it is theirs to decide", () => {
  const detail = (can: Record<string, boolean>) => ({ request: req({ doc_type: "CLAIM", project_id: "p1" }), history: [], docHistoryAll: [], review: { sections: [] }, isManager: false, me: "me@x.co", managers: [], stage: { stage: "MANAGER", label: "Manager approval", role: "MANAGER" }, can: { decide: false, withdraw: false, reassign: false, needsOverride: false, ...can } });
  it("shows 'Waiting for your decision' with a link to the decision when the user can decide", async () => {
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ decide: true }) } as never);
    render(<ApprovalDetailPage />);
    expect((await screen.findByTestId("needs-your-decision")).textContent).toMatch(/Waiting for your decision/);
    expect(screen.getByRole("link", { name: "decide" }).getAttribute("href")).toBe("#decision");
  });
  it("explains who it is waiting for, and that nothing is theirs to do, when the user cannot decide", async () => {
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({}) } as never);
    render(<ApprovalDetailPage />);
    await screen.findByText(/This approval is waiting for mgr@x.co/);
    expect(screen.queryByTestId("needs-your-decision")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
  });
});
