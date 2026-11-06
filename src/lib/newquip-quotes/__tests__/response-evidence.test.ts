import { describe, expect, it } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, checkEvidenceFile, checkEvidenceFiles, detectEvidenceType, readEvidenceBytes, safeFileName, storeEvidence } from "../response-evidence";
import { resolveResponseContact } from "../response-contact";
import { buildCustomerSnapshot } from "../customer-snapshot";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const EML = new TextEncoder().encode("From: Piet <piet@farm.co.za>\r\nTo: rep@x.co\r\nSubject: Re: Quotation NQ-Q-0015\r\nDate: Thu, 30 Oct 2026 10:00:00 +0200\r\n\r\nWe accept.\r\n");

describe("evidence files are verified by CONTENT, not by name or the browser's claim", () => {
  it("accepts PDF, JPG, PNG and EML and records the real type, size and SHA-256", () => {
    expect(checkEvidenceFile({ name: "signed.pdf", bytes: PDF })).toMatchObject({ contentType: "application/pdf", ext: "pdf", size: PDF.length });
    expect(checkEvidenceFile({ name: "scan.JPEG", bytes: JPG })).toMatchObject({ contentType: "image/jpeg", ext: "jpg" });
    expect(checkEvidenceFile({ name: "photo.png", bytes: PNG })).toMatchObject({ contentType: "image/png" });
    const eml = checkEvidenceFile({ name: "confirmation.eml", bytes: EML });
    expect(eml.contentType).toBe("message/rfc822"); expect(eml.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("REJECTS unsupported content whatever the name says (executables, scripts, HTML, SVG, archives, Office files)", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]);
    for (const [name, bytes] of [["x.pdf", html], ["x.pdf", exe], ["logo.png", svg], ["doc.docx", zip], ["run.sh", new TextEncoder().encode("#!/bin/sh\nrm -rf /\n")], ["x.pdf", new TextEncoder().encode("just some text")]] as const) {
      expect(() => checkEvidenceFile({ name, bytes }), name).toThrow(/not a supported file/);
    }
    expect(detectEvidenceType(html)).toBeNull();
  });
  it("rejects a file whose name does not match what it really is (a PNG called .pdf), empty files and oversized files", () => {
    expect(() => checkEvidenceFile({ name: "invoice.pdf", bytes: PNG })).toThrow(/does not look like the file type/);
    expect(() => checkEvidenceFile({ name: "empty.pdf", bytes: new Uint8Array() })).toThrow(/empty/);
    const big = new Uint8Array(EVIDENCE_MAX_BYTES + 1); big.set(PDF);
    expect(() => checkEvidenceFile({ name: "big.pdf", bytes: big })).toThrow(/larger than/);
    const edge = new Uint8Array(EVIDENCE_MAX_BYTES); edge.set(PDF);
    expect(checkEvidenceFile({ name: "edge.pdf", bytes: edge }).size).toBe(EVIDENCE_MAX_BYTES);
  });
  it("bounds the number of files and refuses the same file twice", () => {
    expect(() => checkEvidenceFiles(Array.from({ length: EVIDENCE_MAX_FILES + 1 }, (_, i) => ({ name: `a${i}.pdf`, bytes: new Uint8Array([...PDF, i]) })))).toThrow(/at most/);
    expect(() => checkEvidenceFiles([{ name: "a.pdf", bytes: PDF }, { name: "b.pdf", bytes: PDF }])).toThrow(/twice/);
  });
  it("the files of one upload together stay under the platform's request limit", () => {
    const a = new Uint8Array(3 * 1024 * 1024); a.set(PDF); const b = new Uint8Array(2 * 1024 * 1024); b.set(PNG);
    expect(() => checkEvidenceFiles([{ name: "a.pdf", bytes: a }, { name: "b.png", bytes: b }])).toThrow(/together are larger/);
    expect(checkEvidenceFiles([{ name: "a.pdf", bytes: a }])).toHaveLength(1);
  });
  it("file names are display text only: path tricks and control characters are removed", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\x\\signed copy.pdf")).toBe("signed copy.pdf");
    expect(safeFileName("a\u0000b\nc<script>.pdf")).toBe("abcscript.pdf");
    expect(safeFileName("....")).toBe("evidence");
    expect(safeFileName("x".repeat(500)).length).toBe(120);
  });
});

