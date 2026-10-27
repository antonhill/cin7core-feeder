import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, setOpeningCommitments, submitClaimForApproval } from "../project-store";
import { linkCin7Sale, listPostings, postClaimToCin7, reconcileClaimPosting, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT, buildPostingPlan, idempotencyKeyFor, matchInvoices, memoFor } from "../cin7-posting";
import { buildProgressInvoiceBody } from "@/cin7/sale-invoice-write";

const ORG = "org-a";
const SALE_ID = "4fe3d99c-241d-4404-8795-4c448842108b";
const R = (n: number) => n * 100;
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

class FakePort implements Cin7Port {
  sale: Cin7SaleView = { id: SALE_ID, saleNumber: "SO-00015", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [] };
  created: InvoiceRequest[] = [];
  next: InvoiceOutcome | "throw" | null = null;
  reads = 0;
  async fetchSale(): Promise<Cin7SaleView> { this.reads++; return structuredClone(this.sale); }
  async createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.created.push(req);
    if (this.next === "throw") throw new Error("boom");
    if (this.next) return this.next;
    const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0);
    const tax = Math.round(sub * 15) / 100;
    return { kind: "created", invoiceNumber: "INV-00100", taskId: "task-1", status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax };
  }
  /** What Cin7 would hold after the request landed. */
  landed(req: InvoiceRequest, over: Partial<{ subtotalCents: number; taxCents: number; totalCents: number; status: string }> = {}) {
    const sub = Math.round(req.charges.reduce((n, c) => n + c.priceExVat, 0) * 100);
    this.sale.invoices.push({ invoiceNumber: "INV-00100", taskId: "task-1", memo: req.memo, status: over.status ?? "DRAFT", subtotalCents: over.subtotalCents ?? sub, taxCents: over.taxCents ?? Math.round(sub * 0.15), totalCents: over.totalCents ?? Math.round(sub * 1.15) });
  }
}

/** An ACTIVE project at the golden position with an APPROVED claim C01 = R950,000 ex VAT. */
async function approvedClaim() {
  const db = new FakeDb();
  const projectId = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "n" });
  const v = (await loadProjectView(db as never, ORG, projectId))!;
  const st = (n: string) => v.stages.find((s) => s.name.startsWith(n))!.id;
  const rec = (n: string, a: string, b: string) => recordProgress(db as never, ORG, "x@x", { projectId, stageId: st(n), reportedPct: a, approvedPct: b, comment: "c" });
  await rec("Deposit", "100", "100"); await rec("Manufacturing", "75", "65"); await rec("Delivery", "25", "25");
  await setOpeningCommitments(db as never, ORG, "m@x", { projectId, reason: "opening", items: [{ stageId: st("Deposit"), amountCents: R(1_000_000) }, { stageId: st("Manufacturing"), amountCents: R(1_500_000) }] });
  const { claimId } = await createClaimDraft(db as never, ORG, "x@x", projectId);
  await submitClaimForApproval(db as never, ORG, projectId, claimId);
  await approveClaim(db as never, ORG, "mgr@x", projectId, claimId);
  return { db, projectId, claimId };
}
let ctx: Awaited<ReturnType<typeof approvedClaim>>;
let port: FakePort;
const link = () => linkCin7Sale(ctx.db as never, port, ON, "mgr@x", { orgId: ORG, projectId: ctx.projectId, instanceId: "inst-1", saleId: SALE_ID, revenueAccount: "200" });
const post = (over: Partial<WriteGates> = {}, confirmation = POST_CONFIRMATION_TEXT) => postClaimToCin7(ctx.db as never, port, { ...ON, ...over }, "mgr@x", { orgId: ORG, projectId: ctx.projectId, claimId: ctx.claimId, confirmation });
const rec = (over: Partial<WriteGates> = {}) => reconcileClaimPosting(ctx.db as never, port, { isManager: true, ...over }, { orgId: ORG, projectId: ctx.projectId, claimId: ctx.claimId });
const row = () => ctx.db.rows("project_claim_cin7_postings")[0] as Record<string, unknown>;

