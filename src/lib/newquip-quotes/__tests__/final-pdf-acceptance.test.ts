// FINAL CUSTOMER-PDF ACCEPTANCE. A realistic grower quotation is rendered with the real renderer from a SAFE FICTITIOUS fixture (no real NewQuip details, nothing issued or sent), then:
//   - issuing is BLOCKED while any mandatory company field is missing or a placeholder;
//   - the extracted PDF text is checked for the numbers a customer needs (sections, VAT 15%, payment milestones, terms);
//   - CONFIDENTIALITY: no supplier, cost, FX, freight, margin wording, internal SKU, 'cin7' or 'TEST-ONLY' anywhere in the PDF text, metadata or raw bytes.
// Set NEWQUIP_PDF_OUT=<dir> to also write the PDFs there (used for the visual check).
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";
import { GOLDEN_LIBRARY } from "@/newquip/grower/__tests__/golden-catalogue";
import { NEWQUIP_STANDARD_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { buildCustomerSnapshot, withChosenContact } from "../customer-snapshot";
import { assertNoInternalLeak, buildCustomerDocumentModel, internalTokenSet } from "../customer-document";
import { missingProfileFields, PROFILE_LABELS, type CompanyProfile } from "../company-profile";
import { formatRand, renderCustomerPdf } from "../customer-pdf";

// FICTITIOUS company details. Deliberately obvious fakes (".example" domains, 555 numbers); never defaults, never shipped.
const PARA = (s: string) => s.replace(/\s+/g, " ").trim();
const FICTITIOUS: CompanyProfile = {
  brandName: "Fictional Feed Systems", legalName: "Fictional Feed Systems (Pty) Ltd", registrationNumber: "2099/000123/07", vatNumber: "4999000123",
  addressLines: ["12 Imaginary Road", "Exampleton", "0999 South Africa"], phone: "+27 11 555 0199", email: "quotes@fictional-feed.example", website: "www.fictional-feed.example", validityDays: 30,
  paymentTerms: [
    PARA("Invoices are issued per milestone in the payment schedule and are payable within 7 days of the invoice date. Equipment remains the property of the company until paid in full."),
    PARA("Late payment attracts interest at two percent above the prevailing prime lending rate. All amounts are in South African Rand."),
  ].join("\n"),
  deliveryInstallationConditions: [
    PARA("Delivery is to the site address stated on this quotation. The customer provides safe, graded vehicle access to the building platform and a clear offloading area."),
    PARA("Installation dates are confirmed once the deposit is received and site readiness is signed off. Delays caused by site conditions or weather may move the programme."),
    PARA("Concrete slats are offloaded by crane truck; the customer is responsible for crane access and any ground preparation required."),
  ].join("\n"),
  termsAndConditions: Array.from({ length: 14 }, (_, i) => PARA(`${i + 1}. This is fictitious sample clause text used only to exercise page layout. It is long enough to wrap across several lines so that the terms section spans more than one page and the page break and footer can be checked by eye.`)).join("\n"),
  acceptanceInstructions: PARA("To accept, sign and return the acceptance page or reply to the quotation email confirming the quotation reference. Acceptance is subject to the terms above."),
};

const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "Piet <piet@highveld.example>", handoffBy: "rep.person@nq.example", estimatorSignoffBy: "est.person@nq.example", estimatorSignoffAt: "t", managerApprovedBy: "mgr.person@nq.example", managerApprovedAt: "t" };
function fixture() {
  const draft = readyDraft(); draft.customerName = "Highveld Pig Farm (Pty) Ltd"; draft.siteName = "Highveld Farm, Grower House 3";
  draft.estimator.assumptions = "INTERNAL-ASSUMPTION-DO-NOT-PRINT supplier quote valid to month end, margin is tight, freight 1.3 and exchange rate 18.40";
  const baseline = buildAcceptedBaseline({ mappingLibrary: GOLDEN_LIBRARY as never, quoteRef: "NQ-Q-0123", revision: 2, draft, evaluation: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false }), approvals }).baseline;
  const snapshot = withChosenContact(buildCustomerSnapshot({
    ID: "cin7-1", Name: "Highveld Pig Farm (Pty) Ltd", Currency: "ZAR", PaymentTerm: "30 days", TaxNumber: "4123456789",
    Addresses: [{ Type: "Billing", Line1: "PO Box 77", City: "Bela-Bela", State: "LP", Postcode: "0480", Country: "South Africa", DefaultForType: true }],
    Contacts: [{ Name: "Piet Highveld", Email: "piet@highveld.example", Phone: "082 555 0142" }] }, "2026-11-10T10:00:00.000Z"), { source: "CIN7_CONTACT", contactIndex: 0 });
  const model = buildCustomerDocumentModel({ baseline, quoteRef: "NQ-Q-0123", revision: 2, snapshot, profile: FICTITIOUS, schedule: NEWQUIP_STANDARD_SCHEDULE, issuedOn: "2026-11-17" });
  return { baseline, model };
}

