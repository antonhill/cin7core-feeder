import { describe, it, expect } from "vitest";
import { buildTestPdfEmail, testPdfEmailEnabled, testPdfSubject } from "../test-pdf-email";

describe("UAT TEST-ONLY PDF email", () => {
  it("is enabled only on the UAT deployment with the explicit opt-in", () => {
    expect(testPdfEmailEnabled({ CIN7_CREDENTIAL_STORE: "uat", NEWQUIP_UAT_TEST_EMAIL_ENABLED: "true" })).toBe(true);
    expect(testPdfEmailEnabled({ NEWQUIP_UAT_TEST_EMAIL_ENABLED: "true" })).toBe(false); // not UAT (e.g. Toolbox Production / candidate Preview)
    expect(testPdfEmailEnabled({ CIN7_CREDENTIAL_STORE: "uat" })).toBe(false); // no opt-in
    expect(testPdfEmailEnabled({ CIN7_CREDENTIAL_STORE: "uat", NEWQUIP_UAT_TEST_EMAIL_ENABLED: "TRUE" })).toBe(false);
    expect(testPdfEmailEnabled({})).toBe(false);
  });

  it("uses the required subject and a clear UAT / do-not-forward notice", () => {
    expect(testPdfSubject("NQ-Q-0001")).toBe("TEST ONLY – NewQuip Quotation NQ-Q-0001");
    const m = buildTestPdfEmail({ to: " rep@example.test ", quoteRef: "NQ-Q-0001", revision: 2, bytes: new Uint8Array([1, 2, 3]) });
    expect(m.to).toEqual(["rep@example.test"]);
    expect(m.cc).toBeUndefined();
    expect(m.subject).toBe("TEST ONLY – NewQuip Quotation NQ-Q-0001");
    expect(m.text).toContain("UAT test document");
    expect(m.text).toContain("NOT a commercial quotation");
    expect(m.text).toContain("must NOT be forwarded to a customer");
    expect(m.text).toContain("has not been issued or sent to a customer");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0].filename).toBe("TEST-ONLY-NQ-Q-0001-r2.pdf");
    expect(m.attachments![0].content.length).toBe(3);
  });
});
