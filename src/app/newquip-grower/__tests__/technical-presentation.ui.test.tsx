// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { splitEvidence } from "../technical-text";
import { AuditDetails } from "../[id]/AuditDetails";

const UUID = "e3cbb8a4-aefb-4e5c-86eb-01c9b02a51b8";
const SHA = "8714a8424bb3bb04eac4dab11835597e17d9352d346793f3098ef256216eee6c";
const EVIDENCE = `Customer response link · Anton (Spark, anton@example.com) accepted quotation NQ-Q-0029, revision 1 (document ${UUID}, SHA-256 ${SHA}) and confirmed being authorised to accept it on behalf of the customer.`;

describe("UX-006 PR B: technical identifiers are one disclosure away, never deleted", () => {
  it("splitEvidence separates the document id and hash from the plain wording and loses nothing", () => {
    const { plain, technical } = splitEvidence(EVIDENCE);
    expect(plain).toBe("Customer response link · Anton (Spark, anton@example.com) accepted quotation NQ-Q-0029, revision 1 and confirmed being authorised to accept it on behalf of the customer.");
    expect(plain).not.toContain(UUID);
    expect(plain).not.toContain(SHA);
    expect(technical).toBe(`document ${UUID}, SHA-256 ${SHA}`);
  });
  it("text without a document reference is unchanged", () => {
    expect(splitEvidence("Signed copy no. 42")).toEqual({ plain: "Signed copy no. 42", technical: null });
    expect(splitEvidence("Email 5 Nov, subject (document x)")).toEqual({ plain: "Email 5 Nov, subject (document x)", technical: null });
  });
  it("AuditDetails is a collapsed disclosure that still holds its content", () => {
    render(<AuditDetails><p>Seal (sha256) 3cb87601ef6cbd5d…</p></AuditDetails>);
    const d = screen.getByTestId("audit-details") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector("summary")!.textContent).toBe("Audit details");
    expect(d.textContent).toContain("Seal (sha256)");
    cleanup();
  });
  it("the Stage 6 baseline list no longer shows the seal, rule set, price source or counts; the audit block does", () => {
    const page = readFileSync(`${__dirname}/../[id]/page.tsx`, "utf8");
    const dl = page.slice(page.indexOf("Accepted commercial baseline (frozen)"), page.indexOf("<BaselineExceptionsSummary"));
    for (const label of ["Seal (sha256)", '"Rule set"', '"Price source"', "Overrides · exclusions"]) expect(dl).not.toContain(label);
    const audit = page.slice(page.indexOf('data-testid="baseline-audit"'));
    for (const t of ["Seal (sha256)", "rulesetVersion", "pricing.source.label", "priceResolutions"]) expect(audit).toContain(t);
  });
  it("the Stage 4 and Stage 5 panels keep hashes only inside an Audit details disclosure", () => {
    const rd = (f: string) => readFileSync(`${__dirname}/../[id]/${f}`, "utf8");
    expect(rd("DeliveryPanel.tsx")).toMatch(/<AuditDetails[^>]*>[^<]*<p>Issued PDF fingerprint: sha256/);
    const acc = rd("AcceptancePanel.tsx");
    expect(acc).toContain("splitEvidence(r.evidence).plain");
    expect(acc).not.toMatch(/uploaded by \{x\.uploadedBy\} · sha256/);
  });
});
