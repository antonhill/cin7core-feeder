import { describe, expect, it } from "vitest";
import { inspectSale, type SaleExpectations } from "@/rwtsa-live/sale";
import type { ReadOnlyClient } from "@/rwtsa-live/client";

const fake = (responses: Record<string, unknown>) => {
  const calls: { path: string; query?: Record<string, string | number> }[] = [];
  const c: ReadOnlyClient = { get: async (path, query) => { calls.push({ path, query }); return responses[path] as never; }, requests: () => calls.length, methodsUsed: () => ["GET"] };
  return { c, calls };
};
const EXP: SaleExpectations = { orderNumber: "SO-T1", customer: "Test Customer", sourceReference: "Q-T1", lines: [0, 1, 2].map((i) => ({ sku: `S${i}`, quantity: 2, unitPrice: 98 })), totalExTax: 1000 };
const ID = "11111111-1111-4111-8111-111111111111";
const list = { SaleList: [{ SaleID: ID, OrderNumber: "SO-T1" }] };
const lines = (n = 3, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ SKU: `S${i}`, Quantity: 2, BackorderQuantity: 0, Total: 10, Price: 98, ...extra }));
const sale = (o: Record<string, unknown> = {}, order: Record<string, unknown> = {}) => ({ ID: ID, Customer: "Test Customer", CustomerReference: "Q-T1", Order: { SaleOrderNumber: "SO-T1", Status: "AUTHORISED", TotalBeforeTax: 1000, Lines: lines(), ...order }, Fulfilments: [], ...o });
const run = (s: unknown, l: unknown = list) => { const f = fake({ "/saleList": l, "/sale": s }); return inspectSale(f.c, EXP).then((e) => ({ e, ...f })); };
const status = (e: Awaited<ReturnType<typeof inspectSale>>, id: string) => e.checks.find((c) => c.id === id)?.status;

