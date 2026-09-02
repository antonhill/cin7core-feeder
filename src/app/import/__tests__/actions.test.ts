import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startPushJobAction, continuePushJobAction, getActivePushJobAction, importCsvAction } from "@/app/import/actions";
import { syncOrgInstances } from "@/sync/sync-org";
import { getLastImportKeys } from "@/import/last-batch";
import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { claimJobLock, releaseJobLock } from "@/lib/job-lock";
import { requireAal2 } from "@/lib/require-privileged";
import { requireOrgAdmin } from "@/lib/require-org-admin";

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/sync/sync-org", () => ({ syncOrgInstances: vi.fn() }));
vi.mock("@/import/last-batch", () => ({ getLastImportKeys: vi.fn() }));
// Defaults to "always claimed" so every pre-existing test's behavior is unaffected —
// Phase 4.4's own claim/release wiring is exercised separately below.
vi.mock("@/lib/job-lock", () => ({ claimJobLock: vi.fn(), releaseJobLock: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));

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
  vi.mocked(requireWriteAllowed).mockReset().mockResolvedValue(undefined);
  vi.mocked(requireAal2).mockReset().mockResolvedValue(undefined);
  vi.mocked(requireOrgAdmin).mockReset();
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

  it("security re-audit P1-3-class fix: re-checks requireWriteAllowed on every chunk, not just at job creation, and never calls syncOrgInstances if it now rejects", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ truncated: true })]);

    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("running");
    expect(requireWriteAllowed).toHaveBeenCalledWith("org1");

    // Billing lapses between chunks (e.g. subscription cancelled mid-push).
    vi.mocked(requireWriteAllowed).mockRejectedValueOnce(new Error("Your subscription isn't active — subscribe to write changes back to Cin7."));
    vi.mocked(syncOrgInstances).mockClear();
    const next = await continuePushJobAction(start.jobId!);

    expect(next.ok).toBe(false);
    expect(syncOrgInstances).not.toHaveBeenCalled();
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

/**
 * CCT-ADR-0015 classifies the user-triggered catalog push as an ordinary-
 * member action that also requires a step-up (AAL2). It is ONE authorization
 * family spanning both entry points, so both the first chunk and every
 * write-capable continuation are covered.
 */
