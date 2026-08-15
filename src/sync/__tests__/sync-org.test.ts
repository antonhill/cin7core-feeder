import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncOrgInstances } from "@/sync/sync-org";
import { syncInstance } from "@/sync/run-sync";
import { logActivity } from "@/lib/activity-log";

vi.mock("@/sync/run-sync", () => ({ syncInstance: vi.fn() }));
// The fake db below only implements the select/eq/in/then chain syncOrgInstances'
// own query needs — logActivity's own insert() call is mocked separately here
// rather than teaching the fake db to support inserts too.
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));

/** Chainable no-op stand-in for the sync_locks delete() call releaseSyncLock issues. */
function createSyncLocksBuilder() {
  const api = {
    delete: () => api,
    eq: () => api,
    then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
  };
  return api;
}

/**
 * Minimal in-memory stand-in for the chained query shape syncOrgInstances
 * issues, plus a `.rpc` stub for the Phase 4.3 advisory lock (defaults to
 * always-acquired so every pre-existing test's behavior is unaffected) and a
 * `sync_locks` table stub for the matching release() call.
 */
function createFakeDb(instances: Record<string, unknown>[], rpc: ReturnType<typeof vi.fn> = defaultLockRpc()) {
  function instancesBuilder() {
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
            filters.every(([col, val]) => i[col] === val) &&
            (!inFilter || inFilter.values.includes(i[inFilter.col])),
        );
        resolve({ data: matching, error: null });
      },
    };
    return api;
  }
  return { from: (table: string) => (table === "sync_locks" ? createSyncLocksBuilder() : instancesBuilder()), rpc } as unknown as SupabaseClient;
}

function defaultLockRpc() {
  return vi.fn().mockResolvedValue({ data: [{ acquired: true, locked_at: "2026-01-01T00:00:00Z" }], error: null });
}

