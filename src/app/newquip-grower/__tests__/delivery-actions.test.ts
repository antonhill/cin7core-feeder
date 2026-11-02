import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { resolveActing } from "@/lib/demo-mode/context";
import { resolveRoles } from "@/lib/approvals/role-store";
import { sendEmail } from "@/lib/email/resend";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";
import { buildCustomerSnapshot, withChosenContact } from "@/lib/newquip-quotes/customer-snapshot";

// The REAL document / delivery server actions and the download route over an in-memory database and storage. Only session, Demo Mode, roles, storage and the provider are replaced.
let db: FakeDb; const files = new Map<string, Uint8Array>();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn(async () => ({ orgId: "org-a" })) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn(async () => false) }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn() }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "msg-1" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));
vi.mock("@/lib/newquip-quotes/document-store", async (orig) => {
  const m = await orig<typeof import("@/lib/newquip-quotes/document-store")>();
  return { ...m, defaultDeps: () => ({ today: () => new Date().toISOString().slice(0, 10), render: m.defaultDeps({} as never).render, storage: { upload: async (p: string, b: Uint8Array) => { files.set(p, b); }, download: async (p: string) => files.get(p)!, remove: async (p: string) => { files.delete(p); } } }) };
});
import * as documents from "../document-actions";
import * as delivery from "../delivery-actions";
import * as customer from "../customer-actions";
import { GET as download } from "@/app/api/newquip-quote-documents/[id]/route";

