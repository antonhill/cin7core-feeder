import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { buildAcceptedBaseline, type AcceptedBaseline } from "@/newquip/quote/baseline";
import { NEWQUIP_STANDARD_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { buildCustomerSnapshot, withChosenContact } from "../customer-snapshot";
import { assertNoInternalLeak, buildCustomerDocumentModel, internalTokens, type CustomerDocumentModel } from "../customer-document";
import { cleanProfile, missingProfileFields, type CompanyProfile } from "../company-profile";
import { formatRand, pdfSafe, renderCustomerPdf } from "../customer-pdf";
import { issueQuotationDocument, readDocumentBytes, saveProfile, sha256, type DocumentDeps } from "../document-store";

// Test-only company details: placeholders for TESTS, never shipped as defaults.
const PROFILE: CompanyProfile = {
  brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000 000 0000",
  email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "TERMS-PAYMENT-MARKER", deliveryInstallationConditions: "TERMS-DELIVERY-MARKER", termsAndConditions: "TERMS-GENERAL-MARKER", acceptanceInstructions: "TERMS-ACCEPT-MARKER",
};
const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "rep.person@nq.example", handoffBy: "rep.person@nq.example", estimatorSignoffBy: "est.person@nq.example", estimatorSignoffAt: "t", managerApprovedBy: "mgr.person@nq.example", managerApprovedAt: "t" };
const freeze = () => {
  const draft = readyDraft(); draft.customerName = "Boerdery (Pty) Ltd"; draft.siteName = "Paarl farm"; draft.estimator.assumptions = "INTERNAL-ASSUMPTION-DO-NOT-PRINT margin is tight";
  return buildAcceptedBaseline({ quoteRef: "NQ-Q-0009", revision: 1, draft, evaluation: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false }), approvals });
};
const snapshot = (over: Record<string, unknown> = {}) => withChosenContact(buildCustomerSnapshot({
  ID: "cin7-1", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", PaymentTerm: "30 days", TaxNumber: "4123456789",
  Addresses: [{ Type: "Billing", Line1: "PO Box 1", City: "Paarl", State: "WC", Postcode: "7646", Country: "South Africa", DefaultForType: true }],
  Contacts: [{ Name: "Piet", Email: "piet@boerdery.example" }], ...over }, "2026-10-29T10:00:00.000Z"), { source: "CIN7_CONTACT", contactIndex: 0 });

/** Extracts the text a PDF viewer would show (standard-font hex strings inside TJ arrays of the deflated content streams). */
export function pdfText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1"); const out: string[] = []; const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let c: string; try { c = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const arr of c.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?[\d.]+)*)\]\s*TJ/g)) out.push([...arr[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
  }
  return out.join("\n");
}

describe("company profile is controlled configuration", () => {
  it("nothing is defaulted: an empty profile lists every mandatory field; a complete one has none", () => {
    expect(missingProfileFields(null).length).toBeGreaterThanOrEqual(10);
    expect(missingProfileFields({})).toContain("Terms and conditions");
    expect(missingProfileFields(PROFILE)).toEqual([]);
    expect(missingProfileFields({ ...PROFILE, termsAndConditions: "  " })).toEqual(["Terms and conditions"]);
    expect(missingProfileFields({ ...PROFILE, validityDays: 0 })).toEqual(["Quotation validity (days)"]);
    expect(missingProfileFields({ ...PROFILE, email: "nope" })).toEqual(["Company email"]);
    expect(missingProfileFields({ ...PROFILE, addressLines: ["only one"] })).toEqual(["Company address"]);
    expect(() => cleanProfile({ ...PROFILE, vatNumber: "" })).toThrow(/VAT registration number/);
  });
});

