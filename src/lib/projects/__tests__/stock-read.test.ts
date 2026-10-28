import { beforeEach, describe, expect, it, vi } from "vitest";

const scan = vi.fn();
vi.mock("@/cin7/product-availability", () => ({ fetchAllProductAvailability: (...a: unknown[]) => scan(...a) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn(async () => ({ accountId: "a", applicationKey: "k" })) }));
vi.mock("@/cin7/sales", () => ({ fetchSaleDetail: vi.fn() }));
vi.mock("@/cin7/finished-goods", () => ({ fetchAllFinishedGoodsList: vi.fn(async () => []) }));
vi.mock("@/cin7/sale-order-write", () => ({ createAdvancedSale: vi.fn(), customerExists: vi.fn(), findSaleByExternalIdForCustomer: vi.fn(), resolveProductIds: vi.fn() }));
vi.mock("@/cin7/products", () => ({ findBomSkus: vi.fn() }));
vi.mock("@/cin7/customers", () => ({ fetchCustomerDefaults: vi.fn() }));

import { buildPhysicalPort } from "../physical-adapter";
import { buildSaleCreationPort } from "../cin7-sale-creation-adapter";
import { buildPhysicalStatus } from "../physical-status";

const rows = [
  { ID: "1", SKU: "A", Location: "MSTR", OnHand: 10, Allocated: 2, Available: 8 },
  { ID: "2", SKU: "A", Location: "PROJ", OnHand: 5, Allocated: 0, Available: 5 },
  { ID: "3", SKU: "B", Location: "MSTR", OnHand: 4, Allocated: 0, Available: 4 },
];
beforeEach(() => { scan.mockReset(); scan.mockResolvedValue(rows); });

describe("stock reads: ONE availability scan per view, however many SKUs", () => {
  it("the Products & Fulfilment port reads the whole availability list once and answers every SKU from it (summing locations; unknown SKU = null)", async () => {
    const port = buildPhysicalPort({} as never, "org", "inst");
    const [a, b, none] = [await port.readStock("A"), await port.readStock("B"), await port.readStock("ZZ")];
    expect(scan).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ onHand: 15, allocated: 2, available: 13 });
    expect(b).toEqual({ onHand: 4, allocated: 0, available: 4 });
    expect(none).toBeNull();
  });
  it("P0's stock check uses the same single scan and keeps the per-location rows", async () => {
    const port = buildSaleCreationPort({} as never, "org", "inst");
    expect(await port.stockAt("A")).toEqual([{ location: "MSTR", available: 8 }, { location: "PROJ", available: 5 }]);
    await port.stockAt("B"); await port.stockAt("ZZ");
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it("a failed scan is surfaced (not cached as 'no stock'): the caller reports STOCK_NOT_READ for a linked Sale", async () => {
    scan.mockRejectedValueOnce(new Error("rate limited"));
    const port = buildPhysicalPort({} as never, "org", "inst");
    await expect(port.readStock("A")).rejects.toThrow(/rate limited/);
  });
});

describe("Products & Fulfilment before a Cin7 Sale exists", () => {
  const scope = [{ sku: "A", description: "Feeder", quantity: 10 }, { sku: "B", description: "Door", quantity: 4 }];
  it("raises NO 'stock not read' warning (nothing is read from Cin7 without a Sale); quoted is known and Cin7 figures stay unknown", () => {
    const r = buildPhysicalStatus({ scope, saleLinked: false, ordered: [], invoices: [], fulfilments: [], stock: {}, assemblies: [] });
    expect(r.exceptions).toEqual([]);
    expect(r.rows.map((x) => [x.sku, x.quoted, x.ordered, x.available])).toEqual([["A", 10, null, null], ["B", 4, null, null]]);
  });
  it("with a Sale linked, an unread SKU IS still warned about (the real defect signal is preserved)", () => {
    const r = buildPhysicalStatus({ scope, saleLinked: true, ordered: [{ sku: "A", name: "Feeder", quantity: 10 }], invoices: [], fulfilments: [], stock: { A: { onHand: 1, allocated: 0, available: 1 } }, assemblies: [] });
    expect(r.exceptions.map((e) => `${e.code}:${e.sku}`).sort()).toEqual(["NOT_ON_ORDER:B", "STOCK_NOT_READ:B"]);
  });
});
