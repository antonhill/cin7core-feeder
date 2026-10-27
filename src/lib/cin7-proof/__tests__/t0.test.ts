import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { T0AccessError, T0_FIXTURE, T0_ORG_ID, assertT0Access, buildT0Report, evaluateAfter, evaluateBefore, isGuid, projectAvailability, projectSale } from "../t0";

const root = join(__dirname, "..", "..", "..", "..");
const SALE = "11111111-2222-3333-4444-555555555555";
const stock = (over: Record<string, unknown> = {}) => [{ SKU: "NQ2886", Location: "MSTR", OnHand: 1000, Allocated: 0, Available: 1000, OnOrder: 0, InTransit: 0, ...over }];
/** What T0 hypothesises Cin7 returns after the Sale is created AND authorised. */
const authorisedSale = (over: Record<string, unknown> = {}) => ({
  ID: SALE, Type: "Advanced Sale", Status: "ORDERED", TaxRule: "Standard Rate Sales", Location: "MSTR", COGSAmount: 0, InventoryMovements: [], Transactions: [], Fulfilments: [], Invoices: [],
  CombinedInvoiceStatus: "NOT INVOICED", CombinedPickingStatus: "NOT PICKED", CombinedPackingStatus: "NOT PACKED", CombinedShippingStatus: "NOT SHIPPED", CombinedPaymentStatus: "UNPAID", FulFilmentStatus: "NOT FULFILLED",
  Order: { SaleOrderNumber: "SO-00020", Status: "AUTHORISED", TotalBeforeTax: 1000, Tax: 150, Total: 1150, Lines: [{ SKU: "NQ2886", Quantity: 2, Price: 500, Tax: 150, Total: 1000 }], AdditionalCharges: [] },
  ...over,
});
const OK = { orgId: T0_ORG_ID, isManager: true };

describe("access: every gate runs before any Cin7 read", () => {
  const deps = () => ({ readAvailability: vi.fn(async () => stock()), readSale: vi.fn(async () => authorisedSale()) });
  it("another organisation is refused and nothing is read", async () => {
    const d = deps();
    await expect(buildT0Report({ orgId: "other-org", isManager: true }, null, d)).rejects.toBeInstanceOf(T0AccessError);
    expect(d.readAvailability).not.toHaveBeenCalled();
    expect(d.readSale).not.toHaveBeenCalled();
  });
  it("a non-manager is refused and nothing is read", async () => {
    const d = deps();
    await expect(buildT0Report({ orgId: T0_ORG_ID, isManager: false }, SALE, d)).rejects.toBeInstanceOf(T0AccessError);
    expect(d.readAvailability).not.toHaveBeenCalled();
    expect(d.readSale).not.toHaveBeenCalled();
  });
  it("assertT0Access passes only for the NewQuip POC org AND a manager", () => {
    expect(() => assertT0Access(OK)).not.toThrow();
    expect(() => assertT0Access({ orgId: T0_ORG_ID, isManager: false })).toThrow();
    expect(() => assertT0Access({ orgId: "x", isManager: true })).toThrow();
  });
  it("only the fixture SKU is ever asked for, and a malformed sale parameter is rejected without a Sale read", async () => {
    const d = deps();
    const r = await buildT0Report(OK, "not-a-guid", d);
    expect(d.readAvailability).toHaveBeenCalledWith("NQ2886");
    expect(d.readSale).not.toHaveBeenCalled();
    expect(r.error).toMatch(/valid SaleID/);
    expect(isGuid(SALE)).toBe(true);
    expect(isGuid("../etc/passwd")).toBe(false);
  });
});

describe("BEFORE: live stock must equal the recorded baseline", () => {
  it("matches the baseline (1000 / 0 / 1000 at MSTR)", async () => {
    const r = await buildT0Report(OK, null, { readAvailability: async () => stock(), readSale: async () => ({}) });
    expect(r.mode).toBe("BEFORE");
    expect(r.verdict).toBe("ALL EXPECTED");
  });
  it("drift in live stock is a DEVIATION, so the comparison is not trusted", () => {
    const checks = evaluateBefore(projectAvailability(stock({ Allocated: 3, Available: 997 })));
    expect(checks.filter((c) => c.result === "DEVIATION").map((c) => c.id)).toEqual(["B3", "B4"]);
  });
  it("no row, or two rows, at the fixture location is not silently accepted", () => {
    expect(evaluateBefore([]).some((c) => c.result !== "PASS")).toBe(true);
    expect(evaluateBefore(projectAvailability([...stock(), ...stock()])).some((c) => c.result !== "PASS")).toBe(true);
  });
});

