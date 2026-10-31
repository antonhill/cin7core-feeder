"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { ACTIVITY_MODULE } from "@/app/module-nav";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { fetchActivityLog, type ActivityLogEntry } from "@/lib/activity-log";
import { activityVisible, quoteScope } from "@/lib/newquip-assignments/access";

export interface ActivityActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ActivityLogRow extends ActivityLogEntry {
  instanceName: string | null;
}

/** The current org's activity log, newest first, with each entry's instance ID resolved to its name for display. */
export async function listActivityAction(): Promise<ActivityActionResult<ActivityLogRow[]>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(ACTIVITY_MODULE.href);
    const db = createServiceRoleClient();
    let tier = "member";
    try { await requireOrgAdmin("view the activity log"); tier = "admin"; } catch { tier = "member"; } // fail closed
    // Rep isolation (Slice 1B): NewQuip / approvals / projects entries follow the quotation scope; Toolbox entries (sync, instance, audit...) are unchanged.
    const scope = await quoteScope(db, { orgId, userId, email: email ?? "", tier });
    const entries = (await fetchActivityLog(db, orgId)).filter((e) => activityVisible(scope, e.action));

    const instanceIds = [...new Set(entries.map((e) => e.instanceId).filter((id): id is string => Boolean(id)))];
    const nameById = new Map<string, string>();
    if (instanceIds.length) {
      const { data } = await db.from("cin7_instances").select("id, name").in("id", instanceIds);
      for (const row of data ?? []) nameById.set(row.id, row.name);
    }

    const rows: ActivityLogRow[] = entries.map((e) => ({
      ...e,
      instanceName: e.instanceId ? (nameById.get(e.instanceId) ?? null) : null,
    }));
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
