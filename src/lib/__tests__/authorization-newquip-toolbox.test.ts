import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

import { requireModuleAccess, requireModuleWrite } from "@/lib/authorization";
import { requireCurrentOrg } from "@/lib/current-org";
import { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const NQ = NEWQUIP_POC_ORG_IDS[0];
const reqOrg = vi.mocked(requireCurrentOrg);
const serviceClient = vi.mocked(createServiceRoleClient);
const DENY = "You don't have access to this feature.";

function makeDb(opts: { isSuperAdmin?: boolean; allowedModules?: string[] | null; disabledModules?: string[] }) {
  const { isSuperAdmin = false, allowedModules = null, disabledModules = [] } = opts;
  return {
    from(table: string) {
      const data = table === "super_admins" ? (isSuperAdmin ? { user_id: "u1" } : null) : table === "org_members" ? { allowed_modules: allowedModules } : table === "organizations" ? { disabled_modules: disabledModules } : null;
      const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }) };
      return chain;
    },
  } as unknown as ReturnType<typeof createServiceRoleClient>;
}

const asNewquip = () => reqOrg.mockResolvedValue({ userId: "u1", orgId: NQ, email: "s@newquip.co.za" });
beforeEach(() => { vi.clearAllMocks(); asNewquip(); });

describe("NewQuip-only user: Toolbox modules are default-deny on the server", () => {
  it("Grower actions (no toolbox flag) keep working for every allowed_modules value, including null, [] and an unrelated list", async () => {
    for (const allowed of [null, [], ["/reports"], ["/quotes"]]) {
      serviceClient.mockReturnValue(makeDb({ allowedModules: allowed }));
      await expect(requireModuleAccess("/quotes", { allowDemo: true }), JSON.stringify(allowed)).resolves.toBeTruthy();
      await expect(requireModuleAccess("/projects"), JSON.stringify(allowed)).resolves.toBeTruthy();
    }
  });
  it("the main Toolbox Quotes surface is DENIED with null and with [] (empty never means unrestricted) and with other grants", async () => {
    for (const allowed of [null, [], ["/reports"]]) {
      serviceClient.mockReturnValue(makeDb({ allowedModules: allowed }));
      await expect(requireModuleAccess("/quotes", { toolbox: true }), JSON.stringify(allowed)).rejects.toThrow(DENY);
      await expect(requireModuleWrite("/quotes", { toolbox: true }), JSON.stringify(allowed)).rejects.toThrow(DENY);
    }
  });
  it("is ALLOWED once /quotes is granted, and is denied again as soon as the grant is removed", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/quotes"] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).resolves.toBeTruthy();
    serviceClient.mockReturnValue(makeDb({ allowedModules: [] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).rejects.toThrow(DENY);
  });
  it("any other Toolbox module is denied without its own grant, even with Quotes granted and even when called without the flag", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/quotes"] }));
    for (const href of ["/reports", "/import", "/replenish", "/settings/instances", "/stocktake-assistant"]) await expect(requireModuleAccess(href), href).rejects.toThrow(DENY);
  });
  it("a stray non-grantable value in allowed_modules is never a grant", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/quotes", "/import", "/settings/instances"] }));
    await expect(requireModuleAccess("/import")).rejects.toThrow(DENY);
    await expect(requireModuleAccess("/settings/instances")).rejects.toThrow(DENY);
  });
  it("grants are read per request: removing the grant denies at once (no redeploy)", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/quotes"] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).resolves.toBeTruthy();
    serviceClient.mockReturnValue(makeDb({ allowedModules: [] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).rejects.toThrow(DENY);
  });
  it("an organisation-wide disable still blocks a granted module", async () => {
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/quotes"], disabledModules: ["/quotes"] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).rejects.toThrow(DENY);
  });
  it("a super-admin is not narrowed", async () => {
    serviceClient.mockReturnValue(makeDb({ isSuperAdmin: true, allowedModules: [] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).resolves.toBeTruthy();
  });
});

describe("other organisations are unchanged", () => {
  it("null stays unrestricted and an explicit list still narrows; the toolbox flag changes nothing", async () => {
    reqOrg.mockResolvedValue({ userId: "u1", orgId: "some-other-org", email: "a@b.com" });
    serviceClient.mockReturnValue(makeDb({ allowedModules: null }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).resolves.toBeTruthy();
    await expect(requireModuleAccess("/import")).resolves.toBeTruthy();
    serviceClient.mockReturnValue(makeDb({ allowedModules: ["/reports"] }));
    await expect(requireModuleAccess("/quotes", { toolbox: true })).rejects.toThrow(DENY);
    await expect(requireModuleAccess("/reports")).resolves.toBeTruthy();
  });
});
