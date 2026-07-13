import type { SupabaseClient } from "@supabase/supabase-js";

// Vercel Pro's ceiling for every /api/sync* cron route is 300s (see each
// route's own maxDuration = 300). Bail out with real headroom — the
// in-flight org's own sync can itself take a while, plus this function's
// own upsert + response serialization needs time too.
export const TIME_BUDGET_MS = 260_000;

/**
 * Distinct active org_ids eligible for `syncRoute`, ordered
 * oldest-attempted-first (an org never yet attempted for this route sorts
 * first). Reuses the exact same `cin7_instances.eq("active", true)`
 * eligibility every syncOrg*() function already queries — this is not a new
 * eligibility concept, just deduped to org_ids so rotation can work
 * through orgs rather than instances.
 */
async function eligibleOrgIdsOldestFirst(db: SupabaseClient, syncRoute: string): Promise<string[]> {
  const { data: instances, error: instancesError } = await db.from("cin7_instances").select("org_id").eq("active", true);
  if (instancesError) throw new Error(instancesError.message);

  const orgIds = [...new Set((instances ?? []).map((i: { org_id: string }) => i.org_id))];
  if (orgIds.length === 0) return [];

  const { data: attempts, error: attemptsError } = await db
    .from("sync_route_attempts")
    .select("org_id, last_attempted_at")
    .eq("sync_route", syncRoute)
    .in("org_id", orgIds);
  if (attemptsError) throw new Error(attemptsError.message);

  const lastAttemptedByOrgId = new Map(
    (attempts ?? []).map((a: { org_id: string; last_attempted_at: string | null }) => [a.org_id, a.last_attempted_at])
  );

  // Never-attempted (no row, or a null timestamp) sorts first; otherwise
  // stalest (oldest last_attempted_at) first.
  return orgIds.sort((a, b) => {
    const aAt = lastAttemptedByOrgId.get(a);
    const bAt = lastAttemptedByOrgId.get(b);
    if (!aAt && !bAt) return 0;
    if (!aAt) return -1;
    if (!bAt) return 1;
    return aAt.localeCompare(bAt);
  });
}

/** Marks `orgId` as attempted for `syncRoute` right now — called regardless of that org's sync outcome, so a permanently-broken org doesn't hog priority forever and starve every other org. */
async function markAttempted(db: SupabaseClient, syncRoute: string, orgId: string): Promise<void> {
  const { error } = await db
    .from("sync_route_attempts")
    .upsert({ sync_route: syncRoute, org_id: orgId, last_attempted_at: new Date().toISOString() }, { onConflict: "sync_route,org_id" });
  // Bookkeeping-only — a failed upsert shouldn't fail the whole cron tick
  // (the org's own sync result is what actually matters to the caller).
  if (error) console.error(`sync_route_attempts upsert failed (${syncRoute}, ${orgId}):`, error.message);
}

/**
 * Runs `syncOrg` once per eligible org, oldest-attempted-first, stopping
 * once within TIME_BUDGET_MS of the 300s ceiling so a big org's sync can't
 * push the whole invocation past Vercel's hard timeout — remaining orgs are
 * simply picked up by the next 15-minute cron tick, since they'll now sort
 * to the front (least-recently-attempted) next time. Every attempted org is
 * marked regardless of its sync outcome (success or thrown error) so one
 * permanently-broken org can't monopolize the front of the queue forever.
 *
 * `syncOrg` is expected to already catch its own per-instance failures
 * (every syncOrg* function in src/sync/ does) — this wrapper only guards
 * against `syncOrg` itself throwing, so one org's unexpected failure
 * doesn't stop the rotation from moving on to the next org.
 */
export async function runCronRotation<R>(
  db: SupabaseClient,
  syncRoute: string,
  syncOrg: (orgId: string) => Promise<R[]>
): Promise<R[]> {
  const startedAt = Date.now();
  const orgIds = await eligibleOrgIdsOldestFirst(db, syncRoute);

  const results: R[] = [];
  for (const orgId of orgIds) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) break;

    try {
      results.push(...(await syncOrg(orgId)));
    } catch (e) {
      // syncOrg is expected to catch its own per-instance failures — this
      // guards against syncOrg itself throwing, so one org's unexpected
      // failure doesn't stop rotation from reaching the rest.
      console.error(`runCronRotation: syncOrg threw for org ${orgId} (${syncRoute}):`, e instanceof Error ? e.message : e);
    } finally {
      await markAttempted(db, syncRoute, orgId);
    }
  }

  return results;
}