describe("CCT-ADR-0015: startPushJobAction requires AAL2", () => {
  it("1. member + module + write eligibility + AAL2 creates and runs the job", async () => {
    const { db, getRow } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValue([outcome({ truncated: false })]);

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(requireAal2).toHaveBeenCalledTimes(1);
    expect(requireAal2).toHaveBeenCalledWith("push catalog data to Cin7");
    expect(getRow()).not.toBeNull();
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it("2. missing AAL2 denies before the push_jobs insert, runNextChunk and any external write", async () => {
    const { db, getRow } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required to push catalog data to Cin7."));

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Two-factor authentication is required/);
    // No job row was ever created, so no later continuation can pick one up.
    expect(getRow()).toBeNull();
    expect(syncOrgInstances).not.toHaveBeenCalled();
    expect(claimJobLock).not.toHaveBeenCalled();
    expect(getLastImportKeys).not.toHaveBeenCalled();
  });

  it("3. an unreadable assurance state fails closed", async () => {
    const { db, getRow } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(requireAal2).mockRejectedValue(new Error("Could not verify two-factor authentication status: network"));

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not verify two-factor authentication status/);
    expect(getRow()).toBeNull();
    expect(syncOrgInstances).not.toHaveBeenCalled();
  });

  it("4. an admin role is NOT required", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValue([outcome({ truncated: false })]);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only owners and admins can do this."));

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(true);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it("5. the module gate still runs first and short-circuits before assurance", async () => {
    const { db, getRow } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(requireModuleAccess).mockRejectedValueOnce(new Error("This module is not enabled for your organization."));

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(false);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(getRow()).toBeNull();
  });

  it("6. the billing gate still runs before assurance", async () => {
    const { db, getRow } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(requireWriteAllowed).mockRejectedValueOnce(new Error("Available on a paid plan."));

    const result = await startPushJobAction(["inst-1"]);

    expect(result.ok).toBe(false);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(getRow()).toBeNull();
  });
});

describe("CCT-ADR-0015: continuePushJobAction re-checks AAL2 on every write-capable chunk", () => {
  /** Starts a job whose first chunk leaves it running, and clears the call history. */
  async function startRunningJob() {
    const fake = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(fake.db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ productsCreated: 4, truncated: true })]);
    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("running");
    vi.mocked(syncOrgInstances).mockClear();
    vi.mocked(claimJobLock).mockClear();
    vi.mocked(requireAal2).mockClear();
    return { ...fake, jobId: start.jobId! };
  }

  it("7. a running job with AAL2 executes the next chunk", async () => {
    const { jobId } = await startRunningJob();
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ truncated: false })]);

    const next = await continuePushJobAction(jobId);

    expect(next.ok).toBe(true);
    expect(next.status).toBe("done");
    expect(requireAal2).toHaveBeenCalledTimes(1);
    expect(syncOrgInstances).toHaveBeenCalledTimes(1);
  });

  it("8. a running job WITHOUT AAL2 errors, runs no chunk, claims no lock, and leaves the job untouched", async () => {
    const { jobId, getRow } = await startRunningJob();
    const before = { ...getRow() };
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required to push catalog data to Cin7."));

    const next = await continuePushJobAction(jobId);

    expect(next.ok).toBe(false);
    expect(next.error).toMatch(/Two-factor authentication is required/);
    expect(syncOrgInstances).not.toHaveBeenCalled();
    expect(claimJobLock).not.toHaveBeenCalled();
    // The job is neither failed nor done — still running, with its prior
    // outcomes intact, so it stays resumable.
    expect(getRow()).toEqual(before);
    expect(getRow()!.status).toBe("running");
    expect((getRow()!.outcomes as { productsCreated: number }[])[0].productsCreated).toBe(4);
  });

  it("9. an assurance-read failure on a running job fails closed before the next chunk", async () => {
    const { jobId, getRow } = await startRunningJob();
    vi.mocked(requireAal2).mockRejectedValue(new Error("Could not verify two-factor authentication status: network"));

    const next = await continuePushJobAction(jobId);

    expect(next.ok).toBe(false);
    expect(next.error).toMatch(/Could not verify two-factor authentication status/);
    expect(syncOrgInstances).not.toHaveBeenCalled();
    expect(claimJobLock).not.toHaveBeenCalled();
    expect(getRow()!.status).toBe("running");
  });

  it("10. a job that is no longer running returns its status without requiring AAL2", async () => {
    const fake = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(fake.db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ productsCreated: 7, truncated: false })]);
    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("done");
    vi.mocked(requireAal2).mockClear();
    // Assurance is now unavailable — reading a finished job must still work.
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required."));

    const again = await continuePushJobAction(start.jobId!);

    expect(again.ok).toBe(true);
    expect(again.status).toBe("done");
    expect(requireAal2).not.toHaveBeenCalled();
  });

  it("12. a job belonging to another org stays inaccessible, exactly as before", async () => {
    const { jobId } = await startRunningJob();
    vi.mocked(requireModuleAccess).mockResolvedValueOnce({ orgId: "org2", userId: "user2", email: "x@y.com" });

    const next = await continuePushJobAction(jobId);

    expect(next.ok).toBe(false);
    expect(next.error).toBe("Push job not found");
    expect(syncOrgInstances).not.toHaveBeenCalled();
    // Org scoping rejects before assurance is ever consulted.
    expect(requireAal2).not.toHaveBeenCalled();
  });
});

/**
 * The core security property of the resumable design: assurance is evaluated
 * per chunk against the CURRENT session, and losing it mid-push stops further
 * external writes without destroying the job.
 */
