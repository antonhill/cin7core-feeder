import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { POC_SIX_STAGE_SCHEDULE, NEWQUIP_STANDARD_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { createQuote, createProjectFromAcceptedQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import { buildCustomerSnapshot, withChosenContact } from "../customer-snapshot";
import { appendSnapshot } from "../customer-store";
import { issueQuotationDocument, saveProfile, type DocumentDeps } from "../document-store";
import { renderCustomerPdf } from "../customer-pdf";
import { sendQuotationToCustomer } from "../send-store";
import { listLinks, newToken, parseToken, resolveLink, revokeActiveLinks, MAX_LINK_ATTEMPTS } from "../response-links";
import { loadPublicQuotation, submitPublicResponse, type PublicSubmit } from "../customer-response";
import { recordStaffResponse } from "../response-record";
import { countsAsAcceptance, listReviews, reviewResponse } from "../acceptance";
import { internalTokenSet } from "../customer-document";
import { allow, resetRateLimits } from "../rate-limit";
import { sendEmail } from "@/lib/email/resend";
import { commercialStatus, listResponses, recordCustomerResponse, requireAcceptance, type ResponseInput } from "../acceptance";
import { listDocuments } from "../document-store";
import { listSends } from "../send-store";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "msg-n" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));

const ORG = "org-newquip"; const rep = rolesFor("member"); const mgr = rolesFor("admin"); const ctx = { priceSource: testPriceSource(), withholdCost: true };
const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "p", deliveryInstallationConditions: "d", termsAndConditions: "t", acceptanceInstructions: "a" };
const TODAY = "2026-10-29";
const PREVIEW = { VERCEL_ENV: "preview", NEXT_PUBLIC_SITE_URL: "https://preview.newquip.example" };

async function world(opts: { gated: boolean; portal?: boolean }) {
  const db = new FakeDb(); db.deliveryApplied = true; db.portalApplied = opts.portal ?? true; db.approvalsApplied = true; db.notificationStatuses = ["PENDING", "SENT", "FAILED", "ABANDONED", "SUPPRESSED"];
  const files = new Map<string, Uint8Array>();
  const deps: DocumentDeps = { today: () => TODAY, render: renderCustomerPdf, storage: { upload: async (p, b) => { files.set(p, b); }, download: async (p) => files.get(p)!, remove: async (p) => { files.delete(p); } } };
  const draft = readyDraft(); draft.customerName = "Boerdery (Pty) Ltd"; draft.siteName = "Paarl";
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  (db.rows("newquip_quotes")[0] as Record<string, unknown>).requires_customer_acceptance = opts.gated; // the database default after 0115 for new rows
  await saveDraft(db as never, ORG, rep, id, draft);
  const snap = withChosenContact(buildCustomerSnapshot({ ID: "cin7-cust-42", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "Piet", Email: "piet@boerdery.example" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 });
  await appendSnapshot(db as never, ORG, id, snap, { email: "rep@nq" }, "test");
  await saveProfile(db as never, ORG, PROFILE, "m@nq");
  const total = Math.round(evaluateDraft(draft, ctx).budget!.totals.subtotalExTax * 100);
  await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
  await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
  await managerApprove(db as never, ORG, mgr, "manager@nq", id, ctx);
  return { db, deps, id, files, total };
}
const issue = (w: Awaited<ReturnType<typeof world>>) => issueQuotationDocument(w.db as never, ORG, w.id, { email: "mgr@nq" }, NEWQUIP_STANDARD_SCHEDULE, w.deps);
const project = (w: Awaited<ReturnType<typeof world>>) => createProjectFromAcceptedQuote(w.db as never, ORG, "m@nq", w.id, POC_SIX_STAGE_SCHEDULE);
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };


