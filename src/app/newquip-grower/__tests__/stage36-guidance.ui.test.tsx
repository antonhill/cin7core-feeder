// @vitest-environment jsdom
import * as da from "../delivery-actions";
import * as actions from "../actions";
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

// UX-006c, rendered through the REAL page (Stages 3-6) with the owner's real quote shape. Mocked: the session/auth and the two customer-delivery reads (the issued documents and the
// sends/responses), whose views the tests choose. Nothing is written.

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn(), rolesAvailable: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("../delivery-actions", () => ({
  getQuoteDeliveryAction: vi.fn(async () => ({ ok: true, data: (globalThis as { __DELIVERY?: unknown }).__DELIVERY })),
  sendQuoteToCustomerAction: vi.fn(), retryQuoteSendAction: vi.fn(), recordCustomerResponseAction: vi.fn(), reviewCustomerResponseAction: vi.fn(), revokeResponseLinksAction: vi.fn(),
}));
vi.mock("../document-actions", () => ({
  getQuoteDocumentsAction: vi.fn(async () => ({ ok: true, data: (globalThis as { __DOCS?: unknown }).__DOCS })),
  issueQuoteDocumentAction: vi.fn(),
}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
  (globalThis as { __STEP?: string }).__STEP = undefined;
});


vi.mock("next/navigation", () => ({
  useParams: () => ({ id: (globalThis as { __QID?: string }).__QID }),
  useSearchParams: () => new URLSearchParams("stage=" + ((globalThis as { __STAGE?: string }).__STAGE ?? "2") + ((globalThis as { __STEP?: string }).__STEP ? `&step=${(globalThis as { __STEP?: string }).__STEP}` : "")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const config = {"rooms":12,"widthM":14.43,"lengthM":49.5,"totalPens":20,"pigsPerRoom":600,"hospitalPens":2,"feederVariant":"STANDARD","penningPigSize":"SMALL","optionalEquipment":{"cone_fans":false,"controller":true,"manure_plug":false,"pad_cooling":false,"control_panel":false,"silo_weighing":false,"emergency_windows":false},"quantityOverrides":{"led_light":38,"feed_saver_mat":18},"selectedFeederType":"CCM","slattedFloorAreaM2":120,"estimatorQuantities":{"feeder":18,"pvc_door":2,"bulk_tank":1,"cone_fans":4,"controller":2,"flex_auger":1,"cup_drinker":54,"manure_plug":2,"pad_cooling":3,"concrete_slat":1320,"control_panel":2,"silo_weighing":2,"emergency_windows":2},"selectedDrinkerType":"CUP_NEW","selectedPenningType":"PP_GREEN_VENTED","selectedFlooringType":"CONCRETE_1200X450X70","selectedLightingType":"FORTIS_1_2_5000K","quantityOverrideReasons":{"led_light":"Test","feed_saver_mat":"Test"},"penningRunningMetresPerRoom":20};
const pr = (p: number) => ({ at: "t", by: "x", reason: "Master workbook has no usable price. Temporary POC estimator value only.", unitPriceExVat: p });
const draft: any = { ...emptyDraft(), quoteType: "day_to_day", config: { ...config, exclusions: { pvc_door: "Not needed" } },
  estimator: { ...emptyDraft().estimator, confirmedMappings: {"feeder":"PNQ082","pvc_door":"NQ2114","bulk_tank":"SYSH-2750-3","controller":"HO05084000","concrete_slat":"NQ1161","feed_saver_mat":"ERT053"}, confirmedPackages: ["cup_drinker","led_light"], charges: {"delivery":979992,"installation":1200000,"concrete_slat_delivery":250000}, unitPrices: {"flex_auger":45000}, priceResolutions: {pvc_door:pr(3000),led_light:pr(881),controller:pr(3000),cup_drinker:pr(548),concrete_slat:pr(203),feed_saver_mat:pr(919)} } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); try { window.localStorage.clear(); } catch { /* the "Show all steps" preference must not leak between tests */ } });


const g = globalThis as { __QID?: string; __STAGE?: string; __STEP?: string; __DELIVERY?: unknown; __DOCS?: unknown };
type Role = "REP" | "ESTIMATOR" | "MANAGER";
const delivery = (o: Record<string, unknown> = {}) => ({ available: true, status: "APPROVED_INTERNALLY", statusLabel: "Approved", requiresAcceptance: true, accepted: false, latestDocumentId: null, defaultTo: "c@farm.co", sends: [], responses: [], canSend: true, canRecord: true, portal: true, responseContacts: [], deliveryContact: null, canReview: true, links: { state: "NONE", expiresOn: null }, contactEmails: [], policy: { restricted: true, production: false, allowlist: ["a@b.co"], emailConfigured: true, productionEmailOff: false }, ...o });
const docs = (n: number) => ({ available: true, documents: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, revision: 1, version: i + 1, issuedAt: "2026-01-01T08:00:00Z", issuedBy: "rep@nq", byteSize: 2048, contentHash: "abcdef1234567890" })), blockers: [], canIssue: true });
const baseline = { contractCents: 1_000_000, template: { name: "Grower House", version: "1", rulesetVersion: "r1" }, quote: { revision: 1 }, pricing: { source: { label: "Master" }, basis: "ex VAT" }, overrides: [], exclusions: [], priceResolutions: [] };

