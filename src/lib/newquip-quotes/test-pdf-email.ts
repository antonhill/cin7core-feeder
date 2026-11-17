// UAT-only: email the Rep the EXISTING "approved and ready to issue" notification (src/lib/approvals/messages.ts, kind APPROVED_FOR_REP) with the TEST-ONLY watermarked PDF
// attached and an explicit UAT banner. Pure helpers (no I/O).
//
// There is deliberately NO approve/reject token or one-click link: the existing approval design puts only authenticated deep links in email (they still need login and server-side
// authorisation), so a forwarded email cannot decide anything. Decisions stay in the existing in-app workflow (revision-versioned, duplicate- and stale-decision-safe).
// Nothing here issues or sends a quotation, or creates an acceptance, Project, Sales Order, Claim or Cin7 record.
import type { SendEmailInput } from "@/lib/email/resend";
import { buildNotification } from "@/lib/approvals/messages";
import { isAllowlisted } from "@/lib/approvals/email-policy";
import type { ApprovalRequestRow } from "@/lib/approvals/types";

export type TestEmailEnv = Readonly<Record<string, string | undefined>>;

/** The ONLY origin links in this email may use. Never the Toolbox Production host. */
export const UAT_ORIGIN = "https://newquip-uat.cin7toolbox.com";

/** Only the dedicated UAT deployment (its own credential store) AND an explicit opt-in. Everything else, Production included, is OFF. */
export const testPdfEmailEnabled = (env: TestEmailEnv): boolean => env.CIN7_CREDENTIAL_STORE === "uat" && env.NEWQUIP_UAT_TEST_EMAIL_ENABLED === "true";

export const testPdfSubject = (quoteRef: string): string => `TEST ONLY – NewQuip Quotation ${quoteRef}`;

export const UAT_BANNER = "UAT TEST EMAIL. NOT FOR CUSTOMER ISSUE. This is not a commercial quotation and must NOT be forwarded to a customer.";

/** Recipient must be on the existing authorised test-email allowlist. */
export const recipientAllowed = (email: string): boolean => isAllowlisted(email);

const esc = (v: string | number): string => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The approval's recorded amount must equal the sealed contract amount the PDF shows; otherwise the quotation changed since approval and nothing is sent. */
export const amountConsistent = (approvedCents: number, sealedCents: number | null): boolean => sealedCents != null && approvedCents === sealedCents;

export function buildTestPdfEmail(i: { to: string; request: ApprovalRequestRow; bytes: Uint8Array }): SendEmailInput {
  const n = buildNotification("APPROVED_FOR_REP", i.request, i.to, { baseUrl: UAT_ORIGIN, by: i.request.decided_by_email, at: i.request.decided_at });
  const text = [
    UAT_BANNER,
    "",
    n.body,
    "",
    `Attached: the TEST-ONLY PDF for ${i.request.doc_ref} (revision ${i.request.revision}), watermarked "TEST ONLY – NOT FOR CUSTOMER ISSUE", using placeholder company details.`,
    "The quotation has not been issued or sent to a customer. Decisions are made only after signing in at the links above.",
  ].join("\n");
  const html = `<p><strong>${UAT_BANNER}</strong></p><pre style="font-family:inherit;white-space:pre-wrap">${esc(n.body)}</pre><p>Attached: the TEST-ONLY PDF for ${esc(i.request.doc_ref)} (revision ${esc(i.request.revision)}), watermarked &ldquo;TEST ONLY &ndash; NOT FOR CUSTOMER ISSUE&rdquo;, using placeholder company details.</p><p>The quotation has not been issued or sent to a customer. Decisions are made only after signing in at the links above.</p>`;
  return { to: [i.to.trim()], subject: testPdfSubject(i.request.doc_ref), text, html, attachments: [{ filename: `TEST-ONLY-${i.request.doc_ref}-r${i.request.revision}.pdf`, content: Buffer.from(i.bytes) }] };
}
