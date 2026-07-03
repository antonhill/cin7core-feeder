import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { runImport, type ImportKind } from "@/import/run-import";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

const VALID_KINDS: ImportKind[] = ["products", "assembly_bom", "production_bom"];

/**
 * POST multipart/form-data: { orgId, kind, file }
 * Parses and validates the CSV, commits valid rows, returns a batch summary.
 */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);

    const form = await req.formData();
    const orgId = form.get("orgId");
    const kind = form.get("kind");
    const file = form.get("file");

    if (typeof orgId !== "string" || !orgId) {
      return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    }
    if (typeof kind !== "string" || !VALID_KINDS.includes(kind as ImportKind)) {
      return NextResponse.json({ error: `kind must be one of ${VALID_KINDS.join(", ")}` }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const csvText = await file.text();
    const db = createServiceRoleClient();
    const result = await runImport(db, orgId, kind as ImportKind, file.name, csvText);

    return NextResponse.json(result, { status: result.committed || result.errorCount === 0 ? 200 : 207 });
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
