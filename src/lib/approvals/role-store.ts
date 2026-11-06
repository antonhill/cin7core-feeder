import "server-only";
// Organisation-scoped functional roles and approval policies (migration 0112). Reads report "unavailable" (never "no roles") until the migration is applied, and
// every caller then keeps the Phase H tier behaviour. All writes are transactional database functions that also append the audit history.
import type { createServiceRoleClient } from "@/supabase/server";
import { DEFAULT_POLICIES, effectiveRoles, isFunctionalRole, validatePolicy, type FunctionalRole, type PolicySet, type StagePolicy } from "./roles";
import type { ApprovalDocType } from "./types";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const missing = (m: string) => /does not exist|schema cache|relation|function .* does not exist|Could not find the function/i.test(m);
const PENDING = "Roles and approval policies are not available yet (database migration pending).";

export interface RoleAssignment { id: string; org_id: string; user_id: string; user_email: string; role: FunctionalRole; assigned_by_email: string; assigned_at: string }
export interface RoleEvent { id: string; user_id: string; user_email: string; role: string; action: "ASSIGNED" | "REMOVED"; actor_email: string; created_at: string }

/** Staged approvals and roles are available once migration 0112 is applied. */
export async function rolesAvailable(db: Db): Promise<boolean> {
  const r = await db.from("org_functional_roles").select("id").limit(1);
  if (!r.error) return true;
  if (missing(r.error.message)) return false;
  fail(`roles: ${r.error.message}`);
}

export async function listAssignments(db: Db, orgId: string): Promise<RoleAssignment[] | null> {
  const r = await db.from("org_functional_roles").select("*").eq("org_id", orgId);
  if (r.error) { if (missing(r.error.message)) return null; fail(r.error.message); }
  return ((r.data ?? []) as RoleAssignment[]).filter((a) => isFunctionalRole(a.role));
}

export async function strictRoles(db: Db, orgId: string): Promise<boolean> {
  const r = await db.from("approval_settings").select("roles_enforced").eq("org_id", orgId).maybeSingle();
  if (r.error || !r.data) return false;
  return !!(r.data as { roles_enforced?: boolean }).roles_enforced;
}

/** The roles this person effectively holds in the organisation (server-side; never trusted from the client). */
export async function resolveRoles(db: Db, orgId: string, userId: string, adminTier: boolean): Promise<ReadonlySet<FunctionalRole>> {
  const all = await listAssignments(db, orgId);
  if (all === null) return effectiveRoles([], adminTier, false);
  return effectiveRoles(all.filter((a) => a.user_id === userId).map((a) => a.role), adminTier, await strictRoles(db, orgId));
}

/**
 * May this person see estimated costs and margins and make audited cost overrides? An organisation owner/admin, or someone EXPLICITLY given the Estimator or
 * Manager role. The tier fallback never grants it (otherwise every member would see cost), and Procurement / Rep / Project Manager / Administrator alone do not.
 */
export async function canSeeCosts(db: Db, orgId: string, userId: string, adminTier: boolean): Promise<boolean> {
  if (adminTier) return true;
  const all = await listAssignments(db, orgId);
  return !!all && all.some((a) => a.user_id === userId && (a.role === "ESTIMATOR" || a.role === "MANAGER"));
}

export interface OrgUser { userId: string; email: string; tier: "owner" | "admin" | "member"; roles: FunctionalRole[] }