beforeEach(async () => { ctx = await approvedClaim(); port = new FakePort(); });

describe("Sale link", () => {
  it("links ONE existing Advanced Sale after a single read; permanent; one per project", async () => {
    const l = await link();
    expect(port.reads).toBe(1);
    expect(port.created).toEqual([]);
    expect(l).toMatchObject({ cin7_sale_id: SALE_ID, cin7_sale_number: "SO-00015", tax_rule: "Standard Rate Sales", revenue_account: "200", link_status: "LINKED" });
    expect(await err(link())).toMatch(/already linked/);
  });
  it("refuses a non-manager, a non-enabled org, a bad id, a non-Advanced or unauthorised sale, a missing account", async () => {
    const go = (g: Partial<WriteGates>, saleId = SALE_ID, acct = "200") => linkCin7Sale(ctx.db as never, port, { ...ON, ...g }, "x", { orgId: ORG, projectId: ctx.projectId, instanceId: "i", saleId, revenueAccount: acct });
    expect(await err(go({ isManager: false }))).toMatch(/manager/);
    expect(await err(go({ orgEnabled: false }))).toMatch(/not enabled/);
    expect(await err(go({}, "SO-00015"))).toMatch(/GUID/);
    expect(await err(go({}, SALE_ID, " "))).toMatch(/account/);
    port.sale.type = "Simple Sale"; expect(await err(go({}))).toMatch(/Advanced Sale/);
    port.sale = { ...port.sale, type: "Advanced Sale", orderStatus: "DRAFT" }; expect(await err(go({}))).toMatch(/AUTHORISED/);
    expect(ctx.db.rows("project_cin7_sale_links")).toHaveLength(0);
  });
});

describe("posting gates are enforced server-side", () => {
  beforeEach(async () => { await link(); });
  it.each([
    ["the feature flag is off", { writesEnabled: false }, /switched off/],
    ["the org is not the rollout org", { orgEnabled: false }, /not enabled/],
    ["the caller is not a manager", { isManager: false }, /manager/],
  ])("blocked when %s — and NOTHING is sent or recorded", async (_n, gate, msg) => {
    expect(await err(post(gate))).toMatch(msg);
    expect(port.created).toEqual([]);
    expect(ctx.db.rows("project_claim_cin7_postings")).toHaveLength(0);
  });
  it("requires the exact confirmation text", async () => {
    expect(await err(post({}, "yes"))).toMatch(/confirmation/);
    expect(port.created).toEqual([]);
  });
  it("blocked without a linked Sale", async () => {
    ctx.db.tables.project_cin7_sale_links = [];
    expect(await err(post())).toMatch(/no linked Cin7 Sale/);
  });
  it("blocked for a DRAFT or READY_FOR_APPROVAL claim", async () => {
    for (const status of ["DRAFT", "READY_FOR_APPROVAL"]) {
      (ctx.db.rows("project_claims")[0] as Record<string, unknown>).status = status;
      expect(await err(post())).toMatch(new RegExp(`Only an APPROVED claim.*${status}`));
    }
    expect(port.created).toEqual([]);
  });
  it("blocked on a project that is not ACTIVE", async () => {
    (ctx.db.rows("projects")[0] as Record<string, unknown>).status = "CLOSED";
    expect(await err(post())).toMatch(/ACTIVE/);
  });
});

