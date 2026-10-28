import "server-only";
// Variation BILLING scopes (migration 0105) are internal implementation details of their parent project. Ordinary users never navigate to or
// operate on one directly: they see the parent, whose Variations tab summarises the scopes. An org owner/admin (the authorised internal
// operator) may open and operate a scope, reached from the parent. This is enforced HERE, server-side, by every action that takes a projectId.
import type { createServiceRoleClient } from "@/supabase/server";
import { requireOrgAdmin } from "@/lib/require-org-admin";

type Db = ReturnType<typeof createServiceRoleClient>;

export class BillingScopeAccessError extends Error {
  constructor(public parentProjectId: string | null) {
    super("This is an internal billing scope of a variation, not a separate project. Open the original project instead.");
    this.name = "BillingScopeAccessError";
  }
}

/** The parent project id when `projectId` is a variation billing scope, else null. A missing project is not a scope. */
export async function billingScopeParent(db: Db, orgId: string, projectId: string): Promise<{ isScope: boolean; parentId: string | null }> {
  const r = await db.from("projects").select("*").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (r.error) {
    if (/does not exist|schema cache|column/i.test(r.error.message)) return { isScope: false, parentId: null }; // before migration 0105
    throw new Error(r.error.message);
  }
  const p = r.data as { billing_scope?: string | null; parent_project_id?: string | null } | null;
  const isScope = p?.billing_scope === "VARIATION" || Boolean(p?.parent_project_id);
  return { isScope, parentId: isScope ? p?.parent_project_id ?? null : null };
}

/** Throws unless the project is an ordinary project, or the caller is an authorised internal operator (org owner/admin). */
export async function guardBillingScope(db: Db, orgId: string, projectId: string, canOperateInternally: boolean): Promise<void> {
  if (canOperateInternally) return;
  const s = await billingScopeParent(db, orgId, projectId);
  if (s.isScope) throw new BillingScopeAccessError(s.parentId);
}

/** Whether the caller is an org owner/admin. Fails closed. */
export async function callerIsOrgAdmin(): Promise<boolean> {
  try { await requireOrgAdmin("operate internal billing scopes"); return true; } catch { return false; }
}
