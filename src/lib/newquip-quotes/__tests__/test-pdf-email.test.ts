import { describe, it, expect } from "vitest";
import { buildTestPdfEmail, recipientAllowed, testPdfEmailEnabled, testPdfSubject, UAT_ORIGIN, UAT_BANNER } from "../test-pdf-email";
import type { ApprovalRequestRow } from "@/lib/approvals/types";

const req = {
  id: "11111111-1111-1111-1111-111111111111", org_id: "o", doc_type: "QUOTE", doc_id: "19a65b41-c0a5-4537-b269-79503efba9d2", doc_ref: "NQ-Q-0001", project_id: null, project_ref: null, customer_name: "Spark",
  revision: 2, digest: "d", amount_cents: 1147238936, status: "APPROVED", prepared_by_email: "rep@sparkconsulting.co.za", submitted_at: "2026-11-17T13:00:00Z", assigned_to_email: null, assigned_at: null,
  due_at: null, first_viewed_at: null, decided_by_email: "manager@sparkconsulting.co.za", decided_by_name: null, decided_at: "2026-11-17T13:35:19Z", decision_reason: null, admin_override: false,
  closed_at: null, version: 3, reminders_sent: 0, last_reminder_at: null, created_at: "2026-11-17T13:00:00Z", stage: "MANAGER",
} as unknown as ApprovalRequestRow;

describe("UAT TEST-ONLY approval email", () => {
  it("is enabled only on the UAT deployment with the explicit opt-in", () => {
    expect(testPdfEmailEnabled({ CIN7_CREDENTIAL_STORE: "uat", NEWQUIP_UAT_TEST_EMAIL_ENABLED: "true" })).toBe(true);
    expect(testPdfEmailEnabled({ NEWQUIP_UAT_TEST_EMAIL_ENABLED: "true" })).toBe(false);
    expect(testPdfEmailEnabled({ CIN7_CREDENTIAL_STORE: "uat" })).toBe(false);
    expect(testPdfEmailEnabled({ CIN7_CREDENTIAL_STORE: "uat", NEWQUIP_UAT_TEST_EMAIL_ENABLED: "TRUE" })).toBe(false);
    expect(testPdfEmailEnabled({})).toBe(false);
  });

  it("only the authorised test mailboxes may receive it", () => {
    expect(recipientAllowed("rep@sparkconsulting.co.za")).toBe(true);
    expect(recipientAllowed("  REP@sparkconsulting.co.za ")).toBe(true);
    expect(recipientAllowed("someone@customer.example")).toBe(false);
    expect(recipientAllowed("rep+x@sparkconsulting.co.za")).toBe(false);
  });

  it("carries the original notification content, the UAT banner, UAT-only links and the TEST-ONLY attachment", () => {
    const m = buildTestPdfEmail({ to: " rep@sparkconsulting.co.za ", request: req, bytes: new Uint8Array([1, 2, 3]) });
    expect(m.to).toEqual(["rep@sparkconsulting.co.za"]);
    expect(m.cc).toBeUndefined();
    expect(m.subject).toBe(testPdfSubject("NQ-Q-0001"));
    expect(m.subject).toBe("TEST ONLY – NewQuip Quotation NQ-Q-0001");
    expect(m.text.startsWith(UAT_BANNER)).toBe(true);
    expect(m.text).toContain("NOT FOR CUSTOMER ISSUE");
    expect(m.text).toContain("must NOT be forwarded to a customer");
    // the existing APPROVED_FOR_REP content
    expect(m.text).toContain("Quotation NQ-Q-0001 has been approved and is ready to issue to the customer.");
    expect(m.text).toContain("Amount (ex VAT): R 11");
    expect(m.text).toContain("Required action: Open the Customer quotation stage");
    // links: UAT origin only, authenticated deep links, no token / no one-click decision
    expect(m.text).toContain(`Open: ${UAT_ORIGIN}/newquip-grower/${req.doc_id}?stage=4`);
    expect(m.text).toContain(`Approvals page: ${UAT_ORIGIN}/approvals/${req.id}`);
    const urls = m.text.match(/https?:\/\/[^\s]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) { expect(u.startsWith(UAT_ORIGIN + "/")).toBe(true); expect(u).not.toMatch(/token|[?&](approve|reject|decision|action)=/i); }
    expect(m.text).not.toContain("https://cin7toolbox.com");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0].filename).toBe("TEST-ONLY-NQ-Q-0001-r2.pdf");
    expect(m.attachments![0].content.length).toBe(3);
    expect(m.html).toContain("NOT FOR CUSTOMER ISSUE");
  });

  it("the displayed revision is the one passed in (the quotation revision the PDF carries)", () => {
    const m = buildTestPdfEmail({ to: "rep@sparkconsulting.co.za", request: { ...req, revision: 7 }, bytes: new Uint8Array([1]) });
    expect(m.text).toContain("(revision 7)");
    expect(m.attachments![0].filename).toBe("TEST-ONLY-NQ-Q-0001-r7.pdf");
  });
});
