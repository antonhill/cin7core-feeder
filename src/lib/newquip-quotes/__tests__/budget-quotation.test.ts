// BUDGET QUOTATION (customer UAT feedback): the model, the PDF, the email and the send rules. The database fake REJECTS every table except activity_log reads and every write, which proves the budget
// path creates no approval, acceptance, issued document, send record, Project or Cin7 record: its only record is the (injected) audit trail.
import { beforeEach, describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { emptyDraft, type QuoteDraft } from "@/newquip/grower/draft";
import { readyDraft } from "@/newquip/grower/__tests__/golden";

const state: { quote: unknown; profile: unknown; snapshot: unknown } = { quote: null, profile: null, snapshot: null };
vi.mock("../quote-store", () => ({ loadQuote: async () => state.quote }));
vi.mock("../document-store", () => ({ latestProfile: async () => state.profile }));
vi.mock("../customer-store", () => ({ latestSnapshot: async () => state.snapshot }));
vi.mock("../context", async () => { const { testPriceSource } = await import("@/newquip/grower/__tests__/test-snapshot"); return { evaluationContext: (w: boolean) => ({ priceSource: testPriceSource(), withholdCost: w }) }; });

import { BUDGET_DISCLAIMER, buildBudgetDocumentModel, presentsPartialAsTotal } from "../budget-document";
import { buildBudgetEmail, budgetSendRefusal, prepareBudget, sendBudgetQuotation, type BudgetSendDeps } from "../budget-quotation";
import { renderBudgetPdf } from "../budget-pdf";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { nqQ0002, S } from "@/newquip/grower/__tests__/nq-q-0002-fixture";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";
import { quoteToProjectBaseline } from "@/newquip/quote/to-project";
import { GOLDEN_LIBRARY } from "@/newquip/grower/__tests__/golden-catalogue";
import { buildCustomerSummaryFromCommercial } from "@/newquip/grower/customer-summary";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";

const PROFILE_REAL = { brandName: "Fictional Feed", legalName: "Fictional Feed (Pty) Ltd", registrationNumber: "2099/000123/07", vatNumber: "4999000123", addressLines: ["12 Imaginary Road", "Exampleton"], phone: "+27 11 555 0199", email: "q@fictional.example", website: "", validityDays: 30,
  paymentTerms: "Invoices are issued per milestone and payable within 7 days of the invoice date.", deliveryInstallationConditions: "Delivery is to the site address stated on the quotation, with safe vehicle access.", termsAndConditions: "Standard terms apply to every quotation issued by the company.", acceptanceInstructions: "Sign and return the acceptance page to accept the final quotation." };
const PROFILE_PLACEHOLDER = { ...PROFILE_REAL, paymentTerms: "test", termsAndConditions: "TBD" };
const UAT = { VERCEL_ENV: "production", CIN7_CREDENTIAL_STORE: "uat", NEWQUIP_UAT_TEST_EMAIL_ENABLED: "true" };

// NQ-Q-0003-like: nothing mapped -> five equipment lines unpriced; plus Delivery and Installation (+ commissioning).
function unmappedDraft(): QuoteDraft {
  const d = emptyDraft();
  return { ...d, customerName: "Test Customer", siteName: "Test Site", quoteType: "project",
    config: { ...d.config, rooms: 3, widthM: 11, lengthM: 72, totalPens: 32, pigsPerRoom: 700, penningPigSize: "MEDIUM", slattedFloorAreaM2: 0, penningRunningMetresPerRoom: 0,
      optionalEquipment: { cone_fans: true, controller: true, manure_plug: false, pad_cooling: true, control_panel: true, silo_weighing: false, emergency_windows: false },
      estimatorQuantities: { feeder: 0, pvc_door: 4, bulk_tank: 0, cone_fans: 4, controller: 1, flex_auger: 0, cup_drinker: 0, pad_cooling: 1, concrete_slat: 0, control_panel: 1 }, quantityOverrides: { led_light: 0 }, quantityOverrideReasons: { led_light: "x", feed_saver_mat: "x" },
      exclusions: { feeder: "n", bulk_tank: "n", led_light: "n", flex_auger: "n", cup_drinker: "n", concrete_slat: "n", feed_saver_mat: "n", penning_package: "n" } },
    estimator: { ...d.estimator, charges: { delivery: 8000, installation: 32500, commissioning: 7500 }, templateRevision: "grower-2026-11" } };
}
const quoteOf = (draft: QuoteDraft, over: Record<string, unknown> = {}) => ({ id: "11111111-1111-1111-1111-111111111111", org_id: "org", quote_ref: "NQ-Q-0003", revision: 1, state: "REP_DRAFT", draft, draft_hash: "draft-hash-fixture-one", created_by_email: "rep@x", ...over });

const reads: string[] = [];
const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
const fakeDb = (existing: unknown[] = []) => ({ from(t: string) {
  reads.push(t);
  if (t !== "activity_log") throw new Error(`UNEXPECTED TABLE ACCESS: ${t}`);
  const q: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "filter", "limit"]) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown) => res({ data: existing, error: null }); return q;
} }) as never;
const deps = (over: Partial<BudgetSendDeps> = {}): BudgetSendDeps & { sent: unknown[] } => { const sent: unknown[] = []; return { sent, send: async (i) => { sent.push(i); return { ok: true, messageId: "m-1" }; }, today: () => "2026-11-18", now: () => "2026-11-18T10:00:00Z", storage: { upload: async (path: string, bytes: Uint8Array) => { uploads.push({ path, bytes }); } }, ...over }; };
const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
const audit = (async (_db: unknown, i: { action: string; detail: Record<string, unknown> }) => { audits.push(i); }) as never;
const who = { orgId: "org", userId: "u1", email: "rep@sparkconsulting.co.za", isRep: true };
const req = { to: "anton@sparkconsulting.co.za", idempotencyKey: "send-attempt-one", expectedDraftHash: "draft-hash-fixture-one", acknowledgeIncomplete: true };

