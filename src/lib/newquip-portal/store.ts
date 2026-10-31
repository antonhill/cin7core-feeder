import "server-only";
// The PUBLIC side of a customer response, with a deliberately small dependency surface (this is what the separately deployed customer portal runs): it reads only the tables it needs
// and imports no costing, project, Cin7, estimator or shell code. The emailed token is validated against everything it is bound to; loading the page records nothing, and a response
// is recorded only by the explicit submit. Possession of a link does not prove authority to sign: an ACCEPTANCE needs the respondent's name, company, email, an explicit authority
// confirmation and an explicit acceptance of the identified revision, and then WAITS for internal verification (Customer Acceptance, Stage 5). Nothing here creates a project or a
// Cin7 Sale, and nothing is written to Cin7.
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import type { CustomerDocumentModel } from "@/lib/newquip-quotes/customer-document";
import { queueResponseNotifications } from "./notify";
import {
  FAILURE_MESSAGE, MAX_LINK_ATTEMPTS, countsAsAcceptance, environmentOf, isValidEmail, parseToken, sameHash, sha, standingOf,
  type CustomerResponse, type LinkEnv, type LinkFailure, type StoredLink, type StoredResponse, type StoredReview,
} from "./core";

type Db = ReturnType<typeof createServiceRoleClient>;
const BUCKET = "newquip-quote-documents";
/** A database/credential failure is NOT an invalid link: an unknown token returns no error and no row. Logged without the token, the key or any row data (status/code/message are Supabase's own safe error fields). */
export function noteStoreFailure(where: string, e: { message?: string; code?: string; status?: number } | null | undefined): void {
  console.error(`[newquip-portal] ${where} failed: status=${e?.status ?? "?"} code=${e?.code ?? "?"} message=${String(e?.message ?? "").slice(0, 160)}`);
}

interface PortalDoc { id: string; org_id: string; quote_id: string; quote_ref: string; revision: number; baseline_hash: string; content_hash: string; storage_path: string; content: CustomerDocumentModel }
interface PortalQuote { id: string; state: string; baseline_hash: string | null; revision: number | null; created_by_email: string | null; handoff_by_email: string | null }
export type Resolved = { ok: true; link: StoredLink; doc: PortalDoc; quote: PortalQuote } | { ok: false; reason: LinkFailure; link?: StoredLink };

/** Counts a failed submission against the link (compare-and-set, so concurrent failures cannot undercount below the truth by more than one). */
export async function noteFailedAttempt(db: Db, link: StoredLink): Promise<void> {
  await db.from("newquip_response_links").update({ attempts: link.attempts + 1 }).eq("org_id", link.org_id).eq("id", link.id).eq("attempts", link.attempts);
}