export async function listOrgUsers(db: Db, orgId: string): Promise<OrgUser[]> {
  const m = await db.from("org_members").select("user_id, role").eq("org_id", orgId);
  if (m.error) fail(m.error.message);
  const assignments = (await listAssignments(db, orgId)) ?? [];
  const out: OrgUser[] = [];
  for (const row of (m.data ?? []) as Array<{ user_id: string; role: string }>) {
    const u = await db.auth.admin.getUserById(row.user_id);
    const email = u.data?.user?.email?.toLowerCase();
    if (!email) continue;
    out.push({ userId: row.user_id, email, tier: row.role === "owner" ? "owner" : row.role === "admin" ? "admin" : "member", roles: assignments.filter((a) => a.user_id === row.user_id).map((a) => a.role) });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/** Emails of the people who can act at a stage: explicit holders of the role, or (strict roles OFF and nobody holds it yet) the Phase H tier default. */
export async function emailsWithRole(db: Db, orgId: string, role: FunctionalRole): Promise<string[]> {
  const users = await listOrgUsers(db, orgId);
  const strict = await strictRoles(db, orgId);
  const holders = users.filter((u) => effectiveRoles(u.roles, u.tier !== "member", strict).has(role)).map((u) => u.email);
  return holders;
}

export async function assignRole(db: Db, gates: { canAdminister: boolean }, actorEmail: string, input: { orgId: string; userId: string; role: FunctionalRole }): Promise<boolean> {
  if (!gates.canAdminister) fail("Only an administrator can assign roles.");
  if (!isFunctionalRole(input.role)) fail("Unknown role.");
  const u = await db.auth.admin.getUserById(input.userId);
  const email = u.data?.user?.email;
  if (!email) fail("That user could not be found.");
  const r = await db.rpc("org_role_assign", { p_org: input.orgId, p_user: input.userId, p_email: email, p_role: input.role, p_actor: actorEmail });
  if (r.error) fail(missing(r.error.message) ? PENDING : r.error.message.replace(/^org_role: /, ""));
  return r.data === true;
}

export async function removeRole(db: Db, gates: { canAdminister: boolean }, actorEmail: string, input: { orgId: string; userId: string; role: FunctionalRole }): Promise<boolean> {
  if (!gates.canAdminister) fail("Only an administrator can remove roles.");
  const r = await db.rpc("org_role_remove", { p_org: input.orgId, p_user: input.userId, p_role: input.role, p_actor: actorEmail });
  if (r.error) fail(missing(r.error.message) ? PENDING : r.error.message);
  return r.data === true;
}

export async function roleHistory(db: Db, orgId: string, limit = 100): Promise<RoleEvent[]> {
  const r = await db.from("org_functional_role_events").select("*").eq("org_id", orgId);
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return ((r.data ?? []) as RoleEvent[]).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

// ── policies ────────────────────────────────────────────────────────────────

export async function loadPolicies(db: Db, orgId: string): Promise<PolicySet> {
  const r = await db.from("approval_policies").select("*").eq("org_id", orgId);
  const out: PolicySet = { QUOTE: [...DEFAULT_POLICIES.QUOTE], CLAIM: [...DEFAULT_POLICIES.CLAIM], VARIATION: [...DEFAULT_POLICIES.VARIATION] };
  if (r.error) { if (missing(r.error.message)) return out; fail(r.error.message); }
  for (const row of (r.data ?? []) as Array<{ doc_type: ApprovalDocType; stages: StagePolicy[] }>) {
    if (validatePolicy(row.doc_type, row.stages).length === 0) out[row.doc_type] = row.stages.map((s) => ({ stage: s.stage, role: s.role, approverEmail: s.approverEmail ? s.approverEmail.toLowerCase() : null }));
  }
  return out;
}

export async function savePolicy(db: Db, gates: { canAdminister: boolean }, actorEmail: string, input: { orgId: string; docType: ApprovalDocType; stages: StagePolicy[] }): Promise<void> {
  if (!gates.canAdminister) fail("Only an administrator can change approval policies.");
  const stages = input.stages.map((s) => ({ stage: s.stage, role: s.role, approverEmail: s.approverEmail ? s.approverEmail.trim().toLowerCase() : null }));
  const errors = validatePolicy(input.docType, stages);
  if (errors.length) fail(errors.join(" "));
  // A named approver must actually be able to act at that stage.
  for (const s of stages) {
    if (!s.approverEmail) continue;
    if (!(await emailsWithRole(db, input.orgId, s.role)).includes(s.approverEmail)) fail(`${s.approverEmail} does not hold the ${s.role.toLowerCase().replace("_", " ")} role, so cannot be the named approver for that stage.`);
  }
  const r = await db.rpc("approval_policy_save", { p_org: input.orgId, p_doc_type: input.docType, p_stages: stages, p_actor: actorEmail });
  if (r.error) fail(missing(r.error.message) ? PENDING : r.error.message.replace(/^approval_policy: /, ""));
}

export async function setStrictRoles(db: Db, gates: { canAdminister: boolean }, actorEmail: string, input: { orgId: string; strict: boolean }): Promise<void> {
  if (!gates.canAdminister) fail("Only an administrator can change this setting.");
  if (input.strict) {
    const a = (await listAssignments(db, input.orgId)) ?? [];
    if (!a.some((x) => x.role === "MANAGER")) fail("Assign the Manager role to at least one person before switching on strict roles, or nobody could approve.");
    if (!a.some((x) => x.role === "ESTIMATOR")) fail("Assign the Estimator role to at least one person before switching on strict roles, or no quotation could be signed off.");
  }
  const r = await db.from("approval_settings").upsert({ org_id: input.orgId, roles_enforced: input.strict, updated_by_email: actorEmail, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
  if (r.error) fail(r.error.message);
}