describe("inspectSale", () => {
  it("makes exactly two GETs (list lookup then detail) and matches with allocation as INDIRECT evidence only", async () => {
    const { e, calls } = await run(sale());
    expect(calls.map((c) => c.path)).toEqual(["/saleList", "/sale"]);
    expect(calls[1].query).toEqual({ ID: ID });
    expect(e.verdict).toBe("MATCH_ALLOCATION_INDIRECT");
    expect(e.checks.map((c) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(e.allocation?.status).toBe("NO_BACKORDER_INDIRECT_EVIDENCE");
    expect(e.requests).toBe(2);
  });
  it("REGRESSION: an unmatched list is UNVERIFIED in every case (empty, short, or full), never NOT_FOUND, and no detail request is made", async () => {
    const full = { SaleList: Array.from({ length: 50 }, (_, i) => ({ SaleID: `x${i}`, OrderNumber: `SO-${i}` })) };
    const short = { SaleList: [{ SaleID: "x1", OrderNumber: "SO-OTHER" }] };
    for (const l of [{ SaleList: [] }, short, full]) {
      const f = fake({ "/saleList": l });
      const e = await inspectSale(f.c, EXP);
      expect(e).toMatchObject({ verdict: "UNVERIFIED", status: "UNVERIFIED", saleId: null, checks: [] });
      expect(e.unverifiedReason).toMatch(/unverified/i);
      expect(JSON.stringify(e)).not.toMatch(/NOT_FOUND/);
      expect(f.calls).toHaveLength(1);
    }
  });
  it("an unrecognised list shape fails closed (throws), and an ambiguous order number makes no detail request", async () => {
    await expect(inspectSale(fake({ "/saleList": { Foo: [] } }).c, EXP)).rejects.toThrow(/SaleList is missing/);
    const f = fake({ "/saleList": { SaleList: [{ SaleID: ID, OrderNumber: "SO-T1" }, { SaleID: "22222222-2222-4222-8222-222222222222", OrderNumber: "SO-T1" }] } });
    expect((await inspectSale(f.c, EXP)).verdict).toBe("UNVERIFIED");
    expect(f.calls).toHaveLength(1);
  });
  it("refuses a detail response for a different sale or order number (nothing recorded)", async () => {
    await expect(run(sale({ ID: "33333333-3333-4333-8333-333333333333" }))).rejects.toThrow(/different sale/);
    await expect(run(sale({}, { SaleOrderNumber: "SO-OTHER" }))).rejects.toThrow(/different order number/);
    await expect(run(null)).rejects.toThrow(/Unexpected response shape/);
  });
  it("no Order object is UNVERIFIED", async () => {
    expect((await run({ ID, Customer: "Test Customer" })).e.verdict).toBe("UNVERIFIED");
  });
  it("customer: different name FAILs, missing is UNVERIFIED, case/space-insensitive match passes", async () => {
    expect(status((await run(sale({ Customer: "Someone Else" }))).e, "customer")).toBe("FAIL");
    expect(status((await run(sale({ Customer: null }))).e, "customer")).toBe("UNVERIFIED");
    expect(status((await run(sale({ Customer: "  test   CUSTOMER " }))).e, "customer")).toBe("PASS");
  });
  it("source reference: exact in CustomerReference or ExternalID passes; wrong FAILs; Note-only or absent is UNVERIFIED", async () => {
    expect((await run(sale({ CustomerReference: null, ExternalID: "q-t1" }))).e.observed?.sourceReferenceField).toBe("ExternalID");
    expect(status((await run(sale({ CustomerReference: "Q-OTHER" }))).e, "sourceReference")).toBe("FAIL");
    expect(status((await run(sale({ CustomerReference: null, Note: "from Q-T1" }))).e, "sourceReference")).toBe("UNVERIFIED");
    expect(status((await run(sale({ CustomerReference: null }))).e, "sourceReference")).toBe("UNVERIFIED");
  });
  it("REGRESSION line pairs: all expected SKU/quantity/unit-price pairs must match exactly", async () => {
    const ok = (await run(sale())).e;
    expect(status(ok, "linePairs")).toBe("PASS");
    expect(ok.linePairs).toEqual({ missing: [], quantityDiffers: [], priceDiffers: [], unexpected: [], unpriced: [] });
    const swap = (f: (l: Record<string, unknown>, i: number) => Record<string, unknown>) => (run(sale({}, { Lines: lines().map(f) })));
    const qty = (await swap((l, i) => (i === 1 ? { ...l, Quantity: 3 } : l))).e;
    expect(status(qty, "linePairs")).toBe("FAIL"); expect(qty.linePairs?.quantityDiffers).toEqual(["S1"]); expect(qty.verdict).toBe("MISMATCH");
    const price = (await swap((l, i) => (i === 2 ? { ...l, Price: 98.01 } : l))).e;
    expect(status(price, "linePairs")).toBe("FAIL"); expect(price.linePairs?.priceDiffers).toEqual(["S2"]);
    expect(status((await swap((l, i) => (i === 0 ? { ...l, Price: 98.004 } : l))).e, "linePairs")).toBe("PASS");
    const wrongSku = (await swap((l, i) => (i === 0 ? { ...l, SKU: "OTHER" } : l))).e;
    expect(wrongSku.linePairs).toMatchObject({ missing: ["S0"], unexpected: ["OTHER"] }); expect(status(wrongSku, "linePairs")).toBe("FAIL");
  });
  it("line pairs: a missing or non-numeric unit price is UNVERIFIED (never a pass); malformed lines are UNVERIFIED; an extra line FAILs", async () => {
    const noPrice = (await run(sale({}, { Lines: lines().map((l, i) => { const r: Record<string, unknown> = { ...l }; if (i === 0) delete r.Price; return r; }) }))).e;
    expect(status(noPrice, "linePairs")).toBe("UNVERIFIED"); expect(noPrice.linePairs?.unpriced).toEqual(["S0"]); expect(noPrice.verdict).toBe("UNVERIFIED");
    expect(status((await run(sale({}, { Lines: lines().map((l) => ({ ...l, Price: "98" })) }))).e, "linePairs")).toBe("UNVERIFIED");
    expect(status((await run(sale({}, { Lines: [...lines(2), { SKU: "", Quantity: 1, Price: 98 }] }))).e, "linePairs")).toBe("UNVERIFIED");
    const extra = (await run(sale({}, { Lines: [...lines(), { SKU: "EXTRA", Quantity: 1, Price: 98, BackorderQuantity: 0 }] }))).e;
    expect(extra.linePairs?.unexpected).toEqual(["EXTRA"]); expect(status(extra, "linePairs")).toBe("FAIL");
  });
  it("line count: wrong count and duplicate SKUs FAIL; malformed or missing lines are UNVERIFIED", async () => {
    expect(status((await run(sale({}, { Lines: lines(2) }))).e, "lineCount")).toBe("FAIL");
    expect(status((await run(sale({}, { Lines: [...lines(2), { SKU: "S0", Quantity: 1, BackorderQuantity: 0 }] }))).e, "lineCount")).toBe("FAIL");
    expect(status((await run(sale({}, { Lines: [...lines(2), { SKU: "", Quantity: 1 }] }))).e, "lineCount")).toBe("UNVERIFIED");
    expect(status((await run(sale({}, { Lines: [...lines(2), { SKU: "Z", Quantity: 0 }] }))).e, "lineCount")).toBe("UNVERIFIED");
    expect(status((await run(sale({}, { Lines: undefined }))).e, "lineCount")).toBe("UNVERIFIED");
  });
  it("total excluding tax: compared to the cent; a tax-inclusive or missing total is never a pass", async () => {
    expect(status((await run(sale({}, { TotalBeforeTax: 1150 }))).e, "totalExTax")).toBe("FAIL");
    expect(status((await run(sale({}, { TotalBeforeTax: 1000.004 }))).e, "totalExTax")).toBe("PASS");
    expect(status((await run(sale({}, { TotalBeforeTax: "1000" }))).e, "totalExTax")).toBe("UNVERIFIED");
    expect(status((await run(sale({}, { TotalBeforeTax: undefined }))).e, "totalExTax")).toBe("UNVERIFIED");
  });
  it("order status: only AUTHORISED passes", async () => {
    for (const s of ["DRAFT", "VOIDED", "COMPLETED"]) expect(status((await run(sale({}, { Status: s }))).e, "orderStatus")).toBe("FAIL");
    expect(status((await run(sale({}, { Status: undefined }))).e, "orderStatus")).toBe("UNVERIFIED");
  });
  it("allocation: any backorder is a MISMATCH; absent backorder fields or an unauthorised order are UNVERIFIED, never indirect evidence", async () => {
    const back = (await run(sale({}, { Lines: lines(3).map((l, i) => (i === 0 ? { ...l, BackorderQuantity: 2 } : l)) }))).e;
    expect(back.allocation).toMatchObject({ status: "BACKORDER_PRESENT", backorderUnits: 2, linesWithBackorder: 1 });
    expect(back.verdict).toBe("MISMATCH");
    const missing = (await run(sale({}, { Lines: lines(3).map((l) => { const r: Record<string, unknown> = { ...l }; delete r.BackorderQuantity; return r; }) }))).e;
    expect(missing.allocation?.status).toBe("UNVERIFIED");
    expect(missing.verdict).toBe("UNVERIFIED");
    const draft = (await run(sale({}, { Status: "DRAFT" }))).e;
    expect(draft.allocation?.status).toBe("UNVERIFIED");
    expect((await run(sale({}, { Lines: lines(3, { BackorderQuantity: -1 }) }))).e.allocation?.status).toBe("UNVERIFIED");
  });
  it("any FAIL beats UNVERIFIED in the verdict", async () => {
    expect((await run(sale({ Customer: "Other", CustomerReference: null }))).e.verdict).toBe("MISMATCH");
  });
  it("reports field NAMES and separate line/charge sums, never silently adding charges to the total", async () => {
    const { e } = await run(sale({}, { AdditionalCharges: [{ Total: 5 }, { Total: 7 }] }));
    expect(e.observed).toMatchObject({ linesTotalSum: 30, additionalChargesTotalSum: 12, totalBeforeTax: 1000 });
    expect(e.orderFields).toContain("TotalBeforeTax");
    expect(e.responseTopLevelFields).toContain("Customer");
  });
});
