import { describe, expect, it, vi } from "vitest";
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
import { commercialStatus, listResponses, recordCustomerResponse, requireAcceptance, type ResponseInput } from "../acceptance";
import { listDocuments } from "../document-store";
import { listSends } from "../send-store";

const ORG = "org-newquip"; const rep = rolesFor("member"); const mgr = rolesFor("admin"); const ctx = { priceSource: testPriceSource(), withholdCost: true };
const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "p", deliveryInstallationConditions: "d", termsAndConditions: "t", acceptanceInstructions: "a" };
const TODAY = "2026-10-29";
const PREVIEW = { VERCEL_ENV: "preview" };

async function world(opts: { gated: boolean }) {
  const db = new FakeDb(); db.deliveryApplied = true;
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
const send = async (w: Awaited<ReturnType<typeof world>>, docId: string) => sendQuotationToCustomer(w.db as never, ORG, w.id, { email: "rep@nq" }, { documentId: docId, to: ["rep@sparkconsulting.co.za"], message: "", idempotencyKey: "key-send-0001" }, w.deps, PREVIEW, vi.fn(async () => ({ ok: true, messageId: "m1" })) as never);
const respond = (w: Awaited<ReturnType<typeof world>>, docId: string, over: Partial<ResponseInput> = {}) => recordCustomerResponse(w.db as never, ORG, w.id, { email: "rep@nq" }, { documentId: docId, response: "ACCEPTED", contactName: "Piet", respondedOn: TODAY, evidenceRef: "email 29 Oct re NQ-Q-0001", ...over }, TODAY);
const project = (w: Awaited<ReturnType<typeof world>>) => createProjectFromAcceptedQuote(w.db as never, ORG, "m@nq", w.id, POC_SIX_STAGE_SCHEDULE);
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

describe("GRANDFATHERING: quotations that existed at the cutover behave exactly as before", () => {
  it("a quotation without the flag (migration absent) or with it FALSE becomes a Project on Manager approval alone, with no document, send or response", async () => {
    for (const flag of [false, undefined]) {
      const w = await world({ gated: false });
      if (flag === undefined) delete (w.db.rows("newquip_quotes")[0] as Record<string, unknown>).requires_customer_acceptance;
      const r = await project(w);
      expect(r.created).toBe(true);
      expect(w.db.rows("newquip_quote_documents")).toHaveLength(0);
      expect(w.db.rows("projects")).toHaveLength(1);
    }
  });
  it("the gate helper reports null (no acceptance needed) for a grandfathered quote and never inspects documents", async () => {
    const w = await world({ gated: false });
    expect(await requireAcceptance(w.db as never, ORG, (await loadQuote(w.db as never, ORG, w.id))!)).toBeNull();
  });
  it("an EXISTING project is returned unchanged whatever the flag says (no retroactive eligibility change)", async () => {
    const w = await world({ gated: false });
    const first = await project(w);
    (w.db.rows("newquip_quotes")[0] as Record<string, unknown>).requires_customer_acceptance = true; // even if someone flipped it
    const again = await project(w);
    expect(again).toEqual({ projectId: first.projectId, created: false });
    expect(w.db.rows("projects")).toHaveLength(1);
  });
});

describe("ACCEPTANCE GATE for new quotations", () => {
  it("Manager approval alone does NOT create a Project; each non-acceptance outcome keeps it blocked; acceptance of the exact issued revision unlocks it", async () => {
    const w = await world({ gated: true });
    expect(await err(project(w))).toMatch(/customer must accept the issued quotation/);
    const { document: doc } = await issue(w);
    expect(await err(project(w))).toMatch(/not accepted this quotation yet/);
    await send(w, doc.id);
    expect(commercialStatus({ state: "MANAGER_APPROVED_FINAL" }, doc, await listSends(w.db as never, ORG, w.id), [])).toBe("SENT_TO_CUSTOMER");
    expect(await err(project(w))).toMatch(/not accepted this quotation yet/);
    await respond(w, doc.id, { response: "DECLINED", evidenceRef: "phone call 28 Oct" });
    expect(await err(project(w))).toMatch(/not accepted this quotation yet/);
    await respond(w, doc.id, { response: "CHANGES_REQUESTED", note: "wants 2 fewer rooms", evidenceRef: "email 28 Oct 2" });
    expect(await err(project(w))).toMatch(/not accepted this quotation yet/);
    expect(w.db.rows("projects")).toHaveLength(0);
    await respond(w, doc.id);
    const r = await project(w);
    expect(r.created).toBe(true);
  });
  it("the Project carries the selected Cin7 customer ID, the accepted contract value, and the billing schedule the CUSTOMER accepted (not the caller's)", async () => {
    const w = await world({ gated: true });
    const { document: doc } = await issue(w); await respond(w, doc.id);
    const r = await project(w); // the caller passes the six-stage schedule; the accepted one is the standard schedule
    const proj = w.db.rows("projects").find((p) => p.id === r.projectId) as Record<string, unknown>;
    expect(proj.cin7_customer_id).toBe("cin7-cust-42");
    expect(proj.customer_name).toBe("Boerdery (Pty) Ltd");
    const stages = w.db.rows("project_stages").filter((s) => s.project_id === r.projectId);
    expect(stages.map((s) => s.name)).toEqual(doc.content.paymentSchedule.map((p) => p.name));
    expect(stages.reduce((a, s) => a + Number(s.value_cents), 0)).toBe(w.total);
    expect(stages).not.toHaveLength(POC_SIX_STAGE_SCHEDULE.length);
  });
  it("no duplicate Project (second call returns it) and nothing is written to Cin7 link / sale-creation tables by issuing, sending, accepting or creating", async () => {
    const w = await world({ gated: true });
    const { document: doc } = await issue(w); await send(w, doc.id); await respond(w, doc.id);
    const a = await project(w); const b = await project(w);
    expect(b).toEqual({ projectId: a.projectId, created: false });
    expect(w.db.rows("projects")).toHaveLength(1);
    expect(w.db.writes.filter((x) => /cin7/i.test(x.table))).toEqual([]);
  });
  it("acceptance is bound to the exact issued document: a response for another quotation's document, a stale revision or a changed baseline is refused", async () => {
    const w = await world({ gated: true });
    const { document: doc } = await issue(w);
    expect(await err(respond(w, "someone-elses-doc"))).toMatch(/does not belong/);
    const q = w.db.rows("newquip_quotes")[0] as Record<string, unknown>;
    q.revision = 2;
    expect(await err(respond(w, doc.id))).toMatch(/not the current issued revision/);
    q.revision = 1; q.baseline_hash = "f".repeat(64);
    expect(await err(respond(w, doc.id))).toMatch(/not the current issued revision/);
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
    // and a recorded acceptance of an older revision does not satisfy the gate
    q.baseline_hash = doc.baseline_hash; await respond(w, doc.id); q.revision = 2;
    expect(await err(requireAcceptance(w.db as never, ORG, (await loadQuote(w.db as never, ORG, w.id))! as never))).toMatch(/must accept the issued quotation/);
  });
  it("acceptance is final: nothing else can be recorded and the accepted document can no longer be replaced; the same acceptance twice is not duplicated", async () => {
    const w = await world({ gated: true });
    const { document: doc } = await issue(w);
    const a = await respond(w, doc.id); const dup = await respond(w, doc.id);
    expect(a.created).toBe(true); expect(dup).toMatchObject({ created: false }); expect(dup.response.id).toBe(a.response.id);
    expect(await err(respond(w, doc.id, { response: "DECLINED", evidenceRef: "later email" }))).toMatch(/already accepted/);
    await saveProfile(w.db as never, ORG, { ...PROFILE, termsAndConditions: "changed terms" }, "m@nq");
    expect(await err(issue(w))).toMatch(/accepted this quotation; the accepted document is final/);
    expect((await listDocuments(w.db as never, ORG, w.id)).map((d) => d.version)).toEqual([1]);
    expect((await listResponses(w.db as never, ORG, w.id))).toHaveLength(1);
  });
  it("response validation: evidence, contact, date, changes note; a decline can later be followed by an acceptance", async () => {
    const w = await world({ gated: true }); const { document: doc } = await issue(w);
    expect(await err(respond(w, doc.id, { evidenceRef: "" }))).toMatch(/evidence/);
    expect(await err(respond(w, doc.id, { contactName: "" }))).toMatch(/contact/);
    expect(await err(respond(w, doc.id, { respondedOn: "2099-01-01" }))).toMatch(/future/);
    expect(await err(respond(w, doc.id, { respondedOn: "not-a-date" }))).toMatch(/date/);
    expect(await err(respond(w, doc.id, { respondedOn: "2026-01-01" }))).toMatch(/pre-date/);
    expect(await err(respond(w, doc.id, { response: "CHANGES_REQUESTED", note: "" }))).toMatch(/Describe/);
    await respond(w, doc.id, { response: "DECLINED", evidenceRef: "call" });
    expect(commercialStatus({ state: "MANAGER_APPROVED_FINAL" }, doc, [], await listResponses(w.db as never, ORG, w.id))).toBe("CUSTOMER_DECLINED");
    await respond(w, doc.id, { evidenceRef: "signed copy returned" });
    expect(commercialStatus({ state: "MANAGER_APPROVED_FINAL" }, doc, [], await listResponses(w.db as never, ORG, w.id))).toBe("CUSTOMER_ACCEPTED");
  });
  it("organisation isolation: another organisation cannot record a response or satisfy the gate", async () => {
    const w = await world({ gated: true }); const { document: doc } = await issue(w);
    expect(await err(recordCustomerResponse(w.db as never, "org-b", w.id, { email: "x" }, { documentId: doc.id, response: "ACCEPTED", contactName: "Piet", respondedOn: TODAY, evidenceRef: "email" }, TODAY))).toMatch(/Quote not found/);
    expect(w.db.rows("newquip_quote_responses")).toHaveLength(0);
  });
  it("the customer snapshot of an approved quotation cannot be added to, even straight through the store", async () => {
    const w = await world({ gated: true });
    const snap = withChosenContact(buildCustomerSnapshot({ ID: "other", Name: "Other", Addresses: [], Contacts: [{ Name: "X", Email: "x@y.co" }] }, "t"), { source: "CIN7_CONTACT", contactIndex: 0 });
    expect(await err(appendSnapshot(w.db as never, ORG, w.id, snap, { email: "x" }, "late"))).toMatch(/immutable/);
    expect(w.db.rows("newquip_quote_customers")).toHaveLength(1);
  });
  it("the status is derived: approval alone is APPROVED_INTERNALLY, never accepted", async () => {
    const w = await world({ gated: true });
    const q = (await loadQuote(w.db as never, ORG, w.id))!;
    expect(commercialStatus(q, null, [], [])).toBe("APPROVED_INTERNALLY");
    expect(commercialStatus({ state: "ESTIMATOR_REVIEW" }, null, [], [])).toBe("NOT_APPROVED");
  });
});

describe("REGRESSION: Project creation is idempotent (reload, reopen, double click, two tabs)", () => {
  it("repeating the creation after a reload returns the SAME Project and creates nothing", async () => {
    const w = await world({ gated: false });
    const first = await project(w);
    for (let i = 0; i < 3; i++) expect(await project(w)).toEqual({ projectId: first.projectId, created: false });
    expect(w.db.rows("projects")).toHaveLength(1);
    expect((await loadQuote(w.db as never, ORG, w.id))!.project_id).toBe(first.projectId);
  });
  it("concurrent requests (double click / two tabs) end with exactly one Project, and every caller gets that Project", async () => {
    const w = await world({ gated: false });
    const results = await Promise.all([project(w), project(w), project(w)]);
    expect(w.db.rows("projects")).toHaveLength(1);
    expect(new Set(results.map((r) => r.projectId)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBeLessThanOrEqual(1);
    expect((await loadQuote(w.db as never, ORG, w.id))!.project_id).toBe(results[0].projectId);
  });
  it("a request that loses the race (the database refuses the duplicate reference) links the winner instead of failing or duplicating", async () => {
    const w = await world({ gated: false });
    const winner = await project(w);
    // the quote row has not yet been linked in the loser's view, and its first lookup missed the winner: simulate by unlinking and hiding the project from the first lookup only
    (w.db.rows("newquip_quotes")[0] as Record<string, unknown>).project_id = null;
    const projects = w.db.rows("projects") as Array<Record<string, unknown>>;
    const hidden = projects[0].originating_quote_ref; projects[0].originating_quote_ref = "HIDDEN";
    const orig = w.db.from.bind(w.db); let lookups = 0;
    (w.db as { from: unknown }).from = (t: string) => { const q = orig(t); if (t === "projects" && lookups++ === 1) projects[0].originating_quote_ref = hidden; return q; };
    const r = await project(w);
    expect(r).toEqual({ projectId: winner.projectId, created: false });
    expect(w.db.rows("projects")).toHaveLength(1);
  });
  it("a genuine creation failure (not a duplicate) is NOT swallowed", async () => {
    const w = await world({ gated: false });
    const orig = w.db.from.bind(w.db);
    (w.db as { from: unknown }).from = (t: string) => { const q = orig(t) as Record<string, unknown>; if (t === "projects") return { ...q, insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "connection reset" } }) }) }) }; return q; };
    expect(await err(project(w))).toMatch(/connection reset/);
    expect(w.db.rows("projects")).toHaveLength(0);
  });
});