describe("a successful post", () => {
  beforeEach(async () => { await link(); });
  it("creates exactly one invoice from the FROZEN approved claim: R950,000 + R142,500 = R1,092,500, two charges, no stock lines", async () => {
    const r = await post();
    expect(r).toMatchObject({ state: "CREATED", alreadyPosted: false });
    expect(port.created).toHaveLength(1);
    const req = port.created[0];
    expect(req.charges.map((c) => [c.description, c.priceExVat])).toEqual([["PRJ-NQ-Q-0001 - Manufacturing progress claim C01", 450_000], ["PRJ-NQ-Q-0001 - Delivery progress claim C01", 500_000]]);
    expect(req.charges.every((c) => c.taxRatePct === 15)).toBe(true);
    expect(row()).toMatchObject({ posting_state: "CREATED", amount_ex_vat_cents: R(950_000), tax_cents: R(142_500), total_cents: R(1_092_500), cin7_invoice_number: "INV-00100", cin7_task_id: "task-1", attempt_count: 1 });
  });
  it("the request body has NO stock lines, a DRAFT status, the stable memo, net charge totals and the linked tax rule / account", async () => {
    await post();
    const body = buildProgressInvoiceBody(port.created[0]) as { Lines: unknown[]; AdditionalCharges: Array<Record<string, unknown>> };
    expect(body.Lines).toEqual([]);
    expect(body).toMatchObject({ SaleID: SALE_ID, Status: "DRAFT", CombineAdditionalCharges: false, Memo: "NEWQUIP-PROJECTS:PRJ-NQ-Q-0001:PRJ-NQ-Q-0001-C01", TaskID: "00000000-0000-0000-0000-000000000000" });
    expect(body.AdditionalCharges).toHaveLength(2);
    for (const c of body.AdditionalCharges) expect(c).toMatchObject({ Quantity: 1, Discount: 0, Tax: 15, TaxRule: "Standard Rate Sales", Account: "200", Total: c.Price });
  });
  it("memo and idempotency key are stable and follow the contract", async () => {
    await post();
    const claimId = ctx.claimId;
    expect(row().memo).toBe(memoFor("PRJ-NQ-Q-0001", "PRJ-NQ-Q-0001-C01"));
    expect(row().idempotency_key).toBe(`NEWQUIP:PRJ-NQ-Q-0001:PRJ-NQ-Q-0001-C01:${claimId}`);
    expect(idempotencyKeyFor("P", "P-C01", "id")).toBe("NEWQUIP:P:P-C01:id");
  });
  it("uses the approved values even if progress moves afterwards (no recalculation)", async () => {
    const v = (await loadProjectView(ctx.db as never, ORG, ctx.projectId))!;
    await recordProgress(ctx.db as never, ORG, "x", { projectId: ctx.projectId, stageId: v.stages.find((s) => s.name === "Delivery")!.id, reportedPct: "90", approvedPct: "90", comment: "moved" });
    await post();
    expect(row()).toMatchObject({ amount_ex_vat_cents: R(950_000), total_cents: R(1_092_500) });
  });
  it("a second click returns the existing result and sends NOTHING", async () => {
    await post();
    const again = await post();
    expect(again).toMatchObject({ alreadyPosted: true, state: "CREATED" });
    expect(port.created).toHaveLength(1);
    expect(ctx.db.rows("project_claim_cin7_postings")).toHaveLength(1);
  });
  it("two concurrent attempts create ONE posting and ONE external call", async () => {
    const results = await Promise.allSettled([post(), post()]);
    expect(results.filter((r) => r.status === "fulfilled" && !(r.value as { alreadyPosted: boolean }).alreadyPosted)).toHaveLength(1);
    expect(port.created).toHaveLength(1);
    expect(ctx.db.rows("project_claim_cin7_postings")).toHaveLength(1);
  });
  it("a CREATED posting cannot be retried (reconciliation is the only next step)", async () => {
    await post();
    row().posting_state = "CREATED";
    expect((await post()).alreadyPosted).toBe(true);
    expect(port.created).toHaveLength(1);
  });
  it("surfaces a Cin7 amount mismatch instead of absorbing it", async () => {
    port.next = { kind: "created", invoiceNumber: "INV-1", taskId: "t", status: "DRAFT", totalBeforeTax: 950_000, tax: 142_499, total: 1_092_499 };
    const r = await post();
    expect(r.message).toMatch(/does not match the approved claim/);
    expect(row()).toMatchObject({ posting_state: "CREATED", last_error_code: "AMOUNT_MISMATCH" });
  });
});

