"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { runImport, type ImportKind, type RunImportResult } from "@/import/run-import";

export interface ImportActionState {
  status: "idle" | "error" | "success";
  message?: string;
  result?: RunImportResult;
}

const VALID_KINDS: ImportKind[] = ["products", "assembly_bom", "production_bom"];

/**
 * Server Action backing the /import page. Runs entirely server-side, so the
 * shared secret is compared here and never sent to (or held by) the browser —
 * a stand-in gate until real per-user Supabase Auth replaces it.
 */
export async function importCsvAction(
  _prevState: ImportActionState,
  formData: FormData
): Promise<ImportActionState> {
  const secret = formData.get("secret");
  const expected = process.env.SYNC_SHARED_SECRET;
  if (!expected) {
    return { status: "error", message: "SYNC_SHARED_SECRET is not configured on the server." };
  }
  if (secret !== expected) {
    return { status: "error", message: "Incorrect passphrase." };
  }

  const orgId = formData.get("orgId");
  const kind = formData.get("kind");
  const file = formData.get("file");

  if (typeof orgId !== "string" || !orgId) {
    return { status: "error", message: "Organization ID is required." };
  }
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as ImportKind)) {
    return { status: "error", message: `kind must be one of ${VALID_KINDS.join(", ")}` };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a CSV file." };
  }

  try {
    const csvText = await file.text();
    const db = createServiceRoleClient();
    const result = await runImport(db, orgId, kind as ImportKind, file.name, csvText);
    return { status: "success", result };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Unknown error" };
  }
}
