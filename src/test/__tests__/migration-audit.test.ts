import { describe, expect, it } from "vitest";
import { auditMigrations } from "../../../scripts/migration-audit.mjs";

/**
 * Security re-audit P0-6/P0-5: a blank Supabase project must be able to run
 * every migration in supabase/migrations/ in filename order with no
 * dependency on a manual production-only change (the exact gap that let
 * push_jobs exist for weeks with no creation migration, silently relying on
 * 0058_job_locks.sql's `alter table push_jobs ...` succeeding only because
 * production already had the table). Also asserts every table created in
 * migration history has an RLS-enable statement somewhere in that history —
 * a coarse but real regression guard against another category_instances-style
 * gap (RLS enabled live, never captured in a migration file).
 */
describe("migration history audit", () => {
  it("has no migration that references a table before any earlier-or-same migration creates it", () => {
    const { orderingViolations } = auditMigrations();
    expect(orderingViolations).toEqual([]);
  });

  it("has an RLS-enable statement in history for every table migration history creates", () => {
    const { missingRlsTables } = auditMigrations();
    expect(missingRlsTables).toEqual([]);
  });
});
