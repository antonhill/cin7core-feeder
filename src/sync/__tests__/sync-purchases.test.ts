import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstancePurchases, syncOrgPurchases } from "@/sync/sync-purchases";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";
import { Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/purchases", () => ({ fetchAllPurchasesList: vi.fn() }));
vi.mock("@/cin7/purchase-detail", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/cin7/purchase-detail")>()), fetchPurchaseDetail: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

interface FakeDbOptions {
  syncState?: { last_list_synced_at: string | null } | null;
  existingPurchases?: { cin7_purchase_id: string; combined_receiving_status: string | null; detail_synced_at: string | null }[];
  pendingPurchases?: { cin7_purchase_id: string }[];
  rpcError?: string;
  /** Rows the throttle lookup on activity_log should find (already-logged failure within the window). */
  recentFailureRows?: { id: string }[];
  /** When set, the 0125 purchase_refresh_queue RPC returns these rows; when unset it behaves like "function not deployed" (legacy path). */
  queue?: { cin7_purchase_id: string; order_number?: string | null; source?: string | null; combined_receiving_status?: string | null; reason: "unsynced" | "relisted" | "open_ttl" }[];
  /** Result of replace_purchase_detail_guarded (default true = applied). */
  guardedResult?: boolean;
  /** Simulates the guarded function not being deployed. */
  guardedMissing?: boolean;
  /** Cached rows the refresh reads before deciding. */
  cachedOrderLines?: { quantity: number }[];
  cachedReceiptLines?: { quantity: number }[];
  /** purchase ids the rejected-skip lookup on activity_log should return. */
  rejectedPurchaseIds?: string[];
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
      gte: (...args: unknown[]) => {
        calls.push({ table, op: "gte", args });
        return obj;
      },
      maybeSingle: async () => terminalResult(),
      then: (resolve: (v: unknown) => void) => resolve(terminalResult()),
    };
    return obj;
  }

  const db = {
    from: (table: string) => {
      if (table === "purchases_sync_state") {
        return {
          ...chain(table, () => ({ data: opts.syncState ?? null, error: null })),
          upsert: (row: unknown, conflictOpts: unknown) => {
            calls.push({ table, op: "upsert", args: [row, conflictOpts] });
            return Promise.resolve({ error: null });
          },
        };
      }
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
      if (table === "purchase_order_lines" || table === "purchase_receipt_lines") {
        return {
          select: (...args: unknown[]) => {
            calls.push({ table, op: "select", args });
            const rows = table === "purchase_order_lines" ? (opts.cachedOrderLines ?? []) : (opts.cachedReceiptLines ?? []);
            return chain(table, () => ({ data: rows, error: null }));
          },
        };
      }
      if (table === "activity_log") {
        return {
          select: (...args: unknown[]) => {
            calls.push({ table, op: "select", args });
            // The rejected-skip lookup selects `detail`; the throttle lookup selects `id`.
            const wantsDetail = args[0] === "detail";
            return chain(table, () => ({
              data: wantsDetail ? (opts.rejectedPurchaseIds ?? []).map((id) => ({ detail: { purchase_id: id } })) : (opts.recentFailureRows ?? []),
              error: null,
            }));
          },
          insert: (row: unknown) => {
            calls.push({ table, op: "insert", args: [row] });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`Unhandled table in fake db: ${table}`);
    },
    // Security re-audit P0-7: syncPurchaseDetails now calls the atomic
    // replace_purchase_detail RPC (migration 0074) instead of 4 separate
    // delete/insert/update calls — the RPC's own atomicity is proven live
    // against production (see the PR description), not by this unit test;
    // this just records the args it was called with.
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ table: "__rpc__", op: fn, args: [args] });
      if (fn === "purchase_refresh_queue") {
        return Promise.resolve(opts.queue ? { data: opts.queue, error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function public.purchase_refresh_queue" } });
      }
      if (fn === "replace_purchase_detail_guarded") {
        if (opts.guardedMissing) return Promise.resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function public.replace_purchase_detail_guarded" } });
        if (opts.rpcError) return Promise.resolve({ data: null, error: { message: opts.rpcError } });
        return Promise.resolve({ data: opts.guardedResult ?? true, error: null });
      }
      return Promise.resolve({ error: opts.rpcError ? { message: opts.rpcError } : null });
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

  it("defaults to ~12 months ago on first run (no prior sync_state) — bounded initial backfill", async () => {
    const { db } = makeFakeDb({ syncState: null, existingPurchases: [], pendingPurchases: [] });
    await syncInstancePurchases(db, "org1", "inst-1");

    const [, updatedSince] = vi.mocked(fetchAllPurchasesList).mock.calls[0];
    const expected = new Date();
    expected.setMonth(expected.getMonth() - 12);
    const diffMs = Math.abs(new Date(updatedSince as string).getTime() - expected.getTime());
    expect(diffMs).toBeLessThan(5000); // both computed via `new Date()` a few ms apart
  });

  it("passes the stored watermark as UpdatedSince on a subsequent run", async () => {
    const { db } = makeFakeDb({ syncState: { last_list_synced_at: "2026-05-01T00:00:00.000Z" }, existingPurchases: [], pendingPurchases: [] });
    await syncInstancePurchases(db, "org1", "inst-1");
    // The watermark is held back by the pagination overlap (default 10 minutes) so entries shifted between pages are re-listed.
    expect(fetchAllPurchasesList).toHaveBeenCalledWith(expect.objectContaining(creds), "2026-04-30T23:50:00.000Z");
  });

  it("advances the watermark even when nothing came back changed", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([]);
    const { db, calls } = makeFakeDb({ syncState: { last_list_synced_at: "2026-05-01T00:00:00.000Z" }, existingPurchases: [], pendingPurchases: [] });

    await syncInstancePurchases(db, "org1", "inst-1");

    const stateUpsert = calls.find((c) => c.table === "purchases_sync_state" && c.op === "upsert");
    expect(stateUpsert).toBeDefined();
    const [row] = stateUpsert!.args as [{ org_id: string; instance_id: string; last_list_synced_at: string }, unknown];
    expect(row.last_list_synced_at).not.toBe("2026-05-01T00:00:00.000Z");
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
    const rpcCall = calls.find((c) => c.table === "__rpc__" && c.op === "replace_purchase_detail");
    const rpcArgs = rpcCall?.args[0] as { p_receipt_lines: { card_id: string; quantity: number }[]; p_source: string; p_is_drop_ship: boolean };
    expect(rpcArgs.p_receipt_lines).toEqual([
      expect.objectContaining({ card_id: "card-1", quantity: 5 }),
      expect.objectContaining({ card_id: "card-2", quantity: 5 }),
    ]);
    expect(rpcArgs).toMatchObject({ p_source: "advanced-purchase", p_is_drop_ship: false });
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

    const rpcCall = calls.find((c) => c.table === "__rpc__" && c.op === "replace_purchase_detail");
    const rows = (rpcCall?.args[0] as { p_order_lines: { product_sku: string; quantity: number; line_number: number }[] }).p_order_lines;
    expect(rows).toEqual([
      expect.objectContaining({ product_sku: "SKU-A", quantity: 10, line_number: 0 }),
      expect.objectContaining({ product_sku: "SKU-B", quantity: 3, line_number: 1 }),
    ]);
  });

  it("records is_drop_ship on the purchase when the detail response is a drop-shipment", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: true });
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }] });

    await syncInstancePurchases(db, "org1", "inst-1");

    const rpcCall = calls.find((c) => c.table === "__rpc__" && c.op === "replace_purchase_detail");
    expect(rpcCall?.args[0]).toMatchObject({ p_is_drop_ship: true });
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

  it("security re-audit P0-7: an error from replace_purchase_detail (e.g. a rolled-back transaction) is recorded as a per-purchase failure too, not just a fetchPurchaseDetail throw", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false });
    const { db } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }], rpcError: "constraint violation" });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(0);
    expect(summary.detailFailed).toBe(1);
    expect(summary.errors).toEqual([{ purchaseId: "po-1", error: "replace_purchase_detail: constraint violation" }]);
  });

  it("handles a purchase detail response with no receipt lines or order lines", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false });
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    const rpcCall = calls.find((c) => c.table === "__rpc__" && c.op === "replace_purchase_detail");
    expect(rpcCall?.args[0]).toMatchObject({ p_receipt_lines: [], p_order_lines: [] });
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