const IP = "203.0.113.7";
type W = Awaited<ReturnType<typeof world>>;
/** Sends the issued quotation to an allowlisted Spark mailbox as `repEmail`, capturing the email; returns the three emailed response tokens (read from the URL FRAGMENT). */
async function sendWithLinks(w: W, docId: string, over: { repEmail?: string; to?: string[]; key?: string } = {}) {
  const captured: string[] = [];
  const fn = vi.fn(async (i: { text: string }) => { captured.push(i.text); return { ok: true, messageId: "m-" + captured.length }; });
  const r = await sendQuotationToCustomer(w.db as never, ORG, w.id, { email: over.repEmail ?? "rep@sparkconsulting.co.za" }, { documentId: docId, to: over.to ?? ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: over.key ?? "key-send-portal-1" }, w.deps, PREVIEW, fn as never);
  const text = captured.join("\n");
  const tokens = [...text.matchAll(/#t=([A-Za-z0-9_.-]+)&a=(accept|decline|changes)/g)].map((m) => ({ token: m[1], action: m[2] }));
  return { send: r.send, text, tokens, token: tokens[0]?.token ?? "" };
}
const accept = (token: string, over: Partial<PublicSubmit> = {}): PublicSubmit => ({ token, action: "ACCEPTED", fullName: "Piet Pompies", company: "Boerdery (Pty) Ltd", email: "piet@boerdery.example", authorityConfirmed: true, revisionConfirmed: true, revision: 1, reason: "", ...over });
const submit = (w: W, input: PublicSubmit, now = new Date()) => submitPublicResponse(w.db as never, input, { ip: IP, env: PREVIEW, now, baseEnv: PREVIEW });
async function ready(opts: { portal?: boolean } = {}) {
  const w = await world({ gated: true, portal: opts.portal });
  const { document: doc } = await issue(w);
  w.db.rows("approval_requests").push({ id: "req-1", org_id: ORG, doc_type: "QUOTE", doc_id: w.id, revision: 1, status: "APPROVED", prepared_by_email: "est@nq", originator_email: "rep@nq" });
  return { w, doc };
}
const notes = (w: W, channel: string) => (w.db.rows("approval_notifications") as Array<Record<string, any>>).filter((n) => n.channel === channel); // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => { vi.stubEnv("VERCEL_ENV", "preview"); vi.mocked(sendEmail).mockClear(); resetRateLimits(); });

describe("the emailed response links", () => {
  it("the send email carries Accept / Decline / Request-changes links whose token is in the URL FRAGMENT (never in the path or query), stored only as a hash", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    expect(s.tokens.map((t) => t.action)).toEqual(["accept", "decline", "changes"]);
    expect(new Set(s.tokens.map((t) => t.token)).size).toBe(1); // one link, three entry points
    expect(s.text).toMatch(/https:\/\/preview\.newquip\.example\/quote-response#t=/);
    expect(s.text).not.toMatch(/quote-response\?|quote-response\/[A-Za-z0-9]/); // not in the path or query string
    const [link] = await listLinks(w.db as never, ORG, w.id);
    expect(link.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(w.db.rows("newquip_response_links"))).not.toContain(s.token.split(".")[1]); // the secret itself is nowhere in the database
    expect(link).toMatchObject({ quote_id: w.id, document_id: doc.id, document_hash: doc.content_hash, baseline_hash: doc.baseline_hash, revision: 1, environment: "preview", customer_name: "Boerdery (Pty) Ltd", recipients: ["anton@sparkconsulting.co.za"], allowed_actions: ["ACCEPTED", "DECLINED", "CHANGES_REQUESTED"], created_by_email: "rep@sparkconsulting.co.za" });
    const ttl = new Date(link.expires_at).getTime() - Date.now(); expect(ttl).toBeGreaterThan(13 * 86_400_000); expect(ttl).toBeLessThanOrEqual(14 * 86_400_000 + 5000); // default 14 days
    expect(s.text).toContain("PREVIEW"); // the Preview banner on the body (the subject carries [PREVIEW])
  });
  it("the token is long, random and strictly parsed", () => {
    const a = newToken(); const b = newToken();
    expect(a.token).not.toBe(b.token); expect(a.secret.length).toBe(43);
    expect(parseToken(a.token)).toEqual({ id: a.id, secret: a.secret });
    for (const bad of ["", "x", `${a.id}.short`, `${a.id}x${a.secret}`, `${a.token}A`, `../${a.token}`, `${a.id}.${"!".repeat(43)}`]) expect(parseToken(bad), bad).toBeNull();
  });
  it("Preview recipient restrictions: an address outside the five Spark mailboxes gets NO email and NO link is issued", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id, { to: ["someone@customer-farm.co.za"] });
    expect(s.send.status).toBe("SUPPRESSED"); expect(s.tokens).toHaveLength(0);
    expect(await listLinks(w.db as never, ORG, w.id)).toHaveLength(0);
  });
  it("without migration 0117 the email carries NO links (fail closed) and the send still works", async () => {
    const { w, doc } = await ready({ portal: false });
    const s = await sendWithLinks(w, doc.id);
    expect(s.send.status).toBe("ACCEPTED"); expect(s.tokens).toHaveLength(0); expect(s.text).not.toContain("quote-response");
  });
  it("with no https site address the email carries no links either", async () => {
    const { w, doc } = await ready();
    const captured: string[] = [];
    await sendQuotationToCustomer(w.db as never, ORG, w.id, { email: "rep@sparkconsulting.co.za" }, { documentId: doc.id, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-no-site-1" }, w.deps, { VERCEL_ENV: "preview" }, (async (i: { text: string }) => { captured.push(i.text); return { ok: true, messageId: "m" }; }) as never);
    expect(captured.join("")).not.toContain("quote-response");
  });
  it("sending again issues a NEW link and withdraws the earlier one", async () => {
    const { w, doc } = await ready();
    const first = await sendWithLinks(w, doc.id);
    const again = await sendQuotationToCustomer(w.db as never, ORG, w.id, { email: "rep@sparkconsulting.co.za" }, { documentId: doc.id, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-send-portal-2", resendOfId: first.send.id, resendReason: "customer lost it" }, w.deps, PREVIEW, (async () => ({ ok: true, messageId: "m2" })) as never);
    expect(again.send.id).not.toBe(first.send.id);
    const links = await listLinks(w.db as never, ORG, w.id);
    expect(links).toHaveLength(2);
    expect(links.filter((l) => !l.revoked_at)).toHaveLength(1);
    expect((await resolveLink(w.db as never, first.token, PREVIEW)).ok).toBe(false);
    expect(links.find((l) => l.revoked_at)!.revoked_reason).toMatch(/Superseded/);
  });
});

describe("what a token allows: validation at view time and at submission", () => {
  it("a valid token shows ONLY the customer-facing quotation (no SKU, supplier, cost or margin data) and records NOTHING (GET / scanner safe)", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    const before = JSON.stringify([w.db.rows("newquip_quote_responses"), w.db.rows("newquip_response_links")]);
    for (let i = 0; i < 3; i++) { // an email scanner / link previewer loading the page repeatedly
      const v = await loadPublicQuotation(w.db as never, s.token, PREVIEW);
      expect(v.ok).toBe(true);
    }
    expect(JSON.stringify([w.db.rows("newquip_quote_responses"), w.db.rows("newquip_response_links")])).toBe(before);
    const v = await loadPublicQuotation(w.db as never, s.token, PREVIEW);
    if (!v.ok) throw new Error("view failed");
    expect(v.data).toMatchObject({ quoteRef: doc.quote_ref, revision: 1, customerName: "Boerdery (Pty) Ltd", currency: "ZAR", totalIncVat: doc.content.totals.totalIncVat });
    const set = internalTokenSet((await loadQuote(w.db as never, ORG, w.id))!.accepted_baseline!);
    const shown = JSON.stringify(v.data).toLowerCase();
    for (const t of [...set.ids, ...set.people, ...set.notes]) expect(shown.includes(t.toLowerCase()), "leaked " + t).toBe(false);
    expect(shown).not.toMatch(/margin|supplier|landed|exchange rate|internalmargin|physical/);
    expect(JSON.stringify(Object.keys(v.data))).not.toMatch(/baseline|cost|margin|approval/i);
  });
  it("EXPIRED, REVOKED, WRONG ENVIRONMENT and malformed tokens are refused with a clear message", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    const late = new Date(Date.now() + 15 * 86_400_000);
    const exp = await resolveLink(w.db as never, s.token, PREVIEW, late);
    expect(exp).toMatchObject({ ok: false, reason: "EXPIRED" });
    expect((await submit(w, accept(s.token), late))).toMatchObject({ ok: false, reason: "EXPIRED" });
    expect(await resolveLink(w.db as never, s.token, { VERCEL_ENV: "production" })).toMatchObject({ ok: false, reason: "INVALID" }); // a Preview link means nothing in Production
    expect(await resolveLink(w.db as never, "garbage", PREVIEW)).toMatchObject({ ok: false, reason: "INVALID" });
    expect(await resolveLink(w.db as never, `${newToken().token}`, PREVIEW)).toMatchObject({ ok: false, reason: "INVALID" }); // well-formed but unknown
    await revokeActiveLinks(w.db as never, ORG, w.id, "wrong recipient");
    expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "REVOKED" });
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
  });
  it("a token cannot be bent to another quotation or document, and a SUPERSEDED document or revision is refused", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    const link = w.db.rows("newquip_response_links")[0] as Record<string, unknown>;
    const keep = { ...link };
    link.quote_id = "another-quote"; expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "SUPERSEDED" }); Object.assign(link, keep);
    link.document_id = "another-document"; expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "SUPERSEDED" }); Object.assign(link, keep);
    link.document_hash = "f".repeat(64); expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "SUPERSEDED" }); Object.assign(link, keep);
    expect((await resolveLink(w.db as never, s.token, PREVIEW)).ok).toBe(true);
    // a newer issued version supersedes it
    w.db.rows("newquip_quote_documents").push({ ...(w.db.rows("newquip_quote_documents")[0] as Record<string, unknown>), id: "doc-v2", version: 2, storage_path: "p/v2.pdf", content_hash: "e".repeat(64), created_at: "2099-01-01T00:00:00Z" });
    expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "SUPERSEDED" });
    w.db.rows("newquip_quote_documents").pop();
    // a revised quotation (new revision) supersedes it too
    (w.db.rows("newquip_quotes")[0] as Record<string, unknown>).revision = 2;
    expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "SUPERSEDED" });
    expect(await submit(w, accept(s.token))).toMatchObject({ ok: false, reason: "SUPERSEDED" });
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
  });
  it("a wrong secret against a real link counts toward its lock-out; at the limit the link is LOCKED even for the right token", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    const id = s.token.split(".")[0];
    for (let i = 0; i < MAX_LINK_ATTEMPTS; i++) await resolveLink(w.db as never, `${id}.${"A".repeat(43)}`, PREVIEW);
    expect((w.db.rows("newquip_response_links")[0] as Record<string, unknown>).attempts).toBe(MAX_LINK_ATTEMPTS);
    expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "LOCKED" });
  });
  it("the in-memory limiter is bounded per key and window", () => {
    resetRateLimits();
    expect([1, 2, 3].map(() => allow("k", 2, 1000, 1000))).toEqual([true, true, false]);
    expect(allow("k", 2, 1000, 2500)).toBe(true); // the window moved on
    for (let i = 0; i < 6000; i++) allow(`flood-${i}`, 1, 60_000, 5000);
    expect(allow("flood-0", 1, 60_000, 5001)).toBeTypeOf("boolean"); // no unbounded growth, no crash
  });
});

