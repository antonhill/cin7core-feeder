import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runCronRotation, TIME_BUDGET_MS } from "@/sync/cron-rotation";

/** Minimal in-memory stand-in covering both tables cron-rotation.ts queries. */
function createFakeDb(
  instances: { org_id: string; active: boolean }[],
  attempts: { sync_route: string; org_id: string; last_attempted_at: string | null }[]
) {
  const upserts: { sync_route: string; org_id: string; last_attempted_at: string }[] = [];

  function instancesBuilder() {
    const api = {
      select: () => api,
      eq: () => api, // .eq("active", true) — fake ignores the filter value, test data is pre-filtered
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: instances, error: null }),
    };
    return api;
  }

  function attemptsBuilder() {
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
      upsert: (row: { sync_route: string; org_id: string; last_attempted_at: string }) => {
        upserts.push(row);
        return { then: (resolve: (v: { error: null }) => void) => resolve({ error: null }) };
      },
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
        const matching = attempts.filter(
          (a) =>
            filters.every(([col, val]) => (a as unknown as Record<string, unknown>)[col] === val) &&
            (!inFilter || inFilter.values.includes((a as unknown as Record<string, unknown>)[inFilter.col]))
        );
        resolve({ data: matching, error: null });
      },
    };
    return api;
  }

  const db = {
    from: (table: string) => (table === "cin7_instances" ? instancesBuilder() : attemptsBuilder()),
  } as unknown as SupabaseClient;

  return { db, upserts };
}

describe("runCronRotation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attempts every org when none have a sync_route_attempts row yet", async () => {
    const { db } = createFakeDb(
      [
        { org_id: "org1", active: true },
        { org_id: "org2", active: true },
      ],
      []
    );
    const attemptedOrgIds: string[] = [];
    const syncOrg = vi.fn(async (orgId: string) => {
      attemptedOrgIds.push(orgId);
      return [`result-${orgId}`];
    });

    const results = await runCronRotation(db, "sync", syncOrg);

    expect(attemptedOrgIds).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining(["result-org1", "result-org2"]));
  });

  it("attempts a never-attempted org before any org that already has a row", async () => {
    const { db } = createFakeDb(
      [
        { org_id: "org-old", active: true },
        { org_id: "org-new", active: true },
      ],
      [{ sync_route: "sync", org_id: "org-old", last_attempted_at: "2026-07-01T00:00:00.000Z" }]
    );
    const order: string[] = [];
    const syncOrg = vi.fn(async (orgId: string) => {
      order.push(orgId);
      return [];
    });

    await runCronRotation(db, "sync", syncOrg);

    expect(order).toEqual(["org-new", "org-old"]);
  });

  it("attempts the stalest (oldest last_attempted_at) org before a more recently attempted one", async () => {
    const { db } = createFakeDb(
      [
        { org_id: "org-recent", active: true },
        { org_id: "org-stale", active: true },
      ],
      [
        { sync_route: "sync", org_id: "org-recent", last_attempted_at: "2026-07-13T00:00:00.000Z" },
        { sync_route: "sync", org_id: "org-stale", last_attempted_at: "2026-07-01T00:00:00.000Z" },
      ]
    );
    const order: string[] = [];
    const syncOrg = vi.fn(async (orgId: string) => {
      order.push(orgId);
      return [];
    });

    await runCronRotation(db, "sync", syncOrg);

    expect(order).toEqual(["org-stale", "org-recent"]);
  });

  it("marks an org attempted even when its syncOrg callback throws, and continues to the next org", async () => {
    const { db, upserts } = createFakeDb(
      [
        { org_id: "org-bad", active: true },
        { org_id: "org-good", active: true },
      ],
      []
    );
    const syncOrg = vi.fn(async (orgId: string) => {
      if (orgId === "org-bad") throw new Error("boom");
      return [`result-${orgId}`];
    });

    const results = await runCronRotation(db, "sync", syncOrg);

    expect(syncOrg).toHaveBeenCalledTimes(2);
    expect(results).toEqual(["result-org-good"]);
    expect(upserts.map((u) => u.org_id).sort()).toEqual(["org-bad", "org-good"]);
  });

  it("marks an org attempted when its syncOrg callback succeeds", async () => {
    const { db, upserts } = createFakeDb([{ org_id: "org1", active: true }], []);
    const syncOrg = vi.fn(async () => []);

    await runCronRotation(db, "sync", syncOrg);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ sync_route: "sync", org_id: "org1" });
    expect(upserts[0].last_attempted_at).toEqual(expect.any(String));
  });

  it("stops starting new orgs once within the time budget of the 300s ceiling, leaving the rest for the next tick", async () => {
    vi.useFakeTimers();
    try {
      const { db, upserts } = createFakeDb(
        [
          { org_id: "org1", active: true },
          { org_id: "org2", active: true },
          { org_id: "org3", active: true },
        ],
        []
      );
      // First org's sync itself consumes the whole time budget — the loop's
      // elapsed-time check (before starting the *next* org) should then bail.
      const syncOrg = vi.fn(async (orgId: string) => {
        vi.advanceTimersByTime(TIME_BUDGET_MS);
        return [orgId];
      });

      const results = await runCronRotation(db, "sync", syncOrg);

      expect(syncOrg).toHaveBeenCalledTimes(1);
      expect(results).toEqual(["org1"]);
      expect(upserts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flattens per-org result arrays into one combined results array", async () => {
    const { db } = createFakeDb(
      [
        { org_id: "org1", active: true },
        { org_id: "org2", active: true },
      ],
      []
    );
    const syncOrg = vi.fn(async (orgId: string) => [`${orgId}-a`, `${orgId}-b`]);

    const results = await runCronRotation(db, "sync", syncOrg);

    expect(results).toHaveLength(4);
  });

  it("returns an empty array with nothing attempted when there are no active instances", async () => {
    const { db, upserts } = createFakeDb([], []);
    const syncOrg = vi.fn(async () => []);

    const results = await runCronRotation(db, "sync", syncOrg);

    expect(results).toEqual([]);
    expect(syncOrg).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });
});

