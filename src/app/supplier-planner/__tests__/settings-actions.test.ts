import { describe, expect, it, vi, beforeEach } from "vitest";
import { savePurchasePlannerSettingsAction } from "@/app/supplier-planner/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireWriteAllowed } from "@/lib/billing";
import { requireAal2 } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn(), getBillingStatus: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/purchase-write", () => ({ createPurchaseOrder: vi.fn() }));
vi.mock("@/lib/po-idempotency", () => ({ poIdempotencyKey: vi.fn(), claimPoCreation: vi.fn(), settlePoCreation: vi.fn(), releasePoCreation: vi.fn(), markPoCreationAmbiguous: vi.fn(), findLikelyCreatedPurchaseOrder: vi.fn(), PO_CLAIM_TTL_SECONDS: 900 }));
vi.mock("@/reports/supplier-planner/build", () => ({ groupLinesForPurchaseOrders: vi.fn(), buildSupplierPlanLines: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/pending-purchase-orders", () => ({ loadPendingPurchaseOrders: vi.fn() }));
vi.mock("@/reports/supplier-planner-export", () => ({ buildSupplierPlanSheet: vi.fn() }));
vi.mock("@/reports/xlsx-writer", () => ({ renderXlsxBase64: vi.fn() }));
vi.mock("@/reports/query", () => ({ getReorderReport: vi.fn(), getSupplierPlanLocationDemand: vi.fn() }));
vi.mock("@/cin7/reference-lookups", () => ({ fetchAllLocations: vi.fn() }));
vi.mock("@/cin7/product-supplier-options", () => ({ fetchAllProductsForSupplierPlanning: vi.fn() }));

const ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const MODULE_DENIED = "This module is not enabled for your organization.";
const NOT_ADMIN = "Only an org owner or admin can do this.";

function trackingDb() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  return { upsert, db: { from: vi.fn(() => ({ upsert })) } };
}
let t: ReturnType<typeof trackingDb>;

beforeEach(() => {
  t = trackingDb();
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireWriteAllowed).mockReset();
  vi.mocked(requireAal2).mockReset();
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue(t.db as never);
});

describe("savePurchasePlannerSettingsAction requires module access AND the org-admin role", () => {
  it("A. module denied while the role would otherwise pass → no DB client, no settings write", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
    vi.mocked(requireOrgAdmin).mockResolvedValue(ORG as never);

    const result = await savePurchasePlannerSettingsAction({ homeCurrency: "ZAR", importStockMonths: 3 } as never);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(t.upsert).not.toHaveBeenCalled();
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it("B. module allowed but not an admin → no settings write", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));

    const result = await savePurchasePlannerSettingsAction({ homeCurrency: "ZAR", importStockMonths: 3 } as never);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(NOT_ADMIN);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(t.upsert).not.toHaveBeenCalled();
  });

  it("C. module allowed + admin → the upsert proceeds unchanged", async () => {
    const result = await savePurchasePlannerSettingsAction({ homeCurrency: "ZAR", importStockMonths: 3 } as never);

    expect(result.ok).toBe(true);
    expect(requireModuleAccess).toHaveBeenCalledWith("/supplier-planner");
    expect(t.upsert).toHaveBeenCalledTimes(1);
    expect(t.upsert.mock.calls[0][0]).toMatchObject({ org_id: "org1", home_currency: "ZAR", import_stock_months: 3 });
  });

  it("D. module runs before role, and both before the DB client", async () => {
    const order: string[] = [];
    vi.mocked(requireModuleAccess).mockImplementation(async () => { order.push("module"); return ORG as never; });
    vi.mocked(requireOrgAdmin).mockImplementation(async () => { order.push("role"); return ORG as never; });
    vi.mocked(createServiceRoleClient).mockImplementation(() => { order.push("db"); return t.db as never; });

    await savePurchasePlannerSettingsAction({ homeCurrency: "ZAR", importStockMonths: 3 } as never);

    expect(order).toEqual(["module", "role", "db"]);
  });

  it("E. no billing gate and no assurance step-up were added — a local settings write", async () => {
    await savePurchasePlannerSettingsAction({ homeCurrency: "ZAR", importStockMonths: 3 } as never);
    expect(requireWriteAllowed).not.toHaveBeenCalled();
    expect(requireAal2).not.toHaveBeenCalled();
  });
});
