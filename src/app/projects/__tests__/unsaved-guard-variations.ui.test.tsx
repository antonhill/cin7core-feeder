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
  it("after a successful Save the inputs never show the old values and Save is disabled until the reload lands; a failed save keeps rows and guard", async () => {
    const saveAction = vi.mocked(billingActions.saveVariationScheduleAction);
    saveAction.mockResolvedValue({ ok: true } as never);
    const run = vi.fn(async (fn: () => Promise<{ ok: boolean }>) => (await fn()).ok);
    h.billing = state({ v1: [{ name: "Deposit", bps: 5000 }, { name: "Final", bps: 5000 }] });
    render(<VariationBillingPanel view={view([variation("v1", "DRAFT"), variation("v2", "DRAFT")])} isAdmin run={run as never} working={false} />);
    await waitFor(() => expect(screen.getAllByLabelText("Stage").length).toBeGreaterThan(0));
    const pcts = () => (screen.getAllByLabelText("%") as HTMLInputElement[]).map((i) => i.value);
    fireEvent.change(screen.getAllByLabelText("%")[0], { target: { value: "60" } });
    fireEvent.change(screen.getAllByLabelText("%")[1], { target: { value: "40" } });
    let release!: (v: unknown) => void;
    h.billing = new Promise((r) => { release = r; }); // the reload after the save is held open
    const save = () => screen.getAllByRole("button", { name: "Save schedule" })[0] as HTMLButtonElement;
    fireEvent.click(save());
    await waitFor(() => expect(saveAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(save().disabled).toBe(true));
    expect(pcts().slice(0, 2)).toEqual(["60", "40"]); // never the pre-save 50 / 50
    fireEvent.click(save()); // a second click during the reload is inert
    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(unload()).toBe(true); // still unsaved from the user's point of view until the reload confirms
    release(state({ v1: [{ name: "Deposit", bps: 6000 }, { name: "Final", bps: 4000 }] }));
    await waitFor(() => expect(unload()).toBe(false));
    expect(pcts().slice(0, 2)).toEqual(["60", "40"]);
    await waitFor(() => expect(save().disabled).toBe(false));
    // a failed save keeps the rows, the guard and the button
    saveAction.mockResolvedValue({ ok: false, error: "no" } as never);
    fireEvent.change(screen.getAllByLabelText("%")[0], { target: { value: "70" } });
    fireEvent.change(screen.getAllByLabelText("%")[1], { target: { value: "30" } });
    fireEvent.click(save());
    await waitFor(() => expect(saveAction).toHaveBeenCalledTimes(2));
    expect(pcts().slice(0, 2)).toEqual(["70", "30"]);
    expect(unload()).toBe(true);
    expect(save().disabled).toBe(false);
  });
  async function twoVariations(saved: Record<string, Array<{ name: string; bps: number }>>) {
    const saveAction = vi.mocked(billingActions.saveVariationScheduleAction);
    saveAction.mockResolvedValue({ ok: true } as never);
    const run = vi.fn(async (fn: () => Promise<{ ok: boolean }>) => (await fn()).ok);
    h.billing = state(saved);
    render(<VariationBillingPanel view={view([variation("v1", "DRAFT"), variation("v2", "DRAFT")])} isAdmin run={run as never} working={false} />);
    await waitFor(() => expect(screen.getAllByLabelText("Stage").length).toBeGreaterThan(0));
    const pct = (n: number) => screen.getAllByLabelText("%")[n] as HTMLInputElement;
    const save = (n: number) => screen.getAllByRole("button", { name: "Save schedule" })[n] as HTMLButtonElement;
    return { saveAction, pct, save };
  }
  const two = [{ name: "A", bps: 5000 }, { name: "B", bps: 5000 }];
  it("inputs are disabled while the post-save reload is outstanding, so typing cannot be silently dropped", async () => {
    const { pct, save } = await twoVariations({ v1: two, v2: two });
    fireEvent.change(pct(0), { target: { value: "60" } }); fireEvent.change(pct(1), { target: { value: "40" } });
    let release!: (v: unknown) => void;
    h.billing = new Promise((r) => { release = r; });
    fireEvent.click(save(0));
    await waitFor(() => expect(pct(0).disabled).toBe(true));
    expect(pct(2).disabled).toBe(false); // the other variation is untouched
    release(state({ v1: [{ name: "A", bps: 6000 }, { name: "B", bps: 4000 }], v2: two }));
    await waitFor(() => expect(pct(0).disabled).toBe(false));
  });
  it("a REJECTED reload cannot leave the controls stuck: Save re-enables, the rows are kept and labelled, Try again recovers and releases the guard", async () => {
    const { pct, save } = await twoVariations({ v1: two, v2: two });
    fireEvent.change(pct(0), { target: { value: "60" } }); fireEvent.change(pct(1), { target: { value: "40" } });
    h.billing = Promise.reject(new Error("network down")) as never;
    (h.billing as Promise<unknown>).catch(() => {});
    fireEvent.click(save(0));
    await screen.findByText(/could not be reloaded/);
    expect(save(0).disabled).toBe(false);
    expect(pct(0).value).toBe("60");
    expect(unload()).toBe(true); // honest: the shown rows differ from the last loaded schedule
    h.billing = state({ v1: [{ name: "A", bps: 6000 }, { name: "B", bps: 4000 }], v2: two });
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await waitFor(() => expect(screen.queryByText(/could not be reloaded/)).toBeNull());
    await waitFor(() => expect(unload()).toBe(false));
    expect(pct(0).value).toBe("60");
  });
  it("double-save race: an older in-flight fetch landing after a newer save never clears its marker or shows the pre-save schedule", async () => {
    const { pct, save } = await twoVariations({ v1: two, v2: two });
    fireEvent.change(pct(0), { target: { value: "60" } }); fireEvent.change(pct(1), { target: { value: "40" } });
    fireEvent.change(pct(2), { target: { value: "70" } }); fireEvent.change(pct(3), { target: { value: "30" } });
    let relA!: (v: unknown) => void, relB!: (v: unknown) => void;
    h.billing = new Promise((r) => { relA = r; });
    fireEvent.click(save(0));
    await waitFor(() => expect(pct(0).disabled).toBe(true));
    h.billing = new Promise((r) => { relB = r; });
    fireEvent.click(save(1));
    await waitFor(() => expect(pct(2).disabled).toBe(true));
    relA(state({ v1: two, v2: two })); // the OLDER fetch resolves first, with the pre-save data
    await new Promise((r) => setTimeout(r, 20));
    expect(pct(0).disabled).toBe(true); expect(pct(2).disabled).toBe(true); // markers survive
    expect(pct(0).value).toBe("60");
    relB(state({ v1: [{ name: "A", bps: 6000 }, { name: "B", bps: 4000 }], v2: [{ name: "A", bps: 7000 }, { name: "B", bps: 3000 }] }));
    await waitFor(() => expect(pct(0).disabled).toBe(false));
    expect(pct(0).value).toBe("60"); expect(pct(2).value).toBe("70");
    await waitFor(() => expect(unload()).toBe(false));
  });
  it("the busy explanation is announced from a polite live region", async () => {
    const { pct, save } = await twoVariations({ v1: two, v2: two });
    fireEvent.change(pct(0), { target: { value: "60" } }); fireEvent.change(pct(1), { target: { value: "40" } });
    h.billing = new Promise(() => {});
    fireEvent.click(save(0));
    const msg = await screen.findByText(/Reloading the schedule/);
    expect(msg.closest('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
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
