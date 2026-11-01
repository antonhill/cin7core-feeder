// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ApprovalDetailPage from "../[id]/page";
import * as actions from "../actions";
import type { ApprovalDetail } from "../actions";

// UAT-025 / UAT-023 on the approval review page. The administrator separation-of-duties override must (a) keep exactly its rules - a written reason of
// 10+ characters and an explicit tick - and (b) show every outcome beside the Confirm button: progress, the recorded status, or a failure that keeps
// what was typed. A thrown error must never leave the button spinning (the old page had no try/catch around the call).

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "req-1" }) }));
vi.mock("@/components/ApprovalTimeline", () => ({ ApprovalTimeline: () => null }));
vi.mock("../actions", () => ({ decideApprovalAction: vi.fn(), getApprovalDetailAction: vi.fn(), reassignApprovalAction: vi.fn() }));

const request = (over: Record<string, unknown> = {}) => ({
  id: "req-1", org_id: "o", doc_type: "CLAIM", doc_id: "c1", doc_ref: "PRJ-X-C01", project_id: "p1", revision: 1, digest: "d".repeat(64), amount_cents: 115_000, status: "PENDING",
  prepared_by_email: "prep@x.co", submitted_at: "2026-11-01T10:00:00Z", due_at: null, first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null,
  admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, assigned_to_email: null, assigned_at: null, stage: "MANAGER", stage_role: "MANAGER",
  customer_name: "Spark", project_ref: "PRJ-X", return_destination: null, ...over,
});
const detail = (can: Partial<ApprovalDetail["can"]> = {}, req: Record<string, unknown> = {}): ApprovalDetail => ({
  request: request(req), history: [], docHistoryAll: [], review: { sections: [] }, isManager: true, me: "admin@x.co", managers: [], stage: { stage: "MANAGER", label: "Manager approval", role: "MANAGER" },
  can: { decide: true, withdraw: false, reassign: false, needsOverride: true, ...can },
} as unknown as ApprovalDetail);

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const REASON = "Override reason (required)";
async function openOverride() {
  render(<ApprovalDetailPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
  const box = (await screen.findByLabelText(REASON)).closest("div.space-y-2") as HTMLElement; // the confirmation box under the Decision heading
  return box;
}
const tick = () => screen.getByLabelText(/I confirm this is an administrator override/) as HTMLInputElement;
// The page also has its own static warning alerts; the action's feedback region is addressed explicitly.
const fb = (kind: string) => waitFor(() => { const el = document.querySelector(`[data-testid="action-feedback"][data-kind="${kind}"]`); expect(el).not.toBeNull(); return el as HTMLElement; });
const confirm = (box: HTMLElement) => within(box).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;

beforeEach(() => { vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail() } as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("administrator override: the rules are unchanged", () => {
  it("cannot be confirmed without the explicit tick; and a reason under 10 characters is refused BESIDE the field, submitting nothing", async () => {
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "too short" } });
    expect(confirm(box).disabled).toBe(true); // no tick yet
    fireEvent.click(tick());
    expect(confirm(box).disabled).toBe(false);
    fireEvent.click(confirm(box));
    const field = screen.getByLabelText(REASON);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toMatch(/at least 10 characters/);
    expect(actions.decideApprovalAction).not.toHaveBeenCalled();
  });

  it("submits the override flag and the written reason exactly as entered", async () => {
    vi.mocked(actions.decideApprovalAction).mockResolvedValue({ ok: true, data: request({ status: "APPROVED", admin_override: true, decided_at: "2026-11-01T11:00:00Z", decided_by_email: "admin@x.co" }) } as never);
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "Manager unavailable; owner authorised" } });
    fireEvent.click(tick());
    fireEvent.click(confirm(box));
    await waitFor(() => expect(actions.decideApprovalAction).toHaveBeenCalledTimes(1));
    expect(vi.mocked(actions.decideApprovalAction).mock.calls[0]).toMatchObject(["req-1", "APPROVE", { reason: "Manager unavailable; owner authorised", override: true, expectedVersion: 1 }]);
  });

  it("no override is offered or sent when none is needed", async () => {
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ needsOverride: false }) } as never);
    vi.mocked(actions.decideApprovalAction).mockResolvedValue({ ok: true, data: request({ status: "APPROVED", decided_at: "2026-11-01T11:00:00Z" }) } as never);
    render(<ApprovalDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve…" }));
    expect(screen.queryByLabelText(/administrator override/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(actions.decideApprovalAction).toHaveBeenCalled());
    expect(vi.mocked(actions.decideApprovalAction).mock.calls[0][2]).toMatchObject({ override: false });
  });
});

