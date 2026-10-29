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
export type CustomerResponse = "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED";
export interface StoredResponse {
  id: string; org_id: string; quote_id: string; document_id: string; response: CustomerResponse; contact_name: string; responded_on: string; evidence_ref: string; note: string;
  recorded_by_email: string; recorded_by_owner_email: string | null; created_at: string;
}
export type CommercialStatus = "NOT_APPROVED" | "APPROVED_INTERNALLY" | "SENT_TO_CUSTOMER" | "CUSTOMER_ACCEPTED" | "CUSTOMER_DECLINED" | "CHANGES_REQUESTED";
export const COMMERCIAL_STATUS_LABEL: Record<CommercialStatus, string> = {
  NOT_APPROVED: "Not yet approved", APPROVED_INTERNALLY: "Approved internally", SENT_TO_CUSTOMER: "Sent to customer", CUSTOMER_ACCEPTED: "Customer accepted", CUSTOMER_DECLINED: "Customer declined", CHANGES_REQUESTED: "Changes requested",
};

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

/** Does this quotation need the customer's acceptance before a Project? Only an explicit TRUE; a missing column (migration 0115 absent) or FALSE is grandfathered. */
export const requiresAcceptance = (q: Pick<QuoteRecord, never> & { requires_customer_acceptance?: boolean | null }): boolean => q.requires_customer_acceptance === true;

export async function listResponses(db: Db, orgId: string, quoteId: string): Promise<StoredResponse[]> {
  const r = await db.from("newquip_quote_responses").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("created_at", { ascending: false });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredResponse[];
}

/** The quotation's commercial status, derived from the append-only records (never from the internal approval alone). */
export function commercialStatus(q: Pick<QuoteRecord, "state">, latestDoc: StoredDocument | null, sends: StoredSend[], responses: StoredResponse[]): CommercialStatus {
  if (q.state !== "MANAGER_APPROVED_FINAL") return "NOT_APPROVED";
  if (latestDoc) {
    const mine = responses.filter((r) => r.document_id === latestDoc.id);
    if (mine.some((r) => r.response === "ACCEPTED")) return "CUSTOMER_ACCEPTED";
    const latest = mine[0];
    if (latest?.response === "DECLINED") return "CUSTOMER_DECLINED";
    if (latest?.response === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (sends.some((s) => s.document_id === latestDoc.id && s.status === "ACCEPTED")) return "SENT_TO_CUSTOMER";
  }
  return "APPROVED_INTERNALLY";
}

export interface ResponseInput { documentId: string; response: CustomerResponse; contactName: string; respondedOn: string; evidenceRef: string; note?: string }

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
  if (prior.some((r) => r.response === "ACCEPTED")) {
    const same = prior.find((r) => r.response === input.response && r.document_id === doc.id && r.evidence_ref === evidenceRef);
    if (same) return { response: same, created: false };
    throw new Error("The customer has already accepted this quotation; the acceptance is final.");
  }
  const dup = prior.find((r) => r.document_id === doc.id && r.response === input.response && r.evidence_ref === evidenceRef);
  if (dup) return { response: dup, created: false };
  const ins = await db.from("newquip_quote_responses").insert({
    org_id: orgId, quote_id: quoteId, document_id: doc.id, response: input.response, contact_name: contactName, responded_on: input.respondedOn, evidence_ref: evidenceRef, note,
    recorded_by_email: who.email, recorded_by_owner_email: who.ownerEmail ?? null,
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
  if (!doc || doc.revision !== q.revision || doc.baseline_hash !== q.baseline_hash) throw new Error("The customer must accept the issued quotation before a Project can be created. Issue the quotation, send it, and record the customer's acceptance.");
  const res = (await listResponses(db, orgId, q.id)).find((r) => r.document_id === doc.id && r.response === "ACCEPTED");
  if (!res) throw new Error("The customer has not accepted this quotation yet. A Project can only be created after you record the customer's acceptance of the issued quotation.");
  const schedule: ScheduleStageTemplate[] = doc.content.paymentSchedule.map((s) => ({ name: s.name, bps: Math.round(s.percent * 100), description: s.description, trigger: s.trigger }));
  return { document: doc, response: res, schedule, scheduleSource: doc.content.scheduleSource ?? null };
}

