// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import * as ca from "../customer-actions";
import * as da from "../delivery-actions";
import * as actions from "../actions";

// UX-006a, rendered through the REAL page (Stage 1): the step rail, Back / Next, ?step=, Show all steps, Next incomplete step, the Review step, and the save-state chip.
// The customer panel's own read is stubbed (the FakeDb has no customer tables) so the lifted facts can be controlled; nothing else is mocked.
let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const g = globalThis as { __QID?: string; __STAGE?: string; __STEP?: string };
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: g.__QID }),
  useSearchParams: () => new URLSearchParams("stage=" + (g.__STAGE ?? "1") + (g.__STEP ? `&step=${g.__STEP}` : "")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
  g.__STAGE = undefined; g.__STEP = undefined;
  try { window.localStorage.clear(); } catch { /* storage unavailable in this runtime */ }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


// The panels are replaced by stubs that report through the SAME callbacks the real ones use (onGate / onPicked), so the page's reaction to a panel-driven transition is what is tested.
let emitGate: (g: any) => void = () => undefined;
vi.mock("../[id]/DeliveryPanel", () => ({ DeliveryPanel: (p: { onGate: (g: any) => void }) => { emitGate = p.onGate; return null; } }));
vi.mock("../[id]/AcceptancePanel", () => ({ AcceptancePanel: (p: { onGate: (g: any) => void }) => { emitGate = p.onGate; return null; } }));
let pickCustomer: (n: string) => void = () => undefined;
vi.mock("../[id]/CustomerPanel", () => ({ CustomerPanel: (p: { onPicked: (n: string) => void }) => { pickCustomer = p.onPicked; return null; } }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = emptyDraft();
const goodConfig = { ...base.config, rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, pigsPerRoom: 600, hospitalPens: 2, feederVariant: "STANDARD", penningPigSize: "SMALL", penningRunningMetresPerRoom: 20 } as any;
const customerView = (over: Record<string, unknown> = {}): any => ({ available: true, snapshot: null, snapshotId: null, seq: null, issues: ["Select the customer from Cin7."], currency: null, selectedContactIndex: null, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [], ...over });
const snapshotView = (contact: boolean): any => customerView({ snapshot: { cin7CustomerId: "c1", name: { state: "present", value: "Acme" }, tradingName: { state: "missing" }, billingAddress: null, vatNumber: { state: "missing" }, currency: { state: "missing" }, paymentTerm: { state: "missing" }, contacts: [], chosenContact: contact ? { name: "Sean", email: "s@x.co", source: "CIN7_CONTACT", phone: null } : null }, snapshotId: "s1", seq: 1, issues: [] });

async function open(draftOver: Record<string, unknown> = {}, view: any = customerView(), roles: Array<"REP" | "ESTIMATOR" | "MANAGER"> = ["REP", "ESTIMATOR"], step?: string) {
  asRoles(...roles);
  vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: view } as never);
  vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: false, error: "n/a" } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...base, customerName: "Acme Pigs", siteName: "Farm 1", config: goodConfig, ...draftOver } as any);
  g.__QID = id; g.__STEP = step;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy(), { timeout: 5000 });
}

const viewing = () => document.querySelector('[data-stage][aria-current="step"]')!.getAttribute("data-stage");
const row = (id: string) => db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, any>;
async function openQuote(roles: Array<"REP" | "ESTIMATOR" | "MANAGER">, patch: (r: Record<string, any>) => void, draftOver: Record<string, unknown> = {}) {
  g.__STAGE = ""; // derived stage (no ?stage=)
  asRoles(...roles);
  vi.mocked(canSeeCosts).mockResolvedValue(true);
  vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: customerView() } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...base, customerName: "Acme Pigs", siteName: "Farm 1", config: goodConfig, ...draftOver } as any);
  patch(row(id));
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("stage-nav")).toBeTruthy(), { timeout: 8000 });
  return id;
}
const gateData = (status: string, hasDoc: boolean, link: string) => ({ ok: true, data: { available: true, requiresAcceptance: true, accepted: false, status, latestDocumentId: hasDoc ? "d1" : null, links: { state: link } } });
const gateVal = (status: string, hasDocument: boolean, linkState: string) => ({ requires: true, accepted: false, status, hasDocument, linkState });