/** Opens `stage` of a saved quote with the given row state. */
async function open(o: { stage: string; step?: string; roles?: Role[]; state?: string; row?: Record<string, unknown>; delivery?: unknown; docs?: unknown; wait?: string } = { stage: "3" }) {
  g.__STAGE = o.stage; g.__STEP = o.step; g.__DELIVERY = o.delivery ?? delivery(); g.__DOCS = o.docs ?? docs(0);
  asRoles(...(o.roles ?? ["REP"]));
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...draft, customerName: "Acme Pigs", siteName: "Farm 1" });
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { if (o.state) row.state = o.state; Object.assign(row, o.row ?? {}); if (row.estimator_signoff_hash === "CURRENT") row.estimator_signoff_hash = row.draft_hash; }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("stage-nav")).toBeTruthy(), { timeout: 8000 });
}
const FINAL = { state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline, baseline_hash: "x", requires_customer_acceptance: true, customer_confirmed_cents: 1, estimator_signoff_hash: "CURRENT" };
const checks = () => Object.fromEntries([...document.querySelectorAll("[data-check]")].map((e) => [e.getAttribute("data-check"), e.querySelector("[data-testid^=check-status]")!.textContent]));
const shot = (name: string) => { void name; };

describe("UX-006c Stage 3: the 'before you decide' checklist", () => {
  const review = { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 123 };
  it("lists the checkApproval conditions with a sign-off that is missing / not met, above the unchanged Approve and Return controls", async () => {
    await open({ stage: "3", roles: ["REP", "ESTIMATOR", "MANAGER"], row: review });
    await screen.findByTestId("approval-checklist", {}, { timeout: 8000 });
    expect([...document.querySelectorAll("[data-check]")].map((e) => e.getAttribute("data-check")).slice(0, 5)).toEqual(["ready", "total", "confirmed", "signoff", "amount"]);
    expect(checks().signoff).toBe("Not met");
    expect(checks().confirmed).toBe("Met");
    const approve = screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true); // the existing gate, unchanged
    expect(screen.getByText(/Waiting for the Estimator.s sign-off/)).toBeTruthy(); // the existing Alert stays
    expect(screen.getByTestId("approval-checklist").compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    shot("s3-manager-unmet");
  }, 30000);
  it("an unrecorded customer confirmation and a stale sign-off are unmet", async () => {
    await open({ stage: "3", roles: ["MANAGER"], row: { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: null, estimator_signoff_hash: "stale" } });
    await screen.findByTestId("approval-checklist", {}, { timeout: 8000 });
    expect(checks()).toMatchObject({ confirmed: "Not met", signoff: "Not met", amount: "Not met" });
    expect(document.body.textContent).toMatch(/no longer matches the current quotation/); // the existing Alert carries it
  }, 30000);
  it("the checklist never says Met for everything while Approve is disabled for a non-Manager: a Manager-role row is unmet", async () => {
    await open({ stage: "3", roles: ["REP"], row: { ...review, estimator_signoff_hash: "CURRENT" } });
    await screen.findByTestId("approval-checklist", {}, { timeout: 8000 });
    expect(checks()).toMatchObject({ signoff: "Met", manager: "Not met" });
  }, 30000);
  it("the sign-off row points at the existing Alert instead of repeating it (the Alert stays, once)", async () => {
    await open({ stage: "3", roles: ["MANAGER"], row: review });
    await screen.findByTestId("approval-checklist", {}, { timeout: 8000 });
    expect(screen.getAllByText(/Waiting for the Estimator/)).toHaveLength(1);
    expect(document.querySelector('[data-check="signoff"]')!.textContent).toContain("Explained in the note below.");
  }, 30000);
  it("a Rep/Estimator who is not a Manager sees the same facts read-only with the existing role text and a disabled Approve", async () => {
    await open({ stage: "3", roles: ["REP"], row: { ...review, estimator_signoff_hash: "CURRENT" } });
    await screen.findByTestId("approval-checklist", {}, { timeout: 8000 });
    expect(checks().signoff).toBe("Met");
    expect(screen.getByText("Final approval needs the Manager role.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement).disabled).toBe(true);
    const text = screen.getByTestId("approval-checklist").textContent ?? "";
    for (const leak of ["margin", "Margin", "cost", "GP"]) expect(text, leak).not.toContain(leak);
    shot("s3-nonmanager");
  }, 30000);
  it("is absent once approved and while the quote is still with the Rep", async () => {
    await open({ stage: "3", roles: ["MANAGER"], row: {} });
    expect(screen.queryByTestId("approval-checklist")).toBeNull();
    expect(screen.getByText(/This quotation is with the Rep/)).toBeTruthy();
    cleanup();
    await open({ stage: "3", roles: ["MANAGER"], row: FINAL });
    expect(screen.queryByTestId("approval-checklist")).toBeNull();
    expect(screen.getByText("Manager approved — final")).toBeTruthy();
  }, 60000);
  it("the Manager can approve when the sign-off is current (gate unchanged)", async () => {
    await open({ stage: "3", roles: ["MANAGER"], row: { ...review, estimator_signoff_hash: "CURRENT" } });
    await screen.findByTestId("approval-checklist", {}, { timeout: 8000 });
    expect(checks().signoff).toBe("Met");
    expect((screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement).disabled).toBe(false);
  }, 30000);
});

const shown = (id: string) => !!document.querySelector(`[data-step-panel="${id}"]`) && !document.querySelector(`[data-step-panel="${id}"]`)!.hasAttribute("hidden");
const rail = () => screen.getByRole("navigation", { name: "Customer quotation steps" });
const status = (id: string) => screen.getByTestId(`step-status-${id}`).textContent;

describe("UX-006c Stage 4: Issue PDF / Send to customer", () => {
  it("with no PDF: two steps, issue current and Not complete, send Not available, both panels mounted (the other hidden + inert)", async () => {
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery(), docs: docs(0) });
    await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy(), { timeout: 8000 });
    expect([...rail().querySelectorAll("ol > li button")].map((b) => b.getAttribute("data-step"))).toEqual(["issue", "send"]);
    expect(status("issue")).toBe("Not complete"); expect(status("send")).toBe("Not available");
    await screen.findByRole("button", { name: "Generate customer quotation PDF" }, { timeout: 8000 });
    expect(shown("issue")).toBe(true); expect(shown("send")).toBe(false);
    expect(document.querySelector('[data-step-panel="send"]')!.hasAttribute("inert")).toBe(true);
    expect(rail().querySelector('[aria-current="step"]')!.textContent).toContain("Issue PDF");
    shot("s4-step1");
  }, 30000);
  it("with a PDF issued and not sent: issue Complete, send Not complete; Next moves to the send step with the recipient controls and focuses its heading", async () => {
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery({ latestDocumentId: "d0" }), docs: docs(1) });
    await waitFor(() => expect(status("issue")).toBe("Complete"), { timeout: 8000 });
    expect(status("send")).toBe("Not complete");
    await waitFor(() => expect(document.querySelector('[data-step-panel="send"]')).toBeTruthy(), { timeout: 8000 }); // the panel loads after the page-level status read
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(new URL(window.location.href).searchParams.get("stage")).toBe("4"); // a reload lands on this step even when no ?stage= was given
    expect(shown("send")).toBe(true); expect(shown("issue")).toBe(false);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Step 2 · Send to customer"), { timeout: 8000 });
    expect(new URL(window.location.href).searchParams.get("step")).toBe("2");
    expect(screen.getByRole("button", { name: "Send quotation to customer" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send quotation to customer" }) as HTMLButtonElement).disabled).toBe(true); // existing gate: not yet reviewed
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shown("issue")).toBe(true);
    shot("s4-step2");
  }, 30000);
  it("once sent both steps are Complete and the history shows; the data in the hidden step was loaded either way", async () => {
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery({ status: "SENT_TO_CUSTOMER", latestDocumentId: "d0", sends: [{ id: "s1", status: "ACCEPTED", at: "2026-01-02T08:00:00Z", sentBy: "rep@nq", to: ["c@farm.co"], cc: [], suppressed: [], alternatives: [], alternativeReason: null, error: null, resendReason: null }] }), docs: docs(1) });
    await waitFor(() => expect(status("send")).toBe("Complete"), { timeout: 8000 });
    expect(status("issue")).toBe("Complete");
    await waitFor(() => expect(document.querySelector('[data-testid="send-history"]')).toBeTruthy(), { timeout: 8000 });
    expect(document.querySelector('[data-testid="send-history"]')).toBeTruthy(); // mounted although step 1 is the one shown
    expect(shown("send")).toBe(false);
    expect(screen.getByTestId("all-steps-complete")).toBeTruthy();
  }, 30000);
  it("a viewer who cannot send gets the existing Rep-only text; the step is not hidden", async () => {
    await open({ stage: "4", roles: ["ESTIMATOR"], row: FINAL, delivery: delivery({ latestDocumentId: "d0", canSend: false }), docs: docs(1), step: "2" });
    await waitFor(() => expect(shown("send")).toBe(true), { timeout: 8000 });
    expect(document.body.textContent).toContain("Only a Rep can send it.");
  }, 30000);
  it("Show all steps shows both; the sticky summary and customer summary panel stay", async () => {
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery({ latestDocumentId: "d0" }), docs: docs(1) });
    await waitFor(() => expect(status("issue")).toBe("Complete"), { timeout: 8000 });
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(shown("issue") && shown("send")).toBe(true);
    expect(screen.queryByTestId("step-buttons")).toBeNull();
    expect(screen.getByTestId("quote-summary-bar")).toBeTruthy();
    expect(document.body.textContent).toMatch(/Quotation NQ-Q|Summary view/);
  }, 30000);
  it("a quote that is not approved has no step rail: the read-only summary only", async () => {
    await open({ stage: "4", roles: ["REP"] });
    expect(screen.queryByTestId("step-rail")).toBeNull();
    expect(screen.getByText(/can be issued only after the Manager has approved/)).toBeTruthy();
  }, 30000);
});

