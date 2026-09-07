-- Removes the paging amplification on the two Order Fulfilment report
-- functions, without changing what any of their five consumers receive.
--
-- THE DEFECT. PostgREST does not stream one execution across `.range()`
-- pages: each range request is an independent statement, so a set-returning
-- function is re-executed in full for every page and all but that page's
-- slice is discarded. Measured live on the largest client's default
-- twelve-month view (2026-09-07):
--
--     report_order_fulfillment        8,527 rows ->  9 pages
--     report_order_fulfillment_lines 23,482 rows -> 24 pages
--     = 33 complete executions, ~30s of database work per report open,
--       to deliver roughly 2.5s of unique computation.
--
-- These wrappers aggregate each report into a SINGLE PostgREST row, so the
-- expensive function runs once. Verified from the query plan: the inner
-- Function Scan reports `loops=1`.
--
-- WHY json_agg AND NOT jsonb_agg. This is the load-bearing detail, and the
-- obvious choice is the wrong one. jsonb_agg normalises every value into
-- binary jsonb, which for these wide rows costs several times more:
--
--     orders   jsonb_agg ~7,438ms   vs   json_agg ~1,386ms
--     lines    jsonb_agg ~3,024ms   vs   json_agg ~1,023ms
--
-- PostgREST connects as a role carrying an 8s statement_timeout, so the
-- jsonb_agg form would sit on top of that ceiling for orders and fail on a
-- cold cache. json_agg leaves roughly 5x headroom. Do not "tidy" this to
-- jsonb_agg — a test asserts it.
--
-- WHY THE LIMIT. src/reports/query.ts's page loop enforced a 75,000-row
-- ceiling and raised a user-facing error past it. Removing the loop must not
-- remove that protection, so it moves here. `limit 75001` bounds how much
-- JSON can ever be built — one row past the ceiling is enough to detect the
-- breach — so the wrapper cannot be made to materialise an unbounded value.
-- Measured free: the LIMIT subquery costs nothing (~1,247ms vs ~1,386ms
-- without it, inside run-to-run variance).
--
-- The count travels back as `row_count` rather than an exception: raising
-- inside SQL would lose the application's existing message, and the caller
-- already owns that wording. Over the ceiling the wrapper returns the count
-- with an empty array, and the application raises exactly the error it
-- always did.
--
-- These wrappers hold NO business logic. The underlying report functions
-- remain the single source of truth and are not modified, so every existing
-- caller — including the direct filtered `.rpc()` in
-- markBoxLabelPrintedAction — is unaffected.
--
-- POSTURE: matches the functions being wrapped exactly — `language sql`,
-- `stable`, `security invoker` (the default; RLS therefore still applies to
-- the caller), `search_path = public`. No grants are issued here, so these
-- inherit the same default privileges as their siblings and no existing
-- function's privileges are touched.

create or replace function report_order_fulfillment_json(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null
)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    -- The true row count, capped at 75,001 by the LIMIT below: the caller
    -- only needs to know whether the ceiling was breached, not by how much.
    'row_count', count(*),
    -- coalesce because json_agg returns NULL over an empty set, and every
    -- caller expects an array.
    'rows', coalesce(json_agg(t), '[]'::json)
  )
  from (
    select * from report_order_fulfillment(p_org_id, p_instance_ids, p_from_date)
    limit 75001
  ) t;
$$;

create or replace function report_order_fulfillment_lines_json(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null
)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'row_count', count(*),
    'rows', coalesce(json_agg(t), '[]'::json)
  )
  from (
    select * from report_order_fulfillment_lines(p_org_id, p_instance_ids, p_from_date)
    limit 75001
  ) t;
$$;

comment on function report_order_fulfillment_json(uuid, uuid[], date) is
  'Single-call JSON wrapper over report_order_fulfillment. Exists so PostgREST executes the report once instead of once per .range() page. Returns {row_count, rows}; rows is [] when row_count exceeds the 75,000 ceiling, which the application turns into its own error.';
comment on function report_order_fulfillment_lines_json(uuid, uuid[], date) is
  'Single-call JSON wrapper over report_order_fulfillment_lines. See report_order_fulfillment_json.';
