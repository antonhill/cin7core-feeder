// FINAL WORKFLOW ACCEPTANCE (non-round value). approved quotation -> Project -> Cin7 Sales Order plan -> progress claims -> Cin7 invoice payloads -> duplicate/retry/disabled safety -> displayed statuses.
// Everything runs through the REAL stores against the in-memory FakeDb; Cin7 is a local fake port that RECORDS what would be sent. Nothing here can reach the network.
// The quotation total is deliberately NOT round (R12,345,678.91 ex VAT) so cent rounding, the last-stage remainder and per-line VAT are all exercised.
import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { baselineMatchesHash } from "@/newquip/quote/baseline";
import { NEWQUIP_STANDARD_SCHEDULE, resolveScheduleChoice, splitContractBySchedule } from "@/newquip/quote/billing-schedule";
import { createQuote, createProjectFromAcceptedQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { approveClaim, createClaimDraft, loadProjectView, previewClaim, recordProgress, submitClaimForApproval } from "../project-store";
import { createSaleForProject, type SaleCreationPort } from "../cin7-sale-creation-store";
import { CREATE_CONFIRMATION_TEXT, type SaleReadBack } from "../cin7-sale-creation";
import { postClaimToCin7, reconcileClaimPosting, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT } from "../cin7-posting";
import { buildAdvancedSaleOrderBody } from "@/cin7/sale-order-write";
import { buildProgressInvoiceBody } from "@/cin7/sale-invoice-write";
import { cin7WritesEnabled } from "../write-flag";

const ORG = "org-newquip";
const rep = rolesFor("member"); const mgr = rolesFor("admin");
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const OFF: WriteGates = { ...ON, writesEnabled: false };
const CONTRACT_EX_VAT = 1_234_567_891; // R12,345,678.91, cents
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

/** Independent half-up arithmetic (BigInt), NOT the code under test. */
const shareOf = (cents: number, bps: number) => Number((BigInt(cents) * BigInt(bps) + 5000n) / 10000n);
const vatOf = (cents: number) => shareOf(cents, 1500);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function nonRoundDraft(): QuoteDraft {
  const d = readyDraft();
  const sub = (delivery: number) => evaluateDraft({ ...d, estimator: { ...d.estimator, charges: { ...d.estimator.charges, delivery } } }, ctx).budget!.totals.subtotalExTax;
  const plug = Math.round((CONTRACT_EX_VAT / 100 - (sub(1) - 1)) * 100) / 100;
  return { ...d, estimator: { ...d.estimator, charges: { ...d.estimator.charges, delivery: plug } } };
}
async function approvedQuote(db: FakeDb) {
  seedGoldenCatalogue(db as never, ORG);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, rep, id, nonRoundDraft());
  await sendToEstimator(db as never, ORG, rep, "rep@nq", id, ctx, { confirmedAmountCents: CONTRACT_EX_VAT, confirmedBy: "Farmer Joe" });
  await estimatorSignOff(db as never, ORG, rep, "est@nq", id, ctx);
  await managerApprove(db as never, ORG, mgr, "manager@nq", id, ctx);
  return id;
}

