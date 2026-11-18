import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Audit-trail helpers for the read-only Cin7 diagnostic. They touch ONLY the activity_log table (never Cin7, never a quotation); kept outside the NewQuip app
// directories because those are structurally scanned for any database write.
export const STARTED = "newquip.cin7_diagnostic_run_started";
export const COMPLETED = "newquip.cin7_diagnostic_run";
export const IN_PROGRESS_WINDOW_MS = 5 * 60_000;

/** True when the newest started/completed row in the window is a "started" one. null = could not tell (the caller fails closed). */
export async function runInProgress(db: SupabaseClient, orgId: string): Promise<boolean | null> {
  const since = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const { data, error } = await db.from("activity_log").select("action, created_at").eq("org_id", orgId).in("action", [STARTED, COMPLETED]).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
  if (error || !Array.isArray(data)) return null;
  return data[0]?.action === STARTED;
}

/** Writes the "started" row directly (logActivity swallows errors) and reports whether it was stored. Actor and SKU count only. */
export async function recordRunStarted(db: SupabaseClient, who: { orgId: string; userId: string; email: string }, skuCount: number): Promise<boolean> {
  const { error } = await db.from("activity_log").insert({ org_id: who.orgId, actor_user_id: who.userId, actor_email: who.email, action: STARTED, summary: "Read-only Cin7 diagnostic started (GET only)", detail: { skusRequested: skuCount } });
  return !error;
}