describe("storing evidence: private path, never overwritten, all-or-nothing, hash re-checked on download", () => {
  const world = () => {
    const db = new FakeDb(); db.portalApplied = true; db.deliveryApplied = true;
    const files = new Map<string, Uint8Array>(); const removed: string[] = [];
    const storage = { upload: async (p: string, b: Uint8Array) => { if (files.has(p)) throw new Error("exists"); files.set(p, b); }, download: async (p: string) => files.get(p)!, remove: async (p: string) => { removed.push(p); files.delete(p); } };
    return { db, files, removed, storage };
  };
  const P = { orgId: "org-a", quoteId: "q1", documentId: "d1", responseId: "r1" };

  it("writes under <org>/evidence/<quote>/<response>/<random>.<ext>, NEVER using the user's file name, and registers each file", async () => {
    const w = world();
    const rows = await storeEvidence(w.db as never, w.storage, P, [checkEvidenceFile({ name: "../../Signed Quote.pdf", bytes: PDF }), checkEvidenceFile({ name: "mail.eml", bytes: EML })], { email: "rep@x.co", ownerEmail: "own@x.co" }, "signed copy");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.storage_path).toMatch(/^org-a\/evidence\/q1\/r1\/[0-9a-f-]{36}\.(pdf|eml)$/);
      expect(r.storage_path).not.toContain("Signed"); expect(w.files.has(r.storage_path)).toBe(true);
    }
    expect(rows[0]).toMatchObject({ file_name: "Signed Quote.pdf", uploaded_by_email: "rep@x.co", uploaded_by_owner_email: "own@x.co", description: "signed copy", content_type: "application/pdf" });
    expect(new Set(rows.map((r) => r.storage_path)).size).toBe(2); // two uploads never share a path
  });
  it("if registering one file fails, the objects already written are removed again (nothing is left half-stored)", async () => {
    const w = world();
    const real = w.db.from.bind(w.db);
    let n = 0;
    (w.db as unknown as { from: unknown }).from = (t: string) => { const q = real(t); if (t === "newquip_response_evidence") { const ins = (q as unknown as { insert: (p: unknown) => unknown }).insert.bind(q); (q as unknown as { insert: unknown }).insert = (p: unknown) => { if (++n === 2) return { select: () => ({ single: async () => ({ data: null, error: { message: "boom" } }) }) }; return ins(p); }; } return q; };
    await expect(storeEvidence(w.db as never, w.storage, P, [checkEvidenceFile({ name: "a.pdf", bytes: PDF }), checkEvidenceFile({ name: "b.png", bytes: PNG })], { email: "rep@x.co" })).rejects.toThrow(/boom/);
    expect(w.files.size).toBe(0); expect(w.removed).toHaveLength(2);
  });
  it("download re-verifies the SHA-256: a tampered object is not released, and another organisation's evidence is invisible", async () => {
    const w = world();
    const [row] = await storeEvidence(w.db as never, w.storage, P, [checkEvidenceFile({ name: "a.pdf", bytes: PDF })], { email: "rep@x.co" });
    expect((await readEvidenceBytes(w.db as never, "org-a", row.id, w.storage)).bytes).toEqual(PDF);
    await expect(readEvidenceBytes(w.db as never, "org-b", row.id, w.storage)).rejects.toThrow(/not found/i);
    w.files.set(row.storage_path, new Uint8Array([1, 2, 3]));
    await expect(readEvidenceBytes(w.db as never, "org-a", row.id, w.storage)).rejects.toThrow(/no longer matches/);
  });
});

describe("the responding contact is resolved from the frozen snapshot, separately from the delivery contact", () => {
  const snap = buildCustomerSnapshot({ ID: "c", Name: "Spark", Currency: "ZAR", Contacts: [{ Name: "AJ Mbulo", Email: "testing@sparkconsulting.co.za" }, { Name: "Anton Hill", Email: "anton@sparkconsulting.co.za" }, { Name: "No Email" }] }, "t");
  const delivery = { name: "AJ Mbulo", email: "testing@sparkconsulting.co.za" };
  it("defaults to the contact who received the quotation; another Cin7 contact can be chosen; neither touches Cin7", () => {
    expect(resolveResponseContact(snap, delivery, { source: "DELIVERY_CONTACT" })).toEqual({ source: "DELIVERY_CONTACT", name: "AJ Mbulo", email: "testing@sparkconsulting.co.za", exceptionReason: null });
    expect(resolveResponseContact(snap, delivery, { source: "CIN7_CONTACT", contactIndex: 1 })).toEqual({ source: "CIN7_CONTACT", name: "Anton Hill", email: "anton@sparkconsulting.co.za", exceptionReason: null });
    expect(resolveResponseContact(snap, delivery, { source: "CIN7_CONTACT", contactIndex: 2 }).email).toBeNull();
    expect(() => resolveResponseContact(snap, delivery, { source: "CIN7_CONTACT", contactIndex: 9 })).toThrow(/not on the customer/);
    expect(() => resolveResponseContact(snap, null, { source: "DELIVERY_CONTACT" })).toThrow(/not on record/);
  });
  it("an alternative contact needs a name and an audited reason; a bad email is refused", () => {
    expect(resolveResponseContact(snap, delivery, { source: "ALTERNATIVE", name: "Sarie Venter", email: "sarie@x.co.za", reason: "Owner was away" })).toMatchObject({ source: "ALTERNATIVE", name: "Sarie Venter", exceptionReason: "Owner was away" });
    for (const bad of [{ name: "S", reason: "Owner was away" }, { name: "Sarie", reason: "" }, { name: "Sarie", reason: "no" }, { name: "Sarie", reason: "Owner was away", email: "nope" }]) {
      expect(() => resolveResponseContact(snap, delivery, { source: "ALTERNATIVE", ...bad }), JSON.stringify(bad)).toThrow();
    }
  });
});
