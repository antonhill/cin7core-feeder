import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cin7ApiError, cin7Request } from "@/cin7/http";
import { buildAdvancedSaleHeaderBody, buildAdvancedSaleOrderBody, createAdvancedSale } from "../sale-order-write";

vi.mock("@/cin7/http", async () => {
  class Cin7ApiError extends Error {
    constructor(public status: number, message: string, public retryable: boolean, public ambiguous: boolean = false) { super(message); }
  }
  return { Cin7ApiError, cin7Request: vi.fn() };
});
const creds = { accountId: "a", applicationKey: "k" } as never;
const req = vi.mocked(cin7Request);
const header = { customer: "Test Customer", location: "MSTR", saleOrderDate: "2026-10-28", taxRule: "Standard Rate Sales", externalId: "NEWQUIP-PROJECTS-SALE:P-1" };
const line = { productId: "p1", sku: "NQ2886", name: "Bracket", quantity: 2, taxRule: "Standard Rate Sales" };
const charge = { description: "P-1 - Deposit", priceExVat: 1_000_000, taxAmount: 150_000, taxRule: "Standard Rate Sales", account: "200" };

describe("Advanced Sale request bodies (pure)", () => {
  it("header: Advanced, our ExternalID, no quote stage", () => {
    expect(buildAdvancedSaleHeaderBody(header)).toMatchObject({ Customer: "Test Customer", Location: "MSTR", SaleType: "Advanced", SkipQuote: true, ExternalID: "NEWQUIP-PROJECTS-SALE:P-1", TaxInclusive: false });
  });
  it("order: product lines at R0 with zero tax; the contract as charges with VAT as a monetary amount; AUTHORISED", () => {
    const b = buildAdvancedSaleOrderBody("sale-1", [line], [charge]) as { Status: string; Lines: Array<Record<string, unknown>>; AdditionalCharges: Array<Record<string, unknown>> };
    expect(b.Status).toBe("AUTHORISED");
    expect(b.Lines[0]).toMatchObject({ ProductID: "p1", SKU: "NQ2886", Quantity: 2, Price: 0, Tax: 0, Total: 0 });
    expect(b.AdditionalCharges[0]).toMatchObject({ Price: 1_000_000, Tax: 150_000, Total: 1_000_000, Account: "200", Quantity: 1 });
  });
  it("refuses to build with non-finite money, bad quantities, missing ids or no contract charge", () => {
    expect(() => buildAdvancedSaleOrderBody("s", [line], [])).toThrow(/at least one/);
    expect(() => buildAdvancedSaleOrderBody("s", [line], [{ ...charge, priceExVat: Number.NaN }])).toThrow();
    expect(() => buildAdvancedSaleOrderBody("s", [line], [{ ...charge, taxAmount: -1 }])).toThrow();
    expect(() => buildAdvancedSaleOrderBody("s", [{ ...line, quantity: 0 }], [charge])).toThrow();
    expect(() => buildAdvancedSaleOrderBody("s", [{ ...line, productId: "" }], [charge])).toThrow();
  });
});

describe("createAdvancedSale outcomes", () => {
  beforeEach(() => req.mockReset());
  it("an invalid request is rejected before ANYTHING is sent", async () => {
    expect(await createAdvancedSale(creds, header, [line], [{ ...charge, priceExVat: Number.NaN }])).toMatchObject({ kind: "rejected" });
    expect(req).not.toHaveBeenCalled();
  });
  it("two POSTs, each non-idempotent and sent once, header first then the order against the returned SaleID", async () => {
    req.mockResolvedValueOnce({ ID: "sale-9", Order: { SaleOrderNumber: "SO-00100" } }).mockResolvedValueOnce({});
    expect(await createAdvancedSale(creds, header, [line], [charge])).toEqual({ kind: "created", saleId: "sale-9", saleNumber: "SO-00100" });
    expect(req).toHaveBeenCalledTimes(2);
    expect(req.mock.calls[0][1]).toBe("/sale");
    expect(req.mock.calls[0][2]).toMatchObject({ method: "POST", nonIdempotentCreate: true });
    expect(req.mock.calls[1][1]).toBe("/sale/order");
    expect(req.mock.calls[1][2]).toMatchObject({ method: "POST", nonIdempotentCreate: true });
    expect((req.mock.calls[1][2] as { body: { SaleID: string } }).body.SaleID).toBe("sale-9");
  });
  it("a definite 4xx on the header is a rejection (nothing exists); the order is never attempted", async () => {
    req.mockRejectedValueOnce(new Cin7ApiError(400, "bad", false));
    expect(await createAdvancedSale(creds, header, [line], [charge])).toMatchObject({ kind: "rejected", httpStatus: 400 });
    expect(req).toHaveBeenCalledTimes(1);
  });
  it("an ambiguous header failure, a 5xx, or a 200 without an ID is uncertain with no Sale id", async () => {
    req.mockRejectedValueOnce(new Cin7ApiError(0, "net", true, true));
    expect(await createAdvancedSale(creds, header, [line], [charge])).toMatchObject({ kind: "uncertain", stage: "HEADER_UNKNOWN", saleId: null });
    req.mockReset(); req.mockRejectedValueOnce(new Cin7ApiError(503, "x", true));
    expect(await createAdvancedSale(creds, header, [line], [charge])).toMatchObject({ kind: "uncertain", saleId: null });
    req.mockReset(); req.mockResolvedValueOnce({});
    expect(await createAdvancedSale(creds, header, [line], [charge])).toMatchObject({ kind: "uncertain", saleId: null });
  });
  it("a failed ORDER step leaves an orphan header: uncertain WITH the Sale id, order never resent", async () => {
    req.mockResolvedValueOnce({ ID: "sale-9", Order: { SaleOrderNumber: "SO-00100" } }).mockRejectedValueOnce(new Cin7ApiError(400, "bad", false));
    const r = await createAdvancedSale(creds, header, [line], [charge]);
    expect(r).toMatchObject({ kind: "uncertain", stage: "HEADER_CREATED", saleId: "sale-9", saleNumber: "SO-00100" });
    expect(req).toHaveBeenCalledTimes(2);
  });
});
