// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import type { ProjectView } from "@/lib/projects/project-view";

// PERF-001 / PERF-002 / PERF-004. The browser runs a client's server actions ONE AT A TIME, and each one costs a full round trip (the Preview logs show 3-5 s apart), so the
// number of actions a page fires when it opens is its load time. This mounts the REAL workspace with its REAL panels and records every server action that fires, in order.
// A few of them also reach Cin7 live; those are named in CIN7_READS and must not fire for a project that does not need them.

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {};
  const stub = () => new Proxy({}, {
    get: (_t, name: string) => {
      if (name === "then" || name === "__esModule") return name === "__esModule" ? true : undefined;
      return (...args: unknown[]) => {
        calls.push(name);
        const r = responses[name];
        return Promise.resolve(typeof r === "function" ? (r as (...a: unknown[]) => unknown)(...args) : r ?? { ok: false, error: "not stubbed" });
      };
    },
    has: () => true,
  });
  return { calls, responses, stub };
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

/** Server actions that read Cin7 live (credentials + paged GETs). */
const CIN7_READS = ["getCin7ReferenceOptionsAction"];

const proj = (data: unknown) => ({ ok: true, data, viewer: { canApprove: true, newquip: true } });
const gates = { orgEnabled: true, isManager: true, writesEnabled: true };
const project = (over: Record<string, unknown> = {}) => ({ id: "p1", project_reference: "PRJ-X", name: "Perf", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 100_000, ...over });
const view = (over: Record<string, unknown> = {}, variations: unknown[] = []): ProjectView => ({
  project: project(over),
  commercial: { originalContractCents: 100_000, approvedVariationsCents: 0, revisedContractCents: 100_000, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 100_000, approvedCompletionBps: 0, scheduleBalanced: true, uncertainClaimBlocking: false },
  stages: [{ id: "s1", name: "Deposit", stageValueCents: 100_000, valueCents: 100_000, claimableCents: 0, remainingCents: 0, reportedBps: 0, approvedBps: 0, committedBps: 0, history: [] }],
  claims: [], allocations: [], variations, openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [],
} as unknown as ProjectView);

const linkedSale = { ok: true, data: { gates, creation: null, linked: true, scopeItems: [], saleLines: [], blockers: [], excluded: [] } };
const unlinkedSale = { ok: true, data: { gates, creation: null, linked: false, scopeItems: [], saleLines: [], blockers: [], excluded: [] } };
const postStatus = { ok: true, data: { gates, link: { id: "l1", cin7_sale_number: "SO-00030", cin7_sale_id: "sale-1" }, linkOrigin: "AUTOMATIC", postings: [] } };
const zero = { contractCents: 0, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 0 };
const billing = { ok: true, data: { consolidated: { scopes: [], totals: zero, unbilledApprovedVariations: [], closureBlockers: [] }, schedules: { v1: [{ name: "Variation", bps: 10_000 }] }, billingProjectByVariation: { v1: "vp1" } } };
// The variation's own billing project, as the embedded workspace loads it.
const variationProject = () => view({ id: "vp1", billing_scope: "VARIATION", parent_project_id: "p1", project_reference: "PRJ-X-V001" });
const approvedVariation = { id: "v1", code: "V001", title: "Extra", status: "APPROVED", amount_cents: 50_000, description: "", created_at: "2026-11-01" };

/** Waits until no further server action has fired for a moment (the mocks answer immediately, so this is the page's own chain). */
async function settled() {
  let last = -1;
  await waitFor(() => { const n = h.calls.length; const stable = n === last; last = n; expect(stable).toBe(true); }, { timeout: 4000, interval: 120 });
}
const count = (name: string) => h.calls.filter((c) => c === name).length;
const report = (label: string) => console.info(`[perf] ${label}: ${h.calls.length} server actions: ${h.calls.join(", ")}`);

beforeEach(() => {
  h.calls.length = 0;
  for (const k of Object.keys(h.responses)) delete h.responses[k];
  Object.assign(h.responses, {
    getViewerPermissionsAction: { ok: true, data: { canApprove: true, newquip: true } },
    getCin7PostingStatusAction: postStatus, getCin7SaleCreationStatusAction: linkedSale,
    getCin7ReferenceOptionsAction: { ok: true, data: { locations: ["MSTR"], accounts: [] } },
    getVariationBillingAction: billing,
    // The Commercial boot answers from the same data without calling the other stubs, so it is ONE recorded call.
    getCommercialBootAction: () => ({ ok: true, data: { creation: (h.responses.getCin7SaleCreationStatusAction as { data: unknown }).data, posting: (h.responses.getCin7PostingStatusAction as { data: unknown }).data } }),
  });
});
afterEach(() => cleanup());