describe("recording a customer response from the link", () => {
  it("ACCEPT needs the respondent's details, an authority confirmation and an explicit acceptance of the revision; each missing piece is refused and counts as an attempt", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    for (const bad of [{ authorityConfirmed: false }, { revisionConfirmed: false }, { revision: 2 }, { fullName: "P" }, { company: "" }, { email: "nope" }, { action: "SIGN" as never }]) {
      const r = await submit(w, accept(s.token, bad));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
    expect((w.db.rows("newquip_response_links")[0] as Record<string, unknown>).attempts).toBe(7);
  });
  it("a valid acceptance is recorded as PENDING VERIFICATION: it names the person, company and email, binds to the exact document hash, and does NOT satisfy the project gate", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    const r = await submit(w, accept(s.token));
    expect(r).toMatchObject({ ok: true, data: { action: "ACCEPTED", quoteRef: doc.quote_ref } });
    const [row] = w.db.rows("newquip_quote_responses") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(row).toMatchObject({ response: "ACCEPTED", origin: "CUSTOMER_LINK", contact_name: "Piet Pompies", contact_email: "piet@boerdery.example", contact_company: "Boerdery (Pty) Ltd", contact_source: "CUSTOMER_PROVIDED", authority_confirmed: true, document_hash: doc.content_hash, document_id: doc.id, recorded_by_email: "piet@boerdery.example" });
    expect(row.origin_hint).toMatch(/^[0-9a-f]{12}$/); expect(JSON.stringify(row)).not.toContain(IP); // pseudonymous: no raw IP address is stored
    const q = (await loadQuote(w.db as never, ORG, w.id))!;
    const docs = await listDocuments(w.db as never, ORG, w.id);
    const status = commercialStatus(q, docs[0], await listSends(w.db as never, ORG, w.id), await listResponses(w.db as never, ORG, w.id), await listReviews(w.db as never, ORG, w.id));
    expect(status).toBe("ACCEPTANCE_PENDING_VERIFICATION");
    expect(await err(requireAcceptance(w.db as never, ORG, q))).toMatch(/awaiting internal verification/);
    expect(await err(project(w))).toMatch(/awaiting internal verification/);
    expect(w.db.rows("projects")).toHaveLength(0);
    expect(w.db.rows("project_cin7_sale_links")).toHaveLength(0); expect(w.db.rows("project_cin7_sale_creations")).toHaveLength(0);
  });
  it("DECLINE and REQUEST CHANGES need a reason; they are recorded, are informational (no verification), and never open the gate", async () => {
    for (const action of ["DECLINED", "CHANGES_REQUESTED"] as const) {
      const { w, doc } = await ready();
      const s = await sendWithLinks(w, doc.id);
      expect((await submit(w, accept(s.token, { action, authorityConfirmed: false, revisionConfirmed: false, reason: "" }))).ok).toBe(false);
      expect((await submit(w, accept(s.token, { action, authorityConfirmed: false, revisionConfirmed: false, reason: "too dear" }))).ok).toBe(true);
      const q = (await loadQuote(w.db as never, ORG, w.id))!;
      const st = commercialStatus(q, (await listDocuments(w.db as never, ORG, w.id))[0], [], await listResponses(w.db as never, ORG, w.id), []);
      expect(st).toBe(action === "DECLINED" ? "CUSTOMER_DECLINED" : "CHANGES_REQUESTED");
      expect(await err(project(w))).toMatch(/not accepted this quotation yet/);
    }
  });
  it("a token is ONE-SHOT: a second submission (also a conflicting one, or two at once) is refused and creates no second response", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    const both = await Promise.all([submit(w, accept(s.token)), submit(w, accept(s.token, { action: "DECLINED", reason: "changed my mind", authorityConfirmed: false, revisionConfirmed: false }))]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(1);
    expect(await submit(w, accept(s.token, { action: "DECLINED", reason: "changed my mind" }))).toMatchObject({ ok: false });
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(1);
    expect((await loadPublicQuotation(w.db as never, s.token, PREVIEW))).toMatchObject({ ok: false });
  });
  it("a link that already carries a response says USED (not a vague failure), for a decline as well as an acceptance", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    expect((await submit(w, accept(s.token, { action: "DECLINED", reason: "no thanks", authorityConfirmed: false, revisionConfirmed: false }))).ok).toBe(true);
    expect(await resolveLink(w.db as never, s.token, PREVIEW)).toMatchObject({ ok: false, reason: "USED" });
    expect(await submit(w, accept(s.token))).toMatchObject({ ok: false, reason: "USED" });
  });
  it("a later link cannot be used while an earlier acceptance awaits verification, nor once the quotation is formally accepted", async () => {
    const { w, doc } = await ready();
    const s1 = await sendWithLinks(w, doc.id);
    await submit(w, accept(s1.token));
    let text2 = "";
    await sendQuotationToCustomer(w.db as never, ORG, w.id, { email: "rep@sparkconsulting.co.za" }, { documentId: doc.id, to: ["anton@sparkconsulting.co.za"], message: "", idempotencyKey: "key-send-portal-9", resendOfId: s1.send.id, resendReason: "again" }, w.deps, PREVIEW, (async (i: { text: string }) => { text2 = i.text; return { ok: true, messageId: "mm" }; }) as never);
    const token2 = /#t=([A-Za-z0-9_.-]+)&a=accept/.exec(text2)![1];
    expect(await resolveLink(w.db as never, token2, PREVIEW)).toMatchObject({ ok: false, reason: "PENDING_VERIFICATION" });
    expect(await submit(w, accept(token2, { fullName: "Someone Else" }))).toMatchObject({ ok: false, reason: "PENDING_VERIFICATION" });
    const resp = (await listResponses(w.db as never, ORG, w.id))[0];
    await reviewResponse(w.db as never, ORG, w.id, { email: "mgr@nq" }, { responseId: resp.id, decision: "VERIFIED", note: "" });
    expect(await resolveLink(w.db as never, token2, PREVIEW)).toMatchObject({ ok: false, reason: "ALREADY_ACCEPTED" });
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(1);
  });
});

