import { describe, expect, it, vi, beforeEach } from "vitest";
import { requirePrivilegedOrgAdmin, requirePrivilegedSuperAdmin } from "@/lib/require-privileged";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";

vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/require-super-admin", () => ({ requireSuperAdmin: vi.fn() }));
vi.mock("@/supabase/server-session", () => ({ createSessionClient: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

const CURRENT_ORG = { userId: "u1", orgId: "org1", email: "a@b.c" };
const CURRENT_SUPER = { userId: "u1" };

function fakeSessionClient(aal: { currentLevel: string; nextLevel: string } | null, error: { message: string } | null = null) {
  return { auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal, error }) } } };
}

/** Stands in for the two chains requirePrivilegedOrgAdmin issues: super_admins and organizations, both select.eq.maybeSingle. */
function fakeDb({ isSuperAdmin = false, subscriptionStatus = "active" as string | null }) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, v: unknown) => ({
          maybeSingle: async () => {
            if (table === "super_admins") return { data: isSuperAdmin ? { user_id: v } : null };
            if (table === "organizations") return { data: subscriptionStatus ? { subscription_status: subscriptionStatus } : null };
            return { data: null };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(CURRENT_ORG);
  vi.mocked(requireSuperAdmin).mockReset().mockResolvedValue(CURRENT_SUPER);
  vi.mocked(createSessionClient).mockReset();
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue(fakeDb({ subscriptionStatus: "active" }) as never);
});

describe("requirePrivilegedOrgAdmin", () => {
  it("passes for an org admin on a paid (write-allowed) org currently at aal2", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal2", nextLevel: "aal2" }) as never);
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).resolves.toEqual(CURRENT_ORG);
  });

  it("rejects an org admin who never enrolled a factor at all (currentLevel/nextLevel both aal1)", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal1", nextLevel: "aal1" }) as never);
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).rejects.toThrow(/Two-factor authentication is required/);
  });

  it("rejects an org admin who enrolled a factor but hasn't stepped up THIS session (currentLevel aal1, nextLevel aal2) — the exact case middleware's page-redirect can't cover for a direct Server Action call", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal1", nextLevel: "aal2" }) as never);
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).rejects.toThrow(/Two-factor authentication is required/);
  });

  it("rejects before ever checking AAL2 when the underlying role check itself fails (not an org admin at all)", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can manage Cin7 instances."));
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).rejects.toThrow(/owner or admin/);
    expect(createSessionClient).not.toHaveBeenCalled();
  });

  it("surfaces the action name in the AAL2 denial message", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal1", nextLevel: "aal1" }) as never);
    await expect(requirePrivilegedOrgAdmin("delete a Cin7 instance")).rejects.toThrow("delete a Cin7 instance");
  });

  it("fails closed (throws, not silently passes) when the AAL read itself errors", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient(null, { message: "session expired" }) as never);
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).rejects.toThrow(/Could not verify two-factor authentication status/);
  });

  it("a super-admin passing requireOrgAdmin's own role escape hatch is still held to the AAL2 bar, even on a trialing org", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ isSuperAdmin: true, subscriptionStatus: "trialing" }) as never);
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal1", nextLevel: "aal1" }) as never);
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).rejects.toThrow(/Two-factor authentication is required/);
  });

  it("mirrors middleware's own trial-org exemption: an ordinary owner/admin on a TRIALING org is NOT required to have AAL2 — matches middleware's Phase 1.5 not forcing enrolment for read-only trials", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ isSuperAdmin: false, subscriptionStatus: "trialing" }) as never);
    // No AAL2 mock configured at all — if the guard incorrectly required it, this would throw on the missing mock/undefined data.
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).resolves.toEqual(CURRENT_ORG);
    expect(createSessionClient).not.toHaveBeenCalled();
  });

  it("requires AAL2 once a trial org upgrades to an active/paid plan", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ isSuperAdmin: false, subscriptionStatus: "active" }) as never);
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal1", nextLevel: "aal1" }) as never);
    await expect(requirePrivilegedOrgAdmin("manage Cin7 instances")).rejects.toThrow(/Two-factor authentication is required/);
  });
});

describe("requirePrivilegedSuperAdmin", () => {
  it("passes for a super-admin currently at aal2", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal2", nextLevel: "aal2" }) as never);
    await expect(requirePrivilegedSuperAdmin("delete this organization")).resolves.toEqual(CURRENT_SUPER);
  });

  it("rejects a super-admin not currently at aal2", async () => {
    vi.mocked(createSessionClient).mockResolvedValue(fakeSessionClient({ currentLevel: "aal1", nextLevel: "aal2" }) as never);
    await expect(requirePrivilegedSuperAdmin("delete this organization")).rejects.toThrow(/Two-factor authentication is required/);
  });

  it("rejects before ever checking AAL2 when the underlying super-admin check itself fails", async () => {
    vi.mocked(requireSuperAdmin).mockRejectedValue(new Error("Not authorized."));
    await expect(requirePrivilegedSuperAdmin("delete this organization")).rejects.toThrow(/Not authorized/);
    expect(createSessionClient).not.toHaveBeenCalled();
  });
});