beforeEach(() => { uploads.length = 0; reads.length = 0; audits.length = 0; state.quote = quoteOf(unmappedDraft()); state.profile = { profile: PROFILE_PLACEHOLDER }; state.snapshot = null; });

function pdfText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1"); const out: string[] = []; const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { let c: string; try { c = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    out.push([...c.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?[\d.]+)*)\]\s*TJ/g)].map((arr) => [...arr[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join("")).join(" ")); }
  return out.join(" ").replace(/\s+/g, " ");
}

describe("budget document model", () => {
  it("INCOMPLETE (NQ-Q-0003): five unpriced equipment lines read 'Price to be confirmed'; Delivery and the COMBINED Installation & Commissioning are priced; NO total is presented", async () => {
    const m = (await prepareBudget(fakeDb(), "org", "q", UAT, () => "2026-11-18")).model;
    expect(m.complete).toBe(false);
    expect(m.unpriced.count).toBe(5);
    expect(m.equipment.filter((l) => l.status === "unpriced")).toHaveLength(5);
    expect(m.equipment.every((l) => l.amountExVat === null)).toBe(true);
    expect(m.charges.map((c) => [c.label, c.amountExVat])).toEqual([["Delivery", 8000], ["Installation & Commissioning", 40000]]); // 32,500 + 7,500 counted ONCE
    expect(m.totals.knownSubtotalExVat).toBe(48000);
    expect(m.totals.totalIncVat).toBeNull();
    expect(m.totals.vatExVatBasis).toBeNull();
    expect(presentsPartialAsTotal(m)).toBe(false);
    expect(m.disclaimer).toBe(BUDGET_DISCLAIMER);
    expect(BUDGET_DISCLAIMER).toBe("BUDGET QUOTATION \u2013 INDICATIVE PRICING ONLY. Subject to final equipment confirmation, supplier costing, Estimator review and management approval. This is not a final commercial quotation.");
  });
  it("without commissioning the charge keeps its original 'Installation' wording and amount", async () => {
    const d = unmappedDraft(); d.estimator.charges = { delivery: 8000, installation: 32500 }; state.quote = quoteOf(d);
    const m = (await prepareBudget(fakeDb(), "org", "q", UAT)).model;
    expect(m.charges.map((c) => [c.label, c.amountExVat])).toEqual([["Delivery", 8000], ["Installation", 32500]]);
  });
  it("a missing required charge is itself an unpriced item and keeps the budget incomplete", async () => {
    const d = unmappedDraft(); d.estimator.charges = { delivery: 8000 }; state.quote = quoteOf(d);
    const m = (await prepareBudget(fakeDb(), "org", "q", UAT)).model;
    expect(m.unpriced.items).toContain("Installation & Commissioning");
    expect(m.unpriced.count).toBe(6);
  });
  it("COMPLETE: a fully priced quotation shows subtotal, VAT 15% and total, equal to the engine's own figures (no double counting)", () => {
    const d = readyDraft(); d.estimator.charges = { ...d.estimator.charges, commissioning: 7500 };
    const ev = evaluateDraft(d, { priceSource: testPriceSource(), withholdCost: true });
    const m = buildBudgetDocumentModel({ budget: ev.budget!, quoteRef: "NQ-Q-9", revision: 1, draftHash: "h".repeat(20), preparedOn: "2026-11-18", siteName: "s", customerName: "c", contact: null, profile: PROFILE_REAL, config: {}, testOnly: false });
    expect(m.complete).toBe(true);
    expect(m.totals.knownSubtotalExVat).toBeCloseTo(ev.budget!.totals.subtotalExTax, 2);
    expect(m.totals.vatExVatBasis).toBeCloseTo(ev.budget!.totals.taxTotal, 2);
    expect(m.totals.totalIncVat).toBeCloseTo(ev.budget!.totals.totalIncTax, 2);
    expect(m.charges.find((c) => c.label.startsWith("Installation"))!.amountExVat).toBe(400000 + 7500);
  });
  it("carries NO internal data: no SKU, cost, supplier, margin, rate or free-text assumptions", async () => {
    const d = unmappedDraft(); d.estimator.assumptions = "INTERNAL: supplier quote, margin 30%, freight 1.3"; state.quote = quoteOf(d);
    const m = (await prepareBudget(fakeDb(), "org", "q", UAT)).model;
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/INTERNAL|margin|supplier quote|freight|landed|costOverrides|\bsku\b/i);
  });
  it("refuses a quotation that is no longer a draft (approved quotations use the final document)", async () => {
    state.quote = quoteOf(unmappedDraft(), { state: "MANAGER_APPROVED_FINAL" });
    await expect(prepareBudget(fakeDb(), "org", "q", UAT)).rejects.toThrow(/already been approved/);
  });
});

