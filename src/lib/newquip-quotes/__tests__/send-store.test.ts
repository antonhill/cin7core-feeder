import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";
import { NEWQUIP_STANDARD_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { buildCustomerSnapshot, withChosenContact } from "../customer-snapshot";
import { issueQuotationDocument, saveProfile, type DocumentDeps } from "../document-store";
import { renderCustomerPdf } from "../customer-pdf";
import { retryFailedSend, sendQuotationToCustomer, validateRequest, type SendFn } from "../send-store";

const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "p", deliveryInstallationConditions: "d", termsAndConditions: "t", acceptanceInstructions: "a" };
const PREVIEW = { VERCEL_ENV: "preview" }; const PROD = { VERCEL_ENV: "production" };
const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "rep.person@nq.example", handoffBy: "rep.person@nq.example", estimatorSignoffBy: "est.person@nq.example", estimatorSignoffAt: "t", managerApprovedBy: "mgr.person@nq.example", managerApprovedAt: "t" };

async function world() {
  const db = new FakeDb(); db.deliveryApplied = true;
  const draft = readyDraft(); draft.customerName = "Boerdery (Pty) Ltd"; draft.siteName = "Paarl";
  const { baseline, hash } = buildAcceptedBaseline({ quoteRef: "NQ-Q-0009", revision: 1, draft, evaluation: evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false }), approvals });
  const quote = { id: "q1", org_id: "org-a", quote_ref: "NQ-Q-0009", revision: 1, state: "MANAGER_APPROVED_FINAL", accepted_baseline: baseline, baseline_hash: hash, draft: {}, requires_customer_acceptance: true };
  db.rows("newquip_quotes").push(quote);
  const files = new Map<string, Uint8Array>();
  const deps: DocumentDeps = { today: () => "2026-10-29", render: renderCustomerPdf,
    storage: { upload: async (p, b) => { files.set(p, b); }, download: async (p) => files.get(p)!, remove: async (p) => { files.delete(p); } } };
  const snap = withChosenContact(buildCustomerSnapshot({ ID: "c1", Name: "Boerdery (Pty) Ltd", Currency: "ZAR", Addresses: [{ Type: "Billing", Line1: "PO Box 1", DefaultForType: true }], Contacts: [{ Name: "Piet", Email: "piet@boerdery.example" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 });
  db.rows("newquip_quote_customers").push({ id: "s1", org_id: "org-a", quote_id: "q1", seq: 1, cin7_customer_id: "c1", snapshot: snap, snapshot_hash: "h", captured_by_email: "rep@x" });
  await saveProfile(db as never, "org-a", PROFILE, "m@x");
  const { document } = await issueQuotationDocument(db as never, "org-a", "q1", { email: "mgr@x" }, NEWQUIP_STANDARD_SCHEDULE, deps);
  return { db, quote, deps, files, doc: document };
}
const ok = (): SendFn & ReturnType<typeof vi.fn> => vi.fn(async () => ({ ok: true, messageId: "msg-1" })) as never;
const bad = (): SendFn & ReturnType<typeof vi.fn> => vi.fn(async () => ({ ok: false, error: "provider said no" })) as never;
const req = (w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) => ({ documentId: w.doc.id, to: ["rep@sparkconsulting.co.za"], message: "Hello", idempotencyKey: "key-0001-aaaa", ...over });
const go = (w: Awaited<ReturnType<typeof world>>, send: SendFn, over: Record<string, unknown> = {}, env = PREVIEW) => sendQuotationToCustomer(w.db as never, "org-a", "q1", { email: "rep@x", ownerEmail: null }, req(w, over), w.deps, env, send);

describe("sending the issued quotation", () => {
  it("sends the approved PDF to an allowlisted recipient from Preview: [PREVIEW] subject, exact attachment, ACCEPTED with the provider id, full audit row", async () => {
    const w = await world(); const send = ok();
    const r = await go(w, send);
    expect(send).toHaveBeenCalledTimes(1);
    const i = vi.mocked(send).mock.calls[0][0];
    expect(i.to).toEqual(["rep@sparkconsulting.co.za"]);
    expect(i.subject.startsWith("[PREVIEW] Quotation NQ-Q-0009")).toBe(true);
    expect(i.text).toContain("NewQuip PREVIEW");
    expect(i.attachments).toHaveLength(1);
    expect(Buffer.compare(i.attachments![0].content, Buffer.from(w.files.get(w.doc.storage_path)!))).toBe(0); // the stored, hash-verified PDF
    expect(i.attachments![0].filename).toBe("NQ-Q-0009-r1.pdf");
    expect(r.send).toMatchObject({ status: "ACCEPTED", provider_message_id: "msg-1", document_id: w.doc.id, to_emails: ["rep@sparkconsulting.co.za"], sent_by_email: "rep@x", suppressed_emails: [] });
  });
  it("PREVIEW SAFETY: a real customer address is suppressed - never emailed, never redirected - and the send is recorded as SUPPRESSED", async () => {
    const w = await world(); const send = ok();
    const r = await go(w, send, { to: ["piet@boerdery.example"] });
    expect(send).not.toHaveBeenCalled();
    expect(r.send).toMatchObject({ status: "SUPPRESSED", to_emails: ["piet@boerdery.example"], suppressed_emails: ["piet@boerdery.example"] });
    expect(r.send.provider_message_id ?? null).toBeNull();
  });
  it("a mixed list sends only to the allowlisted mailbox and records who was suppressed (including CC)", async () => {
    const w = await world(); const send = ok();
    const r = await go(w, send, { to: ["anton@sparkconsulting.co.za", "piet@boerdery.example"], cc: ["boss@elsewhere.example", "manager@sparkconsulting.co.za"] });
    const i = vi.mocked(send).mock.calls[0][0];
    expect(i.to).toEqual(["anton@sparkconsulting.co.za"]); expect(i.cc).toEqual(["manager@sparkconsulting.co.za"]);
    expect(r.send.suppressed_emails.sort()).toEqual(["boss@elsewhere.example", "piet@boerdery.example"]);
  });
  it("in Production the customer is emailed with no [PREVIEW] marking", async () => {
    const w = await world(); const send = ok();
    await go(w, send, { to: ["piet@boerdery.example"] }, PROD);
    const i = vi.mocked(send).mock.calls[0][0];
    expect(i.to).toEqual(["piet@boerdery.example"]); expect(i.subject.startsWith("[PREVIEW]")).toBe(false); expect(i.text).not.toContain("PREVIEW");
  });
  it("PRODUCTION RECIPIENTS: only a Cin7 contact of the customer, or an alternative approved with an audited reason (To and CC alike)", async () => {
    const w = await world(); const send = ok();
    await expect(go(w, send, { to: ["stranger@elsewhere.example"] }, PROD)).rejects.toThrow(/not a Cin7 contact/);
    await expect(go(w, send, { to: ["piet@boerdery.example"], cc: ["cc@elsewhere.example"] }, PROD)).rejects.toThrow(/not a Cin7 contact/);
    await expect(go(w, send, { to: ["stranger@elsewhere.example"], alternativeReason: "ok" }, PROD)).rejects.toThrow(/not a Cin7 contact/);
    expect(send).not.toHaveBeenCalled(); expect(w.db.rows("newquip_quote_sends")).toHaveLength(0);
    const r = await go(w, send, { to: ["PIET@boerdery.example"], cc: ["accounts@elsewhere.example"], alternativeReason: "Customer asked that accounts is copied (phone call 29 Oct)" }, PROD);
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.send).toMatchObject({ status: "ACCEPTED", alternative_recipients: ["accounts@elsewhere.example"], alternative_reason: "Customer asked that accounts is copied (phone call 29 Oct)" });
  });
  it("a Cin7 contact needs no reason, and nothing is recorded as an alternative", async () => {
    const w = await world(); const send = ok();
    const r = await go(w, send, { to: ["piet@boerdery.example"] }, PROD);
    expect(r.send.alternative_recipients).toEqual([]); expect(r.send.alternative_reason ?? null).toBeNull();
  });
  it("fails closed: an unset or unrecognised environment is restricted", async () => {
    for (const env of [{}, { VERCEL_ENV: "Production" }, { VERCEL_ENV: "prod" }]) {
      const w = await world(); const send = ok();
      const r = await go(w, send, { to: ["piet@boerdery.example"] }, env as never);
      expect(send).not.toHaveBeenCalled(); expect(r.send.status).toBe("SUPPRESSED");
    }
  });
  it("only after Manager approval, and only the LATEST document at the approved revision and baseline", async () => {
    const w = await world(); const send = ok();
    w.quote.state = "ESTIMATOR_REVIEW";
    await expect(go(w, send)).rejects.toThrow(/after Manager approval/);
    w.quote.state = "MANAGER_APPROVED_FINAL";
    w.quote.revision = 2;
    await expect(go(w, send)).rejects.toThrow(/changed after this document was issued/);
    w.quote.revision = 1; w.quote.baseline_hash = "f".repeat(64);
    await expect(go(w, send)).rejects.toThrow(/changed after this document was issued/);
    w.quote.baseline_hash = w.doc.baseline_hash;
    await expect(go(w, send, { documentId: "nope" })).rejects.toThrow(/does not belong/);
    w.db.rows("newquip_quote_documents").unshift({ ...w.doc, id: "newer", version: 2, storage_path: "x/v2.pdf" }); // a newer version exists
    w.db.rows("newquip_quote_documents").sort((a, b) => Number(b.version) - Number(a.version));
    await expect(go(w, send)).rejects.toThrow(/newer version/);
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses a tampered stored PDF (hash mismatch) before anything is sent", async () => {
    const w = await world(); const send = ok();
    w.files.set(w.doc.storage_path, new Uint8Array([9, 9, 9]));
    await expect(go(w, send)).rejects.toThrow(/recorded hash/);
    expect(send).not.toHaveBeenCalled(); expect(w.db.rows("newquip_quote_sends")).toHaveLength(0);
  });
  it("recipient and message validation: bad address, none, too many, internal wording, internal SKU", async () => {
    const w = await world(); const send = ok();
    await expect(go(w, send, { to: ["not-an-email"] })).rejects.toThrow(/not a valid email/);
    await expect(go(w, send, { to: [] })).rejects.toThrow(/Enter the customer/);
    await expect(go(w, send, { to: ["a@b.co", "c@d.co", "e@f.co", "g@h.co"] })).rejects.toThrow(/At most 3/);
    await expect(go(w, send, { message: "Our margin on this is 20%" })).rejects.toThrow(/internal information/);
    const sku = w.quote.accepted_baseline.commercial.lines.find((l: { sku: string | null }) => l.sku)!.sku;
    await expect(go(w, send, { message: `Includes ${sku} as discussed` })).rejects.toThrow(/internal information/);
    expect(() => validateRequest({ documentId: "d", to: ["a@b.co"], message: "x".repeat(2001), idempotencyKey: "12345678" })).toThrow(/too long/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("duplicate prevention, resend and retry", () => {
  it("the same dialog (same idempotency key) returns the SAME send: a double click or two sessions emit one email", async () => {
    const w = await world(); const send = ok();
    const [a, b] = await Promise.all([go(w, send), go(w, send)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(a.send.id).toBe(b.send.id);
    expect(w.db.rows("newquip_quote_sends")).toHaveLength(1);
  });
  it("repeating the same dialog AFTER it was accepted returns the original send (reused), not an error and not a second email", async () => {
    const w = await world(); const send = ok();
    const a = await go(w, send); const b = await go(w, send);
    expect(b.reused).toBe(true); expect(b.send.id).toBe(a.send.id); expect(send).toHaveBeenCalledTimes(1);
  });
  it("a second send of an already-accepted quotation needs an audited re-send with a reason; then it goes out and is linked to the first", async () => {
    const w = await world(); const send = ok();
    const first = await go(w, send);
    await expect(go(w, send, { idempotencyKey: "key-0002-bbbb" })).rejects.toThrow(/already been sent/);
    await expect(go(w, send, { idempotencyKey: "key-0002-bbbb", resendOfId: first.send.id })).rejects.toThrow(/reason/);
    await expect(go(w, send, { idempotencyKey: "key-0002-bbbb", resendOfId: "other", resendReason: "customer lost it" })).rejects.toThrow(/earlier send/);
    expect(send).toHaveBeenCalledTimes(1);
    const again = await go(w, send, { idempotencyKey: "key-0002-bbbb", resendOfId: first.send.id, resendReason: "customer lost it" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(again.send).toMatchObject({ resend_of: first.send.id, resend_reason: "customer lost it", status: "ACCEPTED" });
  });
  it("a provider failure is recorded FAILED (not accepted); a controlled retry sends once, even under concurrency; an ACCEPTED send cannot be retried", async () => {
    const w = await world(); const failing = bad();
    const r = await go(w, failing);
    expect(r.send).toMatchObject({ status: "FAILED", last_error: "provider said no" });
    expect(r.send.provider_message_id ?? null).toBeNull();
    const good = ok();
    const [x, y] = await Promise.allSettled([retryFailedSend(w.db as never, "org-a", r.send.id, w.deps, PREVIEW, good), retryFailedSend(w.db as never, "org-a", r.send.id, w.deps, PREVIEW, good)]);
    expect(good).toHaveBeenCalledTimes(1);
    expect([x.status, y.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.db.rows("newquip_quote_sends")[0]).toMatchObject({ status: "ACCEPTED", provider_message_id: "msg-1" });
    await expect(retryFailedSend(w.db as never, "org-a", r.send.id, w.deps, PREVIEW, good)).rejects.toThrow(/accepted by the provider/);
    expect(good).toHaveBeenCalledTimes(1);
  });
  it("a retry still obeys the Preview policy and the current approved revision", async () => {
    const w = await world();
    const r = await go(w, bad(), { to: ["anton@sparkconsulting.co.za"] });
    const good = ok();
    w.quote.revision = 7;
    await expect(retryFailedSend(w.db as never, "org-a", r.send.id, w.deps, PREVIEW, good)).rejects.toThrow(/changed after this send/);
    expect(good).not.toHaveBeenCalled();
  });
  it("organisation isolation: another organisation can neither send nor retry", async () => {
    const w = await world();
    const r = await go(w, bad());
    await expect(sendQuotationToCustomer(w.db as never, "org-b", "q1", { email: "x" }, req(w), w.deps, PREVIEW, ok())).rejects.toThrow(/Quote not found/);
    await expect(retryFailedSend(w.db as never, "org-b", r.send.id, w.deps, PREVIEW, ok())).rejects.toThrow(/Send not found/);
  });
  it("the send row is append-only apart from its delivery outcome (database guard emulated)", async () => {
    const w = await world(); const r = await go(w, ok());
    const res = (await w.db.from("newquip_quote_sends").update({ to_emails: ["evil@x.co"] }).eq("id", r.send.id)) as unknown as { error: { message: string } };
    expect(res.error.message).toMatch(/only the delivery outcome/);
    const res2 = (await w.db.from("newquip_quote_sends").update({ status: "FAILED" }).eq("id", r.send.id)) as unknown as { error: { message: string } };
    expect(res2.error.message).toMatch(/settled send/);
  });
});