describe("failures", () => {
  beforeEach(async () => { await link(); });
  it("a Cin7 4xx is FAILED_CONFIRMED_NO_WRITE with the safe message; a controlled retry reuses the SAME row, key and memo", async () => {
    port.next = { kind: "rejected", httpStatus: 400, message: "Total is invalid" };
    const r = await post();
    expect(r).toMatchObject({ state: "FAILED_CONFIRMED_NO_WRITE", message: "Cin7 rejected the request. No invoice was created." });
    const key = row().idempotency_key, memo = row().memo;
    port.next = null;
    const again = await post();
    expect(again.state).toBe("CREATED");
    expect(ctx.db.rows("project_claim_cin7_postings")).toHaveLength(1);
    expect(row()).toMatchObject({ idempotency_key: key, memo, attempt_count: 2 });
    expect(port.created).toHaveLength(2);
  });
  it("an uncertain outcome is FAILED_UNCERTAIN and can NOT be retried without reconciliation", async () => {
    port.next = { kind: "uncertain", reason: "timeout" };
    expect(await post()).toMatchObject({ state: "FAILED_UNCERTAIN", message: "The request outcome is uncertain. Do not retry until Cin7 has been reconciled." });
    port.next = null;
    expect(await err(post())).toMatch(/Do not retry until Cin7 has been reconciled/);
    expect(port.created).toHaveLength(1);
  });
  it("a thrown error from the port is treated as UNCERTAIN, never as a safe failure", async () => {
    port.next = "throw";
    expect((await post()).state).toBe("FAILED_UNCERTAIN");
  });
  it("PENDING blocks a second attempt (in flight)", async () => {
    port.next = { kind: "uncertain", reason: "x" };
    await post();
    row().posting_state = "PENDING"; row().requested_at = new Date().toISOString();
    expect(await err(post())).toMatch(/already in progress/);
    expect(port.created).toHaveLength(1);
  });
  it("a retry is refused if the approved claim no longer matches the original request", async () => {
    port.next = { kind: "rejected", httpStatus: 400, message: "x" };
    await post();
    row().request_fingerprint = "different";
    port.next = null;
    expect(await err(post())).toMatch(/no longer matches the original request/);
  });
});

describe("reconciliation (read-only)", () => {
  beforeEach(async () => { await link(); });
  it("finds the invoice by memo + amounts → RECONCILED, updates the link, and never writes to Cin7", async () => {
    await post();
    port.landed(port.created[0]);
    const writes = port.created.length;
    const r = await rec();
    expect(r).toMatchObject({ state: "RECONCILED" });
    expect(row()).toMatchObject({ posting_state: "RECONCILED" });
    expect(ctx.db.rows("project_cin7_sale_links")[0].last_reconciled_at).toBeTruthy();
    expect(port.created.length).toBe(writes);
  });
  it("an uncertain write whose invoice DID land is recovered to CREATED then RECONCILED — never re-sent", async () => {
    port.next = { kind: "uncertain", reason: "timeout" };
    await post();
    port.landed(port.created[0]);
    expect((await rec()).state).toBe("RECONCILED");
    expect(row().cin7_invoice_number).toBe("INV-00100");
    expect(port.created).toHaveLength(1);
  });
  it("an uncertain write with NO invoice in Cin7 → FAILED_CONFIRMED_NO_WRITE, and only then a retry is permitted", async () => {
    port.next = { kind: "uncertain", reason: "timeout" };
    await post();
    expect((await rec()).state).toBe("FAILED_CONFIRMED_NO_WRITE");
    port.next = null;
    expect((await post()).state).toBe("CREATED");
    expect(port.created).toHaveLength(2);
  });
  it("a found invoice with different amounts is an explicit MISMATCH — not reconciled, and no retry becomes possible", async () => {
    port.next = { kind: "uncertain", reason: "timeout" };
    await post();
    port.landed(port.created[0], { subtotalCents: R(949_999) });
    const r = await rec();
    expect(r.message).toMatch(/does not match the approved claim/);
    expect(row()).toMatchObject({ posting_state: "CREATED", last_error_code: "AMOUNT_MISMATCH" });
    port.next = null;
    expect((await post()).alreadyPosted).toBe(true);
    expect(port.created).toHaveLength(1);
  });
  it("several invoices with the memo fail closed; a voided one is ignored", async () => {
    port.next = { kind: "uncertain", reason: "t" };
    await post();
    port.landed(port.created[0]); port.landed(port.created[0]);
    expect(await err(rec())).toMatch(/2 invoices/);
    port.sale.invoices = []; port.landed(port.created[0], { status: "VOIDED" });
    expect((await rec()).state).toBe("FAILED_CONFIRMED_NO_WRITE");
  });
  it("a CREATED posting whose invoice is missing in Cin7 is reported, not released", async () => {
    await post();
    expect(await err(rec())).toMatch(/NOT found in Cin7/);
    expect(row().posting_state).toBe("CREATED");
  });
  it("an orphaned (stale) PENDING is treated as uncertain and reconciled; a fresh one is in flight", async () => {
    port.next = { kind: "uncertain", reason: "t" };
    await post();
    row().posting_state = "PENDING"; row().requested_at = new Date().toISOString();
    expect(await err(rec())).toMatch(/in progress/);
    row().requested_at = new Date(Date.now() - 10 * 60_000).toISOString();
    port.landed(port.created[0]);
    expect((await rec()).state).toBe("RECONCILED");
  });
  it("only a manager can reconcile; nothing to reconcile before a send", async () => {
    expect(await err(rec({ isManager: false }))).toMatch(/manager/);
    expect(await err(rec())).toMatch(/nothing to reconcile/);
  });
});

