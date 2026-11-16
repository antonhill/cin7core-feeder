/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { NEWQUIP_STANDARD_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { createQuote, estimatorSignOff, managerApprove, saveDraft, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import { buildCustomerSnapshot, withChosenContact } from "@/lib/newquip-quotes/customer-snapshot";
import { appendSnapshot } from "@/lib/newquip-quotes/customer-store";
import { issueQuotationDocument, saveProfile, type DocumentDeps } from "@/lib/newquip-quotes/document-store";
import { renderCustomerPdf } from "@/lib/newquip-quotes/customer-pdf";
import { sendQuotationToCustomer } from "@/lib/newquip-quotes/send-store";
import { recordStaffResponse } from "@/lib/newquip-quotes/response-record";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";

// The page bundle's delivery and documents parts through the REAL readers (page-reads.ts) over a populated FakeDb - an approved quotation with an issued document, a send with emailed
// response links, a customer snapshot and a recorded customer response with an evidence file - for a Rep AND an Estimator: identical to what the single actions return, no cost / margin /
// supplier / markup / freight / FX / unit-cost key, no link token, signed URL, storage path or secret anywhere in the serialised results. And: when authorisation fails, nothing is read.
const { dbFactory } = vi.hoisted(() => ({ dbFactory: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => dbFactory() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "m" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));
import * as actions from "../actions";
import * as delivery from "../delivery-actions";
import * as documents from "../document-actions";

const ORG = "org-newquip"; const rep = rolesFor("member"); const mgr = rolesFor("admin"); const ctx = { priceSource: testPriceSource(), withholdCost: true };
const TODAY = "2026-10-29";
const PREVIEW = { VERCEL_ENV: "preview", NEXT_PUBLIC_SITE_URL: "https://internal.newquip.example", NEWQUIP_PUBLIC_PORTAL_URL: "https://preview.newquip.example", NEWQUIP_INTERNAL_APP_URL: "https://internal.newquip.example" };
const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "Fictitious fixture: 40% deposit, 55% on delivery, 5% on completion.", deliveryInstallationConditions: "Fictitious fixture: delivery to the site gate; installation on a cleared site.", termsAndConditions: "Fictitious fixture: terms and conditions for automated tests only.", acceptanceInstructions: "Fictitious fixture: reply to the sender to accept this quotation." } as any;
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

let db: FakeDb; let quoteId = ""; let tokens: string[] = [];

/** keys anywhere in a serialised payload */
const keysOf = (v: unknown, out: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};
const COST_KEY = /cost|margin|supplier|markup|physical|freight|landed|fx|exchange|forwardcover|nativeunit|unit_cost/i;
const SECRET_KEY = /token|secret|signed|password|credential|storage|path|apikey|api_key|bearer/i;

beforeAll(async () => {
  db = new FakeDb();
  dbFactory.mockImplementation(() => db);
  seedGoldenCatalogue(db as never, ORG); db.deliveryApplied = true; db.portalApplied = true; db.approvalsApplied = true; db.notificationStatuses = ["PENDING", "SENT", "FAILED", "ABANDONED", "SUPPRESSED"];
  const files = new Map<string, Uint8Array>();
  const deps: DocumentDeps = { today: () => TODAY, render: renderCustomerPdf, storage: { upload: async (p, b) => { files.set(p, b); }, download: async (p) => files.get(p)!, remove: async (p) => { files.delete(p); } } };
  const draft = readyDraft(); draft.customerName = "Boerdery (Pty) Ltd"; draft.siteName = "Paarl";
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  quoteId = id;
  (db.rows("newquip_quotes")[0] as Record<string, unknown>).requires_customer_acceptance = true;
  await saveDraft(db as never, ORG, rep, id, draft);
  const snap = withChosenContact(buildCustomerSnapshot({ ID: "cin7-cust-42", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "Piet", Email: "piet@boerdery.example" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 });
  await appendSnapshot(db as never, ORG, id, snap, { email: "rep@nq" }, "test");
  await saveProfile(db as never, ORG, PROFILE, "m@nq");
  const total = Math.round(evaluateDraft(draft, ctx).budget!.totals.subtotalExTax * 100);
  await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
  await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
  await managerApprove(db as never, ORG, mgr, "manager@nq", id, ctx);
  const { document: doc } = await issueQuotationDocument(db as never, ORG, id, { email: "mgr@nq" }, NEWQUIP_STANDARD_SCHEDULE, deps);
  // a send, capturing the emailed response links (the tokens that must never appear in a view)
  const captured: string[] = [];
  const fn = vi.fn(async (i: { text: string }) => { captured.push(i.text); return { ok: true, messageId: "m-" + captured.length }; });
  await sendQuotationToCustomer(db as never, ORG, id, { email: "rep@sparkconsulting.co.za" }, { documentId: doc.id, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-real-readers-1" }, deps, PREVIEW as never, fn as never);
  tokens = [...captured.join("\n").matchAll(/#t=([A-Za-z0-9_.-]+)&a=(accept|decline|changes)/g)].map((m) => m[1]);
  // a staff-recorded customer response with an evidence file
  await recordStaffResponse(db as never, deps.storage, ORG, id, { email: "rep@nq", ownerEmail: "own@x.co" }, { documentId: doc.id, response: "ACCEPTED", contact: { source: "DELIVERY_CONTACT" }, respondedOn: TODAY, evidenceRef: "signed copy 12" } as never, [{ name: "signed.pdf", bytes: new TextEncoder().encode("%PDF-1.4 test evidence") }], TODAY);
});

beforeEach(() => {
  dbFactory.mockClear();
  vi.mocked(requireNewquipPocOrg).mockReset().mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockReset().mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockReset().mockResolvedValue(false);
});

describe("the REAL delivery and documents readers inside the bundle", () => {
  it("the fixture is what the tests claim: an approved quotation with an issued document, a send with response links, and a recorded response with evidence", async () => {
    asRoles("REP");
    const r = await actions.getQuotePageBundleAction(quoteId);
    expect(r.ok).toBe(true);
    expect(r.data?.quote.quote.state).toBe("MANAGER_APPROVED_FINAL");
    const d = r.data!.delivery!.data!;
    expect(d.available).toBe(true);
    expect(d.latestDocumentId).toBeTruthy();
    expect(d.sends.length).toBeGreaterThan(0);
    expect(d.responses.length).toBeGreaterThan(0);
    expect(d.responses[0].files.length).toBeGreaterThan(0);
    expect(r.data!.documents!.data!.documents.length).toBeGreaterThan(0);
    expect(tokens.length).toBeGreaterThan(0); // the emailed links exist, so the token scan below can fail
  });

  for (const [who, role, sees] of [["Rep", "REP", false], ["Estimator", "ESTIMATOR", true], ["Manager", "MANAGER", true]] as const) {
    it(`${who}: delivery and documents parts equal the single actions' results exactly (data and the canSend / canRecord / canReview / canIssue flags)`, async () => {
      asRoles(role);
      vi.mocked(canSeeCosts).mockResolvedValue(sees);
      const bundle = await actions.getQuotePageBundleAction(quoteId);
      const singleDelivery = await delivery.getQuoteDeliveryAction(quoteId);
      const singleDocs = await documents.getQuoteDocumentsAction(quoteId);
      expect(bundle.data!.delivery).toEqual({ ok: true, data: singleDelivery.data });
      expect(bundle.data!.documents).toEqual({ ok: true, data: singleDocs.data });
      const b = bundle.data!.delivery!.data!; const s = singleDelivery.data!;
      expect({ canSend: b.canSend, canRecord: b.canRecord, canReview: b.canReview, canIssue: bundle.data!.documents!.data!.canIssue })
        .toEqual({ canSend: s.canSend, canRecord: s.canRecord, canReview: s.canReview, canIssue: singleDocs.data!.canIssue });
    });

    it(`${who}: no cost, margin, supplier, markup, physical, freight, landed, FX or unit-cost key, and no link token, signed URL, storage path or secret, anywhere in the serialised delivery and documents parts`, async () => {
      asRoles(role);
      vi.mocked(canSeeCosts).mockResolvedValue(sees);
      const r = await actions.getQuotePageBundleAction(quoteId);
      const parts = JSON.parse(JSON.stringify({ delivery: r.data!.delivery, documents: r.data!.documents }));
      const keys = [...keysOf(parts)];
      expect(keys).toEqual(expect.arrayContaining(["sha256", "contentHash", "sends", "responses", "files", "links", "policy"])); // the scan reached the evidence file, document, send, response and link data (it is not scanning an empty shell)
      expect(keys.filter((k) => COST_KEY.test(k))).toEqual([]);
      expect(keys.filter((k) => SECRET_KEY.test(k))).toEqual([]);
      const text = JSON.stringify(parts);
      for (const t of tokens) expect(text).not.toContain(t); // an emailed response token never travels in a view
      expect(text).not.toMatch(/#t=|supabase\.co\/storage|signedUrl|signed_url|sb_secret|service_role|Bearer /i);
    });
  }

  it("the flags differ by role as the single actions say: an Estimator can neither send nor record nor review nor issue", async () => {
    asRoles("ESTIMATOR");
    vi.mocked(canSeeCosts).mockResolvedValue(true);
    const r = await actions.getQuotePageBundleAction(quoteId);
    const d = r.data!.delivery!.data!;
    expect([d.canSend, d.canRecord, d.canReview, r.data!.documents!.data!.canIssue]).toEqual([false, false, false, false]);
  });
});

describe("authorisation comes first: when it fails, nothing is read", () => {
  const QUOTE_TABLES = /^newquip_(quotes|quote_documents|quote_sends|quote_responses|quote_customers|response_evidence|response_links|response_reviews)$/;
  it("no database client is created when the organisation check or the module access rejects, and no quote, document, send, response or evidence table is read when the role resolution rejects", async () => {
    asRoles("REP");
    const from = vi.spyOn(db as any, "from");
    vi.mocked(requireNewquipPocOrg).mockRejectedValue(new Error("Not a NewQuip organisation."));
    expect((await actions.getQuotePageBundleAction(quoteId)).ok).toBe(false);
    expect(dbFactory).not.toHaveBeenCalled();

    vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("No access to Quotes."));
    expect((await actions.getQuotePageBundleAction(quoteId)).ok).toBe(false);
    expect(dbFactory).not.toHaveBeenCalled();

    vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
    vi.mocked(resolveRoles).mockRejectedValue(new Error("roles unavailable"));
    const r = await actions.getQuotePageBundleAction(quoteId);
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    // authorise() builds its own client for the role tables (the authorisation read itself); nothing about the quotation was read before it failed
    expect(from.mock.calls.map((c) => String(c[0])).filter((n) => QUOTE_TABLES.test(n))).toEqual([]);
    from.mockRestore();
  });

  it("positive control: the same spy DOES see the quotation tables on a successful call, so the empty result above is meaningful", async () => {
    asRoles("REP");
    const from = vi.spyOn(db as any, "from");
    expect((await actions.getQuotePageBundleAction(quoteId)).ok).toBe(true);
    expect(from.mock.calls.map((c) => String(c[0])).filter((n) => QUOTE_TABLES.test(n)).length).toBeGreaterThan(0);
    from.mockRestore();
  });
});
