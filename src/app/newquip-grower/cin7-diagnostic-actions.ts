"use server";

// NewQuip read-only Cin7 diagnostic. GET of /Product and /Supplier only, through Cin7ReadOnlyGate. Writes nothing to Cin7 or to any quotation draft; the only writes
// are its own audit rows (counts / reason codes only: no SKUs, no costs). Cost-bearing output: internal, never cached. Single-flight per organisation (an in-process
// flag plus a recent-audit-row check that works across instances). Only async functions and erased types are exported.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/supabase/server";
import { validateSkus, type DiagnosticResult } from "@/cin7/readonly-diagnostic";
import { COMPLETED, recordRunStarted, runInProgress } from "@/cin7/readonly-diagnostic-audit";
import { runReadOnlyDiagnostic } from "@/cin7/readonly-diagnostic-run";
import { logActivity } from "@/lib/activity-log";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { authoriseDiagnostic, type DiagnosticActor } from "./diagnostics/authorise";

export interface Cin7DiagnosticActionResult { ok: boolean; error?: string; data?: DiagnosticResult }

const REFUSED = "newquip.cin7_diagnostic_refused";
const BUSY = "A run is already in progress, try again in a few minutes.";
const inFlight = new Map<string, boolean>();

/** Best-effort audit of a refused attempt by an AUTHENTICATED user. Reason code only. */
async function refused(db: SupabaseClient, who: DiagnosticActor, reason: string) {
  await logActivity(db, { orgId: who.orgId, actor: { userId: who.userId, email: who.email }, action: REFUSED, summary: "Read-only Cin7 diagnostic refused", detail: { reason } });
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
  if (inFlight.get(a.orgId) === true) { await refused(db, a, "concurrent"); return { ok: false, error: BUSY }; }
  inFlight.set(a.orgId, true);
  try {
    if ((await runInProgress(db, a.orgId)) !== false) { await refused(db, a, "concurrent"); return { ok: false, error: BUSY }; } // also refuses when the check itself failed
    // The "started" row is written BEFORE any Cin7 call and checked directly (logActivity swallows errors): no audit row, no run.
    if (!(await recordRunStarted(db, a, valid.skus.length))) return { ok: false, error: "The diagnostic could not be completed." };
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
    inFlight.set(a.orgId, false);
  }
}
