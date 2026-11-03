// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import type { ProjectView } from "@/lib/projects/project-view";

// UX-006 f: claims stepper, nothing-claimable hint, milestone line, variation Next line, unsaved guards. The REAL workspace; only server actions are stubbed.

const h = vi.hoisted(() => {
  const responses: Record<string, unknown> = {};
  const stub = () => new Proxy({}, { get: (_t, name: string) => (name === "then" ? undefined : name === "__esModule" ? true : (...a: unknown[]) => { const r = responses[name]; return Promise.resolve(typeof r === "function" ? (r as (...x: unknown[]) => unknown)(...a) : r ?? { ok: false, error: "not stubbed" }); }), has: () => true });
  return { responses, stub };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: () => null }));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => null }));
vi.mock("../actions", () => h.stub());
vi.mock("../cin7-actions", () => h.stub());
vi.mock("../delivery-actions", () => h.stub());
vi.mock("../variation-billing-actions", () => h.stub());
vi.mock("../overview-actions", () => h.stub());
vi.mock("../physical-actions", () => h.stub());
vi.mock("../procurement-actions", () => h.stub());
vi.mock("../profitability-actions", () => h.stub());
const gates = { orgEnabled: true, isManager: true, writesEnabled: false };
const stage = (over: Record<string, unknown> = {}) => ({ id: "s1", name: "Deposit", stageValueCents: 100_000_00, valueCents: 100_000_00, claimableCents: 0, remainingCents: 100_000_00, reportedBps: 0, approvedBps: 0, committedBps: 0, committedCents: 0, history: [], ...over });
const claimRow = (id: string, n: string, status: string) => ({ id, claim_number: n, claim_date: "2026-11-01", supersedes_claim_id: null, total_cents: 11_500_00, subtotal_cents: 10_000_00, tax_cents: 1_500_00, status, reserves: status !== "DRAFT", cin7Status: { kind: "NOT_POSTED", tone: "neutral", label: "Not sent to Cin7", invoiceNumber: null, reconciled: false, detail: null }, approval: null });
const view = (stages: unknown[], claims: unknown[] = [], variations: unknown[] = [], c: Record<string, unknown> = {}): ProjectView => ({
  project: { id: "p1", project_reference: "PRJ-X", name: "Stepper", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 100_000_00 },
  commercial: { originalContractCents: 100_000_00, approvedVariationsCents: 0, revisedContractCents: 100_000_00, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 100_000_00, approvedCompletionBps: 0, scheduleBalanced: true, uncertainClaimBlocking: false, ...c },
  stages, claims, allocations: [], variations, openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [],
} as unknown as ProjectView);
const preview = { ok: true, data: { claimNumber: "PRJ-X-C01", taxRateBps: 1500, calc: { subtotalCents: 10_000_00, taxCents: 1_500_00, totalCents: 11_500_00, lines: [{ stageId: "s1", stageName: "Deposit", stageValueCents: 100_000_00, approvedBps: 10000, earnedToDateCents: 100_000_00, previouslyBilledCents: 0, previouslyBilledBps: 0, currentClaimCents: 10_000_00 }] } } };
const boot = { ok: true, data: { creation: { gates, creation: null, linked: true, scopeItems: [], saleLines: [], blockers: [], excluded: [] }, posting: { gates, link: null, linkOrigin: "AUTOMATIC", postings: [] } } };

