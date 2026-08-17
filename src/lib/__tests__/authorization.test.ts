import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

import { requireModuleAccess, requireModuleWrite } from "@/lib/authorization";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireWriteAllowed } from "@/lib/billing";
import { createServiceRoleClient } from "@/supabase/server";

const reqOrg = vi.mocked(requireCurrentOrg);
const reqWrite = vi.mocked(requireWriteAllowed);
const serviceClient = vi.mocked(createServiceRoleClient);

const MEMBER = { userId: "u1", orgId: "org1", email: "m@b.com" };
const MODULE = "/import"; // an org-toggleable module href from module-nav's MODULES
const DENY = "You don't have access to this feature.";

// Routes super_admins / org_members / organizations reads to fixed rows so the
// REAL computeEffectiveDisabledModules/findBlockedModule get exercised.
function makeDb(opts: {
  isSuperAdmin?: boolean;
  allowedModules?: string[] | null;
  disabledModules?: string[];
  errorOnTable?: "super_admins" | "org_members" | "organizations";
}) {
  const { isSuperAdmin = false, allowedModules = null, disabledModules = [], errorOnTable } = opts;
  return {
    from(table: string) {
      const data =
        table === "super_admins" ? (isSuperAdmin ? { user_id: "u1" } : null)
        : table === "org_members" ? { allowed_modules: allowedModules }
        : table === "organizations" ? { disabled_modules: disabledModules }
        : null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () =>
          table === errorOnTable ? { data: null, error: { message: `${table} read failed` } } : { data, error: null },
      };
      return chain;
    },
  } as unknown as ReturnType<typeof createServiceRoleClient>;
}

beforeEach(() => {
  vi.clearAllMocks();
  reqOrg.mockResolvedValue(MEMBER);
});

describe("requireModuleAccess", () => {
  it("allows a member (no allow-list) when the module isn't disabled", async () => {
    serviceClient.mockReturnValue(makeDb({}));
    await expect(requireModuleAccess(MODULE)).resolves.toEqual(MEMBER);
  });

  it("blocks a member when the org has disabled the module", async () => {
    serviceClient.mockReturnValue(makeDb({ disabledModules: [MODULE] }));
    await expect(requireModuleAccess(MODULE)).rejects.toThrow(DENY);
  });

  it("blocks when the member's allow-list excludes the module", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/reports"] }));
    await expect(requireModuleAccess(MODULE)).rejects.toThrow(DENY);
  });

  it("allows when the member's allow-list includes the module", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: [MODULE, "/reports"] }));
    await expect(requireModuleAccess(MODULE)).resolves.toEqual(MEMBER);
  });

  it("super-admin bypasses a per-user allow-list (no membership row needed)", async () => {
    serviceClient.mockReturnValue(makeDb({ isSuperAdmin: true, allowedModules: [] }));
    await expect(requireModuleAccess(MODULE)).resolves.toEqual(MEMBER);
  });

  it("super-admin is STILL bound by the org's disabled_modules (parity with middleware)", async () => {
    serviceClient.mockReturnValue(makeDb({ isSuperAdmin: true, disabledModules: [MODULE] }));
    await expect(requireModuleAccess(MODULE)).rejects.toThrow(DENY);
  });

  it("allows a non-toggleable href even when unrelated modules are disabled", async () => {
    serviceClient.mockReturnValue(makeDb({ disabledModules: [MODULE] }));
    await expect(requireModuleAccess("/settings/members")).resolves.toEqual(MEMBER);
  });

  it("propagates requireCurrentOrg's throw", async () => {
    reqOrg.mockRejectedValue(new Error("Not signed in."));
    serviceClient.mockReturnValue(makeDb({}));
    await expect(requireModuleAccess(MODULE)).rejects.toThrow("Not signed in.");
  });

  describe("security re-audit P1-1: fails closed (denies) on a Supabase read error, instead of defaulting to unrestricted access", () => {
    it("denies when the super_admins read errors", async () => {
      serviceClient.mockReturnValue(makeDb({ errorOnTable: "super_admins" }));
      await expect(requireModuleAccess(MODULE)).rejects.toThrow("super_admins read failed");
    });

    it("denies when the org_members (allowed_modules) read errors", async () => {
      serviceClient.mockReturnValue(makeDb({ errorOnTable: "org_members" }));
      await expect(requireModuleAccess(MODULE)).rejects.toThrow("org_members read failed");
    });

    it("denies when the organizations (disabled_modules) read errors", async () => {
      serviceClient.mockReturnValue(makeDb({ errorOnTable: "organizations" }));
      await expect(requireModuleAccess(MODULE)).rejects.toThrow("organizations read failed");
    });

    it("a super-admin is unaffected by an org_members error — that query is skipped for them entirely", async () => {
      serviceClient.mockReturnValue(makeDb({ isSuperAdmin: true, errorOnTable: "org_members" }));
      await expect(requireModuleAccess(MODULE)).resolves.toEqual(MEMBER);
    });
  });
});

describe("requireModuleWrite", () => {
  it("requires the write plan on top of module access", async () => {
    serviceClient.mockReturnValue(makeDb({}));
    reqWrite.mockRejectedValue(new Error("read-only during the trial"));
    await expect(requireModuleWrite(MODULE)).rejects.toThrow("read-only during the trial");
    expect(reqWrite).toHaveBeenCalledWith("org1");
  });

  it("passes when both module access and the write plan allow", async () => {
    serviceClient.mockReturnValue(makeDb({}));
    reqWrite.mockResolvedValue(undefined);
    await expect(requireModuleWrite(MODULE)).resolves.toEqual(MEMBER);
  });

  it("does NOT check the write plan when module access is denied", async () => {
    serviceClient.mockReturnValue(makeDb({ disabledModules: [MODULE] }));
    await expect(requireModuleWrite(MODULE)).rejects.toThrow(DENY);
    expect(reqWrite).not.toHaveBeenCalled();
  });
});
