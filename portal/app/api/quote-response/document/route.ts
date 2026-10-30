// The issued customer quotation PDF for a valid response token. POST only (the token is in the BODY, never in a URL that could be logged, bookmarked or sent in a Referer).
// A GET - including an email scanner or link previewer following the link - gets nothing. Serves exactly the document the token is bound to, re-verifying its SHA-256.
import { createServiceRoleClient } from "@/supabase/server";
import { readTokenDocument } from "@/lib/newquip-portal/store";
import { allow } from "@/lib/newquip-portal/rate-limit";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export async function GET(): Promise<Response> { return new Response("Method not allowed", { status: 405, headers: { ...H, Allow: "POST" } }); }

export async function POST(req: Request): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allow(`doc:${ip}`, 30, 10 * 60_000)) return new Response("Too many requests", { status: 429, headers: H });
  let token = "";
  try { token = String((await req.formData()).get("token") ?? ""); } catch { return new Response("Bad request", { status: 400, headers: H }); }
  try {
    const r = await readTokenDocument(createServiceRoleClient(), token, process.env);
    // Every failure (invalid, expired, revoked, superseded, locked, wrong environment, tampered file) shows nothing. A USED link or one waiting for verification is refused too.
    if (!r.ok) return new Response("This link is not valid.", { status: 404, headers: H });
    return new Response(Buffer.from(r.bytes), { status: 200, headers: { ...H, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${r.fileName}"`, "Content-Length": String(r.bytes.length) } });
  } catch {
    return new Response("Not found", { status: 404, headers: H });
  }
}