describe("UX-006c Stage 5: status banner", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["awaiting", { status: "SENT_TO_CUSTOMER" }, "Awaiting customer response"],
    ["pending", { status: "ACCEPTANCE_PENDING_VERIFICATION" }, "Pending verification"],
    ["accepted", { status: "CUSTOMER_ACCEPTED", accepted: true }, "Accepted"],
    ["declined", { status: "CUSTOMER_DECLINED" }, "Returned: declined"],
    ["changes", { status: "CHANGES_REQUESTED" }, "Returned: changes requested"],
    ["rejected", { status: "ACCEPTANCE_REJECTED" }, "Returned: acceptance rejected"],
  ];
  for (const [name, d, label] of cases) it(`${name}: banner '${label}' sits above the unchanged Acceptance panel`, async () => {
    await open({ stage: "5", roles: ["REP"], row: FINAL, delivery: delivery({ latestDocumentId: "d0", ...d }) });
    const b = await screen.findByTestId("acceptance-banner", {}, { timeout: 8000 });
    expect(b.textContent).toContain(label);
    expect(document.querySelectorAll('[data-testid="acceptance-banner"]').length).toBe(1);
    const panelTitle = (await screen.findAllByText("Customer response"))[0];
    expect(b.compareDocumentPosition(panelTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    shot(`s5-${name}`);
  }, 30000);
  it("grandfathered: Not required; before approval and while loading: no banner (the existing messages stand)", async () => {
    await open({ stage: "5", roles: ["REP"], row: { ...FINAL, requires_customer_acceptance: false }, delivery: delivery({ requiresAcceptance: false, status: "APPROVED_INTERNALLY" }) });
    expect((await screen.findByTestId("acceptance-banner", {}, { timeout: 8000 })).textContent).toContain("Not required (grandfathered)");
    shot("s5-grandfathered");
    expect(document.body.textContent).not.toContain("so it is grandfathered"); // the banner says it once
    cleanup();
    await open({ stage: "5", roles: ["REP"] });
    expect(screen.queryByTestId("acceptance-banner")).toBeNull();
    expect(screen.getByText(/becomes available once the quotation has been issued/)).toBeTruthy();
  }, 60000);
});