describe("UAT-006: estimator sign-off is recorded once", () => {
  it("a second sign-off of the same content is refused and does not re-stamp who/when", async () => {
    const db = new FakeDb(); db.deliveryApplied = true;
    const draft = readyDraft();
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    await saveDraft(db as never, ORG, rep, id, draft);
    const total = Math.round(evaluateDraft(draft, ctx).budget!.totals.subtotalExTax * 100);
    await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
    await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
    const first = { ...(db.rows("newquip_quotes")[0] as Record<string, unknown>) };
    expect(first.estimator_signoff_by_email).toBe("est@nq");
    const msg = await err(estimatorSignOff(db as never, ORG, rep, "other@nq", id, ctx));
    expect(msg).toMatch(/already signed off by est@nq/);
    const after = db.rows("newquip_quotes")[0] as Record<string, unknown>;
    expect(after.estimator_signoff_by_email).toBe("est@nq");
    expect(after.estimator_signoff_at).toBe(first.estimator_signoff_at);
  });
  it("a legacy sign-off hash that no longer matches the content does not lock the quote: it can be signed again (review hardening)", async () => {
    const db = new FakeDb(); db.deliveryApplied = true;
    const draft = readyDraft();
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    await saveDraft(db as never, ORG, rep, id, draft);
    const total = Math.round(evaluateDraft(draft, ctx).budget!.totals.subtotalExTax * 100);
    await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
    (db.rows("newquip_quotes")[0] as Record<string, unknown>).estimator_signoff_hash = "stale-hash"; (db.rows("newquip_quotes")[0] as Record<string, unknown>).estimator_signoff_by_email = "old@nq";
    await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
    expect((db.rows("newquip_quotes")[0] as Record<string, unknown>).estimator_signoff_by_email).toBe("est@nq");
  });
});
