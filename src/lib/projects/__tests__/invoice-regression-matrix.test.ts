// INVOICE REGRESSION MATRIX (post-integration validation). One named test per failure class the corrected writer must refuse or surface,
// exercised end to end through the real writer body builder, the real posting store and reconciliation, with Cin7 modelled by a fake.
// INV-00021 (VAT R30 instead of R142,500, totals NaN) stays on record as the failed financial proof these tests encode.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, setOpeningCommitments, submitClaimForApproval } from "../project-store";
import { linkCin7Sale, postClaimToCin7, reconcileClaimPosting, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT, matchInvoices, type ReadInvoice } from "../cin7-posting";
import { buildProgressInvoiceBody, createSaleProgressInvoice } from "@/cin7/sale-invoice-write";
import { Cin7ApiError, cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async () => {
  class Cin7ApiError extends Error {
    constructor(public status: number, message: string, public retryable: boolean, public ambiguous: boolean = false) { super(message); }
  }
  return { Cin7ApiError, cin7Request: vi.fn() };
});

const ORG = "org-a";
const SALE_ID = "4fe3d99c-241d-4404-8795-4c448842108b";
const OTHER_SALE = "d99db61e-2af5-497b-81b2-e5610c251056";
const R = (n: number) => n * 100;
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

class Port implements Cin7Port {
  sale: Cin7SaleView = { id: SALE_ID, saleNumber: "SO-1", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [], orderLines: [{ productId: "p1", sku: "A", name: "A", quantity: 10 }], shipped: { A: 10 } };
  created: InvoiceRequest[] = [];
  /** What Cin7 stores after a create (the test decides how wrong it is) and what the POST echoes. */
  stored: ((req: InvoiceRequest) => ReadInvoice) | null = null;
  echo: ((req: InvoiceRequest) => InvoiceOutcome) | null = null;
  async fetchSale() { return structuredClone(this.sale); }
  async createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.created.push(req);
    const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0); const tax = req.charges.reduce((n, c) => n + c.taxAmount, 0);
    const good: ReadInvoice = { invoiceNumber: "INV-100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: Math.round(sub * 100), taxCents: Math.round(tax * 100), totalCents: Math.round((sub + tax) * 100), lines: (req.lines ?? []).map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })) };
    this.sale.invoices.push(this.stored ? this.stored(req) : good);
    return this.echo ? this.echo(req) : { kind: "created", invoiceNumber: "INV-100", taskId: "t1", status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax };
  }
}

let db: FakeDb; let projectId: string; let claimId: string; let port: Port;
async function setup() {
  db = new FakeDb(); port = new Port();
  projectId = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "n" });
  const v = (await loadProjectView(db as never, ORG, projectId))!;
  const st = (n: string) => v.stages.find((s) => s.name.startsWith(n))!.id;
  const rec = (n: string, a: string, b: string) => recordProgress(db as never, ORG, "x@x", { projectId, stageId: st(n), reportedPct: a, approvedPct: b, comment: "c" });
  await rec("Deposit", "100", "100"); await rec("Manufacturing", "75", "65"); await rec("Delivery", "25", "25");
  await setOpeningCommitments(db as never, ORG, "m@x", { projectId, reason: "opening", items: [{ stageId: st("Deposit"), amountCents: R(1_000_000) }, { stageId: st("Manufacturing"), amountCents: R(1_500_000) }] });
  claimId = (await createClaimDraft(db as never, ORG, "x@x", projectId)).claimId;
  await submitClaimForApproval(db as never, ORG, projectId, claimId);
  await approveClaim(db as never, ORG, "mgr@x", projectId, claimId);
  await linkCin7Sale(db as never, port, ON, "mgr@x", { orgId: ORG, projectId, instanceId: "i", saleId: SALE_ID, revenueAccount: "200" });
}
const post = (physicalLines?: Array<{ sku: string; quantity: number }>) => postClaimToCin7(db as never, port, ON, "mgr@x", { orgId: ORG, projectId, claimId, confirmation: POST_CONFIRMATION_TEXT, physicalLines });
const rec = () => reconcileClaimPosting(db as never, port, { isManager: true }, { orgId: ORG, projectId, claimId });
const row = () => db.rows("project_claim_cin7_postings")[0] as Record<string, unknown>;
beforeEach(setup);

