// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// F-13 wiring: the approvals admin settings form guards only while its value differs from the loaded settings. jsdom-only evidence.
const h = vi.hoisted(() => ({ isManager: true, settings: { targetBusinessDays: 2, reminderEveryHours: 24, maxReminders: 3, escalationEmail: null as string | null } }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/ApprovalQueueFilters", () => ({ ApprovalQueueFilters: () => null }));
vi.mock("@/app/ModuleHeader", () => ({ ModuleHeader: () => null }));
vi.mock("../actions", () => ({
  getApprovalsDashboardAction: vi.fn(async () => ({ ok: true, data: {
    available: true, me: "m@x.co.za", isManager: h.isManager, nowIso: "2026-11-02T00:00:00Z",
    summary: { awaitingMe: 0, pending: 0, overdue: 0, returned: 0, approvedToday: 0, approvedThisWeek: 0, rejected: 0, pendingValueCents: 0 },
    awaitingMeIds: [], rows: [], needsPreparerAction: [], managers: [], failedEmails: [], recentEmails: [], unread: 0, settings: { ...h.settings },
  } })),
  getEmailStatusAction: vi.fn(async () => ({ ok: false })), getMyNotificationsAction: vi.fn(), retryEmailAction: vi.fn(), sendPendingNowAction: vi.fn(), sendTestEmailAction: vi.fn(),
  saveApprovalSettingsAction: vi.fn(async () => ({ ok: true })),
}));
import ApprovalsPage from "../page";
import * as actions from "../actions";

const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
afterEach(() => { cleanup(); h.isManager = true; h.settings = { targetBusinessDays: 2, reminderEveryHours: 24, maxReminders: 3, escalationEmail: null }; vi.clearAllMocks(); });

async function openAdmin() {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Delivery & settings/ }));
  return (await screen.findByLabelText("Target (business days)")) as HTMLInputElement;
}

describe("Approvals admin settings unsaved guard", () => {
  it("untouched is clean; editing guards; reverting releases", async () => {
    const target = await openAdmin();
    expect(unload()).toBe(false);
    fireEvent.change(target, { target: { value: "5" } });
    expect(unload()).toBe(true);
    fireEvent.change(target, { target: { value: "2" } });
    expect(unload()).toBe(false);
  });
  it("a successful save (server returns the new values) releases the guard", async () => {
    const target = await openAdmin();
    fireEvent.change(target, { target: { value: "5" } });
    expect(unload()).toBe(true);
    h.settings = { ...h.settings, targetBusinessDays: 5 };
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(actions.saveApprovalSettingsAction).toHaveBeenCalled());
    await waitFor(() => expect(unload()).toBe(false));
  });
  it("a non-manager has no settings form and never guards", async () => {
    h.isManager = false;
    render(<ApprovalsPage />);
    await waitFor(() => expect(actions.getApprovalsDashboardAction).toHaveBeenCalled());
    await screen.findByTestId("approvals-summary");
    expect(screen.queryByLabelText("Target (business days)")).toBeNull();
    expect(unload()).toBe(false);
  });
});