describe("internal verification of an emailed acceptance", () => {
  const accepted = async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    await submit(w, accept(s.token));
    const resp = (await listResponses(w.db as never, ORG, w.id))[0];
    return { w, doc, s, resp };
  };
  it("VERIFIED makes it the formal acceptance of the exact document: the gate opens and the Project is created from it (still by an explicit action)", async () => {
    const { w, doc, resp } = await accepted();
    const r = await reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq", ownerEmail: "own@x.co" }, { responseId: resp.id, decision: "VERIFIED", note: "phoned Piet on 011 555 0100" });
    expect(r.created).toBe(true);
    expect(w.db.rows("newquip_response_reviews")[0]).toMatchObject({ decision: "VERIFIED", reviewed_by_email: "rep@nq", reviewed_by_owner_email: "own@x.co" });
    const q = (await loadQuote(w.db as never, ORG, w.id))!;
    expect(commercialStatus(q, doc, [], await listResponses(w.db as never, ORG, w.id), await listReviews(w.db as never, ORG, w.id))).toBe("CUSTOMER_ACCEPTED");
    expect(w.db.rows("projects")).toHaveLength(0); // verification itself creates nothing
    const made = await project(w);
    expect(made.created).toBe(true);
    expect(w.db.rows("project_cin7_sale_links")).toHaveLength(0); expect(w.db.rows("project_cin7_sale_creations")).toHaveLength(0);
  });
  it("REJECTED needs a reason and keeps the gate shut; the decision is final and cannot be flipped", async () => {
    const { w, resp } = await accepted();
    expect(await err(reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: resp.id, decision: "REJECTED", note: "" }))).toMatch(/reason/);
    await reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: resp.id, decision: "REJECTED", note: "signatory is not a director" });
    expect(await err(project(w))).toMatch(/rejected on verification/);
    expect(await err(reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: resp.id, decision: "VERIFIED", note: "" }))).toMatch(/already rejected/);
    const same = await reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: resp.id, decision: "REJECTED", note: "signatory is not a director" });
    expect(same.created).toBe(false); expect(w.db.rows("newquip_response_reviews")).toHaveLength(1);
    expect(w.db.rows("projects")).toHaveLength(0);
  });
  it("only an emailed ACCEPTANCE is reviewed; a staff-recorded response, another quotation's response or a stale document cannot be verified into force", async () => {
    const { w, doc, resp } = await accepted();
    expect(await err(reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: "nope", decision: "VERIFIED", note: "" }))).toMatch(/does not belong/);
    (w.db.rows("newquip_quote_responses")[0] as Record<string, unknown>).origin = "STAFF";
    expect(await err(reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: resp.id, decision: "VERIFIED", note: "" }))).toMatch(/emailed link/);
    (w.db.rows("newquip_quote_responses")[0] as Record<string, unknown>).origin = "CUSTOMER_LINK";
    w.db.rows("newquip_quote_documents").push({ ...(w.db.rows("newquip_quote_documents")[0] as Record<string, unknown>), id: "doc-v2", version: 2, storage_path: "p/v2.pdf", content_hash: "e".repeat(64), created_at: "2099-01-01T00:00:00Z" });
    expect(await err(reviewResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { responseId: resp.id, decision: "VERIFIED", note: "" }))).toMatch(/earlier version/);
    void doc;
  });
  it("another organisation cannot review it", async () => {
    const { w, resp } = await accepted();
    expect(await err(reviewResponse(w.db as never, "org-other", w.id, { email: "rep@x" }, { responseId: resp.id, decision: "VERIFIED", note: "" }))).toMatch(/not found/i);
    expect(w.db.rows("newquip_response_reviews")).toHaveLength(0);
  });
});