function setup(v: () => ProjectView, admin = true) {
  h.responses.getProjectAction = () => ({ ok: true, data: v(), viewer: { canApprove: admin, newquip: true } });
  h.responses.getCommercialBootAction = boot;
  h.responses.getDeliveryRegisterAction = { ok: true, data: { register: { deliveries: [], allocations: [], positions: [], invoicedAgainstDelivery: {} }, confirmations: [] } };
}
beforeEach(() => { for (const k of Object.keys(h.responses)) delete h.responses[k]; });
beforeEach(() => { window.scrollTo = vi.fn() as unknown as typeof window.scrollTo; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openTab(name: RegExp) { render(<ProjectWorkspace id="p1" />); fireEvent.click(await screen.findByRole("button", { name })); }
const steps = () => Array.from(document.querySelectorAll("ol[aria-label='Claim steps'] li")).map((li) => (li as HTMLElement).dataset.status);
const stepper = () => document.querySelector("ol[aria-label='Claim steps']") as HTMLElement;

describe("Claim stepper", () => {
  it("is an ordered list with aria-current on the next step, and walks select -> preview -> save from state only", async () => {
    let v = view([stage({ claimableCents: 10_000_00, approvedBps: 10000, remainingCents: 100_000_00 })]);
    setup(() => v);
    h.responses.previewClaimAction = preview;
    h.responses.createClaimDraftAction = () => { v = view(v.stages as unknown[], [claimRow("c1", "PRJ-X-C01", "DRAFT")]); return { ok: true, data: null }; };
    await openTab(/Commercial \/ Claims/);
    await screen.findByText("Create progress claim");
    expect(stepper().tagName).toBe("OL");
    expect(steps()).toEqual(["next", "todo", "todo", "todo"]);
    expect(stepper().querySelector("[aria-current='step']")!.getAttribute("data-step")).toBe("select");
    // same disabled reason copy as before
    expect(screen.getByText("Preview claim is disabled until you tick at least one billing stage above.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(steps()).toEqual(["done", "next", "todo", "todo"]);
    fireEvent.click(screen.getByRole("button", { name: "Preview claim" }));
    await waitFor(() => expect(steps()).toEqual(["done", "done", "next", "todo"]), { timeout: 8000 });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft claim" }));
    await waitFor(() => expect(steps()).toEqual(["done", "done", "done", "next"]), { timeout: 8000 });
    expect(stepper().textContent).toContain("Use Submit on the draft above");
  });
  it("visiting a step never completes it: an untouched form stays at step 1 after the tab is revisited", async () => {
    setup(() => view([stage({ claimableCents: 10_000_00, approvedBps: 10000 })]));
    await openTab(/Commercial \/ Claims/);
    await screen.findByText("Create progress claim");
    fireEvent.click(screen.getByRole("button", { name: /^Stages/ }));
    fireEvent.click(screen.getByRole("button", { name: /Commercial \/ Claims/ }));
    await screen.findByText("Create progress claim");
    expect(steps()).toEqual(["next", "todo", "todo", "todo"]);
  });
});

describe("Nothing-claimable hint", () => {
  it("says why (no approved progress), role-aware, and opens the Stages tab", async () => {
    setup(() => view([stage()]));
    await openTab(/Commercial \/ Claims/);
    const hint = await screen.findByTestId("nothing-claimable");
    expect(hint.textContent).toContain("No stage has approved commercial progress. Use Approve commercial progress");
    fireEvent.click(within(hint).getByRole("button", { name: "Open the Stages tab" }));
    expect(await screen.findByText("Update progress by stage")).toBeTruthy();
  });
  it("a member is told an owner or admin must approve", async () => {
    setup(() => view([stage()]), false);
    await openTab(/Commercial \/ Claims/);
    expect((await screen.findByTestId("nothing-claimable")).textContent).toContain("An owner or admin must approve it");
  });
  it("names an unbalanced schedule and an uncertain claim; absent when something is claimable", async () => {
    setup(() => view([stage()], [], [], { scheduleBalanced: false, uncertainClaimBlocking: true }));
    await openTab(/Commercial \/ Claims/);
    const t = (await screen.findByTestId("nothing-claimable")).textContent!;
    expect(t).toContain("do not reconcile");
    expect(t).toContain("uncertain Cin7 outcome");
    cleanup();
    setup(() => view([stage({ claimableCents: 5, approvedBps: 5000 })]));
    await openTab(/Commercial \/ Claims/);
    await screen.findByText("Create progress claim");
    expect(screen.queryByTestId("nothing-claimable")).toBeNull();
  });
});

describe("Milestone confirmation line and unsaved guards", () => {
  it("states that confirmation is evidence only and Approve commercial progress makes value claimable", async () => {
    setup(() => view([stage()]));
    await openTab(/Commercial \/ Claims/);
    const p = await screen.findByText(/A confirmation is evidence only/);
    expect(p.textContent).toMatch(/changes no approved percentage and no claimable amount/);
    expect(p.textContent).toMatch(/Approve commercial progress/);
  });
  it("typing a milestone note arms the unsaved guard; clearing it releases it", async () => {
    const add = vi.spyOn(window, "addEventListener");
    setup(() => view([stage()]));
    await openTab(/Commercial \/ Claims/);
    const box = await screen.findByLabelText("What was confirmed");
    const armed = () => add.mock.calls.filter(([t]) => t === "beforeunload").length;
    const before = armed();
    fireEvent.change(box, { target: { value: "Delivered" } });
    await waitFor(() => expect(armed()).toBe(before + 1));
    const remove = vi.spyOn(window, "removeEventListener");
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(remove.mock.calls.some(([t]) => t === "beforeunload")).toBe(true));
  });
  it("the stage progress form arms the guard on a typed comment or changed percentage, and not when merely opened", async () => {
    const add = vi.spyOn(window, "addEventListener");
    setup(() => view([stage({ reportedBps: 1000 })]));
    await openTab(/^Stages/);
    const armed = () => add.mock.calls.filter(([t]) => t === "beforeunload").length;
    fireEvent.click(await screen.findByRole("button", { name: "Update progress" }));
    const before = armed();
    expect(before).toBe(0);
    fireEvent.change(screen.getByLabelText(/Comment \/ reason/), { target: { value: "site visit" } });
    await waitFor(() => expect(armed()).toBe(1));
  });
  it("changing the physical percentage alone arms the guard", async () => {
    const add = vi.spyOn(window, "addEventListener");
    setup(() => view([stage({ reportedBps: 1000 })]));
    await openTab(/^Stages/);
    fireEvent.click(await screen.findByRole("button", { name: "Update progress" }));
    fireEvent.change(screen.getByLabelText(/Physical completion/), { target: { value: "55" } });
    await waitFor(() => expect(add.mock.calls.filter(([t]) => t === "beforeunload").length).toBe(1));
  });
});

describe("Variation Next line", () => {
  const variation = (id: string, code: string, status: string) => ({ id, code, title: `${code} t`, description: "d", status, amount_cents: 50_000_00, raised_by_email: "e@x", priced_by_email: null, decided_by_email: null, decision_reason: null, created_at: "2026-11-01T00:00:00Z" });
  const billing = (billed: Record<string, string>) => ({ ok: true, data: { consolidated: { scopes: [], totals: { contractCents: 0, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 0 }, unbilledApprovedVariations: [], closureBlockers: [] }, schedules: { v1: [{ name: "Variation", bps: 10_000 }], v2: [{ name: "Variation", bps: 10_000 }] }, billingProjectByVariation: billed, saleNumberByVariation: {}, saleLookupFailed: false, reconciliationByVariation: {}, reconciliationLookupFailed: false } });
  it("each variation says what is next, role-aware", async () => {
    setup(() => view([stage()], [], [variation("v1", "V001", "DRAFT"), variation("v2", "V002", "APPROVED")]), false);
    h.responses.getVariationBillingAction = billing({});
    await openTab(/^Variations/);
    expect((await screen.findByTestId("next-v1")).textContent).toMatch(/^Next: Submit it for approval.*a manager must approve/);
    await waitFor(() => expect(screen.getByTestId("next-v2").textContent).toMatch(/A manager checks the schedule and starts variation billing/));
  });
  it("an admin is told they can start billing", async () => {
    setup(() => view([stage()], [], [variation("v2", "V002", "APPROVED")]), true);
    h.responses.getVariationBillingAction = billing({});
    await openTab(/^Variations/);
    await waitFor(() => expect(screen.getByTestId("next-v2").textContent).toMatch(/Start variation billing/));
  });
});
