"use server";

// NewQuip: company details, issuing the customer quotation document and listing issued documents. LOCAL ONLY (nothing here reaches Cin7). Re-authorised inside EVERY
// action. Manager approval authorises issue; issuing needs the Rep or Manager role. Company details are controlled configuration changed by a Manager only.
// Only async functions and erased types are exported.
import { authoriseActor, auditActor, errText, ownerEmailOf, type Actor } from "./actor";
import { documentsViewOf } from "./page-reads";
import { createServiceRoleClient } from "@/supabase/server";
import { missingProfileFields, type CompanyProfile } from "@/lib/newquip-quotes/company-profile";
import { defaultDeps, documentsAvailable, issueQuotationDocument, latestProfile, previewQuotationDocument, saveProfile } from "@/lib/newquip-quotes/document-store";
import { sendEmail } from "@/lib/email/resend";
import { buildTestPdfEmail, testPdfEmailEnabled } from "@/lib/newquip-quotes/test-pdf-email";
import { resolveProjectSchedule } from "@/lib/newquip-quotes/schedule-resolve";
import type { ScheduleChoice } from "@/newquip/quote/billing-schedule";

export interface DocumentActionResult<T> { ok: boolean; error?: string; data?: T }

export interface ProfileView { available: boolean; profile: CompanyProfile | null; version: number | null; missing: string[]; canEdit: boolean }
export interface IssuedDocumentRow { id: string; version: number; revision: number; issuedAt: string; issuedBy: string; byteSize: number; contentHash: string }
export interface QuoteDocumentsView { available: boolean; documents: IssuedDocumentRow[]; blockers: string[]; /** TEST-ONLY preview can be opened (company details unusable for customers but buildable). */ previewAvailable: boolean; /** UAT deployment only: the TEST-ONLY PDF can be emailed to the quotation's Rep. */ testEmailAvailable?: boolean; canIssue: boolean }

const needManager = (a: Actor) => { if (!a.roles.has("manager")) throw new Error("Only a Manager can change NewQuip's company details."); };

export async function getCompanyProfileAction(): Promise<DocumentActionResult<ProfileView>> {
  try {
    const a = await authoriseActor();
    const db = createServiceRoleClient();
    if (!(await documentsAvailable(db))) return { ok: true, data: { available: false, profile: null, version: null, missing: [], canEdit: false } };
    const p = await latestProfile(db, a.orgId);
    return { ok: true, data: { available: true, profile: p?.profile ?? null, version: p?.version ?? null, missing: missingProfileFields(p?.profile), canEdit: a.roles.has("manager") } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function saveCompanyProfileAction(input: Partial<CompanyProfile>): Promise<DocumentActionResult<ProfileView>> {
  try {
    const a = await authoriseActor(); needManager(a);
    const db = createServiceRoleClient();
    if (!(await documentsAvailable(db))) throw new Error("Company details are not available until the database update (migration 0115) is applied.");
    const saved = await saveProfile(db, a.orgId, input, a.email);
    await auditActor(db, a, { action: "newquip.company_profile_saved", summary: "Saved NewQuip company details and quotation terms (new version; earlier versions kept)", detail: { version: saved.version, byOwner: ownerEmailOf(a) } });
    return { ok: true, data: { available: true, profile: saved.profile, version: saved.version, missing: [], canEdit: true } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function getQuoteDocumentsAction(quoteId: string): Promise<DocumentActionResult<QuoteDocumentsView>> {
  try { return { ok: true, data: await documentsViewOf(createServiceRoleClient(), await authoriseActor(), quoteId) }; } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Generates the customer PDF from the approved baseline (Rep or Manager). Re-issuing identical inputs returns the same document; a changed input creates the next version. */
export async function issueQuoteDocumentAction(quoteId: string, scheduleChoice?: ScheduleChoice): Promise<DocumentActionResult<{ documentId: string; version: number; created: boolean }>> {
  try {
    const a = await authoriseActor();
    if (!a.roles.has("rep") && !a.roles.has("manager")) throw new Error("You do not have permission to issue a customer quotation.");
    const db = createServiceRoleClient();
    const applied = await resolveProjectSchedule(db, a.orgId, scheduleChoice);
    const r = await issueQuotationDocument(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) }, applied.schedule, defaultDeps(db), applied.source);
    if (r.created) await auditActor(db, a, { action: "newquip.quote_document_issued", summary: "Issued the customer quotation PDF (local only; no Cin7 write, nothing sent)", detail: { quoteId, documentId: r.document.id, version: r.document.version, revision: r.document.revision, contentHash: r.document.content_hash } });
    return { ok: true, data: { documentId: r.document.id, version: r.document.version, created: r.created } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** UAT only: email the watermarked TEST-ONLY PDF to the Rep assigned to this quotation. Issues nothing, stores nothing, records no send to a customer. */
export async function sendTestPdfToRepAction(quoteId: string): Promise<DocumentActionResult<{ sentTo: string }>> {
  try {
    if (!testPdfEmailEnabled(process.env)) throw new Error("Test PDF email is available only on the UAT deployment.");
    const a = await authoriseActor();
    if (!a.roles.has("rep") && !a.roles.has("manager")) throw new Error("Only a Rep or Manager can send the test PDF.");
    if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new Error("Quotation not found.");
    const db = createServiceRoleClient();
    const applied = await resolveProjectSchedule(db, a.orgId);
    const r = await previewQuotationDocument(db, a.orgId, quoteId, applied.schedule, { today: () => new Date().toISOString().slice(0, 10) }, applied.source);
    if (!r.repEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.repEmail)) throw new Error("This quotation has no Sales Rep email address.");
    const sent = await sendEmail(buildTestPdfEmail({ to: r.repEmail, quoteRef: r.quoteRef, revision: r.revision, bytes: r.bytes }));
    await auditActor(db, a, { action: "newquip.quote_test_pdf_emailed", summary: `Emailed the TEST-ONLY quotation PDF to the assigned Rep (not issued, not sent to a customer)`, detail: { quoteId, accepted: sent.ok, to: r.repEmail, ...(sent.ok ? {} : { error: (sent.error ?? "").slice(0, 120) }) } }).catch(() => undefined);
    if (!sent.ok) throw new Error(`The email provider did not accept the message: ${(sent.error ?? "unknown error").slice(0, 120)}`);
    return { ok: true, data: { sentTo: r.repEmail } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