describe("customer document model", () => {
  const { baseline } = freeze();
  const model = buildCustomerDocumentModel({ baseline, quoteRef: "NQ-Q-0009", revision: 1, snapshot: snapshot(), profile: PROFILE, schedule: NEWQUIP_STANDARD_SCHEDULE, issuedOn: "2026-10-29" });
  it("uses the sealed commercial figures: sections add up to the sub-total, VAT and totals match the baseline, schedule adds up to the sub-total", () => {
    const c = baseline.commercial;
    expect(model.totals).toEqual({ subtotalExVat: c.subtotalCents / 100, vatRatePercent: c.taxRateBps / 100, vat: c.taxCents / 100, totalIncVat: c.totalCents / 100 });
    expect(Math.round(model.sections.reduce((a, s) => a + s.amountExVat * 100, 0))).toBe(c.subtotalCents);
    expect(Math.round(model.totals.subtotalExVat * 100) + Math.round(model.totals.vat * 100)).toBe(Math.round(model.totals.totalIncVat * 100));
    expect(Math.round(model.paymentSchedule.reduce((a, s) => a + s.amountExVat * 100, 0))).toBe(c.subtotalCents);
    expect(model.paymentSchedule.reduce((a, s) => a + s.percent, 0)).toBe(100);
    expect(model.currency).toBe("ZAR");
  });
  it("carries the customer, contact, validity and terms exactly; the validity period comes from the profile", () => {
    expect(model.customer).toMatchObject({ name: "Boerdery (Pty) Ltd", contactName: "Piet", contactEmail: "piet@boerdery.example", vatNumber: "4123456789" });
    expect(model.customer.billingAddress).toEqual(["PO Box 1", "Paarl WC 7646", "South Africa"]);
    expect(model.quote).toMatchObject({ reference: "NQ-Q-0009", revision: 1, issuedOn: "2026-10-29", validUntil: "2026-11-28", validityDays: 30, siteName: "Paarl farm" });
    expect(model.termsAndConditions).toBe("TERMS-GENERAL-MARKER");
  });
  it("CONFIDENTIALITY: no SKU, supplier, margin value, assumption text or internal person appears anywhere in the model", () => {
    const text = JSON.stringify(model).toLowerCase();
    const tokens = internalTokens(baseline);
    expect(tokens.length).toBeGreaterThan(5); // the baseline really holds internal data to leak
    for (const t of tokens) expect(text.includes(t.toLowerCase()), `leaked: ${t}`).toBe(false);
    expect(text).not.toMatch(/margin|mark-?up|supplier|landed|exchange rate|estimator|internal-assumption/);
    expect(() => assertNoInternalLeak(model, baseline)).not.toThrow();
  });
  it("the leak guard fires when internal data is smuggled in (SKU in a description, a person's email, assumption text, a margin word)", () => {
    const sku = baseline.commercial.lines.find((l) => l.sku)!.sku!;
    const dirty = (mut: (m: CustomerDocumentModel) => void) => { const m = structuredClone(model); mut(m); return () => assertNoInternalLeak(m, baseline); };
    expect(dirty((m) => { m.sections[0].scope += ` (${sku})`; })).toThrow(/internal data/);
    expect(dirty((m) => { m.sections[0].scope += " mgr.person@nq.example"; })).toThrow(/internal data/);
    expect(dirty((m) => { m.termsAndConditions += " INTERNAL-ASSUMPTION-DO-NOT-PRINT margin is tight"; })).toThrow(/internal data/);
    expect(dirty((m) => { m.sections[0].title = "Gross margin package"; })).toThrow(/internal data/);
  });
  it("refuses when the contact is not chosen", () => {
    expect(() => buildCustomerDocumentModel({ baseline, quoteRef: "Q", revision: 1, snapshot: { ...snapshot(), chosenContact: null }, profile: PROFILE, schedule: NEWQUIP_STANDARD_SCHEDULE, issuedOn: "2026-10-29" })).toThrow(/contact/);
  });
});

describe("PDF rendering", () => {
  const { baseline } = freeze();
  const model = buildCustomerDocumentModel({ baseline, quoteRef: "NQ-Q-0009", revision: 1, snapshot: snapshot(), profile: PROFILE, schedule: NEWQUIP_STANDARD_SCHEDULE, issuedOn: "2026-10-29" });
  it("renders a real PDF whose text carries the customer, numbers and terms - and none of the internal data", async () => {
    const bytes = await renderCustomerPdf(model);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const t = pdfText(bytes);
    for (const must of ["Boerdery (Pty) Ltd", "NQ-Q-0009", "Piet", "29/10/2026", "28/11/2026", formatRand(model.totals.subtotalExVat), formatRand(model.totals.vat), formatRand(model.totals.totalIncVat), "TERMS-PAYMENT-MARKER", "TERMS-DELIVERY-MARKER", "TERMS-GENERAL-MARKER", "TERMS-ACCEPT-MARKER", "Test Company (Pty) Ltd", model.paymentSchedule[0].name])
      expect(t, must).toContain(must);
    for (const t2 of internalTokens(baseline)) expect(t.toLowerCase().includes(t2.toLowerCase()), `PDF leaked: ${t2}`).toBe(false);
    expect(t).not.toMatch(/margin|supplier|exchange rate|landed/i);
  });
  it("money is formatted in rand with a decimal comma and grouped thousands; text outside the PDF font is replaced, not corrupted", () => {
    expect(formatRand(1234567.5)).toBe("R 1 234 567,50"); expect(formatRand(0.05)).toBe("R 0,05"); expect(formatRand(-12)).toBe("-R 12,00");
    expect(pdfSafe("Café – “quote” ☃")).toBe('Café - "quote" ?');
  });
});