describe("CCT-ADR-0015: per-chunk assurance expiry and recovery", () => {
  it("11. stops the next chunk when AAL2 lapses mid-push, then resumes the SAME job once it is restored", async () => {
    const { db, getRow } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);

    // 1. Start under AAL2; the first chunk leaves the job running.
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ productsCreated: 4, truncated: true })]);
    const start = await startPushJobAction(["inst-1"]);
    expect(start.status).toBe("running");
    const jobId = start.jobId!;

    // 2. The session falls below AAL2 and a continuation is attempted.
    vi.mocked(syncOrgInstances).mockClear();
    vi.mocked(claimJobLock).mockClear();
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required to push catalog data to Cin7."));

    const blocked = await continuePushJobAction(jobId);

    // 3. No second chunk executed; the job is unchanged and still running.
    expect(blocked.ok).toBe(false);
    expect(syncOrgInstances).not.toHaveBeenCalled();
    expect(claimJobLock).not.toHaveBeenCalled();
    expect(getRow()!.status).toBe("running");
    expect((getRow()!.outcomes as { productsCreated: number }[])[0].productsCreated).toBe(4);

    // 4. The user steps up again; the same job — not a new one — resumes.
    vi.mocked(requireAal2).mockResolvedValue(undefined);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ productsCreated: 3, truncated: false })]);

    const resumed = await continuePushJobAction(jobId);

    expect(resumed.ok).toBe(true);
    expect(resumed.jobId).toBe(jobId);
    expect(resumed.status).toBe("done");
    expect(syncOrgInstances).toHaveBeenCalledTimes(1);
    // Progress accumulated across both chunks rather than restarting.
    expect(resumed.outcomes![0].productsCreated).toBe(7);
  });

  it("the resumable job is exactly what getActivePushJobAction rediscovers, so the page's mount effect can drive it", async () => {
    const { db } = createFakePushJobsDb();
    vi.mocked(createServiceRoleClient).mockReturnValue(db);
    vi.mocked(syncOrgInstances).mockResolvedValueOnce([outcome({ truncated: true })]);
    const start = await startPushJobAction(["inst-1"]);

    // Stand in for the "newest running job for this org" lookup.
    vi.mocked(createServiceRoleClient).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: start.jobId, status: "running", outcomes: [] } }) }) }) }),
          }),
        }),
      }),
    } as never);

    const active = await getActivePushJobAction();

    expect(active?.jobId).toBe(start.jobId);
    expect(active?.status).toBe("running");
  });
});

describe("CCT-ADR-0015: read-only and local-import boundaries gain no assurance", () => {
  it("14. getActivePushJobAction does NOT require AAL2 — it is a status read", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required."));
    vi.mocked(createServiceRoleClient).mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }),
      }),
    } as never);

    const active = await getActivePushJobAction();

    expect(active).toBeNull();
    expect(requireAal2).not.toHaveBeenCalled();
    expect(requireWriteAllowed).not.toHaveBeenCalled();
  });

  it("13. importCsvAction does NOT require AAL2 — it writes to local canonical state, not across the Cin7 boundary", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required."));
    vi.mocked(createServiceRoleClient).mockReturnValue(createFakePushJobsDb().db);

    const form = new FormData();
    form.set("kind", "products");
    form.set("file", new File(["SKU,Name\nSKU1,Widget\n"], "products.csv", { type: "text/csv" }));

    // The fake db above only knows push_jobs, so this call may well fail on
    // its own persistence — the assertion that matters is that assurance was
    // never consulted on the way there.
    await importCsvAction({ status: "idle" } as never, form);

    // Non-vacuous: the call really did get past input validation and into
    // the guarded region, and consulted module access on the way.
    expect(requireModuleAccess).toHaveBeenCalled();
    expect(requireAal2).not.toHaveBeenCalled();
  });
});
