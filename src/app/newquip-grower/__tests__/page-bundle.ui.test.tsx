// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { deliveryViewOf, documentsViewOf } from "../page-reads";

// (setup shared with stage-follow.ui.test.tsx) UX-006a, rendered through the REAL page (Stage 1): the step rail, Back / Next, ?step=, Show all steps, Next incomplete step, the Review step, and the save-state chip.
// The customer panel's own read is stubbed (the FakeDb has no customer tables) so the lifted facts can be controlled; nothing else is mocked.
let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
// The opening bundle's delivery / documents readers are spies, so what the page does with each part can be observed.
vi.mock("../page-reads", () => ({ deliveryViewOf: vi.fn(), documentsViewOf: vi.fn() }));
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
let panelSeeds: any[] = [];
vi.mock("../[id]/DeliveryPanel", () => ({ DeliveryPanel: (p: { onGate: (g: any) => void; seed?: any }) => { emitGate = p.onGate; panelSeeds.push(p.seed); return null; } }));
vi.mock("../[id]/AcceptancePanel", () => ({ AcceptancePanel: (p: { onGate: (g: any) => void }) => { emitGate = p.onGate; return null; } }));
let pickCustomer: (n: string) => void = () => undefined;
// UX-006i1: the stub also reports the customer facts the way the real panel does (loaded, snapshot + contact), because the wizard resolves its entry step only once they have settled.
vi.mock("../[id]/CustomerPanel", () => ({ CustomerPanel: (p: { onPicked: (n: string) => void; onFacts?: (f: any) => void }) => { pickCustomer = p.onPicked; p.onFacts?.({ loaded: true, available: true, hasSnapshot: true, hasContact: true, contactName: "Sean", contactEmail: "s@x.co", customerTitle: "Acme" }); return null; } }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = emptyDraft();
const goodConfig = { ...base.config, rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, pigsPerRoom: 600, hospitalPens: 2, feederVariant: "STANDARD", penningPigSize: "SMALL", penningRunningMetresPerRoom: 20 } as any;
const customerView = (over: Record<string, unknown> = {}): any => ({ available: true, snapshot: null, snapshotId: null, seq: null, issues: ["Select the customer from Cin7."], currency: null, selectedContactIndex: null, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [], ...over });
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


const DELIVERY = { available: true, requiresAcceptance: true, accepted: false, status: "APPROVED_INTERNALLY", latestDocumentId: "d1", links: { state: "NONE" } } as any;
const DOCS = { available: true, documents: [], blockers: [], canIssue: false } as any;
const finalPatch = (r: Record<string, any>) => { r.state = "MANAGER_APPROVED_FINAL"; r.requires_customer_acceptance = true; r.accepted_baseline = { contractCents: 1000000, internalMargin: null, template: { name: "Grower", version: "1", rulesetVersion: "1" }, quote: { revision: 1 }, pricing: { source: { label: "x" }, basis: "x" }, overrides: [], exclusions: [], priceResolutions: [], exceptions: [] }; };

describe("the page opens an approved quotation with ONE bundle call (no separate delivery read)", () => {
  beforeEach(() => { panelSeeds = []; });
  it("reads the quotation, delivery and documents in one call and seeds the gate and the Stage 4 panel from it", async () => {
    vi.mocked(deliveryViewOf).mockResolvedValue(DELIVERY);
    vi.mocked(documentsViewOf).mockResolvedValue(DOCS);
    const bundle = vi.spyOn(actions, "getQuotePageBundleAction");
    const one = vi.spyOn(actions, "getGrowerQuoteAction");
    const delivery = vi.spyOn(da, "getQuoteDeliveryAction");
    await openQuote(["MANAGER", "REP"], finalPatch);
    await waitFor(() => expect(viewing()).toBe("4"), { timeout: 8000 });
    expect(bundle).toHaveBeenCalledTimes(1);
    expect(one).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled(); // the gate came from the bundle
    await waitFor(() => expect(panelSeeds.some((s) => s?.delivery?.ok && s?.documents?.ok)).toBe(true));
  }, 60000);

  it("a delivery part that failed is read again, the old way (one individual read, same error handling)", async () => {
    vi.mocked(deliveryViewOf).mockRejectedValue(new Error("boom"));
    vi.mocked(documentsViewOf).mockResolvedValue(DOCS);
    const delivery = vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: true, data: DELIVERY } as never);
    await openQuote(["MANAGER", "REP"], finalPatch);
    await waitFor(() => expect(viewing()).toBe("4"), { timeout: 8000 });
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(panelSeeds.every((s) => !s?.delivery?.ok || !s?.documents?.ok)).toBe(true); // a failed part is not offered to the panel as data
  }, 60000);

  it("documents failed but delivery fine: the gate still comes from the bundle (no individual delivery read) and the panel is offered a seed whose documents part is not ok, so it reads for itself", async () => {
    vi.mocked(deliveryViewOf).mockResolvedValue(DELIVERY);
    vi.mocked(documentsViewOf).mockRejectedValue(new Error("documents read failed"));
    const delivery = vi.spyOn(da, "getQuoteDeliveryAction");
    await openQuote(["MANAGER", "REP"], finalPatch);
    await waitFor(() => expect(viewing()).toBe("4"), { timeout: 8000 });
    expect(delivery).not.toHaveBeenCalled();
    await waitFor(() => expect(panelSeeds.some((s) => s?.delivery?.ok && s?.documents && !s.documents.ok && s.documents.error === "documents read failed")).toBe(true));
  }, 60000);

  it("the seed carries the server's read time and the quotation-and-viewer binding", async () => {
    vi.mocked(deliveryViewOf).mockResolvedValue(DELIVERY);
    vi.mocked(documentsViewOf).mockResolvedValue(DOCS);
    await openQuote(["MANAGER", "REP"], finalPatch);
    await waitFor(() => expect(panelSeeds.some((s) => s?.delivery?.ok)).toBe(true));
    const s = panelSeeds.find((x) => x?.delivery?.ok);
    expect(typeof s.readAt).toBe("number");
    expect(s.key).toContain(":r1:"); // ... : revision : organisation : roles : cost visibility
    expect(s.key).toMatch(/:(cost|nocost)$/);
  }, 60000);

  it("if the individual read also fails the page shows the same 'Try again' error as before", async () => {
    vi.mocked(deliveryViewOf).mockRejectedValue(new Error("boom"));
    vi.mocked(documentsViewOf).mockResolvedValue(DOCS);
    vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: false, error: "The quotation's delivery status could not be loaded." } as never);
    await openQuote(["MANAGER", "REP"], finalPatch);
    await waitFor(() => expect(screen.getByText(/delivery status could not be loaded/i)).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  }, 60000);

  it("a quotation that is not approved makes the one bundle call and no delivery read at all", async () => {
    const bundle = vi.spyOn(actions, "getQuotePageBundleAction");
    const delivery = vi.spyOn(da, "getQuoteDeliveryAction");
    await openQuote(["REP"], () => undefined);
    expect(bundle).toHaveBeenCalledTimes(1);
    expect(delivery).not.toHaveBeenCalled();
    expect(deliveryViewOf).not.toHaveBeenCalled();
  }, 60000);
});