// ── issuing, storage, immutability ──────────────────────────────────────────
function world() {
  const db = new FakeDb(); db.deliveryApplied = true;
  const { baseline, hash } = freeze();
  const quote = { id: "q1", org_id: "org-a", quote_ref: "NQ-Q-0009", revision: 1, state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline as AcceptedBaseline, baseline_hash: hash, draft: {}, requires_customer_acceptance: true };
  db.rows("newquip_quotes").push(quote);
  const files = new Map<string, Uint8Array>();
  const deps: DocumentDeps & { renders: number } = {
    renders: 0, today: () => "2026-10-29",
    render: vi.fn(async (m: CustomerDocumentModel) => { deps.renders++; return renderCustomerPdf(m); }),
    storage: { upload: vi.fn(async (p: string, b: Uint8Array) => { if (files.has(p)) throw new Error("exists"); files.set(p, b); }), download: vi.fn(async (p: string) => { const b = files.get(p); if (!b) throw new Error("missing"); return b; }), remove: vi.fn(async (p: string) => { files.delete(p); }) },
  };
  const addSnapshot = (snap = snapshot(), seq = 1) => db.rows("newquip_quote_customers").push({ id: `s${seq}`, org_id: "org-a", quote_id: "q1", seq, cin7_customer_id: "cin7-1", snapshot: snap, snapshot_hash: "h", captured_by_email: "rep@x" });
  return { db, quote, files, deps, addSnapshot };
}
const who = { email: "mgr@x.co", ownerEmail: null };
const issue = (w: ReturnType<typeof world>, org = "org-a") => issueQuotationDocument(w.db as never, org, "q1", who, NEWQUIP_STANDARD_SCHEDULE, w.deps);

