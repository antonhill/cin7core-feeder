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
import { sendQuotationToCustomer } from "@/lib/newquip-quotes/send-store";
import { amountConsistent, buildTestPdfEmail, recipientAllowed, testPdfEmailEnabled } from "@/lib/newquip-quotes/test-pdf-email";
import { latestRequestFor } from "@/lib/approvals/approval-store";
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
    if (!recipientAllowed(r.repEmail)) throw new Error("The assigned Rep's address is not on the authorised test-email list; nothing was sent.");
    // The existing approval request for THIS quotation (its content drives the original notification). It must be the APPROVED Manager-stage request; the preview above already
    // proved the quotation is Manager-approved with a sealed baseline. The approval request's own counter is not the quotation revision, so the email shows the quotation revision the PDF carries.
    const req = await latestRequestFor(db, a.orgId, "QUOTE", quoteId);
    if (!req || req.status !== "APPROVED" || (req.stage ?? "MANAGER") !== "MANAGER" || req.doc_id !== quoteId) throw new Error("There is no approved Manager decision for this quotation; nothing was sent.");
    // Consistency: the amount the approval recorded must equal the sealed contract amount the PDF shows. If the quotation changed since approval, block rather than email inconsistent figures.
    if (!amountConsistent(req.amount_cents, r.contractCents)) throw new Error("The approved amount no longer matches the quotation's sealed amount (it changed since approval); nothing was sent.");
    const sent = await sendEmail(buildTestPdfEmail({ to: r.repEmail, request: { ...req, revision: r.revision }, bytes: r.bytes }));
    await auditActor(db, a, { action: "newquip.quote_test_pdf_emailed", summary: `Emailed the TEST-ONLY quotation PDF to the assigned Rep (not issued, not sent to a customer)`, detail: { quoteId, accepted: sent.ok, to: r.repEmail, ...(sent.ok ? {} : { error: (sent.error ?? "").slice(0, 120) }) } }).catch(() => undefined);
    if (!sent.ok) throw new Error(`The email provider did not accept the message: ${(sent.error ?? "unknown error").slice(0, 120)}`);
    return { ok: true, data: { sentTo: r.repEmail } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** The one mailbox that acts as "the customer" in UAT. Must be on the existing authorised test-email allowlist; the restricted-environment email policy enforces it again at send. */
const UAT_TEST_CUSTOMER_DEFAULT = "anton@sparkconsulting.co.za";

/**
 * UAT only: issue the quotation as a TEST document (watermarked, content.testOnly, lenient company-details rule) and send it through the EXISTING customer send path to the test
 * mailbox acting as the customer. The email carries the existing personal Accept / Decline / Request-changes links to the public customer portal; nothing is recorded until the
 * customer confirms on that page. The strict customer-issue gate is untouched for every other caller. No Project, Sales Order, Claim, invoice or Cin7 record is created.
 */
export async function sendTestQuotationToCustomerAction(quoteId: string): Promise<DocumentActionResult<{ sentTo: string; status: string }>> {
  try {
    if (!testPdfEmailEnabled(process.env)) throw new Error("The test customer email is available only on the UAT deployment.");
    const a = await authoriseActor();
    if (!a.roles.has("rep")) throw new Error("Only a Rep sends the quotation to the customer.");
    if (!/^[0-9a-f-]{36}$/i.test(quoteId)) throw new Error("Quotation not found.");
    const to = (process.env.NEWQUIP_UAT_TEST_CUSTOMER_EMAIL?.trim() || UAT_TEST_CUSTOMER_DEFAULT).toLowerCase();
    if (!recipientAllowed(to)) throw new Error("The test customer mailbox is not on the authorised test-email list; nothing was sent.");
    const db = createServiceRoleClient();
    const applied = await resolveProjectSchedule(db, a.orgId);
    const issued = await issueQuotationDocument(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) }, applied.schedule, defaultDeps(db), applied.source, { uatTest: true });
    if (issued.document.content.testOnly !== true) throw new Error("This quotation already has a real issued document; the test send is only for a TEST document.");
    const sent = await sendQuotationToCustomer(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) },
      { documentId: issued.document.id, to: [to], message: "TEST ONLY: UAT walkthrough of the customer acceptance flow.", idempotencyKey: `uat-test-${issued.document.id}-${Date.now()}`, resendOfId: undefined },
      { storage: defaultDeps(db).storage }, process.env);
    await auditActor(db, a, { action: "newquip.uat_test_quotation_sent", summary: "UAT: sent the TEST quotation (watermarked) to the test customer mailbox with the customer response links (not a commercial quotation)", detail: { quoteId, documentId: issued.document.id, sendId: sent.send.id, to, status: sent.send.status } }).catch(() => undefined);
    if (sent.send.status !== "ACCEPTED") throw new Error(`The test email was not accepted by the provider (status ${sent.send.status}${sent.send.last_error ? `: ${sent.send.last_error.slice(0, 120)}` : ""}).`);
    return { ok: true, data: { sentTo: to, status: sent.send.status } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
