import { describe, it, expect } from "vitest";
import { applyEmailPolicy, isRestricted, PREVIEW_SUBJECT_PREFIX } from "@/lib/approvals/email-policy";
import { testDocumentBlockedHere } from "../acceptance";
import { htmlOf, TEST_NOTICE } from "../send-store";
import type { StoredDocument } from "../document-store";

const UAT = { VERCEL_ENV: "production", CIN7_CREDENTIAL_STORE: "uat" } as const;
const PROD = { VERCEL_ENV: "production" } as const;

describe("UAT deployment email policy", () => {
  it("is restricted like a Preview, while a real Production deployment is not", () => {
    expect(isRestricted(UAT)).toBe(true);
    expect(isRestricted(PROD)).toBe(false);
    expect(isRestricted({ VERCEL_ENV: "preview" })).toBe(true);
  });
  it("only the authorised test mailboxes receive mail from UAT; others are suppressed, never redirected", () => {
    const ok = applyEmailPolicy(UAT, { to: "anton@sparkconsulting.co.za", subject: "Quotation NQ-Q-0001", text: "x" });
    expect(ok.action).toBe("SEND");
    if (ok.action === "SEND") expect(ok.subject.startsWith(PREVIEW_SUBJECT_PREFIX)).toBe(true);
    expect(applyEmailPolicy(UAT, { to: "customer@real-company.example", subject: "s", text: "x" }).action).toBe("SUPPRESS");
  });
});

describe("TEST document isolation", () => {
  it("a TEST document's acceptance may be used only on the UAT deployment", () => {
    expect(testDocumentBlockedHere({ testOnly: true }, UAT)).toBe(false);
    expect(testDocumentBlockedHere({ testOnly: true }, PROD)).toBe(true);
    expect(testDocumentBlockedHere({ testOnly: true }, { VERCEL_ENV: "preview" })).toBe(true);
    expect(testDocumentBlockedHere({}, PROD)).toBe(false);
  });
  const doc = (testOnly: boolean) => ({ quote_ref: "NQ-Q-0001", revision: 2, content: { testOnly, company: { brandName: "NewQuip", legalName: "NewQuip (Pty) Ltd" }, quote: { validUntil: "2026-12-17" } } }) as unknown as StoredDocument;
  const links = { accept: "https://portal.example/quote-response#t=a&a=accept", decline: "https://portal.example/quote-response#t=a&a=decline", changes: "https://portal.example/quote-response#t=a&a=changes", expiresOn: "2026-12-01" };
  it("the customer email carries a clear TEST banner and Accept / Decline links only for a TEST document", () => {
    const t = htmlOf(doc(true), "m", links, true);
    expect(t).toContain("TEST ONLY");
    expect(t).toContain("NOT A COMMERCIAL QUOTATION");
    expect(t).toContain("Accept quotation");
    expect(t).toContain("Decline quotation");
    expect(htmlOf(doc(false), "m", links, false)).not.toContain(TEST_NOTICE);
  });
});
