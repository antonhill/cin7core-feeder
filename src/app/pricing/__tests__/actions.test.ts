import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyPriceUpdatesAction, loadPricingPreviewAction } from "@/app/pricing/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { requireAal2 } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForPricing } from "@/cin7/pricing";
import { applyProductFixes } from "@/audit/apply-fixes";
import { logActivity } from "@/lib/activity-log";
import { requireOrgAdmin } from "@/lib/require-org-admin";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/pricing", () => ({ fetchAllProductsForPricing: vi.fn() }));
vi.mock("@/audit/apply-fixes", () => ({ applyProductFixes: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));

const CURRENT_ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
/** Tier index 2 => PriceTier3. Two products, so target-line mapping is observable. */
const LINES = [
  { productId: "p1", productSku: "SKU1", productName: "Widget", tierIndex: 2, currentValue: 100, newValue: 110 },
  { productId: "p2", productSku: "SKU2", productName: "Gadget", tierIndex: 2, currentValue: 50, newValue: 55 },
] as never;

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(CURRENT_ORG as never);
  vi.mocked(requireWriteAllowed).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(requireAal2).mockReset().mockResolvedValue(undefined);
  vi.mocked(requireOrgAdmin).mockReset();
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({} as never);
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({} as never);
  vi.mocked(fetchAllProductsForPricing).mockReset().mockResolvedValue({ products: [] } as never);
  vi.mocked(applyProductFixes).mockReset().mockResolvedValue({ succeeded: 2, failed: [] } as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined);
});

describe("CCT-ADR-0015: Bulk Pricing price-tier update requires AAL2", () => {
  it("1. an ordinary member with module access, write eligibility and AAL2 reaches the update", async () => {
    const result = await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    expect(result.ok).toBe(true);
    expect(requireAal2).toHaveBeenCalledTimes(1);
    expect(requireAal2).toHaveBeenCalledWith("apply bulk price updates");
    expect(applyProductFixes).toHaveBeenCalledTimes(1);
    // No admin role was consulted anywhere on the successful path.
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it("2. without AAL2 the action is denied BEFORE any Cin7 mutation", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required to apply bulk price updates."));

    const result = await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Two-factor authentication is required/);
    expect(applyProductFixes).not.toHaveBeenCalled();
    // ...and before credentials were even loaded.
    expect(loadCin7Credentials).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("3. an assurance-read failure fails CLOSED (indeterminate is not permitted)", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Could not verify two-factor authentication status: network"));

    const result = await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not verify two-factor authentication status/);
    expect(applyProductFixes).not.toHaveBeenCalled();
    expect(loadCin7Credentials).not.toHaveBeenCalled();
  });

  it("4. an admin role is NOT required — this stays an ordinary-member action", async () => {
    // requireOrgAdmin is mocked to reject: if the action consulted it at all,
    // the member path below would fail.
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only owners and admins can do this."));

    const result = await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    expect(result.ok).toBe(true);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it("5. the module gate remains effective and short-circuits before assurance", async () => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("This module is not enabled for your organization."));

    const result = await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enabled/);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(applyProductFixes).not.toHaveBeenCalled();
  });

  it("6. the billing/write-eligibility gate remains effective", async () => {
    vi.mocked(requireWriteAllowed).mockRejectedValue(new Error("Available on a paid plan."));

    const result = await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/paid plan/);
    expect(applyProductFixes).not.toHaveBeenCalled();
  });

  it("7. the computed values and target lines are unchanged by this guard", async () => {
    await applyPriceUpdatesAction("inst-1", "Tier 3", LINES);

    // One fix per line, carrying only the product ID plus the single tier
    // field — the values arrive exactly as the caller computed them.
    expect(applyProductFixes).toHaveBeenCalledWith({}, [
      { productId: "p1", fields: { PriceTier3: 110 } },
      { productId: "p2", fields: { PriceTier3: 55 } },
    ]);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logActivity).mock.calls[0][1]).toMatchObject({ action: "pricing.bulk_update" });
  });

  it("8. the read-only pricing preview is unaffected — no assurance, no billing gate", async () => {
    const result = await loadPricingPreviewAction("inst-1");

    expect(result.ok).toBe(true);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(requireWriteAllowed).not.toHaveBeenCalled();
    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(fetchAllProductsForPricing).toHaveBeenCalledTimes(1);
  });
});
