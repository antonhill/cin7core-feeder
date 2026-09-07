import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the two properties of migration 0089 that are invisible in review
 * and expensive in production.
 *
 * The wrappers exist so PostgREST executes each report once rather than once
 * per `.range()` page — 33 executions and ~30s of database work at the
 * largest client's default view. Two details make that work, and both look
 * like arbitrary style choices to anyone tidying the SQL later:
 *
 *  - **json_agg, not jsonb_agg.** jsonb_agg normalises into binary and cost
 *    ~7,438ms for orders against ~1,386ms for json_agg. PostgREST's role
 *    carries an 8s statement_timeout, so the jsonb form would sit on top of
 *    that ceiling and fail on a cold cache — a slower report replaced by a
 *    broken one.
 *  - **The LIMIT.** It carries the 75,000-row ceiling that used to live in
 *    the application's page loop. Without it the wrapper would happily build
 *    an unbounded JSON value and only discover the breach afterwards.
 *
 * A text-level check is the right shape here: both are single tokens in one
 * migration file, and neither can be asserted behaviourally without a live
 * database.
 */
const MIGRATION = "supabase/migrations/0089_order_fulfillment_single_call.sql";

function migrationSql(): string {
  return readFileSync(join(__dirname, "..", "..", "..", MIGRATION), "utf8");
}

/** Statement bodies only — the file's header comment discusses jsonb_agg deliberately. */
function sqlWithoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("order-fulfilment JSON wrappers (migration 0089)", () => {
  it("aggregates with json_agg and never jsonb_agg", () => {
    const sql = sqlWithoutComments(migrationSql());

    expect(sql).toMatch(/json_agg\(/);
    expect(sql).not.toMatch(/jsonb_agg\(/);
  });

  it("bounds the result so the ceiling cannot be discovered only after building an unbounded value", () => {
    const sql = sqlWithoutComments(migrationSql());

    // 75001 — one past the application's MAX_RPC_ROWS, which is the smallest
    // bound that can still detect a breach.
    expect(sql).toMatch(/limit\s+75001/i);
    expect((sql.match(/limit\s+75001/gi) ?? []).length).toBe(2);
  });

  it("returns an array rather than NULL for an empty result", () => {
    // json_agg yields NULL over an empty set; every caller expects an array.
    const sql = sqlWithoutComments(migrationSql());
    expect((sql.match(/coalesce\(json_agg\(t\),\s*'\[\]'::json\)/gi) ?? []).length).toBe(2);
  });

  it("reports the row count alongside the rows, so the ceiling is enforced server-side", () => {
    const sql = sqlWithoutComments(migrationSql());
    expect((sql.match(/'row_count',\s*count\(\*\)/gi) ?? []).length).toBe(2);
  });

  it("keeps the posture of the functions it wraps — stable, invoker rights, pinned search_path", () => {
    const sql = sqlWithoutComments(migrationSql());

    expect((sql.match(/language sql stable set search_path = public/gi) ?? []).length).toBe(2);
    // security definer would run the report as the owner and bypass RLS.
    expect(sql).not.toMatch(/security\s+definer/i);
    // No grants here: the wrappers must inherit default privileges exactly as
    // their siblings do, and must not alter any other function's.
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b/i);
  });

  it("wraps rather than reimplements — the report logic stays in one place", () => {
    const sql = sqlWithoutComments(migrationSql());

    expect(sql).toMatch(/from report_order_fulfillment\(p_org_id, p_instance_ids, p_from_date\)/);
    expect(sql).toMatch(/from report_order_fulfillment_lines\(p_org_id, p_instance_ids, p_from_date\)/);
    // The underlying functions must not be redefined by this migration.
    expect(sql).not.toMatch(/create (or replace )?function report_order_fulfillment\s*\(/i);
    expect(sql).not.toMatch(/create (or replace )?function report_order_fulfillment_lines\s*\(/i);
  });
});
