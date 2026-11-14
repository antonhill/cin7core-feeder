import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstance, type PushScope, type SyncRunSummary } from "@/sync/run-sync";
import { logActivity, type ActivityActor } from "@/lib/activity-log";
import { acquireSyncLock, releaseSyncLock, type SyncLockResult } from "@/lib/sync-lock";
import { acquireSyncRouteLock, releaseSyncRouteLock } from "@/lib/sync-route-lock";
import { MANUAL_PUSH_PROTECTED_MESSAGE, manualPushProtectedInstanceIds, scheduledPushAllowedInstanceIds } from "@/sync/scheduled-push-policy";

export interface InstanceSyncOutcome {
  ok: boolean;
  instanceId: string;
  orgId: string;
  error?: string;
  instanceName?: string;
  productsCreated?: number;
  productsUpdated?: number;
  productsSkipped?: number;
  productsFailureSuppressed?: number;
  productsFailed?: number;
  productionBomsPushed?: number;
  productionBomsFailed?: number;
  customersCreated?: number;
  customersUpdated?: number;
  customersSkipped?: number;
  customersFailed?: number;
  suppliersCreated?: number;
  suppliersUpdated?: number;
  suppliersSkipped?: number;
  suppliersFailed?: number;
  errors?: { sku: string; error: string[]; raw?: string }[];
  /** See SyncRunSummary.truncated — set when a budgetMs cut this instance's push short. */
  truncated?: boolean;
  /**
   * True when this instance was skipped entirely because another sync run
   * already held its advisory lock (Phase 4.3) — not a failure, just
   * deliberately avoided overlap. The next attempt (cron tick or manual
   * retry) picks it up once free.
   */
  skippedLocked?: boolean;
  /**
   * True when the scheduler did not push this instance because it is not listed in CIN7_SCHEDULED_PUSH_INSTANCE_IDS (default-deny). Not a failure and
   * not a retry-later: nothing was read from or written to Cin7 for it. The instance stays connected for every other function.
   */
  skippedNotAuthorised?: boolean;
  /** True when a signed-in user's push was refused because the instance is on CIN7_MANUAL_PUSH_PROTECTED_INSTANCE_IDS. `ok` is false and `error` says why. */
  skippedProtected?: boolean;
}

// Instances used to sync one at a time here, which meant two genuinely
// independent Cin7 accounts' own 60/min budgets (see the per-account keying
// in src/cin7/http.ts) were needlessly serialized — an org's 2 instances
// took roughly 2x as long as either alone. Bounded (not unbounded) since
// /api/sync's cron GET handler calls this with no orgId at all — it syncs
// every active instance across every organization in one call — so
// unbounded concurrency here would mean every org's Cin7 traffic firing
// simultaneously in one Vercel invocation. 5 is a defensive cap for future
// growth: only 5 active instances exist across all orgs today (checked
// 2026-07-11), so this is effectively unbounded right now and only starts
// limiting anything once the tenant base grows well past this.
const MAX_CONCURRENT_INSTANCE_SYNCS = 5;

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving each result's position in the returned array regardless of completion order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** "Pushed 3 products, 1 customer (2 failed)" / "No changes needed" — the activity-log summary for one instance's sync outcome. */
function summarizeSyncOutcome(summary: SyncRunSummary): string {
  const parts: string[] = [];
  const products = summary.productsCreated + summary.productsUpdated;
  if (products > 0) parts.push(`${products} product${products === 1 ? "" : "s"}`);
  const customers = summary.customersCreated + summary.customersUpdated;
  if (customers > 0) parts.push(`${customers} customer${customers === 1 ? "" : "s"}`);
  const suppliers = summary.suppliersCreated + summary.suppliersUpdated;
  if (suppliers > 0) parts.push(`${suppliers} supplier${suppliers === 1 ? "" : "s"}`);
  if (summary.productionBomsPushed > 0) parts.push(`${summary.productionBomsPushed} production BOM${summary.productionBomsPushed === 1 ? "" : "s"}`);

  const failed = summary.productsFailed + summary.customersFailed + summary.suppliersFailed + summary.productionBomsFailed;
  const base = parts.length > 0 ? `Pushed ${parts.join(", ")}` : "No changes needed";
  return failed > 0 ? `${base} (${failed} failed)` : base;
}

/**
 * Syncs active Cin7 instances — every one for the org, or just the given
 * subset (`instanceIds`) when the caller wants to push to specific
 * instances only. Shared by /api/sync (cron + on-demand) and the Import
 * page's "push to Cin7" action so there's one sync-orchestration path.
 * Per-instance failures are caught so one bad instance doesn't stop others.
 *
 * `actor` defaults to "system" — correct for both /api/sync call sites
 * (cron, and the bearer-token-authed on-demand POST), neither of which has
 * a real session user. pushToCin7Action passes the actual signed-in user.
 *
 * Advisory lock (Phase 4.3): those same three call sites (cron tick,
 * on-demand POST, Import wizard push) can race for the SAME (org, instance)
 * — each instance claims a short-lived lock (migration 0057) before its own
 * syncInstance call and releases it in a finally, so an already-in-progress
 * instance is skipped rather than double-scanned/double-pushed by a second
 * concurrent run. Fails open (never blocks a sync on the guard itself) and
 * self-heals via a TTL past Vercel's 300s hard timeout, so a crashed run
 * can't wedge an instance out of every future sync.
 *
 * Route lock (Phase 3.3a): on top of the per-instance lock above, the whole
 * call is ALSO guarded per (org, "sync") — those same three call sites can
 * overlap for a given org before even reaching the per-instance loop,
 * meaning two runs redundantly re-query and re-walk the same instance list.
 * When `orgId` is given (every real caller supplies one), the whole
 * instance list for that org is skipped as a batch rather than starting a
 * second concurrent scan — reusing `skippedLocked` since it's the exact
 * same "still needs work, retry later" semantics a per-instance lock miss
 * already has. The legacy "no orgId, sweep every org" shape (unused by any
 * current caller) proceeds unguarded, since there's no single org to lock.
 */
