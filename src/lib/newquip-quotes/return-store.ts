import "server-only";
// Persistence for "why is this quotation back with me?" - see src/newquip/quote/return-info.ts. NO migration: the append-only `activity_log` holds the record, and
// RETURNED approval requests are the fallback for earlier returns. This module imports nothing from src/cin7 and never calls fetch.
import type { createServiceRoleClient } from "@/supabase/server";
import { redactSecrets } from "@/lib/audit-safety";
import type { QuoteRole } from "@/newquip/quote/roles";
import {
  returnRoleOf, CONFIRMATION_WITHDRAWN_ACTION, RETURN_RECORD_ACTION, candidateFromActivity, candidateFromApproval, latestReturnInfo, returnRecordDetail,
  type ActivityRow, type ReturnCandidate, type ReturnInfo, type ReturnRecordDetail,
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
export async function recordReturn(db: Db, orgId: string, by: ReturnBy, detail: Omit<ReturnRecordDetail, "byEmail" | "byRole">, summary: string): Promise<void> {
  const full = returnRecordDetail({ ...detail, byEmail: by.email, byRole: by.role });
  const r = await db.from("activity_log").insert({
    org_id: orgId, instance_id: null, actor_user_id: null, actor_email: by.ownerEmail ?? by.email, action: RETURN_RECORD_ACTION, summary, detail: redactSecrets(full),
  });
  if (r.error) throw new Error(`The reason could not be recorded, so the quotation was not changed: ${r.error.message}`);
}

/** Every stored candidate for ONE quotation, newest first from each source. A source that is unavailable (e.g. approvals not yet migrated) contributes nothing. */
export async function loadReturnCandidates(db: Db, orgId: string, quoteId: string): Promise<ReturnCandidate[]> {
  const out: ReturnCandidate[] = [];
  const act = await db.from("activity_log").select("action, actor_email, detail, created_at").eq("org_id", orgId)
    .in("action", [RETURN_RECORD_ACTION, CONFIRMATION_WITHDRAWN_ACTION]).eq("detail->>quoteId", quoteId).order("created_at", { ascending: false }).limit(25);
  if (act.error) throw new Error(`return history: ${act.error.message}`);
  for (const row of (act.data ?? []) as ActivityRow[]) { const c = candidateFromActivity(row); if (c) out.push(c); }
  const apr = await db.from("approval_requests").select("*").eq("org_id", orgId).eq("doc_type", "QUOTE").eq("doc_id", quoteId).eq("status", "RETURNED").order("decided_at", { ascending: false }).limit(10);
  if (!apr.error) for (const row of (apr.data ?? []) as Array<Parameters<typeof candidateFromApproval>[0]>) { const c = candidateFromApproval(row); if (c) out.push(c); }
  return out;
}

/** The reason the quotation is where it is NOW (see latestReturnInfo), or null. A read failure is not fatal to the page: it yields null. */
export async function returnInfoOf(db: Db, orgId: string, quote: { id: string; state: string; revision: number; estimator_signoff_hash: string | null }): Promise<ReturnInfo | null> {
  try { return latestReturnInfo(quote, await loadReturnCandidates(db, orgId, quote.id)); } catch { return null; }
}
