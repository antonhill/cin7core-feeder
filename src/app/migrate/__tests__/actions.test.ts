import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startPullJobAction, continuePullJobAction } from "@/app/migrate/actions";
import { pullInstanceGroup } from "@/migrate/pull-instance";
import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { claimJobLock, releaseJobLock } from "@/lib/job-lock";
import type { ImportKind, RunImportResult } from "@/import/run-import";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/migrate/pull-instance", () => ({
  pullInstanceGroup: vi.fn(),
  PULL_GROUP_ORDER: ["products", "customers", "suppliers"],
}));
// Defaults to "always claimed" so every pre-existing test's behavior is unaffected —
// Phase 4.4's own claim/release wiring is exercised separately below.
vi.mock("@/lib/job-lock", () => ({ claimJobLock: vi.fn(), releaseJobLock: vi.fn() }));

/** Minimal in-memory stand-in for the exact pull_jobs chains actions.ts issues — insert+select+single, select+eq+eq+single, update+eq. */
function createFakePullJobsDb() {
  let row: Record<string, unknown> | null = null;

  const db = {
    from: (table: string) => {
      if (table !== "pull_jobs") throw new Error(`unexpected table ${table}`);
      return {
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              row = { id: "job-1", status: "running", completed_groups: [], results: {}, error: null, ...payload };
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

function fakeResult(kind: ImportKind): RunImportResult {
  return { batchId: "b1", kind, rowCount: 1, errorCount: 0, committed: true, invalidRows: [], warnings: [] };
}

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org1", userId: "user1", email: "a@b.com" });
  vi.mocked(pullInstanceGroup).mockReset();
  vi.mocked(claimJobLock).mockReset().mockResolvedValue({ claimed: true, lockedAt: "2026-08-15T00:00:00Z" });
  vi.mocked(releaseJobLock).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startPullJobAction", () => {
  it("requires a source instance", async () => {
    const result = await startPullJobAction("");
    expect(result.ok).toBe(false);
  });

  it("runs groups until the budget runs out, then continuePullJobAction resumes the rest", async () => {
    const { db } = createFakePullJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.useFakeTimers();

    vi.mocked(pullInstanceGroup).mockImplementation(async (_db, _orgId, _sourceId, group) => {
      if (group === "products") {
        // Blow past PULL_BUDGET_MS (260_000ms) while "processing" the first
        // group — the chunk loop should stop before starting a second group.
        vi.advanceTimersByTime(300_000);
        return { products: fakeResult("products"), assembly_bom: fakeResult("assembly_bom") };
      }
      if (group === "customers") {
        return { customers: fakeResult("customers"), customer_addresses: fakeResult("customer_addresses") };
      }
      return { suppliers: fakeResult("suppliers"), supplier_addresses: fakeResult("supplier_addresses") };
    });

    const start = await startPullJobAction("inst-1");
    expect(start.status).toBe("running");
    expect(Object.keys(start.results ?? {})).toEqual(["products", "assembly_bom"]);
    expect(pullInstanceGroup).toHaveBeenCalledTimes(1);

    const next = await continuePullJobAction(start.jobId!);
    expect(next.status).toBe("done");
    expect(Object.keys(next.results ?? {})).toEqual([
      "products",
      "assembly_bom",
      "customers",
      "customer_addresses",
      "suppliers",
      "supplier_addresses",
    ]);
    expect(pullInstanceGroup).toHaveBeenCalledTimes(3);
  });
});

describe("continuePullJobAction", () => {
  it("marks status 'failed' and persists the error when a group throws, without losing already-completed groups' results", async () => {
    const { db } = createFakePullJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(pullInstanceGroup).mockImplementation(async (_db, _orgId, _sourceId, group) => {
      if (group === "products") return { products: fakeResult("products"), assembly_bom: fakeResult("assembly_bom") };
      throw new Error("Rate limited");
    });

    const start = await startPullJobAction("inst-1");
    expect(start.ok).toBe(false);
    expect(start.status).toBe("failed");
    expect(start.error).toBe("Rate limited");
    expect(Object.keys(start.results ?? {})).toEqual(["products", "assembly_bom"]);

    vi.mocked(pullInstanceGroup).mockClear();
    const again = await continuePullJobAction(start.jobId!);
    expect(again.status).toBe("failed");
    expect(again.ok).toBe(false);
    expect(pullInstanceGroup).not.toHaveBeenCalled();
  });

  it("continuing a job already marked done just returns it, without calling pullInstanceGroup again", async () => {
    const { db } = createFakePullJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(pullInstanceGroup).mockImplementation(async (_db, _orgId, _sourceId, group) => {
      if (group === "products") return { products: fakeResult("products"), assembly_bom: fakeResult("assembly_bom") };
      if (group === "customers") return { customers: fakeResult("customers"), customer_addresses: fakeResult("customer_addresses") };
      return { suppliers: fakeResult("suppliers"), supplier_addresses: fakeResult("supplier_addresses") };
    });

    const start = await startPullJobAction("inst-1");
    expect(start.status).toBe("done");

    vi.mocked(pullInstanceGroup).mockClear();
    const again = await continuePullJobAction(start.jobId!);
    expect(again.status).toBe("done");
    expect(pullInstanceGroup).not.toHaveBeenCalled();
  });
});

describe("Phase 4.4 job-chunk claim", () => {
  it("does not call pullInstanceGroup and reports the unchanged prior state when the job lock isn't claimed", async () => {
    const { db } = createFakePullJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(claimJobLock).mockResolvedValue({ claimed: false });

    const start = await startPullJobAction("inst-1");

    expect(pullInstanceGroup).not.toHaveBeenCalled();
    expect(start).toEqual(expect.objectContaining({ ok: true, status: "running", results: {} }));
  });

  it("releases the lock (with the exact lockedAt it claimed) after a chunk runs", async () => {
    const { db } = createFakePullJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(claimJobLock).mockResolvedValue({ claimed: true, lockedAt: "2026-08-15T01:02:03Z" });
    vi.mocked(pullInstanceGroup).mockResolvedValue({});

    const start = await startPullJobAction("inst-1");

    expect(releaseJobLock).toHaveBeenCalledWith(db, "pull_jobs", start.jobId, "2026-08-15T01:02:03Z");
  });

  it("still releases the lock when a group throws", async () => {
    const { db } = createFakePullJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(pullInstanceGroup).mockRejectedValueOnce(new Error("boom"));

    const result = await startPullJobAction("inst-1");

    expect(result.status).toBe("failed");
    expect(releaseJobLock).toHaveBeenCalled();
  });
});