/** Cin7 Sale port that records the request it would send and serves it back as the read-back. */
function salePort() {
  const sales = new Map<string, SaleReadBack>(); const sent: Array<Parameters<SaleCreationPort["createSale"]>[0]> = [];
  const port: SaleCreationPort = {
    customerExists: async () => true, customerDefaults: async () => ({ taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }),
    resolveProducts: async (s) => ({ ids: new Map(s.map((k) => [k, `id-${k}`])), missing: [] }), assemblySkus: async () => [], stockAt: async () => [],
    createSale: async (req) => {
      sent.push(req);
      sales.set("sale-1", { id: "sale-1", type: "Advanced Sale", orderStatus: "AUTHORISED", customer: req.header.customer, externalId: req.header.externalId, taxRule: req.header.taxRule,
        lines: req.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })), charges: req.charges.map((c) => ({ description: c.description, priceCents: Math.round(c.priceExVat * 100), taxCents: Math.round(c.taxAmount * 100) })), invoiceCount: 0, fulfilmentCount: 0 });
      return { kind: "created", saleId: "sale-1", saleNumber: "SO-00042" };
    },
    readSale: async (id) => structuredClone(sales.get(id)!), findByExternalId: async () => [],
  };
  return { port, sent };
}
/** Cin7 invoice port: records every request, can be told to lose the response. Models Cin7 using the Tax it is SENT. */
class InvoicePort implements Cin7Port {
  sale: Cin7SaleView = { id: "sale-1", saleNumber: "SO-00042", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [] };
  sent: InvoiceRequest[] = []; mode: "ok" | "lost" = "ok"; fetches = 0;
  async fetchSale() { this.fetches++; return structuredClone(this.sale); }
  async createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.sent.push(req);
    const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0); const tax = req.charges.reduce((n, c) => n + c.taxAmount, 0);
    if (this.mode === "lost") { this.landed(req, sub, tax); return { kind: "uncertain", reason: "response lost (timeout)" }; } // the invoice DID land in Cin7, the reply never came back
    return { kind: "created", invoiceNumber: "INV-00100", taskId: "t1", status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax };
  }
  landed(req: InvoiceRequest, sub: number, tax: number) {
    this.sale.invoices.push({ invoiceNumber: "INV-00100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: Math.round(sub * 100), taxCents: Math.round(tax * 100), totalCents: Math.round((sub + tax) * 100), lines: [] });
  }
}

async function projectFor(db: FakeDb, quoteId: string, choice?: Parameters<typeof resolveScheduleChoice>[0]) {
  const r = resolveScheduleChoice(choice); if (!r.ok) throw new Error(r.errors.join(" "));
  const { projectId } = await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", quoteId, r.schedule);
  return { projectId, schedule: r.schedule };
}

describe("(1) approved quotation -> Project: sealed baseline preserved, stages sum exactly", () => {
  it("default 40/55/5: contract = the approved ex-VAT total to the cent, stages sum exactly, remainder on the last stage, baseline seal intact", async () => {
    const db = new FakeDb(); const quoteId = await approvedQuote(db);
    const q = (await loadQuote(db as never, ORG, quoteId))!;
    expect(q.accepted_baseline!.contractCents).toBe(CONTRACT_EX_VAT);
    expect(q.accepted_baseline!.commercial.subtotalCents).toBe(CONTRACT_EX_VAT);
    const { projectId } = await projectFor(db, quoteId);
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    expect(v.project).toMatchObject({ status: "ACTIVE", original_contract_cents: CONTRACT_EX_VAT, tax_rate_bps: 1500, originating_quote_ref: q.quote_ref });
    const exp = [shareOf(CONTRACT_EX_VAT, 4000), shareOf(CONTRACT_EX_VAT, 5500)]; exp.push(CONTRACT_EX_VAT - sum(exp));
    expect(v.stages.map((s) => [s.name, s.valueCents])).toEqual([["Deposit", exp[0]], ["Delivery", exp[1]], ["Installation", exp[2]]]);
    expect(sum(v.stages.map((s) => s.valueCents))).toBe(CONTRACT_EX_VAT);
    expect(CONTRACT_EX_VAT % 100).not.toBe(0); // genuinely non-round
    expect(v.commercial.scheduleBalanced).toBe(true);
    // sealed pricing baseline preserved verbatim on the project and still matches its seal
    const snap = db.rows("projects")[0].baseline_snapshot as { contractCents: number; provenance: { baselineHash: string } };
    expect(snap.contractCents).toBe(CONTRACT_EX_VAT);
    expect(snap.provenance.baselineHash).toBe(q.baseline_hash);
    expect(baselineMatchesHash(q.accepted_baseline!, q.baseline_hash!)).toBe(true);
    // idempotent: a second creation returns the same project
    expect(await createProjectFromAcceptedQuote(db as never, ORG, "m@nq", quoteId, NEWQUIP_STANDARD_SCHEDULE)).toEqual({ projectId, created: false });
    expect(db.rows("projects")).toHaveLength(1);
  });

  it("a custom template (33.33 / 41.67 / 25) sums exactly too, the last stage taking the cent remainder", async () => {
    const db = new FakeDb(); const quoteId = await approvedQuote(db);
    const choice = { preset: "CUSTOM" as const, stages: [{ name: "Mobilisation", percent: "33.33" }, { name: "Supply", percent: "41.67" }, { name: "Handover", percent: "25" }] };
    const { projectId } = await projectFor(db, quoteId, choice);
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    const a = shareOf(CONTRACT_EX_VAT, 3333), b = shareOf(CONTRACT_EX_VAT, 4167);
    expect(v.stages.map((s) => s.valueCents)).toEqual([a, b, CONTRACT_EX_VAT - a - b]);
    expect(sum(v.stages.map((s) => s.valueCents))).toBe(CONTRACT_EX_VAT);
    expect(v.project.original_contract_cents).toBe(CONTRACT_EX_VAT);
    expect(Math.abs(CONTRACT_EX_VAT - a - b - shareOf(CONTRACT_EX_VAT, 2500))).toBeLessThanOrEqual(2); // remainder is within cents of the exact 25%
  });
  it("a schedule that does not total 100% is refused before anything is created", () => {
    expect(resolveScheduleChoice({ preset: "CUSTOM", stages: [{ name: "A", percent: "60" }, { name: "B", percent: "39.99" }] }).ok).toBe(false);
    expect(() => splitContractBySchedule(CONTRACT_EX_VAT, [{ name: "A", bps: 5000, description: "", trigger: "" }])).toThrow(/not 100%/);
  });
});

describe("(2)-(5) claim, Cin7 Sale plan, invoice payloads, safety and statuses (default schedule)", () => {
  async function world() {
    const db = new FakeDb(); const quoteId = await approvedQuote(db); const { projectId } = await projectFor(db, quoteId);
    const sp = salePort();
    const sale = await createSaleForProject(db as never, sp.port, ON, "mgr@nq", { orgId: ORG, projectId, instanceId: "inst", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "Topigs Warden", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" });
    const view = async () => (await loadProjectView(db as never, ORG, projectId))!;
    const stageId = async (n: string) => (await view()).stages.find((s) => s.name === n)!.id;
    const progress = async (n: string, pct: string) => recordProgress(db as never, ORG, "x@nq", { projectId, stageId: await stageId(n), reportedPct: pct, approvedPct: pct, comment: "approved" });
    const claim = async () => { const { claimId } = await createClaimDraft(db as never, ORG, "x@nq", projectId); await submitClaimForApproval(db as never, ORG, projectId, claimId); await approveClaim(db as never, ORG, "mgr@nq", projectId, claimId); return claimId; };
    const post = (port: Cin7Port, claimId: string, gates: WriteGates = ON, confirmation = POST_CONFIRMATION_TEXT) => postClaimToCin7(db as never, port, gates, "mgr@nq", { orgId: ORG, projectId, claimId, confirmation });
    return { db, projectId, sp, sale, view, progress, claim, post };
  }

  it("(3a) the Cin7 Sales Order payload equals the project, to the cent, and is built WITHOUT being sent to Cin7", async () => {
    const w = await world();
    expect(w.sale).toMatchObject({ state: "RECONCILED", linked: true });
    expect(w.sp.sent).toHaveLength(1); // only the in-memory port saw it
    const req = w.sp.sent[0]; const v = await w.view();
    expect(req.charges.map((c) => Math.round(c.priceExVat * 100))).toEqual(v.stages.map((s) => s.valueCents));
    expect(sum(req.charges.map((c) => Math.round(c.priceExVat * 100)))).toBe(CONTRACT_EX_VAT);
    expect(req.charges.map((c) => Math.round(c.taxAmount * 100))).toEqual(v.stages.map((s) => vatOf(s.valueCents))); // VAT 15%, per charge, half-up
    // the real HTTP body builder accepts the plan and carries the same numbers (pure function, nothing sent)
    const body = buildAdvancedSaleOrderBody("sale-1", req.lines, req.charges) as { AdditionalCharges: Array<{ Price: number; Tax: number; Total: number }>; Lines: Array<{ Price: number }> };
    expect(body.AdditionalCharges.map((c) => Math.round(c.Price * 100))).toEqual(v.stages.map((s) => s.valueCents));
    expect(body.AdditionalCharges.every((c) => c.Total === c.Price)).toBe(true);
    expect(body.Lines.every((l) => l.Price === 0)).toBe(true); // physical lines carry quantity only; money is on the charges
    expect(req.header).toMatchObject({ taxRule: "Standard Rate Sales", customer: "Topigs Warden" });
    expect(w.db.rows("projects")[0].baseline_snapshot).toBeTruthy();
  });

  it("(2)+(3b)+(5) deposit claim then delivery claim: amounts against the approved project value, invoice payloads match to the cent, cumulative never exceeds the contract, statuses at each step", async () => {
    const w = await world(); const port = new InvoicePort(); const v0 = await w.view();
    const [dep, del, ins] = v0.stages.map((s) => s.valueCents);
    expect(v0.claims).toEqual([]);

    // Claim 1: Deposit at 100% approved
    await w.progress("Deposit", "100");
    const p1 = await previewClaim(w.db as never, ORG, w.projectId);
    expect([p1.calc.subtotalCents, p1.calc.taxCents, p1.calc.totalCents]).toEqual([dep, vatOf(dep), dep + vatOf(dep)]);
    const c1 = await w.claim();
    let v = await w.view();
    expect(v.claims[0]).toMatchObject({ status: "APPROVED", subtotal_cents: dep, tax_cents: vatOf(dep), total_cents: dep + vatOf(dep) });
    expect(v.claims[0].cin7Status).toMatchObject({ kind: "NOT_POSTED", label: "Not posted to Cin7" });
    const r1 = await w.post(port, c1);
    expect(r1).toMatchObject({ state: "CREATED", alreadyPosted: false });
    expect(port.sent).toHaveLength(1);
    const inv1 = buildProgressInvoiceBody(port.sent[0]) as { AdditionalCharges: Array<{ Price: number; Tax: number; Total: number }>; Status: string; Lines: unknown[] };
    expect(inv1.AdditionalCharges.map((c) => [Math.round(c.Price * 100), Math.round(c.Tax * 100)])).toEqual([[dep, vatOf(dep)]]);
    expect(inv1).toMatchObject({ Status: "DRAFT", Lines: [] }); // DRAFT only; never authorised by the Toolbox
    v = await w.view();
    expect(v.claims[0].cin7Status).toMatchObject({ kind: "DRAFT_CREATED", invoiceNumber: "INV-00100" });
    expect(v.claims[0].cin7Status.label).toMatch(/draft/i);
    expect(v.project.status).toBe("ACTIVE");

    // Claim 2: Delivery at 90% approved (a partial of the stage)
    await w.progress("Delivery", "90");
    const delPart = shareOf(del, 9000);
    const p2 = await previewClaim(w.db as never, ORG, w.projectId);
    expect(p2.calc.subtotalCents).toBe(delPart);
    expect(p2.calc.taxCents).toBe(vatOf(delPart));
    const c2 = await w.claim();
    await w.post(port, c2);
    const inv2 = port.sent[1];
    expect(inv2.charges.map((c) => [Math.round(c.priceExVat * 100), Math.round(c.taxAmount * 100)])).toEqual([[delPart, vatOf(delPart)]]);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1].memo).not.toBe(port.sent[0].memo); // distinct claim, distinct memo / idempotency

    // Cumulative so far never exceeds the contract; nothing left to claim until more progress is approved
    v = await w.view();
    const billed = sum(v.claims.map((c) => c.subtotal_cents));
    expect(billed).toBe(dep + delPart);
    expect(billed).toBeLessThanOrEqual(CONTRACT_EX_VAT);
    expect(await err(previewClaim(w.db as never, ORG, w.projectId))).toMatch(/nothing new to claim/);

    // Final claim: everything to 100% -> exactly the remainder, total billed == contract to the cent, then no more is claimable
    await w.progress("Delivery", "100"); await w.progress("Installation", "100");
    const p3 = await previewClaim(w.db as never, ORG, w.projectId);
    expect(p3.calc.subtotalCents).toBe(CONTRACT_EX_VAT - dep - delPart);
    const c3 = await w.claim(); await w.post(port, c3);
    v = await w.view();
    expect(sum(v.claims.map((c) => c.subtotal_cents))).toBe(CONTRACT_EX_VAT);
    expect(sum(port.sent.flatMap((r) => r.charges.map((c) => Math.round(c.priceExVat * 100))))).toBe(CONTRACT_EX_VAT); // what WOULD be invoiced in Cin7 == the contract
    expect(ins).toBeGreaterThan(0);
    expect(await err(previewClaim(w.db as never, ORG, w.projectId))).toMatch(/nothing new to claim/); // fully billed: no further claim exists
    // per-invoice VAT is rounded per charge; the sum may differ from VAT on the whole contract by whole cents only (documented, bounded)
    const vatSent = sum(port.sent.flatMap((r) => r.charges.map((c) => Math.round(c.taxAmount * 100))));
    expect(Math.abs(vatSent - vatOf(CONTRACT_EX_VAT))).toBeLessThanOrEqual(3);
  });

  it("(4a) posting the same claim twice sends ONE invoice; (4b) a lost response is UNCERTAIN, a retry is refused, reconcile finds the landed invoice and never re-sends", async () => {
    const w = await world(); const port = new InvoicePort();
    await w.progress("Deposit", "100"); const c1 = await w.claim();
    await w.post(port, c1);
    expect(await w.post(port, c1)).toMatchObject({ alreadyPosted: true, state: "CREATED" });
    expect(port.sent).toHaveLength(1);
    expect(w.db.rows("project_claim_cin7_postings")).toHaveLength(1);

    // second claim: response lost
    await w.progress("Delivery", "50"); const c2 = await w.claim();
    port.mode = "lost";
    expect(await w.post(port, c2)).toMatchObject({ state: "FAILED_UNCERTAIN", message: expect.stringMatching(/uncertain/i) });
    let v = await w.view();
    const cl2 = v.claims.find((c) => c.id === c2)!;
    expect(cl2.cin7Status).toMatchObject({ kind: "UNCERTAIN", label: "Outcome uncertain", tone: "danger" });
    expect(cl2.status).toBe("APPROVED"); // the claim row stays approved (value stays reserved); the POSTING row carries the uncertain state
    expect(w.db.rows("project_claim_cin7_postings").find((r) => r.claim_id === c2)).toMatchObject({ posting_state: "FAILED_UNCERTAIN" });
    // retry without reconciliation is refused; nothing more is sent
    port.mode = "ok";
    expect(await err(w.post(port, c2))).toMatch(/reconcil/i);
    expect(port.sent).toHaveLength(2);
    // the uncertain claim reserves its value: a new claim cannot re-bill the same stage
    await w.progress("Delivery", "60");
    // the uncertain claim's 50% stays RESERVED (its claim row is still APPROVED): a new draft can only ever carry the NEW 10% increment, never the 50% again
    const delVal = (await w.view()).stages.find((s) => s.name === "Delivery")!.valueCents;
    const pv = await previewClaim(w.db as never, ORG, w.projectId);
    const delLine = pv.calc.lines.find((l) => l.stageName === "Delivery")!;
    expect(delLine.currentClaimCents).toBeLessThan(shareOf(delVal, 6000));
    expect(Math.abs(delLine.currentClaimCents - (shareOf(delVal, 6000) - shareOf(delVal, 5000)))).toBeLessThanOrEqual(1);
    // read-only reconcile finds the invoice that landed, links it, creates nothing
    const rec = await reconcileClaimPosting(w.db as never, port, { isManager: true }, { orgId: ORG, projectId: w.projectId, claimId: c2 });
    expect(rec).toBeTruthy();
    expect(port.sent).toHaveLength(2);
    v = await w.view();
    const after = v.claims.find((c) => c.id === c2)!;
    expect(["DRAFT_CREATED", "AUTHORISED", "CREATED_OTHER"]).toContain(after.cin7Status.kind);
    expect(after.cin7Status.invoiceNumber).toBe("INV-00100");
    // and it is still ONE invoice for that claim
    expect(port.sale.invoices.filter((i) => i.memo === port.sent[1].memo)).toHaveLength(1);
  });

  it("(4c) writes disabled: refused honestly, nothing sent, nothing recorded, the claim reads 'Not posted to Cin7' and is still approved", async () => {
    const w = await world(); const port = new InvoicePort();
    await w.progress("Deposit", "100"); const c1 = await w.claim();
    expect(await err(w.post(port, c1, OFF))).toMatch(/switched off/);
    expect(await err(w.post(port, c1, { ...ON, isManager: false }))).toMatch(/manager/);
    expect(await err(w.post(port, c1, ON, "yes"))).toMatch(/confirmation/);
    expect(port.sent).toEqual([]);
    expect(w.db.rows("project_claim_cin7_postings")).toHaveLength(0);
    const v = await w.view();
    expect(v.claims[0]).toMatchObject({ status: "APPROVED" });
    expect(v.claims[0].cin7Status).toMatchObject({ kind: "NOT_POSTED", label: "Not posted to Cin7" });
    // the same gate, derived from the environment, is closed for the candidate configuration (flag false / unset / production / test runner)
    expect(cin7WritesEnabled({ NEWQUIP_CIN7_WRITES_ENABLED: "false" })).toBe(false);
    expect(cin7WritesEnabled({})).toBe(false);
    // Sale creation is gated the same way: a disabled gate stores no intent and sends nothing
    const db2 = new FakeDb(); const q2 = await approvedQuote(db2); const { projectId } = await projectFor(db2, q2); const sp = salePort();
    expect(await err(createSaleForProject(db2 as never, sp.port, OFF, "mgr@nq", { orgId: ORG, projectId, instanceId: "i", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "Topigs Warden", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" }))).toMatch(/switched off|disabled|off/i);
    expect(sp.sent).toEqual([]);
  });

  it("a Sale replay cannot create a second Sales Order", async () => {
    const w = await world();
    const again = await err(createSaleForProject(w.db as never, w.sp.port, ON, "mgr@nq", { orgId: ORG, projectId: w.projectId, instanceId: "inst", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "Topigs Warden", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" }));
    expect(again === undefined || /already|linked/i.test(again)).toBe(true);
    expect(w.sp.sent).toHaveLength(1);
  });
});
