import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { Cin7ReadOnlyGate, cin7Transport, inspectSkus, type DiagnosticResult } from "@/cin7/readonly-diagnostic";

/** Loads the instance's credentials (never returned) and runs the read-only inspection. `skus` must already be validated. */
export async function runReadOnlyDiagnostic(db: SupabaseClient, orgId: string, instanceId: string, skus: string[]): Promise<DiagnosticResult> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  return inspectSkus(new Cin7ReadOnlyGate(cin7Transport(creds)), skus);
}
