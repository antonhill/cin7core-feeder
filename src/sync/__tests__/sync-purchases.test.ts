import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstancePurchases, syncOrgPurchases } from "@/sync/sync-purchases";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/purchases", () => ({ fetchAllPurchasesList: vi.fn() }));
vi.mock("@/cin7/purchase-detail", () => ({ fetchPurchaseDetail: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

interface FakeDbOptions {
  existingPurchases?: { cin7_purchase_id: string; combined_receiving_status: string | null; detail_synced_at: string | null }[];
  pendingPurchases?: { cin7_purchase_id: string }[];
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
      then: (resolve: (v: unknown) => void) => resolve(terminalResult()),
    };
    return obj;
  }

  const db = {
    from: (table: string) => {
      if (table === "purchases") {
        return {
          select: (cols: string) => {
            calls.push({ table, op: "select", args: [cols] });
            const result = cols.includes("combined_receiving_status") ? (opts.existingPurchases ?? []) : (opts.pendingPurchases ?? []);
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
      if (table === "purchase_receipt_lines" || table === "purchase_order_lines") {
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
      throw new Error(`Unhandled table in fake db: ${table}`);
    },
  };

  return { db: db as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({ ...creds, name: "Spark Demo" });
  vi.mocked(fetchAllPurchasesList).mockReset().mockResolvedValue([]);
  vi.mocked(fetchPurchaseDetail).mockReset();
});

describe("syncInstancePurchases — list phase", () => {
  it("includes a purchase that has never received anything (needed for backorder-ETA cross-referencing)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-1", CombinedReceivingStatus: "NOT RECEIVED" }]);
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.listSynced).toBe(1);
    expect(calls.find((c) => c.table === "purchases" && c.op === "upsert")).toBeDefined();
  });

  it("excludes a VOIDED purchase regardless of receiving status", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-1", CombinedReceivingStatus: "NOT RECEIVED", Status: "VOIDED" }]);
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.listSynced).toBe(0);
    expect(calls.find((c) => c.table === "purchases" && c.op === "upsert")).toBeUndefined();
  });

  it("stores RequiredBy as required_by, trimmed to a plain date", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([
      { ID: "po-1", CombinedReceivingStatus: "NOT RECEIVED", RequiredBy: "2026-08-01T00:00:00" },
    ]);
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [] });

    await syncInstancePurchases(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "purchases" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { required_by: unknown }[];
    expect(rows[0].required_by).toBe("2026-08-01");
  });

  it("queues a brand-new received purchase for detail sync (detail_synced_at cleared)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([
      { ID: "po-1", OrderNumber: "PO-1", Supplier: "Acme", CombinedReceivingStatus: "FULLY RECEIVED", OrderDate: "2026-06-01T00:00:00" },
    ]);
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.listSynced).toBe(1);
    const upsertCall = calls.find((c) => c.table === "purchases" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBeNull();
  });

  it("does not requeue a purchase whose receiving status is unchanged", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-1", CombinedReceivingStatus: "FULLY RECEIVED" }]);
    const { db, calls } = makeFakeDb({
      existingPurchases: [{ cin7_purchase_id: "po-1", combined_receiving_status: "FULLY RECEIVED", detail_synced_at: "2026-06-02T00:00:00.000Z" }],
      pendingPurchases: [],
    });

    await syncInstancePurchases(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "purchases" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBe("2026-06-02T00:00:00.000Z");
  });

  it("re-queues a purchase whose receiving status changed (e.g. partial -> fully received)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-1", CombinedReceivingStatus: "FULLY RECEIVED" }]);
    const { db, calls } = makeFakeDb({
      existingPurchases: [{ cin7_purchase_id: "po-1", combined_receiving_status: "PARTIALLY RECEIVED", detail_synced_at: "2026-06-02T00:00:00.000Z" }],
      pendingPurchases: [],
    });

    await syncInstancePurchases(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "purchases" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBeNull();
  });
});

describe("syncInstancePurchases — detail phase", () => {
  it("stores receipt lines keyed by CardID and records which endpoint served the purchase", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({
      source: "advanced-purchase",
      receiptLines: [
        { cardId: "card-1", productSku: "SKU-A", productName: "Widget", quantity: 5, receivedDate: "2026-01-30", location: "Main", locationId: "loc-1" },
        { cardId: "card-2", productSku: "SKU-A", productName: "Widget", quantity: 5, receivedDate: "2026-01-31", location: "Main", locationId: "loc-1" },
      ],
      orderLines: [],
      isDropShip: false,
    });
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(summary.detailFailed).toBe(0);
    const insertCall = calls.find((c) => c.table === "purchase_receipt_lines" && c.op === "insert");
    const lines = insertCall?.args[0] as { card_id: string; quantity: number }[];
    expect(lines).toEqual([
      expect.objectContaining({ card_id: "card-1", quantity: 5 }),
      expect.objectContaining({ card_id: "card-2", quantity: 5 }),
    ]);
    const updateCall = calls.find((c) => c.table === "purchases" && c.op === "update");
    expect(updateCall?.args[0]).toMatchObject({ source: "advanced-purchase", is_drop_ship: false });
  });

  it("stores Order.Lines[] into purchase_order_lines", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({
      source: "purchase",
      receiptLines: [],
      orderLines: [
        { productSku: "SKU-A", productName: "Widget", quantity: 10 },
        { productSku: "SKU-B", productName: "Gadget", quantity: 3 },
      ],
      isDropShip: false,
    });
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }] });

    await syncInstancePurchases(db, "org1", "inst-1");

    const insertCall = calls.find((c) => c.table === "purchase_order_lines" && c.op === "insert");
    const rows = insertCall?.args[0] as { product_sku: string; quantity: number; line_number: number }[];
    expect(rows).toEqual([
      expect.objectContaining({ product_sku: "SKU-A", quantity: 10, line_number: 0 }),
      expect.objectContaining({ product_sku: "SKU-B", quantity: 3, line_number: 1 }),
    ]);
  });

  it("records is_drop_ship on the purchase when the detail response is a drop-shipment", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: true });
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }] });

    await syncInstancePurchases(db, "org1", "inst-1");

    const updateCall = calls.find((c) => c.table === "purchases" && c.op === "update");
    expect(updateCall?.args[0]).toMatchObject({ is_drop_ship: true });
  });

  it("records a per-purchase failure without aborting the rest of the batch", async () => {
    vi.mocked(fetchPurchaseDetail)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false });
    const { db } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }, { cin7_purchase_id: "po-2" }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(summary.detailFailed).toBe(1);
    expect(summary.errors).toEqual([{ purchaseId: "po-1", error: "boom" }]);
  });

  it("handles a purchase detail response with no receipt lines or order lines", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false });
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(calls.find((c) => c.table === "purchase_receipt_lines" && c.op === "insert")).toBeUndefined();
    expect(calls.find((c) => c.table === "purchase_order_lines" && c.op === "insert")).toBeUndefined();
  });
});

describe("syncOrgPurchases", () => {
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

    const results = await syncOrgPurchases(db);

    expect(results).toHaveLength(2);
    expect(results[0].errors[0].error).toBe("Instance not found");
    expect(results[1].instanceId).toBe("inst-2");
  });
});