/**
 * Fairness regression cover. Production, 2026-09-06: /api/sync omitted the
 * budget its own callee already accepted, so the push ran until the platform
 * killed it, `markAttempted` (in a `finally`) never ran, and one organization
 * held the front of the rotation for 47 days while three others went unsynced.
 */
describe("runCronRotation — budget and fairness", () => {
  const attempt = (org: string, at: string | null) => ({ sync_route: "sync", org_id: org, last_attempted_at: at });

  it("hands each org the REMAINING budget, not the whole of it", async () => {
    // The dangerous shape: org A finishes late, org B then starts with a full
    // budget and runs past the platform ceiling. B must get what is left.
    const { db } = createFakeDb(
      [{ org_id: "a", active: true }, { org_id: "b", active: true }],
      [attempt("a", "2026-01-01T00:00:00Z"), attempt("b", "2026-02-01T00:00:00Z")]
    );
    const budgets: number[] = [];
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    await runCronRotation(db, "sync", async (_orgId, budgetMs) => {
      budgets.push(budgetMs);
      clock += 100_000; // each org burns 100s
      return [];
    });

    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBe(TIME_BUDGET_MS);
    expect(budgets[1]).toBe(TIME_BUDGET_MS - 100_000);
    // Sum of what any org was allowed can never exceed the window.
    expect(budgets[1]).toBeLessThan(budgets[0]);
  });

  it("stops starting orgs once the budget is exhausted", async () => {
    const { db, upserts } = createFakeDb(
      [{ org_id: "a", active: true }, { org_id: "b", active: true }],
      [attempt("a", "2026-01-01T00:00:00Z"), attempt("b", "2026-02-01T00:00:00Z")]
    );
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const seen: string[] = [];
    await runCronRotation(db, "sync", async (orgId) => {
      seen.push(orgId);
      clock += TIME_BUDGET_MS; // first org consumes everything
      return [];
    });

    expect(seen).toEqual(["a"]);
    // Crucially it still marked the org it ran — that is what lets "b" go first
    // next tick instead of "a" holding the front forever.
    expect(upserts.map((u) => u.org_id)).toEqual(["a"]);
  });

  it("advances the attempt marker for an org that yields on budget", async () => {
    const { db, upserts } = createFakeDb([{ org_id: "big", active: true }], [attempt("big", "2026-01-01T00:00:00Z")]);

    // A budgeted org returns normally rather than being killed — so the
    // `finally` runs. This is the whole fix in one assertion.
    await runCronRotation(db, "sync", async () => []);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].org_id).toBe("big");
    expect(upserts[0].last_attempted_at).toEqual(expect.any(String));
  });

  it("rotates to the starved org on the next cycle once the big org is marked", async () => {
    // Cycle 1: "big" is stalest, runs, gets marked with a fresh timestamp.
    const cycle1 = createFakeDb(
      [{ org_id: "big", active: true }, { org_id: "small", active: true }],
      [attempt("big", "2026-01-01T00:00:00Z"), attempt("small", "2026-06-01T00:00:00Z")]
    );
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const firstSeen: string[] = [];
    await runCronRotation(cycle1.db, "sync", async (orgId) => {
      firstSeen.push(orgId);
      clock += TIME_BUDGET_MS;
      return [];
    });
    expect(firstSeen).toEqual(["big"]);

    // Cycle 2: "big" now carries the newest timestamp, so "small" sorts first.
    const cycle2 = createFakeDb(
      [{ org_id: "big", active: true }, { org_id: "small", active: true }],
      [attempt("big", cycle1.upserts[0].last_attempted_at), attempt("small", "2026-06-01T00:00:00Z")]
    );
    const secondSeen: string[] = [];
    await runCronRotation(cycle2.db, "sync", async (orgId) => {
      secondSeen.push(orgId);
      clock += TIME_BUDGET_MS;
      return [];
    });

    expect(secondSeen).toEqual(["small"]);
  });

  it("still marks an org whose sync throws, so a broken org cannot hold the front either", async () => {
    const { db, upserts } = createFakeDb([{ org_id: "a", active: true }], [attempt("a", "2026-01-01T00:00:00Z")]);

    await runCronRotation(db, "sync", async () => {
      throw new Error("sync exploded");
    });

    expect(upserts.map((u) => u.org_id)).toEqual(["a"]);
  });
});
