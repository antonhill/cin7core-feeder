"use server";

// NewQuip: functional roles and approval policies. Authorisation is re-established inside EVERY action: NewQuip organisation + Projects module access, then
// the caller's own roles are resolved on the server. Reading is open to the organisation's members; changing roles, policies or strict roles needs an
// organisation owner/admin or an explicit Administrator. Nothing here calls Cin7. Only async functions and erased types are exported.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import { canAdminister, isFunctionalRole, type FunctionalRole, type PolicySet, type StagePolicy } from "@/lib/approvals/roles";
import { assignRole, listOrgUsers, loadPolicies, removeRole, resolveRoles, rolesAvailable, roleHistory, savePolicy, setStrictRoles, strictRoles, type OrgUser, type RoleEvent } from "@/lib/approvals/role-store";
import type { ApprovalDocType } from "@/lib/approvals/types";

export interface RoleActionResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function actor() {
  const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
  assertNewquipOrg(orgId);
  let adminTier = false;
  try { await requireOrgAdmin("manage NewQuip roles"); adminTier = true; } catch { adminTier = false; } // fail closed
  const db = createServiceRoleClient();
  const roles = await resolveRoles(db, orgId, userId, adminTier);
  return { db, orgId, userId, email: (email ?? "unknown").toLowerCase(), roles, admin: canAdminister(roles, adminTier) };
}

export interface RolesAdminView { available: boolean; canAdminister: boolean; me: string; myRoles: FunctionalRole[]; users: OrgUser[]; policies: PolicySet; strict: boolean; history: RoleEvent[] }

export async function getRolesAdminAction(): Promise<RoleActionResult<RolesAdminView>> {
  try {
    const a = await actor();
    const available = await rolesAvailable(a.db);
    return { ok: true, data: {
      available, canAdminister: a.admin, me: a.email, myRoles: [...a.roles], users: await listOrgUsers(a.db, a.orgId), policies: await loadPolicies(a.db, a.orgId),
      strict: available ? await strictRoles(a.db, a.orgId) : false, history: a.admin ? await roleHistory(a.db, a.orgId) : [],
    } };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function assignRoleAction(userId: string, role: string): Promise<RoleActionResult<null>> {
  try {
    const a = await actor();
    if (!isFunctionalRole(role)) throw new Error("Unknown role.");
    const changed = await assignRole(a.db, { canAdminister: a.admin }, a.email, { orgId: a.orgId, userId, role });
    if (changed) await logActivity(a.db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.role_assigned", summary: `Assigned the ${role} role`, detail: { userId, role } });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function removeRoleAction(userId: string, role: string): Promise<RoleActionResult<null>> {
  try {
    const a = await actor();
    if (!isFunctionalRole(role)) throw new Error("Unknown role.");
    const changed = await removeRole(a.db, { canAdminister: a.admin }, a.email, { orgId: a.orgId, userId, role });
    if (changed) await logActivity(a.db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.role_removed", summary: `Removed the ${role} role`, detail: { userId, role } });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function saveApprovalPolicyAction(docType: ApprovalDocType, stages: StagePolicy[]): Promise<RoleActionResult<null>> {
  try {
    const a = await actor();
    await savePolicy(a.db, { canAdminister: a.admin }, a.email, { orgId: a.orgId, docType, stages });
    await logActivity(a.db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.approval_policy_saved", summary: `Changed the ${docType.toLowerCase()} approval policy`, detail: { docType, stages } });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function setStrictRolesAction(strict: boolean): Promise<RoleActionResult<null>> {
  try {
    const a = await actor();
    await setStrictRoles(a.db, { canAdminister: a.admin }, a.email, { orgId: a.orgId, strict });
    await logActivity(a.db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.strict_roles", summary: strict ? "Switched strict roles ON" : "Switched strict roles OFF", detail: { strict } });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}
