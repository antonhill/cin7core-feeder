import { describe, expect, it, vi, beforeEach } from "vitest";
import { updateOrderShipByAction, markOrderShippedAction } from "../actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { updateSaleShipBy, markSaleShipped } from "@/cin7/sales";
import { createServiceRoleClient } from "@/supabase/server";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/sales", () => ({ updateSaleShipBy: vi.fn(), markSaleShipped: vi.fn(), fetchCarriers: vi.fn() }));
vi.mock("@/lib/ship-by-notifications", () => ({ recordShipByChange: vi.fn() }));

function fakeDb() {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ship_by: null }, error: null }) }) }) }) }),
      update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
    }),
  };
}

/**
 * Security re-audit P1-3: updateOrderShipByAction/markOrderShippedAction
 * both write to Cin7 (updateSaleShipBy/markSaleShipped) and must gate on
 * requireWriteAllowed (the org's billing plan), not just requireModuleAccess
 * (module visibility only) — asserts the gate is actually called with the
 * resolved orgId, and that a billing rejection stops the action before any
 * Cin7 write happens.
 */
describe("shipping-calendar write gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "user1", email: "a@b.com" });
    vi.mocked(requireWriteAllowed).mockResolvedValue(undefined);
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb() as never);
    vi.mocked(loadCin7Credentials).mockResolvedValue({ name: "i", accountId: "a", applicationKey: "k", baseUrl: "https://inventory.dearsystems.com/ExternalApi/v2" });
    vi.mocked(updateSaleShipBy).mockResolvedValue(undefined);
    vi.mocked(markSaleShipped).mockResolvedValue(undefined);
  });

  it("updateOrderShipByAction checks requireWriteAllowed with the resolved orgId before writing to Cin7", async () => {
    const result = await updateOrderShipByAction("inst1", "sale1", "2026-09-01");
    expect(requireWriteAllowed).toHaveBeenCalledWith("org1");
    expect(result.ok).toBe(true);
    expect(updateSaleShipBy).toHaveBeenCalled();
  });

  it("updateOrderShipByAction refuses and never calls Cin7 when billing disallows writes", async () => {
    vi.mocked(requireWriteAllowed).mockRejectedValue(new Error("Your subscription isn't active — subscribe to write changes back to Cin7."));
    const result = await updateOrderShipByAction("inst1", "sale1", "2026-09-01");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/subscription/i);
    expect(updateSaleShipBy).not.toHaveBeenCalled();
  });

  it("markOrderShippedAction checks requireWriteAllowed with the resolved orgId before writing to Cin7", async () => {
    const result = await markOrderShippedAction("inst1", "sale1", { shipmentDate: "2026-09-01", carrier: "DEFAULT" });
    expect(requireWriteAllowed).toHaveBeenCalledWith("org1");
    expect(result.ok).toBe(true);
    expect(markSaleShipped).toHaveBeenCalled();
  });

  it("markOrderShippedAction refuses and never calls Cin7 when billing disallows writes", async () => {
    vi.mocked(requireWriteAllowed).mockRejectedValue(new Error("read-only during the trial"));
    const result = await markOrderShippedAction("inst1", "sale1", { shipmentDate: "2026-09-01", carrier: "DEFAULT" });
    expect(result.ok).toBe(false);
    expect(markSaleShipped).not.toHaveBeenCalled();
  });
});
