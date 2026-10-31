// Staff upload endpoint for customer-response evidence (multipart). Two intents:
//   record - record the customer's response with its responding contact AND evidence files (one request, so an acceptance is never recorded without its evidence);
//   attach - add evidence files to an existing response.
// Authenticated, organisation-checked, Rep / Manager only; file type is verified from the CONTENT, size-limited, hashed and stored privately. Nothing reaches Cin7.
import { authoriseActor, auditActor, ownerEmailOf } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { defaultDeps } from "@/lib/newquip-quotes/document-store";
import { attachEvidence, recordStaffResponse } from "@/lib/newquip-quotes/response-record";
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, EVIDENCE_MAX_TOTAL } from "@/lib/newquip-quotes/response-evidence";
import { guardQuote } from "@/lib/newquip-assignments/access";
import type { ResponseContactInput } from "@/lib/newquip-quotes/response-contact";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: NO_STORE });
const MAX_BODY = EVIDENCE_MAX_TOTAL + 400 * 1024; // the files plus the form fields; the platform itself stops anything above 4.5 MB

export async function POST(req: Request): Promise<Response> {
  let a;
  try { a = await authoriseActor(); } catch { return reply(401, { ok: false, error: "Not authorised." }); }
  if (!a.roles.has("rep") && !a.roles.has("manager")) return reply(403, { ok: false, error: "You do not have permission to record a customer response." });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return reply(413, { ok: false, error: `The upload is too large. Attach at most ${EVIDENCE_MAX_FILES} files, ${EVIDENCE_MAX_TOTAL / 1024 / 1024} MB in total.` });
  let form: FormData;
  try { form = await req.formData(); } catch { return reply(400, { ok: false, error: "The upload could not be read." }); }
  const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const quoteId = str("quoteId");
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return reply(400, { ok: false, error: "Missing quotation." });
  try {
    await guardQuote(createServiceRoleClient(), a, quoteId);   // Rep isolation (Slice 1B): before any file is read or anything recorded
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const v of form.getAll("files")) if (typeof v !== "string" && v.size > 0) {
      if (v.size > EVIDENCE_MAX_BYTES) throw new Error(`"${v.name}" is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB.`);
      files.push({ name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
    }
    const db = createServiceRoleClient();
    const who = { email: a.email, ownerEmail: ownerEmailOf(a) };
    const storage = defaultDeps(db).storage;
    if (str("intent") === "attach") {
      const rows = await attachEvidence(db, storage, a.orgId, quoteId, who, str("responseId"), files, str("description"));
      await auditActor(db, a, { action: "newquip.response_evidence_added", summary: "Attached evidence to a customer response (no project or Cin7 write)", detail: { quoteId, responseId: str("responseId"), files: rows.map((r) => ({ id: r.id, sha256: r.sha256, bytes: r.byte_size, type: r.content_type })) } });
      return reply(200, { ok: true, attached: rows.length });
    }
    const contact = JSON.parse(str("contact") || "null") as ResponseContactInput | null;
    if (!contact) throw new Error("Choose who responded.");
    const r = await recordStaffResponse(db, storage, a.orgId, quoteId, who, {
      documentId: str("documentId"), response: str("response") as never, contact, respondedOn: str("respondedOn"), evidenceRef: str("evidenceRef"), note: str("note"),
    }, files, new Date().toISOString().slice(0, 10));
    if (r.created) {
      await auditActor(db, a, { action: `newquip.customer_${r.response.response.toLowerCase()}`, summary: `Recorded the customer's response: ${r.response.response} (no project or Cin7 Sale is created by this step)`,
        detail: { quoteId, responseId: r.response.id, documentId: r.response.document_id, contactSource: r.response.contact_source ?? null, exceptionReason: r.response.exception_reason ?? null, evidence: r.evidence.map((e) => ({ id: e.id, sha256: e.sha256, bytes: e.byte_size })) } });
    }
    return reply(200, { ok: true, created: r.created, responseId: r.response.id });
  } catch (e) {
    return reply(400, { ok: false, error: e instanceof Error ? e.message : "The response could not be recorded." });
  }
}
