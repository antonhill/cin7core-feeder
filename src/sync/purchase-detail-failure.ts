import type { SupabaseClient } from "@supabase/supabase-js";
import { logActivity } from "@/lib/activity-log";
import { Cin7ApiError } from "@/cin7/http";
import { ReceiptLineConflictError } from "@/cin7/purchase-detail";

/** Persisted via the existing activity_log (no migration). `diagnostic.` prefix keeps it distinguishable from the live-write audit actions. */
export const PURCHASE_DETAIL_FAILURE_ACTION = "diagnostic.purchase_detail_sync_failed";

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
