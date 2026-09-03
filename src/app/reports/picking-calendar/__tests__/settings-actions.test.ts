import { describe, expect, it, vi, beforeEach } from "vitest";
import { savePickingCalendarSettingsAction } from "@/app/reports/picking-calendar/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireWriteAllowed } from "@/lib/billing";
import { requireAal2 } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/sales", () => ({ updateSaleShipBy: vi.fn() }));
vi.mock("@/lib/ship-by-notifications", () => ({ recordShipByChange: vi.fn() }));
vi.mock("@/reports/query", () => ({ getOrderFulfillment: vi.fn(), getOrderFulfillmentLines: vi.fn() }));
vi.mock("@/actions/instances", () => ({ listInstancePickerItems: vi.fn() }));

const ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const MODULE_DENIED = "This module is not enabled for your organization.";
const NOT_ADMIN = "Only an org owner or admin can manage team members.";

/** Records every upsert so a denial can be asserted as "no write", not just "an error". */
function trackingDb() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  return { upsert, db: { from: vi.fn(() => ({ upsert })) } };
}

let tracker: ReturnType<typeof trackingDb>;

beforeEach(() => {
  tracker = trackingDb();
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireWriteAllowed).mockReset();
  vi.mocked(requireAal2).mockReset();
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue(tracker.db as never);
});

describe("savePickingCalendarSettingsAction requires BOTH module access and the org-admin role", () => {
  it("A. module denied, admin role would otherwise pass → NO settings write", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
    // The role guard is left passing, so only the module gate can stop this.
    vi.mocked(requireOrgAdmin).mockResolvedValue(ORG as never);

    const result = await savePickingCalendarSettingsAction(3);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expect(tracker.upsert).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("B. module allowed, non-admin → NO settings write", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error(NOT_ADMIN));

    const result = await savePickingCalendarSettingsAction(3);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(NOT_ADMIN);
    expect(tracker.upsert).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("C. module allowed + admin → the settings upsert proceeds unchanged", async () => {
    const result = await savePickingCalendarSettingsAction(3);

    expect(result.ok).toBe(true);
    expect(requireModuleAccess).toHaveBeenCalledWith("/reports/picking-calendar");
    expect(requireOrgAdmin).toHaveBeenCalledTimes(1);
    expect(tracker.upsert).toHaveBeenCalledTimes(1);
    expect(tracker.upsert.mock.calls[0][0]).toMatchObject({ org_id: "org1", offset_days: 3 });
  });

  it("D. both guards run before the service-role client is created", async () => {
    const order: string[] = [];
    vi.mocked(requireModuleAccess).mockImplementation(async () => {
      order.push("module");
      return ORG as never;
    });
    vi.mocked(requireOrgAdmin).mockImplementation(async () => {
      order.push("role");
      return ORG as never;
    });
    vi.mocked(createServiceRoleClient).mockImplementation(() => {
      order.push("db");
      return tracker.db as never;
    });

    await savePickingCalendarSettingsAction(3);

    expect(order).toEqual(["module", "role", "db"]);
  });

  it("E/F. no billing gate and no assurance step-up were added — this is a local settings write", async () => {
    await savePickingCalendarSettingsAction(3);

    expect(requireWriteAllowed).not.toHaveBeenCalled();
    expect(requireAal2).not.toHaveBeenCalled();
  });
});