describe("UX-006c Stage 6: readiness checklist", () => {
  it("UX-006: the Stage 6 handover controls (billing schedule select, Create Project button) carry 44px classes, for the Manager and the Rep alike", async () => {
    for (const roles of [["MANAGER"], ["REP"]] as Role[][]) {
      await open({ stage: "6", roles, row: { ...FINAL, requires_customer_acceptance: false }, delivery: delivery({ requiresAcceptance: false, status: "APPROVED_INTERNALLY" }) }); // the grandfathered path shows the schedule chooser
      await screen.findByTestId("handover-checklist", {}, { timeout: 8000 });
      const sel = screen.getByLabelText("Billing schedule") as HTMLSelectElement;
      expect(sel.className).toContain("min-h-11");
      if (roles[0] === "MANAGER") expect(screen.getByRole("button", { name: "Create Project from accepted quote" }).className).toContain("min-h-11");
      cleanup();
    }
  }, 60000);
  it("UX-006i2: Stage 6 says plainly what is next - for the Manager, the Manager's own button; for a Rep, that the Manager creates it; before acceptance, Stage 5", async () => {
    await open({ stage: "6", roles: ["MANAGER"], row: FINAL, delivery: delivery({ status: "CUSTOMER_ACCEPTED", accepted: true, latestDocumentId: "d0" }) });
    expect((await screen.findByTestId("stage6-next", {}, { timeout: 8000 })).textContent).toBe("Next: create the Project from the accepted quotation (the button below).");
    cleanup();
    await open({ stage: "6", roles: ["REP"], row: FINAL, delivery: delivery({ status: "CUSTOMER_ACCEPTED", accepted: true, latestDocumentId: "d0" }) });
    expect((await screen.findByTestId("stage6-next", {}, { timeout: 8000 })).textContent).toBe("Next: the Manager creates the Project from the accepted quotation.");
    cleanup();
    await open({ stage: "6", roles: ["MANAGER"], row: FINAL, delivery: delivery({ status: "SENT_TO_CUSTOMER", latestDocumentId: "d0" }) });
    expect((await screen.findByTestId("stage6-next", {}, { timeout: 8000 })).textContent).toMatch(/acceptance \(Stage 5\) is needed before you can create the Project/);
  }, 60000);

  it("a Manager on an accepted quote: all met; the Create button and copy are unchanged", async () => {
    await open({ stage: "6", roles: ["MANAGER"], row: FINAL, delivery: delivery({ status: "CUSTOMER_ACCEPTED", accepted: true, latestDocumentId: "d0" }) });
    const c = await screen.findByTestId("handover-checklist", {}, { timeout: 8000 });
    expect([...c.querySelectorAll("[data-testid^=check-status]")].map((e) => e.textContent)).toEqual(["Met", "Met", "Met", "Met"]);
    expect(screen.getByRole("button", { name: "Create Project from accepted quote" })).toBeTruthy();
    shot("s6-manager-ready");
  }, 30000);
  it("not yet accepted: acceptance is unmet and the existing 'not available yet' text stays", async () => {
    await open({ stage: "6", roles: ["MANAGER"], row: FINAL, delivery: delivery({ status: "SENT_TO_CUSTOMER", latestDocumentId: "d0" }) });
    const c = await screen.findByTestId("handover-checklist", {}, { timeout: 8000 });
    expect(c.querySelector('[data-check="acceptance"] [data-testid^=check-status]')!.textContent).toBe("Not met");
    expect(screen.queryByText(/Project handover is not available yet/)).toBeNull(); // the row says it once, with the link
    fireEvent.click(within(c).getByRole("button", { name: /Customer Acceptance \(Stage 5\)/ }));
    expect(new URL(window.location.href).searchParams.get("stage")).toBe("5");
    shot("s6-unmet");
  }, 30000);
  it("a non-Manager sees the role item unmet and the existing text", async () => {
    await open({ stage: "6", roles: ["REP"], row: FINAL, delivery: delivery({ status: "CUSTOMER_ACCEPTED", accepted: true, latestDocumentId: "d0" }) });
    const c = await screen.findByTestId("handover-checklist", {}, { timeout: 8000 });
    expect(c.querySelector('[data-check="manager"] [data-testid^=check-status]')!.textContent).toBe("Not met");
    expect(screen.getByText(/A Manager creates the Project from the accepted quotation/)).toBeTruthy();
    shot("s6-rep");
  }, 30000);
  it("grandfathered with a default schedule: the schedule item reflects the existing chooser; absent once a Project exists", async () => {
    await open({ stage: "6", roles: ["MANAGER"], row: { ...FINAL, requires_customer_acceptance: false }, delivery: delivery({ requiresAcceptance: false, status: "APPROVED_INTERNALLY" }) });
    const c = await screen.findByTestId("handover-checklist", {}, { timeout: 8000 });
    expect(c.querySelector('[data-check="acceptance"]')!.textContent).toContain("Not required");
    expect(c.querySelector('[data-check="schedule"]')).toBeTruthy();
    cleanup();
    await open({ stage: "6", roles: ["MANAGER"], row: { ...FINAL, project_id: "p1" } });
    expect(screen.queryByTestId("handover-checklist")).toBeNull();
  }, 60000);
});

