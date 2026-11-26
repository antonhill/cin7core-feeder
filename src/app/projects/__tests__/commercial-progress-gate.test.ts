// recordProgressAction: the commercial-approval gate after the 2026-11-26 correction. NewQuip: the explicit Manager role decides (member or admin tier); an admin without it,
// an unknown user and another organisation are refused BEFORE anything is written. Other organisations keep the owner/admin-tier rule. Physical progress needs no approval right.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { holdsManagerRoleForCommercialApproval } from "@/lib/approvals/role-store";
import { recordProgress } from "@/lib/projects/project-store";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { getProjectAction, recordProgressAction } from "../actions";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/approvals/role-store", async (orig) => ({ ...(await orig<typeof import("@/lib/approvals/role-store")>()), holdsManagerRoleForCommercialApproval: vi.fn(), tierHoldsManagerRole: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/scope-access", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/scope-access")>()), guardBillingScope: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/project-store", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/project-store")>()), recordProgress: vi.fn(() => Promise.resolve()), loadProjectView: vi.fn(() => Promise.resolve({ project: { id: "p1" }, variations: [], claims: [], stages: [] })) }));

const NQ = { orgId: NEWQUIP_POC_ORG_IDS[0], userId: "u1", email: "u@x" };
const OTHER = { orgId: "some-other-org", userId: "u1", email: "u@x" };

describe("recordProgressAction: commercial approval gate", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("NewQuip: a Manager (member tier, no organisation-admin right) can approve commercial progress", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin")); // not an admin
    vi.mocked(holdsManagerRoleForCommercialApproval).mockResolvedValue(true);
    const r = await recordProgressAction("p1", "s1", "0", "100", "reason");
    expect(r.ok).toBe(true);
    expect(recordProgress).toHaveBeenCalledTimes(1);
  });
  it("NewQuip: an organisation admin/owner WITHOUT the Manager role is refused, and nothing is written", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never);
    vi.mocked(requireOrgAdmin).mockResolvedValue(NQ as never); // admin tier alone must not be enough
    vi.mocked(holdsManagerRoleForCommercialApproval).mockResolvedValue(false);
    const r = await recordProgressAction("p1", "s1", "0", "100", "reason");
    expect(r).toMatchObject({ ok: false, error: "This needs the Manager role." });
    expect(recordProgress).not.toHaveBeenCalled();
  });
  it("NewQuip: a failing role lookup fails closed", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never);
    vi.mocked(holdsManagerRoleForCommercialApproval).mockRejectedValue(new Error("db down"));
    const r = await recordProgressAction("p1", "s1", "0", "100", "reason");
    expect(r.ok).toBe(false);
    expect(recordProgress).not.toHaveBeenCalled();
  });
  it("NewQuip: physical progress needs no approval right", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never);
    vi.mocked(holdsManagerRoleForCommercialApproval).mockResolvedValue(false);
    const r = await recordProgressAction("p1", "s1", "50", null, "site report");
    expect(r.ok).toBe(true);
    expect(holdsManagerRoleForCommercialApproval).not.toHaveBeenCalled();
  });
  it("another organisation: unchanged - an owner/admin may approve, a plain member may not, and the NewQuip Manager check is never consulted", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(OTHER as never);
    vi.mocked(requireOrgAdmin).mockResolvedValue(OTHER as never);
    expect((await recordProgressAction("p1", "s1", "0", "100", "reason")).ok).toBe(true);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin"));
    const denied = await recordProgressAction("p1", "s1", "0", "100", "reason");
    expect(denied).toMatchObject({ ok: false, error: "Only an org owner or admin can approve commercial completion." });
    expect(holdsManagerRoleForCommercialApproval).not.toHaveBeenCalled();
    expect(recordProgress).toHaveBeenCalledTimes(1);
  });

  it("getProjectAction viewer.canApproveCommercial (display only): true for a member-tier Manager, false for an admin without the role, per the same server rule as the action", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue(NQ as never);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin"));
    vi.mocked(holdsManagerRoleForCommercialApproval).mockResolvedValue(true);
    expect((await getProjectAction("p1")).viewer?.canApproveCommercial).toBe(true);
    vi.mocked(requireOrgAdmin).mockResolvedValue(NQ as never);
    vi.mocked(holdsManagerRoleForCommercialApproval).mockResolvedValue(false);
    expect((await getProjectAction("p1")).viewer?.canApproveCommercial).toBe(false);
    vi.mocked(holdsManagerRoleForCommercialApproval).mockRejectedValue(new Error("db down"));
    expect((await getProjectAction("p1")).viewer?.canApproveCommercial).toBe(false); // fails closed
    vi.mocked(requireModuleAccess).mockResolvedValue(OTHER as never);
    vi.mocked(requireOrgAdmin).mockResolvedValue(OTHER as never);
    expect((await getProjectAction("p1")).viewer?.canApproveCommercial).toBe(true); // other organisations: owner/admin tier, unchanged
  });
  // Known, intended limits (reviewed 2026-11-26): internal variation billing scopes and cost redaction still use isAdmin() (admin tier AND Manager), so a member-tier Manager
  // fails closed there; the role-switch (Rep/Estimator-mode) narrowing is covered by role-switch.test.ts, not re-tested here.
});