const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "p", deliveryInstallationConditions: "d", termsAndConditions: "t", acceptanceInstructions: "a" };
const as = (roles: string[], opts: { email?: string; demo?: boolean; admin?: boolean } = {}) => {
  const email = opts.email ?? "rep@x.co";
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-a", userId: "u1", email } as never);
  vi.mocked(resolveActing).mockResolvedValue({ orgId: "org-a", userId: "u1", email, tier: opts.demo ? "member" : null, demo: opts.demo ? { ownerUserId: "own", ownerEmail: "testing@sparkconsulting.co.za", actorName: "[DEMO] Rep", slot: "rep" } : null } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!opts.admin) throw new Error("no"); return undefined as never; });
  vi.mocked(resolveRoles).mockResolvedValue(new Set(roles) as never);
};
beforeEach(async () => {
  db = new FakeDb(); db.deliveryApplied = true; files.clear(); vi.mocked(sendEmail).mockClear(); vi.stubEnv("VERCEL_ENV", "preview");
  const draft = readyDraft(); draft.customerName = "Boerdery (Pty) Ltd";
  const { baseline, hash } = buildAcceptedBaseline({ quoteRef: "NQ-Q-0009", revision: 1, draft, evaluation: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false }), approvals: { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" } });
  db.rows("newquip_quotes").push({ id: "q1", org_id: "org-a", quote_ref: "NQ-Q-0009", revision: 1, state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline, baseline_hash: hash, draft: {}, requires_customer_acceptance: true });
  db.rows("newquip_quote_customers").push({ id: "s1", org_id: "org-a", quote_id: "q1", seq: 1, cin7_customer_id: "c1", snapshot: withChosenContact(buildCustomerSnapshot({ ID: "c1", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "Piet", Email: "piet@boerdery.example" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 }), snapshot_hash: "h", captured_by_email: "r" });
});

describe("who may do what (server-side)", () => {
  it("company details: Manager only; the profile is versioned", async () => {
    as(["REP", "ESTIMATOR"]);
    expect((await documents.saveCompanyProfileAction(PROFILE)).error).toMatch(/Only a Manager/);
    as(["REP", "ESTIMATOR", "MANAGER"], { admin: true });
    expect((await documents.saveCompanyProfileAction(PROFILE)).data!.version).toBe(1);
    expect((await documents.saveCompanyProfileAction({ ...PROFILE, termsAndConditions: "" })).error).toMatch(/Terms and conditions/);
    expect(db.rows("newquip_company_profiles")).toHaveLength(1);
  });
  it("issuing needs Rep or Manager; an Estimator-only user cannot; nothing is generated", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE);
    as(["ESTIMATOR"]);
    expect((await documents.issueQuoteDocumentAction("q1")).error).toMatch(/permission to issue/);
    expect(files.size).toBe(0);
    as(["REP"]);
    const r = await documents.issueQuoteDocumentAction("q1");
    expect(r.ok).toBe(true); expect(files.size).toBe(1);
  });
  it("sending is an explicit REP action: Manager-only and Estimator-only callers are refused, and nothing is sent", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); const issued = await documents.issueQuoteDocumentAction("q1");
    for (const roles of [["MANAGER"], ["ESTIMATOR"]]) {
      as(roles, { admin: true });
      const r = await delivery.sendQuoteToCustomerAction("q1", { documentId: issued.data!.documentId, to: ["rep@sparkconsulting.co.za"], message: "", idempotencyKey: "key-aaaa-0001" });
      expect(r.error).toMatch(/Only a Rep/);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("a Rep sends in Preview: allowlisted recipient gets it, a real customer is suppressed; the view says ACCEPTED vs SUPPRESSED, sent status follows", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); const issued = await documents.issueQuoteDocumentAction("q1");
    as(["REP"]);
    const real = await delivery.sendQuoteToCustomerAction("q1", { documentId: issued.data!.documentId, to: ["piet@boerdery.example"], message: "", idempotencyKey: "key-aaaa-0001" });
    expect(real.data).toMatchObject({ status: "SUPPRESSED" }); expect(sendEmail).not.toHaveBeenCalled();
    expect(real.data!.view.status).toBe("APPROVED_INTERNALLY"); // a suppressed send is not "sent to customer"
    const ok = await delivery.sendQuoteToCustomerAction("q1", { documentId: issued.data!.documentId, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-aaaa-0002" });
    expect(ok.data).toMatchObject({ status: "ACCEPTED" }); expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(ok.data!.view.status).toBe("SENT_TO_CUSTOMER");
    expect(ok.data!.view.policy.restricted).toBe(true);
  });
  it("recording the customer's response needs Rep or Manager; an Estimator-only user cannot; acceptance flips the status", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); const issued = await documents.issueQuoteDocumentAction("q1");
    const input = { documentId: issued.data!.documentId, response: "ACCEPTED" as const, contactName: "Piet", respondedOn: new Date().toISOString().slice(0, 10), evidenceRef: "email 29 Oct" };
    as(["ESTIMATOR"]);
    expect((await delivery.recordCustomerResponseAction("q1", input)).error).toMatch(/permission to record/);
    as(["REP"]);
    const r = await delivery.recordCustomerResponseAction("q1", input);
    expect(r.data).toMatchObject({ status: "CUSTOMER_ACCEPTED", accepted: true, canSend: false });
  });
  it("DEMO MODE: the effective identity's role applies (a demo Estimator cannot send), and the real owner is recorded on a demo Rep's send", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); const issued = await documents.issueQuoteDocumentAction("q1");
    as(["ESTIMATOR"], { demo: true, email: "estimator@sparkconsulting.co.za" });
    expect((await delivery.sendQuoteToCustomerAction("q1", { documentId: issued.data!.documentId, to: ["rep@sparkconsulting.co.za"], message: "", idempotencyKey: "key-demo-0001" })).error).toMatch(/Only a Rep/);
    as(["REP"], { demo: true, email: "rep@sparkconsulting.co.za" });
    const r = await delivery.sendQuoteToCustomerAction("q1", { documentId: issued.data!.documentId, to: ["rep@sparkconsulting.co.za"], message: "", idempotencyKey: "key-demo-0002" });
    expect(r.ok).toBe(true);
    expect(db.rows("newquip_quote_sends")[0]).toMatchObject({ sent_by_email: "rep@sparkconsulting.co.za", sent_by_owner_email: "testing@sparkconsulting.co.za" });
  });
  it("organisation isolation: a quotation of another organisation is 'not found' to every action", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); await documents.issueQuoteDocumentAction("q1");
    db.rows("newquip_quotes")[0].org_id = "org-b";
    as(["REP", "MANAGER"], { admin: true });
    for (const r of [await documents.getQuoteDocumentsAction("q1"), await documents.issueQuoteDocumentAction("q1"), await delivery.getQuoteDeliveryAction("q1")]) expect(r.error).toMatch(/not found/i);
  });
});