describe("UX-006c interplay with the pinned landing stage", () => {
  const stageChip = (n: number) => document.querySelector(`[data-stage="${n}"]`)!.textContent ?? "";
  it("a Rep-only viewer's Stage 2 chip says 'With the Estimator' for a submitted quote; an Estimator's says 'Awaiting your review' (role-relative, same quote)", async () => {
    await open({ stage: "2", roles: ["REP"], row: { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1_000_000_000 } });
    await waitFor(() => expect(stageChip(2)).toContain("With the Estimator"), { timeout: 8000 });
    cleanup();
    await open({ stage: "2", roles: ["REP", "ESTIMATOR"], row: { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1_000_000_000 } });
    await waitFor(() => expect(stageChip(2)).toContain("Awaiting your review"), { timeout: 8000 });
  }, 60000);
  it("Preview only and the narrow-screen disclosure still work on the pinned stage", async () => {
    await open({ stage: "3", roles: ["REP"] });
    expect(document.querySelector('[data-phase="4"]')!.textContent).toContain("Preview only");
    const t = screen.getByTestId("stage-nav-toggle");
    expect(t.textContent).toContain("Phase 3 of 4");
    fireEvent.click(t); fireEvent.click(document.querySelector('[data-phase="4"]')!);
    expect(t.textContent).toContain("Phase 4 of 4");
    expect(document.activeElement).toBe(t);
  }, 30000);
  it("after a real workflow transition (the Manager approves) the view moves on to the new current stage", async () => {
    await open({ stage: "3", roles: ["MANAGER"], row: { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1_000_000_000, estimator_signoff_hash: "CURRENT" } });
    const approve = await screen.findByRole("button", { name: "Manager: final approval" }, { timeout: 8000 });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    expect(document.querySelector('[data-stage="3"]')!.getAttribute("aria-current")).toBe("step");
    // UX-006 S1a: the real approval now also needs COMPLETE costing, which this fixture does not have; the action is stubbed to the approved state so the test keeps proving that the view follows the transition.
    vi.spyOn(actions, "approveGrowerQuoteAction").mockImplementation((async () => { const rows = db.rows("newquip_quotes") as Array<Record<string, unknown>>; rows[0].state = "MANAGER_APPROVED_FINAL"; rows[0].approved_by_email = "m@nq"; return actions.getGrowerQuoteAction(g.__QID!); }) as never);
    fireEvent.click(approve);
    await waitFor(() => expect(document.querySelector('[data-testid="phase4-steps"] [data-stage="4"]')!.getAttribute("aria-current")).toBe("step"), { timeout: 15000 });
  }, 60000);
});