describe("UX-006a panel-driven transitions still move the view (the pin must not swallow them)", () => {
  async function openFinal() {
    vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue(gateData("APPROVED_INTERNALLY", false, "NONE") as never);
    await openQuote(["MANAGER", "REP"], (r) => { r.state = "MANAGER_APPROVED_FINAL"; r.requires_customer_acceptance = true; r.accepted_baseline = { contractCents: 1000000, internalMargin: null, template: { name: "Grower", version: "1", rulesetVersion: "1" }, quote: { revision: 1 }, pricing: { source: { label: "test" }, basis: "test" }, overrides: [], exclusions: [], priceResolutions: [] }; r.customer_confirmed_cents = 1; r.requires_customer_acceptance = true; });
    await waitFor(() => expect(typeof emitGate).toBe("function"));
    await waitFor(() => expect(viewing()).toBe("4"), { timeout: 8000 });
  }
  it("sending to the customer (DeliveryPanel onGate) moves Stage 4 -> 5, and verifying the response (AcceptancePanel onGate) moves 5 -> 6; an unchanged gate moves nothing", async () => {
    await openFinal();
    act(() => emitGate(gateVal("APPROVED_INTERNALLY", false, "NONE"))); // identical to the first read
    expect(viewing()).toBe("4");
    act(() => emitGate(gateVal("SENT_TO_CUSTOMER", true, "ACTIVE")));
    await waitFor(() => expect(viewing()).toBe("5"));
    act(() => emitGate(gateVal("SENT_TO_CUSTOMER", true, "ACTIVE")));
    expect(viewing()).toBe("5");
    act(() => emitGate({ requires: true, accepted: true, status: "CUSTOMER_ACCEPTED", hasDocument: true, linkState: "ACTIVE" }));
    await waitFor(() => expect(viewing()).toBe("6"));
  }, 60000);
  it("a user who picked a stage by hand and then sees no change stays on it", async () => {
    await openFinal();
    fireEvent.click(document.querySelector('[data-stage="3"]')!);
    act(() => emitGate(gateVal("APPROVED_INTERNALLY", false, "NONE")));
    expect(viewing()).toBe("3");
  }, 60000);
});

describe("UX-006a workflow actions move the view; the user's own Save / demo load never do", () => {
  it("Manager 'Return to Estimator' (same state and revision, sign-off withdrawn) moves the view from Stage 3 to Stage 2", async () => {
    vi.mocked(requireOrgAdmin).mockResolvedValue(SESSION as never); // the server decides Manager by org admin
    await openQuote(["MANAGER", "REP"], (r) => { r.state = "ESTIMATOR_REVIEW"; r.customer_confirmed_cents = 1; r.estimator_signoff_hash = r.draft_hash; });
    await waitFor(() => expect(viewing()).toBe("3"));
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Check the freight" } });
    const real = actions.getGrowerQuoteAction;
    // the server's answer (a COPY: the FakeDb hands the page its live row object): same state and revision, sign-off withdrawn
    vi.spyOn(actions, "returnGrowerQuoteToEstimatorAction").mockImplementation((async (qid: string) => { const r: any = structuredClone(await real(qid)); r.data.quote.estimator_signoff_hash = null; return r; }) as never);
    fireEvent.click(screen.getByRole("button", { name: "Manager: return to estimator" }));
    await waitFor(() => expect(viewing()).toBe("2"), { timeout: 8000 });
  }, 60000);
  it("a Rep's own Save of an unsaved edit stays where it is, even though it withdraws any sign-off", async () => {
    await openQuote(["REP", "ESTIMATOR"], () => undefined, { siteName: "" });
    const before = viewing();
    fireEvent.click(screen.getByRole("button", { name: /Room measurements/ })); // stage 1 rail
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Total pens/), { target: { value: "21" } }); });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    expect(viewing()).toBe(before);
    expect(document.querySelector('[data-step-panel="room"]')!.hasAttribute("hidden")).toBe(false);
  }, 60000);
  it("a customer change that sends the quotation back to the Rep moves the view even while the draft is unsaved", async () => {
    await openQuote(["REP", "ESTIMATOR"], (r) => { r.state = "ESTIMATOR_REVIEW"; r.customer_confirmed_cents = 1; }, { siteName: "" });
    await waitFor(() => expect(viewing()).toBe("2"));
    fireEvent.click(document.querySelector('[data-stage="1"]')!);
    fireEvent.click(screen.getByRole("button", { name: /Room measurements/ }));
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Total pens/), { target: { value: "22" } }); }); // unsaved edit
    fireEvent.click(document.querySelector('[data-stage="2"]')!);
    expect(viewing()).toBe("2");
    const real = actions.getGrowerQuoteAction;
    vi.spyOn(actions, "getGrowerQuoteAction").mockImplementation((async (qid: string) => { const r: any = structuredClone(await real(qid)); Object.assign(r.data.quote, { state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null }); return r; }) as never); // the server's answer to the customer change
    await act(async () => { pickCustomer("Other Farms Ltd"); await new Promise((r) => setTimeout(r, 400)); });
    await waitFor(() => expect(viewing()).toBe("1"), { timeout: 8000 });
  }, 60000);
});