const UUID = "11111111-2222-3333-4444-555555555555";
describe("authenticated download route", () => {
  const call = (id: string) => download(new Request("http://x/api"), { params: Promise.resolve({ id }) });
  it("streams the issued PDF with private no-store headers to an authorised member of the owning organisation, and re-verifies its hash", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); await documents.issueQuoteDocumentAction("q1");
    db.rows("newquip_quote_documents")[0].id = UUID; const issued = { data: { documentId: UUID } };
    const res = await call(issued.data!.documentId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf"); expect(res.headers.get("cache-control")).toBe("private, no-store"); expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const path = [...files.keys()][0]; files.set(path, new Uint8Array([1, 2, 3]));
    expect((await call(issued.data!.documentId)).status).toBe(404); // a corrupted file is never released
  });
  it("refuses an unauthenticated caller (401), a malformed id (404) and another organisation's document (404)", async () => {
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE); await documents.issueQuoteDocumentAction("q1");
    db.rows("newquip_quote_documents")[0].id = UUID; const issued = { data: { documentId: UUID } };
    vi.mocked(requireModuleAccess).mockRejectedValueOnce(new Error("no session"));
    expect((await call(issued.data!.documentId)).status).toBe(401);
    as(["REP"]);
    expect((await call("../../etc/passwd")).status).toBe(404);
    db.rows("newquip_quote_documents")[0].org_id = "org-b";
    expect((await call(issued.data!.documentId)).status).toBe(404);
  });
});

describe("the selected Cin7 contact is the recipient", () => {
  it("select first contact, switch to the second, reopen, approve, issue: the PDF is addressed to the second contact and the send dialog defaults to it; the email goes there; changes after approval are refused", async () => {
    // a Spark customer with two Cin7 contacts, still a draft with no contact chosen
    db.rows("newquip_quote_customers").length = 0;
    db.rows("newquip_quote_customers").push({ id: "s0", org_id: "org-a", quote_id: "q1", seq: 1, cin7_customer_id: "cs", snapshot_hash: "h", captured_by_email: "rep@x.co", reason: "Customer selected from Cin7",
      snapshot: buildCustomerSnapshot({ ID: "cs", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "AJ Mbulo", Email: "testing@sparkconsulting.co.za" }, { Name: "Anton Hill", Email: "anton@sparkconsulting.co.za" }] }, "t") });
    const quote = db.rows("newquip_quotes")[0]; const approved = { ...quote }; quote.state = "REP_DRAFT";
    as(["REP"]);
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 })).data!.snapshot!.chosenContact!.email).toBe("testing@sparkconsulting.co.za");
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 1 })).data!.snapshot!.chosenContact!.email).toBe("anton@sparkconsulting.co.za");
    expect((await customer.getQuoteCustomerAction("q1")).data!.snapshot!.chosenContact!.name).toBe("Anton Hill"); // reopened
    Object.assign(quote, approved); // Manager approval (frozen baseline)
    as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE);
    const issued = await documents.issueQuoteDocumentAction("q1");
    expect(issued.error).toBeUndefined();
    as(["REP"]);
    const view = (await delivery.getQuoteDeliveryAction("q1")).data!;
    expect(view.defaultTo).toBe("anton@sparkconsulting.co.za");
    expect(view.contactEmails).toEqual(expect.arrayContaining(["testing@sparkconsulting.co.za", "anton@sparkconsulting.co.za"]));
    const sent = await delivery.sendQuoteToCustomerAction("q1", { documentId: issued.data!.documentId, to: [view.defaultTo!], message: "", idempotencyKey: "key-contact-0001" });
    expect(sent.ok).toBe(true);
    expect(vi.mocked(sendEmail).mock.calls.at(-1)![0]).toMatchObject({ to: ["anton@sparkconsulting.co.za"] });
    expect(db.rows("newquip_quote_sends")[0].to_emails).toEqual(["anton@sparkconsulting.co.za"]);
    // no contact change once approved
    expect((await customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 })).error).toMatch(/immutable/);
    expect((await delivery.getQuoteDeliveryAction("q1")).data!.defaultTo).toBe("anton@sparkconsulting.co.za");
  });
});