describe("UX-006c Stage 4 wiring follows the stable gate callback", () => {
  it("after a send is recorded (gate: SENT) the Stage 4 rail completes both steps and the view moves 4 -> 5", async () => {
    vi.mocked(da.sendQuoteToCustomerAction).mockImplementation((async () => {
      g.__DELIVERY = delivery({ status: "SENT_TO_CUSTOMER", latestDocumentId: "d0", sends: [{ id: "s1", status: "ACCEPTED", at: "2026-01-02T08:00:00Z", sentBy: "rep@nq", to: ["c@farm.co"], cc: [], suppressed: [], alternatives: [], alternativeReason: null, error: null, resendReason: null }] });
      return { ok: true, data: {} };
    }) as never);
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery({ latestDocumentId: "d0" }), docs: docs(1), step: "2" });
    const box = await screen.findByLabelText(/I have opened and reviewed the PDF/, {}, { timeout: 8000 });
    expect(document.querySelector('[data-testid="phase4-steps"] [data-stage="4"]')!.getAttribute("aria-current")).toBe("step");
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Send quotation to customer" }));
    await waitFor(() => expect(document.querySelector('[data-testid="phase4-steps"] [data-stage="5"]')!.getAttribute("aria-current")).toBe("step"), { timeout: 15000 });
  }, 60000);
});

