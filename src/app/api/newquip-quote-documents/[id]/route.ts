// Authenticated, organisation-checked download of an ISSUED customer quotation PDF. There is no public or permanent URL: every request re-authenticates, resolves the
// caller's organisation, loads the document only within it, re-verifies the stored SHA-256 and answers with private, no-store headers.
import { authoriseActor, auditActor } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { defaultDeps, readDocumentBytes } from "@/lib/newquip-quotes/document-store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let actor;
  try { actor = await authoriseActor(); } catch { return new Response("Not authorised", { status: 401, headers: { "Cache-Control": "private, no-store" } }); }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  try {
    const db = createServiceRoleClient();
    const { doc, bytes } = await readDocumentBytes(db, actor.orgId, id, defaultDeps(db));
    await auditActor(db, actor, { action: "newquip.quote_document_downloaded", summary: "Opened an issued customer quotation PDF", detail: { documentId: doc.id, quoteId: doc.quote_id, version: doc.version } }).catch(() => undefined);
    return new Response(Buffer.from(bytes), { status: 200, headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${doc.quote_ref}-r${doc.revision}-v${doc.version}.pdf"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(bytes.length),
    } });
  } catch {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
}
