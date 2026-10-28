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
  charges: [{ description: "P - Manufacturing progress claim C01", priceExVat: 450_000, taxAmount: 67_500 }],
};
beforeEach(() => { vi.mocked(cin7Request).mockReset(); });

describe("request body — the proven P5 representation", () => {
  it("no stock lines, DRAFT, zero TaskID, charges carry net Total, memo and tax rule/account", () => {
    expect(buildProgressInvoiceBody(input)).toEqual({
      SaleID: "sale-1", TaskID: ZERO_GUID, CombineAdditionalCharges: false, Memo: input.memo, Status: "DRAFT", InvoiceDate: "2026-10-27", InvoiceDueDate: "2026-11-26", Lines: [],
      AdditionalCharges: [{ Description: input.charges[0].description, Quantity: 1, Price: 450_000, Discount: 0, Tax: 67_500, Total: 450_000, TaxRule: "Standard Rate Sales", Account: "200" }],
    });
  });
});

describe("Tax is a MONETARY AMOUNT, never a percentage (regression: R30 of VAT on a R950,000 claim)", () => {
  const claim: ProgressInvoiceInput = {
    ...input,
    charges: [
      { description: "Manufacturing", priceExVat: 450_000, taxAmount: 67_500 },
      { description: "Delivery", priceExVat: 500_000, taxAmount: 75_000 },
    ],
  };
  const charges = (b: Record<string, unknown>) => b.AdditionalCharges as Array<{ Price: number; Tax: number; Total: number }>;
  it("sends the VAT amount per charge: R67,500 + R75,000 = R142,500 - not the rate 15 on each charge (which Cin7 totals as R30)", () => {
    const cs = charges(buildProgressInvoiceBody(claim));
    expect(cs.map((c) => c.Tax)).toEqual([67_500, 75_000]);
    expect(cs.reduce((n, c) => n + c.Tax, 0)).toBe(142_500);
    expect(cs.some((c) => c.Tax === 15)).toBe(false);
    expect(cs.reduce((n, c) => n + c.Total, 0)).toBe(950_000);
  });
  it("the P5 fixture (R100 at 15%) is the amount R15 - the same wire value as before, now unambiguous", () => {
    const cs = charges(buildProgressInvoiceBody({ ...input, charges: [{ description: "P5", priceExVat: 100, taxAmount: 15 }] }));
    expect(cs[0]).toMatchObject({ Price: 100, Tax: 15, Total: 100 });
  });
  it("refuses a non-finite, negative or zero money value before anything is sent", () => {
    for (const bad of [{ priceExVat: NaN }, { priceExVat: Infinity }, { priceExVat: 0 }, { priceExVat: -5 }, { taxAmount: NaN }, { taxAmount: -1 }, { taxAmount: Infinity }, { taxAmount: undefined as unknown as number }]) {
      expect(() => buildProgressInvoiceBody({ ...input, charges: [{ ...input.charges[0], ...bad }] })).toThrow();
    }
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
  it("a POST response that carries no totals is created with null amounts - never NaN", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ Invoices: [{ InvoiceNumber: "INV-21", TaskID: "t", Memo: input.memo, Status: "DRAFT" }] });
    const r = await createSaleProgressInvoice(creds, input);
    expect(r).toMatchObject({ kind: "created", invoiceNumber: "INV-21", totalBeforeTax: null, tax: null, total: null });
    expect(JSON.stringify(r)).not.toMatch(/NaN/);
  });
  it("non-numeric totals in the response are null, not NaN", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ Invoices: [{ InvoiceNumber: "I", TaskID: "t", Memo: input.memo, Status: "DRAFT", TotalBeforeTax: "abc", Tax: null, Total: "" }] });
    expect(await createSaleProgressInvoice(creds, input)).toMatchObject({ kind: "created", totalBeforeTax: null, tax: null, total: null });
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

describe("R0 physical lines", () => {
  const base = { saleId: "s", memo: "m", invoiceDate: "2026-10-27", invoiceDueDate: "2026-11-26", taxRule: "Standard Rate Sales", account: "200", charges: [{ description: "d", priceExVat: 100, taxAmount: 15 }] };
  it("emits zero-priced, zero-tax lines and keeps the VAT on the charges", () => {
    const b = buildProgressInvoiceBody({ ...base, lines: [{ productId: "p", sku: "A", name: "n", quantity: 2 }] }) as { Lines: Array<Record<string, unknown>>; AdditionalCharges: Array<Record<string, unknown>> };
    expect(b.Lines).toEqual([{ ProductID: "p", SKU: "A", Name: "n", Quantity: 2, Price: 0, Discount: 0, Tax: 0, TaxRule: "Standard Rate Sales", Total: 0 }]);
    expect(b.AdditionalCharges[0]).toMatchObject({ Price: 100, Tax: 15, Total: 100 });
  });
  it("rejects bad quantities, duplicate SKUs, missing ids and a charge-less invoice", () => {
    const ln = { productId: "p", sku: "A", name: "n", quantity: 1 };
    expect(() => buildProgressInvoiceBody({ ...base, lines: [{ ...ln, quantity: 0 }] })).toThrow();
    expect(() => buildProgressInvoiceBody({ ...base, lines: [{ ...ln, quantity: Number.NaN }] })).toThrow();
    expect(() => buildProgressInvoiceBody({ ...base, lines: [ln, ln] })).toThrow(/twice/);
    expect(() => buildProgressInvoiceBody({ ...base, lines: [{ ...ln, productId: "" }] })).toThrow();
    expect(() => buildProgressInvoiceBody({ ...base, charges: [], lines: [ln] })).toThrow(/at least one/);
  });
});