describe("syncInstancePurchases — duplicate-receipt regression and failure diagnostics", () => {
  const aggregatedDetail = {
    source: "advanced-purchase" as const,
    // What fetchPurchaseDetail now returns for PO-14939: the four 21/20/106/233 lines already collapsed to one key.
    receiptLines: [{ cardId: "card-1", productSku: "LBLINSTALLATIONNONIP", productName: "Installation", quantity: 380, receivedDate: "2026-10-29", location: "Main", locationId: "loc-1" }],
    orderLines: [{ productSku: "LBLINSTALLATIONNONIP", productName: "Installation", quantity: 380 }],
    isDropShip: false,
  };

  it("PO-14939: sends one row per (card_id, product_sku) with the 380 total to the atomic replace", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValueOnce(aggregatedDetail);
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-14939", order_number: "PO-14939" } as { cin7_purchase_id: string }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary).toMatchObject({ detailSynced: 1, detailFailed: 0 });
    const args = calls.find((c) => c.table === "__rpc__" && c.op === "replace_purchase_detail")?.args[0] as { p_receipt_lines: { card_id: string; product_sku: string; quantity: number }[] };
    const keys = args.p_receipt_lines.map((l) => `${l.card_id}|${l.product_sku}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(args.p_receipt_lines.reduce((n, l) => n + l.quantity, 0)).toBe(380);
  });

  it("repeated synchronisation sends the identical payload each time (replace is idempotent) and records no failures", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(aggregatedDetail);
    const first = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-14939" }] });
    const second = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-14939" }] });

    await syncInstancePurchases(first.db, "org1", "inst-1");
    await syncInstancePurchases(second.db, "org1", "inst-1");

    const payload = (c: { calls: { table: string; op: string; args: unknown[] }[] }) => c.calls.find((x) => x.table === "__rpc__" && x.op === "replace_purchase_detail")?.args[0];
    expect(payload(second)).toEqual(payload(first));
    expect(first.calls.some((c) => c.table === "activity_log")).toBe(false);
  });

  it("a failed detail sync is recorded as a sanitised, persistent diagnostic naming the PO — and does not abort the batch", async () => {
    vi.mocked(fetchPurchaseDetail)
      .mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false })
      .mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false });
    const { db, calls } = makeFakeDb({
      existingPurchases: [],
      pendingPurchases: [{ cin7_purchase_id: "po-14939", order_number: "PO-14939" } as { cin7_purchase_id: string }, { cin7_purchase_id: "po-2" }],
      rpcError: 'duplicate key value violates unique constraint "purchase_receipt_lines_pkey" Key (org_id, instance_id, card_id, product_sku)=(11111111-2222-3333-4444-555555555555, x, y, z) already exists.',
    });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailFailed).toBe(2);
    const insert = calls.find((c) => c.table === "activity_log" && c.op === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ org_id: "org1", instance_id: "inst-1", action: "diagnostic.purchase_detail_sync_failed" });
    expect(String(insert.summary)).toContain("PO-14939");
    expect(JSON.stringify(insert)).not.toMatch(/11111111-2222|card_id, product_sku/);
    expect((insert.detail as Record<string, unknown>).code).toBe("duplicate_key");
  });

  it("does not re-record the same PO's failure inside the throttle window (no log spam every 15 minutes)", async () => {
    vi.mocked(fetchPurchaseDetail).mockRejectedValueOnce(new Error("boom"));
    const { db, calls } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }], recentFailureRows: [{ id: "already" }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary.detailFailed).toBe(1);
    expect(calls.some((c) => c.table === "activity_log" && c.op === "insert")).toBe(false);
  });

  it("a failing diagnostic write never fails or aborts the sync", async () => {
    vi.mocked(fetchPurchaseDetail).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ source: "purchase", receiptLines: [], orderLines: [], isDropShip: false });
    const { db } = makeFakeDb({ existingPurchases: [], pendingPurchases: [{ cin7_purchase_id: "po-1" }, { cin7_purchase_id: "po-2" }] });
    const original = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "activity_log") throw new Error("activity_log down");
      return original(t);
    };

    const summary = await syncInstancePurchases(db, "org1", "inst-1");

    expect(summary).toMatchObject({ detailSynced: 1, detailFailed: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Issue #206 / migration 0125: prioritised refresh queue, guards, budget and instrumentation.
// ---------------------------------------------------------------------------------------------------------------
describe("purchase detail refresh (0125 queue)", () => {
  const cfg = { maxPerRun: 3, openTtlHours: 24, listOverlapMinutes: 0, safetyMs: 45_000 };
  const full = (over: Record<string, unknown> = {}) => ({
    source: "purchase" as const,
    isDropShip: false,
    receiptSectionPresent: true,
    orderLines: [{ productSku: "A", productName: "A", quantity: 10 }],
    receiptLines: [{ cardId: "c1", productSku: "A", productName: "A", quantity: 4, receivedDate: "2026-11-01", location: "Main", locationId: "l" }],
    ...over,
  });
  const q = (id: string, reason: "unsynced" | "relisted" | "open_ttl", extra: Record<string, unknown> = {}) => ({ cin7_purchase_id: id, order_number: `PO-${id}`, source: "purchase", combined_receiving_status: "PARTIALLY RECEIVED", reason, ...extra });
  const rpcCalls = (calls: { table: string; op: string; args: unknown[] }[], fn: string) => calls.filter((c) => c.table === "__rpc__" && c.op === fn);

  it("asks the queue function for THIS org+instance only, and fetches each PO with its source hint", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ source: "advanced-purchase" }));
    const { db, calls } = makeFakeDb({ queue: [q("p1", "unsynced", { source: "advanced-purchase" })], cachedOrderLines: [], cachedReceiptLines: [] });

    await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(rpcCalls(calls, "purchase_refresh_queue")[0].args[0]).toMatchObject({ p_org_id: "org1", p_instance_id: "inst-1", p_open_ttl_hours: 24 });
    expect(vi.mocked(fetchPurchaseDetail)).toHaveBeenCalledWith(expect.anything(), "p1", { sourceHint: "advanced-purchase" });
    // cached-detail lookups are tenant scoped
    const eqs = calls.filter((c) => (c.table === "purchase_order_lines" || c.table === "purchase_receipt_lines") && c.op === "eq").map((c) => c.args.join("="));
    expect(eqs).toEqual(expect.arrayContaining(["org_id=org1", "instance_id=inst-1", "cin7_purchase_id=p1"]));
  });

  it("caps the work per run at maxPerRun (the capacity this route reserves)", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const queue = ["p1", "p2", "p3", "p4", "p5"].map((id) => q(id, "relisted"));
    const { db } = makeFakeDb({ queue, cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(vi.mocked(fetchPurchaseDetail)).toHaveBeenCalledTimes(3);
    expect(summary.detailSynced).toBe(3);
  });

  it("refreshes a RELISTED PO whose receipts changed with NO status change, via the newer-wins guard", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ receiptLines: [
      { cardId: "c1", productSku: "A", productName: "A", quantity: 4, receivedDate: "2026-11-01", location: "Main", locationId: "l" },
      { cardId: "c2", productSku: "A", productName: "A", quantity: 3, receivedDate: "2026-11-05", location: "Main", locationId: "l" },
    ] }));
    const { db, calls } = makeFakeDb({ queue: [q("p1", "relisted")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailSynced: 1, detailRefreshed: 1, refreshChanged: 1, refreshChangedWithoutRelist: 0, refreshRejected: 0 });
    const guarded = rpcCalls(calls, "replace_purchase_detail_guarded")[0].args[0] as { p_receipt_lines: unknown[]; p_fetched_at: string };
    expect(guarded.p_receipt_lines).toHaveLength(2);
    expect(Date.parse(guarded.p_fetched_at)).not.toBeNaN();
  });

  it("an OPEN PO past its TTL that CHANGED without Cin7 relisting it is counted and recorded (evidence about LastUpdatedDate)", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ receiptLines: [{ cardId: "c1", productSku: "A", productName: "A", quantity: 9, receivedDate: "2026-11-02", location: "Main", locationId: "l" }] }));
    const { db, calls } = makeFakeDb({ queue: [q("p1", "open_ttl")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailRefreshed: 1, refreshChanged: 1, refreshChangedWithoutRelist: 1 });
    const insert = calls.find((c) => c.table === "activity_log" && c.op === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ action: "diagnostic.purchase_refresh_changed_without_relist", org_id: "org1", instance_id: "inst-1" });
    expect((insert.detail as { before: { receiptQty: number }; after: { receiptQty: number } }).before.receiptQty).toBe(4);
    expect((insert.detail as { after: { receiptQty: number } }).after.receiptQty).toBe(9);
  });

  it("an unchanged open-TTL revalidation is applied quietly (no diagnostic, not counted as changed)", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const { db, calls } = makeFakeDb({ queue: [q("p1", "open_ttl")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailSynced: 1, detailRefreshed: 1, refreshChanged: 0, refreshChangedWithoutRelist: 0 });
    expect(calls.some((c) => c.table === "activity_log" && c.op === "insert")).toBe(false);
  });

  it("PRESERVES cached receipts when the response is contradictory: zero receipts while Cin7's list says PARTIALLY RECEIVED", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ receiptLines: [] }));
    const { db, calls } = makeFakeDb({ queue: [q("p1", "relisted")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailSynced: 0, detailFailed: 0, refreshRejected: 1 });
    expect(rpcCalls(calls, "replace_purchase_detail_guarded")).toHaveLength(0);
    expect(rpcCalls(calls, "replace_purchase_detail")).toHaveLength(0);
    const insert = calls.find((c) => c.table === "activity_log" && c.op === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ action: "diagnostic.purchase_refresh_rejected" });
    expect((insert.detail as { code: string }).code).toBe("zero_receipts_contradicts_status");
  });

  it("PRESERVES cached receipts when the response has no receipt section at all", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ receiptLines: [], receiptSectionPresent: false }));
    const { db, calls } = makeFakeDb({ queue: [q("p1", "relisted", { combined_receiving_status: "NOT RECEIVED" })], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary.refreshRejected).toBe(1);
    expect(rpcCalls(calls, "replace_purchase_detail_guarded")).toHaveLength(0);
  });

  it("applies zero receipts when the list status is NOT RECEIVED (a legitimately reversed receipt)", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ receiptLines: [] }));
    const { db } = makeFakeDb({ queue: [q("p1", "relisted", { combined_receiving_status: "NOT RECEIVED" })], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailSynced: 1, refreshChanged: 1, refreshRejected: 0 });
  });

  it("a fetch that loses the race to a newer stored detail is skipped, not applied and not an error", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const { db } = makeFakeDb({ queue: [q("p1", "relisted")], guardedResult: false, cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailSynced: 0, detailFailed: 0, skippedNewer: 1 });
  });

  it("falls back to replace_purchase_detail if the guarded function is not deployed", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const { db, calls } = makeFakeDb({ queue: [q("p1", "unsynced")], guardedMissing: true });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary.detailSynced).toBe(1);
    expect(rpcCalls(calls, "replace_purchase_detail")).toHaveLength(1);
  });

  it("uses the legacy unsynced-only path (and says so) when the queue function is not deployed yet", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const { db } = makeFakeDb({ pendingPurchases: [{ cin7_purchase_id: "p1" }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ legacyQueue: true, detailSynced: 1 });
  });

  it("honours the cron time budget: starts no fetch when less than safetyMs remains", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const { db } = makeFakeDb({ queue: [q("p1", "relisted"), q("p2", "relisted")] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg, deadlineAt: Date.now() + 10_000 });

    expect(vi.mocked(fetchPurchaseDetail)).not.toHaveBeenCalled();
    expect(summary.stoppedEarly).toBe("budget");
  });

  it("syncOrgPurchases passes the cron's remaining budget down: with 1s left no fetch starts; with no budget it runs", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const build = () => {
      const base = makeFakeDb({ queue: [q("p1", "relisted")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });
      const inner = base.db as unknown as { from: (t: string) => unknown; rpc: unknown };
      return {
        db: {
          rpc: inner.rpc,
          from: (t: string) =>
            t === "cin7_instances"
              ? { select: () => ({ eq: () => ({ then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: "inst-1", org_id: "org1" }], error: null }) }) }) }
              : inner.from(t),
        } as unknown as SupabaseClient,
      };
    };

    const limited = await syncOrgPurchases(build().db, undefined, undefined, 1_000);
    expect(limited[0].stoppedEarly).toBe("budget");
    expect(vi.mocked(fetchPurchaseDetail)).not.toHaveBeenCalled();

    const unlimited = await syncOrgPurchases(build().db);
    expect(unlimited[0].detailSynced).toBe(1);
    expect(vi.mocked(fetchPurchaseDetail)).toHaveBeenCalledTimes(1);
  });

  it("stops spending Cin7 budget on an instance the moment it is rate limited", async () => {
    vi.mocked(fetchPurchaseDetail).mockRejectedValue(new Cin7ApiError(503, "Rate limited (60 calls/min) and retries exhausted", true));
    const { db } = makeFakeDb({ queue: [q("p1", "relisted"), q("p2", "relisted"), q("p3", "relisted")] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(vi.mocked(fetchPurchaseDetail)).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ stoppedEarly: "rate_limit", detailFailed: 1 });
  });

  it("a PO whose refresh was recently REJECTED is skipped so it cannot hog the head of the queue", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const { db } = makeFakeDb({ queue: [q("rej", "relisted"), q("ok1", "relisted")], rejectedPurchaseIds: ["rej"], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    const fetched = vi.mocked(fetchPurchaseDetail).mock.calls.map((c) => c[1]);
    expect(fetched).toEqual(["ok1"]);
  });

  it("partial failure: one PO failing does not stop the others, and failures are persisted", async () => {
    vi.mocked(fetchPurchaseDetail).mockRejectedValueOnce(new Error("boom")).mockResolvedValue(full());
    const { db, calls } = makeFakeDb({ queue: [q("p1", "relisted"), q("p2", "relisted")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary).toMatchObject({ detailSynced: 1, detailFailed: 1 });
    expect(calls.some((c) => c.table === "activity_log" && c.op === "insert" && (c.args[0] as { action: string }).action === "diagnostic.purchase_detail_sync_failed")).toBe(true);
  });

  it("records receipt lines WITHOUT a CardID (not persisted) as a throttled diagnostic — instrumentation only", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ droppedReceiptLines: { count: 2, quantity: 7 } }));
    const { db, calls } = makeFakeDb({ queue: [q("p1", "unsynced")] });

    await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    const insert = calls.find((c) => c.table === "activity_log" && c.op === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ action: "diagnostic.receipt_lines_without_cardid" });
    expect(insert.detail).toMatchObject({ lines: 2, quantity: 7 });
    // persistence is unchanged: only the keyed line is sent
    const sent = rpcCalls(calls, "replace_purchase_detail_guarded")[0].args[0] as { p_receipt_lines: unknown[] };
    expect(sent.p_receipt_lines).toHaveLength(1);
  });

  it("nil-CardID lines of different POs are passed through unchanged (the 0124 key keeps them apart)", async () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full({ receiptLines: [{ cardId: nil, productSku: "LBLINSTALLATIONNONIP", productName: "x", quantity: 380, receivedDate: null, location: "Main", locationId: "l" }] }));
    const { db, calls } = makeFakeDb({ queue: [q("po-a", "unsynced"), q("po-b", "unsynced")] });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary.detailSynced).toBe(2);
    const sent = rpcCalls(calls, "replace_purchase_detail_guarded").map((c) => (c.args[0] as { p_cin7_purchase_id: string; p_receipt_lines: { card_id: string; quantity: number }[] }));
    expect(sent.map((x) => x.p_cin7_purchase_id)).toEqual(["po-a", "po-b"]);
    expect(sent.every((x) => x.p_receipt_lines[0].card_id === nil && x.p_receipt_lines[0].quantity === 380)).toBe(true);
  });

  it("repeating the same refresh sends the identical payload both times (idempotent)", async () => {
    vi.mocked(fetchPurchaseDetail).mockResolvedValue(full());
    const run = async () => {
      const { db, calls } = makeFakeDb({ queue: [q("p1", "relisted")], cachedOrderLines: [{ quantity: 10 }], cachedReceiptLines: [{ quantity: 4 }] });
      await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });
      const { p_fetched_at: _ignored, ...rest } = rpcCalls(calls, "replace_purchase_detail_guarded")[0].args[0] as Record<string, unknown>;
      return rest;
    };
    expect(await run()).toEqual(await run());
  });
});

describe("purchase list phase — header status and pagination overlap", () => {
  const cfg = { maxPerRun: 3, openTtlHours: 24, listOverlapMinutes: 10, safetyMs: 45_000 };

  it("detects a header Status change with an UNCHANGED receiving status, and keeps the cached detail (the relist queues the refresh)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-1", Status: "COMPLETED", CombinedReceivingStatus: "FULLY RECEIVED" }]);
    const { db, calls } = makeFakeDb({
      existingPurchases: [{ cin7_purchase_id: "po-1", combined_receiving_status: "FULLY RECEIVED", status: "INVOICED", detail_synced_at: "2026-08-01T00:00:00Z" } as never],
    });

    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    expect(summary.listStatusChanged).toBe(1);
    const rows = calls.find((c) => c.table === "purchases" && c.op === "upsert")!.args[0] as { detail_synced_at: string | null; updated_at: string }[];
    expect(rows[0].detail_synced_at).toBe("2026-08-01T00:00:00Z"); // NOT cleared: last-known quantities stay visible
    expect(Date.parse(rows[0].updated_at)).toBeGreaterThan(Date.parse("2026-08-01T00:00:00Z")); // …but the bump makes it relisted-after-fetch
  });

  it("still clears detail_synced_at when the RECEIVING status changes (existing behaviour)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-1", Status: "RECEIVING", CombinedReceivingStatus: "FULLY RECEIVED" }]);
    const { db, calls } = makeFakeDb({ existingPurchases: [{ cin7_purchase_id: "po-1", combined_receiving_status: "PARTIALLY RECEIVED", status: "RECEIVING", detail_synced_at: "2026-08-01T00:00:00Z" } as never] });

    await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });

    const rows = calls.find((c) => c.table === "purchases" && c.op === "upsert")!.args[0] as { detail_synced_at: string | null }[];
    expect(rows[0].detail_synced_at).toBeNull();
  });

  it("holds the list watermark back by the overlap, and only on subsequent runs", async () => {
    const { db } = makeFakeDb({ syncState: { last_list_synced_at: "2026-05-01T00:30:00.000Z" } });
    await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });
    expect(fetchAllPurchasesList).toHaveBeenLastCalledWith(expect.anything(), "2026-05-01T00:20:00.000Z");

    vi.mocked(fetchAllPurchasesList).mockClear();
    const first = makeFakeDb({ syncState: null });
    await syncInstancePurchases(first.db, "org1", "inst-1", { config: cfg });
    const since = vi.mocked(fetchAllPurchasesList).mock.calls[0][1] as string;
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(300 * 24 * 3600 * 1000); // first run keeps the 12-month backfill
  });

  it("still excludes VOIDED purchases from the list upsert exactly as before (downstream consumers unchanged)", async () => {
    vi.mocked(fetchAllPurchasesList).mockResolvedValue([{ ID: "po-v", Status: "VOIDED", CombinedReceivingStatus: "NOT RECEIVED" }]);
    const { db, calls } = makeFakeDb({});
    const summary = await syncInstancePurchases(db, "org1", "inst-1", { config: cfg });
    expect(summary.listSynced).toBe(0);
    expect(calls.some((c) => c.table === "purchases" && c.op === "upsert")).toBe(false);
  });
});
