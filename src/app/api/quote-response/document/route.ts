// The issued customer quotation PDF for a valid response token. POST only (the token is in the BODY, never in a URL that could be logged, bookmarked or sent in a Referer).
// A GET - including an email scanner or link previewer following the link - gets nothing. Serves exactly the document the token is bound to, re-verifying its SHA-256.
import { createServiceRoleClient } from "@/supabase/server";
import { defaultDeps, readDocumentBytes } from "@/lib/newquip-quotes/document-store";
import { resolveLink } from "@/lib/newquip-quotes/response-links";
import { allow } from "@/lib/newquip-quotes/rate-limit";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export async function GET(): Promise<Response> { return new Response("Method not allowed", { status: 405, headers: { ...H, Allow: "POST" } }); }

export async function POST(req: Request): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allow(`doc:${ip}`, 30, 10 * 60_000)) return new Response("Too many requests", { status: 429, headers: H });
  let token = "";
  try { token = String((await req.formData()).get("token") ?? ""); } catch { return new Response("Bad request", { status: 400, headers: H }); }
  try {
    const db = createServiceRoleClient();
    const r = await resolveLink(db, token, process.env);
    // A link that has been USED or is waiting for verification can still show the document it answered; every other failure shows nothing.
    if (!r.ok) return new Response("This link is not valid.", { status: 404, headers: H });
    const { doc, bytes } = await readDocumentBytes(db, r.link.org_id, r.doc.id, defaultDeps(db));
    return new Response(Buffer.from(bytes), { status: 200, headers: { ...H, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${doc.quote_ref}-r${doc.revision}.pdf"`, "Content-Length": String(bytes.length) } });
  } catch {
    return new Response("Not found", { status: 404, headers: H });
  }
}
