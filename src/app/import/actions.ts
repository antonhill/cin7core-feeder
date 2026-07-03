"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { runImport, type ImportKind, type RunImportResult } from "@/import/run-import";
import { syncOrgInstances, type InstanceSyncOutcome } from "@/sync/sync-org";
import { requireCurrentOrg } from "@/lib/current-org";

export interface ImportActionState {
  status: "idle" | "error" | "success";
  message?: string;
  result?: RunImportResult;
}

const VALID_KINDS: ImportKind[] = ["products", "assembly_bom", "production_bom"];

/**
 * Server Action backing the /import page. The org comes from the logged-in
 * session (org_members), not a client-supplied orgId — a user can only ever
 * import into their own org.
 */
export async function importCsvAction(
  _prevState: ImportActionState,
  formData: FormData
): Promise<ImportActionState> {
  const kind = formData.get("kind");
  const file = formData.get("file");

  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as ImportKind)) {
    return { status: "error", message: `kind must be one of ${VALID_KINDS.join(", ")}` };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a CSV file." };
  }

  try {
    const { orgId } = await requireCurrentOrg();
    const csvText = await file.text();
    const db = createServiceRoleClient();
    const result = await runImport(db, orgId, kind as ImportKind, file.name, csvText);
    return { status: "success", result };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface PushToCin7Result {
  ok: boolean;
  error?: string;
  outcomes?: InstanceSyncOutcome[];
}

/** Pushes the org's current canonical data to the selected instance(s) only. */
export async function pushToCin7Action(instanceIds: string[]): Promise<PushToCin7Result> {
  if (!instanceIds.length) return { ok: false, error: "Select at least one instance to push to." };

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const outcomes = await syncOrgInstances(db, orgId, instanceIds);
    return { ok: true, outcomes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
