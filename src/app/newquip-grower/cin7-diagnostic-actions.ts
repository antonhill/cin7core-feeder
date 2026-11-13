"use server";

// NewQuip read-only Cin7 diagnostic. GET of /Product and /Supplier only, through Cin7ReadOnlyGate. Writes nothing to Cin7 or to any quotation draft; the only writes
// are its own audit rows (counts / reason codes only: no SKUs, no costs). Cost-bearing output: internal, never cached. Single-flight per organisation (an in-process
// flag plus a recent-audit-row check that works across instances). Only async functions and erased types are exported.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/supabase/server";
import { validateSkus, type DiagnosticResult } from "@/cin7/readonly-diagnostic";
import { runReadOnlyDiagnostic } from "@/cin7/readonly-diagnostic-run";
import { logActivity } from "@/lib/activity-log";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { authoriseDiagnostic, type DiagnosticActor } from "./diagnostics/authorise";

export interface Cin7DiagnosticActionResult { ok: boolean; error?: string; data?: DiagnosticResult }

const STARTED = "newquip.cin7_diagnostic_run_started";
const COMPLETED = "newquip.cin7_diagnostic_run";
const REFUSED = "newquip.cin7_diagnostic_refused";
const IN_PROGRESS_WINDOW_MS = 5 * 60_000;
const BUSY = "A run is already in progress, try again in a few minutes.";
const inFlight = new Set<string>();

/** Best-effort audit of a refused attempt by an AUTHENTICATED user. Reason code only. */
async function refused(db: SupabaseClient, who: DiagnosticActor, reason: string) {
  await logActivity(db, { orgId: who.orgId, actor: { userId: who.userId, email: who.email }, action: REFUSED, summary: "Read-only Cin7 diagnostic refused", detail: { reason } });
}

/** True when the newest started/completed row in the window is a "started" one. null = could not tell (the caller fails closed). */
async function runInProgress(db: SupabaseClient, orgId: string): Promise<boolean | null> {
  const since = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const { data, error } = await db.from("activity_log").select("action, created_at").eq("org_id", orgId).in("action", [STARTED, COMPLETED]).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
  if (error || !Array.isArray(data)) return null;
  return data[0]?.action === STARTED;
}

export async function runCin7DiagnosticAction(skus: string[]): Promise<Cin7DiagnosticActionResult> {
  const db = createServiceRoleClient();
  const auth = await authoriseDiagnostic(db);
  if (!auth.ok) {
    if (auth.identity && auth.reason !== "not_enabled") await refused(db, auth.identity, auth.reason);
    return { ok: false, error: auth.error };
  }
  const a = auth.actor;
  const valid = validateSkus(skus);
  if (!valid.ok) { await refused(db, a, "invalid_input"); return { ok: false, error: valid.error }; }
  if (inFlight.has(a.orgId)) { await refused(db, a, "concurrent"); return { ok: false, error: BUSY }; }
  inFlight.add(a.orgId);
  try {
    if ((await runInProgress(db, a.orgId)) !== false) { await refused(db, a, "concurrent"); return { ok: false, error: BUSY }; } // also refuses when the check itself failed
    // The "started" row is written BEFORE any Cin7 call and checked directly (logActivity swallows errors): no audit row, no run.
    const started = await db.from("activity_log").insert({ org_id: a.orgId, actor_user_id: a.userId, actor_email: a.email, action: STARTED, summary: "Read-only Cin7 diagnostic started (GET only)", detail: { skusRequested: valid.skus.length } });
    if (started.error) return { ok: false, error: "The diagnostic could not be completed." };
    const done = (detail: Record<string, unknown>) => logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: COMPLETED, summary: "Read-only Cin7 diagnostic run (GET only; no Cin7 or quotation write)", detail });
    try {
      const data = await runReadOnlyDiagnostic(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, valid.skus); // credentials are loaded in there, never returned or logged
      await done({ skusRequested: data.summary.requested, found: data.summary.found, missing: data.summary.missing, errors: data.summary.errors, aborted: data.aborted, abortReason: data.abortReason });
      return { ok: true, data };
    } catch {
      await done({ skusRequested: valid.skus.length, found: 0, missing: 0, errors: 0, aborted: false, failed: true });
      return { ok: false, error: "The diagnostic could not be completed." };
    }
  } finally {
    inFlight.delete(a.orgId);
  }
}
