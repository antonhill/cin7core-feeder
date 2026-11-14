import "server-only";
// NewQuip quote page: the READ-ONLY views the page loads on open, kept out of the "use server" action files so that they can be shared by the individual actions AND the one-call
// page bundle (getQuotePageBundleAction) without ever becoming callable from the browser themselves. Every caller passes the database client and an Actor it has just authorised: nothing in here
// authorises, writes, or reaches Cin7.
import type { Actor, Db } from "./actor";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { documentsAvailable, latestProfile, listDocuments } from "@/lib/newquip-quotes/document-store";
import { latestSnapshot } from "@/lib/newquip-quotes/customer-store";
import { snapshotIssues } from "@/lib/newquip-quotes/customer-snapshot";
import { missingProfileFields } from "@/lib/newquip-quotes/company-profile";
import { listSends } from "@/lib/newquip-quotes/send-store";
import { COMMERCIAL_STATUS_LABEL, commercialStatus, evidenceCounts, listResponses, listReviews, portalAvailable, requiresAcceptance, standingOf } from "@/lib/newquip-quotes/acceptance";
import { listEvidence } from "@/lib/newquip-quotes/response-evidence";
import { listLinks } from "@/lib/newquip-quotes/response-links";
import { fieldValue } from "@/lib/newquip-quotes/customer-snapshot";
import { PREVIEW_EMAIL_ALLOWLIST, isRestricted, productionEmailBlocked } from "@/lib/approvals/email-policy";
import { emailConfigStatus } from "@/lib/email/resend";
import type { DeliveryView } from "./delivery-actions";
import type { QuoteDocumentsView } from "./document-actions";

const canRecordRole = (a: Actor) => a.roles.has("rep") || a.roles.has("manager");

export async function deliveryViewOf(db: Db, a: Actor, quoteId: string): Promise<DeliveryView> {
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


/** The issued documents of a quotation and what blocks issuing another (the body of getQuoteDocumentsAction). */
export async function documentsViewOf(db: Db, a: Actor, quoteId: string): Promise<QuoteDocumentsView> {
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (!(await documentsAvailable(db))) return { available: false, documents: [], blockers: [], canIssue: false };
  const docs = await listDocuments(db, a.orgId, quoteId);
  const blockers: string[] = [];
  if (q.state !== "MANAGER_APPROVED_FINAL") blockers.push("The quotation must be approved by a Manager before a customer document can be issued.");
  else {
    const s = await latestSnapshot(db, a.orgId, quoteId);
    blockers.push(...(s ? snapshotIssues(s.snapshot) : ["Select the customer from Cin7."]));
    const missing = missingProfileFields((await latestProfile(db, a.orgId))?.profile);
    if (missing.length) blockers.push(`NewQuip company details are incomplete: ${missing.join(", ")}.`);
  }
  return { available: true, blockers, canIssue: (a.roles.has("rep") || a.roles.has("manager")) && blockers.length === 0,
    documents: docs.map((d) => ({ id: d.id, version: d.version, revision: d.revision, issuedAt: d.created_at, issuedBy: d.issued_by_email, byteSize: d.byte_size, contentHash: d.content_hash })) };
}