describe("staff-recorded responses: responding contact and evidence", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4]);
  const rec = (w: W, docId: string, over: Record<string, unknown> = {}, files = [{ name: "signed.pdf", bytes: PDF }]) =>
    recordStaffResponse(w.db as never, w.deps.storage, ORG, w.id, { email: "rep@nq", ownerEmail: "own@x.co" }, { documentId: docId, response: "ACCEPTED", contact: { source: "DELIVERY_CONTACT" }, respondedOn: TODAY, evidenceRef: "signed copy 12", ...over } as never, files, TODAY);
  it("an acceptance with evidence defaults to the contact who received the quotation, is stored privately with its hash, and opens the gate", async () => {
    const { w, doc } = await ready();
    const r = await rec(w, doc.id);
    expect(r.response).toMatchObject({ contact_name: "Piet", contact_email: "piet@boerdery.example", contact_source: "DELIVERY_CONTACT", origin: "STAFF", document_hash: doc.content_hash, recorded_by_email: "rep@nq", recorded_by_owner_email: "own@x.co" });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].storage_path).toMatch(new RegExp(`^${ORG}/evidence/${w.id}/${r.response.id}/[0-9a-f-]{36}\\.pdf$`));
    expect((await project(w)).created).toBe(true);
  });
  it("an acceptance WITHOUT evidence files is refused (migration 0117 applied); a decline needs none", async () => {
    const { w, doc } = await ready();
    expect(await err(rec(w, doc.id, {}, []))).toMatch(/Attach the supporting evidence/);
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
    expect((await rec(w, doc.id, { response: "DECLINED", evidenceRef: "phone call" }, [])).created).toBe(true);
  });
  it("an acceptance whose evidence is missing does not count (e.g. a failed upload): the gate stays shut until evidence is attached", async () => {
    const { w, doc } = await ready();
    const r = await rec(w, doc.id);
    w.db.rows("newquip_response_evidence").length = 0; // simulate a response whose evidence registration did not happen
    const q = (await loadQuote(w.db as never, ORG, w.id))!;
    expect(await err(requireAcceptance(w.db as never, ORG, q))).toMatch(/no supporting evidence/);
    expect(countsAsAcceptance(r.response, [], new Map())).toBe(false);
  });
  it("another Cin7 contact can respond; an alternative contact needs a reason; a bad file type is refused and nothing is recorded", async () => {
    const { w, doc } = await ready();
    expect(await err(rec(w, doc.id, { contact: { source: "ALTERNATIVE", name: "Sarie", reason: "" } }))).toMatch(/reason/);
    expect(await err(rec(w, doc.id, {}, [{ name: "malware.pdf", bytes: new TextEncoder().encode("MZ......") }]))).toMatch(/not a supported file/);
    expect(await err(rec(w, doc.id, { contact: { source: "CIN7_CONTACT", contactIndex: 5 } }))).toMatch(/not on the customer/);
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
    const r = await rec(w, doc.id, { contact: { source: "ALTERNATIVE", name: "Sarie Venter", email: "sarie@boerdery.example", reason: "Owner was away" } });
    expect(r.response).toMatchObject({ contact_name: "Sarie Venter", contact_source: "ALTERNATIVE", exception_reason: "Owner was away" });
  });
  it("evidence is organisation-isolated, append-only, and never overwrites the issued PDF", async () => {
    const { w, doc } = await ready();
    const r = await rec(w, doc.id);
    const issuedPath = doc.storage_path; const issuedBytes = new Uint8Array(w.files.get(issuedPath)!);
    expect(r.evidence[0].storage_path).not.toBe(issuedPath);
    expect(new Uint8Array(w.files.get(issuedPath)!)).toEqual(issuedBytes);
    const upd = (await w.db.from("newquip_response_evidence").update({ file_name: "x" }).eq("id", r.evidence[0].id)) as unknown as { error?: { message: string } };
    expect(upd.error?.message).toMatch(/append-only/);
    const del = (await w.db.from("newquip_response_evidence").delete().eq("id", r.evidence[0].id)) as unknown as { error?: { message: string } };
    expect(del.error?.message).toMatch(/append-only/);
  });
  it("while an emailed acceptance awaits verification, staff cannot record another response over it", async () => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id);
    await submit(w, accept(s.token));
    expect(await err(rec(w, doc.id))).toMatch(/waiting for internal verification/);
  });
});

