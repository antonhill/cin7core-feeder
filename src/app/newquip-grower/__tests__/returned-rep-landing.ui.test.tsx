// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { deliveryViewOf, documentsViewOf } from "../page-reads";

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
const NEW = () => undefined;

async function open(o: { draft?: Record<string, unknown>; patch: (r: Record<string, any>) => void; search?: string; delay?: number; rememberShowAll?: boolean }) {
  g.__SEARCH = o.search ?? ""; // a click from the quotation list and a direct visit both arrive with no ?step
  factsDelayMs = o.delay ?? 0;
  if (o.rememberShowAll) vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => undefined });
  vi.mocked(resolveRoles).mockResolvedValue(new Set(["REP"]) as never);
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: { available: true, snapshot: null, snapshotId: null, seq: null, issues: [], currency: null, selectedContactIndex: null } } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...emptyDraft(), ...readyDraft(), quoteType: "project", customerName: "Acme Pigs", siteName: "Farm 1", ...(o.draft ?? {}) } as any);
  o.patch(row(id));
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await screen.findByTestId("step-rail", {}, { timeout: 15000 });
}
const active = () => document.querySelector('[data-testid="step-rail"] [aria-current="step"]')!.getAttribute("data-step");
const shown = (id: string) => !(document.querySelector(`[data-step-panel="${id}"]`) as HTMLElement).hasAttribute("hidden");

describe("a returned quotation with its earlier steps complete opens on the submit step", () => {
  it("customer details read promptly", async () => {
    await open({ patch: RETURNED });
    await waitFor(() => expect(active()).toBe("submit"));
    expect(shown("submit")).toBe(true);
    expect(shown("customer")).toBe(false);
  }, 60000);

  it("the same with Show all steps remembered as ON: still the one active form", async () => {
    await open({ patch: RETURNED, rememberShowAll: true });
    await waitFor(() => expect(active()).toBe("submit"));
    for (const id of ["customer", "site", "equipment", "review"]) expect(shown(id), id).toBe(false);
  }, 60000);

  it("the customer details are SLOW (the page stops waiting first): it must not stay on Customer once they arrive", async () => {
    await open({ patch: RETURNED, delay: 900 });
    await waitFor(() => expect(active()).toBe("submit"), { timeout: 8000 });
    expect(shown("customer")).toBe(false);
  }, 60000);

  it("while the customer details are still loading a returned quotation shows a stable loading state: the Customer form is NEVER visible on the way to Step 5", async () => {
    factsDelayMs = 0; // set by open(); this one needs a read that is slow but inside the returned-quotation wait (3 x 250 ms)
    const visibleCustomer: boolean[] = [];
    const sample = setInterval(() => { const p = document.querySelector('[data-step-panel="customer"]'); if (p) visibleCustomer.push(!p.closest("[hidden]") && !p.hasAttribute("hidden")); }, 20);
    try {
      await open({ patch: RETURNED, delay: 600 });
      expect(screen.getByTestId("stage1-shell").textContent).toMatch(/Preparing your quotation steps/);
      await waitFor(() => expect(active()).toBe("submit"), { timeout: 8000 });
    } finally { clearInterval(sample); }
    expect(visibleCustomer.length).toBeGreaterThan(5);
    expect(visibleCustomer.some(Boolean)).toBe(false);
  }, 60000);

  it("a visit with ?stage=1 (no step) lands the same way", async () => {
    await open({ patch: RETURNED, search: "stage=1", delay: 900 });
    await waitFor(() => expect(active()).toBe("submit"), { timeout: 8000 });
  }, 60000);
});

describe("other states keep their landing", () => {
  it("a NEW quotation with nothing entered opens on Step 1", async () => {
    await open({ patch: NEW, draft: { customerName: "", siteName: "" } });
    await waitFor(() => expect(active()).toBe("customer"));
  }, 60000);

  it("a NEW quotation with Show all steps remembered as ON opens on its ONE active step; the other forms stay hidden and the checkbox starts unchecked", async () => {
    await open({ patch: NEW, draft: { siteName: "" }, rememberShowAll: true });
    await waitFor(() => expect(active()).toBe("site")); // the first incomplete step of a draft with no site yet
    expect(["customer", "site", "equipment", "review", "submit"].filter((id) => shown(id))).toEqual(["site"]);
    expect((screen.getByRole("checkbox", { name: /Show all steps/ }) as HTMLInputElement).checked).toBe(false);
  }, 60000);

  it("a returned quotation whose Site step is incomplete opens on that step, not on Submit and not on Customer", async () => {
    await open({ patch: RETURNED, draft: { siteName: "" }, delay: 900 });
    await waitFor(() => expect(active()).toBe("site"), { timeout: 8000 });
  }, 60000);

  it("an explicit ?step= is honoured, slow read or not", async () => {
    await open({ patch: RETURNED, search: "stage=1&step=3", delay: 900 });
    expect(active()).toBe("customer"); // shown while nothing is known (later steps look locked), but the request is KEPT
    await waitFor(() => expect(active()).toBe("equipment"), { timeout: 8000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
    expect(active()).toBe("equipment");
  }, 60000);
});

describe("the page never moves a Rep who has chosen a step", () => {
  it("after the landing, choosing an earlier step stays put (nothing pulls the Rep back to Submit)", async () => {
    await open({ patch: RETURNED });
    await waitFor(() => expect(active()).toBe("submit"));
    fireEvent.click(document.querySelector('[data-testid="step-rail"] [data-step="equipment"]')!);
    await waitFor(() => expect(active()).toBe("equipment"));
    await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
    expect(active()).toBe("equipment");
  }, 60000);
});
