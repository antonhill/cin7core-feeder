import { beforeEach, describe, expect, it, vi } from "vitest";

// Cost is withheld SERVER-SIDE from anyone who is not an org owner/admin (Sean Round 1 sign-off #6; Round 2 brief §15).
const NEWQUIP = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const requireOrgAdmin = vi.fn();

const TABLES: Record<string, unknown[]> = {
  products: [{ sku: "PNQ082", name: "CCM FEEDER WITH MONOFLO NIPPLE FOR GROWERS", active: true, average_cost: 812.5 }],
  price_tiers: [{ product_sku: "PNQ082", tier_code: "Tier1", amount: 1200 }],
  product_availability: [{ product_sku: "PNQ082", available: 7 }],
};
// A minimal thenable stand-in for the supabase-js builder: every chain method returns itself; awaiting yields the rows.
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order", "limit"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) => res({ data: TABLES[table] ?? [], error: null });
  return b;
}

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: () => Promise.resolve({ orgId: NEWQUIP, userId: "u", email: null }) }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: () => Promise.resolve(undefined) }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: (a: string) => requireOrgAdmin(a) }));

import { discoverGrowerProductsAction, getGrowerViewerAction, lookupGrowerProductsAction } from "@/app/newquip-grower/actions";

beforeEach(() => vi.clearAllMocks());

describe("getGrowerViewerAction (display only)", () => {
  it("an owner/admin may see commercials", async () => {
    requireOrgAdmin.mockResolvedValue({});
    expect(await getGrowerViewerAction()).toEqual({ ok: true, data: { canViewCommercials: true } });
  });
  it("a plain member may not — and that is not an error", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Only an org owner or admin can do that."));
    expect(await getGrowerViewerAction()).toEqual({ ok: true, data: { canViewCommercials: false } });
  });
});

describe("Average Cost never reaches a non-admin's browser", () => {
  it("lookup returns the cost to an admin", async () => {
    requireOrgAdmin.mockResolvedValue({});
    const r = await lookupGrowerProductsAction(["PNQ082"]);
    expect(r.data![0]).toMatchObject({ sku: "PNQ082", averageCost: 812.5, tierPrices: { Tier1: 1200 } });
  });
  it("lookup returns NO cost to a member (selling price still available)", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("nope"));
    const r = await lookupGrowerProductsAction(["PNQ082"]);
    expect(r.data![0].averageCost).toBeNull();
    expect(r.data![0].tierPrices).toEqual({ Tier1: 1200 });
    expect(JSON.stringify(r)).not.toContain("812.5");
  });
  it("discovery returns NO cost to a member", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("nope"));
    const r = await discoverGrowerProductsAction();
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("812.5");
  });
  it("a failure to establish the role fails CLOSED (no cost)", async () => {
    requireOrgAdmin.mockRejectedValue(new Error("Not signed in."));
    expect(JSON.stringify(await lookupGrowerProductsAction(["PNQ082"]))).not.toContain("812.5");
  });
});
