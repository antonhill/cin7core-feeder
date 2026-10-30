import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { buildAcceptedBaseline, type AcceptedBaseline } from "@/newquip/quote/baseline";
import { NEWQUIP_STANDARD_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { buildCustomerSnapshot, withChosenContact } from "../customer-snapshot";
import { assertNoInternalLeak, buildCustomerDocumentModel, internalTokens, internalTokenSet, messageLeaksInternal, tokenAppears, type CustomerDocumentModel } from "../customer-document";
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
    const set = internalTokenSet(baseline);
    expect(set.figures.length).toBeGreaterThan(0); // internal cost / gross-profit amounts ARE extracted from the frozen margin sheet
    for (const t of [...set.ids, ...set.people, ...set.notes]) expect(text.includes(t.toLowerCase()), `leaked: ${t}`).toBe(false);
    for (const t of set.figures) expect(tokenAppears(text, t), `leaked figure: ${t}`).toBe(false);
    expect(text).not.toMatch(/margin|mark-?up|supplier|landed|exchange rate|estimator|internal-assumption/);
    expect(() => assertNoInternalLeak(model, baseline)).not.toThrow();
  });
  it("the customer contact who confirmed the amount is the customer's own person, not internal data: the document may be addressed to them, while internal staff are still guarded", () => {
    const { baseline: b2 } = buildAcceptedBaseline({ quoteRef: "NQ-Q-0009", revision: 1, draft: readyDraft(), evaluation: evaluateDraft(readyDraft(), { priceSource: testPriceSource(), withholdCost: false }), approvals: { ...approvals, customerConfirmedBy: "Piet <piet@boerdery.example>" } });
    expect(internalTokens(b2)).not.toContain("Piet <piet@boerdery.example>");
    const m = structuredClone(model); m.customer.contactName = "Piet"; m.customer.contactEmail = "piet@boerdery.example";
    expect(() => assertNoInternalLeak(m, b2)).not.toThrow();
    const leaky = structuredClone(m); leaky.sections[0].scope += " rep.person@nq.example"; // an internal person's email in the offer text is still refused
    expect(() => assertNoInternalLeak(leaky, b2)).toThrow(/internal data/);
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
    expect(((await w.db.from("newquip_quote_documents").update({ content_hash: "x" }).eq("id", a.document.id)) as unknown as { error: { message: string } }).error.message).toMatch(/append-only/);
    expect(((await w.db.from("newquip_quote_documents").delete().eq("id", a.document.id)) as unknown as { error: { message: string } }).error.message).toMatch(/append-only/);
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

// ── REGRESSION: the actual Preview failure (NQ-Q-0015) ──────────────────────
// The demonstration quotation (R10,000,000 ex VAT, 40/55/5 schedule) carries the internal assumption "Test" and override reasons "Test"; its site is "Test Farm 1" and the
// customer contact tests/approves from the same mailbox domain. The old guard looked for the 4-letter note as a SUBSTRING of the whole model, so the customer's own site name
// ("Test Farm 1") made it refuse a perfectly safe document: "The customer document would expose internal data and was not issued."
describe("REGRESSION: NQ-Q-0015 on Preview (demonstration quotation, 40/55/5)", () => {
  const demo = () => {
    const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Spark" }).draft;
    const ap = { ...approvals, customerConfirmedBy: "Anton Hill <anton@sparkconsulting.co.za>", handoffBy: "rep@sparkconsulting.co.za", estimatorSignoffBy: "estimator@sparkconsulting.co.za", managerApprovedBy: "anton@sparkconsulting.co.za" };
    const { baseline, hash } = buildAcceptedBaseline({ quoteRef: "NQ-Q-0015", revision: 1, draft, evaluation: evaluateDraft(draft, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false }), approvals: ap });
    // the customer's contact is the SAME person as the internal approver, and the customer is called "Spark"
    const snap = withChosenContact(buildCustomerSnapshot({ ID: "c-spark", Name: "Spark", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "1 Spark Road", DefaultForType: true }], Contacts: [{ Name: "Anton Hill", Email: "anton@sparkconsulting.co.za" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 });
    return { baseline, hash, snap, model: buildCustomerDocumentModel({ baseline, quoteRef: "NQ-Q-0015", revision: 1, snapshot: snap, profile: PROFILE, schedule: NEWQUIP_STANDARD_SCHEDULE, issuedOn: "2026-10-30" }) };
  };
  it("the guard accepts it, and the figures reconcile exactly: R10,000,000 + R1,500,000 VAT = R11,500,000; 40/55/5 = R4,000,000 + R5,500,000 + R500,000", () => {
    const { baseline, model } = demo();
    expect(baseline.assumptions).toBe("Test"); // the trigger: a short internal note that also occurs as a word in the customer's site name
    expect(model.quote.siteName).toBe("Test Farm 1");
    expect(() => assertNoInternalLeak(model, baseline)).not.toThrow();
    expect(model.totals).toMatchObject({ subtotalExVat: 10_000_000, vat: 1_500_000, totalIncVat: 11_500_000, vatRatePercent: 15 });
    expect(model.paymentSchedule.map((x) => [x.percent, x.amountExVat])).toEqual([[40, 4_000_000], [55, 5_500_000], [5, 500_000]]);
    expect(model.paymentSchedule.reduce((a, x) => a + x.amountExVat, 0)).toBe(model.totals.subtotalExVat);
    expect(model.customer).toMatchObject({ name: "Spark", contactName: "Anton Hill", contactEmail: "anton@sparkconsulting.co.za" });
  });
  it("it really issues through the full pipeline: stored privately with its hash, revision-bound; issuing again with identical inputs reuses it (no duplicate)", async () => {
    const { baseline, hash, snap } = demo();
    const db = new FakeDb(); db.deliveryApplied = true;
    db.rows("newquip_quotes").push({ id: "q15", org_id: "org-a", quote_ref: "NQ-Q-0015", revision: 1, state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline, baseline_hash: hash, draft: {}, requires_customer_acceptance: true });
    db.rows("newquip_quote_customers").push({ id: "s1", org_id: "org-a", quote_id: "q15", seq: 1, cin7_customer_id: "c-spark", snapshot: snap, snapshot_hash: "h", captured_by_email: "rep@x" });
    const files = new Map<string, Uint8Array>();
    const deps: DocumentDeps = { today: () => "2026-10-30", render: renderCustomerPdf, storage: { upload: async (p, b) => { files.set(p, b); }, download: async (p) => files.get(p)!, remove: async (p) => { files.delete(p); } } };
    await saveProfile(db as never, "org-a", PROFILE, "m@x");
    const first = await issueQuotationDocument(db as never, "org-a", "q15", { email: "mgr@x" }, NEWQUIP_STANDARD_SCHEDULE, deps);
    expect(first.document).toMatchObject({ revision: 1, baseline_hash: hash });
    expect(Buffer.from(files.get(first.document.storage_path)!).subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha256(files.get(first.document.storage_path)!)).toBe(first.document.content_hash);
    const again = await issueQuotationDocument(db as never, "org-a", "q15", { email: "mgr@x" }, NEWQUIP_STANDARD_SCHEDULE, deps);
    expect(db.rows("newquip_quote_documents")).toHaveLength(1); expect(again.document.id).toBe(first.document.id);
  });
  it("a refused issue leaves NO registry row and NO stored file (the failed Preview attempt created nothing)", async () => {
    const { baseline, hash, snap } = demo();
    const db = new FakeDb(); db.deliveryApplied = true;
    db.rows("newquip_quotes").push({ id: "q15", org_id: "org-a", quote_ref: "NQ-Q-0015", revision: 1, state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline, baseline_hash: hash, draft: {}, requires_customer_acceptance: true });
    db.rows("newquip_quote_customers").push({ id: "s1", org_id: "org-a", quote_id: "q15", seq: 1, cin7_customer_id: "c-spark", snapshot: snap, snapshot_hash: "h", captured_by_email: "rep@x" });
    const files = new Map<string, Uint8Array>();
    const deps: DocumentDeps = { today: () => "2026-10-30", render: renderCustomerPdf, storage: { upload: async (p, b) => { files.set(p, b); }, download: async (p) => files.get(p)!, remove: async (p) => { files.delete(p); } } };
    const sku = internalTokenSet(baseline).ids[0];
    await saveProfile(db as never, "org-a", { ...PROFILE, termsAndConditions: `General terms. See product ${sku}.` }, "m@x"); // a genuine leak: an internal SKU in the company terms
    await expect(issueQuotationDocument(db as never, "org-a", "q15", { email: "mgr@x" }, NEWQUIP_STANDARD_SCHEDULE, deps)).rejects.toThrow(/internal data.*SKU or supplier/);
    expect(db.rows("newquip_quote_documents")).toHaveLength(0); expect(files.size).toBe(0);
  });
});

describe("the guard still blocks genuine confidential data (and names only the KIND, never the value)", () => {
  const { baseline } = freeze();
  const model = buildCustomerDocumentModel({ baseline, quoteRef: "NQ-Q-0009", revision: 1, snapshot: snapshot(), profile: PROFILE, schedule: NEWQUIP_STANDARD_SCHEDULE, issuedOn: "2026-10-29" });
  const dirty = (mut: (m: CustomerDocumentModel) => void) => { const m = structuredClone(model); mut(m); return () => assertNoInternalLeak(m, baseline); };
  const set = () => internalTokenSet(baseline);
  it("a SKU, a supplier, an internal cost figure, a staff email and a distinctive note in the offer text are refused", () => {
    const sku = set().ids[0]; const fig = set().figures[0]; const person = set().people[0];
    expect(dirty((m) => { m.sections[0].scope += ` ${sku}`; })).toThrow(/a SKU or supplier/);
    expect(dirty((m) => { m.sections[1].title += ` R${fig}`; })).toThrow(/internal cost or margin figure/);
    expect(dirty((m) => { m.sections[0].scope += ` ${person}`; })).toThrow(/an internal person/);
    expect(dirty((m) => { m.sections[0].scope += " INTERNAL-ASSUMPTION-DO-NOT-PRINT margin is tight"; })).toThrow(/an internal note/);
    let msg = ""; try { dirty((m) => { m.sections[0].scope += ` ${sku} ${person}`; })(); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain(sku); expect(msg).not.toContain(person);
  });
  it("organisation text (terms, company details) may not carry a SKU, a cost figure or a distinctive internal note either", () => {
    const sku = set().ids[0]; const fig = set().figures[0];
    expect(dirty((m) => { m.termsAndConditions += ` ${sku}`; })).toThrow(/company details or terms/);
    expect(dirty((m) => { m.paymentTerms += ` ${fig}`; })).toThrow(/company details or terms/);
    expect(dirty((m) => { m.deliveryInstallationConditions += " INTERNAL-ASSUMPTION-DO-NOT-PRINT margin is tight"; })).toThrow(/internal note/);
  });
  it("a short internal note is still caught as a WORD in the offer text (the scope), but not as a fragment of another word or in the customer's own details", () => {
    const { baseline: b } = (() => { const d = readyDraft(); d.estimator.assumptions = "Test"; return buildAcceptedBaseline({ quoteRef: "Q", revision: 1, draft: d, evaluation: evaluateDraft(d, { priceSource: testPriceSource(), withholdCost: false }), approvals }); })();
    const m1 = structuredClone(model); m1.sections[0].scope += " this is a Test line";
    expect(() => assertNoInternalLeak(m1, b)).toThrow(/an internal note/);
    const m2 = structuredClone(model); m2.sections[0].scope += " the latest testing contest"; m2.quote.siteName = "Test Farm 1"; m2.customer.name = "Test Customer";
    expect(() => assertNoInternalLeak(m2, b)).not.toThrow();
  });
  it("the customer's own name, address and contact may equal an internal SKU, supplier or staff email without being refused; a cost figure inside a LONGER number is not a match", () => {
    const sku = set().ids[0]; const person = set().people[0];
    expect(dirty((m) => { m.customer.name = `${sku} Supplies`; m.customer.contactEmail = person; m.customer.billingAddress = [sku]; })).not.toThrow();
    expect(tokenAppears("total 40000000 and 4000000.5", "4000000")).toBe(false);
    expect(tokenAppears("deposit 4000000 due", "4000000")).toBe(true); expect(tokenAppears("[4000000,5500000]", "4000000")).toBe(true);
    expect(tokenAppears("the latest", "test")).toBe(false);
    expect(tokenAppears("a Test.", "test")).toBe(true);
  });
  it("a staff mailbox may legitimately be the company's own contact address (organisation text), though not appear in the offer text", () => {
    const person = set().people[0];
    expect(dirty((m) => { m.company.email = person; })).not.toThrow();
    expect(dirty((m) => { m.sections[0].scope += ` ${person}`; })).toThrow(/an internal person/);
  });
  it("an internal word in the scope or schedule wording is refused, but a customer called 'Suppliers Ltd' is fine", () => {
    expect(dirty((m) => { m.paymentSchedule[0].name = "Supplier deposit"; })).toThrow(/internal term/);
    expect(dirty((m) => { m.customer.name = "ABC Suppliers (Pty) Ltd"; })).not.toThrow();
  });
  it("the cover-email check uses whole words: 'please find the latest quote' passes, a SKU or margin talk does not", () => {
    const sku = set().ids[0];
    expect(messageLeaksInternal("Please find the latest quote and the testing schedule", baseline)).toBe(false);
    expect(messageLeaksInternal(`Includes ${sku} at a good margin`, baseline)).toBe(true);
    expect(messageLeaksInternal("Our gross profit is fine", baseline)).toBe(true);
  });
});
