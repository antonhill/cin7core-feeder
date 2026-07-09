import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstanceAssemblyBuilds, syncOrgAssemblyBuilds } from "@/sync/sync-assembly-builds";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllFinishedGoodsList, fetchFinishedGoodsDetail } from "@/cin7/finished-goods";

vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/finished-goods", () => ({ fetchAllFinishedGoodsList: vi.fn(), fetchFinishedGoodsDetail: vi.fn() }));

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

interface FakeDbOptions {
  existingBuilds?: { cin7_task_id: string; status: string | null; detail_synced_at: string | null }[];
  pendingBuilds?: { cin7_task_id: string }[];
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
      if (table === "assembly_builds") {
        return {
          select: (cols: string) => {
            calls.push({ table, op: "select", args: [cols] });
            const result = cols.includes("status") ? (opts.existingBuilds ?? []) : (opts.pendingBuilds ?? []);
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
      if (table === "assembly_consumption_lines") {
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
  vi.mocked(fetchAllFinishedGoodsList).mockReset().mockResolvedValue([]);
  vi.mocked(fetchFinishedGoodsDetail).mockReset();
});

describe("syncInstanceAssemblyBuilds — list phase", () => {
  it("skips builds that are not COMPLETED", async () => {
    vi.mocked(fetchAllFinishedGoodsList).mockResolvedValue([{ TaskID: "t1", Status: "IN PROGRESS" }]);
    const { db, calls } = makeFakeDb({ existingBuilds: [], pendingBuilds: [] });

    const summary = await syncInstanceAssemblyBuilds(db, "org1", "inst-1");

    expect(summary.listSynced).toBe(0);
    expect(calls.find((c) => c.table === "assembly_builds" && c.op === "upsert")).toBeUndefined();
  });

  it("queues a brand-new completed build for detail sync (detail_synced_at cleared)", async () => {
    vi.mocked(fetchAllFinishedGoodsList).mockResolvedValue([
      { TaskID: "t1", AssemblyNumber: "FG-1", ProductCode: "SKU-A", ProductName: "Widget", Status: "COMPLETED", Quantity: 5, Date: "2026-06-01T00:00:00" },
    ]);
    const { db, calls } = makeFakeDb({ existingBuilds: [], pendingBuilds: [] });

    const summary = await syncInstanceAssemblyBuilds(db, "org1", "inst-1");

    expect(summary.listSynced).toBe(1);
    const upsertCall = calls.find((c) => c.table === "assembly_builds" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBeNull();
  });

  it("does not requeue a build whose status is unchanged", async () => {
    vi.mocked(fetchAllFinishedGoodsList).mockResolvedValue([{ TaskID: "t1", Status: "COMPLETED" }]);
    const { db, calls } = makeFakeDb({
      existingBuilds: [{ cin7_task_id: "t1", status: "COMPLETED", detail_synced_at: "2026-06-02T00:00:00.000Z" }],
      pendingBuilds: [],
    });

    await syncInstanceAssemblyBuilds(db, "org1", "inst-1");

    const upsertCall = calls.find((c) => c.table === "assembly_builds" && c.op === "upsert");
    const rows = upsertCall?.args[0] as { detail_synced_at: unknown }[];
    expect(rows[0].detail_synced_at).toBe("2026-06-02T00:00:00.000Z");
  });
});

describe("syncInstanceAssemblyBuilds — detail phase", () => {
  it("stores consumption lines keyed by position and updates the authoritative completion date", async () => {
    vi.mocked(fetchFinishedGoodsDetail).mockResolvedValueOnce({
      TaskID: "t1",
      CompletionDate: "2026-06-05T00:00:00",
      PickLines: [
        { ProductCode: "COMP-A", Name: "Component A", Quantity: 2, Cost: 10, BatchSN: "B1" },
        { ProductCode: "COMP-B", Name: "Component B", Quantity: 1, Cost: 5, BatchSN: null },
      ],
    });
    const { db, calls } = makeFakeDb({ existingBuilds: [], pendingBuilds: [{ cin7_task_id: "t1" }] });

    const summary = await syncInstanceAssemblyBuilds(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(summary.detailFailed).toBe(0);
    const insertCall = calls.find((c) => c.table === "assembly_consumption_lines" && c.op === "insert");
    const lines = insertCall?.args[0] as { line_number: number; product_sku: string }[];
    expect(lines).toEqual([
      expect.objectContaining({ line_number: 0, product_sku: "COMP-A" }),
      expect.objectContaining({ line_number: 1, product_sku: "COMP-B" }),
    ]);
    const updateCall = calls.find((c) => c.table === "assembly_builds" && c.op === "update");
    expect(updateCall?.args[0]).toMatchObject({ completion_date: "2026-06-05" });
  });

  it("records a per-build failure without aborting the rest of the batch", async () => {
    vi.mocked(fetchFinishedGoodsDetail)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ TaskID: "t2", PickLines: [] });
    const { db } = makeFakeDb({ existingBuilds: [], pendingBuilds: [{ cin7_task_id: "t1" }, { cin7_task_id: "t2" }] });

    const summary = await syncInstanceAssemblyBuilds(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(summary.detailFailed).toBe(1);
    expect(summary.errors).toEqual([{ taskId: "t1", error: "boom" }]);
  });

  it("handles a build detail response with no pick lines", async () => {
    vi.mocked(fetchFinishedGoodsDetail).mockResolvedValueOnce({ TaskID: "t1", PickLines: [] });
    const { db, calls } = makeFakeDb({ existingBuilds: [], pendingBuilds: [{ cin7_task_id: "t1" }] });

    const summary = await syncInstanceAssemblyBuilds(db, "org1", "inst-1");

    expect(summary.detailSynced).toBe(1);
    expect(calls.find((c) => c.table === "assembly_consumption_lines" && c.op === "insert")).toBeUndefined();
  });
});

describe("syncOrgAssemblyBuilds", () => {
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

    const results = await syncOrgAssemblyBuilds(db);

    expect(results).toHaveLength(2);
    expect(results[0].errors[0].error).toBe("Instance not found");
    expect(results[1].instanceId).toBe("inst-2");
  });
});