/** Validates a presented token against everything it is bound to. Never records anything (apart from counting a wrong secret against a real link). */
export async function resolveLink(db: Db, rawToken: string, env: LinkEnv, now = new Date()): Promise<Resolved> {
  const t = parseToken(rawToken);
  if (!t) return { ok: false, reason: "INVALID" };
  const r = await db.from("newquip_response_links").select("*").eq("id", t.id).maybeSingle();
  if (r.error) { noteStoreFailure("link lookup", r.error as { message?: string; code?: string; status?: number }); return { ok: false, reason: "UNAVAILABLE" }; } // fail closed, but never mislabel as an invalid link
  const link = r.data as StoredLink | null;
  if (!link || !sameHash(link.token_hash, sha(t.secret))) {
    if (link) await noteFailedAttempt(db, link); // a wrong secret against a real link id counts toward its lock-out
    return { ok: false, reason: "INVALID" };
  }
  if (link.environment !== environmentOf(env)) return { ok: false, reason: "INVALID", link }; // a Preview link means nothing in Production, and vice versa
  if (link.attempts >= MAX_LINK_ATTEMPTS) return { ok: false, reason: "LOCKED", link };
  if (link.revoked_at) return { ok: false, reason: "REVOKED", link };
  if (new Date(link.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "EXPIRED", link };
  const qr = await db.from("newquip_quotes").select("id, state, baseline_hash, revision, created_by_email, handoff_by_email").eq("org_id", link.org_id).eq("id", link.quote_id).maybeSingle();
  const q = qr.data as PortalQuote | null;
  if (!q || q.state !== "MANAGER_APPROVED_FINAL" || !q.baseline_hash) return { ok: false, reason: "SUPERSEDED", link };
  const dr = await db.from("newquip_quote_documents").select("id, org_id, quote_id, quote_ref, revision, baseline_hash, content_hash, storage_path, content").eq("org_id", link.org_id).eq("quote_id", link.quote_id).order("version", { ascending: false }).limit(1);
  const doc = ((dr.data ?? []) as PortalDoc[])[0];
  if (!doc || doc.id !== link.document_id || doc.content_hash !== link.document_hash || doc.revision !== link.revision || q.revision !== link.revision || q.baseline_hash !== link.baseline_hash || doc.baseline_hash !== link.baseline_hash) {
    return { ok: false, reason: "SUPERSEDED", link };
  }
  const [rs, rv, ev] = await Promise.all([
    db.from("newquip_quote_responses").select("*").eq("org_id", link.org_id).eq("quote_id", link.quote_id),
    db.from("newquip_response_reviews").select("*").eq("org_id", link.org_id).eq("quote_id", link.quote_id),
    db.from("newquip_response_evidence").select("response_id").eq("org_id", link.org_id).eq("quote_id", link.quote_id),
  ]);
  const responses = (rs.data ?? []) as StoredResponse[]; const reviews = (rv.data ?? []) as StoredReview[];
  const counts = new Map<string, number>(); for (const e of (ev.data ?? []) as Array<{ response_id: string }>) counts.set(e.response_id, (counts.get(e.response_id) ?? 0) + 1);
  if (responses.some((x) => x.link_id === link.id)) return { ok: false, reason: "USED", link };
  if (responses.some((x) => countsAsAcceptance(x, reviews, counts))) return { ok: false, reason: "ALREADY_ACCEPTED", link };
  if (responses.some((x) => x.document_id === doc.id && x.response === "ACCEPTED" && standingOf(x, reviews, counts) === "PENDING_VERIFICATION")) return { ok: false, reason: "PENDING_VERIFICATION", link };
  return { ok: true, link, doc, quote: q };
}

/** The issued PDF a valid token is bound to, re-verified against the SHA-256 recorded at issue (a tampered or substituted file is refused). */
export async function readTokenDocument(db: Db, rawToken: string, env: LinkEnv): Promise<{ ok: true; bytes: Uint8Array; fileName: string } | { ok: false }> {
  const r = await resolveLink(db, rawToken, env);
  if (!r.ok) return { ok: false }; // every failure shows nothing
  const dl = await db.storage.from(BUCKET).download(r.doc.storage_path);
  if (dl.error || !dl.data) return { ok: false };
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== r.doc.content_hash) return { ok: false };
  return { ok: true, bytes, fileName: `${r.doc.quote_ref}-r${r.doc.revision}.pdf` };
}

export interface PublicQuotation {
  quoteRef: string; revision: number; customerName: string; companyName: string; companyLegalName: string;
  currency: "ZAR"; subtotalExVat: number; vat: number; totalIncVat: number; validUntil: string; issuedOn: string;
  schedule: Array<{ name: string; percent: number; amountExVat: number }>; actions: CustomerResponse[];
}
export type PublicResult<T> = { ok: true; data: T } | { ok: false; reason: LinkFailure | "INVALID_INPUT" | "RATE_LIMITED"; error: string };

/** What the customer sees: ONLY the customer-facing model of the issued document (the same model the PDF is rendered from). No internal cost, margin, supplier or approval data exists in it. */
export async function loadPublicQuotation(db: Db, token: string, env: LinkEnv, now = new Date()): Promise<PublicResult<PublicQuotation>> {
  const r = await resolveLink(db, token, env, now);
  if (!r.ok) return { ok: false, reason: r.reason, error: FAILURE_MESSAGE[r.reason] };
  const m = r.doc.content;
  return { ok: true, data: {
    quoteRef: r.doc.quote_ref, revision: r.doc.revision, customerName: m.customer.name, companyName: m.company.brandName, companyLegalName: m.company.legalName, currency: m.currency,
    subtotalExVat: m.totals.subtotalExVat, vat: m.totals.vat, totalIncVat: m.totals.totalIncVat, validUntil: m.quote.validUntil, issuedOn: m.quote.issuedOn,
    schedule: m.paymentSchedule.map((s) => ({ name: s.name, percent: s.percent, amountExVat: s.amountExVat })), actions: r.link.allowed_actions,
  } };
}