export async function syncOrgInstances(
  db: SupabaseClient,
  orgId?: string,
  instanceIds?: string[],
  scope: PushScope = {},
  actor: ActivityActor = "system",
  budgetMs?: number
): Promise<InstanceSyncOutcome[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);
  const connectedInstances = (instances ?? []) as { id: string; org_id: string }[];

  // Default-deny (see scheduled-push-policy.ts): the SCHEDULER is the machine actor ("system"), and it may push master data only to instances named in
  // CIN7_SCHEDULED_PUSH_INSTANCE_IDS. A connected (active) instance is not thereby authorised. A signed-in user's Import & Sync push passes a real actor
  // and keeps its own gate (module access + write-eligible plan + AAL2), so the scheduled allow-list is not applied to it. Nothing is logged for an
  // instance the cron denies: it ticks every fifteen minutes and a row per instance per tick would bury the activity log - the denial is visible in the
  // route's JSON instead.
  const scheduled = actor === "system";
  const allowedIds = scheduled ? scheduledPushAllowedInstanceIds() : null;
  // A PROTECTED instance (CIN7_MANUAL_PUSH_PROTECTED_INSTANCE_IDS) receives no master-data push from ANY actor, scheduled or signed-in, until its id is
  // removed from that list. It wins over the scheduled allow-list.
  const protectedIds = manualPushProtectedInstanceIds();
  const isRunnable = (i: { id: string }) => !protectedIds.has(i.id) && (!allowedIds || allowedIds.has(i.id));
  const allInstances = connectedInstances.filter(isRunnable);
  const notAuthorised: InstanceSyncOutcome[] = connectedInstances
    .filter((i) => !isRunnable(i))
    .map((i): InstanceSyncOutcome =>
      protectedIds.has(i.id) && !scheduled
        // A person asked for this push, so say plainly that it was refused (the Import page shows `error` on a failed outcome) rather than reporting success.
        ? { ok: false, instanceId: i.id, orgId: i.org_id, error: MANUAL_PUSH_PROTECTED_MESSAGE, skippedProtected: true }
        : { ok: true, instanceId: i.id, orgId: i.org_id, skippedNotAuthorised: true }
    );
  if (!scheduled) {
    // A refused MANUAL push is rare and deliberate, so it is worth a record (unlike the 15-minute cron denial above).
    for (const o of notAuthorised.filter((n) => n.skippedProtected)) {
      await logActivity(db, { orgId: o.orgId, instanceId: o.instanceId, actor, action: "sync.push_blocked", summary: "Manual master-data push refused: instance is protected" });
    }
  }

  const runInstances = (list: typeof allInstances) =>
    mapWithConcurrency(list, MAX_CONCURRENT_INSTANCE_SYNCS, async (instance): Promise<InstanceSyncOutcome> => {
      let lock: SyncLockResult;
      try {
        lock = await acquireSyncLock(db, instance.org_id, instance.id);
      } catch (e) {
        // Security re-audit round 3, P1-5 (Anton-approved): the sync lock
        // guard fails closed now — an unreachable guard blocks THIS
        // instance's sync (same outcome as any other sync failure below),
        // not the whole batch; other instances in this run are unaffected.
        const errorMessage = e instanceof Error ? e.message : "Unknown error";
        await logActivity(db, {
          orgId: instance.org_id,
          instanceId: instance.id,
          actor,
          action: "sync.push_failed",
          summary: `Sync failed: ${errorMessage}`,
        });
        return { ok: false, instanceId: instance.id, orgId: instance.org_id, error: errorMessage };
      }
      if (!lock.acquired) {
        await logActivity(db, {
          orgId: instance.org_id,
          instanceId: instance.id,
          actor,
          action: "sync.skipped_locked",
          summary: "Sync skipped — another sync is already in progress for this instance",
        });
        return { ok: true, instanceId: instance.id, orgId: instance.org_id, skippedLocked: true };
      }

      try {
        const summary = await syncInstance(db, instance.org_id, instance.id, scope, budgetMs);
        await logActivity(db, {
          orgId: instance.org_id,
          instanceId: instance.id,
          actor,
          action: "sync.push",
          summary: summarizeSyncOutcome(summary),
          detail: { ...summary },
        });
        return { ok: true, orgId: instance.org_id, ...summary };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : "Unknown error";
        await logActivity(db, {
          orgId: instance.org_id,
          instanceId: instance.id,
          actor,
          action: "sync.push_failed",
          summary: `Sync failed: ${errorMessage}`,
        });
        return { ok: false, instanceId: instance.id, orgId: instance.org_id, error: errorMessage };
      } finally {
        await releaseSyncLock(db, instance.org_id, instance.id, lock.lockedAt);
      }
    });

  if (!orgId) return [...(await runInstances(allInstances)), ...notAuthorised];

  // Nothing authorised for this org: no route lock, no Cin7 credential load, no work.
  if (allInstances.length === 0) return notAuthorised;

  const routeLock = await acquireSyncRouteLock(db, "sync", orgId);
  if (!routeLock.acquired) {
    return [...allInstances.map((i) => ({ ok: true, instanceId: i.id, orgId: i.org_id, skippedLocked: true })), ...notAuthorised];
  }
  try {
    return [...(await runInstances(allInstances)), ...notAuthorised];
  } finally {
    await releaseSyncRouteLock(db, "sync", orgId, routeLock.lockedAt);
  }
}
