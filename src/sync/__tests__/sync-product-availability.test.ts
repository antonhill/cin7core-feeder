import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstanceProductAvailability, syncOrgProductAvailability } from "@/sync/sync-product-availability";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductAvailability } from "@/cin7/product-availability";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/product-availability", () => ({ fetchAllProductAvailability: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

function makeFakeDb() {
  const calls: { table: string; op: string; args: unknown[] }[] = [];

  const db = {
    from: (table: string) => {
      if (table === "product_availability") {
        return {
          delete: () => {
            calls.push({ table, op: "delete", args: [] });
            const chainObj: Record<string, unknown> = {
              eq: (...args: unknown[]) => {
                calls.push({ table, op: "eq", args });
                return chainObj;
              },
              then: (resolve: (v: unknown) => void) => resolve({ error: null }),
            };
            return chainObj;
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
  vi.mocked(fetchAllProductAvailability).mockReset().mockResolvedValue([]);
});

describe("syncInstanceProductAvailability", () => {
  it("deletes the instance's prior snapshot before inserting the fresh one", async () => {
    vi.mocked(fetchAllProductAvailability).mockResolvedValue([{ ID: "1", SKU: "SKU-1", Name: "Widget", Location: "Main", OnHand: 5, Available: 5 }]);
    const { db, calls } = makeFakeDb();

    await syncInstanceProductAvailability(db, "org1", "inst-1");

    const relevant = calls.filter((c) => c.table === "product_availability");
    const deleteIndex = relevant.findIndex((c) => c.op === "delete");
    const insertIndex = relevant.findIndex((c) => c.op === "insert");
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(deleteIndex);
  });

  it("scopes the delete to this org and instance", async () => {
    const { db, calls } = makeFakeDb();
    await syncInstanceProductAvailability(db, "org1", "inst-1");
    const eqCalls = calls.filter((c) => c.table === "product_availability" && c.op === "eq");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { table: "product_availability", op: "eq", args: ["org_id", "org1"] },
        { table: "product_availability", op: "eq", args: ["instance_id", "inst-1"] },
      ])
    );
  });

  it("maps Cin7 fields onto the row shape, including OnHand -> on_hand and StockOnHand -> stock_value", async () => {
    vi.mocked(fetchAllProductAvailability).mockResolvedValue([
      {
        ID: "1",
        SKU: "SKU-1",
        Name: "Widget",
        Location: "Main",
        Bin: "Bin1",
        Batch: "BATCH-A",
        ExpiryDate: "2026-06-30T00:00:00",
        OnHand: 88,
        Available: 22,
        OnOrder: 0,
        InTransit: 0,
        Allocated: 66,
        StockOnHand: 20910.032,
        NextDeliveryDate: "2026-01-12T00:00:00",
      },
    ]);
    const { db, calls } = makeFakeDb();

    await syncInstanceProductAvailability(db, "org1", "inst-1");

    const insertCall = calls.find((c) => c.table === "product_availability" && c.op === "insert");
    const rows = insertCall?.args[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      product_sku: "SKU-1",
      product_name: "Widget",
      location: "Main",
      bin: "Bin1",
      batch_sn: "BATCH-A",
      expiry_date: "2026-06-30",
      on_hand: 88,
      available: 22,
      allocated: 66,
      stock_value: 20910.032,
      next_delivery_date: "2026-01-12",
    });
  });

  it("still deletes the prior snapshot but skips inserting when the live list is empty", async () => {
    vi.mocked(fetchAllProductAvailability).mockResolvedValue([]);
    const { db, calls } = makeFakeDb();

    const summary = await syncInstanceProductAvailability(db, "org1", "inst-1");

    expect(summary.rowsSynced).toBe(0);
    expect(calls.find((c) => c.table === "product_availability" && c.op === "delete")).toBeDefined();
    expect(calls.find((c) => c.table === "product_availability" && c.op === "insert")).toBeUndefined();
  });
});

describe("syncOrgProductAvailability", () => {
  it("continues to the next instance after one fails", async () => {
    const instances = [
      { id: "inst-1", org_id: "org1" },
      { id: "inst-2", org_id: "org1" },
    ];
    const { db: productDb } = makeFakeDb();
    const db = {
      from: (table: string) => {
        if (table === "cin7_instances") {
          return {
            select: () => ({ eq: () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: instances, error: null }) }) }),
          };
        }
        return productDb.from(table);
      },
    } as unknown as SupabaseClient;

    vi.mocked(loadCin7Credentials).mockRejectedValueOnce(new Error("Instance not found")).mockResolvedValueOnce({ ...creds, name: "OK" });

    const results = await syncOrgProductAvailability(db);

    expect(results).toHaveLength(2);
    expect(results[0].error).toBe("Instance not found");
    expect(results[1].instanceId).toBe("inst-2");
  });
});
