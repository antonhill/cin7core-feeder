import type { SupabaseClient } from "@supabase/supabase-js";

export interface DeleteOrgResult {
  ok: boolean;
  error?: string;
}

/**
 * Permanently deletes an organization and everything scoped to it. Every
 * org_id foreign key across the schema is ON DELETE CASCADE (confirmed live
 * 2026-07-09 against every table referencing organizations — instances,
 * products, customers, suppliers, sales, sync state, activity log, etc), so
 * this one row delete is sufficient; no manual per-table cleanup needed.
 * Also best-effort removes the org's logo file(s) from the "org-logos"
 * storage bucket first — that's not a DB foreign key, so the cascade
 * wouldn't touch it, but a failure here doesn't block the actual delete
 * since an orphaned logo file is harmless (just wasted storage).
 *
 * Shared by both the manual admin action (src/app/admin/actions.ts) and the
 * automatic trial-expiry cron (src/app/api/delete-expired-trials/route.ts)
 * so there's exactly one deletion code path to trust.
 */
export async function deleteOrganizationById(db: SupabaseClient, orgId: string): Promise<DeleteOrgResult> {
  try {
    const { data: files } = await db.storage.from("org-logos").list(orgId);
    if (files && files.length > 0) {
      await db.storage.from("org-logos").remove(files.map((f) => `${orgId}/${f.name}`));
    }

    const { error } = await db.from("organizations").delete().eq("id", orgId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
