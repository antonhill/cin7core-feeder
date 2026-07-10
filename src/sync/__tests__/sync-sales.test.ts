import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstanceSales, syncOrgSales } from "@/sync/sync-sales";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllSalesList, fetchSaleDetail } from "@/cin7/sales";
import { fetchAllCategories } from "@/cin7/categories";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/sales", () => ({ fetchAllSalesList: vi.fn(), fetchSaleDetail: vi.fn() }));
vi.mock("@/cin7/categories", () => ({ fetchAllCategories: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

interface FakeDbOptions {
  syncState?: { last_list_synced_at: string | null } | null;
  existingSales?: { cin7_sale_id: string; cin7_updated_at: string | null; detail_synced_at: string | null }[];
  pendingSales?: { cin7_sale_id: string }[];
}

function makeFakeDb(opts: FakeDbOptions) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];

  function chain(table: string, terminalResult: () => { data?: unknown; error?: unknown }) {
    const obj: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        calls.push({ table, op: "select", args });
        return obj;
      },
      eq: (...args: unknown[]) => {
        calls.push({ table, op: "eq", args });
        return obj;
      },
      in: (...args: unknown[]) => {
        calls.push({ table, op: "in", args });
        return obj;
      },
      is: (...args: unknown[]) => {
        calls.push({ table, op: "is", args });
        return obj;
      },
      order: (...args: unknown[]) => {
        calls.push({ table, op: "order", args });
        return obj;
      },
      limit: (...args: unknown[]) => {
        calls.push({ table, op: "limit", args });
        return obj;
      },
      maybeSingle: async () => terminalResult(),
      then: (resolve: (v: unknown) => void) => resolve(terminalResult()),
    };
    return obj;
  }

  function deleteInsertTable(table: string) {
    return {
      delete: () => {
        calls.push({ table, op: "delete", args: [] });
        return chain(table, () => ({ error: null }));
      },
      insert: (rows: unknown) => {
        calls.push({ table, op: "insert", args: [rows] });
        return Promise.resolve({ error: null });
      },
    };
  }

  const db = {
    from: (table: string) => {
      if (table === "sales_sync_state") {
        return {
          ...chain(table, () => ({ data: opts.syncState ?? null, error: null })),
          upsert: (row: unknown, conflictOpts: unknown) => {
            calls.push({ table, op: "upsert", args: [row, conflictOpts] });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "sales") {
        return {
          select: (cols: string) => {
            calls.push({ table, op: "select", args: [cols] });
            const result = cols.includes("cin7_updated_at") ? (opts.existingSales ?? []) : (opts.pendingSales ?? []);
            return chain(table, () => ({ data: result, error: null }));
          },
          upsert: (rows: unknown, conflictOpts: unknown) => {
            calls.push({ table, op: "upsert", args: [rows, conflictOpts] });
            return Promise.resolve({ error: null });
          },
          update: (patch: unknown) => {
            calls.push({ table, op: "update", args: [patch] });
            return chain(table, () => ({ error: null }));
          },
        };
      }
      if (table === "sale_lines" || table === "sale_order_lines" || table === "sale_pick_pack_lines") {
        return deleteInsertTable(table);
      }
      if (table === "categories" || table === "category_instances") {
        return {
          upsert: (rows: unknown, conflictOpts: unknown) => {
            calls.push({ table, op: "upsert", args: [rows, conflictOpts] });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Unhandled table in fake db: ${table}`);
    },
  };

  return { db: db as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({ ...creds, name: "Spark Demo" });
  vi.mocked(fetchAllSalesList).mockReset().mockResolvedValue([]);
  vi.mocked(fetchSaleDetail).mockReset();
  vi.mocked(fetchAllCategories).mockReset().mockResolvedValue([]);
});

describe("syncInstanceSales — list phase", () => {
  it("queues a brand-new sale for detail sync (detail_synced_at cleared)", async () => {
    vi.mocked(fetchAllSalesList).mockResolvedValue([
      { SaleID: "sale-1", OrderNumber: "SO-1", InvoiceNumber: "INV-1", InvoiceDate: "2026-06-01T00:00:00", Customer: "Acme", Updated: "2026-06-01T01:00:00.000Z", CombinedInvoiceStatus: "AUTHORISED" },
    ]);
    const { db, calls } = makeFakeDb({ syncState: null, existingSales: [], pendingSales: [] });

    const summary = await syncInstanceSales(db, "org1", "inst-1");

    expect(summary.listSynced).toBe(1);
    const upsertCall = calls.find((c) => c.table === "sales" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBeNull();
  });

  it("does not requeue an unchanged sale — keeps its existing detail_synced_at", async () => {
    vi.mocked(fetchAllSalesList).mockResolvedValue([
      { SaleID: "sale-1", Updated: "2026-06-01T01:00:00.000Z" },
    ]);
    const { db, calls } = makeFakeDb({
      syncState: { last_list_synced_at: "2026-05-01T00:00:00.000Z" },
      existingSales: [{ cin7_sale_id: "sale-1", cin7_updated_at: "2026-06-01T01:00:00.000Z", detail_synced_at: "2026-06-02T00:00:00.000Z" }],
      pendingSales: [],
    });

    await syncInstanceSales(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "sales" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBe("2026-06-02T00:00:00.000Z");
  });

  it("re-queues a sale whose Updated timestamp changed", async () => {
    vi.mocked(fetchAllSalesList).mockResolvedValue([{ SaleID: "sale-1", Updated: "2026-06-05T00:00:00.000Z" }]);
    const { db, calls } = makeFakeDb({
      syncState: { last_list_synced_at: "2026-05-01T00:00:00.000Z" },
      existingSales: [{ cin7_sale_id: "sale-1", cin7_updated_at: "2026-06-01T01:00:00.000Z", detail_synced_at: "2026-06-02T00:00:00.000Z" }],
      pendingSales: [],
    });

    await syncInstanceSales(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "sales" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBeNull();
  });

  it("defaults to ~12 months ago on first run (no prior sync_state) — bounded initial backfill", async () => {
    const { db } = makeFakeDb({ syncState: null, existingSales: [], pendingSales: [] });
    await syncInstanceSales(db, "org1", "inst-1");

    const [, updatedSince] = vi.mocked(fetchAllSalesList).mock.calls[0];
    const expected = new Date();
    expected.setMonth(expected.getMonth() - 12);
    const diffMs = Math.abs(new Date(updatedSince as string).getTime() - expected.getTime());
    expect(diffMs).toBeLessThan(5000); // both computed via `new Date()` a few ms apart
  });

  it("passes the stored watermark as UpdatedSince on a subsequent run", async () => {
    const { db } = makeFakeDb({ syncState: { last_list_synced_at: "2026-05-01T00:00:00.000Z" }, existingSales: [], pendingSales: [] });
    await syncInstanceSales(db, "org1", "inst-1");
    expect(fetchAllSalesList).toHaveBeenCalledWith(expect.objectContaining(creds), "2026-05-01T00:00:00.000Z");
  });

  it("stores the Order Fulfillment Dashboard's fields (Combined statuses, ShipBy, PaidAmount, etc.) alongside the existing ones", async () => {
    vi.mocked(fetchAllSalesList).mockResolvedValue([
      {
        SaleID: "sale-1",
        OrderDate: "2026-06-20T00:00:00",
        OrderStatus: "AUTHORISED",
        CombinedInvoiceStatus: "INVOICED",
        CombinedPickingStatus: "PICKED",
        CombinedPackingStatus: "NOT PACKED",
        CombinedShippingStatus: "NOT SHIPPED",
        CombinedPaymentStatus: "UNPAID",
        FulFilmentStatus: "NOT FULFILLED",
        ShipBy: "2026-10-26T00:00:00",
        Carrier: "Post",
        CombinedTrackingNumbers: "TRACK123",
        PaidAmount: 0,
        SaleInvoicesTotalAmount: 4608.04,
      },
    ]);
    const { db, calls } = makeFakeDb({ syncState: null, existingSales: [], pendingSales: [] });

    await syncInstanceSales(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "sales" && c.op === "upsert");
    const rows = upsertCall?.args[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      order_date: "2026-06-20",
      order_status: "AUTHORISED",
      combined_invoice_status: "INVOICED",
      combined_picking_status: "PICKED",
      combined_packing_status: "NOT PACKED",
      combined_shipping_status: "NOT SHIPPED",
      combined_payment_status: "UNPAID",
      fulfilment_status: "NOT FULFILLED",
      ship_by: "2026-10-26",
      carrier: "Post",
      tracking_numbers: "TRACK123",
      paid_amount: 0,
      invoice_amount: 4608.04,
    });
  });
});

describe("syncInstanceSales — detail phase", () => {
  it("flattens multiple invoices' lines, tagging each with its own invoice number/date", async () => {
    vi.mocked(fetchSaleDetail).mockResolvedValueOnce({
      ID: "sale-1",
      Location: "Main Warehouse",
      CustomerReference: "PO-98765",
      Invoices: [
        { InvoiceNumber: "INV-1", InvoiceDate: "2026-06-01T00:00:00", Lines: [{ SKU: "SKU-A", Name: "Widget", Quantity: 2, Price: 10, Total: 20, AverageCost: 4 }] },
        { InvoiceNumber: "INV-2", InvoiceDate: "2026-06-15T00:00:00", Lines: [{ SKU: "SKU-B", Name: "Gadget", Quantity: 1, Price: 30, Total: 30, AverageCost: 12 }] },
      ],
    });
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: null }, existingSales: [], pendingSales: [{ cin7_sale_id: "sale-1" }] });

    const summary = await syncInstanceSales(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(summary.detailFailed).toBe(0);
    const insertCall = calls.find((c) => c.table === "sale_lines" && c.op === "insert");
    const lines = insertCall?.args[0] as { invoice_number: string; product_sku: string; line_number: number }[];
    expect(lines).toEqual([
      expect.objectContaining({ invoice_number: "INV-1", product_sku: "SKU-A", line_number: 0 }),
      expect.objectContaining({ invoice_number: "INV-2", product_sku: "SKU-B", line_number: 0 }),
    ]);
    const updateCall = calls.find((c) => c.table === "sales" && c.op === "update");
    expect(updateCall?.args[0]).toMatchObject({ location: "Main Warehouse", customer_reference: "PO-98765" });
  });

  it("records a per-sale failure without aborting the rest of the batch", async () => {
    vi.mocked(fetchSaleDetail)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ID: "sale-2", Invoices: [] });
    const { db } = makeFakeDb({
      syncState: { last_list_synced_at: null },
      existingSales: [],
      pendingSales: [{ cin7_sale_id: "sale-1" }, { cin7_sale_id: "sale-2" }],
    });

    const summary = await syncInstanceSales(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(summary.detailFailed).toBe(1);
    expect(summary.errors).toEqual([{ saleId: "sale-1", error: "boom" }]);
  });

  it("handles a sale detail response with no invoices (no lines to insert)", async () => {
    vi.mocked(fetchSaleDetail).mockResolvedValueOnce({ ID: "sale-1", Invoices: [] });
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: null }, existingSales: [], pendingSales: [{ cin7_sale_id: "sale-1" }] });

    const summary = await syncInstanceSales(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(calls.find((c) => c.table === "sale_lines" && c.op === "insert")).toBeUndefined();
  });

  it("stores Order.Lines[] (with BackorderQuantity) into sale_order_lines", async () => {
    vi.mocked(fetchSaleDetail).mockResolvedValueOnce({
      ID: "sale-1",
      Invoices: [],
      Order: {
        SaleOrderNumber: "SO-1",
        Lines: [
          { SKU: "SKU-A", Name: "Widget", Quantity: 2, BackorderQuantity: 0 },
          { SKU: "SKU-B", Name: "Gadget", Quantity: 3, BackorderQuantity: 1 },
        ],
      },
    });
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: null }, existingSales: [], pendingSales: [{ cin7_sale_id: "sale-1" }] });

    await syncInstanceSales(db, "org1", "inst-1");

    const insertCall = calls.find((c) => c.table === "sale_order_lines" && c.op === "insert");
    const rows = insertCall?.args[0] as { product_sku: string; quantity: number; backorder_quantity: number; line_number: number }[];
    expect(rows).toEqual([
      expect.objectContaining({ product_sku: "SKU-A", quantity: 2, backorder_quantity: 0, line_number: 0 }),
      expect.objectContaining({ product_sku: "SKU-B", quantity: 3, backorder_quantity: 1, line_number: 1 }),
    ]);
  });

  it("skips sale_order_lines insert when Order.Lines[] is empty or Order itself is absent (confirmed live on older sales)", async () => {
    vi.mocked(fetchSaleDetail).mockResolvedValueOnce({ ID: "sale-1", Invoices: [] });
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: null }, existingSales: [], pendingSales: [{ cin7_sale_id: "sale-1" }] });

    await syncInstanceSales(db, "org1", "inst-1");

    expect(calls.find((c) => c.table === "sale_order_lines" && c.op === "delete")).toBeDefined();
    expect(calls.find((c) => c.table === "sale_order_lines" && c.op === "insert")).toBeUndefined();
  });

  it("flattens Pick/Pack lines across multiple Fulfilments[] entries into independently-numbered stage sequences", async () => {
    vi.mocked(fetchSaleDetail).mockResolvedValueOnce({
      ID: "sale-1",
      Invoices: [],
      Fulfilments: [
        {
          TaskID: "f1",
          Pick: { Status: "AUTHORISED", Lines: [{ SKU: "SKU-A", Name: "Widget", Quantity: 2, Location: "Main Warehouse", BatchSN: "BATCH-1" }] },
          Pack: { Status: "NOT AVAILABLE", Lines: [] },
        },
        {
          TaskID: "f2",
          Pick: { Status: "AUTHORISED", Lines: [{ SKU: "SKU-B", Name: "Gadget", Quantity: 1, Location: "Overflow" }] },
          Pack: { Status: "AUTHORISED", Lines: [{ SKU: "SKU-B", Name: "Gadget", Quantity: 1 }] },
        },
      ],
    });
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: null }, existingSales: [], pendingSales: [{ cin7_sale_id: "sale-1" }] });

    await syncInstanceSales(db, "org1", "inst-1");

    const insertCall = calls.find((c) => c.table === "sale_pick_pack_lines" && c.op === "insert");
    const rows = insertCall?.args[0] as { stage: string; product_sku: string; line_number: number; location: string | null; batch_sn: string | null }[];
    expect(rows).toEqual([
      expect.objectContaining({ stage: "pick", product_sku: "SKU-A", line_number: 0, location: "Main Warehouse", batch_sn: "BATCH-1" }),
      expect.objectContaining({ stage: "pick", product_sku: "SKU-B", line_number: 1, location: "Overflow", batch_sn: null }),
      expect.objectContaining({ stage: "pack", product_sku: "SKU-B", line_number: 0, location: null, batch_sn: null }),
    ]);
  });

  it("skips sale_pick_pack_lines insert when there are no fulfilments yet", async () => {
    vi.mocked(fetchSaleDetail).mockResolvedValueOnce({ ID: "sale-1", Invoices: [] });
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: null }, existingSales: [], pendingSales: [{ cin7_sale_id: "sale-1" }] });

    await syncInstanceSales(db, "org1", "inst-1");

    expect(calls.find((c) => c.table === "sale_pick_pack_lines" && c.op === "delete")).toBeDefined();
    expect(calls.find((c) => c.table === "sale_pick_pack_lines" && c.op === "insert")).toBeUndefined();
  });
});

describe("syncOrgSales", () => {
  it("continues to the next instance after one fails", async () => {
    const instances = [
      { id: "inst-1", org_id: "org1" },
      { id: "inst-2", org_id: "org1" },
    ];
    const db = {
      from: (table: string) => {
        if (table !== "cin7_instances") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({ eq: () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: instances, error: null }) }) }),
        };
      },
    } as unknown as SupabaseClient;

    vi.mocked(loadCin7Credentials).mockRejectedValueOnce(new Error("Instance not found")).mockResolvedValueOnce({ ...creds, name: "OK" });

    const results = await syncOrgSales(db);

    expect(results).toHaveLength(2);
    expect(results[0].errors[0].error).toBe("Instance not found");
    expect(results[1].instanceId).toBe("inst-2");
  });
});
