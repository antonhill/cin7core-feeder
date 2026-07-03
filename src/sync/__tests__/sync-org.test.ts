import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncOrgInstances } from "@/sync/sync-org";
import { syncInstance } from "@/sync/run-sync";

vi.mock("@/sync/run-sync", () => ({ syncInstance: vi.fn() }));

/** Minimal in-memory stand-in for the chained query shape syncOrgInstances issues. */
function createFakeDb(instances: Record<string, unknown>[]) {
  function builder() {
    const filters: [string, unknown][] = [];
    let inFilter: { col: string; values: unknown[] } | undefined;
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      in: (col: string, values: unknown[]) => {
        inFilter = { col, values };
        return api;
      },
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
        const matching = instances.filter(
          (i) =>
            filters.every(([col, val]) => i[col] === val) && (!inFilter || inFilter.values.includes(i[inFilter.col]))
        );
        resolve({ data: matching, error: null });
      },
    };
    return api;
  }
  return { from: builder } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.mocked(syncInstance).mockReset();
});

describe("syncOrgInstances", () => {
  it("syncs every active instance for the org when no instanceIds filter is given", async () => {
    const db = createFakeDb([
      { id: "inst-1", org_id: "org1", active: true },
      { id: "inst-2", org_id: "org1", active: true },
    ]);
    vi.mocked(syncInstance).mockResolvedValue({
      instanceId: "x",
      instanceName: "X",
      productsCreated: 0,
      productsUpdated: 0,
      productsSkipped: 0,
      productsFailed: 0,
      productionBomsPushed: 0,
      productionBomsFailed: 0,
      errors: [],
    });

    const results = await syncOrgInstances(db, "org1");

    expect(results).toHaveLength(2);
    expect(syncInstance).toHaveBeenCalledTimes(2);
  });

  it("scopes to just the given instanceIds when provided", async () => {
    const db = createFakeDb([
      { id: "inst-1", org_id: "org1", active: true },
      { id: "inst-2", org_id: "org1", active: true },
    ]);
    vi.mocked(syncInstance).mockResolvedValue({
      instanceId: "inst-1",
      instanceName: "X",
      productsCreated: 0,
      productsUpdated: 0,
      productsSkipped: 0,
      productsFailed: 0,
      productionBomsPushed: 0,
      productionBomsFailed: 0,
      errors: [],
    });

    const results = await syncOrgInstances(db, "org1", ["inst-1"]);

    expect(results).toHaveLength(1);
    expect(syncInstance).toHaveBeenCalledWith(db, "org1", "inst-1");
  });

  it("catches a per-instance failure and continues, rather than aborting the whole run", async () => {
    const db = createFakeDb([
      { id: "inst-1", org_id: "org1", active: true },
      { id: "inst-2", org_id: "org1", active: true },
    ]);
    vi.mocked(syncInstance)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        instanceId: "inst-2",
        instanceName: "Good",
        productsCreated: 1,
        productsUpdated: 0,
        productsSkipped: 0,
        productsFailed: 0,
        productionBomsPushed: 0,
        productionBomsFailed: 0,
        errors: [],
      });

    const results = await syncOrgInstances(db, "org1");

    expect(results).toEqual([
      expect.objectContaining({ ok: false, instanceId: "inst-1", error: "boom" }),
      expect.objectContaining({ ok: true, instanceId: "inst-2", productsCreated: 1 }),
    ]);
  });
});
