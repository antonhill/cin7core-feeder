import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startPushJobAction, continuePushJobAction } from "@/app/import/actions";
import { syncOrgInstances } from "@/sync/sync-org";
import { getLastImportKeys } from "@/import/last-batch";
import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { claimJobLock, releaseJobLock } from "@/lib/job-lock";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/sync/sync-org", () => ({ syncOrgInstances: vi.fn() }));
vi.mock("@/import/last-batch", () => ({ getLastImportKeys: vi.fn() }));
// Defaults to "always claimed" so every pre-existing test's behavior is unaffected —
// Phase 4.4's own claim/release wiring is exercised separately below.
vi.mock("@/lib/job-lock", () => ({ claimJobLock: vi.fn(), releaseJobLock: vi.fn() }));

/** Minimal in-memory stand-in for the exact push_jobs chains actions.ts issues — insert+select+single, select+eq+eq+single, update+eq. */
function createFakePushJobsDb() {
  let row: Record<string, unknown> | null = null;

  const db = {
    from: (table: string) => {
      if (table !== "push_jobs") throw new Error(`unexpected table ${table}`);
      return {
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              row = { id: "job-1", status: "running", outcomes: [], ...payload };
              return { data: { id: "job-1" }, error: null };
            },
          }),
        }),
        select: () => ({
          eq: (col1: string, val1: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              single: async () => {
                if (!row || row[col1] !== val1 || row[col2] !== val2) return { data: null, error: { message: "not found" } };
                return { data: row, error: null };
              },
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (col: string, val: unknown) => {
            if (row && row[col] === val) row = { ...row, ...payload };
            return { data: null, error: null };
          },
        }),
      };
    },
  };
  return { db: db as unknown as SupabaseClient, getRow: () => row };
}

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "user1", email: "a@b.com" });
  vi.mocked(syncOrgInstances).mockReset();
  vi.mocked(getLastImportKeys).mockReset();
  vi.mocked(claimJobLock).mockReset().mockResolvedValue({ claimed: true, lockedAt: "2026-08-15T00:00:00Z" });
  vi.mocked(releaseJobLock).mockReset().mockResolvedValue(undefined);
});

function outcome(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    instanceId: "inst-1",
    orgId: "org1",
    instanceName: "Spark Demo",
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
    ...overrides,
  };
}

describe("startPushJobAction", () => {
  it("freezes the resolved scope once at kickoff — getLastImportKeys isn't re-called on later chunks", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(getLastImportKeys).mockResolvedValue(["SKU1", "SKU2"]);
    vi.mocked(syncOrgInstances).mockResolvedValue([outcome({ productsCreated: 2, truncated: false })]);

    const result = await startPushJobAction(["inst-1"], { products: "last_import", customers: "none", suppliers: "all" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(getLastImportKeys).toHaveBeenCalledTimes(1);
    expect(syncOrgInstances).toHaveBeenCalledWith(
      db,
      "org1",
      ["inst-1"],
      { productSkus: ["SKU1", "SKU2"], customerNames: [] },
      { userId: "user1", email: "a@b.com" },
      expect.any(Number)
    );

    // A later chunk (if the job weren't already done) must reuse the same frozen
    // scope rather than re-resolving "last_import" against whatever's newest by then.
    await continuePushJobAction(result.jobId!);
    expect(getLastImportKeys).toHaveBeenCalledTimes(1);
  });
});

describe("continuePushJobAction", () => {
  it("sums each instance's counters across chunks instead of overwriting", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances)
      .mockResolvedValueOnce([outcome({ productsCreated: 3, productsSkipped: 1, truncated: true })])
      .mockResolvedValueOnce([outcome({ productsCreated: 2, productsSkipped: 4, truncated: false })]);

    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("running");
    expect(start.outcomes?.[0].productsCreated).toBe(3);

    const next = await continuePushJobAction(start.jobId!);
    expect(next.status).toBe("done");
    expect(next.outcomes).toEqual([expect.objectContaining({ productsCreated: 5, productsSkipped: 5, truncated: false })]);
  });

  it("only re-includes instances still truncated in the next chunk's syncOrgInstances call", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([
      outcome({ instanceId: "inst-1", truncated: false }),
      outcome({ instanceId: "inst-2", truncated: true }),
    ]);

    const start = await startPushJobAction(["inst-1", "inst-2"]);
    expect(start.status).toBe("running");

    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ instanceId: "inst-2", truncated: false })]);
    const next = await continuePushJobAction(start.jobId!);

    expect(syncOrgInstances).toHaveBeenLastCalledWith(db, "org1", ["inst-2"], expect.anything(), expect.anything(), expect.any(Number));
    expect(next.status).toBe("done");
    expect(next.outcomes).toHaveLength(2);
  });

  it("stays 'running' until every instance comes back non-truncated", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([
      outcome({ instanceId: "inst-1", truncated: false }),
      outcome({ instanceId: "inst-2", truncated: true }),
    ]);

    const start = await startPushJobAction(["inst-1", "inst-2"]);
    expect(start.status).toBe("running");

    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ instanceId: "inst-2", truncated: true })]);
    const stillRunning = await continuePushJobAction(start.jobId!);
    expect(stillRunning.status).toBe("running");

    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ instanceId: "inst-2", truncated: false })]);
    const done = await continuePushJobAction(start.jobId!);
    expect(done.status).toBe("done");
  });

  it("continuing a job already marked done just returns it, without calling syncOrgInstances again", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ truncated: false })]);

    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("done");

    vi.mocked(syncOrgInstances).mockClear();
    const again = await continuePushJobAction(start.jobId!);
    expect(again.status).toBe("done");
    expect(syncOrgInstances).not.toHaveBeenCalled();
  });

  it("treats a skippedLocked outcome (Phase 4.3's sync lock held by a concurrent run) as still needing work, not done", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ skippedLocked: true, truncated: undefined })]);

    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("running");

    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ truncated: false })]);
    const next = await continuePushJobAction(start.jobId!);

    expect(syncOrgInstances).toHaveBeenLastCalledWith(db, "org1", ["inst-1"], expect.anything(), expect.anything(), expect.any(Number));
    expect(next.status).toBe("done");
  });
});

describe("Phase 4.4 job-chunk claim", () => {
  it("does not call syncOrgInstances and reports the unchanged prior state when the job lock isn't claimed", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ productsCreated: 3, truncated: true })]);

    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("running");

    vi.mocked(claimJobLock).mockResolvedValueOnce({ claimed: false });
    vi.mocked(syncOrgInstances).mockClear();
    const next = await continuePushJobAction(start.jobId!);

    expect(syncOrgInstances).not.toHaveBeenCalled();
    expect(next).toEqual(expect.objectContaining({ ok: true, status: "running", outcomes: start.outcomes }));
  });

  it("releases the lock (with the exact lockedAt it claimed) after a chunk runs", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(claimJobLock).mockResolvedValue({ claimed: true, lockedAt: "2026-08-15T01:02:03Z" });
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ truncated: false })]);

    const start = await startPushJobAction(["inst-1"]);

    expect(releaseJobLock).toHaveBeenCalledWith(db, "push_jobs", start.jobId, "2026-08-15T01:02:03Z");
  });

  it("still releases the lock when syncOrgInstances throws", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockRejectedValueOnce(new Error("boom"));

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(false);
    expect(releaseJobLock).toHaveBeenCalled();
  });
});
