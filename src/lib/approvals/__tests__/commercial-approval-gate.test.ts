import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import type { FunctionalRole } from "../roles";

vi.mock("server-only", () => ({}));
import { holdsManagerRoleForCommercialApproval, tierHoldsManagerRole } from "../role-store";

// UAT finding 2026-11-26: "Approve commercial progress" needed the owner/admin tier AND the Manager role, which nobody held (the NewQuip Managers are plain members).
// The correction: in the NewQuip organisation the EXPLICIT Manager role alone decides. These tests pin the intended model and the negative cases, with the real role store.
const NQ = NEWQUIP_POC_ORG_IDS[0];
const OTHER_ORG = "some-other-org";

function setup(members: Array<{ user: string; tier: "owner" | "admin" | "member"; org?: string }>, roles: Array<{ user: string; role: FunctionalRole; org?: string }>) {
  const db = new FakeDb(); db.rolesApplied = true;
  for (const m of members) db.rows("org_members").push({ org_id: m.org ?? NQ, user_id: m.user, role: m.tier });
  for (const r of roles) db.rows("org_functional_roles").push({ id: `${r.user}-${r.role}`, org_id: r.org ?? NQ, user_id: r.user, user_email: `${r.user}@x`, role: r.role, assigned_by_email: "o", assigned_at: "t" });
  return db;
}
const can = (db: FakeDb, user: string, org = NQ) => holdsManagerRoleForCommercialApproval(db as never, org, user);

describe("commercial-progress approval gate (NewQuip)", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = setup(
      [{ user: "mgr", tier: "member" }, { user: "owner", tier: "owner" }, { user: "owner-mgr", tier: "owner" }, { user: "admin", tier: "admin" }, { user: "est", tier: "member" }, { user: "rep", tier: "member" }, { user: "nobody", tier: "member" }],
      [{ user: "mgr", role: "MANAGER" }, { user: "owner", role: "ADMINISTRATOR" }, { user: "owner-mgr", role: "ADMINISTRATOR" }, { user: "owner-mgr", role: "MANAGER" }, { user: "admin", role: "ADMINISTRATOR" }, { user: "est", role: "ESTIMATOR" }, { user: "rep", role: "REP" }],
    );
  });

  it("a Manager who is only an organisation MEMBER can approve (Managers need no administration privilege)", async () => { expect(await can(db, "mgr")).toBe(true); });
  it("an owner who also holds the Manager role can approve (tier preserved)", async () => { expect(await can(db, "owner-mgr")).toBe(true); });
  it("an organisation OWNER without the Manager role cannot", async () => { expect(await can(db, "owner")).toBe(false); });
  it("an organisation ADMIN without the Manager role cannot", async () => { expect(await can(db, "admin")).toBe(false); });
  it("Estimator, Rep and a member with no role cannot", async () => { for (const u of ["est", "rep", "nobody"]) expect(await can(db, u), u).toBe(false); });
  it("an unknown user, or a user with no membership of this organisation, cannot", async () => {
    expect(await can(db, "ghost")).toBe(false);
    db.rows("org_functional_roles").push({ id: "x", org_id: NQ, user_id: "stranger", user_email: "s@x", role: "MANAGER", assigned_by_email: "o", assigned_at: "t" }); // a stray assignment without membership
    expect(await can(db, "stranger")).toBe(false);
  });
  it("a Manager of ANOTHER organisation cannot approve here (cross-organisation access stays blocked)", async () => {
    const x = setup([{ user: "mgr2", tier: "member", org: OTHER_ORG }], [{ user: "mgr2", role: "MANAGER", org: OTHER_ORG }]);
    expect(await can(x, "mgr2")).toBe(false);
    expect(await can(x, "mgr2", OTHER_ORG)).toBe(false); // the helper is NewQuip-only: other organisations keep the unchanged owner/admin-tier rule in the caller
  });
  it("a read failure fails closed", async () => {
    const broken = { from: () => { throw new Error("boom"); } };
    await expect(holdsManagerRoleForCommercialApproval(broken as never, NQ, "mgr")).rejects.toThrow(); // the caller wraps this and refuses
  });
  it("does not touch the other admin-tier gates: the owner-without-Manager is still refused by tierHoldsManagerRole (costs, claim, variation approvals unchanged)", async () => {
    expect(await tierHoldsManagerRole(db as never, NQ, "owner")).toBe(false);
    expect(await tierHoldsManagerRole(db as never, NQ, "owner-mgr")).toBe(true);
  });
});
