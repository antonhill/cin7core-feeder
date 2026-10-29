"use server";

// NewQuip: sending the issued quotation to the customer, retrying a failed send, and recording the customer's response. The only outbound call is the existing Resend
// wrapper (src/lib/email/resend.ts); nothing reaches Cin7. Re-authorised inside EVERY action: the NewQuip org check, then the effective user's role (Demo Mode aware).
// Sending is an explicit Rep action; recording a response needs the Rep or Manager role. Preview sends obey the server-side recipient allowlist. Only async functions
// and erased types are exported.
import { authoriseActor, auditActor, errText, ownerEmailOf, type Actor } from "./actor";
import { createServiceRoleClient } from "@/supabase/server";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { defaultDeps, documentsAvailable, listDocuments } from "@/lib/newquip-quotes/document-store";
import { listSends, retryFailedSend, sendQuotationToCustomer, type SendRequest } from "@/lib/newquip-quotes/send-store";
import { COMMERCIAL_STATUS_LABEL, commercialStatus, listResponses, recordCustomerResponse, requiresAcceptance, type CommercialStatus, type ResponseInput } from "@/lib/newquip-quotes/acceptance";
import { PREVIEW_EMAIL_ALLOWLIST, isRestricted } from "@/lib/approvals/email-policy";
import { emailConfigStatus } from "@/lib/email/resend";

export interface DeliveryActionResult<T> { ok: boolean; error?: string; data?: T }

export interface SendRow { id: string; documentId: string; status: "QUEUED" | "ACCEPTED" | "FAILED" | "SUPPRESSED"; to: string[]; cc: string[]; suppressed: string[]; subject: string; sentBy: string; at: string; providerMessageId: string | null; error: string | null; resendOf: string | null; resendReason: string | null }
export interface ResponseRow { id: string; documentId: string; response: "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED"; contact: string; respondedOn: string; evidence: string; note: string; recordedBy: string; at: string }
export interface DeliveryView {
  available: boolean;
  status: CommercialStatus; statusLabel: string;
  requiresAcceptance: boolean; accepted: boolean;
  latestDocumentId: string | null; defaultTo: string | null;
  sends: SendRow[]; responses: ResponseRow[];
  canSend: boolean; canRecord: boolean;
  /** Preview / non-production: only these mailboxes are emailed. */
  policy: { restricted: boolean; allowlist: string[]; emailConfigured: boolean };
}

const canRecordRole = (a: Actor) => a.roles.has("rep") || a.roles.has("manager");

async function viewOf(a: Actor, quoteId: string): Promise<DeliveryView> {
  const db = createServiceRoleClient();
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  const restricted = isRestricted(process.env);
  const policy = { restricted, allowlist: restricted ? [...PREVIEW_EMAIL_ALLOWLIST] : [], emailConfigured: emailConfigStatus().configured };
  if (!(await documentsAvailable(db))) return { available: false, status: "NOT_APPROVED", statusLabel: "", requiresAcceptance: false, accepted: false, latestDocumentId: null, defaultTo: null, sends: [], responses: [], canSend: false, canRecord: false, policy };
  const [docs, sends, responses] = await Promise.all([listDocuments(db, a.orgId, quoteId), listSends(db, a.orgId, quoteId), listResponses(db, a.orgId, quoteId)]);
  const latest = docs[0] ?? null;
  const status = commercialStatus(q, latest, sends, responses);
  const current = !!latest && latest.revision === q.revision && latest.baseline_hash === q.baseline_hash && q.state === "MANAGER_APPROVED_FINAL";
  return {
    available: true, status, statusLabel: COMMERCIAL_STATUS_LABEL[status], requiresAcceptance: requiresAcceptance(q), accepted: status === "CUSTOMER_ACCEPTED",
    latestDocumentId: latest?.id ?? null, defaultTo: latest?.content.customer.contactEmail ?? null,
    sends: sends.map((s) => ({ id: s.id, documentId: s.document_id, status: s.status, to: s.to_emails, cc: s.cc_emails, suppressed: s.suppressed_emails, subject: s.subject, sentBy: s.sent_by_email, at: s.attempted_at ?? s.created_at, providerMessageId: s.provider_message_id, error: s.last_error, resendOf: s.resend_of, resendReason: s.resend_reason })),
    responses: responses.map((r) => ({ id: r.id, documentId: r.document_id, response: r.response, contact: r.contact_name, respondedOn: r.responded_on, evidence: r.evidence_ref, note: r.note, recordedBy: r.recorded_by_email, at: r.created_at })),
    canSend: current && a.roles.has("rep") && status !== "CUSTOMER_ACCEPTED", canRecord: current && canRecordRole(a),
    policy,
  };
}

