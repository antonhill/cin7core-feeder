import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstanceProductAvailability, syncOrgProductAvailability } from "@/sync/sync-product-availability";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductAvailability } from "@/cin7/product-availability";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/product-availability", () => ({ fetchAllProductAvailability: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

/**
 * Security re-audit P0-7: syncInstanceProductAvailability now calls the
 * atomic replace_product_availability RPC (migration 0074) instead of a
 * separate delete + insert — this fake db mocks .rpc() accordingly. The
 * RPC's own atomicity (a failure rolls back the delete too, preserving the
 * previous snapshot) is proven live against production, not by this unit
 * test — see PROJECT-NOTES.md / the PR description for that evidence. What
 * this file still covers: the exact args passed to the RPC (org/instance
 * scoping, Cin7-field-to-row-shape mapping) and per-instance failure
 * isolation in syncOrgProductAvailability.
 */
function makeFakeDb() {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ error: null });
    },
  };

  return { db: db as unknown as SupabaseClient, rpcCalls };
}

beforeEach(() => {
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({ ...creds, name: "Spark Demo" });
  vi.mocked(fetchAllProductAvailability).mockReset().mockResolvedValue([]);
});

describe("syncInstanceProductAvailability", () => {
  it("calls replace_product_availability scoped to this org and instance", async () => {
    vi.mocked(fetchAllProductAvailability).mockResolvedValue([{ ID: "1", SKU: "SKU-1", Name: "Widget", Location: "Main", OnHand: 5, Available: 5 }]);
    const { db, rpcCalls } = makeFakeDb();

    await syncInstanceProductAvailability(db, "org1", "inst-1");

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("replace_product_availability");
    expect(rpcCalls[0].args.p_org_id).toBe("org1");
    expect(rpcCalls[0].args.p_instance_id).toBe("inst-1");
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
    const { db, rpcCalls } = makeFakeDb();

    await syncInstanceProductAvailability(db, "org1", "inst-1");

    const rows = rpcCalls[0].args.p_rows as Record<string, unknown>[];
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

  it("still calls the RPC (with an empty row array) even when the live list is empty — the RPC's own delete still needs to run to clear a stale snapshot", async () => {
    vi.mocked(fetchAllProductAvailability).mockResolvedValue([]);
    const { db, rpcCalls } = makeFakeDb();

    const summary = await syncInstanceProductAvailability(db, "org1", "inst-1");

    expect(summary.rowsSynced).toBe(0);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.p_rows).toEqual([]);
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
        throw new Error(`Unhandled table in fake db: ${table}`);
      },
      rpc: productDb.rpc,
    } as unknown as SupabaseClient;

    vi.mocked(loadCin7Credentials).mockRejectedValueOnce(new Error("Instance not found")).mockResolvedValueOnce({ ...creds, name: "OK" });

    const results = await syncOrgProductAvailability(db);

    expect(results).toHaveLength(2);
    expect(results[0].error).toBe("Instance not found");
    expect(results[1].instanceId).toBe("inst-2");
  });
});