describe("budget PDF", () => {
  it("renders a real PDF from the saved draft, titled BUDGET QUOTATION with the disclaimer, unpriced items, 'NOT AVAILABLE' and the TEST ONLY watermark in UAT", async () => {
    const prep = await prepareBudget(fakeDb(), "org", "q", UAT, () => "2026-11-18");
    const bytes = await renderBudgetPdf(prep.model);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const t = pdfText(bytes);
    expect(t).toContain("BUDGET QUOTATION NQ-Q-0003");
    expect(t).toContain("INDICATIVE PRICING ONLY");
    expect(t).toContain("This is not a final commercial quotation");
    expect(t).toContain("Price to be confirmed");
    expect(t).toMatch(/INCOMPLETE PRICING.{0,4}5 item\s?s not yet priced/);
    expect(t).toContain("NOT AVAILABLE");
    expect(t).toContain("Installation & Commissioning");
    expect(t).toContain("R 40 000,00");
    expect(t).toContain("TEST ONLY");
    expect(t).not.toMatch(/Total including VAT|Budget total/);
    expect(t).not.toMatch(/\bsku\b|margin|landed|cost price|mark-?up|freight/i); // ("supplier costing" appears only inside the mandated disclaimer)
  });
  it("a COMPLETE budget shows the totals and still says it is a budget, not a final quotation", async () => {
    state.quote = quoteOf(readyDraft());
    const prep = await prepareBudget(fakeDb(), "org", "q", {}, () => "2026-11-18");
    const t = pdfText(await renderBudgetPdf({ ...prep.model, testOnly: false }));
    expect(prep.model.complete).toBe(true);
    expect(t).toContain("Budget total including VAT");
    expect(t).toContain("Indicative budget only");
    expect(t).not.toContain("NOT AVAILABLE");
  });
});