describe("1. missing monetary fields", () => {
  const input = { saleId: "s", memo: "m", invoiceDate: "2026-10-28", invoiceDueDate: "2026-11-27", taxRule: "r", account: "200" };
  it("the writer refuses to build a body from a missing price or VAT", () => {
    expect(() => buildProgressInvoiceBody({ ...input, charges: [{ description: "d", priceExVat: undefined as never, taxAmount: 1 }] })).toThrow();
    expect(() => buildProgressInvoiceBody({ ...input, charges: [{ description: "d", priceExVat: 1, taxAmount: undefined as never }] })).toThrow();
  });
  it("Cin7 returning no totals AND no readable read-back is a surfaced mismatch, never a match", async () => {
    port.echo = () => ({ kind: "created", invoiceNumber: "INV-100", taskId: "t1", status: "DRAFT", totalBeforeTax: null, tax: null, total: null });
    port.stored = (req) => ({ invoiceNumber: "INV-100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: null, taxCents: null, totalCents: null });
    const r = await post();
    expect(r.state).toBe("CREATED");
    expect(row()).toMatchObject({ last_error_code: "AMOUNT_MISMATCH" });
    expect(r.message).toMatch(/not returned by Cin7/);
    expect((await rec()).state).toBe("CREATED"); // still not RECONCILED
    expect(row().posting_state).not.toBe("RECONCILED");
  });
});

describe("2. non-finite amounts", () => {
  const base = { saleId: "s", memo: "m", invoiceDate: "2026-10-28", invoiceDueDate: "2026-11-27", taxRule: "r", account: "200" };
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5])("price %s is refused", (bad) => {
    expect(() => buildProgressInvoiceBody({ ...base, charges: [{ description: "d", priceExVat: bad, taxAmount: 1 }] })).toThrow();
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("VAT %s is refused", (bad) => {
    expect(() => buildProgressInvoiceBody({ ...base, charges: [{ description: "d", priceExVat: 10, taxAmount: bad }] })).toThrow();
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("physical quantity %s is refused", (bad) => {
    expect(() => buildProgressInvoiceBody({ ...base, charges: [{ description: "d", priceExVat: 10, taxAmount: 1 }], lines: [{ productId: "p", sku: "A", name: "A", quantity: bad }] })).toThrow();
  });
  it("a Cin7 response with non-finite numbers is read as unknown (null), not as a number", async () => {
    vi.mocked(cin7Request).mockResolvedValueOnce({ Invoices: [{ InvoiceNumber: "INV-1", TaskID: "t", Memo: "m", Status: "DRAFT", TotalBeforeTax: "NaN", Tax: Number.POSITIVE_INFINITY, Total: "abc" }] });
    const r = await createSaleProgressInvoice({} as never, { saleId: "s", memo: "m", invoiceDate: "d", invoiceDueDate: "d", taxRule: "r", account: "200", charges: [{ description: "d", priceExVat: 10, taxAmount: 1 }] });
    expect(r).toMatchObject({ kind: "created", totalBeforeTax: null, tax: null, total: null });
  });
});

describe("3. incorrect VAT (the INV-00021 shape)", () => {
  it("VAT sent as a rate (R15 per charge) is exposed: R30 vs approved R142,500, never RECONCILED", async () => {
    port.echo = () => ({ kind: "created", invoiceNumber: "INV-100", taskId: "t1", status: "DRAFT", totalBeforeTax: 950_000, tax: 30, total: 950_030 });
    port.stored = (req) => ({ invoiceNumber: "INV-100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: R(950_000), taxCents: 3000, totalCents: R(950_000) + 3000 });
    const r = await post();
    expect(r.message).toMatch(/VAT R30\.00 vs approved R142500\.00/);
    expect(row()).toMatchObject({ posting_state: "CREATED", last_error_code: "AMOUNT_MISMATCH" });
    expect((await rec()).state).toBe("CREATED");
  });
  it("the request itself carries the VAT as an amount that sums to R142,500", async () => {
    await post();
    expect(port.created[0].charges.reduce((n, c) => n + c.taxAmount, 0)).toBe(142_500);
    expect(port.created[0].charges.every((c) => c.taxAmount > 15)).toBe(true);
  });
});

describe("4. incorrect invoice totals", () => {
  it.each([
    ["ex VAT", { subtotalCents: R(950_000) + 1 }],
    ["total", { totalCents: R(1_092_500) - 1 }],
  ])("a wrong %s is a mismatch", async (_n, over) => {
    port.stored = (req) => ({ invoiceNumber: "INV-100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: R(950_000), taxCents: R(142_500), totalCents: R(1_092_500), ...over });
    port.echo = () => ({ kind: "created", invoiceNumber: "INV-100", taskId: "t1", status: "DRAFT", totalBeforeTax: null, tax: null, total: null });
    await post();
    expect(row()).toMatchObject({ last_error_code: "AMOUNT_MISMATCH" });
  });
  it("matchInvoices demands exact cents", () => {
    const inv: ReadInvoice = { invoiceNumber: "I", taskId: "t", memo: "m", status: "DRAFT", subtotalCents: 100, taxCents: 15, totalCents: 115 };
    expect(matchInvoices([inv], { memo: "m", amount_ex_vat_cents: 100, tax_cents: 15, total_cents: 115 }).kind).toBe("matched");
    expect(matchInvoices([{ ...inv, totalCents: 116 }], { memo: "m", amount_ex_vat_cents: 100, tax_cents: 15, total_cents: 115 }).kind).toBe("mismatch");
  });
});

describe("5. incorrect physical quantities", () => {
  it("over-invoicing is refused before any intent exists; a wrong quantity read back is a mismatch", async () => {
    expect(await err(post([{ sku: "A", quantity: 11 }]))).toMatch(/remain invoiceable/);
    expect(db.rows("project_claim_cin7_postings")).toHaveLength(0);
    port.stored = (req) => ({ invoiceNumber: "INV-100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: R(950_000), taxCents: R(142_500), totalCents: R(1_092_500), lines: [{ sku: "A", quantity: 9, priceCents: 0 }] });
    port.echo = () => ({ kind: "created", invoiceNumber: "INV-100", taskId: "t1", status: "DRAFT", totalBeforeTax: null, tax: null, total: null });
    await post([{ sku: "A", quantity: 4 }]);
    expect(row()).toMatchObject({ last_error_code: "AMOUNT_MISMATCH" });
  });
});

describe("6. wrong Sale or scope", () => {
  it("a project with no linked Sale cannot post; a claim cannot be posted through another project", async () => {
    const other = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), sourceQuoteRef: "OTHER" }, { reference: "PRJ-OTHER", name: "o" });
    expect(await err(postClaimToCin7(db as never, port, ON, "m", { orgId: ORG, projectId: other, claimId, confirmation: POST_CONFIRMATION_TEXT }))).toMatch(/no linked Cin7 Sale/);
    await linkCin7Sale(db as never, port, ON, "m", { orgId: ORG, projectId: other, instanceId: "i", saleId: OTHER_SALE, revenueAccount: "200" }).catch(() => undefined);
    expect(await err(postClaimToCin7(db as never, port, ON, "m", { orgId: ORG, projectId: other, claimId, confirmation: POST_CONFIRMATION_TEXT }))).toBeDefined();
    expect(port.created).toHaveLength(0);
  });
  it("the request always targets the project's own linked Sale; another org cannot reach the claim", async () => {
    await post();
    expect(port.created[0].saleId).toBe(SALE_ID);
    expect(await err(postClaimToCin7(db as never, port, ON, "m", { orgId: "org-b", projectId, claimId, confirmation: POST_CONFIRMATION_TEXT }))).toBeDefined();
  });
  it("a Sale that is not an authorised Advanced Sale cannot be linked", async () => {
    const p2 = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), sourceQuoteRef: "P2" }, { reference: "PRJ-P2", name: "o" });
    for (const bad of [{ type: "Simple Sale" }, { orderStatus: "DRAFT" }, { taxRule: null }, { id: "someone-else" }]) {
      port.sale = { ...port.sale, ...bad } as Cin7SaleView;
      expect(await err(linkCin7Sale(db as never, port, ON, "m", { orgId: ORG, projectId: p2, instanceId: "i", saleId: OTHER_SALE, revenueAccount: "200" }))).toBeDefined();
    }
  });
});

describe("7. duplicate memos", () => {
  it("two invoices carrying the claim's memo: reconciliation refuses to guess and changes nothing", async () => {
    await post();
    port.sale.invoices.push({ ...port.sale.invoices[0], invoiceNumber: "INV-101" });
    expect(await err(rec())).toMatch(/refusing to guess/);
    expect(row().posting_state).toBe("CREATED");
  });
  it("a 200 with two (or zero) invoices carrying our memo is UNCERTAIN, not created", async () => {
    const http = vi.mocked(cin7Request);
    const inv = (n: string) => ({ InvoiceNumber: n, TaskID: "t", Memo: "m", Status: "DRAFT" });
    const send = () => createSaleProgressInvoice({} as never, { saleId: "s", memo: "m", invoiceDate: "d", invoiceDueDate: "d", taxRule: "r", account: "200", charges: [{ description: "d", priceExVat: 10, taxAmount: 1 }] });
    http.mockResolvedValueOnce({ Invoices: [inv("I1"), inv("I2")] });
    expect((await send()).kind).toBe("uncertain");
    http.mockResolvedValueOnce({ Invoices: [] });
    expect((await send()).kind).toBe("uncertain");
  });
  it("the database-level uniqueness (one posting per claim, one memo per org) holds in the fake exactly as in 0104", async () => {
    await post();
    expect(await err(post())).toBeUndefined(); // replay returns the existing result, no second send
    expect(port.created).toHaveLength(1);
    expect(db.rows("project_claim_cin7_postings")).toHaveLength(1);
  });
});

describe("8. uncertain outcomes need reconciliation", () => {
  it("timeout -> FAILED_UNCERTAIN -> retry refused -> reconcile (nothing found) -> only then a controlled retry", async () => {
    port.createInvoice = async (req) => { port.created.push(req); return { kind: "uncertain", reason: "timeout" }; };
    expect((await post()).state).toBe("FAILED_UNCERTAIN");
    expect(await err(post())).toMatch(/uncertain/);
    expect(port.created).toHaveLength(1);
    expect((await rec()).state).toBe("FAILED_CONFIRMED_NO_WRITE");
    port.createInvoice = Port.prototype.createInvoice.bind(port);
    expect((await post()).state).toBe("CREATED");
    expect(port.created).toHaveLength(2);
    expect(row()).toMatchObject({ attempt_count: 2 });
  });
  it("an uncertain post whose invoice actually landed is recovered by reconciliation, not resent", async () => {
    port.createInvoice = async (req) => { port.created.push(req); port.sale.invoices.push({ invoiceNumber: "INV-100", taskId: "t1", memo: req.memo, status: "DRAFT", subtotalCents: R(950_000), taxCents: R(142_500), totalCents: R(1_092_500) }); return { kind: "uncertain", reason: "dropped" }; };
    await post();
    expect((await rec()).state).toBe("RECONCILED");
    expect(port.created).toHaveLength(1);
  });
  it("a definite HTTP 4xx is a confirmed no-write; the Cin7 error class is preserved", async () => {
    vi.mocked(cin7Request).mockRejectedValueOnce(new Cin7ApiError(400, "bad", false));
    const r = await createSaleProgressInvoice({} as never, { saleId: "s", memo: "m", invoiceDate: "d", invoiceDueDate: "d", taxRule: "r", account: "200", charges: [{ description: "d", priceExVat: 10, taxAmount: 1 }] });
    expect(r).toMatchObject({ kind: "rejected", httpStatus: 400 });
  });
});
