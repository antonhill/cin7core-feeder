import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every cron route whose per-org work is bounded only by a budget must
 * actually pass one.
 *
 * This exists because the omission is invisible: `syncOrgInstances`'s
 * `budgetMs` is an optional trailing parameter, so `syncOrgInstances(db,
 * orgId)` compiles, type-checks, passes review and runs — it simply never
 * yields. `run-sync.ts` computes `deadline = budgetMs !== undefined ? … :
 * null` and `overBudget()` returns false forever against a null deadline, so
 * the push ran until the platform killed the process. Because
 * `markAttempted` sits in a `finally`, a killed process never records the
 * attempt, so the same organization sorted first on every subsequent tick.
 * In production that left `/api/sync`'s rotation frozen for 47 days while
 * three organizations went unsynced.
 *
 * Scoped to `/api/sync` deliberately. The other five sync routes bound their
 * own per-run work internally (a detail-fetch batch size) and their
 * `syncOrg*` functions do not accept a budget at all, so requiring one there
 * would assert something untrue about them.
 */
const BUDGETED_CRON_ROUTES = ["app/api/sync/route.ts"];

describe("cron routes bounded only by a budget must pass one", () => {
  it.each(BUDGETED_CRON_ROUTES)("%s passes the rotation's remaining budget through to the sync", (rel) => {
    const src = readFileSync(join(__dirname, "..", "..", rel), "utf8");

    // The callback must accept the budget runCronRotation hands it...
    expect(src).toMatch(/runCronRotation\([^)]*\(\s*orgId\s*,\s*budgetMs\s*\)/);
    // ...and actually forward it, rather than accepting and dropping it.
    expect(src).toMatch(/syncOrgInstances\([^)]*budgetMs[^)]*\)/);
  });

  it("runCronRotation hands out what is LEFT of the window, never the whole of it", () => {
    // Handing each org the full budget would let a late-starting org run past
    // the platform ceiling — the very failure this guards.
    const rotation = readFileSync(join(__dirname, "..", "..", "sync/cron-rotation.ts"), "utf8");

    expect(rotation).toMatch(/const remainingMs = TIME_BUDGET_MS - \(Date\.now\(\) - startedAt\)/);
    expect(rotation).toMatch(/syncOrg\(orgId, remainingMs\)/);
  });

  it("still marks the attempt in a finally, so an org that yields cannot hold the front", () => {
    const rotation = readFileSync(join(__dirname, "..", "..", "sync/cron-rotation.ts"), "utf8");
    expect(rotation).toMatch(/finally\s*\{\s*await markAttempted\(/);
  });
});