describe("budget email", () => {
  it("states the exact disclaimer first and last, marks incomplete pricing, and carries NO accept / decline / link", async () => {
    const prep = await prepareBudget(fakeDb(), "org", "q", UAT);
    const mail = buildBudgetEmail({ model: prep.model, to: "anton@sparkconsulting.co.za", message: "", bytes: new Uint8Array([1]) });
    expect(mail.subject).toBe("TEST ONLY \u2013 BUDGET QUOTATION \u2013 INDICATIVE PRICING ONLY \u2013 NQ-Q-0003");
    expect(mail.text.split("\n").filter((l) => l === BUDGET_DISCLAIMER)).toHaveLength(2);
    expect(mail.text).toContain("INCOMPLETE PRICING: 5 items are not yet priced");
    expect(mail.text + mail.html).not.toMatch(/https?:|accept the quotation|decline the quotation|request changes/i);
    expect(mail.attachments).toHaveLength(1);
  });
});

describe("send rules", () => {
  it("UAT: sends ONLY to an authorised test mailbox, with the incomplete acknowledgement, and records the exact snapshot", async () => {
    const dp = deps(); const db = fakeDb();
    const r = await sendBudgetQuotation(db, who, "q", req, UAT, dp, audit);
    expect(r).toMatchObject({ status: "ACCEPTED", to: "anton@sparkconsulting.co.za", reused: false, incompleteCount: 5, testMode: true });
    expect(dp.sent).toHaveLength(1);
    const sent = dp.sent[0] as { to: string[]; subject: string; text: string };
    expect(sent.to).toEqual(["anton@sparkconsulting.co.za"]);
    expect(sent.subject).toMatch(/^\[PREVIEW\] TEST ONLY/);
    expect(audits.map((a) => a.action)).toEqual(["newquip.budget_quotation_send_started", "newquip.budget_quotation_sent"]); // intent recorded BEFORE the email leaves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = audits[1].detail as Record<string, any>;
    expect(rec).toMatchObject({ quoteRef: "NQ-Q-0003", draftHash: "draft-hash-fixture-one", complete: false, incompleteCount: 5, status: "ACCEPTED", providerMessageId: "m-1", testMode: true });
    expect(rec.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.snapshot.model.kind).toBe("BUDGET_QUOTATION"); // the exact document model is reproducible from the audit record
    expect(rec.snapshot.modelHash).toBe(rec.modelHash);
  });
  it("UAT: a real customer address is REFUSED (never redirected) and nothing is sent or recorded", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb(), who, "q", { ...req, to: "farmer@realcustomer.co.za" }, UAT, dp, audit)).rejects.toThrow(/authorised Spark test mailbox/);
    expect(dp.sent).toHaveLength(0); expect(audits).toHaveLength(0);
  });
  it("only a Rep may send (Estimator / Manager refused)", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb(), { ...who, isRep: false }, "q", req, UAT, dp, audit)).rejects.toThrow(/Only a Rep/);
    expect(dp.sent).toHaveLength(0);
  });
  it("incomplete pricing needs the Rep's explicit acknowledgement", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb(), who, "q", { ...req, acknowledgeIncomplete: false }, UAT, dp, audit)).rejects.toThrow(/Pricing is incomplete/);
    expect(dp.sent).toHaveLength(0);
  });
  it("a draft that changed since the preview is refused: the customer gets exactly what was previewed", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb(), who, "q", { ...req, expectedDraftHash: "different" }, UAT, dp, audit)).rejects.toThrow(/changed after you previewed/);
    expect(dp.sent).toHaveLength(0);
  });
  it("the test email switch is required in any restricted environment", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb(), who, "q", req, { VERCEL_ENV: "preview" }, dp, audit)).rejects.toThrow(/available only on the UAT/);
    expect(dp.sent).toHaveLength(0);
  });
  it("PRODUCTION: refused while placeholder company details, unapproved wording or the production email switch stand in the way (a 'provisional' label bypasses none of them)", () => {
    const prod = { VERCEL_ENV: "production" };
    expect(budgetSendRefusal(prod, true, [])).toMatch(/Production email is not enabled/);
    expect(budgetSendRefusal({ ...prod, NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true" }, true, [])).toMatch(/wording has not been approved/);
    expect(budgetSendRefusal({ ...prod, NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true", NEWQUIP_BUDGET_QUOTATION_WORDING_APPROVED: "true" }, false, ["Payment terms contains placeholder text"])).toMatch(/company details cannot be used/);
    expect(budgetSendRefusal({ ...prod, NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true", NEWQUIP_BUDGET_QUOTATION_WORDING_APPROVED: "true" }, true, [])).toBeNull();
  });
  it("a repeat of the same click returns the recorded outcome and emits nothing", async () => {
    const dp = deps();
    const r = await sendBudgetQuotation(fakeDb([{ action: "newquip.budget_quotation_sent", created_at: "2026-11-18T09:00:00Z", detail: { status: "ACCEPTED", to: "anton@sparkconsulting.co.za", incompleteCount: 5, testMode: true, draftRef: "draft-hash-fi", pdfSha256: "x" } }]), who, "q", req, UAT, dp, audit);
    expect(r.reused).toBe(true); expect(dp.sent).toHaveLength(0); expect(audits).toHaveLength(0);
  });
  it("a FAILED earlier send is NOT reported as sent: the Rep can retry with the same key", async () => {
    const dp = deps();
    const r = await sendBudgetQuotation(fakeDb([{ action: "newquip.budget_quotation_sent", detail: { status: "FAILED" }, created_at: "2026-11-18T09:00:00Z" }]), who, "q", req, UAT, dp, audit);
    expect(r.reused).toBe(false); expect(dp.sent).toHaveLength(1);
  });
  it("a send that started seconds ago with no outcome is in flight: a second one is refused", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb([{ action: "newquip.budget_quotation_send_started", detail: {}, created_at: new Date().toISOString() }]), who, "q", req, UAT, dp, audit)).rejects.toThrow(/already being sent/);
    expect(dp.sent).toHaveLength(0);
  });
  it("incomplete for a non-line reason still never shows a total and says pricing is under review", async () => {
    const d = unmappedDraft(); d.estimator.charges = { delivery: 8000, installation: 32500 }; d.config.estimatorQuantities = { ...d.config.estimatorQuantities, pvc_door: 4 };
    d.estimator.confirmedMappings = { pvc_door: "NQ2114", controller: "X", control_panel: "X", pad_cooling: "X", cone_fans: "X" }; state.quote = quoteOf(d);
    const m = (await prepareBudget(fakeDb(), "org", "q", UAT)).model;
    expect(m.totals.totalIncVat === null || m.complete).toBe(true);
    expect(m.unpriced.count).toBeGreaterThan(0);
  });
  it("if the audit record cannot be written NOTHING is sent", async () => {
    const dp = deps();
    await expect(sendBudgetQuotation(fakeDb(), who, "q", req, UAT, dp, (async () => { throw new Error("audit down"); }) as never)).rejects.toThrow(/audit down/);
    expect(dp.sent).toHaveLength(0);
  });
  it("a provider failure is recorded as FAILED (not as sent)", async () => {
    const dp = deps({ send: async () => ({ ok: false, error: "boom" }) });
    const r = await sendBudgetQuotation(fakeDb(), who, "q", req, UAT, dp, audit);
    expect(r.status).toBe("FAILED"); expect((audits[1].detail as Record<string, unknown>).status).toBe("FAILED");
  });
  it("internal wording in the Rep's message is refused", async () => {
    await expect(sendBudgetQuotation(fakeDb(), who, "q", { ...req, message: "our margin is 30%" }, UAT, deps(), audit)).rejects.toThrow(/internal information/);
  });
  it("NO approval, acceptance, issued document, send record, Project or Cin7 write: the database fake only ever allows activity_log reads", async () => {
    await sendBudgetQuotation(fakeDb(), who, "q", req, UAT, deps(), audit);
    expect([...new Set(reads)]).toEqual(["activity_log"]);
  });
  it("organisation isolation: the quotation is loaded for the actor's organisation only (a missing quotation is refused)", async () => {
    state.quote = null;
    await expect(sendBudgetQuotation(fakeDb(), who, "q", req, UAT, deps(), audit)).rejects.toThrow(/Quotation not found/);
  });
});

describe("commissioning: approval snapshot, Project handover and historic documents", () => {
  const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "Piet <p@x>", handoffBy: "rep@x", estimatorSignoffBy: "est@x", estimatorSignoffAt: "t", managerApprovedBy: "mgr@x", managerApprovedAt: "t" };
  const baselineOf = (commissioning: number | undefined) => {
    const d = readyDraft(); if (commissioning !== undefined) d.estimator.charges = { ...d.estimator.charges, commissioning };
    return buildAcceptedBaseline({ mappingLibrary: GOLDEN_LIBRARY as never, quoteRef: "NQ-Q-1", revision: 1, draft: d, evaluation: evaluateDraft(d, { priceSource: testPriceSource(), withholdCost: false }), approvals }).baseline;
  };
  it("the approval snapshot freezes commissioning as its own charge, and the contract total includes it exactly once", () => {
    const without = baselineOf(undefined), withC = baselineOf(7500);
    expect(without.commercial.charges.map((c) => c.key)).not.toContain("commissioning");
    expect(withC.commercial.charges.find((c) => c.key === "commissioning")).toMatchObject({ amountCents: 750000 });
    expect(withC.contractCents - without.contractCents).toBe(750000);
  });
  it("Project handover: commissioning becomes an Installation-stage line and the project lines still add up to the contract", () => {
    const b = baselineOf(7500);
    const p = quoteToProjectBaseline(b, "hash", "qid");
    expect(p.lines.find((l) => l.lineRef === "commissioning")).toMatchObject({ suggestedStageName: "Installation", salesValueCents: 750000 });
    expect(p.lines.reduce((a, l) => a + l.salesValueCents, 0)).toBe(b.contractCents);
  });
  it("a HISTORIC approved baseline (no commissioning) hands over and renders exactly as before", () => {
    const b = baselineOf(undefined);
    const p = quoteToProjectBaseline(b, "hash", "qid");
    expect(p.lines.some((l) => l.lineRef === "commissioning")).toBe(false);
    expect(p.lines.reduce((a, l) => a + l.salesValueCents, 0)).toBe(b.contractCents);
    const s = buildCustomerSummaryFromCommercial(b.commercial);
    expect(s.sections.find((x) => /install/i.test(x.title))!.title).toBe("Installation");
    expect(s.sections.reduce((a, x) => a + Math.round(x.amountExVat * 100), 0)).toBe(b.commercial.subtotalCents);
  });
});

describe("provisional pricing in the budget quotation (UAT only)", () => {
  const pdfOf = async () => { const prep = await prepareBudget(fakeDb(), "org", "q", UAT, () => "2026-11-18"); return { prep, text: pdfText(await renderBudgetPdf(prep.model)) }; };
  beforeEach(() => { state.quote = quoteOf(nqQ0002(), { draft_hash: "draft-hash-fixture-one" }); });

  it("the document shows the two packages as PROVISIONAL priced lines, the PVC door as unpriced, a priced SUBTOTAL, and NO total", async () => {
    const { prep, text } = await pdfOf();
    const m = prep.model;
    expect(m.provisional.count).toBe(2);
    expect(m.equipment.filter((l) => l.status === "provisional").map((l) => l.amountExVat).sort()).toEqual([332934.72, 431082]);
    expect(m.totals.knownSubtotalExVat).toBeCloseTo(11_129_349.36, 2);
    expect(m.complete).toBe(false);
    expect(m.totals.totalIncVat).toBeNull();
    expect(text).toContain("PROVISIONAL");
    expect(text).toContain("most likely to change");
    expect(text).toContain("Subtotal of PRICED items only");
    expect(text).toContain("NOT AVAILABLE");
    expect(text).not.toMatch(/Provisional estimate including VAT/);
  });
  it("the Rep-facing document and email carry no product code, supplier, cost, rate, freight, markup, margin or the internal open questions", async () => {
    const { prep, text } = await pdfOf();
    const all = JSON.stringify(prep.model) + text + buildBudgetEmail({ model: prep.model, to: "anton@sparkconsulting.co.za", message: "", bytes: new Uint8Array([1]) }).text;
    expect(all).not.toMatch(/HNQ|QCA00|NQ1380|NYNUT|NB3542|FERAX|supplier price|freight|markup|margin|landed|rateMicro/i);
  });
  it("a COMPLETE provisional budget (door costed) shows a PROVISIONAL ESTIMATE total including VAT", async () => {
    const d = nqQ0002(); d.estimator.confirmedMappings = { pvc_door: "NQ3444" } as never; (d.estimator.pricing!.skus as Record<string, unknown>).NQ3444 = S("ZAR", 90000000000); state.quote = quoteOf(d, { draft_hash: "draft-hash-fixture-one" });
    const { prep, text } = await pdfOf();
    expect(prep.model.complete).toBe(true);
    expect(prep.model.totals.totalIncVat).not.toBeNull();
    expect(text).toContain("Provisional estimate including VAT");
    expect(prep.model.vatNote).toMatch(/provisional budget estimate/);
  });
  it("sending records the INTERNAL snapshot in the private store; the audit row holds only its path and hash (no cost, rate, freight or markup)", async () => {
    const dp = deps();
    await sendBudgetQuotation(fakeDb(), who, "q", { ...req, expectedDraftHash: "draft-hash-fixture-one" }, UAT, dp, audit);
    expect(uploads).toHaveLength(1);
    const snap = JSON.parse(new TextDecoder().decode(uploads[0].bytes));
    expect(snap.draft.estimator.pricing.skus.HNQ7046).toBeDefined(); // internal: the saved draft WITH its pricing
    expect(snap.provisional.map((p: { itemKey: string }) => p.itemKey).sort()).toEqual(["cup_drinker", "led_light"]);
    expect(snap.provisional[0].openQuestions.join(" ")).toMatch(/NB3542-03|FORTIS/);
    const rec = audits[1].detail as Record<string, unknown>;
    expect(rec.provisionalCount).toBe(2);
    expect((rec.internalSnapshot as { path: string; sha256: string }).path).toBe(uploads[0].path);
    expect(JSON.stringify(audits.map((a) => ({ ...a.detail, snapshot: undefined })))).not.toMatch(/nativeUnitCost|rateMicro|factorMicro|markupBps|HNQ7046/);
  });
  it("no internal snapshot store -> nothing is sent", async () => {
    const dp = deps({ storage: undefined });
    await expect(sendBudgetQuotation(fakeDb(), who, "q", { ...req, expectedDraftHash: "draft-hash-fixture-one" }, UAT, dp, audit)).rejects.toThrow(/snapshot store is unavailable/);
    expect(dp.sent).toHaveLength(0);
  });
  it("PRODUCTION: a budget with provisional packages is refused until NewQuip management approves the compositions", async () => {
    const dp = deps();
    const prod = { VERCEL_ENV: "production", NEWQUIP_PRODUCTION_EMAIL_ENABLED: "true", NEWQUIP_BUDGET_QUOTATION_WORDING_APPROVED: "true" };
    state.profile = { profile: PROFILE_REAL };
    await expect(sendBudgetQuotation(fakeDb(), who, "q", { ...req, to: "farmer@realcustomer.co.za", expectedDraftHash: "draft-hash-fixture-one" }, prod, dp, audit)).rejects.toThrow(/provisional package prices/);
    expect(dp.sent).toHaveLength(0);
    await sendBudgetQuotation(fakeDb(), who, "q", { ...req, to: "farmer@realcustomer.co.za", expectedDraftHash: "draft-hash-fixture-one" }, { ...prod, NEWQUIP_PROVISIONAL_PACKAGES_APPROVED: "true" }, dp, audit);
    expect(dp.sent).toHaveLength(1);
  });
});