describe("outcomes appear beside the Confirm button", () => {
  it("in progress -> recorded: the decision record names the resulting status", async () => {
    const d = deferred<unknown>();
    vi.mocked(actions.decideApprovalAction).mockReturnValue(d.promise as never);
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "Manager unavailable; owner authorised" } });
    fireEvent.click(tick());
    fireEvent.click(confirm(box));
    const pending = await within(box).findByText(/Recording your decision/);
    expect(pending.closest("[role=status]")).not.toBeNull();
    await act(async () => d.resolve({ ok: true, data: request({ status: "APPROVED", admin_override: true, decided_at: "2026-11-01T11:00:00Z", decided_by_email: "admin@x.co" }) }));
    const heading = await screen.findByText("Decision recorded");
    const panel = heading.closest("div.rounded-xl, section, div") as HTMLElement;
    expect(within(panel.parentElement!).getByText(/Approved\. This authorises the document only/).textContent).toMatch(/Status now: Approved/);
  });

  it("a server refusal is an alert inside the decision box and everything typed is kept", async () => {
    vi.mocked(actions.decideApprovalAction).mockResolvedValue({ ok: false, error: "This submission is assigned to other@x.co. Ask for it to be reassigned before deciding it." } as never);
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "Manager unavailable; owner authorised" } });
    fireEvent.click(tick());
    fireEvent.click(confirm(box));
    const alert = await fb("error");
    expect(box.contains(alert)).toBe(true); // inside the confirmation box, next to the Confirm button
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(/assigned to other@x\.co/);
    expect((screen.getByLabelText(REASON) as HTMLInputElement).value).toBe("Manager unavailable; owner authorised");
    expect(tick().checked).toBe(true);
    expect(confirm(box).disabled).toBe(false);
  });

  it("a thrown error never leaves the button spinning, keeps the reason, and re-reads the request before suggesting a retry", async () => {
    vi.mocked(actions.decideApprovalAction).mockRejectedValue(new Error("Failed to fetch"));
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "Manager unavailable; owner authorised" } });
    fireEvent.click(tick());
    const reads = vi.mocked(actions.getApprovalDetailAction).mock.calls.length;
    fireEvent.click(confirm(box));
    const alert = await fb("error");
    expect(box.contains(alert)).toBe(true);
    expect(alert.textContent).toMatch(/did not complete and nothing was changed\. You can try again/); // the re-read still shows PENDING
    expect(vi.mocked(actions.getApprovalDetailAction).mock.calls.length).toBeGreaterThan(reads);
    expect(confirm(box).disabled).toBe(false);
    expect((screen.getByLabelText(REASON) as HTMLInputElement).value).toBe("Manager unavailable; owner authorised");
  });

  it("a lost response whose re-read shows the decision WAS recorded is reported as recorded, not as a failure", async () => {
    vi.mocked(actions.decideApprovalAction).mockRejectedValue(new Error("Failed to fetch"));
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "Manager unavailable; owner authorised" } });
    fireEvent.click(tick());
    vi.mocked(actions.getApprovalDetailAction).mockResolvedValue({ ok: true, data: detail({ decide: false, needsOverride: false }, { status: "APPROVED", admin_override: true, decided_at: "2026-11-01T11:00:00Z", decided_by_email: "admin@x.co" }) } as never);
    fireEvent.click(confirm(box));
    expect(await screen.findByText(/lost, but the current status shows it was recorded/i)).toBeTruthy();
    expect(document.querySelector('[data-testid="action-feedback"][data-kind="error"]')).toBeNull(); // not reported as a failure
  });

  it("a double-click on Confirm records the decision once", async () => {
    const d = deferred<unknown>();
    vi.mocked(actions.decideApprovalAction).mockReturnValue(d.promise as never);
    const box = await openOverride();
    fireEvent.change(screen.getByLabelText(REASON), { target: { value: "Manager unavailable; owner authorised" } });
    fireEvent.click(tick());
    act(() => { fireEvent.click(confirm(box)); fireEvent.click(confirm(box)); });
    expect(actions.decideApprovalAction).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ ok: false, error: "x" }));
  });
});
