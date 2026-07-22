import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startPullJobAction, continuePullJobAction } from "@/app/migrate/actions";
import { pullInstanceGroup } from "@/migrate/pull-instance";
import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import type { ImportKind, RunImportResult } from "@/import/run-import";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/migrate/pull-instance", () => ({
  pullInstanceGroup: vi.fn(),
  PULL_GROUP_ORDER: ["products", "customers", "suppliers"],
}));

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
  vi.mocked(requireCurrentOrg).mockResolvedValue({ orgId: "org1", userId: "user1", email: "a@b.com" });
  vi.mocked(pullInstanceGroup).mockReset();
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