describe("AFTER: the T0 hypotheses", () => {
  const after = stock({ Allocated: 2, Available: 998 });
  it("an authorised Advanced Sale that only reserves stock passes every check", () => {
    const checks = evaluateAfter(projectSale(authorisedSale()), projectAvailability(after));
    expect(checks.every((c) => c.result === "PASS")).toBe(true);
    expect(checks).toHaveLength(12);
  });
  it("a Simple Sale is flagged (the SO-00018 failure mode)", () => {
    const c = evaluateAfter(projectSale(authorisedSale({ Type: "Simple Sale" })), projectAvailability(after));
    expect(c.find((x) => x.id === "A1")?.result).toBe("DEVIATION");
  });
  it("stock that did not allocate is flagged", () => {
    const c = evaluateAfter(projectSale(authorisedSale()), projectAvailability(stock()));
    expect(c.filter((x) => x.result === "DEVIATION").map((x) => x.id)).toEqual(["A11", "A12"]);
  });
  it("any invoice, fulfilment, COGS or inventory movement is flagged", () => {
    const sale = projectSale(authorisedSale({ Invoices: [{ InvoiceNumber: "INV-1", Status: "DRAFT" }], Fulfilments: [{}], COGSAmount: 50, InventoryMovements: [{}] }));
    const c = evaluateAfter(sale, projectAvailability(after));
    expect(c.filter((x) => x.result === "DEVIATION").map((x) => x.id)).toEqual(["A6", "A7", "A8", "A9"]);
  });
  it("a wrong quantity or price is flagged", () => {
    const sale = projectSale(authorisedSale({ Order: { ...authorisedSale().Order, Lines: [{ SKU: "NQ2886", Quantity: 3, Price: 500 }] } }));
    expect(evaluateAfter(sale, projectAvailability(after)).find((x) => x.id === "A3")?.result).toBe("DEVIATION");
  });
  it("values Cin7 does not return are NOT_READABLE, never zero and never a pass", () => {
    const sale = projectSale({ ID: SALE, Order: { Status: "AUTHORISED", Lines: [{ SKU: "NQ2886", Quantity: 2, Price: 500 }] } });
    const c = evaluateAfter(sale, projectAvailability(after));
    expect(c.find((x) => x.id === "A1")?.result).toBe("NOT_READABLE");
    expect(c.find((x) => x.id === "A5")?.result).toBe("NOT_READABLE");
    expect(c.find((x) => x.id === "A8")?.result).toBe("NOT_READABLE");
    expect(JSON.stringify(c)).not.toMatch(/NaN/);
  });
});

describe("projection: allow-list only, no personal or commercial-party data", () => {
  it("drops customer, address, contact, notes and attachments even when present", () => {
    const sale = projectSale(authorisedSale({
      Customer: "SECRET CUSTOMER", CustomerID: "c1", Contact: "J Smith", Email: "x@y.z", BillingAddress: { Line1: "1 Secret St" }, ShippingAddress: { Line1: "2 Secret St" },
      Note: "private", CustomerReference: "PO-1", SalesRepresentative: "Rep Name", Attachments: [{ FileName: "secret.pdf", DownloadUrl: "https://signed" }],
    }));
    const out = JSON.stringify(sale);
    for (const s of ["SECRET", "J Smith", "x@y.z", "Secret St", "private", "PO-1", "Rep Name", "secret.pdf", "signed"]) expect(out).not.toContain(s);
  });
  it("exposes property NAMES of the payload shape but never their values", () => {
    const v = projectSale(authorisedSale());
    expect(v.topLevelKeys).toContain("COGSAmount");
    expect(v.orderKeys).toContain("Lines");
  });
  it("non-numeric money is null, not NaN", () => {
    const v = projectSale({ COGSAmount: "abc", Order: { Total: "", Lines: [{ SKU: "A", Quantity: "x" }] } });
    expect(v.cogsAmount).toBeNull();
    expect(v.orderTotal).toBeNull();
    expect(v.lines[0].quantity).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/NaN/);
  });
});

describe("read-only by construction", () => {
  const files = ["src/cin7/sale-inspect.ts", "src/lib/cin7-proof/t0.ts", "src/app/cin7-proof/t0/page.tsx"];
  it("the inspector files contain no write verbs, no mutation calls and no env access", () => {
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
      expect(src, f).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/i);
      expect(src, f).not.toMatch(/process\.env|"use server"|<form|formAction|createInvoice|nonIdempotentCreate/);
    }
  });
  it("the Cin7 module only issues GETs: no method option is ever passed to the gateway", () => {
    const src = readFileSync(join(root, "src/cin7/sale-inspect.ts"), "utf8");
    expect(src).not.toMatch(/method\s*:/);
    expect(src.match(/cin7Request[<(]/g)?.length).toBeGreaterThan(0);
  });
  it("the fixture is pinned to the approved values", () => {
    expect(T0_FIXTURE).toMatchObject({ sku: "NQ2886", location: "MSTR", quantity: 2, unitPrice: 500, totals: { exVat: 1000, vat: 150, total: 1150 } });
  });
});
