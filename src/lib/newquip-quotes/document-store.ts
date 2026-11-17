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
import { cleanProfile, describeProfileProblems, missingProfileFields, profileProblems, type CompanyProfile } from "./company-profile";
import { renderCustomerPdf } from "./customer-pdf";
import { applyDemoTerms } from "./demo-terms";
import { pocDocumentMarked } from "./poc-presentation";
import { commercialOf, nextProfileWithCommercial, nextProfileWithDetails, withoutCommercial, type CommercialVersion } from "./commercial-block";
import type { CommercialSettings } from "@/newquip/pricing/commercial-settings";

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
export const SIMULTANEOUS_SAVE_MSG = "Someone else saved at the same time, so your change was not kept. Reload and try again.";
/**
 * Appends one profile version built on `built` (the latest row the caller read). There is no database guard for a read-modify-write across two writers (no migration), so after the insert the row
 * directly beneath ours is checked: if it is not the one we built on, another writer got in between and OUR row would silently drop their change. Then a CORRECTIVE version is appended that restores
 * the other writer's profile verbatim (so the latest row is exactly what they saved), and this call fails loudly. Append-only: nothing is updated or deleted.
 */
async function appendProfileRow(db: Db, orgId: string, built: StoredProfile | null, profile: Record<string, unknown>, email: string, what: string): Promise<StoredProfile> {
  const ins = await db.from("newquip_company_profiles").insert({ org_id: orgId, profile, entered_by_email: email }).select("*").single();
  if (ins.error || !ins.data) throw new Error(`Could not save the ${what}: ${ins.error?.message ?? "no row"}`);
  const mine = ins.data as StoredProfile;
  const recent = await db.from("newquip_company_profiles").select("*").eq("org_id", orgId).order("version", { ascending: false }).limit(5);
  if (recent.error) throw new Error(`Could not verify the ${what} save: ${recent.error.message}`);
  const rows = (recent.data ?? []) as StoredProfile[];
  const at = rows.findIndex((r) => r.id === mine.id);
  const beneath = at >= 0 ? rows[at + 1] ?? null : null;
  if ((beneath?.id ?? null) === (built?.id ?? null)) return mine;
  // beneath is the intervening writer's row (the one directly under ours); restore it as the latest version unless something newer than ours already supersedes us.
  if (at === 0 && beneath) {
    const fix = await db.from("newquip_company_profiles").insert({ org_id: orgId, profile: beneath.profile, entered_by_email: beneath.entered_by_email });
    if (fix.error) throw new Error(`${SIMULTANEOUS_SAVE_MSG} The other person's earlier change could not be restored automatically (${fix.error.message}): check Company details and Commercial settings before saving again.`);
  }
  throw new Error(SIMULTANEOUS_SAVE_MSG);
}

/** The RAW latest row, commercial block included. INTERNAL to this file's commercial functions: customer-facing code must use latestProfile(), which strips the block. */
async function latestProfileRow(db: Db, orgId: string): Promise<StoredProfile | null> {
  const r = await db.from("newquip_company_profiles").select("*").eq("org_id", orgId).order("version", { ascending: false }).limit(1);
  if (r.error) { if (missing(r.error.message)) return null; throw new Error(r.error.message); }
  return ((r.data ?? []) as StoredProfile[])[0] ?? null;
}
/** The company details for customer-facing use. The Manager-only `commercial` block is REMOVED here, so the customer-document builder can never read it. */
export async function latestProfile(db: Db, orgId: string): Promise<StoredProfile | null> {
  const row = await latestProfileRow(db, orgId);
  return row ? { ...row, profile: withoutCommercial(row.profile) } : null;
}
export async function saveProfile(db: Db, orgId: string, input: Partial<CompanyProfile>, email: string): Promise<StoredProfile> {
  const profile = cleanProfile(input);
  const stored = await latestProfileRow(db, orgId); // the Manager's commercial settings are carried forward untouched
  const row = await appendProfileRow(db, orgId, stored, nextProfileWithDetails(profile, stored?.profile), email, "company details");
  return { ...row, profile: withoutCommercial(row.profile) };
}

