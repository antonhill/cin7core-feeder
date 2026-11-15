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
async function open(pricing: EstimatorPricing | undefined, roles: Role[] = ["ESTIMATOR"], o: { state?: string; commercials?: boolean; waitFor?: string; unmapped?: boolean; noWaiver?: boolean } = {}) {
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials ?? true);
  vi.mocked(resolveRoles).mockResolvedValue(new Set(roles) as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  const d0 = readyDraft();
  const d1 = o.noWaiver ? { ...d0, estimator: { ...d0.estimator, costBasis: {} } } : d0; // the golden fixture already carries an accepted incomplete-cost exception
  const d = o.unmapped ? { ...d1, estimator: { ...d1.estimator, priceResolutions: { ...d1.estimator.priceResolutions, feeder: { unitPriceExVat: 1000, reason: "" } } } } : d1;
  await saveDraft(db as never, ORG, member, id, pricing ? { ...d, estimator: { ...d.estimator, pricing } } : d);
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { row.state = o.state ?? SUBMITTED.state; Object.assign(row, SUBMITTED.row); }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await screen.findByTestId(o.waitFor ?? "disc-supplier-pricing", {}, { timeout: 15000 });
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
      expect(screen.queryByTestId("estimator-workspace")).toBeNull(); // the workspace only mounts when supplier pricing is ON
      expect(screen.queryByTestId("cost-next-action")).toBeNull();
      expect(document.querySelector('[data-supplier-pricing="optional"]')).toBeTruthy();
      expect(screen.getByTestId("disc-supplier-pricing").hasAttribute("open")).toBe(false); // still the collapsed, optional disclosure it always was
      expect(screen.getByText(/Supplier pricing \(Estimator workspace\)/)).toBeTruthy();
    }, 60000);
  }
});

const WS = "estimator-workspace";
const openWs = (pricing: EstimatorPricing | undefined, roles: Role[] = ["ESTIMATOR"], o: Parameters<typeof open>[2] = {}) => open(pricing, roles, { ...o, waitFor: WS });

describe("Phase 2 (supplier pricing ON): the Estimator workspace replaces the stacked costing forms", () => {
  it("mounts ONE workspace with the next action and the four separate checks; the legacy panels, margin sheet and old supplier-pricing form are not in the normal view", async () => {
    await openWs(verified());
    await screen.findByTestId("commercial-summary");
    expect(screen.getAllByTestId(WS)).toHaveLength(1);
    expect(screen.getByTestId("next-action")).toBeTruthy();
    expect(screen.getByTestId("four-checks").textContent).toMatch(/Mapping complete.*Selling price complete.*Supplier cost complete.*Independently verified/);
    for (const gone of ["disc-cost-capture", "disc-margin", "disc-supplier-pricing", "estimator-pricing-panel", "disc-legacy-costing", "cost-next-action"]) expect(screen.queryByTestId(gone), gone).toBeNull();
    expect(document.querySelector('[data-supplier-pricing="primary"]')).toBeNull();
  }, 60000);
  it("no misleading legacy 'costing incomplete / no supplier cost selected / Cin7 cost capture is checked' text anywhere on the page", async () => {
    await openWs(verified());
    await screen.findByTestId("commercial-summary");
    const text = document.body.textContent ?? "";
    for (const re of LEGACY_PHRASES) expect(text, String(re)).not.toMatch(re);
  }, 60000);
  it("the sign-off and return actions stay on the page, below the workspace, with their gates", async () => {
    await openWs(verified());
    await screen.findByTestId("commercial-summary");
    expect(document.getElementById("ws-signoff")).toBeTruthy();
    expect(screen.getByTestId("return-section")).toBeTruthy();
  }, 60000);
  it("unverified costs: the workspace says verification is outstanding and the Estimator cannot verify (no legacy wording)", async () => {
    await openWs({ ...equivalentInputs({}, "unverified"), pricingDate: fresh(), fxQuotes: verified().fxQuotes });
    await screen.findByTestId("commercial-summary");
    expect(screen.getByTestId("four-checks").textContent).toMatch(/Independently verified\d+ of \d+/);
    expect(screen.getByTestId("four-checks").textContent).not.toMatch(/Independently verified(\d+) of \1\b/); // not all verified
    expect(screen.getByTestId("summary-margin").textContent).toMatch(/indicative, unverified/);
    expect(screen.queryByTestId("verify-block")).toBeNull(); // only a reviewer sees the verification block; the Estimator cannot verify
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/no supplier cost selected/i);
    expect(text).not.toMatch(/Costing is incomplete/);
  }, 60000);
  it("a SKU with no supplier cost entered is a task that names it", async () => {
    const p = verified(); delete p.skus.ERT053;
    await openWs(p);
    await screen.findByTestId("needs-you");
    expect(screen.getByTestId("needs-you").textContent).toMatch(/ERT053/);
  }, 60000);
});

describe("Phase 2: viewers without cost visibility see nothing of it", () => {
  for (const [label, roles] of [["a Rep", ["REP"]], ["an Estimator who cannot see costs", ["ESTIMATOR"]]] as const) {
    it(`${label}: no banner, no legacy disclosure, no supplier-pricing workspace, no supplier data`, async () => {
      await open(verified(), [...roles], { commercials: false, waitFor: "step-rail" });
      await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy());
      for (const id of ["cost-next-action", "disc-legacy-costing", "disc-cost-capture", "disc-supplier-pricing", "estimator-pricing-panel", "verify-block", "estimator-workspace", "commercial-summary"]) expect(screen.queryByTestId(id), id).toBeNull();
      expect(document.body.textContent ?? "").not.toMatch(/Fixture supplier|Supplier pricing and verification|Legacy costing/);
    }, 60000);
  }
});

describe("the banner never names an action the sign-off would refuse", () => {
  it("verified costs but the quotation is not READY: the workspace never offers sign-off or approval", async () => {
    await openWs(verified(), ["ESTIMATOR"], { unmapped: true });
    await screen.findByTestId("next-action");
    expect(screen.getByTestId("next-action").textContent).not.toMatch(/Sign off this quotation|Mark reviewed|Next: Manager approval/);
  }, 60000);
  it("an approved (final) quotation shows the frozen banner", async () => {
    await open(verified(), ["MANAGER"], { state: "MANAGER_APPROVED_FINAL", waitFor: "cost-next-action" });
    expect(screen.getByTestId("cost-next-action-headline").textContent).toMatch(/frozen/);
  }, 60000);
});

describe("the incomplete-costing waiver mirrors the server: Manager only, enabled for a Manager", () => {
  it("a Manager on a legacy quotation can use the waiver form (not under a disabled fieldset); the Estimator-only viewer gets no form and a note", async () => {
    await open(undefined, ["MANAGER"], { waitFor: "disc-cost-capture", noWaiver: true });
    fireEvent.click(screen.getByTestId("disc-cost-capture").querySelector("summary")!);
    const input = (await screen.findByLabelText(/Exception reason/, {}, { timeout: 15000 })) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.closest("fieldset[disabled]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Capture latest costs from Cin7/ })).toBeNull(); // Estimator-only controls are not offered to a Manager
    cleanup();
    await open(undefined, ["ESTIMATOR"], { waitFor: "disc-cost-capture", noWaiver: true });
    await screen.findByTestId("waiver-manager-only", {}, { timeout: 15000 });
    expect(screen.queryByLabelText(/Exception reason/)).toBeNull();
  }, 90000);
});
