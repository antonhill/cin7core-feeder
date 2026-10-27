import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cin7ApiError, cin7Request } from "@/cin7/http";
import { buildProgressInvoiceBody, createSaleProgressInvoice, ZERO_GUID, type ProgressInvoiceInput } from "../sale-invoice-write";

vi.mock("@/cin7/http", async () => {
  class Cin7ApiError extends Error {
    constructor(public status: number, message: string, public retryable: boolean, public ambiguous: boolean = false) { super(message); }
  }
  return { Cin7ApiError, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "SECRET-KEY", baseUrl: "https://x" };
const input: ProgressInvoiceInput = {
  saleId: "sale-1", memo: "NEWQUIP-PROJECTS:P:P-C01", invoiceDate: "2026-10-27", invoiceDueDate: "2026-11-26", taxRule: "Standard Rate Sales", account: "200",
  charges: [{ description: "P - Manufacturing progress claim C01", priceExVat: 450_000, taxRatePct: 15 }],
};
beforeEach(() => { vi.mocked(cin7Request).mockReset(); });

describe("request body — the proven P5 representation", () => {
  it("no stock lines, DRAFT, zero TaskID, charges carry net Total, memo and tax rule/account", () => {
    expect(buildProgressInvoiceBody(input)).toEqual({
      SaleID: "sale-1", TaskID: ZERO_GUID, CombineAdditionalCharges: false, Memo: input.memo, Status: "DRAFT", InvoiceDate: "2026-10-27", InvoiceDueDate: "2026-11-26", Lines: [],
      AdditionalCharges: [{ Description: input.charges[0].description, Quantity: 1, Price: 450_000, Discount: 0, Tax: 15, Total: 450_000, TaxRule: "Standard Rate Sales", Account: "200" }],
    });
  });
});

describe("outcome classification", () => {
  it("sends ONE non-idempotent POST /sale/invoice (no automatic resend)", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ Invoices: [{ InvoiceNumber: "INV-1", TaskID: "t", Memo: input.memo, Status: "DRAFT", TotalBeforeTax: 450000, Tax: 67500, Total: 517500 }] });
    await createSaleProgressInvoice(creds, input);
    expect(cin7Request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cin7Request).mock.calls[0][1]).toBe("/sale/invoice");
    expect(vi.mocked(cin7Request).mock.calls[0][2]).toMatchObject({ method: "POST", nonIdempotentCreate: true });
  });
  it("created only with positive evidence: an invoice carrying OUR memo (the historic voided one is ignored)", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ Invoices: [{ InvoiceNumber: "INV-1", TaskID: "t", Memo: input.memo, Status: "DRAFT", TotalBeforeTax: 450000, Tax: 67500, Total: 517500 }, { InvoiceNumber: "INV-0", TaskID: "o", Memo: "", Status: "VOIDED" }] });
    expect(await createSaleProgressInvoice(creds, input)).toMatchObject({ kind: "created", invoiceNumber: "INV-1", taskId: "t", total: 517500 });
  });
  it("a 200 WITHOUT our memo is UNCERTAIN, not created", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ Invoices: [{ InvoiceNumber: "INV-9", TaskID: "t", Memo: "other" }] });
    expect((await createSaleProgressInvoice(creds, input)).kind).toBe("uncertain");
    vi.mocked(cin7Request).mockResolvedValue({});
    expect((await createSaleProgressInvoice(creds, input)).kind).toBe("uncertain");
  });
  it("a 4xx is a confirmed rejection; ambiguous / 5xx / 503 / unknown errors are UNCERTAIN", async () => {
    vi.mocked(cin7Request).mockRejectedValue(new Cin7ApiError(400, "bad total", false));
    expect(await createSaleProgressInvoice(creds, input)).toEqual({ kind: "rejected", httpStatus: 400, message: "bad total" });
    for (const e of [new Cin7ApiError(0, "net", false, true), new Cin7ApiError(500, "x", false), new Cin7ApiError(503, "x", true), new Cin7ApiError(429, "x", true), new Error("weird")]) {
      vi.mocked(cin7Request).mockRejectedValue(e);
      expect((await createSaleProgressInvoice(creds, input)).kind).toBe("uncertain");
    }
  });
  it("never leaks credentials into its result", async () => {
    vi.mocked(cin7Request).mockRejectedValue(new Cin7ApiError(500, "x", false));
    expect(JSON.stringify(await createSaleProgressInvoice(creds, input))).not.toContain("SECRET-KEY");
  });
});