describe("issuing an immutable customer document", () => {
  it("refuses until the quotation is Manager-approved, the customer is complete, and every company detail is supplied", async () => {
    const w = world(); w.quote.state = "ESTIMATOR_REVIEW";
    await expect(issue(w)).rejects.toThrow(/after Manager approval/);
    w.quote.state = "MANAGER_APPROVED_FINAL";
    await expect(issue(w)).rejects.toThrow(/Select the customer/);
    w.addSnapshot(snapshot({ Currency: "USD" }));
    await expect(issue(w)).rejects.toThrow(/ZAR only/);
    w.db.rows("newquip_quote_customers").length = 0; w.addSnapshot();
    await expect(issue(w)).rejects.toThrow(/company details are incomplete/);
    await saveProfile(w.db as never, "org-a", { ...PROFILE, termsAndConditions: "" }, "m@x").catch(() => undefined);
    expect(w.db.rows("newquip_company_profiles")).toHaveLength(0);
    expect(w.deps.renders).toBe(0); expect(w.files.size).toBe(0); expect(w.db.rows("newquip_quote_documents")).toHaveLength(0);
  });
  it("refuses a tampered baseline and a customer that does not match the approved quotation", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x");
    w.quote.accepted_baseline = { ...w.quote.accepted_baseline, assumptions: "edited after approval" };
    await expect(issue(w)).rejects.toThrow(/does not match its seal/);
    const w2 = world(); w2.addSnapshot(snapshot({ Name: "Someone Else Ltd" })); await saveProfile(w2.db as never, "org-a", PROFILE, "m@x");
    await expect(issue(w2)).rejects.toThrow(/does not match the customer/);
  });
  it("issues once, stores the PDF with its SHA-256 under the exact revision, and re-issuing the same inputs returns the SAME document (no silent replacement)", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x");
    const a = await issue(w);
    expect(a.created).toBe(true);
    expect(a.document).toMatchObject({ revision: 1, version: 1, quote_ref: "NQ-Q-0009", baseline_hash: w.quote.baseline_hash, storage_path: "org-a/q1/r1-v1.pdf", issued_by_email: "mgr@x.co" });
    expect(a.document.content_hash).toBe(sha256(w.files.get("org-a/q1/r1-v1.pdf")!));
    const b = await issue(w);
    expect(b.created).toBe(false); expect(b.document.id).toBe(a.document.id);
    expect(w.deps.renders).toBe(1); expect(w.files.size).toBe(1); expect(w.db.rows("newquip_quote_documents")).toHaveLength(1);
  });
  it("a changed input (new company terms) issues VERSION 2; version 1 and its file remain untouched", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x");
    const v1 = await issue(w); const bytes1 = new Uint8Array(w.files.get("org-a/q1/r1-v1.pdf")!);
    await saveProfile(w.db as never, "org-a", { ...PROFILE, termsAndConditions: "REVISED-TERMS" }, "m@x");
    const v2 = await issue(w);
    expect(v2.created).toBe(true); expect(v2.document.version).toBe(2); expect(v2.document.storage_path).toBe("org-a/q1/r1-v2.pdf");
    expect(w.files.get("org-a/q1/r1-v1.pdf")).toEqual(bytes1);
    expect(w.db.rows("newquip_quote_documents").map((d) => d.version)).toEqual([1, 2]);
    expect(pdfText(w.files.get("org-a/q1/r1-v2.pdf")!)).toContain("REVISED-TERMS");
    expect(pdfText(w.files.get("org-a/q1/r1-v1.pdf")!)).not.toContain("REVISED-TERMS");
    expect(v1.document.id).not.toBe(v2.document.id);
  });
  it("an issued document row can never be updated or deleted (database guard emulated)", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x"); const a = await issue(w);
    expect((await w.db.from("newquip_quote_documents").update({ content_hash: "x" }).eq("id", a.document.id)).error?.message).toMatch(/append-only/);
    expect((await w.db.from("newquip_quote_documents").delete().eq("id", a.document.id)).error?.message).toMatch(/append-only/);
  });
  it("retrieval re-verifies the hash: a swapped or corrupted file is refused; another organisation cannot read it", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x"); const a = await issue(w);
    expect((await readDocumentBytes(w.db as never, "org-a", a.document.id, w.deps)).bytes.length).toBe(a.document.byte_size);
    await expect(readDocumentBytes(w.db as never, "org-b", a.document.id, w.deps)).rejects.toThrow(/not found/);
    w.files.set(a.document.storage_path, new Uint8Array([1, 2, 3]));
    await expect(readDocumentBytes(w.db as never, "org-a", a.document.id, w.deps)).rejects.toThrow(/does not match its recorded hash/);
  });
  it("organisation isolation: another organisation's quotation is 'not found' and nothing is rendered or stored", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x");
    await expect(issue(w, "org-b")).rejects.toThrow(/Quote not found/);
    expect(w.deps.renders).toBe(0); expect(w.files.size).toBe(0);
  });
  it("a storage failure records nothing; a failed insert removes the orphan file", async () => {
    const w = world(); w.addSnapshot(); await saveProfile(w.db as never, "org-a", PROFILE, "m@x");
    vi.mocked(w.deps.storage.upload).mockRejectedValueOnce(new Error("bucket down"));
    await expect(issue(w)).rejects.toThrow(/bucket down/);
    expect(w.db.rows("newquip_quote_documents")).toHaveLength(0);
    const orig = w.db.from.bind(w.db);
    (w.db as unknown as { from: unknown }).from = (t: string) => { const q = orig(t); if (t === "newquip_quote_documents") (q as unknown as { insert: unknown }).insert = () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "boom" } }) }) }); return q; };
    await expect(issue(w)).rejects.toThrow(/Could not record/);
    expect(w.files.size).toBe(0);
  });
  it("when migration 0115 is absent the document feature reads as unavailable instead of crashing", async () => {
    const db = new FakeDb(); const { listDocuments } = await import("../document-store");
    expect(await listDocuments(db as never, "org-a", "q1")).toEqual([]);
  });
});
