import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  actor: { orgId: "org-nq", userId: "u-mgr", email: "mgr@x.co", tier: "member", roles: new Set(["manager"]), demo: null, activeRole: null } as Record<string, unknown>,
  aal2: vi.fn(), createUser: vi.fn(), listUsers: vi.fn(), addMember: vi.fn(), assign: vi.fn(), audit: vi.fn(),
}));
vi.mock("../actor", () => ({ authoriseActor: async () => h.actor, auditActor: h.audit, errText: (e: unknown) => (e instanceof Error ? e.message : "x") }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: h.aal2 }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({ auth: { admin: { createUser: h.createUser, listUsers: h.listUsers } } }) }));
vi.mock("@/lib/approvals/role-store", () => ({ assignRole: h.assign, addOrdinaryMember: h.addMember, listOrgUsers: async () => [] }));
import { inviteNewquipMemberAction } from "../team-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.roles = new Set(["manager"]); h.actor.tier = "member";
  h.aal2.mockResolvedValue(undefined);
  h.createUser.mockResolvedValue({ data: { user: { id: "u-new" } }, error: null });
  h.addMember.mockResolvedValue(true);
  h.assign.mockResolvedValue(true);
});

describe("inviteNewquipMemberAction", () => {
  it("creates a confirmed account, adds an ordinary member to the SESSION organisation and assigns the chosen role", async () => {
    const r = await inviteNewquipMemberAction(" New@Farm.co.za ", "ESTIMATOR");
    expect(r).toMatchObject({ ok: true, data: { email: "new@farm.co.za", role: "ESTIMATOR", created: true, roleAdded: true } });
    expect(h.createUser).toHaveBeenCalledWith({ email: "new@farm.co.za", email_confirm: true });
    expect(h.addMember).toHaveBeenCalledWith(expect.anything(), "org-nq", "u-new");
    expect(h.assign).toHaveBeenCalledWith(expect.anything(), { canAdminister: true }, "mgr@x.co", { orgId: "org-nq", userId: "u-new", role: "ESTIMATOR" });
    expect(h.audit).toHaveBeenCalled();
  });
  it("an existing account only gains this membership (multi-organisation people are not recreated or changed)", async () => {
    h.createUser.mockResolvedValue({ data: { user: null }, error: { message: "already registered" } });
    h.listUsers.mockResolvedValue({ data: { users: [{ id: "u-old", email: "Old@Spark.co.za" }] }, error: null });
    const r = await inviteNewquipMemberAction("old@spark.co.za", "REP");
    expect(r.data).toMatchObject({ created: false });
    expect(h.addMember).toHaveBeenCalledWith(expect.anything(), "org-nq", "u-old");
  });
  it("a Rep or Estimator cannot invite; nothing is created", async () => {
    h.actor.roles = new Set(["rep"]);
    expect((await inviteNewquipMemberAction("a@b.co", "REP")).error).toMatch(/Only a Manager/);
    expect(h.createUser).not.toHaveBeenCalled();
  });
  it("needs a two-factor session", async () => {
    h.aal2.mockRejectedValue(new Error("Two-factor authentication is required"));
    expect((await inviteNewquipMemberAction("a@b.co", "REP")).error).toMatch(/Two-factor/);
    expect(h.createUser).not.toHaveBeenCalled();
  });
  it("refuses unknown roles (Administrator) and bad emails before touching anything", async () => {
    expect((await inviteNewquipMemberAction("a@b.co", "ADMINISTRATOR")).ok).toBe(false);
    expect((await inviteNewquipMemberAction("not-an-email", "REP")).ok).toBe(false);
    expect(h.createUser).not.toHaveBeenCalled();
  });
  it("an already-member re-invite is reported, not an error", async () => {
    h.addMember.mockResolvedValue(false);
    h.assign.mockResolvedValue(false);
    expect((await inviteNewquipMemberAction("a@b.co", "REP")).data).toMatchObject({ alreadyMember: true, roleAdded: false });
  });
});
