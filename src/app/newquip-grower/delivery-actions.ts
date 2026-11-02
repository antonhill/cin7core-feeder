"use server";

// NewQuip: sending the issued quotation to the customer, retrying a failed send, and recording the customer's response. The only outbound call is the existing Resend
// wrapper (src/lib/email/resend.ts); nothing reaches Cin7. Re-authorised inside EVERY action: the NewQuip org check, then the effective user's role (Demo Mode aware).
// Sending is an explicit Rep action; recording a response needs the Rep or Manager role. Preview sends obey the server-side recipient allowlist. Only async functions
// and erased types are exported.
import { authoriseActor, auditActor, errText, ownerEmailOf, type Actor } from "./actor";
import { createServiceRoleClient } from "@/supabase/server";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { defaultDeps, documentsAvailable, listDocuments } from "@/lib/newquip-quotes/document-store";
import { latestSnapshot } from "@/lib/newquip-quotes/customer-store";
import { listSends, retryFailedSend, sendQuotationToCustomer, type SendRequest } from "@/lib/newquip-quotes/send-store";
import { COMMERCIAL_STATUS_LABEL, commercialStatus, evidenceCounts, listResponses, listReviews, portalAvailable, recordCustomerResponse, requiresAcceptance, reviewResponse, standingOf, type CommercialStatus, type ResponseInput, type Standing } from "@/lib/newquip-quotes/acceptance";
import { listEvidence } from "@/lib/newquip-quotes/response-evidence";
import { listLinks, revokeActiveLinks } from "@/lib/newquip-quotes/response-links";
import { notifyResponseEvent } from "@/lib/newquip-quotes/response-notify";
import { recordStaffResponse, type StaffResponseInput } from "@/lib/newquip-quotes/response-record";
import { fieldValue } from "@/lib/newquip-quotes/customer-snapshot";
import { PREVIEW_EMAIL_ALLOWLIST, isRestricted, productionEmailBlocked } from "@/lib/approvals/email-policy";
import { emailConfigStatus } from "@/lib/email/resend";

export interface DeliveryActionResult<T> { ok: boolean; error?: string; data?: T }

export interface SendRow { id: string; documentId: string; status: "QUEUED" | "ACCEPTED" | "FAILED" | "SUPPRESSED"; to: string[]; cc: string[]; suppressed: string[]; alternatives: string[]; alternativeReason: string | null; subject: string; sentBy: string; at: string; providerMessageId: string | null; error: string | null; resendOf: string | null; resendReason: string | null }
export interface EvidenceRow { id: string; fileName: string; type: string; bytes: number; sha256: string; uploadedBy: string; at: string; description: string }
export interface ResponseRow {
  id: string; documentId: string; response: "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED"; contact: string; respondedOn: string; evidence: string; note: string; recordedBy: string; at: string;
  /** Migration 0117 (defaults describe a response recorded before it). */
  origin: "STAFF" | "CUSTOMER_LINK"; standing: Standing; contactEmail: string | null; contactSource: string | null; company: string | null; exceptionReason: string | null; authorityConfirmed: boolean;
  files: EvidenceRow[]; review: { decision: "VERIFIED" | "REJECTED"; note: string; by: string; at: string } | null;
}
export interface DeliveryView {
  available: boolean;
  status: CommercialStatus; statusLabel: string;
  requiresAcceptance: boolean; accepted: boolean;
  latestDocumentId: string | null; defaultTo: string | null;
  sends: SendRow[]; responses: ResponseRow[];
  canSend: boolean; canRecord: boolean;
  /** Migration 0117 applied: contact selection, evidence files, emailed response links and verification operate. */
  portal: boolean;
  /** Who may respond: the customer's Cin7 contacts (frozen snapshot of the issued document) and the contact the quotation was addressed to. */
  responseContacts: Array<{ index: number; name: string; email: string | null }>; deliveryContact: { name: string; email: string } | null;
  /** Rep / Manager: may verify or reject an emailed acceptance. */
  canReview: boolean;
  links: { state: "NONE" | "ACTIVE" | "EXPIRED" | "REVOKED"; expiresOn: string | null };
  /** Cin7 contact emails of the selected customer. In Production any other recipient needs an audited reason. */
  contactEmails: string[];
  /** Preview / non-production: only these mailboxes are emailed. */
  policy: { restricted: boolean; production: boolean; allowlist: string[]; emailConfigured: boolean; productionEmailOff: boolean };
}

const canRecordRole = (a: Actor) => a.roles.has("rep") || a.roles.has("manager");