export interface PublicSubmit {
  token: string; action: CustomerResponse; fullName: string; company: string; email: string;
  authorityConfirmed: boolean; revisionConfirmed: boolean; /** the revision number the page displayed, echoed back */ revision: number; reason: string;
}
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Records the customer's response. Re-validates the token, the document and the quotation state AT SUBMISSION. */
export async function submitPublicResponse(db: Db, input: PublicSubmit, ctx: { ip: string; env: LinkEnv; now?: Date; baseEnv?: Record<string, string | undefined> }): Promise<PublicResult<{ action: CustomerResponse; quoteRef: string; revision: number; submittedAt: string }>> {
  const now = ctx.now ?? new Date();
  const r = await resolveLink(db, input.token, ctx.env, now);
  if (!r.ok) return { ok: false, reason: r.reason, error: FAILURE_MESSAGE[r.reason] };
  const { link, doc, quote } = r;
  const bad = async (error: string): Promise<PublicResult<never>> => { await noteFailedAttempt(db, link); return { ok: false, reason: "INVALID_INPUT", error }; };
  if (!link.allowed_actions.includes(input.action)) return bad("That response is not available for this link.");
  const fullName = clean(input.fullName, 120); const company = clean(input.company, 160); const email = clean(input.email, 254).toLowerCase(); const reason = clean(input.reason, 1500);
  if (fullName.length < 2) return bad("Enter your full name.");
  if (company.length < 2) return bad("Enter the company you are responding for.");
  if (!isValidEmail(email)) return bad("Enter a valid email address.");
  if (input.revision !== doc.revision) return bad("This page is out of date. Please reload it from the link in your email.");
  if (input.action === "ACCEPTED") {
    if (!input.revisionConfirmed) return bad(`Please confirm that you accept quotation ${doc.quote_ref}, revision ${doc.revision}.`);
    if (!input.authorityConfirmed) return bad("Please confirm that you are authorised to accept this quotation on behalf of the customer.");
  } else if (reason.length < 3) return bad(input.action === "DECLINED" ? "Please tell us why you are declining." : "Please describe the changes you would like.");

  // The explicit statement the customer agreed to is preserved verbatim with the acceptance (the online acceptance is itself the evidence; no separate upload is required).
  const statement = input.action === "ACCEPTED"
    ? `${fullName} (${company}, ${email}) accepted quotation ${doc.quote_ref}, revision ${doc.revision} (document ${doc.id}, SHA-256 ${doc.content_hash}) and confirmed being authorised to accept it on behalf of the customer.${reason ? ` Comment: ${reason}` : ""}`
    : reason;
  const originHint = createHash("sha256").update(`${ctx.ip}|${link.id}`).digest("hex").slice(0, 12); // pseudonymous: no raw IP address is stored
  const ins = await db.from("newquip_quote_responses").insert({
    org_id: link.org_id, quote_id: link.quote_id, document_id: doc.id, response: input.action, contact_name: fullName, responded_on: now.toISOString().slice(0, 10),
    evidence_ref: "Customer response link", note: statement, recorded_by_email: email, recorded_by_owner_email: null,
    origin: "CUSTOMER_LINK", link_id: link.id, contact_email: email, contact_source: "CUSTOMER_PROVIDED", contact_company: company, authority_confirmed: input.action === "ACCEPTED" ? true : false,
    document_hash: doc.content_hash, origin_hint: originHint,
  }).select("*").single();
  if (ins.error || !ins.data) {
    if (/duplicate key|unique/i.test(ins.error?.message ?? "")) return { ok: false, reason: "USED", error: FAILURE_MESSAGE.USED };
    return { ok: false, reason: "UNAVAILABLE", error: FAILURE_MESSAGE.UNAVAILABLE };
  }
  const response = ins.data as StoredResponse;
  await db.from("activity_log").insert({
    org_id: link.org_id, instance_id: null, actor_user_id: null, actor_email: `Customer response link (${email})`, action: `newquip.customer_link_${input.action.toLowerCase()}`,
    summary: `A customer responded through the emailed link: ${input.action} (recorded for internal verification; no project or Cin7 Sale is created)`,
    detail: { quoteId: link.quote_id, responseId: response.id, linkId: link.id, documentId: doc.id, documentHash: doc.content_hash, revision: doc.revision, origin: "CUSTOMER_LINK", originHint, tokenValidation: "VALID", environment: ctx.env, linkExpiresAt: link.expires_at, submittedAt: now.toISOString() },
  });
  const event = input.action === "ACCEPTED" ? "ACCEPTED_PENDING" : input.action === "DECLINED" ? "DECLINED" : "CHANGES_REQUESTED";
  // Queue only (no email provider here): the in-app notification is immediate, the email row waits in the internal outbox. The link target is the INTERNAL Toolbox, set explicitly.
  const internalBaseUrl = ((ctx.baseEnv ?? process.env).NEWQUIP_INTERNAL_APP_URL ?? "").trim() || null;
  await queueResponseNotifications(db, {
    orgId: link.org_id, quoteId: link.quote_id, quoteRef: doc.quote_ref, customerName: doc.content.customer.name, event, response,
    recipients: [link.created_by_email, quote.handoff_by_email, quote.created_by_email], reason: input.action === "ACCEPTED" ? null : reason, internalBaseUrl,
  }).catch(() => undefined);
  return { ok: true, data: { action: input.action, quoteRef: doc.quote_ref, revision: doc.revision, submittedAt: now.toISOString() } };
}

