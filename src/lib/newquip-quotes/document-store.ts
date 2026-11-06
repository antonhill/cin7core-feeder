import "server-only";
// NewQuip customer quotation documents - persistence and issuing. LOCAL ONLY: nothing here reaches Cin7. A document is issued only for a Manager-approved quotation,
// from its sealed baseline, and is then immutable: a different document never replaces an earlier one (a changed input gets the next VERSION; the old file and row stay).
// The PDF lives in a PRIVATE bucket (service role only) and is retrieved through an authenticated, organisation-checked route; its SHA-256 is re-verified on every read.
// Every query is scoped by org_id.
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import { baselineMatchesHash, hashOf } from "@/newquip/quote/baseline";
import type { ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import type { ScheduleSource } from "@/newquip/quote/project-template";
import { loadQuote } from "./quote-store";
import { latestSnapshot } from "./customer-store";
import { fieldValue, snapshotIssues } from "./customer-snapshot";
import { assertNoInternalLeak, buildCustomerDocumentModel, type CustomerDocumentModel } from "./customer-document";
import { cleanProfile, missingProfileFields, type CompanyProfile } from "./company-profile";
import { renderCustomerPdf } from "./customer-pdf";

type Db = ReturnType<typeof createServiceRoleClient>;
export const DOCUMENT_BUCKET = "newquip-quote-documents";

export interface DocumentStorage { upload(path: string, bytes: Uint8Array, contentType?: string): Promise<void>; download(path: string): Promise<Uint8Array>; remove(path: string): Promise<void> }
export interface DocumentDeps { render: (m: CustomerDocumentModel) => Promise<Uint8Array>; storage: DocumentStorage; today: () => string }

export function supabaseStorage(db: Db): DocumentStorage {
  const bucket = () => db.storage.from(DOCUMENT_BUCKET);
  return {
    async upload(path, bytes, contentType = "application/pdf") { const r = await bucket().upload(path, bytes, { contentType, upsert: false }); if (r.error) throw new Error(`Could not store the quotation PDF: ${r.error.message}`); },
    async download(path) { const r = await bucket().download(path); if (r.error || !r.data) throw new Error("The quotation PDF could not be read."); return new Uint8Array(await r.data.arrayBuffer()); },
    async remove(path) { await bucket().remove([path]); },
  };
}
export const defaultDeps = (db: Db): DocumentDeps => ({ render: renderCustomerPdf, storage: supabaseStorage(db), today: () => new Date().toISOString().slice(0, 10) });

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");
export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export interface StoredProfile { id: string; org_id: string; version: number; profile: CompanyProfile; entered_by_email: string; created_at: string }
export interface StoredDocument {
  id: string; org_id: string; quote_id: string; quote_ref: string; revision: number; version: number; baseline_hash: string; customer_snapshot_id: string; company_profile_id: string;
  storage_path: string; content_hash: string; byte_size: number; content: CustomerDocumentModel; issued_by_email: string; issued_by_owner_email: string | null; created_at: string;
}

export async function documentsAvailable(db: Db): Promise<boolean> {
  const r = await db.from("newquip_quote_documents").select("id").limit(1);
  if (!r.error) return true;
  if (missing(r.error.message)) return false;
  throw new Error(r.error.message);
}

// ── company profile ─────────────────────────────────────────────────────────
export async function latestProfile(db: Db, orgId: string): Promise<StoredProfile | null> {
  const r = await db.from("newquip_company_profiles").select("*").eq("org_id", orgId).order("version", { ascending: false }).limit(1);
  if (r.error) { if (missing(r.error.message)) return null; throw new Error(r.error.message); }
  return ((r.data ?? []) as StoredProfile[])[0] ?? null;
}
export async function saveProfile(db: Db, orgId: string, input: Partial<CompanyProfile>, email: string): Promise<StoredProfile> {
  const profile = cleanProfile(input);
  const ins = await db.from("newquip_company_profiles").insert({ org_id: orgId, profile, entered_by_email: email }).select("*").single();
  if (ins.error || !ins.data) throw new Error(`Could not save the company details: ${ins.error?.message ?? "no row"}`);
  return ins.data as StoredProfile;
}

// ── documents ───────────────────────────────────────────────────────────────
export async function listDocuments(db: Db, orgId: string, quoteId: string): Promise<StoredDocument[]> {
  const r = await db.from("newquip_quote_documents").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("version", { ascending: false });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredDocument[];
}
export async function loadDocument(db: Db, orgId: string, documentId: string): Promise<StoredDocument | null> {
  const r = await db.from("newquip_quote_documents").select("*").eq("org_id", orgId).eq("id", documentId).maybeSingle();
  if (r.error) { if (missing(r.error.message)) return null; throw new Error(r.error.message); }
  return (r.data as StoredDocument | null) ?? null;
}

/** The identity of a document's content for "is this the same document?": dates are excluded so re-issuing on another day does not mint a new version. */
const stableOf = (m: CustomerDocumentModel) => hashOf({ ...m, quote: { ...m.quote, issuedOn: "", validUntil: "" } });
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export async function issueQuotationDocument(
  db: Db, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, schedule: readonly ScheduleStageTemplate[], deps: DocumentDeps, scheduleSource?: ScheduleSource,
): Promise<{ document: StoredDocument; created: boolean }> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state !== "MANAGER_APPROVED_FINAL" || !q.accepted_baseline || !q.baseline_hash) throw new Error("A customer quotation can only be issued after Manager approval.");
  if (!baselineMatchesHash(q.accepted_baseline, q.baseline_hash)) throw new Error("The approved baseline does not match its seal; the quotation was not issued.");
  const snap = await latestSnapshot(db, orgId, quoteId);
  if (!snap) throw new Error("Select the customer from Cin7 before issuing the quotation.");
  const issues = snapshotIssues(snap.snapshot);
  if (issues.length) throw new Error(`The customer details are incomplete: ${issues.join(" ")}`);
  if (norm(fieldValue(snap.snapshot.name) ?? "") !== norm(q.accepted_baseline.quote.customerName)) throw new Error("The selected Cin7 customer does not match the customer on the approved quotation.");
  const prof = await latestProfile(db, orgId);
  const lacking = missingProfileFields(prof?.profile);
  if (!prof || lacking.length) throw new Error(`NewQuip's company details are incomplete, so the quotation cannot be issued. Missing: ${lacking.join(", ") || "all company details"}.`);

  const accepted = await db.from("newquip_quote_responses").select("id").eq("org_id", orgId).eq("quote_id", quoteId).eq("response", "ACCEPTED").limit(1);
  if (accepted.error && !missing(accepted.error.message)) throw new Error(accepted.error.message);
  if ((accepted.data ?? []).length > 0) throw new Error("The customer has accepted this quotation; the accepted document is final and cannot be replaced.");
  const existing = await listDocuments(db, orgId, quoteId);
  const model = buildCustomerDocumentModel({ baseline: q.accepted_baseline, quoteRef: q.quote_ref, revision: q.revision, snapshot: snap.snapshot, profile: prof.profile, schedule, scheduleSource, issuedOn: deps.today() });
  assertNoInternalLeak(model, q.accepted_baseline);
  const last = existing[0];
  if (last && last.baseline_hash === q.baseline_hash && stableOf(last.content) === stableOf(model) && last.customer_snapshot_id === snap.id && last.company_profile_id === prof.id) return { document: last, created: false };

  const bytes = await deps.render(model);
  const version = (last?.version ?? 0) + 1;
  const path = `${orgId}/${quoteId}/r${q.revision}-v${version}.pdf`;
  await deps.storage.upload(path, bytes);
  const ins = await db.from("newquip_quote_documents").insert({
    org_id: orgId, quote_id: quoteId, quote_ref: q.quote_ref, revision: q.revision, version, baseline_hash: q.baseline_hash, customer_snapshot_id: snap.id, company_profile_id: prof.id,
    storage_path: path, content_hash: sha256(bytes), byte_size: bytes.length, content: model, issued_by_email: who.email, issued_by_owner_email: who.ownerEmail ?? null,
  }).select("*").single();
  if (ins.error || !ins.data) {
    await deps.storage.remove(path).catch(() => undefined); // never leave an orphan file that no row describes
    if (/duplicate key|unique/i.test(ins.error?.message ?? "")) { const again = (await listDocuments(db, orgId, quoteId))[0]; if (again) return { document: again, created: false }; }
    throw new Error(`Could not record the issued quotation: ${ins.error?.message ?? "no row"}`);
  }
  return { document: ins.data as StoredDocument, created: true };
}

/** The bytes of an issued document of THIS organisation, re-verified against the SHA-256 recorded at issue. A tampered or substituted file is refused. */
export async function readDocumentBytes(db: Db, orgId: string, documentId: string, deps: Pick<DocumentDeps, "storage">): Promise<{ doc: StoredDocument; bytes: Uint8Array }> {
  const doc = await loadDocument(db, orgId, documentId);
  if (!doc) throw new Error("Document not found.");
  const bytes = await deps.storage.download(doc.storage_path);
  if (sha256(bytes) !== doc.content_hash) throw new Error("The stored quotation PDF does not match its recorded hash; it was not released.");
  return { doc, bytes };
}

