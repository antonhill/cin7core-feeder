import { describe, expect, it, vi, beforeEach } from "vitest";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireCurrentOrg } from "@/lib/current-org";
import { createServiceRoleClient } from "@/supabase/server";

vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

const CURRENT = { userId: "u1", orgId: "org1", email: "a@b.c" };

/** Stands in for the two chains requireOrgAdmin issues: super_admins (select.eq.maybeSingle)
 *  and org_members (select.eq.eq.maybeSingle). */
function fakeDb({ isSuperAdmin = false, role = null as string | null }) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_c1: string, v1: unknown) => {
          if (table === "super_admins") {
            return { maybeSingle: async () => ({ data: isSuperAdmin ? { user_id: v1 } : null, error: null }) };
          }
          return { eq: () => ({ maybeSingle: async () => ({ data: role ? { role } : null, error: null }) }) };
        },
      }),
    }),
  };
}

beforeEach(() => {
  vi.mocked(requireCurrentOrg).mockResolvedValue(CURRENT);
});

describe("requireOrgAdmin", () => {
  it("allows an owner", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ role: "owner" }) as never);
    await expect(requireOrgAdmin("manage Cin7 instances")).resolves.toEqual(CURRENT);
  });

  it("allows an admin", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ role: "admin" }) as never);
    await expect(requireOrgAdmin()).resolves.toEqual(CURRENT);
  });

  it("rejects an ordinary member", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ role: "member" }) as never);
    await expect(requireOrgAdmin("manage Cin7 instances")).rejects.toThrow(/owner or admin can manage Cin7 instances/);
  });

  it("rejects a user with no membership row in this org", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ role: null }) as never);
    await expect(requireOrgAdmin()).rejects.toThrow(/owner or admin/);
  });

  it("allows a super-admin regardless of org role (incl. while impersonating)", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ isSuperAdmin: true }) as never);
    await expect(requireOrgAdmin()).resolves.toEqual(CURRENT);
  });

  it("surfaces the action name in the denial message", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ role: "member" }) as never);
    await expect(requireOrgAdmin("delete Cin7 instances")).rejects.toThrow("delete Cin7 instances");
  });
});