async function viewOf(a: Actor, quoteId: string): Promise<DeliveryView> {
  const db = createServiceRoleClient();
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  const restricted = isRestricted(process.env);
  const policy = { restricted, production: !restricted, allowlist: restricted ? [...PREVIEW_EMAIL_ALLOWLIST] : [], emailConfigured: emailConfigStatus().configured, productionEmailOff: productionEmailBlocked(process.env) };
  if (!(await documentsAvailable(db))) return { available: false, status: "NOT_APPROVED", statusLabel: "", requiresAcceptance: false, accepted: false, latestDocumentId: null, defaultTo: null, sends: [], responses: [], canSend: false, canRecord: false, portal: false, responseContacts: [], deliveryContact: null, canReview: false, links: { state: "NONE", expiresOn: null }, contactEmails: [], policy };
  const [docs, sends, responses] = await Promise.all([listDocuments(db, a.orgId, quoteId), listSends(db, a.orgId, quoteId), listResponses(db, a.orgId, quoteId)]);
  const latest = docs[0] ?? null;
  const snap = await latestSnapshot(db, a.orgId, quoteId);
  const portal = await portalAvailable(db);
  const [reviews, evidence, files, links] = portal ? await Promise.all([listReviews(db, a.orgId, quoteId), evidenceCounts(db, a.orgId, quoteId), listEvidence(db, a.orgId, quoteId), listLinks(db, a.orgId, quoteId)]) : [[], new Map<string, number>(), [], []];
  const status = commercialStatus(q, latest, sends, responses, reviews, evidence);
  const docSnap = latest ? (await db.from("newquip_quote_customers").select("snapshot").eq("org_id", a.orgId).eq("id", latest.customer_snapshot_id).maybeSingle()).data as { snapshot: import("@/lib/newquip-quotes/customer-snapshot").CustomerSnapshot } | null : null;
  const mineLinks = latest ? links.filter((l) => l.document_id === latest.id) : [];
  const liveLink = mineLinks.find((l) => !l.revoked_at && new Date(l.expires_at).getTime() > Date.now());
  const linkState = liveLink ? "ACTIVE" as const : mineLinks.length === 0 ? "NONE" as const : mineLinks.every((l) => l.revoked_at) ? "REVOKED" as const : "EXPIRED" as const;
  const current = !!latest && latest.revision === q.revision && latest.baseline_hash === q.baseline_hash && q.state === "MANAGER_APPROVED_FINAL";
  return {
    available: true, status, statusLabel: COMMERCIAL_STATUS_LABEL[status], requiresAcceptance: requiresAcceptance(q), accepted: status === "CUSTOMER_ACCEPTED",
    latestDocumentId: latest?.id ?? null, defaultTo: latest?.content.customer.contactEmail ?? null,
    sends: sends.map((s) => ({ id: s.id, documentId: s.document_id, status: s.status, to: s.to_emails, cc: s.cc_emails, suppressed: s.suppressed_emails, alternatives: s.alternative_recipients ?? [], alternativeReason: s.alternative_reason, subject: s.subject, sentBy: s.sent_by_email, at: s.attempted_at ?? s.created_at, providerMessageId: s.provider_message_id, error: s.last_error, resendOf: s.resend_of, resendReason: s.resend_reason })),
    responses: responses.map((r) => {
      const rv = reviews.find((x) => x.response_id === r.id);
      return {
        id: r.id, documentId: r.document_id, response: r.response, contact: r.contact_name, respondedOn: r.responded_on, evidence: r.evidence_ref, note: r.note, recordedBy: r.recorded_by_email, at: r.created_at,
        origin: r.origin ?? "STAFF", standing: standingOf(r, reviews, evidence), contactEmail: r.contact_email ?? null, contactSource: r.contact_source ?? null, company: r.contact_company ?? null, exceptionReason: r.exception_reason ?? null, authorityConfirmed: r.authority_confirmed ?? false,
        files: files.filter((f) => f.response_id === r.id).map((f) => ({ id: f.id, fileName: f.file_name, type: f.content_type, bytes: f.byte_size, sha256: f.sha256, uploadedBy: f.uploaded_by_email, at: f.created_at, description: f.description })),
        review: rv ? { decision: rv.decision, note: rv.note, by: rv.reviewed_by_email, at: rv.created_at } : null,
      };
    }),
    portal, deliveryContact: latest ? { name: latest.content.customer.contactName, email: latest.content.customer.contactEmail } : null,
    responseContacts: (docSnap?.snapshot.contacts ?? []).map((c, index) => ({ index, name: fieldValue(c.name) ?? "", email: fieldValue(c.email) })).filter((c) => c.name),
    canReview: current && canRecordRole(a), links: { state: linkState, expiresOn: liveLink?.expires_at.slice(0, 10) ?? null },
    canSend: current && a.roles.has("rep") && status !== "CUSTOMER_ACCEPTED", canRecord: current && canRecordRole(a),
    contactEmails: [...new Set([...(snap?.snapshot.contacts ?? []).map((c) => (c.email.state === "present" ? c.email.value : "")), snap?.snapshot.chosenContact?.email ?? ""].filter(Boolean))],
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
export async function recordCustomerResponseAction(quoteId: string, input: Omit<ResponseInput, "contact" | "responseId" | "evidenceCount"> & { contact?: StaffResponseInput["contact"] }): Promise<DeliveryActionResult<DeliveryView>> {
  try {
    const a = await authoriseActor();
    if (!canRecordRole(a)) throw new Error("You do not have permission to record a customer response.");
    const db = createServiceRoleClient();
    const who = { email: a.email, ownerEmail: ownerEmailOf(a) };
    const today = new Date().toISOString().slice(0, 10);
    // With a chosen responding contact (migration 0117) the shared record path validates and resolves it; the file-bearing variant is the upload route.
    const r = input.contact
      ? await recordStaffResponse(db, defaultDeps(db).storage, a.orgId, quoteId, who, { documentId: input.documentId, response: input.response, contact: input.contact, respondedOn: input.respondedOn, evidenceRef: input.evidenceRef, note: input.note }, [], today)
      : await recordCustomerResponse(db, a.orgId, quoteId, who, { documentId: input.documentId, response: input.response, contactName: input.contactName, respondedOn: input.respondedOn, evidenceRef: input.evidenceRef, note: input.note }, today);
    if (r.created) await auditActor(db, a, { action: `newquip.customer_${r.response.response.toLowerCase()}`, summary: `Recorded the customer's response: ${r.response.response} (no project or Cin7 Sale is created by this step)`, detail: { quoteId, responseId: r.response.id, documentId: r.response.document_id, contact: r.response.contact_name, evidence: r.response.evidence_ref } });
    return { ok: true, data: await viewOf(a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Rep or Manager: verify or reject an ACCEPTANCE that arrived through the customer's emailed link. Only a verified acceptance of the current issued document can lead to a Project. */
export async function reviewCustomerResponseAction(quoteId: string, input: { responseId: string; decision: "VERIFIED" | "REJECTED"; note: string }): Promise<DeliveryActionResult<DeliveryView>> {
  try {
    const a = await authoriseActor();
    if (!canRecordRole(a)) throw new Error("Only a Rep or Manager can verify a customer's acceptance.");
    const db = createServiceRoleClient();
    const r = await reviewResponse(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) }, input);
    if (r.created) {
      await auditActor(db, a, { action: `newquip.customer_acceptance_${input.decision.toLowerCase()}`, summary: `${input.decision === "VERIFIED" ? "Verified" : "Rejected"} a customer's emailed acceptance (no project or Cin7 Sale is created by this step)`, detail: { quoteId, responseId: r.response.id, decision: input.decision, linkId: r.response.link_id ?? null } });
      const q = await loadQuote(db, a.orgId, quoteId);
      if (q) await notifyResponseEvent(db, { orgId: a.orgId, quoteId, quoteRef: q.quote_ref, customerName: q.customer_name, event: input.decision === "VERIFIED" ? "VERIFIED" : "REJECTED_ON_VERIFICATION", response: r.response, recipients: [q.handoff_by_email, q.created_by_email, ...(await listSends(db, a.orgId, quoteId)).filter((x) => x.document_id === r.response.document_id).map((x) => x.sent_by_email)], by: a.email, reason: input.decision === "REJECTED" ? input.note : null }).catch(() => undefined);
    }
    return { ok: true, data: await viewOf(a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Rep or Manager: withdraw every active emailed response link of the quotation (for example after a wrong recipient). A later send issues a fresh link. */
export async function revokeResponseLinksAction(quoteId: string, reason: string): Promise<DeliveryActionResult<DeliveryView>> {
  try {
    const a = await authoriseActor();
    if (!canRecordRole(a)) throw new Error("You do not have permission to withdraw response links.");
    if ((reason ?? "").trim().length < 3) throw new Error("Give a reason for withdrawing the links.");
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const n = await revokeActiveLinks(db, a.orgId, quoteId, reason.trim());
    if (n) await auditActor(db, a, { action: "newquip.response_links_revoked", summary: "Withdrew the customer's emailed response links", detail: { quoteId, count: n, reason: reason.trim() } });
    return { ok: true, data: await viewOf(a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