describe("a recorded send that FAILED or was SUPPRESSED is never reported as sent", () => {
  it.each([["FAILED", /The email was NOT sent/], ["SUPPRESSED", /Not sent: no recipient is on the allowed list/]])("status %s shows the plain failure, not a success note", async (status, text) => {
    vi.mocked(da.sendQuoteToCustomerAction).mockImplementation((async () => ({ ok: true, data: { status } })) as never);
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery({ latestDocumentId: "d0" }), docs: docs(1), step: "2" });
    fireEvent.click(await screen.findByLabelText(/I have opened and reviewed the PDF/, {}, { timeout: 8000 }));
    fireEvent.click(screen.getByRole("button", { name: "Send quotation to customer" }));
    expect(await screen.findByText(text, {}, { timeout: 8000 })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Sent: the email provider accepted it|Send recorded/);
  }, 60000);
});

describe("UX-006c stage navigation", () => {
  it("Customer & Handover groups stages 4-6: the phase stays highlighted and its steps move between the existing stages (?stage= unchanged)", async () => {
    await open({ stage: "4", roles: ["REP"], row: FINAL, delivery: delivery({ latestDocumentId: "d0" }), docs: docs(1) });
    expect(document.querySelector('[data-phase="4"]')!.getAttribute("aria-current")).toBe("true"); // the phase is current; the one "step" is the active step below it
    expect(document.querySelectorAll('[data-stage][aria-current="step"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="phase4-steps"] [data-stage]').length).toBe(3);
    const toggle = screen.getByTestId("stage-nav-toggle");
    fireEvent.click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(document.querySelector('[data-testid="phase4-steps"] [data-stage="5"]')!);
    expect(toggle.getAttribute("aria-expanded")).toBe("false"); // choosing a step closes the open phase list (and returns focus to the toggle)
    await waitFor(() => expect(document.querySelector('[data-testid="phase4-steps"] [data-stage="5"]')!.getAttribute("aria-current")).toBe("step"));
    expect(document.querySelector('[data-phase="4"]')!.getAttribute("aria-current")).toBe("true");
    expect(document.querySelector('[data-phase="4"]')!.getAttribute("data-stage")).toBe("4"); // the phase card keeps its representative stage as an anchor
    expect(document.querySelector('[data-testid="phase4-steps"] [data-stage="4"]')!.getAttribute("aria-current")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("stage")).toBe("5");
    fireEvent.click(document.querySelector('[data-phase="3"]')!);
    expect(document.querySelector('[data-testid="phase4-steps"]')).toBeNull(); // the steps only show inside the phase
  }, 60000);
  it("Preview only appears on Stage 4 only when the customer summary can be inspected (READY, not approved); Stages 5 and 6 stay Not yet available", async () => {
    await open({ stage: "4", roles: ["REP"] });
    const label = (n: number) => document.querySelector(`[data-stage="${n}"]`)!.textContent ?? "";
    expect(label(4)).toContain("Preview only"); expect(label(5)).toContain("Not yet available"); expect(label(6)).toContain("Not yet available");
    expect(label(4)).not.toContain("Not yet available");
  }, 30000);
  it("selecting a phase from the open list moves focus to the toggle (the list collapses); Escape closes it and returns focus there", async () => {
    await open({ stage: "3", roles: ["REP"] });
    const t = screen.getByTestId("stage-nav-toggle");
    fireEvent.click(t);
    const five = document.querySelector('[data-phase="4"]') as HTMLElement; five.focus();
    fireEvent.click(five);
    expect(document.activeElement).toBe(t);
    fireEvent.click(t);
    const two = document.querySelector('[data-stage="2"]') as HTMLElement; two.focus();
    fireEvent.keyDown(two, { key: "Escape" });
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(t);
  }, 30000);
  it("on a narrow screen the disclosure reads 'Phase n of 4 · name', toggles aria-expanded, lists all four and selecting one closes it", async () => {
    await open({ stage: "3", roles: ["REP"] });
    const t = screen.getByTestId("stage-nav-toggle");
    expect(t.textContent).toContain("Phase 3 of 4 · Approve or Return");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll("#stage-nav-list > li button").length).toBe(4);
    fireEvent.click(document.querySelector('[data-phase="4"]')!);
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.textContent).toContain("Phase 4 of 4 · Customer & Handover");
    shot("nav-disclosure");
  }, 30000);
});
