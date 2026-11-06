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
let fwd = "198.51.100.9";
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": fwd }) }));
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
import { POST as uploadPost } from "@/app/api/newquip-quote-responses/route";
import { GET as evidenceGet } from "@/app/api/newquip-response-evidence/[id]/route";
import { GET as publicDocGet, POST as publicDocPost } from "@portal/app/api/quote-response/document/route";
import * as publicActions from "@portal/app/quote-response/actions";
import { resetRateLimits } from "@/lib/newquip-portal/rate-limit";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "p", deliveryInstallationConditions: "d", termsAndConditions: "t", acceptanceInstructions: "a" };
const as = (roles: string[], opts: { email?: string; demo?: boolean; admin?: boolean } = {}) => {
  const email = opts.email ?? "rep@x.co";
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-a", userId: "u1", email } as never);
  vi.mocked(resolveActing).mockResolvedValue({ orgId: "org-a", userId: "u1", email, tier: opts.demo ? "member" : null, demo: opts.demo ? { ownerUserId: "own", ownerEmail: "testing@sparkconsulting.co.za", actorName: "[DEMO] Rep", slot: "rep" } : null } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!opts.admin) throw new Error("no"); return undefined as never; });
  vi.mocked(resolveRoles).mockResolvedValue(new Set(roles) as never);
};
beforeEach(async () => {
  db = new FakeDb(); db.deliveryApplied = true; db.portalApplied = true; db.approvalsApplied = true; resetRateLimits(); fwd = "198.51.100.9"; vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.newquip.example"); vi.stubEnv("NEWQUIP_PUBLIC_PORTAL_URL", "https://portal.newquip.example"); vi.stubEnv("NEWQUIP_INTERNAL_APP_URL", "https://preview.newquip.example"); files.clear(); (db as unknown as { storage: unknown }).storage = { from: () => ({ download: async (p: string) => (files.has(p) ? { data: { arrayBuffer: async () => { const b = files.get(p)!; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } } } : { error: { message: "not found" } }) }) }; vi.mocked(sendEmail).mockClear(); vi.stubEnv("VERCEL_ENV", "preview");
  const draft = readyDraft(); draft.customerName = "Boerdery (Pty) Ltd";
  const { baseline, hash } = buildAcceptedBaseline({ quoteRef: "NQ-Q-0009", revision: 1, draft, evaluation: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false }), approvals: { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" } });
  db.rows("newquip_quotes").push({ id: "11111111-2222-3333-4444-555555555555", org_id: "org-a", quote_ref: "NQ-Q-0009", revision: 1, state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline, baseline_hash: hash, draft: {}, requires_customer_acceptance: true });
  db.rows("newquip_quote_customers").push({ id: "s1", org_id: "org-a", quote_id: "11111111-2222-3333-4444-555555555555", seq: 1, cin7_customer_id: "c1", snapshot: withChosenContact(buildCustomerSnapshot({ ID: "c1", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "Piet", Email: "piet@boerdery.example" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 }), snapshot_hash: "h", captured_by_email: "r" });
});


const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a, 7, 7, 7]);
const form = (fields: Record<string, string>, files: Array<{ name: string; bytes: Uint8Array; type?: string }> = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const x of files) f.append("files", new File([Buffer.from(x.bytes)], x.name, { type: x.type ?? "application/octet-stream" }));
  return new Request("http://x/api/newquip-quote-responses", { method: "POST", body: f });
};
/** FakeDb ids are not UUIDs; the routes (rightly) insist on UUID-shaped ids, so give the evidence rows real-looking ones. */
const uuidify = () => (db.rows("newquip_response_evidence") as Array<Record<string, string>>).forEach((r, i) => { if (!/^[0-9a-f-]{36}$/.test(r.id)) r.id = `aaaaaaaa-0000-4000-8000-${String(i + 1).padStart(12, "0")}`; });
const call = async (r: Request) => { const res = await uploadPost(r); return { status: res.status, body: (await res.json()) as Record<string, any> }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function issued() {
  as(["REP", "MANAGER"], { admin: true }); await documents.saveCompanyProfileAction(PROFILE);
  const r = await documents.issueQuoteDocumentAction("11111111-2222-3333-4444-555555555555");
  db.rows("approval_requests").push({ id: "req-1", org_id: "org-a", doc_type: "QUOTE", doc_id: "11111111-2222-3333-4444-555555555555", revision: 1, status: "APPROVED", prepared_by_email: "est@x", originator_email: "rep@x.co" });
  return r.data!.documentId;
}
const recordFields = (docId: string, over: Record<string, string> = {}) => ({ intent: "record", quoteId: "11111111-2222-3333-4444-555555555555", documentId: docId, response: "ACCEPTED", contact: JSON.stringify({ source: "DELIVERY_CONTACT" }), respondedOn: new Date().toISOString().slice(0, 10), evidenceRef: "signed copy", note: "", ...over });

describe("staff upload route: record a response with its contact and evidence", () => {
  it("a Rep records an acceptance with PDF evidence; the response, contact and file are stored; the view shows them and the download is an authenticated attachment", async () => {
    const docId = await issued(); as(["REP"]);
    const r = await call(form(recordFields(docId), [{ name: "signed.pdf", bytes: PDF }]));
    expect(r).toMatchObject({ status: 200, body: { ok: true, created: true } });
    uuidify();
    const view = (await delivery.getQuoteDeliveryAction("11111111-2222-3333-4444-555555555555")).data!;
    expect(view.status).toBe("CUSTOMER_ACCEPTED"); expect(view.accepted).toBe(true); expect(view.portal).toBe(true);
    expect(view.responses[0]).toMatchObject({ contact: "Piet", contactSource: "DELIVERY_CONTACT", origin: "STAFF", standing: "RECORDED" });
    expect(view.responses[0].files).toHaveLength(1);
    const dl = await evidenceGet(new Request("http://x"), { params: Promise.resolve({ id: view.responses[0].files[0].id }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="signed\.pdf"$/); expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("cache-control")).toBe("private, no-store"); expect(dl.headers.get("content-security-policy")).toBe("sandbox"); expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF);
  });
  it("an acceptance without evidence, an unsupported file, an oversized body and too many files are all refused and nothing is stored", async () => {
    const docId = await issued(); as(["REP"]);
    expect((await call(form(recordFields(docId)))).body.error).toMatch(/Attach the supporting evidence/);
    expect((await call(form(recordFields(docId), [{ name: "x.pdf", bytes: new TextEncoder().encode("MZ not a pdf") }]))).body.error).toMatch(/not a supported file/);
    expect((await call(form(recordFields(docId), Array.from({ length: 4 }, (_, i) => ({ name: `a${i}.pdf`, bytes: new Uint8Array([...PDF, i]) }))))).body.error).toMatch(/at most 3/);
    const huge = new Request("http://x", { method: "POST", headers: { "content-length": String(50 * 1024 * 1024) }, body: new FormData() });
    expect((await uploadPost(huge)).status).toBe(413);
    expect(db.rows("newquip_quote_responses")).toHaveLength(0); expect(db.rows("newquip_response_evidence")).toHaveLength(0);
  });
  it("only a Rep or Manager may record or attach; an Estimator-only or role-less user is refused; a signed-out caller gets 401", async () => {
    const docId = await issued();
    for (const roles of [["ESTIMATOR"], []]) { as(roles); expect((await call(form(recordFields(docId), [{ name: "s.pdf", bytes: PDF }]))).status).toBe(403); }
    vi.mocked(requireModuleAccess).mockRejectedValueOnce(new Error("no session"));
    expect((await call(form(recordFields(docId), [{ name: "s.pdf", bytes: PDF }]))).status).toBe(401);
    expect(db.rows("newquip_quote_responses")).toHaveLength(0);
  });
  it("another responding contact from the customer record, or an exception with a reason, is recorded with its source; an exception without a reason is refused", async () => {
    const docId = await issued(); as(["REP"]);
    expect((await call(form(recordFields(docId, { response: "DECLINED", contact: JSON.stringify({ source: "ALTERNATIVE", name: "Sarie Venter", reason: "" }) })))).body.error).toMatch(/reason/);
    const ok = await call(form(recordFields(docId, { response: "DECLINED", evidenceRef: "phone 29 Oct", contact: JSON.stringify({ source: "ALTERNATIVE", name: "Sarie Venter", email: "sarie@farm.example", reason: "Owner away" }) })));
    expect(ok.status).toBe(200);
    expect(db.rows("newquip_quote_responses")[0]).toMatchObject({ contact_name: "Sarie Venter", contact_source: "ALTERNATIVE", exception_reason: "Owner away", contact_email: "sarie@farm.example" });
  });
  it("evidence can be attached to an existing response (append-only), but not to another quotation's response, and it keeps the original files", async () => {
    const docId = await issued(); as(["REP"]);
    const rec = await call(form(recordFields(docId), [{ name: "a.pdf", bytes: PDF }]));
    const rid = rec.body.responseId as string;
    expect((await call(form({ intent: "attach", quoteId: "11111111-2222-3333-4444-555555555555", responseId: rid }, [{ name: "b.pdf", bytes: new Uint8Array([...PDF, 9]) }]))).status).toBe(200);
    expect(db.rows("newquip_response_evidence")).toHaveLength(2);
    expect((await call(form({ intent: "attach", quoteId: "11111111-2222-3333-4444-555555555555", responseId: "nope" }, [{ name: "b.pdf", bytes: new Uint8Array([...PDF, 8]) }]))).body.error).toMatch(/does not belong/);
    expect((await call(form({ intent: "attach", quoteId: "11111111-2222-3333-4444-555555555555", responseId: rid }))).body.error).toMatch(/at least one file/);
    expect(db.rows("newquip_response_evidence")).toHaveLength(2);
  });
  it("organisation isolation for evidence: another organisation cannot download it, and an Estimator-only member cannot enumerate files", async () => {
    const docId = await issued(); as(["REP"]);
    await call(form(recordFields(docId), [{ name: "a.pdf", bytes: PDF }]));
    uuidify();
    const id = (db.rows("newquip_response_evidence")[0] as Record<string, string>).id;
    db.rows("newquip_response_evidence")[0].org_id = "org-b";
    expect((await evidenceGet(new Request("http://x"), { params: Promise.resolve({ id }) })).status).toBe(404);
    db.rows("newquip_response_evidence")[0].org_id = "org-a";
    expect((await evidenceGet(new Request("http://x"), { params: Promise.resolve({ id: "../../etc/passwd" }) })).status).toBe(404);
    as([]); expect((await evidenceGet(new Request("http://x"), { params: Promise.resolve({ id }) })).status).toBe(403);
    vi.mocked(requireModuleAccess).mockRejectedValueOnce(new Error("no session"));
    expect((await evidenceGet(new Request("http://x"), { params: Promise.resolve({ id }) })).status).toBe(401);
  });
  it("Demo Mode: the effective user's role applies and the real owner is recorded", async () => {
    const docId = await issued();
    as(["ESTIMATOR"], { demo: true, email: "estimator@sparkconsulting.co.za" });
    expect((await call(form(recordFields(docId), [{ name: "a.pdf", bytes: PDF }]))).status).toBe(403);
    as(["REP"], { demo: true, email: "rep@sparkconsulting.co.za" });
    expect((await call(form(recordFields(docId), [{ name: "a.pdf", bytes: PDF }]))).status).toBe(200);
    expect(db.rows("newquip_quote_responses")[0]).toMatchObject({ recorded_by_email: "rep@sparkconsulting.co.za", recorded_by_owner_email: "testing@sparkconsulting.co.za" });
    expect(db.rows("newquip_response_evidence")[0]).toMatchObject({ uploaded_by_email: "rep@sparkconsulting.co.za", uploaded_by_owner_email: "testing@sparkconsulting.co.za" });
  });
});

describe("the public response routes and actions", () => {
  async function linked() {
    const docId = await issued(); as(["REP"]);
    const texts: string[] = [];
    const { sendQuotationToCustomer } = await import("@/lib/newquip-quotes/send-store");
    const { defaultDeps } = await import("@/lib/newquip-quotes/document-store");
    await sendQuotationToCustomer(db as never, "org-a", "11111111-2222-3333-4444-555555555555", { email: "rep@sparkconsulting.co.za" }, { documentId: docId, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-public-0001" }, defaultDeps(db as never), { VERCEL_ENV: "preview", NEXT_PUBLIC_SITE_URL: "https://preview.newquip.example", NEWQUIP_PUBLIC_PORTAL_URL: "https://portal.newquip.example" }, (async (i: { text: string }) => { texts.push(i.text); return { ok: true, messageId: "m" }; }) as never);
    return { docId, token: /#t=([A-Za-z0-9_.-]+)&a=accept/.exec(texts.join("\n"))![1] };
  }
  const post = (token: string) => { const f = new FormData(); f.set("token", token); return new Request("http://x/api/quote-response/document", { method: "POST", body: f }); };
  it("the PDF route: GET gives nothing (email scanners), POST with a valid token streams exactly the issued PDF with private headers, a bad token gets nothing", async () => {
    const { token, docId } = await linked();
    expect((await publicDocGet()).status).toBe(405);
    const ok = await publicDocPost(post(token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf"); expect(ok.headers.get("cache-control")).toBe("private, no-store"); expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    const bytes = Buffer.from(await ok.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.equals(Buffer.from(files.get((db.rows("newquip_quote_documents").find((d) => d.id === docId) as Record<string, string>).storage_path)!))).toBe(true);
    expect((await publicDocPost(post("garbage"))).status).toBe(404);
    expect((await publicDocPost(post(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")))).status).toBe(404);
    expect((await publicDocPost(new Request("http://x", { method: "POST", body: new FormData() }))).status).toBe(404);
    // expired / revoked links show nothing
    (db.rows("newquip_response_links")[0] as Record<string, unknown>).revoked_at = new Date().toISOString();
    expect((await publicDocPost(post(token))).status).toBe(404);
  });
  it("the public actions need no session: loading shows the quotation and records nothing; submitting records an acceptance for verification and creates no project or Cin7 Sale", async () => {
    const { token } = await linked();
    as([]); vi.mocked(requireModuleAccess).mockRejectedValue(new Error("no session"));
    const view = await publicActions.loadQuoteResponsePageAction(token);
    expect(view).toMatchObject({ ok: true, data: { revision: 1, customerName: "Boerdery (Pty) Ltd" } });
    expect(db.rows("newquip_quote_responses")).toHaveLength(0);
    const r = await publicActions.submitQuoteResponseAction({ token, action: "ACCEPTED", fullName: "Piet Pompies", company: "Boerdery", email: "piet@boerdery.example", authorityConfirmed: true, revisionConfirmed: true, revision: 1, reason: "" });
    expect(r.ok).toBe(true);
    expect(db.rows("newquip_quote_responses")).toHaveLength(1); expect(db.rows("projects")).toHaveLength(0);
    expect(db.rows("project_cin7_sale_links")).toHaveLength(0); expect(db.rows("project_cin7_sale_creations")).toHaveLength(0);
    expect(db.rows("activity_log").some((a) => (a as Record<string, string>).action === "newquip.customer_link_accepted")).toBe(true);
    expect(JSON.stringify(db.rows("activity_log"))).not.toContain("198.51.100.9");
    vi.mocked(requireModuleAccess).mockReset();
  });
  it("a hostile client is rate limited, and bad submissions are bounded by the per-link attempt counter", async () => {
    const { token } = await linked();
    const bad = { token, action: "ACCEPTED" as const, fullName: "", company: "", email: "", authorityConfirmed: false, revisionConfirmed: false, revision: 1, reason: "" };
    const results = [];
    for (let i = 0; i < 14; i++) results.push((await publicActions.submitQuoteResponseAction(bad)).ok === false ? ((await Promise.resolve()), "x") : "ok");
    const limited = await publicActions.submitQuoteResponseAction(bad);
    expect(limited).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    fwd = "198.51.100.77"; // a different client is not affected by the first one's limit
    expect((await publicActions.loadQuoteResponsePageAction(token)).ok).toBe(true);
    expect(db.rows("newquip_quote_responses")).toHaveLength(0);
  });
  it("hostile input cannot break the actions", async () => {
    const { token } = await linked();
    for (const t of ["", "x".repeat(10_000), "' or 1=1 --", null as never, undefined as never]) expect(await publicActions.loadQuoteResponsePageAction(t)).toMatchObject({ ok: false });
    expect(await publicActions.submitQuoteResponseAction(null as never)).toMatchObject({ ok: false });
    expect(await publicActions.submitQuoteResponseAction({ token, action: "ACCEPTED", fullName: "<script>", company: "x".repeat(5000), email: "a@b.co", authorityConfirmed: "yes" as never, revisionConfirmed: true, revision: 1, reason: "" })).toMatchObject({ ok: false });
  });
});

describe("staff review actions and the project gate", () => {
  async function pendingAcceptance() {
    const docId = await issued(); as(["REP"]);
    const { sendQuotationToCustomer } = await import("@/lib/newquip-quotes/send-store");
    const { defaultDeps } = await import("@/lib/newquip-quotes/document-store");
    const texts: string[] = [];
    await sendQuotationToCustomer(db as never, "org-a", "11111111-2222-3333-4444-555555555555", { email: "rep@sparkconsulting.co.za" }, { documentId: docId, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-review-0001" }, defaultDeps(db as never), { VERCEL_ENV: "preview", NEXT_PUBLIC_SITE_URL: "https://preview.newquip.example", NEWQUIP_PUBLIC_PORTAL_URL: "https://portal.newquip.example" }, (async (i: { text: string }) => { texts.push(i.text); return { ok: true, messageId: "m" }; }) as never);
    const token = /#t=([A-Za-z0-9_.-]+)&a=accept/.exec(texts.join("\n"))![1];
    await publicActions.submitQuoteResponseAction({ token, action: "ACCEPTED", fullName: "Piet Pompies", company: "Boerdery", email: "piet@boerdery.example", authorityConfirmed: true, revisionConfirmed: true, revision: 1, reason: "" });
    return { docId, rid: (db.rows("newquip_quote_responses")[0] as Record<string, string>).id };
  }
  it("the view shows the pending acceptance (respondent, company, authority) and the status; Stage 6 stays closed", async () => {
    await pendingAcceptance(); as(["REP"]);
    const v = (await delivery.getQuoteDeliveryAction("11111111-2222-3333-4444-555555555555")).data!;
    expect(v.status).toBe("ACCEPTANCE_PENDING_VERIFICATION"); expect(v.statusLabel).toMatch(/verification pending/); expect(v.accepted).toBe(false); expect(v.canReview).toBe(true);
    expect(v.responses[0]).toMatchObject({ origin: "CUSTOMER_LINK", standing: "PENDING_VERIFICATION", company: "Boerdery", contactEmail: "piet@boerdery.example", authorityConfirmed: true });
    expect(v.links.state).toBe("ACTIVE");
  });
  it("only a Rep or Manager can verify or reject; an Estimator-only user cannot; under Demo Mode the effective role applies and the real owner is recorded", async () => {
    const { rid } = await pendingAcceptance();
    as(["ESTIMATOR"]); expect((await delivery.reviewCustomerResponseAction("11111111-2222-3333-4444-555555555555", { responseId: rid, decision: "VERIFIED", note: "" })).error).toMatch(/Only a Rep or Manager/);
    as(["ESTIMATOR"], { demo: true, email: "estimator@sparkconsulting.co.za" }); expect((await delivery.reviewCustomerResponseAction("11111111-2222-3333-4444-555555555555", { responseId: rid, decision: "VERIFIED", note: "" })).ok).toBe(false);
    expect(db.rows("newquip_response_reviews")).toHaveLength(0);
    as(["REP"], { demo: true, email: "rep@sparkconsulting.co.za" });
    const ok = await delivery.reviewCustomerResponseAction("11111111-2222-3333-4444-555555555555", { responseId: rid, decision: "VERIFIED", note: "phoned" });
    expect(ok.data!.status).toBe("CUSTOMER_ACCEPTED");
    expect(db.rows("newquip_response_reviews")[0]).toMatchObject({ reviewed_by_email: "rep@sparkconsulting.co.za", reviewed_by_owner_email: "testing@sparkconsulting.co.za" });
    expect(db.rows("approval_notifications").some((n) => (n as Record<string, string>).kind === "CUSTOMER_VERIFIED")).toBe(true);
  });
  it("another organisation's quotation is 'not found' to review and to withdraw links", async () => {
    const { rid } = await pendingAcceptance();
    db.rows("newquip_quotes")[0].org_id = "org-b"; as(["REP", "MANAGER"], { admin: true });
    expect((await delivery.reviewCustomerResponseAction("11111111-2222-3333-4444-555555555555", { responseId: rid, decision: "VERIFIED", note: "" })).error).toMatch(/not found/i);
    expect((await delivery.revokeResponseLinksAction("11111111-2222-3333-4444-555555555555", "wrong recipient")).error).toMatch(/not found/i);
  });
  it("withdrawing the links needs a reason and a Rep/Manager; afterwards the link is REVOKED and the view says so", async () => {
    await pendingAcceptance();
    db.rows("newquip_quote_responses").length = 0; // back to "awaiting a response" to look at the link state
    as(["ESTIMATOR"]); expect((await delivery.revokeResponseLinksAction("11111111-2222-3333-4444-555555555555", "wrong recipient")).error).toMatch(/permission/);
    as(["REP"]); expect((await delivery.revokeResponseLinksAction("11111111-2222-3333-4444-555555555555", "")).error).toMatch(/reason/);
    const v = (await delivery.revokeResponseLinksAction("11111111-2222-3333-4444-555555555555", "wrong recipient")).data!;
    expect(v.links.state).toBe("REVOKED");
  });
});

describe("the public surface is exactly what was designed", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)).map((p) => `${e.name}/${p}`) : [e.name]));
  it("only the response page, its actions and the token-authenticated PDF route sit under the unauthenticated prefixes", () => {
    expect(walk(join(process.cwd(), "portal/app/quote-response")).sort()).toEqual(["__tests__/portal-isolation.test.tsx", "actions.ts", "page.tsx"]);
    expect(walk(join(process.cwd(), "portal/app/api/quote-response")).sort()).toEqual(["document/route.ts"]);
    const mw = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(mw).toMatch(/const PUBLIC_PATHS = \["\/login", "\/auth\/callback", "\/privacy", "\/signup"\];/); // the INTERNAL app serves no customer route
  });
  it("the public page never reads the token from the URL path or query, and no public module touches Cin7, projects or the costing code", () => {
    const page = readFileSync(join(process.cwd(), "portal/app/quote-response/page.tsx"), "utf8");
    expect(page).toContain("window.location.hash"); expect(page).not.toMatch(/useSearchParams|searchParams|useParams|location\.search/);
    for (const f of ["portal/app/quote-response/actions.ts", "portal/app/api/quote-response/document/route.ts", "src/lib/newquip-portal/store.ts"]) {
      const text = readFileSync(join(process.cwd(), f), "utf8");
      expect(text, f).not.toMatch(/from "@\/cin7|cin7Request|createProject|project_cin7|quotes\/margin|costOverrides|buildMarginSheet|latest-cost/);
    }
  });
});
