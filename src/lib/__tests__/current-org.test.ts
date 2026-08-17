import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/supabase/server-session", () => ({ createSessionClient: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/org-switch", () => ({ getImpersonatedOrgId: vi.fn() }));
vi.mock("@/lib/active-org", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/active-org")>();
  return { ...actual, getActiveOrgCookie: vi.fn() };
});

import { requireCurrentOrg } from "@/lib/current-org";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { getImpersonatedOrgId } from "@/lib/org-switch";
import { getActiveOrgCookie } from "@/lib/active-org";

const sessionClient = vi.mocked(createSessionClient);
const serviceClient = vi.mocked(createServiceRoleClient);
const impersonatedOrgId = vi.mocked(getImpersonatedOrgId);
const activeOrgCookie = vi.mocked(getActiveOrgCookie);

const USER = { id: "u1", email: "m@b.com" };

function makeSessionClient(opts: { user?: typeof USER | null; membershipOrgIds?: string[] }) {
  const { user = USER, membershipOrgIds = [] } = opts;
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      if (table !== "org_members") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: membershipOrgIds.map((org_id) => ({ org_id })), error: null }),
        }),
      };
    },
  } as unknown as Awaited<ReturnType<typeof createSessionClient>>;
}

function makeServiceClient(opts: { isSuperAdmin?: boolean }) {
  const { isSuperAdmin = false } = opts;
  return {
    from: (table: string) => {
      if (table !== "super_admins") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: isSuperAdmin ? { user_id: USER.id } : null }),
          }),
        }),
      };
    },
  } as unknown as ReturnType<typeof createServiceRoleClient>;
}

beforeEach(() => {
  vi.clearAllMocks();
  impersonatedOrgId.mockResolvedValue(null);
  activeOrgCookie.mockResolvedValue(null);
});

describe("requireCurrentOrg", () => {
  it("throws when not signed in", async () => {
    sessionClient.mockResolvedValue(makeSessionClient({ user: null }));
    serviceClient.mockReturnValue(makeServiceClient({}));
    await expect(requireCurrentOrg()).rejects.toThrow("Not signed in.");
  });

  it("throws when the user has no org membership", async () => {
    sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: [] }));
    serviceClient.mockReturnValue(makeServiceClient({}));
    await expect(requireCurrentOrg()).rejects.toThrow("isn't linked to an organization");
  });

  it("resolves the sole membership with no cookie needed", async () => {
    sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: ["org-1"] }));
    serviceClient.mockReturnValue(makeServiceClient({}));
    await expect(requireCurrentOrg()).resolves.toEqual({ userId: "u1", orgId: "org-1", email: "m@b.com" });
  });

  describe("security re-audit P1-8: multi-org resolution", () => {
    it("uses the active-org cookie when it matches a real membership", async () => {
      sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: ["org-1", "org-2"] }));
      serviceClient.mockReturnValue(makeServiceClient({}));
      activeOrgCookie.mockResolvedValue("org-2");
      await expect(requireCurrentOrg()).resolves.toMatchObject({ orgId: "org-2" });
    });

    it("falls back to the first membership when the cookie doesn't match any real membership", async () => {
      sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: ["org-1", "org-2"] }));
      serviceClient.mockReturnValue(makeServiceClient({}));
      activeOrgCookie.mockResolvedValue("org-not-a-member-of");
      await expect(requireCurrentOrg()).resolves.toMatchObject({ orgId: "org-1" });
    });

    it("falls back to the first membership when there's no cookie at all", async () => {
      sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: ["org-1", "org-2"] }));
      serviceClient.mockReturnValue(makeServiceClient({}));
      activeOrgCookie.mockResolvedValue(null);
      await expect(requireCurrentOrg()).resolves.toMatchObject({ orgId: "org-1" });
    });
  });

  it("a super-admin viewing as an org uses the impersonated org, bypassing membership resolution entirely", async () => {
    sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: [] }));
    serviceClient.mockReturnValue(makeServiceClient({ isSuperAdmin: true }));
    impersonatedOrgId.mockResolvedValue("impersonated-org");
    await expect(requireCurrentOrg()).resolves.toEqual({ userId: "u1", orgId: "impersonated-org", email: "m@b.com" });
  });

  it("a super-admin NOT currently impersonating falls through to their own membership resolution", async () => {
    sessionClient.mockResolvedValue(makeSessionClient({ membershipOrgIds: ["org-1"] }));
    serviceClient.mockReturnValue(makeServiceClient({ isSuperAdmin: true }));
    impersonatedOrgId.mockResolvedValue(null);
    await expect(requireCurrentOrg()).resolves.toMatchObject({ orgId: "org-1" });
  });
});
