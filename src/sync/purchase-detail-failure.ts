import type { SupabaseClient } from "@supabase/supabase-js";
import { logActivity, DIAGNOSTIC_ACTION_PREFIX } from "@/lib/activity-log";
import { Cin7ApiError } from "@/cin7/http";
import { ReceiptLineConflictError } from "@/cin7/purchase-detail";

/** Persisted via the existing activity_log (no migration). `diagnostic.` prefix keeps it distinguishable from the live-write audit actions. */
export const PURCHASE_DETAIL_FAILURE_ACTION = `${DIAGNOSTIC_ACTION_PREFIX}purchase_detail_sync_failed`;

export const PURCHASE_REFRESH_REJECTED_ACTION = `${DIAGNOSTIC_ACTION_PREFIX}purchase_refresh_rejected`;
/** A previously populated PO returned empty order lines: SUSPECTED void at source — never confirmed, never written as a status. */
export const PURCHASE_LIKELY_VOIDED_ACTION = `${DIAGNOSTIC_ACTION_PREFIX}purchase_likely_voided_at_source`;
/** A refresh found quantities different from the cache WITHOUT Cin7 having relisted the PO (evidence about LastUpdatedDate reliability). */
export const PURCHASE_REFRESH_CHANGED_ACTION = `${DIAGNOSTIC_ACTION_PREFIX}purchase_refresh_changed_without_relist`;
/** Receipt lines Cin7 returned with no CardID (not persisted — instrumentation only). */
export const RECEIPT_LINES_WITHOUT_CARDID_ACTION = `${DIAGNOSTIC_ACTION_PREFIX}receipt_lines_without_cardid`;

/** A PO that keeps failing is recorded at most once per window, not once per sync cycle (~96/day). */
export const FAILURE_LOG_WINDOW_HOURS = 24;

