import "server-only";
// Customer response recording and the acceptance gate. LOCAL ONLY. The rules:
//  - a response is recorded against the EXACT issued document (and so its revision + baseline hash); a document that is no longer current for the approved
//    quotation (revision or baseline changed, or a newer version exists) cannot be answered;
//  - ACCEPTED is final: once recorded nothing else can be recorded for the quotation, and the accepted document can no longer be replaced;
//  - a repeat of the same response with the same evidence returns the original (no duplicate), different evidence is a new entry;
//  - for quotations created after migration 0115 (requires_customer_acceptance = true) a Project can only be created from an ACCEPTED response to the current
//    document. Every quotation that existed at the cutover (flag FALSE, or no column at all) keeps its previous behaviour - they are GRANDFATHERED.
import type { createServiceRoleClient } from "@/supabase/server";
import type { ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import type { ScheduleSource } from "@/newquip/quote/project-template";
import type { QuoteRecord } from "./quote-store";
import { loadQuote } from "./quote-store";
import { listDocuments, type StoredDocument } from "./document-store";
import type { StoredSend } from "./send-store";

type Db = ReturnType<typeof createServiceRoleClient>;
import type { CustomerResponse, StoredResponse, StoredReview } from "@/lib/newquip-portal/core";
export { standingOf, countsAsAcceptance } from "@/lib/newquip-portal/core";
export type { CustomerResponse, StoredResponse, StoredReview, Standing } from "@/lib/newquip-portal/core";
import { standingOf, countsAsAcceptance } from "@/lib/newquip-portal/core";
export type CommercialStatus = "NOT_APPROVED" | "APPROVED_INTERNALLY" | "SENT_TO_CUSTOMER" | "ACCEPTANCE_PENDING_VERIFICATION" | "ACCEPTANCE_REJECTED" | "CUSTOMER_ACCEPTED" | "CUSTOMER_DECLINED" | "CHANGES_REQUESTED";
export const COMMERCIAL_STATUS_LABEL: Record<CommercialStatus, string> = {
  NOT_APPROVED: "Not yet approved", APPROVED_INTERNALLY: "Approved internally", SENT_TO_CUSTOMER: "Sent to customer", ACCEPTANCE_PENDING_VERIFICATION: "Customer accepted: verification pending", ACCEPTANCE_REJECTED: "Customer acceptance rejected on verification", CUSTOMER_ACCEPTED: "Customer acceptance verified", CUSTOMER_DECLINED: "Customer declined", CHANGES_REQUESTED: "Changes requested",
};

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

/** Does this quotation need the customer's acceptance before a Project? Only an explicit TRUE; a missing column (migration 0115 absent) or FALSE is grandfathered. */
export const requiresAcceptance = (q: Pick<QuoteRecord, never> & { requires_customer_acceptance?: boolean | null }): boolean => q.requires_customer_acceptance === true;

export async function listResponses(db: Db, orgId: string, quoteId: string): Promise<StoredResponse[]> {
  const r = await db.from("newquip_quote_responses").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("created_at", { ascending: false });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredResponse[];
}

/** True once migration 0117 is applied (the link / review / evidence tables and the response columns exist). Until then none of the portal features operate. */
export async function portalAvailable(db: Db): Promise<boolean> {
  const t = await db.from("newquip_response_links").select("id").limit(1);
  if (t.error) { if (missing(t.error.message)) return false; throw new Error(t.error.message); }
  return true;
}

export async function listReviews(db: Db, orgId: string, quoteId: string): Promise<StoredReview[]> {
  const r = await db.from("newquip_response_reviews").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("created_at", { ascending: true });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredReview[];
}

/** The quotation's commercial status, derived from the append-only records (never from the internal approval alone). */
export function commercialStatus(q: Pick<QuoteRecord, "state">, latestDoc: StoredDocument | null, sends: StoredSend[], responses: StoredResponse[], reviews: readonly StoredReview[] = [], evidence: ReadonlyMap<string, number> = new Map()): CommercialStatus {
  if (q.state !== "MANAGER_APPROVED_FINAL") return "NOT_APPROVED";
  if (latestDoc) {
    const mine = responses.filter((r) => r.document_id === latestDoc.id);
    if (mine.some((r) => countsAsAcceptance(r, reviews, evidence))) return "CUSTOMER_ACCEPTED";
    const latest = mine[0];
    if (latest) {
      const st = standingOf(latest, reviews, evidence);
      if (latest.response === "ACCEPTED" && (st === "PENDING_VERIFICATION" || st === "EVIDENCE_MISSING")) return "ACCEPTANCE_PENDING_VERIFICATION";
      if (latest.response === "ACCEPTED" && st === "REJECTED") return "ACCEPTANCE_REJECTED";
      if (latest.response === "DECLINED") return "CUSTOMER_DECLINED";
      if (latest.response === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    }
    if (sends.some((s) => s.document_id === latestDoc.id && s.status === "ACCEPTED")) return "SENT_TO_CUSTOMER";
  }
  return "APPROVED_INTERNALLY";
}

export interface ResponseInput {
  documentId: string; response: CustomerResponse; contactName: string; respondedOn: string; evidenceRef: string; note?: string;
  /** Migration 0117: the resolved responding contact (see response-contact.ts), recorded alongside the name. */
  contact?: { source: "DELIVERY_CONTACT" | "CIN7_CONTACT" | "ALTERNATIVE"; email: string | null; exceptionReason: string | null; company: string | null };
  /** A pre-generated id so evidence objects can be stored under the response before it exists. */
  responseId?: string;
  /** How many evidence files accompany this response. A NEW acceptance needs at least one once migration 0117 is applied. */
  evidenceCount?: number;
}

export async function recordCustomerResponse(
  db: Db, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, input: ResponseInput, today: string,
): Promise<{ response: StoredResponse; created: boolean }> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state !== "MANAGER_APPROVED_FINAL") throw new Error("A customer response can only be recorded against an approved, issued quotation.");
  if (!["ACCEPTED", "DECLINED", "CHANGES_REQUESTED"].includes(input.response)) throw new Error("Choose the customer's response.");
  const contactName = input.contactName.trim(); const evidenceRef = input.evidenceRef.trim(); const note = (input.note ?? "").trim();
  if (contactName.length < 2) throw new Error("Enter the name of the customer's contact who responded.");
  if (evidenceRef.length < 3) throw new Error("Enter the evidence reference (for example the email date and subject, or the signed document number).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.respondedOn) || Number.isNaN(Date.parse(input.respondedOn))) throw new Error("Enter the date the customer responded.");
  if (input.respondedOn > today) throw new Error("The response date cannot be in the future.");
  if (input.response === "CHANGES_REQUESTED" && note.length < 3) throw new Error("Describe the changes the customer asked for.");
  const docs = await listDocuments(db, orgId, quoteId);
  const doc = docs.find((d) => d.id === input.documentId);
  if (!doc) throw new Error("That document does not belong to this quotation.");
  if (docs[0].id !== doc.id || doc.revision !== q.revision || doc.baseline_hash !== q.baseline_hash) throw new Error("That is not the current issued revision of this quotation; record the response against the current document.");
  if (input.respondedOn < doc.created_at.slice(0, 10)) throw new Error("The response cannot pre-date the issue of the quotation.");
  const prior = await listResponses(db, orgId, quoteId);
  const reviews = await listReviews(db, orgId, quoteId);
  const portal = await portalAvailable(db);
  if (input.response === "ACCEPTED" && portal && (input.evidenceCount ?? 0) < 1) throw new Error("Attach the supporting evidence for the acceptance (for example the signed quotation or the customer's confirming email).");
  if (portal && prior.some((r) => r.document_id === doc.id && r.response === "ACCEPTED" && standingOf(r, reviews) === "PENDING_VERIFICATION")) throw new Error("The customer's emailed acceptance is waiting for internal verification. Verify or reject it first.");
  if (prior.some((r) => countsAsAcceptance(r, reviews))) {
    const same = prior.find((r) => r.response === input.response && r.document_id === doc.id && r.evidence_ref === evidenceRef);
    if (same) return { response: same, created: false };
    throw new Error("The customer has already accepted this quotation; the acceptance is final.");
  }
  const dup = prior.find((r) => r.document_id === doc.id && r.response === input.response && r.evidence_ref === evidenceRef);
  if (dup) return { response: dup, created: false };
  const ins = await db.from("newquip_quote_responses").insert({
    ...(input.responseId ? { id: input.responseId } : {}),
    org_id: orgId, quote_id: quoteId, document_id: doc.id, response: input.response, contact_name: contactName, responded_on: input.respondedOn, evidence_ref: evidenceRef, note,
    recorded_by_email: who.email, recorded_by_owner_email: who.ownerEmail ?? null,
    // Migration 0117 columns, only once it is applied (older databases have no such columns).
    ...(portal && input.contact ? { origin: "STAFF", contact_email: input.contact.email, contact_source: input.contact.source, contact_company: input.contact.company, exception_reason: input.contact.exceptionReason, document_hash: doc.content_hash } : {}),
  }).select("*").single();
  if (ins.error || !ins.data) throw new Error(`Could not record the response: ${ins.error?.message ?? "no row"}`);
  return { response: ins.data as StoredResponse, created: true };
}

export interface AcceptedTerms { document: StoredDocument; response: StoredResponse; schedule: ScheduleStageTemplate[]; scheduleSource: ScheduleSource | null }

/**
 * The gate. null = this quotation is grandfathered (no acceptance needed). Otherwise returns the accepted document + response + the schedule the customer accepted,
 * or throws when the customer has not accepted the CURRENT issued revision.
 */
export async function requireAcceptance(db: Db, orgId: string, q: QuoteRecord & { requires_customer_acceptance?: boolean | null }): Promise<AcceptedTerms | null> {
  if (!requiresAcceptance(q)) return null;
  const docs = await listDocuments(db, orgId, q.id);
  const doc = docs[0];
  if (!doc || doc.revision !== q.revision || doc.baseline_hash !== q.baseline_hash) throw new Error("The customer must accept the issued quotation before a Project can be created. Issue the quotation, send it, and record the customer's acceptance of that exact version.");
  const [responses, reviews, evidence] = await Promise.all([listResponses(db, orgId, q.id), listReviews(db, orgId, q.id), evidenceCounts(db, orgId, q.id)]);
  const mine = responses.filter((r) => r.document_id === doc.id && r.response === "ACCEPTED");
  const res = mine.find((r) => countsAsAcceptance(r, reviews, evidence));
  if (!res) {
    const st = mine[0] ? standingOf(mine[0], reviews, evidence) : null;
    if (st === "PENDING_VERIFICATION") throw new Error("The customer's emailed acceptance has been received but is awaiting internal verification. Verify it in Customer Acceptance before a Project can be created.");
    if (st === "EVIDENCE_MISSING") throw new Error("The recorded acceptance has no supporting evidence file yet. Attach the evidence in Customer Acceptance before a Project can be created.");
    if (st === "REJECTED") throw new Error("The customer's emailed acceptance was rejected on verification, so it does not authorise a Project.");
    throw new Error("The customer has not accepted this quotation yet. A Project can only be created after the customer's acceptance of the issued quotation is recorded and, if it came by email, verified.");
  }
  const schedule: ScheduleStageTemplate[] = doc.content.paymentSchedule.map((s) => ({ name: s.name, bps: Math.round(s.percent * 100), description: s.description, trigger: s.trigger }));
  return { document: doc, response: res, schedule, scheduleSource: doc.content.scheduleSource ?? null };
}


/** Evidence files per response (empty before migration 0117). */
export async function evidenceCounts(db: Db, orgId: string, quoteId: string): Promise<Map<string, number>> {
  const r = await db.from("newquip_response_evidence").select("response_id").eq("org_id", orgId).eq("quote_id", quoteId);
  const m = new Map<string, number>();
  if (r.error) { if (missing(r.error.message)) return m; throw new Error(r.error.message); }
  for (const x of (r.data ?? []) as Array<{ response_id: string }>) m.set(x.response_id, (m.get(x.response_id) ?? 0) + 1);
  return m;
}

/**
 * Internal verification of an ACCEPTANCE received through the customer's emailed link. A Rep or Manager (checked by the caller) reviews the respondent's identity and
 * authority; VERIFIED makes it the formal acceptance of that exact issued document, REJECTED (with a reason) does not. One review per response, append-only.
 * Nothing here creates a project or a Cin7 Sale.
 */
export async function reviewResponse(
  db: Db, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, input: { responseId: string; decision: "VERIFIED" | "REJECTED"; note: string },
): Promise<{ review: StoredReview; response: StoredResponse; created: boolean }> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state !== "MANAGER_APPROVED_FINAL") throw new Error("Only an approved, issued quotation has customer responses to review.");
  if (input.decision !== "VERIFIED" && input.decision !== "REJECTED") throw new Error("Choose to verify or reject the acceptance.");
  const note = (input.note ?? "").trim();
  if (input.decision === "REJECTED" && note.length < 3) throw new Error("Give the reason the acceptance is being rejected.");
  const responses = await listResponses(db, orgId, quoteId);
  const resp = responses.find((r) => r.id === input.responseId);
  if (!resp) throw new Error("That response does not belong to this quotation.");
  if (resp.origin !== "CUSTOMER_LINK" || resp.response !== "ACCEPTED") throw new Error("Only an acceptance received through the customer's emailed link needs verification.");
  const reviews = await listReviews(db, orgId, quoteId);
  const prior = reviews.find((x) => x.response_id === resp.id);
  if (prior) { if (prior.decision === input.decision) return { review: prior, response: resp, created: false }; throw new Error(`This acceptance was already ${prior.decision === "VERIFIED" ? "verified" : "rejected"}; a review is final.`); }
  // The acceptance must still be of the CURRENT issued document: a response to a superseded revision cannot be verified into force.
  const docs = await listDocuments(db, orgId, quoteId);
  const doc = docs[0];
  if (!doc || doc.id !== resp.document_id || doc.revision !== q.revision || doc.baseline_hash !== q.baseline_hash || (resp.document_hash && resp.document_hash !== doc.content_hash)) {
    if (input.decision === "VERIFIED") throw new Error("That acceptance was given for an earlier version of the quotation, so it cannot be verified. Reject it, or have the customer respond to the current version.");
  }
  if (input.decision === "VERIFIED" && responses.some((r) => r.id !== resp.id && countsAsAcceptance(r, reviews))) throw new Error("This quotation already has a formal acceptance.");
  const ins = await db.from("newquip_response_reviews").insert({
    org_id: orgId, quote_id: quoteId, response_id: resp.id, decision: input.decision, note, reviewed_by_email: who.email, reviewed_by_owner_email: who.ownerEmail ?? null,
  }).select("*").single();
  if (ins.error || !ins.data) {
    if (/duplicate key|unique/i.test(ins.error?.message ?? "")) throw new Error("This acceptance was just reviewed by someone else.");
    throw new Error(`Could not record the review: ${ins.error?.message ?? "no row"}`);
  }
  return { review: ins.data as StoredReview, response: resp, created: true };
}
