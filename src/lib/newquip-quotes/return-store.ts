import "server-only";
// Persistence for "why is this quotation back with me?" - see src/newquip/quote/return-info.ts. NO migration: the append-only `activity_log` holds the record, and
// RETURNED approval requests are the fallback for earlier returns. This module imports nothing from src/cin7 and never calls fetch.
import type { createServiceRoleClient } from "@/supabase/server";
import { redactSecrets } from "@/lib/audit-safety";
import type { QuoteRole } from "@/newquip/quote/roles";
import {
  returnRoleOf, CONFIRMATION_WITHDRAWN_ACTION, RETURN_RECORD_ACTION, RETURN_VOID_ACTION, SIGNOFF_RECORD_ACTION, SIGNOFF_STEP_ACTION, candidateFromActivity, candidateFromApproval, latestReturnInfo, returnRecordDetail,
  type ActivityRow, type ReturnCandidate, type ReturnHistory, type ReturnInfo, type ReturnRecordDetail,
} from "@/newquip/quote/return-info";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Who returned the quotation and in which capacity. `ownerEmail` is the REAL account under Demo Mode (the log's actor); `email` is the effective user shown to people. */
export interface ReturnBy { email: string; role: QuoteRole; ownerEmail?: string | null }

/** The returning actor from a server-action actor (`email` is the effective user; `demo.ownerEmail` the real account). `role` defaults to the highest capacity held. */
export function returnByOf(a: { email: string; roles: ReadonlySet<QuoteRole>; demo?: { ownerEmail: string } | null }, role?: QuoteRole): ReturnBy {
  return { email: a.email, role: role ?? returnRoleOf(a.roles), ownerEmail: a.demo?.ownerEmail ?? null };
}

/**
 * Appends the return record. STRICT: unlike logActivity it THROWS when the row cannot be written, because the transition that follows must not happen without its
 * reason being kept. It is written BEFORE the state change and bound to the revision that change produces, so a record whose transition then failed never matches
 * the quotation's current revision. Append-only: nothing here updates or deletes.
 */
export async function recordReturn(db: Db, orgId: string, by: ReturnBy, detail: Omit<ReturnRecordDetail, "byEmail" | "byRole">, summary: string): Promise<string> {
  const full = returnRecordDetail({ ...detail, byEmail: by.email, byRole: by.role });
  const r = await db.from("activity_log").insert({
    org_id: orgId, instance_id: null, actor_user_id: null, actor_email: by.ownerEmail ?? by.email, action: RETURN_RECORD_ACTION, summary, detail: redactSecrets(full),
  }).select("id").single();
  if (r.error || !r.data) throw new Error(`The reason could not be recorded, so the quotation was not changed: ${r.error?.message ?? "no row"}`);
  return (r.data as { id: string }).id;
}

/**
 * The state change after recordReturn did not happen (0 rows, or an error): append a compensating void record so the stale record can never show. Chosen over recording
 * AFTER the update because "record fails => no state change" must hold (a reason is never lost); the void is best effort and only matters in that rare race.
 */
export async function voidReturn(db: Db, orgId: string, quoteId: string, recordId: string, why: string): Promise<void> {
  await db.from("activity_log").insert({ org_id: orgId, instance_id: null, actor_user_id: null, actor_email: null, action: RETURN_VOID_ACTION, summary: "The recorded return did not take effect (local only)", detail: { quoteId, recordId, why } }).then(() => undefined, () => undefined);
}

/** Best effort: marks a successful estimator sign-off (ends an earlier return to the Estimator). The step audit row is read as well, so a failure here loses nothing alone. */
export async function recordSignoff(db: Db, orgId: string, quoteId: string, email: string): Promise<void> {
  await db.from("activity_log").insert({ org_id: orgId, instance_id: null, actor_user_id: null, actor_email: email, action: SIGNOFF_RECORD_ACTION, summary: "Estimator sign-off recorded (local only)", detail: { quoteId } }).then(() => undefined, () => undefined);
}

/** Every stored candidate for ONE quotation (newest first from each source), plus the void and sign-off markers. A source that is unavailable (e.g. approvals not yet migrated) contributes nothing. */
export async function loadReturnCandidates(db: Db, orgId: string, quoteId: string): Promise<ReturnHistory> {
  const candidates: ReturnCandidate[] = [];
  const voidedIds: string[] = [];
  const signoffAts: string[] = [];
  const act = await db.from("activity_log").select("id, action, actor_email, detail, created_at").eq("org_id", orgId)
    .in("action", [RETURN_RECORD_ACTION, CONFIRMATION_WITHDRAWN_ACTION, RETURN_VOID_ACTION, SIGNOFF_RECORD_ACTION, SIGNOFF_STEP_ACTION]).eq("detail->>quoteId", quoteId).order("created_at", { ascending: false }).limit(60);
  if (act.error) throw new Error(`return history: ${act.error.message}`);
  for (const row of (act.data ?? []) as ActivityRow[]) {
    if (row.action === RETURN_VOID_ACTION) { const id = row.detail?.recordId; if (typeof id === "string") voidedIds.push(id); continue; }
    if (row.action === SIGNOFF_RECORD_ACTION || row.action === SIGNOFF_STEP_ACTION) { signoffAts.push(row.created_at); continue; }
    const c = candidateFromActivity(row); if (c) candidates.push(c);
  }
  const apr = await db.from("approval_requests").select("*").eq("org_id", orgId).eq("doc_type", "QUOTE").eq("doc_id", quoteId).eq("status", "RETURNED").order("decided_at", { ascending: false }).limit(10);
  if (!apr.error) for (const row of (apr.data ?? []) as Array<Parameters<typeof candidateFromApproval>[0]>) { const c = candidateFromApproval(row); if (c) candidates.push(c); }
  return { candidates, voidedIds, signoffAts };
}

/** The reason the quotation is where it is NOW (see latestReturnInfo), or null. A read failure is not fatal to the page: it yields null. */
export async function returnInfoOf(db: Db, orgId: string, quote: { id: string; state: string; revision: number; estimator_signoff_hash: string | null }): Promise<ReturnInfo | null> {
  try { return latestReturnInfo(quote, await loadReturnCandidates(db, orgId, quote.id)); } catch { return null; }
}
