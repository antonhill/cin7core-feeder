// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectView } from "@/lib/projects/project-view";

// F-13 wiring: VariationsPanel (raise / re-price / reject) and VariationBillingPanel (schedule editor, amend reason) guard unsaved input ONLY while a form differs
// from its saved/initial value. jsdom-only evidence: the guard hook itself is browser-demonstrated, these wirings are not.

const h = vi.hoisted(() => ({ billing: null as unknown }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: () => null }));
vi.mock("../[id]/ConsolidatedReportPanel", () => ({ ConsolidatedReportPanel: () => null }));
vi.mock("../[id]/ProjectWorkspace", () => ({ ProjectWorkspace: () => null }));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => null }));
vi.mock("../actions", () => ({ approveVariationAction: vi.fn(), raiseVariationAction: vi.fn(), rejectVariationAction: vi.fn(), repriceVariationAction: vi.fn(), submitVariationForApprovalAction: vi.fn() }));
vi.mock("../variation-billing-actions", () => ({
  getVariationBillingAction: vi.fn(async () => h.billing), saveVariationScheduleAction: vi.fn(), amendVariationScheduleAction: vi.fn(), startVariationBillingAction: vi.fn(),
}));

import { VariationsPanel } from "../[id]/VariationsPanel";
import { VariationBillingPanel } from "../[id]/VariationBillingPanel";
import * as billingActions from "../variation-billing-actions";

const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const variation = (id: string, status: string) => ({ id, code: id.toUpperCase(), title: `${id} title`, description: "", status, amount_cents: 500_000, decided_by_email: null, decision_reason: null });
const view = (variations: unknown[], projectStatus = "ACTIVE") => ({
  project: { id: "p1", status: projectStatus }, commercial: { originalContractCents: 1, approvedVariationsCents: 0, revisedContractCents: 1 },
  variations, cin7Representation: [],
} as unknown as ProjectView);
const okRun = vi.fn(async () => true);
const input = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, v: string) => fireEvent.change(input(label), { target: { value: v } });

describe("VariationsPanel unsaved guard", () => {
  // the real billing panel is not needed here: the decision controls are rendered by a stand-in that calls renderDecision like the real one does
  async function panel(v: ProjectView, isAdmin = true) {
    h.billing = { ok: true, data: { consolidated: { scopes: [], totals: { contractCents: 0, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 0 }, unbilledApprovedVariations: [], closureBlockers: [] }, schedules: {}, billingProjectByVariation: {}, saleNumberByVariation: {} } };
    const r = render(<VariationsPanel view={v} isAdmin={isAdmin} run={okRun} working={false} />);
    if (v.variations.length) await waitFor(() => expect(billingActions.getVariationBillingAction).toHaveBeenCalled());
    return r;
  }
  it("raise form: untouched is clean, typing guards, clearing releases", async () => {
    await panel(view([]));
    expect(unload()).toBe(false);
    type(/^Title/, "V1");
    expect(unload()).toBe(true);
    type(/^Title/, "");
    expect(unload()).toBe(false);
  });
  it("raise form: a successful raise (fields cleared) releases the guard", async () => {
    await panel(view([]));
    type(/^Title/, "V1"); type(/^Price/, "100");
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Raise draft" }));
    await waitFor(() => expect(unload()).toBe(false));
  });
  it("raise form is not available (so never guards) on a non-ACTIVE project", async () => {
    await panel(view([], "CLOSED"));
    expect(screen.queryByLabelText(/^Title/)).toBeNull();
    expect(unload()).toBe(false);
  });
  it("re-price: typing a new price guards, restoring the current price or clearing releases, success clears", async () => {
    await panel(view([variation("v1", "DRAFT")]));
    expect(unload()).toBe(false);
    type(/Re-price/, "6000");
    expect(unload()).toBe(true);
    type(/Re-price/, "5000"); // equal to the current price (500000 cents): not a change
    expect(unload()).toBe(false);
    type(/Re-price/, "6000");
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Re-price" }));
    await waitFor(() => expect(unload()).toBe(false));
  });
  it("reject reason: typed text guards (manager), clearing/success releases; a non-manager has no reject form and never guards", async () => {
    await panel(view([variation("v1", "DRAFT")]));
    type(/Reject reason/, "too dear");
    expect(unload()).toBe(true);
    type(/Reject reason/, "  ");
    expect(unload()).toBe(false);
    type(/Reject reason/, "too dear");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(unload()).toBe(false));
    cleanup();
    await panel(view([variation("v2", "DRAFT")]), false);
    expect(screen.queryByLabelText(/Reject reason/)).toBeNull();
    expect(unload()).toBe(false);
  });
  it("a decided (APPROVED) variation has no re-price/reject form and never guards", async () => {
    await panel(view([variation("v3", "APPROVED")]));
    expect(screen.queryByLabelText(/Re-price/)).toBeNull();
    expect(unload()).toBe(false);
  });
});

