import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requirePrivilegedOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

import { setTeamMemberModulesAction, listTeamMembersAction, listModuleAuditAction } from "../actions";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requirePrivilegedOrgAdmin } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const NQ = NEWQUIP_POC_ORG_IDS[0];
const OTHER_ORG = "11111111-1111-1111-1111-111111111111";
const ADMIN = { userId: "admin-1", orgId: NQ, email: "admin@newquip.co.za" };
const SHIRNEL = "shirnel-1";

interface Fx { members: { org_id: string; user_id: string; role: string; allowed_modules: string[] | null }[]; rpc: ReturnType<typeof vi.fn>; audit: unknown[] }
function makeDb(fx: Fx) {
  return {
    from(table: string) {
      if (table === "org_members") {
        const f: Record<string, string> = {};
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (k: string, v: string) => { f[k] = v; return chain; },
          maybeSingle: async () => ({ data: fx.members.find((m) => m.org_id === f.org_id && m.user_id === f.user_id) ? { user_id: f.user_id } : null, error: null }),
          then: (res: (v: unknown) => void) => res({ data: fx.members.filter((m) => m.org_id === f.org_id), error: null }),
        };
        return chain;
      }
      if (table === "org_member_module_audit") {
        const f: Record<string, string> = {};
        const chain: Record<string, unknown> = { select: () => chain, eq: (k: string, v: string) => { f[k] = v; return chain; }, order: () => chain, limit: async () => ({ data: fx.audit, error: null }) };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: fx.rpc,
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@x.test` } } }) } },
  } as unknown as ReturnType<typeof createServiceRoleClient>;
}

let fx: Fx;
beforeEach(() => {
  vi.clearAllMocks();
  fx = { members: [{ org_id: NQ, user_id: SHIRNEL, role: "member", allowed_modules: null }, { org_id: NQ, user_id: "admin-1", role: "owner", allowed_modules: null }, { org_id: OTHER_ORG, user_id: "other-1", role: "member", allowed_modules: null }], rpc: vi.fn(async () => ({ error: null })), audit: [] };
  vi.mocked(createServiceRoleClient).mockReturnValue(makeDb(fx));
  vi.mocked(requirePrivilegedOrgAdmin).mockResolvedValue(ADMIN);
  vi.mocked(requireOrgAdmin).mockResolvedValue(ADMIN);
});

describe("setTeamMemberModulesAction (NewQuip organisation)", () => {
  it("grants Quotes through the audited RPC with the actor, the org from the SESSION and the target's email", async () => {
    expect(await setTeamMemberModulesAction(SHIRNEL, ["/quotes"])).toEqual({ ok: true });
    expect(fx.rpc).toHaveBeenCalledWith("set_member_modules", { p_org_id: NQ, p_user_id: SHIRNEL, p_modules: ["/quotes"], p_actor_user_id: "admin-1", p_actor_email: "admin@newquip.co.za", p_target_email: `${SHIRNEL}@x.test` });
  });
  it("disabling everything stores an explicit empty list, and a null request is also stored as [] (never unrestricted)", async () => {
    await setTeamMemberModulesAction(SHIRNEL, []);
    await setTeamMemberModulesAction(SHIRNEL, null);
    expect(fx.rpc.mock.calls.map((c) => (c[1] as { p_modules: unknown }).p_modules)).toEqual([[], []]);
  });
  it("rejects unknown modules and NewQuip's own Projects key as a grant, writing nothing", async () => {
    expect((await setTeamMemberModulesAction(SHIRNEL, ["/typo"])).ok).toBe(false);
    expect((await setTeamMemberModulesAction(SHIRNEL, ["/projects"])).ok).toBe(false);
    expect((await setTeamMemberModulesAction(SHIRNEL, ["/quotes", "/import"])).ok).toBe(false); // real module, not reviewed as grantable for NewQuip users
    expect(fx.rpc).not.toHaveBeenCalled();
  });
  it("an administrator cannot change their OWN Toolbox access", async () => {
    const r = await setTeamMemberModulesAction("admin-1", ["/quotes"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/own Toolbox access/);
    expect(fx.rpc).not.toHaveBeenCalled();
  });
  it("cannot reach a member of ANOTHER organisation, whatever id is supplied", async () => {
    const r = await setTeamMemberModulesAction("other-1", ["/quotes"]);
    expect(r.ok).toBe(false);
    expect(fx.rpc).not.toHaveBeenCalled();
  });
  it("a non-admin is refused before anything is read or written", async () => {
    vi.mocked(requirePrivilegedOrgAdmin).mockRejectedValue(new Error("Admin only"));
    expect((await setTeamMemberModulesAction(SHIRNEL, ["/quotes"])).ok).toBe(false);
    expect(fx.rpc).not.toHaveBeenCalled();
  });
  it("a failed audited write reports failure (no silent partial change)", async () => {
    fx.rpc.mockResolvedValue({ error: { message: "boom" } });
    expect(await setTeamMemberModulesAction(SHIRNEL, ["/quotes"])).toEqual({ ok: false, error: "boom" });
  });
});

describe("setTeamMemberModulesAction (other organisations keep their behaviour)", () => {
  it("null still means unrestricted and self-service is not newly blocked", async () => {
    vi.mocked(requirePrivilegedOrgAdmin).mockResolvedValue({ userId: "other-1", orgId: OTHER_ORG, email: "o@x.test" });
    expect(await setTeamMemberModulesAction("other-1", null)).toEqual({ ok: true });
    expect((fx.rpc.mock.calls[0][1] as { p_modules: unknown }).p_modules).toBeNull();
  });
});

describe("listing", () => {
  it("flags the NewQuip organisation and the caller; the audit list is scoped to the session org", async () => {
    fx.audit = [{ id: "a1", target_email: "s@x", actor_email: "a@x", previous_modules: null, new_modules: ["/quotes"], changed_at: "2026-11-27T08:00:00Z" }];
    const l = await listTeamMembersAction();
    expect(l.ok && l.newquipOnly).toBe(true);
    expect(l.callerUserId).toBe("admin-1");
    expect(l.members?.map((m) => m.userId).sort()).toEqual(["admin-1", SHIRNEL].sort());
    const a = await listModuleAuditAction();
    expect(a.entries?.[0]).toMatchObject({ targetEmail: "s@x", actorEmail: "a@x", newModules: ["/quotes"] });
  });
});