beforeEach(() => {
  vi.mocked(syncInstance).mockReset();
  vi.mocked(logActivity).mockReset();
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
      customersCreated: 0,
      customersUpdated: 0,
      customersSkipped: 0,
      customersFailed: 0,
      suppliersCreated: 0,
      suppliersUpdated: 0,
      suppliersSkipped: 0,
      suppliersFailed: 0,
      errors: [],
      truncated: false,
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
      customersCreated: 0,
      customersUpdated: 0,
      customersSkipped: 0,
      customersFailed: 0,
      suppliersCreated: 0,
      suppliersUpdated: 0,
      suppliersSkipped: 0,
      suppliersFailed: 0,
      errors: [],
      truncated: false,
    });

    const results = await syncOrgInstances(db, "org1", ["inst-1"]);

    expect(results).toHaveLength(1);
    expect(syncInstance).toHaveBeenCalledWith(db, "org1", "inst-1", {}, undefined);
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
        customersCreated: 0,
        customersUpdated: 0,
        customersSkipped: 0,
        customersFailed: 0,
        suppliersCreated: 0,
        suppliersUpdated: 0,
        suppliersSkipped: 0,
        suppliersFailed: 0,
        errors: [],
        truncated: false,
      });

    const results = await syncOrgInstances(db, "org1");

    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        instanceId: "inst-1",
        error: "boom",
      }),
      expect.objectContaining({
        ok: true,
        instanceId: "inst-2",
        productsCreated: 1,
      }),
    ]);
  });

  it("logs a sync.push activity entry per successful instance, defaulting to a 'system' actor", async () => {
    const db = createFakeDb([{ id: "inst-1", org_id: "org1", active: true }]);
    vi.mocked(syncInstance).mockResolvedValue({
      instanceId: "inst-1",
      instanceName: "X",
      productsCreated: 2,
      productsUpdated: 1,
      productsSkipped: 0,
      productsFailed: 0,
      productionBomsPushed: 0,
      productionBomsFailed: 0,
      customersCreated: 0,
      customersUpdated: 0,
      customersSkipped: 0,
      customersFailed: 0,
      suppliersCreated: 0,
      suppliersUpdated: 0,
      suppliersSkipped: 0,
      suppliersFailed: 0,
      errors: [],
      truncated: false,
    });

    await syncOrgInstances(db, "org1");

    expect(logActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        orgId: "org1",
        instanceId: "inst-1",
        actor: "system",
        action: "sync.push",
        summary: "Pushed 3 products",
      })
    );
  });

  it("passes through a real user as the actor when given one, for a manually-triggered push", async () => {
    const db = createFakeDb([{ id: "inst-1", org_id: "org1", active: true }]);
    vi.mocked(syncInstance).mockResolvedValue({
      instanceId: "inst-1",
      instanceName: "X",
      productsCreated: 0,
      productsUpdated: 0,
      productsSkipped: 5,
      productsFailed: 0,
      productionBomsPushed: 0,
      productionBomsFailed: 0,
      customersCreated: 0,
      customersUpdated: 0,
      customersSkipped: 0,
      customersFailed: 0,
      suppliersCreated: 0,
      suppliersUpdated: 0,
      suppliersSkipped: 0,
      suppliersFailed: 0,
      errors: [],
      truncated: false,
    });

    await syncOrgInstances(db, "org1", undefined, {}, { userId: "u1", email: "anton@sparkconsulting.co.za" });

    expect(logActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        actor: { userId: "u1", email: "anton@sparkconsulting.co.za" },
        summary: "No changes needed",
      })
    );
  });

  it("starts every instance's sync concurrently rather than waiting for each to finish first", async () => {
    const db = createFakeDb([
      { id: "inst-1", org_id: "org1", active: true },
      { id: "inst-2", org_id: "org1", active: true },
    ]);

    // Deferred promises so we control exactly when each instance "finishes" —
    // under the old serial for-loop, inst-2's syncInstance() call wouldn't
    // even happen until inst-1's promise above resolved.
    let rejectInst1!: (e: unknown) => void;
    let resolveInst2!: (v: unknown) => void;
    const deferred1 = new Promise((_resolve, reject) => {
      rejectInst1 = reject;
    });
    const deferred2 = new Promise((resolve) => {
      resolveInst2 = resolve;
    });
    vi.mocked(syncInstance).mockImplementation((_db, _orgId, instanceId) =>
      (instanceId === "inst-1" ? deferred1 : deferred2) as ReturnType<typeof syncInstance>
    );

    const resultsPromise = syncOrgInstances(db, "org1");

    // Both instances' syncs must already be in flight before either resolves.
    await vi.waitFor(() => expect(syncInstance).toHaveBeenCalledTimes(2));

    rejectInst1(new Error("boom"));
    resolveInst2({
      instanceId: "inst-2",
      instanceName: "Good",
      productsCreated: 1,
      productsUpdated: 0,
      productsSkipped: 0,
      productsFailed: 0,
      productionBomsPushed: 0,
      productionBomsFailed: 0,
      customersCreated: 0,
      customersUpdated: 0,
      customersSkipped: 0,
      customersFailed: 0,
      suppliersCreated: 0,
      suppliersUpdated: 0,
      suppliersSkipped: 0,
      suppliersFailed: 0,
      errors: [],
      truncated: false,
    });
    const results = await resultsPromise;

    expect(results).toEqual([
      expect.objectContaining({ ok: false, instanceId: "inst-1", error: "boom" }),
      expect.objectContaining({ ok: true, instanceId: "inst-2", productsCreated: 1 }),
    ]);
  });

  it("logs a sync.push_failed entry (not sync.push) when the instance sync throws", async () => {
    const db = createFakeDb([{ id: "inst-1", org_id: "org1", active: true }]);
    vi.mocked(syncInstance).mockRejectedValueOnce(new Error("boom"));

    await syncOrgInstances(db, "org1");

    expect(logActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "sync.push_failed", summary: "Sync failed: boom" })
    );
  });

  /** A fake db whose sync_locks table records delete()/eq() calls, so a release can be asserted on. */
  function createFakeDbWithLockSpy(instances: Record<string, unknown>[], rpc: ReturnType<typeof vi.fn>) {
    const deleteSpy = vi.fn().mockReturnThis();
    const eqSpy = vi.fn().mockReturnThis();
    const syncLocksBuilder = { delete: deleteSpy, eq: eqSpy, then: (r: (v: { error: null }) => void) => r({ error: null }) };
    deleteSpy.mockReturnValue(syncLocksBuilder);
    eqSpy.mockReturnValue(syncLocksBuilder);
    const instancesDb = createFakeDb(instances, rpc);
    const db = {
      from: (table: string) => (table === "sync_locks" ? syncLocksBuilder : instancesDb.from(table)),
      rpc,
    } as unknown as SupabaseClient;
    return { db, deleteSpy, eqSpy };
  }

  describe("Phase 4.3 advisory lock", () => {
    it("skips an instance whose lock is already held, without calling syncInstance", async () => {
      const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: false, locked_at: "2026-01-01T00:00:00Z" }], error: null });
      const db = createFakeDb([{ id: "inst-1", org_id: "org1", active: true }], rpc);

      const results = await syncOrgInstances(db, "org1");

      expect(syncInstance).not.toHaveBeenCalled();
      expect(results).toEqual([expect.objectContaining({ ok: true, instanceId: "inst-1", skippedLocked: true })]);
      expect(logActivity).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ action: "sync.skipped_locked", instanceId: "inst-1" })
      );
    });

    it("releases the lock (with the exact locked_at it acquired) after a successful sync", async () => {
      const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: true, locked_at: "2026-01-01T00:00:00Z" }], error: null });
      const { db, deleteSpy, eqSpy } = createFakeDbWithLockSpy([{ id: "inst-1", org_id: "org1", active: true }], rpc);

      vi.mocked(syncInstance).mockResolvedValue({
        instanceId: "inst-1",
        instanceName: "X",
        productsCreated: 0,
        productsUpdated: 0,
        productsSkipped: 0,
        productsFailed: 0,
        productionBomsPushed: 0,
        productionBomsFailed: 0,
        customersCreated: 0,
        customersUpdated: 0,
        customersSkipped: 0,
        customersFailed: 0,
        suppliersCreated: 0,
        suppliersUpdated: 0,
        suppliersSkipped: 0,
        suppliersFailed: 0,
        errors: [],
        truncated: false,
      });

      await syncOrgInstances(db, "org1");

      expect(deleteSpy).toHaveBeenCalled();
      expect(eqSpy).toHaveBeenCalledWith("locked_at", "2026-01-01T00:00:00Z");
    });

    it("releases the lock even when the sync throws", async () => {
      const rpc = vi.fn().mockResolvedValue({ data: [{ acquired: true, locked_at: "2026-01-01T00:00:00Z" }], error: null });
      const { db, deleteSpy } = createFakeDbWithLockSpy([{ id: "inst-1", org_id: "org1", active: true }], rpc);

      vi.mocked(syncInstance).mockRejectedValueOnce(new Error("boom"));

      await syncOrgInstances(db, "org1");

      expect(deleteSpy).toHaveBeenCalled();
    });
  });
});