const names = () => [...h.calls];

describe("what a Project fires when it opens", () => {
  it("opening a Project on its default tab: the project (with the viewer's permissions) and the overview", async () => {
    h.responses.getProjectAction = proj(view());
    render(<ProjectWorkspace id="p1" />);
    await screen.findByRole("button", { name: /Commercial \/ Claims/ });
    await settled();
    report("open Project");
    expect(names()).toEqual(["getProjectAction", "getProjectOverviewDataAction"]);
  });

  it("opening Commercial / Claims on a Project whose Cin7 Sale is already linked: one Sale + invoice read, and nothing live from Cin7", async () => {
    h.responses.getProjectAction = proj(view());
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    await settled();
    report("Commercial / Claims, Sale linked");
    expect(h.calls.filter((c) => CIN7_READS.includes(c))).toEqual([]);
    expect(names()).toEqual(["getProjectAction", "getProjectOverviewDataAction", "getCommercialBootAction", "getDeliveryRegisterAction"]);
  });

  it("leaving Commercial / Claims and coming back does not read it all again", async () => {
    h.responses.getProjectAction = proj(view());
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /^Stages/ }));
    await settled();
    const before = count("getCommercialBootAction");
    fireEvent.click(screen.getByRole("button", { name: /Commercial \/ Claims/ }));
    await settled();
    report("back to Commercial / Claims");
    expect(count("getCommercialBootAction")).toBe(before);
    expect(screen.queryByTestId("commercial-loading")).toBeNull(); // the Sale and invoice panels are on screen straight away
  });

  it("the Create-Sale form still gets the Cin7 location and account lists, once, when it is actually shown", async () => {
    h.responses.getProjectAction = proj(view());
    h.responses.getCin7SaleCreationStatusAction = unlinkedSale;
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    await screen.findByText("Create the Cin7 Sales Order");
    await settled();
    report("Commercial / Claims, Sale NOT linked");
    expect(count("getCin7ReferenceOptionsAction")).toBe(1);
    await waitFor(() => expect(screen.getByLabelText("Cin7 location").tagName).toBe("SELECT")); // the list reached the form
  });

  it("a Commercial tab that is still loading reserves its space and says so", async () => {
    h.responses.getProjectAction = proj(view());
    h.responses.getCommercialBootAction = () => new Promise(() => undefined); // never answers
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    const slot = await screen.findByTestId("commercial-loading");
    expect(slot.getAttribute("role")).toBe("status");
    expect(slot.className).toMatch(/min-h-/);
  });

  it("opening Variations: the permission read is not repeated for the variation's own workspace", async () => {
    h.responses.getProjectAction = (id: string) => proj(id === "vp1" ? variationProject() : view({}, [approvedVariation]));
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Variations/ }));
    await screen.findByText(/V001 billing workspace/);
    await settled();
    report("Variations tab, one billed variation");
    expect(names()).toEqual(["getProjectAction", "getProjectOverviewDataAction", "getVariationBillingAction", "getProjectAction"]);
    expect(count("getViewerPermissionsAction")).toBe(0);
  });

  it("opening the variation's Commercial / Claims: one Sale + invoice read, no live Cin7 read, no permission read", async () => {
    h.responses.getProjectAction = (id: string) => proj(id === "vp1" ? variationProject() : view({}, [approvedVariation]));
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Variations/ }));
    await screen.findByText(/V001 billing workspace/);
    await settled();
    const before = h.calls.length;
    const tabs = await screen.findAllByRole("button", { name: /Commercial \/ Claims/ });
    fireEvent.click(tabs[tabs.length - 1]); // the one inside the variation's workspace
    await settled();
    const mine = h.calls.slice(before);
    console.info(`[perf] variation workspace, Commercial / Claims: ${mine.length} server actions: ${mine.join(", ")}`);
    expect(mine.filter((c) => CIN7_READS.includes(c))).toEqual([]);
    expect(mine).toEqual(["getCommercialBootAction"]);
  });
  it("while the project loads, the page already shows its structure and says what it is waiting for", async () => {
    h.responses.getProjectAction = () => new Promise(() => undefined); // never answers
    render(<ProjectWorkspace id="p1" />);
    const slot = await screen.findByTestId("workspace-loading");
    expect(slot.getAttribute("role")).toBe("status");
    expect(slot.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading project…")).toBeTruthy(); // the header
    expect(slot.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(6); // summary cards, tab bar and body keep their space
  });
});