// ── commercial settings (interim store: see commercial-block.ts) ────────────
/** The current commercial settings and their revision, or null when none have been entered (or the stored block does not validate). Cost-bearing: Manager / cost-entitled server code only. */
export async function latestCommercialSettings(db: Db, orgId: string, nowIso: string = new Date().toISOString()): Promise<CommercialVersion | null> {
  const row = await latestProfileRow(db, orgId);
  return row ? commercialOf(row.profile, nowIso) : null;
}
/** Appends a NEW profile version carrying the settings (customer-facing fields untouched). Append-only: nothing earlier is changed. */
export async function saveCommercialSettings(db: Db, orgId: string, settings: CommercialSettings, email: string, nowIso: string = new Date().toISOString()): Promise<CommercialVersion> {
  const stored = await latestProfileRow(db, orgId);
  const profile = nextProfileWithCommercial(stored?.profile, stored ? commercialOf(stored.profile, nowIso) : null, settings, email, nowIso);
  const row = await appendProfileRow(db, orgId, stored, profile, email, "commercial settings");
  const v = commercialOf(row.profile, nowIso);
  if (!v) throw new Error("The saved commercial settings could not be read back.");
  return v;
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
  // The placeholder guard runs on the STORED profile, before any demo override, so a demo override can never mask a bad profile for a non-demo quote.
  // Only the designated demonstration quotes (whose terms are replaced in the PDF) keep the pre-guard behaviour.
  const marked = pocDocumentMarked(q, orgId);
  const isDemo = !!prof && applyDemoTerms(prof.profile, orgId, q.quote_ref, marked) !== prof.profile;
  const lacking = missingProfileFields(prof?.profile, { allowPlaceholderTerms: isDemo });
  if (!prof || lacking.length) {
    const why = prof ? describeProfileProblems(profileProblems(prof.profile, { allowPlaceholderTerms: isDemo })).join("; ") : "no company details have been saved";
    throw new Error(`The company details cannot be used on a customer document (Manager > Company details): ${why}.`);
  }

  const accepted = await db.from("newquip_quote_responses").select("id").eq("org_id", orgId).eq("quote_id", quoteId).eq("response", "ACCEPTED").limit(1);
  if (accepted.error && !missing(accepted.error.message)) throw new Error(accepted.error.message);
  if ((accepted.data ?? []).length > 0) throw new Error("The customer has accepted this quotation; the accepted document is final and cannot be replaced.");
  const existing = await listDocuments(db, orgId, quoteId);
  const model = buildCustomerDocumentModel({ baseline: q.accepted_baseline, quoteRef: q.quote_ref, revision: q.revision, snapshot: snap.snapshot, profile: applyDemoTerms(prof.profile, orgId, q.quote_ref, marked), schedule, scheduleSource, issuedOn: deps.today() });
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

/**
 * TEST-ONLY preview of the customer PDF for an approved quotation. It exists so a demonstration can show the document while the company details still hold placeholder wording.
 * It is NEVER issued: nothing is stored, no newquip_quote_documents row is written, so there is no document that can be sent, accepted or handed over. The strict issue gate
 * (issueQuotationDocument) is unchanged and does not call this. The render is watermarked on every page. Everything except placeholder TEXT is still validated.
 */
export async function previewQuotationDocument(
  db: Db, orgId: string, quoteId: string, schedule: readonly ScheduleStageTemplate[], deps: Pick<DocumentDeps, "today">, scheduleSource?: ScheduleSource,
): Promise<{ bytes: Uint8Array; quoteRef: string; revision: number; repEmail: string | null }> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state !== "MANAGER_APPROVED_FINAL" || !q.accepted_baseline || !q.baseline_hash) throw new Error("A preview is available only after Manager approval.");
  if (!baselineMatchesHash(q.accepted_baseline, q.baseline_hash)) throw new Error("The approved baseline does not match its seal; no preview was produced.");
  const snap = await latestSnapshot(db, orgId, quoteId);
  if (!snap) throw new Error("Select the customer from Cin7 before previewing the quotation.");
  const issues = snapshotIssues(snap.snapshot);
  if (issues.length) throw new Error(`The customer details are incomplete: ${issues.join(" ")}`);
  const prof = await latestProfile(db, orgId);
  const hard = profileProblems(prof?.profile, { lenient: true });
  if (!prof || hard.length) throw new Error(`The preview cannot be built: ${prof ? describeProfileProblems(hard).join("; ") : "no company details have been saved"}.`);
  const model = buildCustomerDocumentModel({ baseline: q.accepted_baseline, quoteRef: q.quote_ref, revision: q.revision, snapshot: snap.snapshot, profile: prof.profile, schedule, scheduleSource, issuedOn: deps.today() });
  assertNoInternalLeak(model, q.accepted_baseline);
  return { bytes: await renderCustomerPdf(model, { testOnly: true }), quoteRef: q.quote_ref, revision: q.revision, repEmail: q.created_by_email ?? null };
}

/** The bytes of an issued document of THIS organisation, re-verified against the SHA-256 recorded at issue. A tampered or substituted file is refused. */
export async function readDocumentBytes(db: Db, orgId: string, documentId: string, deps: Pick<DocumentDeps, "storage">): Promise<{ doc: StoredDocument; bytes: Uint8Array }> {
  const doc = await loadDocument(db, orgId, documentId);
  if (!doc) throw new Error("Document not found.");
  const bytes = await deps.storage.download(doc.storage_path);
  if (sha256(bytes) !== doc.content_hash) throw new Error("The stored quotation PDF does not match its recorded hash; it was not released.");
  return { doc, bytes };
}