describe("Rep notifications for customer responses", () => {
  const resp = async (action: "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED", repEmail = "rep@sparkconsulting.co.za") => {
    const { w, doc } = await ready();
    const s = await sendWithLinks(w, doc.id, { repEmail });
    await submit(w, action === "ACCEPTED" ? accept(s.token) : accept(s.token, { action, reason: "price too high", authorityConfirmed: false, revisionConfirmed: false }));
    return { w, doc, s };
  };
  it("the Rep gets an in-app notification AND an email with the quotation, customer, response, time, next action and a Stage 5 link - and no money figures", async () => {
    const { w, doc } = await resp("ACCEPTED");
    const inApp = notes(w, "IN_APP").filter((n) => n.kind === "CUSTOMER_ACCEPTED_PENDING");
    expect(inApp.map((n) => n.recipient_email).sort()).toEqual(["rep@nq", "rep@sparkconsulting.co.za"]); // the Rep who sent it and the Rep who handed it off
    const mail = notes(w, "EMAIL").find((n) => n.kind === "CUSTOMER_ACCEPTED_PENDING" && n.recipient_email === "rep@sparkconsulting.co.za")!;
    expect(mail.subject).toBe(`NewQuip Quotation ${doc.quote_ref}: customer accepted - verification required`);
    expect(mail.body).toContain("Customer: Boerdery (Pty) Ltd"); expect(mail.body).toContain("Response: Accepted"); expect(mail.body).toContain("Piet Pompies");
    expect(mail.body).toMatch(/Required action: Open Customer Acceptance, check who responded/);
    expect(mail.body).toContain(`/newquip-grower/${w.id}?stage=5`);
    expect(mail.body).not.toMatch(/R\s?\d|VAT|margin|cost|supplier/i);
    expect(mail.status).toBe("SENT"); // the allowlisted Rep mailbox is emailed, with the Preview marking
    const sent = vi.mocked(sendEmail).mock.calls.map((c) => c[0] as { to: string[]; subject: string }).find((c) => /verification required/.test(c.subject));
    expect(sent!.to).toEqual(["rep@sparkconsulting.co.za"]); expect(sent!.subject).toMatch(/^\[PREVIEW\]/);
  });
  it("decline and change-request notifications are distinct, and carry the customer's reason", async () => {
    const d = await resp("DECLINED"); const dm = notes(d.w, "EMAIL").find((n) => n.kind === "CUSTOMER_DECLINED")!;
    expect(dm.subject).toMatch(/customer declined/); expect(dm.body).toContain("Reason: price too high");
    const c = await resp("CHANGES_REQUESTED"); expect(notes(c.w, "EMAIL").some((n) => n.kind === "CUSTOMER_CHANGES_REQUESTED" && /requested changes/.test(n.subject))).toBe(true);
  });
  it("verification outcomes notify the Rep: verified (next: create the Project) and rejected (with the reason)", async () => {
    const { w } = await resp("ACCEPTED");
    const r = (await listResponses(w.db as never, ORG, w.id))[0];
    const rv = await reviewResponse(w.db as never, ORG, w.id, { email: "mgr@nq" }, { responseId: r.id, decision: "VERIFIED", note: "ok" });
    const { notifyResponseEvent } = await import("../response-notify");
    await notifyResponseEvent(w.db as never, { orgId: ORG, quoteId: w.id, quoteRef: "NQ-Q-0001", customerName: "Boerdery", event: "VERIFIED", response: rv.response, recipients: ["rep@sparkconsulting.co.za"], by: "mgr@nq" }, PREVIEW);
    await notifyResponseEvent(w.db as never, { orgId: ORG, quoteId: w.id, quoteRef: "NQ-Q-0001", customerName: "Boerdery", event: "REJECTED_ON_VERIFICATION", response: rv.response, recipients: ["rep@sparkconsulting.co.za"], by: "mgr@nq", reason: "not a director" }, PREVIEW);
    const kinds = notes(w, "EMAIL").map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["CUSTOMER_VERIFIED", "CUSTOMER_REJECTED_ON_VERIFICATION"]));
    expect(notes(w, "EMAIL").find((n) => n.kind === "CUSTOMER_VERIFIED")!.body).toMatch(/create the Project \(nothing is created automatically\)/);
    expect(notes(w, "EMAIL").find((n) => n.kind === "CUSTOMER_REJECTED_ON_VERIFICATION")!.body).toContain("Reason: not a director");
  });
  it("PREVIEW allowlist: a Rep outside the five Spark mailboxes is notified in-app only - the email is SUPPRESSED, never redirected", async () => {
    const { w } = await resp("ACCEPTED", "rep@some-other-company.example");
    expect(notes(w, "IN_APP").some((n) => n.recipient_email === "rep@some-other-company.example")).toBe(true);
    const mail = notes(w, "EMAIL").find((n) => n.recipient_email === "rep@some-other-company.example")!;
    expect(mail.status).toBe("SUPPRESSED");
    expect(vi.mocked(sendEmail).mock.calls.some((c) => (c[0] as { to: string[] }).to.includes("rep@some-other-company.example"))).toBe(false);
  });
  it("each event is recorded once per recipient (deduplicated): notifying the same event again adds nothing", async () => {
    const { w } = await resp("ACCEPTED");
    const { notifyResponseEvent } = await import("../response-notify");
    const r0 = (await listResponses(w.db as never, ORG, w.id))[0];
    const before = notes(w, "IN_APP").length + notes(w, "EMAIL").length;
    await notifyResponseEvent(w.db as never, { orgId: ORG, quoteId: w.id, quoteRef: "NQ-Q-0001", customerName: "Boerdery", event: "ACCEPTED_PENDING", response: r0, recipients: ["rep@sparkconsulting.co.za", "rep@nq"] }, PREVIEW);
    expect(notes(w, "IN_APP").length + notes(w, "EMAIL").length).toBe(before);
    const keys = notes(w, "IN_APP").concat(notes(w, "EMAIL")).map((n) => n.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("without an approval request or without approvals installed there is simply no notification (the response is still recorded)", async () => {
    const { w, doc } = await ready();
    w.db.rows("approval_requests").length = 0;
    const s = await sendWithLinks(w, doc.id);
    expect((await submit(w, accept(s.token))).ok).toBe(true);
    expect(notes(w, "IN_APP")).toHaveLength(0);
  });
});