describe("pure rules", () => {
  const link = { id: "l", cin7_sale_id: SALE_ID, tax_rule: "Standard Rate Sales", revenue_account: "200" };
  const claim = { id: "c", claim_number: "P-C01", status: "APPROVED", tax_rate_bps: 1500, subtotal_cents: 1000, tax_cents: 150, total_cents: 1150 };
  it("plan is deterministic (same fingerprint) and refuses a claim whose VAT would not reconcile in Cin7", () => {
    const lines = [{ stage_name: "A", current_claim_cents: 1000, tax_cents: 150 }];
    const a = buildPostingPlan({ projectRef: "P", claim, lines, link }), b = buildPostingPlan({ projectRef: "P", claim, lines, link });
    expect(a.ok && b.ok && a.plan.fingerprint === b.plan.fingerprint).toBe(true);
    expect(buildPostingPlan({ projectRef: "P", claim, lines: [{ stage_name: "A", current_claim_cents: 1000, tax_cents: 149 }], link }).ok).toBe(false);
    expect(buildPostingPlan({ projectRef: "P", claim: { ...claim, subtotal_cents: 999 }, lines, link }).ok).toBe(false);
    expect(buildPostingPlan({ projectRef: "P", claim: { ...claim, status: "DRAFT" }, lines, link }).ok).toBe(false);
  });
  it("matchInvoices matches by EXACT memo only", () => {
    const inv = { invoiceNumber: "I", taskId: "t", memo: "M", status: "DRAFT", subtotalCents: 1, taxCents: 0, totalCents: 1 };
    const p = { memo: "M", amount_ex_vat_cents: 1, tax_cents: 0, total_cents: 1 };
    expect(matchInvoices([inv], p).kind).toBe("matched");
    expect(matchInvoices([{ ...inv, memo: "M2" }, { ...inv, memo: "m" }], p).kind).toBe("not_found");
  });
});

describe("posting never touches stock or other tables", () => {
  it("only the posting table is written during a send; project_cin7_links is untouched", async () => {
    await link();
    const before = ctx.db.writes.length;
    await post();
    const tables = new Set(ctx.db.writes.slice(before).map((w) => w.table));
    expect([...tables].sort()).toEqual(["project_claim_cin7_postings"]);
    expect(ctx.db.rows("project_cin7_links")).toHaveLength(0);
    expect((await listPostings(ctx.db as never, ORG, ctx.projectId))).toHaveLength(1);
  });
});
