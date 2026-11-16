// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useEffect, useRef } from "react";
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
import * as actions from "../actions";
import { deliveryViewOf, documentsViewOf } from "../page-reads";

// THE REP'S SUBMISSION shows ONE status. Rendered through the REAL page with a slow (delayed) server response: ONE inline pending region that stays visible and updates (still waiting), no button spinner, no floating
// progress pill, a disabled button (no duplicate submission), and ONE actionable failure. (Landing rules are in returned-rep-landing.ui.test.tsx; the harness below is the same.)
// WHERE A REP LANDS in Stage 1, rendered through the REAL page with the quotation's genuine state and a customer read that can be SLOW (the connected host's customer read takes seconds). The agreed rule:
// a returned quotation whose earlier steps are complete opens on Step 5; a new quotation on Step 1; an incomplete earlier step opens THAT step; a remembered "Show all steps" never overrides it; a slow customer
// read never leaves the Rep stuck on Customer; and the page never moves a Rep who has chosen a step.
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
// The page waits this long for the customer details before it stops showing its loading shell; shortened here so a "slow read" is testable.
vi.mock("@/newquip/quote/stage1-steps", async (orig) => ({ ...(await orig<typeof import("@/newquip/quote/stage1-steps")>()), CUSTOMER_FACTS_WAIT_MS: 250 }));

const FACTS = { loaded: true, available: true, hasSnapshot: true, hasContact: true, contactName: "A Contact" };
let factsDelayMs = 0; // when the customer panel reports its details
vi.mock("../[id]/CustomerPanel", () => ({
  CustomerPanel: (p: { onFacts?: (f: any) => void }) => {
    const latest = useRef(p.onFacts);
    latest.current = p.onFacts; // the page passes a new callback on each render: one read, reported once, after the configured delay
    useEffect(() => { const t = setTimeout(() => latest.current?.(FACTS), factsDelayMs); return () => clearTimeout(t); }, []);
    return null;
  },
}));

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
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
  factsDelayMs = 0;
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(deliveryViewOf).mockResolvedValue({ available: true, requiresAcceptance: true, accepted: false, status: "APPROVED_INTERNALLY", latestDocumentId: null, links: { state: "NONE" } } as any);
  vi.mocked(documentsViewOf).mockResolvedValue({ available: true, documents: [], blockers: [], canIssue: false } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const row = (id: string) => db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, any>;
const RETURNED = (r: Record<string, any>) => { r.state = "REP_DRAFT"; r.revision = 2; };

async function open() {
  g.__SEARCH = "";
  vi.mocked(resolveRoles).mockResolvedValue(new Set(["REP"]) as never);
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  const contact = { name: { state: "present", value: "Sean" }, email: { state: "present", value: "s@x.co" } };
  const view = { available: true, snapshot: { cin7CustomerId: "c-123", name: { state: "present", value: "Acme Pigs (Pty) Ltd" }, tradingName: { state: "present", value: "Acme Pigs" }, billingAddress: null, vatNumber: { state: "missing" }, currency: { state: "missing" }, paymentTerm: { state: "missing" }, contacts: [contact], chosenContact: { name: "Sean", email: "s@x.co", source: "CIN7_CONTACT", phone: null } }, snapshotId: "s1", seq: 7, issues: [], currency: null, selectedContactIndex: 0, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [] };
  vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: view } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...emptyDraft(), ...readyDraft(), quoteType: "project", customerName: "Acme Pigs", siteName: "Farm 1" } as any);
  RETURNED(row(id));
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await screen.findByTestId("step-rail", {}, { timeout: 15000 });
}
const live = () => [...document.querySelectorAll('[data-testid="action-feedback"]')].filter((e) => e.getAttribute("data-kind") !== "idle");

describe("submitting to the Estimator shows ONE coherent status", () => {
  it("a slow server: one pending region that keeps updating, no button spinner, no floating pill, a disabled button; then ONE actionable failure", async () => {
    let finish: (v: any) => void = () => undefined;
    vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction").mockImplementation((() => new Promise((res) => { finish = res; })) as never);
    await open();
    await waitFor(() => expect(document.querySelector('[data-testid="step-rail"] [aria-current="step"]')!.getAttribute("data-step")).toBe("submit"), { timeout: 8000 });
    const ack = await screen.findByTestId("confirm-ack");
    fireEvent.click(within(ack).getByRole("checkbox"));
    const btn = screen.getByRole("button", { name: "Submit to Estimator" }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);

    await waitFor(() => expect(live()).toHaveLength(1));
    expect(live()[0].getAttribute("data-kind")).toBe("pending");
    expect(btn.disabled).toBe(true); // no second submission
    expect(btn.querySelector("svg, [data-testid=spinner]")).toBeNull(); // the button itself carries no second spinner
    fireEvent.click(btn);
    expect(vi.mocked(actions.sendGrowerQuoteToEstimatorAction)).toHaveBeenCalledTimes(1);

    await act(async () => { await new Promise((r) => setTimeout(r, 2600)); }); // past the "still waiting" threshold
    expect(live()).toHaveLength(1); // the SAME region updates, it does not add another
    expect(screen.getAllByTestId("action-feedback-slow")).toHaveLength(1);
    expect(screen.queryByTestId("long-running-status")).toBeNull(); // no floating progress pill

    await act(async () => { finish({ ok: false, error: "The Estimator could not be notified. Nothing was submitted; try again." }); });
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(live()[0].getAttribute("data-kind")).toBe("error");
    expect(live()[0].textContent).toMatch(/could not be notified/);
    expect(screen.queryByTestId("long-running-status")).toBeNull();
  }, 60000);
});
