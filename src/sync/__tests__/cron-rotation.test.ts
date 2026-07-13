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
