// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { equivalentInputs } from "@/newquip/pricing/estimator/__tests__/helpers";
import type { EstimatorPricing } from "@/newquip/pricing/estimator";

// Cost & Verify workstream, rendered through the REAL Stage 2 page. A quotation with Phase 2 supplier pricing ON shows ONE supplier-pricing workspace and a next-action banner, and the legacy Cin7 cost
// capture / margin sheet leave the normal view (kept, collapsed, reachable). A quotation WITHOUT Phase 2 pricing (or with it off) renders exactly as before.

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: (globalThis as { __QID?: string }).__QID }),
  useSearchParams: () => new URLSearchParams("stage=2&step=2"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
type Role = "REP" | "ESTIMATOR" | "MANAGER";
const g = globalThis as { __QID?: string };
const SUBMITTED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq" } };

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const fresh = () => new Date().toISOString();
/** Verified, complete supplier pricing with CURRENT exchange rates (so nothing is outstanding). */
const verified = (): EstimatorPricing => equivalentInputs({ pricingDate: fresh(), fxQuotes: { EUR: { rateMicro: 20_000_000, source: "Fixture spot", asOf: fresh() }, USD: { rateMicro: 20_000_000, source: "Fixture spot", asOf: fresh() } } }, "verified");
async function open(pricing: EstimatorPricing | undefined, roles: Role[] = ["ESTIMATOR"]) {
  vi.mocked(resolveRoles).mockResolvedValue(new Set(roles) as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  const d = readyDraft();
  await saveDraft(db as never, ORG, member, id, pricing ? { ...d, estimator: { ...d.estimator, pricing } } : d);
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { row.state = SUBMITTED.state; Object.assign(row, SUBMITTED.row); }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await screen.findByTestId("disc-supplier-pricing", {}, { timeout: 15000 });
  return id;
}
const LEGACY_PHRASES = [/Costing is incomplete/, /no supplier cost selected/i, /Cin7 cost capture is checked/];

describe("legacy quotations (no Phase 2 pricing) render EXACTLY as before", () => {
  for (const [label, pricing] of [["no supplier pricing at all", undefined], ["supplier pricing present but switched OFF", { ...equivalentInputs({}, "verified"), enabled: false } as unknown as EstimatorPricing]] as const) {
    it(`${label}: the legacy Cin7 cost capture and margin detail render; no banner, no legacy disclosure; supplier pricing is the optional disclosure`, async () => {
      await open(pricing);
      const cap = screen.getByTestId("disc-cost-capture");
      expect(cap.textContent).toMatch(/Cin7 cost capture and FX rates/);
      expect(screen.getByTestId("disc-margin").textContent).toMatch(/Margin detail/);
      expect(screen.queryByTestId("disc-legacy-costing")).toBeNull();
      expect(screen.queryByTestId("cost-next-action")).toBeNull();
      expect(document.querySelector('[data-supplier-pricing="optional"]')).toBeTruthy();
      expect(screen.getByTestId("disc-supplier-pricing").hasAttribute("open")).toBe(false); // still the collapsed, optional disclosure it always was
      expect(screen.getByText(/Supplier pricing \(Estimator workspace\)/)).toBeTruthy();
    }, 60000);
  }
});

describe("Phase 2 verified and complete", () => {
  it("shows ONE open supplier-pricing workspace and the next-action banner; the legacy panels are not in the normal view", async () => {
    await open(verified());
    expect(document.querySelector('[data-supplier-pricing="primary"]')).toBeTruthy();
    await screen.findByTestId("estimator-pricing-panel");
    expect(screen.getAllByTestId("estimator-pricing-panel")).toHaveLength(1);
    expect(screen.getByTestId("disc-supplier-pricing").hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("cost-next-action")).toBeTruthy();
    expect(screen.queryByTestId("disc-cost-capture")).toBeNull();
    expect(screen.queryByTestId("disc-margin")).toBeNull();
    expect(screen.queryByTestId("est-priced-note")).toBeNull();
  }, 60000);
  it("keeps the legacy data reachable in ONE collapsed 'Legacy costing (not used for this quotation)' disclosure that mounts the legacy panels only when opened", async () => {
    await open(verified());
    const legacy = screen.getByTestId("disc-legacy-costing");
    expect(legacy.textContent).toMatch(/Legacy costing \(not used for this quotation\)/);
    expect(legacy.hasAttribute("open")).toBe(false);
    expect(screen.queryByTestId("legacy-costing-body")).toBeNull();
    fireEvent.click(legacy.querySelector("summary")!);
    legacy.setAttribute("open", ""); legacy.dispatchEvent(new Event("toggle"));
    await waitFor(() => expect(screen.getByTestId("legacy-costing-body")).toBeTruthy());
    expect(screen.getByTestId("legacy-costing-body").textContent).toMatch(/Cin7|cost|margin/i);
  }, 60000);
  it("no misleading legacy 'costing incomplete / no supplier cost selected / Cin7 cost capture is checked' text anywhere on the page", async () => {
    await open(verified());
    await waitFor(() => expect(screen.getByTestId("estimator-pricing-panel")).toBeTruthy());
    const text = document.body.textContent ?? "";
    for (const re of LEGACY_PHRASES) expect(text, String(re)).not.toMatch(re);
    expect(text).toMatch(/Supplier costs verified \(\d+ of \d+\)/); // the step summary now speaks for Phase 2
    // verified: nothing about supplier costs is outstanding any more (this fixture's confirmed amount differs from the total, so the next step is the Rep's reconfirmation)
    expect(["mark", "reconfirm"]).toContain(screen.getByTestId("cost-next-action").getAttribute("data-next-action"));
    expect(screen.queryByTestId("cost-outstanding")).toBeNull();
  }, 60000);
});

describe("Phase 2 NOT yet verified: the outstanding items are phrased from the Phase 2 state", () => {
  it("unverified costs: the banner names the action and who may verify; no legacy wording", async () => {
    await open({ ...equivalentInputs({}, "unverified"), pricingDate: fresh(), fxQuotes: verified().fxQuotes });
    const b = screen.getByTestId("cost-next-action");
    expect(b.getAttribute("data-next-action")).toBe("verify");
    expect(screen.getByTestId("cost-next-action-headline").textContent).toMatch(/^\d+ costs? needs? independent verification by a Manager$/);
    expect(screen.getByTestId("cost-outstanding").textContent).toMatch(/supplier costs? needs? independent verification by a Manager \(/);
    expect(screen.queryByTestId("disc-cost-capture")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/no supplier cost selected/i);
    expect(text).not.toMatch(/Cin7 cost capture is checked/);
    expect(text).not.toMatch(/Costing is incomplete/);
    expect(text).toMatch(/Supplier pricing is not complete: \d+ supplier costs? needs? independent verification/); // header / step summary / sign-off reason are phrased from Phase 2
  }, 60000);
  it("a SKU with no supplier cost entered: 'Enter supplier costs' naming the SKU", async () => {
    const p = verified(); delete p.skus.ERT053;
    await open(p);
    expect(screen.getByTestId("cost-next-action-headline").textContent).toBe("Enter supplier costs");
    expect(screen.getByTestId("cost-next-action-detail").textContent).toMatch(/ERT053/);
  }, 60000);
});
