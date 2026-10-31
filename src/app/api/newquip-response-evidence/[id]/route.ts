// Authenticated, organisation-checked download of ONE customer-response evidence file. No public or permanent URL: every request re-authenticates, resolves the caller's
// organisation, loads the file only within it, re-verifies its SHA-256, and answers as an ATTACHMENT (never rendered in the browser) with private, no-store headers.
import { authoriseActor, auditActor } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { defaultDeps } from "@/lib/newquip-quotes/document-store";
import { readEvidenceBytes } from "@/lib/newquip-quotes/response-evidence";
import { guardQuote } from "@/lib/newquip-assignments/access";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let actor;
  try { actor = await authoriseActor(); } catch { return new Response("Not authorised", { status: 401, headers: NO_STORE }); }
  // Evidence is customer-confidential: the roles that handle customer responses (Rep, Manager, Estimator for review) may open it; a user with no NewQuip role may not.
  if (!actor.roles.has("rep") && !actor.roles.has("manager") && !actor.roles.has("estimator")) return new Response("Not authorised", { status: 403, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404, headers: NO_STORE });
  try {
    const db = createServiceRoleClient();
    // Rep isolation (Slice 1B): authorise on the evidence's quotation (metadata only) BEFORE the file is read; every refusal is the same generic 404.
    const meta = await db.from("newquip_response_evidence").select("quote_id").eq("org_id", actor.orgId).eq("id", id).maybeSingle();
    if (meta.error || !meta.data) throw new Error("Evidence not found.");
    await guardQuote(db, actor, (meta.data as { quote_id: string }).quote_id);
    const { row, bytes } = await readEvidenceBytes(db, actor.orgId, id, defaultDeps(db).storage);
    await auditActor(db, actor, { action: "newquip.response_evidence_downloaded", summary: "Opened a customer-response evidence file", detail: { evidenceId: row.id, quoteId: row.quote_id, responseId: row.response_id } }).catch(() => undefined);
    const ascii = row.file_name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(Buffer.from(bytes), { status: 200, headers: {
      "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${ascii}"`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Content-Length": String(bytes.length), ...NO_STORE,
    } });
  } catch {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }
}
