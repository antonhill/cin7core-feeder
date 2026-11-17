// UAT-only: email the TEST-ONLY watermarked quotation PDF to the Sales Rep assigned to the quotation. Pure helpers (no I/O).
// This is NOT issuing or sending a quotation: nothing is stored or recorded as issued/sent, and it creates no acceptance, Project, Sales Order, Claim or Cin7 record.
import type { SendEmailInput } from "@/lib/email/resend";

export type TestEmailEnv = Readonly<Record<string, string | undefined>>;

/** Only the dedicated UAT deployment (its own credential store) AND an explicit opt-in. Everything else, Production included, is OFF. */
export const testPdfEmailEnabled = (env: TestEmailEnv): boolean => env.CIN7_CREDENTIAL_STORE === "uat" && env.NEWQUIP_UAT_TEST_EMAIL_ENABLED === "true";

export const testPdfSubject = (quoteRef: string): string => `TEST ONLY – NewQuip Quotation ${quoteRef}`;

const NOTICE = "This is a UAT test document. It is NOT a commercial quotation and must NOT be forwarded to a customer.";

export function buildTestPdfEmail(i: { to: string; quoteRef: string; revision: number; bytes: Uint8Array }): SendEmailInput {
  const text = [
    NOTICE,
    "",
    `Attached: the TEST-ONLY PDF for quotation ${i.quoteRef} (revision ${i.revision}). It carries a "TEST ONLY – NOT FOR CUSTOMER ISSUE" watermark and uses placeholder company details.`,
    "The quotation has not been issued or sent to a customer, and no customer acceptance, project, sales order, claim or Cin7 transaction has been created.",
  ].join("\n");
  const html = `<p><strong>${NOTICE}</strong></p><p>Attached: the TEST-ONLY PDF for quotation ${i.quoteRef} (revision ${i.revision}). It carries a &ldquo;TEST ONLY &ndash; NOT FOR CUSTOMER ISSUE&rdquo; watermark and uses placeholder company details.</p><p>The quotation has not been issued or sent to a customer, and no customer acceptance, project, sales order, claim or Cin7 transaction has been created.</p>`;
  return { to: [i.to.trim()], subject: testPdfSubject(i.quoteRef), text, html, attachments: [{ filename: `TEST-ONLY-${i.quoteRef}-r${i.revision}.pdf`, content: Buffer.from(i.bytes) }] };
}
