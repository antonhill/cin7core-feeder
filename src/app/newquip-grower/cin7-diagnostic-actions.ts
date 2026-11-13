"use server";

// NewQuip read-only Cin7 diagnostic. GET of /Product and /Supplier only, through Cin7ReadOnlyGate. Writes nothing to Cin7 or to any quotation draft; the one thing it
// writes is its own audit row (counts only). Cost-bearing output: internal, never cached. Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { validateSkus, type DiagnosticResult } from "@/cin7/readonly-diagnostic";
import { runReadOnlyDiagnostic } from "@/cin7/readonly-diagnostic-run";
import { logActivity } from "@/lib/activity-log";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { authoriseDiagnostic } from "./diagnostics/authorise";

export interface Cin7DiagnosticActionResult { ok: boolean; error?: string; data?: DiagnosticResult }

export async function runCin7DiagnosticAction(skus: string[]): Promise<Cin7DiagnosticActionResult> {
  const auth = await authoriseDiagnostic();
  if (!auth.ok) return { ok: false, error: auth.error };
  const valid = validateSkus(skus);
  if (!valid.ok) return { ok: false, error: valid.error };
  try {
    const db = createServiceRoleClient();
    const data = await runReadOnlyDiagnostic(db, auth.actor.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, valid.skus); // credentials are loaded in there, never returned or logged
    await logActivity(db, {
      orgId: auth.actor.orgId, actor: { userId: auth.actor.userId, email: auth.actor.email },
      action: "newquip.cin7_diagnostic_run", summary: "Read-only Cin7 diagnostic run (GET only; no Cin7 or quotation write)",
      detail: { skusRequested: data.summary.requested, found: data.summary.found, missing: data.summary.missing, errors: data.summary.errors },
    });
    return { ok: true, data };
  } catch {
    return { ok: false, error: "The diagnostic could not be completed." };
  }
}
