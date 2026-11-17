import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";

// The Rep's "Submit to Estimator" with NO customer price yet retries automatic pricing through the SAME gated entry (runAutoPricing), first, and the submit NEVER fails or blocks because pricing
// failed. Only the session, the roles and the two collaborators under test are replaced; the action and its ordering are real.
let db: FakeDb;
const order: string[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn(async () => ({ userId: "u-rep", email: "rep@a" })) }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn(async () => { throw new Error("not admin"); }) }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn(async () => ({ orgId: "org-nq" })) }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn(async () => ({ userId: "u-rep", email: "rep@a", demo: null, tier: "member" })) }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(async () => ({ functional: ["REP"], explicit: true })), canSeeCosts: vi.fn(async () => false) }));
vi.mock("@/lib/approvals/roles", () => ({ toQuoteRoles: () => new Set(["rep"]) }));
vi.mock("@/lib/approvals/role-switch-store", () => ({ narrowTier: vi.fn(async () => true), resolveSwitchState: vi.fn(async () => null) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/auto-pricing-service", () => ({ runAutoPricing: vi.fn() }));
vi.mock("@/lib/newquip-quotes/customer-store", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-quotes/customer-store")>()), customerFeaturesAvailable: vi.fn(async () => false) }));
vi.mock("@/lib/newquip-quotes/quote-store", async (orig) => ({ ...(await orig<typeof import("@/lib/newquip-quotes/quote-store")>()), sendToEstimatorUnpriced: vi.fn() }));
vi.mock("@/lib/approvals/approval-store", async (orig) => ({ ...(await orig<typeof import("@/lib/approvals/approval-store")>()), stagedAvailable: vi.fn(async () => false) }));
import { runAutoPricing } from "@/lib/newquip-quotes/auto-pricing-service";
import { sendToEstimatorUnpriced } from "@/lib/newquip-quotes/quote-store";
import { sendGrowerQuoteUnpricedToEstimatorAction } from "../actions";

const outcome = (o: Partial<{ status: string; added: number; pending: string[]; pendingCount: number }> = {}) => ({ status: "applied", added: 0, pending: [], pendingCount: 0, internal: [], ...o });
beforeEach(() => {
  db = new FakeDb(); seedGoldenCatalogue(db as never, "org-nq"); order.length = 0;
  vi.mocked(runAutoPricing).mockReset().mockImplementation(async () => { order.push("auto"); return outcome({ added: 2 }) as never; });
  vi.mocked(sendToEstimatorUnpriced).mockReset().mockImplementation(async () => { order.push("send"); });
});

describe("hand-off retry", () => {
  it("runs the gated automatic pricing BEFORE the submit, as the Rep, with the single entry point", async () => {
    await sendGrowerQuoteUnpricedToEstimatorAction("q1", true);
    expect(order).toEqual(["auto", "send"]);
    expect(runAutoPricing).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAutoPricing).mock.calls[0][1]).toMatchObject({ orgId: "org-nq", userId: "u-rep", demo: false });
    expect([...vi.mocked(runAutoPricing).mock.calls[0][1].roles]).toEqual(["rep"]);
  });
  it("a pricing FAILURE (it throws) never blocks the submit", async () => {
    vi.mocked(runAutoPricing).mockImplementation(async () => { order.push("auto"); throw new Error("Cin7 is down"); });
    await sendGrowerQuoteUnpricedToEstimatorAction("q1", true);
    expect(order).toEqual(["auto", "send"]);
  });
  it("a pricing refusal or error outcome never blocks the submit", async () => {
    for (const status of ["error", "skipped", "no_prices", "settings_incomplete", "not_applicable"]) {
      order.length = 0;
      vi.mocked(runAutoPricing).mockImplementation(async () => { order.push("auto"); return outcome({ status, added: 0 }) as never; });
      await sendGrowerQuoteUnpricedToEstimatorAction("q1", true);
      expect(order).toEqual(["auto", "send"]);
    }
  });
  it("when the retry just completed the prices, the existing 'indicative price exists' refusal is explained (the normal confirmation submit applies)", async () => {
    vi.mocked(sendToEstimatorUnpriced).mockImplementation(async () => { throw new Error("An indicative price exists: the customer must confirm that amount."); });
    const r = await sendGrowerQuoteUnpricedToEstimatorAction("q1", true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Automatic pricing has just completed the remaining prices/);
  });
  it("without a retry that added prices, the refusal is unchanged", async () => {
    vi.mocked(runAutoPricing).mockImplementation(async () => outcome({ status: "nothing_to_add", added: 0 }) as never);
    vi.mocked(sendToEstimatorUnpriced).mockImplementation(async () => { throw new Error("An indicative price exists: the customer must confirm that amount."); });
    const r = await sendGrowerQuoteUnpricedToEstimatorAction("q1", true);
    expect(!r.ok && r.error).toMatch(/^An indicative price exists/);
  });
});
