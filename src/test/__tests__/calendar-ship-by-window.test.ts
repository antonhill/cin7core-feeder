import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the properties of migration 0090 that are invisible in review and
 * expensive in production.
 *
 * 0090 bounds the three calendars to the week they are drawing. Three of its
 * details look like arbitrary style choices to anyone tidying the SQL later,
 * and undoing any one of them silently restores the timeout:
 *
 *  - **Plain `s.ship_by`, never `coalesce(ship_by, order_date)`.** The
 *    neighbouring p_from_date predicate uses coalesce, so "making it
 *    consistent" is the obvious edit. It would make sales_ship_by_idx
 *    unusable — that index is the whole reason the window is cheap.
 *  - **The window reaches the `totals` CTE.** 0083 deliberately passes null
 *    for p_from_date there, so the window looks like it should be null too.
 *    Without it the outer function still aggregates every line the org has
 *    ever had: 861ms of a ~1,032ms call, spent before the window can discard
 *    anything.
 *  - **report_calendar_banner_counts is NOT windowed.** It exists precisely
 *    because those counts are global; windowing it would report 106 orders
 *    with no Ship By date instead of 4,264.
 */
const DIR = join(__dirname, "..", "..", "..", "supabase", "migrations");
const sql0090 = readFileSync(join(DIR, "0090_calendar_ship_by_window.sql"), "utf8");
const sql0087 = readFileSync(join(DIR, "0087_fix_order_fulfillment_timeout.sql"), "utf8");

function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const body0090 = withoutComments(sql0090);

/** The `returns table (...)` column list of a function, as declared names. */
function returnedColumns(sql: string, fnName: string): string[] {
  const src = withoutComments(sql);
  const at = src.indexOf(`function ${fnName}(`);
  expect(at, `${fnName} not found`).toBeGreaterThan(-1);
  const open = src.indexOf("returns table (", at) + "returns table (".length;
  const close = src.indexOf(") language sql", open);
  expect(close, `${fnName} returns-table close not found`).toBeGreaterThan(open);
  return src
    .slice(open, close)
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);
}

describe("calendar ship_by window (migration 0090)", () => {
  it("filters on ship_by directly so sales_ship_by_idx can serve the window", () => {
    expect(body0090).toMatch(/p_ship_by_from is null or s\.ship_by >= p_ship_by_from/);
    expect(body0090).toMatch(/p_ship_by_to is null or s\.ship_by <= p_ship_by_to/);
    // The window must never be wrapped in coalesce() — that defeats the index.
    expect(body0090).not.toMatch(/coalesce\([^)]*\)\s*>=\s*p_ship_by_from/);
    expect(body0090).not.toMatch(/coalesce\([^)]*\)\s*<=\s*p_ship_by_to/);
  });

  it("pushes the window into the totals CTE, not just the outer filter", () => {
    expect(body0090).toMatch(
      /from report_order_fulfillment_lines\(p_org_id, p_instance_ids, null, p_ship_by_from, p_ship_by_to\)/
    );
    // The pre-0090 unwindowed call must be gone.
    expect(body0090).not.toMatch(/from report_order_fulfillment_lines\(p_org_id, p_instance_ids, null\)\s*\n/);
  });

  it("keeps a null window free by proving it away rather than joining", () => {
    // Same shape 0083 chose: when both bounds are null Postgres drops the
    // EXISTS entirely, so every existing caller keeps its current plan.
    expect(body0090).toMatch(/\(p_ship_by_from is null and p_ship_by_to is null\)\s*\n\s*or exists \(/);
  });

  it("forwards the window through both JSON wrappers", () => {
    const forwarded = body0090.match(
      /select \* from report_order_fulfillment(?:_lines)?\(p_org_id, p_instance_ids, p_from_date, p_ship_by_from, p_ship_by_to\)/g
    );
    expect(forwarded).toHaveLength(2);
  });

  it("keeps 0089's json_agg and row ceiling through the wrapper rebuild", () => {
    // 0090 re-creates both wrappers, which is exactly how a previous
    // migration silently reverted an earlier performance fix.
    expect(body0090).toMatch(/json_agg\(/);
    expect(body0090).not.toMatch(/jsonb_agg\(t\)/);
    expect((body0090.match(/limit\s+75001/gi) ?? []).length).toBe(2);
  });

  it("leaves the banner counts UNwindowed — they are global facts", () => {
    const at = body0090.indexOf("function report_calendar_banner_counts(");
    expect(at).toBeGreaterThan(-1);
    // Bound to the function body — the trailing `comment on function`
    // statements legitimately mention the window parameters.
    const fn = body0090.slice(at, body0090.indexOf("$$;", at));
    expect(fn).toMatch(/from report_order_fulfillment\(p_org_id, p_instance_ids, null\) r/);
    expect(fn).not.toMatch(/p_ship_by_from|p_ship_by_to/);
  });

  it("returns no rows for an unrecognised calendar rather than a plausible zero", () => {
    expect(body0090).toMatch(/having p_calendar in \('shipping', 'picking', 'invoicing'\)/);
  });

  it("adds no index — the window is served by one that already exists", () => {
    expect(body0090).not.toMatch(/create\s+(unique\s+)?index/i);
  });

  it("preserves every column of both report functions", () => {
    // 0081 rebuilt one of these from an outdated copy and dropped three
    // migrations' worth of columns; 0082 did the same to a performance fix.
    // 0090 recreates both functions, so the column lists must still match.
    for (const fn of ["report_order_fulfillment", "report_order_fulfillment_lines"]) {
      expect(returnedColumns(sql0090, fn)).toEqual(returnedColumns(sql0087, fn));
    }
  });

  it("adds the window parameters to all four functions that take them", () => {
    // Both report functions and both JSON wrappers — a wrapper left on the
    // old signature would compile and then silently ignore the window.
    const signature = /p_from_date date default null,\n\s*p_ship_by_from date default null,\n\s*p_ship_by_to date default null\n\)/g;
    expect((body0090.match(signature) ?? []).length).toBe(4);
  });
});
