import { describe, expect, it } from "vitest";
import { statusLabel, verifyInvoiceStatuses } from "../invoice-verification";
import type { Cin7SaleView, PostingRow } from "../cin7-posting-store";
import type { ReadInvoice } from "../cin7-posting";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const posting = (n: string | null, status: string | null, over: Partial<PostingRow> = {}): PostingRow => ({
  id: `po-${n}`, claim_id: `cl-${n}`, sale_link_id: "l1", idempotency_key: "k", request_fingerprint: "f", memo: "m", posting_state: "RECONCILED", attempt_count: 1,
  amount_ex_vat_cents: 100, tax_cents: 15, total_cents: 115, cin7_sale_id: "sale-1", cin7_invoice_number: n, cin7_task_id: `t-${n}`, cin7_status: status,
  requested_by_email: "a@b", requested_at: "x", completed_at: null, reconciled_at: null, last_error_code: null, last_error_message: null, ...over,
});
const inv = (n: string | null, status: string | null, over: Partial<ReadInvoice> = {}): ReadInvoice => ({ invoiceNumber: n, taskId: `t-${n}`, memo: null, status, subtotalCents: 100, taxCents: 15, totalCents: 115, ...over });
const sale = (invoices: ReadInvoice[], id = "sale-1"): Cin7SaleView => ({ id, saleNumber: "SO-00027", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: null, invoices });
const run = (postings: PostingRow[], s: Cin7SaleView) => verifyInvoiceStatuses({ saleId: "sale-1", postings, sale: s, now: NOW });

describe("verifyInvoiceStatuses (UAT-028)", () => {
  it("shows the recorded status and the current Cin7 status side by side - INV-00034..36 recorded Draft, now Authorised; INV-00037 unchanged", () => {
    const r = run(
      [posting("INV-00034", "DRAFT"), posting("INV-00035", "DRAFT"), posting("INV-00036", "DRAFT"), posting("INV-00037", "AUTHORISED")],
      sale([inv("INV-00034", "AUTHORISED"), inv("INV-00035", "AUTHORISED"), inv("INV-00036", "AUTHORISED"), inv("INV-00037", "AUTHORISED")]),
    );
    expect(r.invoices.map((i) => [i.invoiceNumber, i.recordedStatus, i.currentStatus, i.outcome])).toEqual([
      ["INV-00034", "DRAFT", "AUTHORISED", "CHANGED"], ["INV-00035", "DRAFT", "AUTHORISED", "CHANGED"], ["INV-00036", "DRAFT", "AUTHORISED", "CHANGED"], ["INV-00037", "AUTHORISED", "AUTHORISED", "SAME"],
    ]);
    expect(r.verifiedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(r.saleNumber).toBe("SO-00027");
    expect(r.unaccounted).toEqual([]);
  });
  it("never reports a status as current unless the Sale read said so: a Toolbox 'AUTHORISED' record with Cin7 still Draft is CHANGED to Draft", () => {
    const r = run([posting("INV-1", "AUTHORISED")], sale([inv("INV-1", "DRAFT")]));
    expect(r.invoices[0]).toMatchObject({ recordedStatus: "AUTHORISED", currentStatus: "DRAFT", outcome: "CHANGED" });
  });
  it("is case- and whitespace-tolerant about the status text only", () => {
    expect(run([posting("INV-1", "draft")], sale([inv("INV-1", " Draft ")])).invoices[0].outcome).toBe("SAME");
  });
  it("an invoice that is not on the Sale is reported NOT_IN_SALE with no current status (voided/removed is Cin7's to say, not guessed)", () => {
    const r = run([posting("INV-9", "DRAFT")], sale([inv("INV-1", "DRAFT")]));
    expect(r.invoices[0]).toMatchObject({ outcome: "NOT_IN_SALE", currentStatus: null });
    expect(r.unaccounted).toEqual([{ invoiceNumber: "INV-1", status: "DRAFT" }]);
  });
  it("two invoices with the same number are ambiguous and are not guessed", () => {
    expect(run([posting("INV-1", "DRAFT")], sale([inv("INV-1", "DRAFT"), inv("INV-1", "AUTHORISED", { taskId: "other" })])).invoices[0].outcome).toBe("NOT_IN_SALE");
  });
  it("the same number with a different Cin7 task id is an identity mismatch and is not trusted", () => {
    expect(run([posting("INV-1", "DRAFT", { cin7_task_id: "t-recorded" })], sale([inv("INV-1", "AUTHORISED", { taskId: "t-other" })])).invoices[0].outcome).toBe("IDENTITY_MISMATCH");
  });
  it("a missing task id on either side does not block a number match", () => {
    expect(run([posting("INV-1", "DRAFT", { cin7_task_id: null })], sale([inv("INV-1", "AUTHORISED")])).invoices[0].outcome).toBe("CHANGED");
    expect(run([posting("INV-1", "DRAFT")], sale([inv("INV-1", "AUTHORISED", { taskId: null })])).invoices[0].outcome).toBe("CHANGED");
  });
  it("an invoice Cin7 gives no status for is STATUS_UNREADABLE, not 'same' and not 'changed'", () => {
    expect(run([posting("INV-1", "DRAFT")], sale([inv("INV-1", null)])).invoices[0]).toMatchObject({ outcome: "STATUS_UNREADABLE", currentStatus: null });
  });
  it("only postings that produced an invoice are checked", () => {
    const r = run([posting(null, null, { posting_state: "FAILED_CONFIRMED_NO_WRITE" }), posting("INV-2", "DRAFT", { posting_state: "PENDING" }), posting("INV-3", "DRAFT", { posting_state: "FAILED_UNCERTAIN" }), posting("INV-4", "DRAFT", { posting_state: "CREATED" })], sale([inv("INV-4", "DRAFT")]));
    expect(r.invoices.map((i) => i.invoiceNumber)).toEqual(["INV-4"]);
  });
  it("invoices on the Sale that no posting accounts for are listed, never attached to a claim", () => {
    expect(run([posting("INV-1", "DRAFT")], sale([inv("INV-1", "DRAFT"), inv("INV-77", "AUTHORISED")])).unaccounted).toEqual([{ invoiceNumber: "INV-77", status: "AUTHORISED" }]);
  });
  it("refuses a Sale that is not the linked one: nothing is verified", () => {
    expect(() => run([posting("INV-1", "DRAFT")], sale([inv("INV-1", "DRAFT")], "another-sale"))).toThrow(/different Sale/);
  });
  it("does not modify the postings it was given (the historical record is untouched)", () => {
    const ps = [posting("INV-1", "DRAFT")];
    const before = JSON.stringify(ps);
    run(ps, sale([inv("INV-1", "AUTHORISED")]));
    expect(JSON.stringify(ps)).toBe(before);
    expect(Object.isFrozen(ps)).toBe(false); // plain data in, plain data out: there is no write path in this module
  });
  it("labels", () => { expect(statusLabel("AUTHORISED")).toBe("Authorised"); expect(statusLabel(null)).toBe("Not read"); expect(statusLabel("PARTIALLY PAID")).toBe("Partially paid"); });
});
