// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { emptyDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import * as ca from "../customer-actions";
import { deliveryViewOf, documentsViewOf } from "../page-reads";

// FOUR-PHASE UX (project quotations), rendered through the REAL page: ONE shared header and phase line on every phase; Phase 1 for a reader is a read-only summary (never the Rep's form); Phase 3 is one decision
// screen; Phase 4 has an at-a-glance status over the existing steps. Roles, gates and server actions are the existing ones.
let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("../page-reads", () => ({ deliveryViewOf: vi.fn(), documentsViewOf: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("../[id]/DeliveryPanel", () => ({ DeliveryPanel: () => null }));
vi.mock("../[id]/AcceptancePanel", () => ({ AcceptancePanel: () => null }));
vi.mock("../[id]/CustomerPanel", () => ({ CustomerPanel: (p: { onFacts?: (f: any) => void }) => { p.onFacts?.({ loaded: true, available: true, hasSnapshot: true, snapshotId: "s1", contactSelected: true, contactEmail: "a@b.co", currency: "ZAR", issues: [] }); return null; } }));

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
type Role = "REP" | "ESTIMATOR" | "MANAGER";
const g = globalThis as { __QID?: string; __SEARCH?: string };
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: g.__QID }),
  useSearchParams: () => new URLSearchParams(g.__SEARCH ?? ""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(deliveryViewOf).mockResolvedValue({ available: true, requiresAcceptance: true, accepted: false, status: "APPROVED_INTERNALLY", latestDocumentId: null, links: { state: "NONE" } } as any);
  vi.mocked(documentsViewOf).mockResolvedValue({ available: true, documents: [], blockers: [], canIssue: false } as any);
  try { window.localStorage.clear(); } catch { /* storage unavailable */ }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (id: string) => db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, any>;
const SUBMITTED = (r: Record<string, any>) => { Object.assign(r, { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq" }); };
const RETURNED = (r: Record<string, any>) => { r.state = "REP_DRAFT"; r.revision = 2; };
const FINAL = (r: Record<string, any>) => { Object.assign(r, { state: "MANAGER_APPROVED_FINAL", requires_customer_acceptance: true, accepted_baseline: { contractCents: 1000000, internalMargin: null, template: { name: "Grower", version: "1", rulesetVersion: "1" }, quote: { revision: 1 }, pricing: { source: { label: "x" }, basis: "x" }, overrides: [], exclusions: [], priceResolutions: [], exceptions: [] } }); };

async function openQuote(o: { roles: Role[]; commercials: boolean; search: string; patch: (r: Record<string, any>) => void; waitFor: string }) {
  g.__SEARCH = o.search;
  vi.mocked(resolveRoles).mockResolvedValue(new Set(o.roles) as never);
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials);
  vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: { available: true, snapshot: null, snapshotId: null, seq: null, issues: [], currency: null, selectedContactIndex: null } } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...emptyDraft(), ...readyDraft(), quoteType: "project", customerName: "Acme Pigs", siteName: "Farm 1" } as any);
  o.patch(row(id));
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await screen.findByTestId(o.waitFor, {}, { timeout: 15000 });
  return id;
}
const LEAK = /Landed|Freight|markup|Supplier cost|Fixture supplier|Estimated cost|Cin7 latest cost/i;

describe("every phase carries the same header and phase line", () => {
  for (const [label, search, roles, patch, wait] of [
    ["Phase 1 (Rep)", "stage=1", ["REP"], SUBMITTED, "step-rail"],
    ["Phase 1 (Estimator, read-only)", "stage=1", ["ESTIMATOR"], SUBMITTED, "phase1-readonly"],
    ["Phase 3 (Manager)", "stage=3", ["MANAGER"], SUBMITTED, "manager-decision"],
    ["Phase 4", "stage=4", ["MANAGER"], FINAL, "handover-overview"],
  ] as Array<[string, string, Role[], (r: Record<string, any>) => void, string]>) {
    it(`${label}: one compact header, one four-phase line with the current phase marked, no old stage strips`, async () => {
      await openQuote({ roles, commercials: roles[0] !== "REP", search, patch, waitFor: wait });
      expect(screen.getAllByTestId("phase-header")).toHaveLength(1);
      const nav = screen.getByTestId("phase-stepper");
      expect(nav.querySelectorAll("[data-phase]")).toHaveLength(4);
      expect(nav.querySelector('[aria-current="step"]')).toBeTruthy();
      expect(screen.queryByTestId("stage-nav-toggle")).toBeNull();
      expect(screen.queryByTestId("quote-summary-bar")).toBeNull();
      expect(screen.getByTestId("phase-header-status").textContent).toBeTruthy();
    }, 60000);
  }
});

describe("Phase 1 for the Estimator and Manager is a read-only summary", () => {
  it("shows the included products with selling amounts and the selling totals, with no editable form, no Rep actions and no supplier or cost data", async () => {
    await openQuote({ roles: ["ESTIMATOR"], commercials: true, search: "stage=1", patch: SUBMITTED, waitFor: "phase1-readonly" });
    expect(screen.queryByTestId("step-rail")).toBeNull();
    expect(screen.queryByTestId("stage1-layout")).toBeNull();
    expect(within(screen.getByTestId("phase1-lines")).getAllByRole("row").length).toBeGreaterThan(1);
    expect(screen.getByTestId("phase1-customer").textContent).toContain("Acme Pigs");
    expect(screen.getByTestId("phase1-total-ex").textContent).toMatch(/^R\u00a0[\d\u00a0]+,\d\d$/); // the application's one South African money presentation
    expect(screen.getByTestId("phase1-status").textContent).toMatch(/Submitted by the Rep/);
    expect(document.querySelectorAll("main input, main textarea").length).toBe(0);
    for (const name of [/Save draft/, /Submit to Estimator/, /Load sample/, /Load whole demonstration/]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(document.body.textContent).not.toMatch(LEAK);
  }, 60000);

  it("a Manager reads it too and can go straight to the approval decision", async () => {
    await openQuote({ roles: ["MANAGER"], commercials: true, search: "stage=1", patch: SUBMITTED, waitFor: "phase1-readonly" });
    fireEvent.click(screen.getByTestId("phase1-next"));
    await screen.findByTestId("manager-decision");
    expect(screen.queryByTestId("phase1-readonly")).toBeNull();
  }, 60000);

  it("a returned quotation says it is waiting for the Rep, not for the reader", async () => {
    await openQuote({ roles: ["ESTIMATOR"], commercials: true, search: "stage=1", patch: RETURNED, waitFor: "phase1-readonly" });
    expect(screen.getByTestId("phase1-status").textContent).toMatch(/Returned to the Rep \(revision 2\)/);
    expect(screen.getAllByTestId("next-action")).toHaveLength(1); // the action is in the ONE Next action bar, not repeated in the card
    expect(screen.getByTestId("next-action-headline").textContent!.length).toBeGreaterThan(5);
  }, 60000);
});

describe("Phase 1 for a Rep on a returned quotation leads with reconfirming the selling price", () => {
  it("shows the prominent reconfirm steps (one banner, with the amount sentence the Rep already had)", async () => {
    await openQuote({ roles: ["REP"], commercials: false, search: "stage=1&step=1", patch: RETURNED, waitFor: "returned-banner" });
    expect(screen.getByTestId("returned-banner").textContent).toMatch(/Returned to the Rep \(revision 2\)/);
    expect(screen.getAllByTestId("next-action")).toHaveLength(1);
    expect(screen.getByTestId("next-action-headline").textContent).toMatch(/Rep/);
    expect(document.body.textContent).not.toMatch(LEAK);
  }, 60000);
});

describe("Phase 3 is one decision screen", () => {
  it("a Manager sees totals, supplier-cost verification, margin, the sign-off state and what is outstanding, then the existing approve and return controls", async () => {
    await openQuote({ roles: ["MANAGER"], commercials: true, search: "stage=3", patch: SUBMITTED, waitFor: "manager-decision" });
    for (const id of ["decision-status", "decision-totals", "decision-verification", "decision-margin", "decision-signoff", "decision-open"]) expect(screen.getByTestId(id), id).toBeTruthy();
    expect(screen.getByTestId("decision-totals").textContent).toMatch(/R\u00a0[\d\u00a0]+,\d\d.*ex VAT.*VAT R\u00a0[\d\u00a0]+,\d\d.*inc VAT R\u00a0[\d\u00a0]+,\d\d/);
    expect(screen.getByTestId("decision-signoff").textContent).toMatch(/Not signed off yet/);
    expect(screen.getByTestId("decision-margin").textContent).toMatch(/Not verified/); // supplier costing is off here: the price-list margin is never presented as a verified result
    expect(screen.getByTestId("decision-margin").textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy(); // the existing gate (disabled until it is satisfied)
    expect(screen.queryByTestId("stage3-owner")).toBeNull();
    expect(screen.getByTestId("decision-supporting").tagName).toBe("DETAILS"); // the Estimator result, evidence and Rep submission stay available, collapsed
  }, 60000);

  it("a Rep previewing it sees no margin and no verification detail", async () => {
    await openQuote({ roles: ["REP"], commercials: false, search: "stage=3", patch: SUBMITTED, waitFor: "manager-decision" });
    expect(screen.queryByTestId("decision-margin")).toBeNull();
    expect(screen.getByTestId("decision-verification").textContent).toMatch(/Not applicable/);
    expect(document.body.textContent).not.toMatch(LEAK);
  }, 60000);
});

describe("Phase 4 shows its status at a glance and keeps its three steps reachable", () => {
  it("an approved quotation: approved, document, acceptance, handover and Cin7 tiles; Cin7 is reported as not sent", async () => {
    await openQuote({ roles: ["MANAGER"], commercials: true, search: "stage=4", patch: FINAL, waitFor: "handover-overview" });
    for (const id of ["approved", "document", "acceptance", "handover"]) expect(screen.getByTestId(`overview-${id}`), id).toBeTruthy();
    expect(screen.getAllByTestId(/^overview-/)).toHaveLength(4); // four tiles: one row on a desktop, never an orphan
    expect(screen.getByTestId("overview-approved").textContent).toContain("Approved");
    expect(screen.getByTestId("overview-handover").textContent).toMatch(/Nothing is sent to Cin7 from here/);
    const steps = screen.getByTestId("phase4-substeps");
    expect(within(steps).getAllByRole("button").map((b) => b.textContent)).toEqual(["Customer quotation", "Customer acceptance", "Project handover"]);
    fireEvent.click(within(steps).getByRole("button", { name: "Project handover" }));
    await waitFor(() => expect(screen.getByTestId("stage6-next")).toBeTruthy());
  }, 60000);

  it("an unapproved quotation does not pretend: every downstream tile waits", async () => {
    await openQuote({ roles: ["MANAGER"], commercials: true, search: "stage=4", patch: SUBMITTED, waitFor: "handover-overview" });
    expect(screen.getByTestId("overview-approved").textContent).toContain("Not approved yet");
    expect(screen.getByTestId("overview-document").textContent).toContain("Not available yet");
    expect(screen.getByTestId("overview-handover").textContent).toContain("Not ready");
  }, 60000);
});

describe("final presentation pass", () => {
  it("a returned Rep quotation opens ONLY on the active step even when Show all steps is remembered; the Rep can still open them all for this visit", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => undefined }); // Show all steps is remembered as ON
    await openQuote({ roles: ["REP"], commercials: false, search: "stage=1", patch: RETURNED, waitFor: "returned-banner" });
    const panel = (id: string) => document.querySelector(`[data-step-panel="${id}"]`) as HTMLElement;
    const active = document.querySelector('[data-testid="step-rail"] [aria-current="step"]')!.getAttribute("data-step")!;
    await waitFor(() => expect(panel(active).hasAttribute("hidden")).toBe(false));
    const others = ["customer", "site", "equipment", "review", "submit"].filter((x) => x !== active);
    for (const id of others) expect(panel(id).hasAttribute("hidden"), id).toBe(true); // ONE form, not five
    fireEvent.click(screen.getByRole("checkbox", { name: /Show all steps/ }));
    await waitFor(() => { for (const id of others) expect(panel(id).hasAttribute("hidden"), id).toBe(false); });
  }, 60000);

  it("exactly one Next action per phase screen, and the badge describes THAT phase (Phase 4 never says 'returned to the Rep')", async () => {
    await openQuote({ roles: ["ESTIMATOR"], commercials: true, search: "stage=4", patch: RETURNED, waitFor: "handover-overview" });
    expect(screen.getAllByTestId("next-action")).toHaveLength(1);
    expect(screen.getByTestId("phase-header-status").textContent).toBe("NOT APPROVED YET");
  }, 60000);

  it("the Manager's decision badge says what the decision waits for", async () => {
    await openQuote({ roles: ["MANAGER"], commercials: true, search: "stage=3", patch: SUBMITTED, waitFor: "manager-decision" });
    expect(screen.getByTestId("phase-header-status").textContent).toBe("AWAITING ESTIMATOR SIGN-OFF");
    expect(screen.getAllByTestId("next-action")).toHaveLength(1);
    expect(screen.getByTestId("decision-status").textContent).not.toMatch(/Next/); // a state, not a second instruction
  }, 60000);

  it("the supporting-detail heading is neutral for a role that cannot see costs", async () => {
    await openQuote({ roles: ["REP"], commercials: false, search: "stage=3", patch: SUBMITTED, waitFor: "manager-decision" });
    expect(screen.getByTestId("decision-supporting").textContent).toContain("Supporting detail: Rep submission and sign-off");
    expect(screen.getByTestId("decision-supporting").querySelector("summary")!.textContent).not.toMatch(/evidence|cost|margin/i);
  }, 60000);

  it("the Rep's Phase 2 note carries no second next action", async () => {
    await openQuote({ roles: ["REP"], commercials: false, search: "stage=2", patch: SUBMITTED, waitFor: "phase2-readonly" });
    expect(screen.getAllByTestId("next-action")).toHaveLength(1);
    expect(screen.getByTestId("phase2-readonly").textContent).not.toMatch(/Next responsible role/);
  }, 60000);
});
