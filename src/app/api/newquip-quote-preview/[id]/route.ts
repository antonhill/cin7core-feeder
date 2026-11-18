// TEST-ONLY preview of a customer quotation PDF. Authenticated, organisation-scoped, Rep or Manager. Nothing is stored or recorded as an issued document, so the result can
// never be sent, accepted or handed over. The normal issue gate (issueQuotationDocument) is separate and unchanged. Every page is watermarked.
import { authoriseActor, auditActor } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { previewQuotationDocument } from "@/lib/newquip-quotes/document-store";
import { resolveProjectSchedule } from "@/lib/newquip-quotes/schedule-resolve";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "private, no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let actor;
  try { actor = await authoriseActor(); } catch { return new Response("Not authorised", { status: 401, headers: H }); }
  if (!actor.roles.has("rep") && !actor.roles.has("manager")) return new Response("Not authorised", { status: 403, headers: H });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404, headers: H });
  try {
    const db = createServiceRoleClient();
    const applied = await resolveProjectSchedule(db, actor.orgId);
    const r = await previewQuotationDocument(db, actor.orgId, id, applied.schedule, { today: () => new Date().toISOString().slice(0, 10) }, applied.source);
    await auditActor(db, actor, { action: "newquip.quote_test_preview_opened", summary: "Opened a TEST-ONLY quotation PDF preview (not issued, not stored, cannot be sent)", detail: { quoteId: id } }).catch(() => undefined);
    return new Response(Buffer.from(r.bytes), { status: 200, headers: { ...H, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="TEST-ONLY-${r.quoteRef}-r${r.revision}.pdf"`, "X-Content-Type-Options": "nosniff", "Content-Length": String(r.bytes.length) } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Preview unavailable", { status: 409, headers: H });
  }
}