export async function getQuoteDeliveryAction(quoteId: string): Promise<DeliveryActionResult<DeliveryView>> {
  try { return { ok: true, data: await viewOf(await authoriseActor(), quoteId) }; } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Rep: email the approved, issued quotation PDF. `idempotencyKey` identifies the dialog, so a double click sends once. */
export async function sendQuoteToCustomerAction(quoteId: string, req: SendRequest): Promise<DeliveryActionResult<{ view: DeliveryView; status: string; reused: boolean }>> {
  try {
    const a = await authoriseActor();
    if (!a.roles.has("rep")) throw new Error("Only a Rep can send a quotation to a customer.");
    const db = createServiceRoleClient();
    const r = await sendQuotationToCustomer(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) }, req, defaultDeps(db), process.env);
    if (!r.reused) await auditActor(db, a, { action: "newquip.quote_sent_to_customer", summary: `Customer quotation send recorded as ${r.send.status} (provider acceptance is not proof of inbox delivery; no Cin7 write)`, detail: { quoteId, sendId: r.send.id, documentId: r.send.document_id, status: r.send.status, to: r.send.to_emails, cc: r.send.cc_emails, suppressed: r.send.suppressed_emails, resendOf: r.send.resend_of } });
    return { ok: true, data: { view: await viewOf(a, quoteId), status: r.send.status, reused: r.reused } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Rep: controlled retry of a FAILED send (one at a time; never an accepted one). */
export async function retryQuoteSendAction(quoteId: string, sendId: string): Promise<DeliveryActionResult<{ view: DeliveryView; status: string }>> {
  try {
    const a = await authoriseActor();
    if (!a.roles.has("rep")) throw new Error("Only a Rep can send a quotation to a customer.");
    const db = createServiceRoleClient();
    const row = (await listSends(db, a.orgId, quoteId)).find((s) => s.id === sendId);
    if (!row) throw new Error("Send not found.");
    const r = await retryFailedSend(db, a.orgId, sendId, defaultDeps(db), process.env);
    await auditActor(db, a, { action: "newquip.quote_send_retried", summary: `Retried a failed customer quotation send: now ${r.status}`, detail: { quoteId, sendId, status: r.status } });
    return { ok: true, data: { view: await viewOf(a, quoteId), status: r.status } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Rep or Manager: record the customer's acceptance / decline / change request against the current issued document, with evidence. */
export async function recordCustomerResponseAction(quoteId: string, input: ResponseInput): Promise<DeliveryActionResult<DeliveryView>> {
  try {
    const a = await authoriseActor();
    if (!canRecordRole(a)) throw new Error("You do not have permission to record a customer response.");
    const db = createServiceRoleClient();
    const r = await recordCustomerResponse(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) }, input, new Date().toISOString().slice(0, 10));
    if (r.created) await auditActor(db, a, { action: `newquip.customer_${r.response.response.toLowerCase()}`, summary: `Recorded the customer's response: ${r.response.response} (no project or Cin7 Sale is created by this step)`, detail: { quoteId, responseId: r.response.id, documentId: r.response.document_id, contact: r.response.contact_name, evidence: r.response.evidence_ref } });
    return { ok: true, data: await viewOf(a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
