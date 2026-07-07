import type { SupabaseClient } from "@supabase/supabase-js";

/** Who performed a write action — "system" covers the scheduled cron sync and any other non-interactive trigger, which has no session user. */
export type ActivityActor = { userId: string; email: string | null } | "system";

export interface LogActivityInput {
  orgId: string;
  instanceId?: string | null;
  actor: ActivityActor;
  action: string;
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * Records a live-write action (Data Audit fixes/merges, sync push) so a
 * client can see what changed, when, and by whom — see Task #33. Deliberately
 * swallows its own errors rather than throwing: a logging failure must never
 * roll back or fail the real operation, which has already succeeded by the
 * time this is called.
 */
export async function logActivity(db: SupabaseClient, input: LogActivityInput): Promise<void> {
  const actorUserId = input.actor === "system" ? null : input.actor.userId;
  const actorEmail = input.actor === "system" ? "System (scheduled sync)" : (input.actor.email ?? "Unknown");

  const { error } = await db.from("activity_log").insert({
    org_id: input.orgId,
    instance_id: input.instanceId ?? null,
    actor_user_id: actorUserId,
    actor_email: actorEmail,
    action: input.action,
    summary: input.summary,
    detail: input.detail ?? null,
  });
  if (error) console.error(`logActivity failed (${input.action}):`, error.message);
}

export interface ActivityLogEntry {
  id: string;
  instanceId: string | null;
  actorEmail: string | null;
  action: string;
  summary: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** Most recent activity for an org, newest first. */
export async function fetchActivityLog(db: SupabaseClient, orgId: string, limit = 100): Promise<ActivityLogEntry[]> {
  const { data, error } = await db
    .from("activity_log")
    .select("id, instance_id, actor_email, action, summary, detail, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    instanceId: row.instance_id,
    actorEmail: row.actor_email,
    action: row.action,
    summary: row.summary,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}
