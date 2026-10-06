import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/cin7/http", () => ({ cin7Request: vi.fn() }));

import { cin7Request } from "@/cin7/http";
import { buildShipContractOrder, inspectSaleShipContract, parseOrderNumbers, redactRaw } from "@/cin7/ship-contract-diagnostic";

const creds = { accountId: "acc", applicationKey: "SECRET-APP-KEY", baseUrl: "https://example.invalid" };

const detail = {
  ID: "sale-1",
  Invoices: [{ InvoiceNumber: "INV-1", Status: "AUTHORISED", InvoiceDate: "2026-09-07", Lines: [{ SKU: "A", Quantity: 5 }, { SKU: "B", Quantity: 3 }] }],
  Order: { Lines: [{ SKU: "A", Quantity: 5, BackorderQuantity: 0 }, { SKU: "C", Quantity: 1, BackorderQuantity: 1 }] },
  Attachments: [{ ID: "x", DownloadUrl: "https://signed.example/?timeStamp=1" }],
  Fulfilments: [
    {
      TaskID: "t1",
      FulfillmentNumber: 1,
      LinkedInvoiceNumber: "INV-1",
      Pick: { Status: "AUTHORISED", Lines: [{ SKU: "A", Quantity: 5 }] },
      Pack: { Status: "AUTHORISED", Lines: [{ SKU: "A", Quantity: 5, Box: "Box 1", LineID: "L1" }, { SKU: "B", Quantity: 3, Box: "Box 2" }] },
      Ship: {
        Status: "AUTHORISED",
        Lines: [{ ID: "s1", ShipmentDate: "2026-09-08", Carrier: "DHL", Boxes: "Box 1,Box 2", TrackingNumber: "T", IsShipped: true, Quantity: 8 }],
        Extra: 1,
      },
    },
  ],
};

describe("buildShipContractOrder", () => {
  it("preserves raw fulfilment/ship structure and totals packed and invoiced quantity", () => {
    const o = buildShipContractOrder("SO-1", { SaleID: "sale-1", OrderNumber: "SO-1", CombinedShippingStatus: "PARTIALLY SHIPPED" }, detail);
    expect(o.saleId).toBe("sale-1");
    expect(o.fulfilments).toHaveLength(1);
    const f = o.fulfilments![0];
    expect(f.shipStatus).toBe("AUTHORISED");
    expect(f.packedQuantity).toBe(8);
    expect(f.shipLines[0]).toMatchObject({ Boxes: "Box 1,Box 2", IsShipped: true, Quantity: 8 });
    expect(o.invoices![0].invoicedQuantity).toBe(8);
    expect(o.orderLines![1]).toMatchObject({ sku: "C", backorderQuantity: 1 });
  });

  it("reports fields the repo typings do not declare, without dropping them", () => {
    const o = buildShipContractOrder("SO-1", { SaleID: "sale-1" }, detail);
    expect(o.unknownFields!.shipLine).toEqual(["Quantity"]);
    expect(o.unknownFields!.packLine).toEqual(["LineID"]);
    expect(o.unknownFields!.ship).toEqual(["Extra"]);
    expect(JSON.stringify(o.fulfilments![0].raw)).toContain("Extra");
  });

  it("never echoes signed attachment links or credential-shaped keys", () => {
    expect(redactRaw({ DownloadUrl: "u", "Application-Key": "k", nested: [{ password: "p", ok: 1 }] })).toEqual({
      DownloadUrl: "[REDACTED]",
      "Application-Key": "[REDACTED]",
      nested: [{ password: "[REDACTED]", ok: 1 }],
    });
    const o = buildShipContractOrder("SO-1", { SaleID: "sale-1" }, detail);
    expect(JSON.stringify(o)).not.toContain("signed.example");
  });
});

describe("inspectSaleShipContract", () => {
  beforeEach(() => vi.mocked(cin7Request).mockReset());

  it("issues only GET /saleList and GET /sale, never a write, and never puts credentials in the output", async () => {
    vi.mocked(cin7Request).mockImplementation(async (_c, path) => {
      if (path === "/saleList") return { SaleList: [{ SaleID: "sale-1", OrderNumber: "SO-1" }] };
      return detail;
    });
    const out = await inspectSaleShipContract(creds, ["SO-1"]);
    const calls = vi.mocked(cin7Request).mock.calls;
    expect(calls.map((c) => c[1])).toEqual(["/saleList", "/sale"]);
    for (const c of calls) expect((c[2] as { method?: string } | undefined)?.method ?? "GET").toBe("GET");
    expect(JSON.stringify(out)).not.toContain("SECRET-APP-KEY");
  });

  it("reports an unknown order as an error entry and keeps going", async () => {
    vi.mocked(cin7Request).mockResolvedValue({ SaleList: [] });
    const out = await inspectSaleShipContract(creds, ["SO-404"]);
    expect(out[0].error).toMatch(/No sale found/);
  });
});

describe("parseOrderNumbers", () => {
  it("splits, de-duplicates and validates", () => {
    expect(parseOrderNumbers("SO-1, SO-2\nSO-1")).toEqual(["SO-1", "SO-2"]);
  });
  it("rejects empty, over-long lists and unsafe characters", () => {
    expect(() => parseOrderNumbers("  ")).toThrow();
    expect(() => parseOrderNumbers(Array.from({ length: 11 }, (_, i) => `SO-${i}`).join(","))).toThrow(/At most/);
    expect(() => parseOrderNumbers("SO-1/../x")).toThrow(/not a valid/);
  });
});