describe("VariationBillingPanel unsaved guard", () => {
  const state = (schedules: Record<string, Array<{ name: string; bps: number }>>, billed: Record<string, string> = {}) =>
    ({ ok: true, data: { consolidated: { scopes: [], totals: { contractCents: 0, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 0 }, unbilledApprovedVariations: [], closureBlockers: [] }, schedules, billingProjectByVariation: billed, saleNumberByVariation: {} } });
  async function billing(v: ProjectView, st: unknown, isAdmin = true) {
    h.billing = st;
    const r = render(<VariationBillingPanel view={v} isAdmin={isAdmin} run={okRun} working={false} />);
    await waitFor(() => expect(screen.getAllByLabelText("Stage").length).toBeGreaterThan(0));
    return r;
  }
  it("schedule rows: changing a stage guards, reverting releases, Save releases once the saved schedule reloads", async () => {
    const saved = [{ name: "Deposit", bps: 5000 }, { name: "Final", bps: 5000 }];
    await billing(view([variation("v1", "DRAFT")]), state({ v1: saved }));
    expect(unload()).toBe(false);
    const first = () => screen.getAllByLabelText("Stage")[0] as HTMLInputElement;
    fireEvent.change(first(), { target: { value: "Advance" } });
    expect(unload()).toBe(true);
    fireEvent.change(first(), { target: { value: "Deposit" } });
    expect(unload()).toBe(false);
    fireEvent.change(screen.getAllByLabelText("%")[0], { target: { value: "60" } });
    fireEvent.change(screen.getAllByLabelText("%")[1], { target: { value: "40" } });
    expect(unload()).toBe(true);
    // Save succeeds; the server now returns the new schedule
    h.billing = state({ v1: [{ name: "Deposit", bps: 6000 }, { name: "Final", bps: 4000 }] });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(unload()).toBe(false));
  });
  it("normalised comparison: \"50.0\" and a padded name equal the saved schedule, so they are not unsaved changes", async () => {
    await billing(view([variation("v1", "DRAFT")]), state({ v1: [{ name: "Deposit", bps: 5000 }, { name: "Final", bps: 5000 }] }));
    fireEvent.change(screen.getAllByLabelText("%")[0], { target: { value: "50.0" } });
    fireEvent.change(screen.getAllByLabelText("Stage")[0], { target: { value: " Deposit " } });
    expect(unload()).toBe(false);
    fireEvent.change(screen.getAllByLabelText("%")[0], { target: { value: "50.5" } });
    expect(unload()).toBe(true);
  });
  it("a value the server normalises differently (25.505 -> 25.51) still releases after Save, because the typed rows are discarded", async () => {
    await billing(view([variation("v1", "DRAFT")]), state({ v1: [{ name: "Deposit", bps: 5000 }, { name: "Final", bps: 5000 }] }));
    fireEvent.change(screen.getAllByLabelText("%")[0], { target: { value: "25.505" } });
    fireEvent.change(screen.getAllByLabelText("%")[1], { target: { value: "74.495" } });
    expect(unload()).toBe(true);
    h.billing = state({ v1: [{ name: "Deposit", bps: 2551 }, { name: "Final", bps: 7449 }] });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(unload()).toBe(false));
    await waitFor(() => expect((screen.getAllByLabelText("%")[0] as HTMLInputElement).value).toBe("25.51"));
  });
  it("Cin7 Sale line: no billing project says billing not started even when the Sale lookup failed", async () => {
    await billing(view([variation("v1", "APPROVED")]), { ok: true, data: { ...(state({ v1: [{ name: "Variation", bps: 10000 }] }) as { data: object }).data, saleLookupFailed: true } });
    expect(screen.getByText("billing not started")).toBeTruthy();
    expect(screen.queryByText(/number unavailable/)).toBeNull();
  });
  it("Add stage guards; Remove last releases", async () => {
    await billing(view([variation("v1", "DRAFT")]), state({ v1: [{ name: "Variation", bps: 10000 }] }));
    fireEvent.click(screen.getByRole("button", { name: "Add stage" }));
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove last" }));
    expect(unload()).toBe(false);
  });
  it("amend reason: typed reason guards a manager's approved variation, clearing/amend releases", async () => {
    await billing(view([variation("v1", "APPROVED")]), state({ v1: [{ name: "Variation", bps: 10000 }] }));
    expect(unload()).toBe(false);
    type(/Reason for amendment/, "client asked");
    expect(unload()).toBe(true);
    type(/Reason for amendment/, "");
    expect(unload()).toBe(false);
    type(/Reason for amendment/, "client asked");
    fireEvent.click(screen.getByRole("button", { name: "Amend schedule" }));
    await waitFor(() => expect(unload()).toBe(false));
  });
  it("read-only never guards: locked approved schedule (billing started) and a non-manager's approved variation", async () => {
    await billing(view([variation("v1", "APPROVED")]), state({ v1: [{ name: "Variation", bps: 10000 }] }, { v1: "bp1" }));
    expect((screen.getAllByLabelText("Stage")[0] as HTMLInputElement).disabled).toBe(true);
    expect(unload()).toBe(false);
    cleanup();
    await billing(view([variation("v2", "APPROVED")]), state({ v2: [{ name: "Variation", bps: 10000 }] }), false);
    expect((screen.getAllByLabelText("Stage")[0] as HTMLInputElement).disabled).toBe(true);
    expect(unload()).toBe(false);
  });
});