/** Text a viewer shows: standard-font hex strings in TJ arrays of the deflated content streams, page by page (one block per content stream). */
function pdfPages(bytes: Uint8Array): string[] {
  const s = Buffer.from(bytes).toString("latin1"); const out: string[] = []; const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let c: string; try { c = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    const parts = [...c.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?[\d.]+)*)\]\s*TJ/g)].map((arr) => [...arr[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
    if (parts.length) out.push(parts.join(" ").replace(/\s+/g, " "));
  }
  return out;
}

describe("issuing a customer PDF is BLOCKED until genuine NewQuip details exist", () => {
  const MANDATORY = (Object.keys(PROFILE_LABELS) as Array<keyof CompanyProfile>).filter((k) => k !== "website");
  it("the fictitious fixture is itself a complete profile (so each case below fails for ONE reason)", () => expect(missingProfileFields(FICTITIOUS)).toEqual([]));
  it.each(MANDATORY)("blank %s is rejected and named", (k) => {
    const blank = (Array.isArray(FICTITIOUS[k]) ? [] : typeof FICTITIOUS[k] === "number" ? 0 : "") as never;
    expect(missingProfileFields({ ...FICTITIOUS, [k]: blank })).toEqual([PROFILE_LABELS[k]]);
  });
  it("an entirely empty or missing profile lists every mandatory field", () => {
    const all = MANDATORY.map((k) => PROFILE_LABELS[k]).sort();
    expect(missingProfileFields(null).sort()).toEqual(all);
    expect(missingProfileFields({}).sort()).toEqual(all);
  });
  it.each(["test", "TBD", "todo", "n/a", "xxx", "placeholder", "sample", "dummy", "lorem ipsum", "asdf"])("the placeholder %j is rejected for every identity and terms field", (v) => {
    for (const k of ["brandName", "legalName", "registrationNumber", "vatNumber", "phone", "paymentTerms", "deliveryInstallationConditions", "termsAndConditions", "acceptanceInstructions"] as const)
      expect(missingProfileFields({ ...FICTITIOUS, [k]: v }), `${k}=${v}`).toEqual([PROFILE_LABELS[k]]);
  });
  it("short stub terms, a one-line address, an invalid email, and validity outside 1-365 days are rejected", () => {
    expect(missingProfileFields({ ...FICTITIOUS, termsAndConditions: "Net 30 days." })).toEqual(["Terms and conditions"]);
    expect(missingProfileFields({ ...FICTITIOUS, addressLines: ["12 Imaginary Road"] })).toEqual(["Company address"]);
    expect(missingProfileFields({ ...FICTITIOUS, email: "sales@" })).toEqual(["Company email"]);
    for (const d of [0, -5, 366, 30.5]) expect(missingProfileFields({ ...FICTITIOUS, validityDays: d })).toEqual(["Quotation validity (days)"]);
  });
  it("repeated-digit identity values are rejected", () => {
    for (const k of ["registrationNumber", "vatNumber", "phone"] as const) expect(missingProfileFields({ ...FICTITIOUS, [k]: "0000000000" })).toEqual([PROFILE_LABELS[k]]);
  });
});

describe("the rendered customer PDF", () => {
  const { baseline, model } = fixture();
  const FORBIDDEN_WORDS = /supplier|vendor|landed|exchange|fx\b|forex|rand\/usd|usd|eur\b|freight|mark-?up|margin|gross profit|\bgp\b|cost price|unit cost|estimator|cin7|test-only|internal|purchase price|\bsku\b/i;
  const INTERNAL_SKUS = ["PNQ082", "NQ1161", "SYSH-2750-3", "HNQ7046"];

  it("renders, and the extracted text carries what the customer needs", async () => {
    const bytes = await renderCustomerPdf(model);
    if (process.env.NEWQUIP_PDF_OUT) { fs.mkdirSync(process.env.NEWQUIP_PDF_OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.NEWQUIP_PDF_OUT, "quotation.pdf"), bytes); }
    const pages = pdfPages(bytes); const t = pages.join("\n"); const flat = t.replace(/\s/g, ""); // fragments of one line are separate text runs: compare without whitespace
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(pages.length).toBeGreaterThanOrEqual(2); // the long terms really paginate
    for (const must of ["Highveld Pig Farm (Pty) Ltd", "Highveld Farm, Grower House 3", "NQ-Q-0123", "revision 2", "17/11/2026", "17/12/2026", "Attention: Piet Highveld", "Fictional Feed Systems (Pty) Ltd", "Reg. 2099/000123/07", "VAT 4999000123",
      "Total excluding VAT", "VAT (15%)", "Total including VAT", formatRand(model.totals.subtotalExVat), formatRand(model.totals.vat), formatRand(model.totals.totalIncVat), "Payment schedule", "Deposit", "Delivery", "Installation", "40%", "55%", "5%", "Payment terms", "Delivery and installation", "Terms and conditions", "How to accept this quotation"]) expect(flat, must).toContain(must.replace(/\s/g, ""));
    for (const s of model.sections) { expect(flat).toContain(s.title.replace(/\s/g, "")); expect(flat).toContain(formatRand(s.amountExVat).replace(/\s/g, "")); }
    for (const p of model.paymentSchedule) expect(flat).toContain(formatRand(p.amountExVat).replace(/\s/g, ""));
    // every page carries the fixed footer with its page number
    pages.forEach((_, i) => expect(flat).toContain(`Page${i + 1}of${pages.length}`));
  });

  it("LAYOUT REGRESSION: the payment schedule is never split across a page break, and a milestone's wording is not printed twice", async () => {
    const pages = pdfPages(await renderCustomerPdf(model)).map((p) => p.replace(/\s/g, ""));
    const holder = pages.filter((p) => p.includes("Paymentschedule"));
    expect(holder).toHaveLength(1);
    for (const stage of model.paymentSchedule) expect(holder[0]).toContain(formatRand(stage.amountExVat).replace(/\s/g, ""));
    expect(pages.join("")).not.toContain("Due:"); // the standard schedule's trigger equals its description: printed once
  });

  it("figures reconcile: sections = sub-total, stages = sub-total, VAT is 15% of the sub-total, total = sub-total + VAT, to the cent", () => {
    const c = (n: number) => Math.round(n * 100);
    expect(model.sections.reduce((a, s) => a + c(s.amountExVat), 0)).toBe(c(model.totals.subtotalExVat));
    expect(model.paymentSchedule.reduce((a, s) => a + c(s.amountExVat), 0)).toBe(c(model.totals.subtotalExVat));
    expect(model.paymentSchedule.map((p) => p.percent)).toEqual([40, 55, 5]);
    expect(model.totals.vatRatePercent).toBe(15);
    expect(c(model.totals.vat)).toBe(Math.floor((c(model.totals.subtotalExVat) * 15 + 50) / 100));
    expect(c(model.totals.subtotalExVat) + c(model.totals.vat)).toBe(c(model.totals.totalIncVat));
  });

  it("CONFIDENTIALITY: the PDF text, metadata and raw bytes contain no supplier, cost, FX, freight, margin wording, internal SKU, 'cin7' or 'TEST-ONLY'", async () => {
    const set = internalTokenSet(baseline);
    for (const s of ["PNQ082", "NQ1161", "SYSH-2750-3"]) expect(set.ids, `fixture should hold ${s}`).toContain(s); // the baseline REALLY holds these, so absence in the PDF is meaningful
    expect(() => assertNoInternalLeak(model, baseline)).not.toThrow();
    const bytes = await renderCustomerPdf(model);
    const text = pdfPages(bytes).join("\n"); const raw = Buffer.from(bytes).toString("latin1");
    expect(text.length).toBeGreaterThan(500);
    expect(text.match(FORBIDDEN_WORDS)?.[0] ?? null).toBeNull();
    // The one internal-sounding word that IS printed is the confirmed standard milestone wording "Contract approved, before procurement" (the deposit trigger). It names no supplier, cost or rate.
    expect([...text.matchAll(/procurement/gi)].length).toBe(1);
    expect(text).toContain("before procurement");
    for (const token of [...set.ids, ...set.people, ...set.notes, ...INTERNAL_SKUS, "INTERNAL-ASSUMPTION"]) {
      expect(text.toLowerCase().includes(token.toLowerCase()), `PDF text leaked: ${token}`).toBe(false);
      expect(raw.includes(token), `PDF bytes leaked: ${token}`).toBe(false);
    }
    for (const fig of set.figures) expect(new RegExp(`(?<![\\d.,])${fig.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`).test(text), `PDF leaked cost figure ${fig}`).toBe(false);
    // document metadata (Info dictionary) is not compressed: the title/author/creator carry no internal wording either
    expect(raw).not.toMatch(/cin7|test-only|supplier|margin/i);
    // internal staff identities never appear
    for (const p of ["rep.person@nq.example", "est.person@nq.example", "mgr.person@nq.example"]) expect(text).not.toContain(p);
  });
});
