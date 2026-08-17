import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/lemonsqueezy", () => ({ buildCheckoutUrl: vi.fn(), createCheckoutToken: vi.fn(), fetchCustomerPortalUrl: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

import { getCheckoutUrlAction, getManageSubscriptionUrlAction, getBillingStatusAction } from "@/actions/billing";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireCurrentOrg } from "@/lib/current-org";
import { getBillingStatus } from "@/lib/billing";
import { buildCheckoutUrl, createCheckoutToken, fetchCustomerPortalUrl } from "@/lib/lemonsqueezy";
import { createServiceRoleClient } from "@/supabase/server";

const reqAdmin = vi.mocked(requireOrgAdmin);
const reqOrg = vi.mocked(requireCurrentOrg);
const billingStatus = vi.mocked(getBillingStatus);
const checkoutUrl = vi.mocked(buildCheckoutUrl);
const checkoutToken = vi.mocked(createCheckoutToken);
const portalUrl = vi.mocked(fetchCustomerPortalUrl);
const serviceClient = vi.mocked(createServiceRoleClient);

const ADMIN = { userId: "u1", orgId: "org1", email: "a@b.com" };
const DENY = "Only an org owner or admin can manage billing.";

// Minimal service-role stub for getManageSubscriptionUrlAction's subscription
// lookup: organizations -> billing_subscription_id.
function dbWithSubscription(subId: string | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { billing_subscription_id: subId }, error: null }) }),
      }),
    }),
  } as unknown as ReturnType<typeof createServiceRoleClient>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billing actions require owner/admin (Phase 1.3)", () => {
  it("getCheckoutUrlAction: denies a non-admin member", async () => {
    reqAdmin.mockRejectedValue(new Error(DENY));
    const res = await getCheckoutUrlAction();
    expect(res).toEqual({ ok: false, error: DENY });
    expect(checkoutUrl).not.toHaveBeenCalled();
  });

  it("getCheckoutUrlAction: allows an owner/admin", async () => {
    reqAdmin.mockResolvedValue(ADMIN);
    checkoutToken.mockResolvedValue("tok-abc");
    checkoutUrl.mockReturnValue("https://checkout.example/x");
    const res = await getCheckoutUrlAction();
    expect(res).toEqual({ ok: true, url: "https://checkout.example/x" });
    expect(reqAdmin).toHaveBeenCalledWith("manage billing");
  });

  it("getCheckoutUrlAction: security re-audit P1-4 — creates a checkout token scoped to the resolved org, and builds the URL from the TOKEN, never the raw orgId", async () => {
    reqAdmin.mockResolvedValue(ADMIN);
    const fakeDb = {} as ReturnType<typeof createServiceRoleClient>;
    serviceClient.mockReturnValue(fakeDb);
    checkoutToken.mockResolvedValue("tok-abc");
    checkoutUrl.mockReturnValue("https://checkout.example/x");
    await getCheckoutUrlAction();
    expect(checkoutToken).toHaveBeenCalledWith(fakeDb, "org1");
    expect(checkoutUrl).toHaveBeenCalledWith("tok-abc", "a@b.com");
  });

  it("getManageSubscriptionUrlAction: denies a non-admin member (no portal lookup)", async () => {
    reqAdmin.mockRejectedValue(new Error(DENY));
    const res = await getManageSubscriptionUrlAction();
    expect(res).toEqual({ ok: false, error: DENY });
    expect(serviceClient).not.toHaveBeenCalled();
    expect(portalUrl).not.toHaveBeenCalled();
  });

  it("getManageSubscriptionUrlAction: allows an owner/admin with an active subscription", async () => {
    reqAdmin.mockResolvedValue(ADMIN);
    serviceClient.mockReturnValue(dbWithSubscription("sub_123"));
    portalUrl.mockResolvedValue("https://portal.example/y");
    const res = await getManageSubscriptionUrlAction();
    expect(res).toEqual({ ok: true, url: "https://portal.example/y" });
    expect(portalUrl).toHaveBeenCalledWith("sub_123");
  });

  it("getBillingStatusAction stays member-readable (uses requireCurrentOrg, not requireOrgAdmin)", async () => {
    reqOrg.mockResolvedValue({ userId: "m1", orgId: "org1", email: "m@b.com" });
    billingStatus.mockResolvedValue({
      status: "trialing",
      checkoutAvailable: true,
      trialEndsAt: "2026-01-01T00:00:00.000Z",
      maxInstances: 1,
      canWrite: false,
    });
    const res = await getBillingStatusAction();
    expect(res.ok).toBe(true);
    expect(reqOrg).toHaveBeenCalled();
    expect(reqAdmin).not.toHaveBeenCalled();
  });
});