export interface SanitisedSyncError {
  code: "receipt_line_conflict" | "duplicate_key" | "cin7_api" | "database" | "unknown";
  message: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * Reduces an error to something safe to persist and show: no UUIDs, no long
 * tokens (keys/ids), no key=value DETAIL fragments, bounded length. The
 * Postgres duplicate-key class is recognised and named by its constraint.
 */
export function sanitiseSyncError(e: unknown): SanitisedSyncError {
  const raw = e instanceof Error ? e.message : String(e);
  const clean = (t: string) => t.replace(UUID, "<id>").replace(LONG_TOKEN, "<redacted>").replace(/\s+/g, " ").trim().slice(0, 240);

  if (e instanceof ReceiptLineConflictError) return { code: "receipt_line_conflict", message: clean(e.message) };
  const dup = /duplicate key value violates unique constraint "([a-z0-9_]+)"/i.exec(raw);
  if (dup) return { code: "duplicate_key", message: `Duplicate key on ${dup[1]}` };
  if (e instanceof Cin7ApiError) return { code: "cin7_api", message: clean(`Cin7 API error (HTTP ${e.status}): ${e.message}`) };
  if (/^replace_purchase_detail:/.test(raw)) return { code: "database", message: clean(raw) };
  return { code: "unknown", message: clean(raw) };
}

/**
 * Persists (throttled) and logs one failed purchase-detail sync. Diagnostics
 * must never break or slow the sync, so every failure here is swallowed.
 */
export async function recordPurchaseDetailFailure(
  db: SupabaseClient,
  input: { orgId: string; instanceId: string; purchaseId: string; orderNumber: string | null; error: unknown }
): Promise<SanitisedSyncError> {
  const sanitised = sanitiseSyncError(input.error);
  console.error(`purchase detail sync failed (instance ${input.instanceId}, purchase ${input.purchaseId}): [${sanitised.code}] ${sanitised.message}`);
  try {
    const cutoff = new Date(Date.now() - FAILURE_LOG_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { data: recent, error } = await db
      .from("activity_log")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("instance_id", input.instanceId)
      .eq("action", PURCHASE_DETAIL_FAILURE_ACTION)
      .eq("detail->>purchase_id", input.purchaseId)
      .gte("created_at", cutoff)
      .limit(1);
    if (error || (recent && recent.length > 0)) return sanitised;

    await logActivity(db, {
      orgId: input.orgId,
      instanceId: input.instanceId,
      actor: "system",
      action: PURCHASE_DETAIL_FAILURE_ACTION,
      summary: `Purchase detail sync failed for ${input.orderNumber ?? input.purchaseId}: ${sanitised.message}`,
      detail: { purchase_id: input.purchaseId, order_number: input.orderNumber, code: sanitised.code, message: sanitised.message },
    });
  } catch (e) {
    console.error("recordPurchaseDetailFailure: could not persist diagnostic:", e instanceof Error ? e.message : e);
  }
  return sanitised;
}

/**
 * Generic throttled diagnostic row for one purchase (activity_log, `diagnostic.` prefix — hidden from the
 * Cin7 write-audit view). At most one row per (action, purchase) per `windowHours`. Never throws.
 */
export async function recordPurchaseDiagnostic(
  db: SupabaseClient,
  input: {
    orgId: string;
    instanceId: string;
    action: string;
    purchaseId: string;
    summary: string;
    detail: Record<string, unknown>;
    windowHours: number;
    /**
     * When set, an existing record only throttles a new one if it is NEWER than this instant. Used so a PO relisted
     * after an earlier suspicion (new evidence) is recorded again instead of being swallowed by the throttle.
     */
    supersedeAfter?: string | null;
  }
): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - input.windowHours * 3600 * 1000).toISOString();
    const effectiveCutoff = input.supersedeAfter && input.supersedeAfter > cutoff ? input.supersedeAfter : cutoff;
    const { data: recent, error } = await db
      .from("activity_log")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("instance_id", input.instanceId)
      .eq("action", input.action)
      .eq("detail->>purchase_id", input.purchaseId)
      .gte("created_at", effectiveCutoff)
      .limit(1);
    if (error || (recent && recent.length > 0)) return false;
    await logActivity(db, {
      orgId: input.orgId,
      instanceId: input.instanceId,
      actor: "system",
      action: input.action,
      summary: input.summary,
      detail: { purchase_id: input.purchaseId, ...input.detail },
    });
    return true;
  } catch (e) {
    console.error(`recordPurchaseDiagnostic (${input.action}) failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Instance-wide lookups of recent refresh diagnostics (activity_log, scoped to this org + instance). Loaded BEFORE the
 * queue is read so the queue limit can be widened by their sizes: suspected-void POs are open with the oldest detail,
 * i.e. they sit at the head of the queue, and would otherwise starve everything behind them.
 */
export async function loadRefreshSkipMaps(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  windows: { rejectedHours: number; suspectVoidHours: number }
): Promise<{ rejected: Set<string>; suspectVoid: Map<string, string> }> {
  const out = { rejected: new Set<string>(), suspectVoid: new Map<string, string>() };
  const read = async (action: string, hours: number) => {
    try {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data, error } = await db
        .from("activity_log")
        .select("detail, created_at")
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("action", action)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) return [] as { detail: { purchase_id?: string } | null; created_at: string }[];
      return (data ?? []) as { detail: { purchase_id?: string } | null; created_at: string }[];
    } catch {
      return [];
    }
  };
  for (const r of await read(PURCHASE_REFRESH_REJECTED_ACTION, windows.rejectedHours)) {
    if (r.detail?.purchase_id) out.rejected.add(r.detail.purchase_id);
  }
  for (const r of await read(PURCHASE_LIKELY_VOIDED_ACTION, windows.suspectVoidHours)) {
    const id = r.detail?.purchase_id;
    // newest first: keep the most recent suspicion per purchase
    if (id && !out.suspectVoid.has(id)) out.suspectVoid.set(id, r.created_at);
  }
  return out;
}
