import "server-only";
// The PUBLIC side of a customer response: what the emailed link shows, and the explicit POST that records a response. The quotation page only SHOWS the offer (the token is not
// sent in the URL: see /quote-response), and nothing is recorded until the customer submits the form. Possession of the link does not prove authority to sign: an ACCEPTANCE needs
// the respondent's name, company, email, an explicit authority confirmation and an explicit acceptance of the identified revision, and then WAITS for internal verification
// (Customer Acceptance, Stage 5) before it can authorise anything. Nothing here creates a project or a Cin7 Sale, and nothing is written to Cin7.
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import { isValidEmail } from "./customer-snapshot";
import { FAILURE_MESSAGE, MAX_LINK_ATTEMPTS, noteFailedAttempt, resolveLink, type LinkEnv, type LinkFailure } from "./response-links";
import { notifyResponseEvent } from "./response-notify";
import type { CustomerResponse, StoredResponse } from "./acceptance";

type Db = ReturnType<typeof createServiceRoleClient>;

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
export async function submitPublicResponse(db: Db, input: PublicSubmit, ctx: { ip: string; env: LinkEnv; now?: Date; baseEnv?: Record<string, string | undefined> }): Promise<PublicResult<{ action: CustomerResponse; quoteRef: string }>> {
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

  const originHint = createHash("sha256").update(`${ctx.ip}|${link.id}`).digest("hex").slice(0, 12); // pseudonymous: no raw IP address is stored
  const ins = await db.from("newquip_quote_responses").insert({
    org_id: link.org_id, quote_id: link.quote_id, document_id: doc.id, response: input.action, contact_name: fullName, responded_on: now.toISOString().slice(0, 10),
    evidence_ref: "Customer response link", note: reason, recorded_by_email: email, recorded_by_owner_email: null,
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
    detail: { quoteId: link.quote_id, responseId: response.id, linkId: link.id, documentId: doc.id, revision: doc.revision, origin: "CUSTOMER_LINK", originHint },
  });
  const event = input.action === "ACCEPTED" ? "ACCEPTED_PENDING" : input.action === "DECLINED" ? "DECLINED" : "CHANGES_REQUESTED";
  await notifyResponseEvent(db, {
    orgId: link.org_id, quoteId: link.quote_id, quoteRef: doc.quote_ref, customerName: doc.content.customer.name, event, response,
    recipients: [link.created_by_email, quote.handoff_by_email, quote.created_by_email], reason: input.action === "ACCEPTED" ? null : reason,
  }, (ctx.baseEnv ?? process.env) as never).catch(() => undefined);
  return { ok: true, data: { action: input.action, quoteRef: doc.quote_ref } };
}
export { MAX_LINK_ATTEMPTS };
