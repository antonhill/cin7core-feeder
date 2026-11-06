import "server-only";
// Staff recording of a customer's response WITH its responding contact and evidence files. One code path for the server action (no files) and the upload route (files).
// Order: validate the files and contact -> insert the response (a pre-generated id) -> store and register the evidence under it. A NEW acceptance (migration 0117 applied) only
// counts once at least one evidence file is registered, so a failure between the two steps can never leave an unevidenced acceptance in force; "attach evidence" completes it.
import { randomUUID } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import { recordCustomerResponse, type CustomerResponse, type StoredResponse } from "./acceptance";
import { loadDocument, type DocumentStorage } from "./document-store";
import { checkEvidenceFiles, storeEvidence, type StoredEvidence } from "./response-evidence";
import { resolveResponseContact, type ResponseContactInput } from "./response-contact";
import type { CustomerSnapshot } from "./customer-snapshot";
import { listDocuments } from "./document-store";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface StaffResponseInput { documentId: string; response: CustomerResponse; contact: ResponseContactInput; respondedOn: string; evidenceRef: string; note?: string }

/** The frozen customer snapshot the issued document was built from. */
async function snapshotOf(db: Db, orgId: string, snapshotId: string): Promise<CustomerSnapshot | null> {
  const r = await db.from("newquip_quote_customers").select("snapshot").eq("org_id", orgId).eq("id", snapshotId).maybeSingle();
  return (r.data as { snapshot: CustomerSnapshot } | null)?.snapshot ?? null;
}

export async function recordStaffResponse(
  db: Db, storage: DocumentStorage, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, input: StaffResponseInput, files: Array<{ name: string; bytes: Uint8Array }>, today: string,
): Promise<{ response: StoredResponse; created: boolean; evidence: StoredEvidence[] }> {
  const checked = checkEvidenceFiles(files);
  const doc = await loadDocument(db, orgId, input.documentId);
  if (!doc || doc.quote_id !== quoteId) throw new Error("That document does not belong to this quotation.");
  const snap = await snapshotOf(db, orgId, doc.customer_snapshot_id);
  const resolved = resolveResponseContact(snap, { name: doc.content.customer.contactName, email: doc.content.customer.contactEmail }, input.contact);
  const responseId = randomUUID();
  const r = await recordCustomerResponse(db, orgId, quoteId, who, {
    documentId: doc.id, response: input.response, contactName: resolved.name, respondedOn: input.respondedOn, evidenceRef: input.evidenceRef, note: input.note,
    contact: { source: resolved.source, email: resolved.email, exceptionReason: resolved.exceptionReason, company: doc.content.customer.name }, responseId, evidenceCount: checked.length,
  }, today);
  if (!r.created) return { response: r.response, created: false, evidence: [] };
  const evidence = checked.length ? await storeEvidence(db, storage, { orgId, quoteId, documentId: doc.id, responseId: r.response.id }, checked, who) : [];
  return { response: r.response, created: true, evidence };
}

/** Adds evidence files to an EXISTING response of this quotation (never replaces anything). */
export async function attachEvidence(
  db: Db, storage: DocumentStorage, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, responseId: string, files: Array<{ name: string; bytes: Uint8Array }>, description = "",
): Promise<StoredEvidence[]> {
  if (files.length === 0) throw new Error("Choose at least one file to attach.");
  const checked = checkEvidenceFiles(files);
  const r = await db.from("newquip_quote_responses").select("*").eq("org_id", orgId).eq("quote_id", quoteId).eq("id", responseId).maybeSingle();
  const resp = r.data as StoredResponse | null;
  if (!resp) throw new Error("That response does not belong to this quotation.");
  const docs = await listDocuments(db, orgId, quoteId);
  if (!docs.some((d) => d.id === resp.document_id)) throw new Error("That response does not belong to this quotation.");
  return storeEvidence(db, storage, { orgId, quoteId, documentId: resp.document_id, responseId: resp.id }, checked, who, description);
}
