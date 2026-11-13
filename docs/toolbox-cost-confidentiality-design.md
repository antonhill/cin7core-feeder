# Toolbox cost / margin confidentiality (migration 0127)

Status: implemented on `security/toolbox-cost-column-confidentiality`, stacked on PR #216 (0122). **Not applied anywhere; needs owner approval.**

## 1. Exposure evidence (read-only, shared Production)
Nine generic Toolbox tables hold cost / margin data. Each has policy `org members read <table>` = `is_org_member(org_id)` and table-level SELECT for `authenticated` (and `anon` on `quotes` / `quote_lines`, row-hidden by RLS). `authenticated` also held INSERT and TRUNCATE (the accidental Supabase default ALL; TRUNCATE ignores RLS). So any organisation member, including a NewQuip Rep, could read these through PostgREST with the public anon key and their own JWT, bypassing application redaction.

| Table | Sensitive columns |
|---|---|
| products | average_cost, supplier_fixed_price, costing_method |
| quotes | estimated_cost, margin_revenue_ex_tax, overall_margin_pct, margin_scope, costed_line_count, excluded_from_margin_count |
| quote_lines | average_cost, estimated_cost, margin_pct, margin_included, unit_price, cost_snapshot_at |
| sale_lines | average_cost, price |
| assembly_bom_lines | estimated_unit_cost, cost_percentage, wastage_* |
| assembly_consumption_lines | unit_cost |
| production_bom_items | cost_of_wastage, cost_allocation_type, resource_cost_type, wastage_* |
| production_operations | actual_resource_cost, actual_material_cost, wastage |
| production_orders | wip_actual_cost, wip_account |

No views reference them. Functions executable by PUBLIC / anon / authenticated that read cost / margin (all SECURITY INVOKER, so RLS applied): `report_sales_by_product`, `report_sales_pivot`, `report_sales_facts` (average_cost), `report_reorder` (unit cost), and `recompute_product_hash` (a void maintenance function that hashes supplier_fixed_price and BOM cost_percentage into `products.content_hash`; called by triggers and never by a client).

Usage evidence: every read/write of these tables and every `report_*` RPC goes through the service-role client (`src/supabase/server.ts`). User-JWT clients appear in 14 reviewed files (REVIEWED in the guard test) that touch only `org_members`, `organizations`, `super_admins` and `rpc create_self_serve_org`. 24h of production API logs showed zero client-token REST reads of these tables. That log window is evidence of non-use, not proof (a short window; rarely used paths could be missed) - the code audit and the guard test are the stronger basis.

## 2. Decision
Follow the 0122 pattern: **whole-table lockdown**. For each of the nine tables: `revoke all ... from public, anon, authenticated` (this also removes column grants), keep RLS enabled, drop every policy (default deny), leave `service_role` untouched. For the five functions (all overloads, resolved by name via `pg_proc`): revoke EXECUTE from public, anon, authenticated and grant it explicitly to `service_role`. Absent tables / functions are skipped; the migration is idempotent and changes no data and no other object.

## 3. Rejected alternatives
- **Column-level grants.** Postgres privileges are additive: a column REVOKE does not override a table-level SELECT, so the table-level privilege would have to be revoked first and every non-sensitive column re-granted. That breaks `select *` (PostgREST default), must be updated for every new column (a forgotten column silently becomes unreadable, or a new sensitive one is granted by habit), and buys nothing because no client path needs any column.
- **Security-barrier views** exposing only non-cost columns: extra objects to maintain and keep in sync, again for a consumer that does not exist.
- **Role-aware RLS** (e.g. hide cost from Reps): impossible in SQL. Rep / Estimator resolution lives in the application (strict-roles setting, tier defaults, functional-role tables); duplicating it in policies would drift and is the exact thing 0122 rejected.

## 4. Effect on other customers' workflows
None expected. Evidence: all application reads/writes and the `report_*` RPCs use the service-role client, which has `BYPASSRLS` and keeps its table and execute privileges; triggers (e.g. `products_touch` -> `recompute_product_hash`) run as the writing role, i.e. the service role in production; the guard test `toolbox-cost-boundary.test.ts` fails the build if a user-JWT file queries these tables or calls these functions, and if a new user-JWT file appears without review. Client sessions still read `org_members` / `organizations` and every table 0127 does not touch.

## 5. Residual risks (honest)
- Pages that deliberately show costs to authorised application roles are enforced in the application layer only; 0127 does not change that.
- Cost data also exists in Cin7 and in copies synced elsewhere; this does not protect Cin7 itself.
- `suppliers`, `purchases` and purchase totals / receipts, `customers`, `activity_log` and other tables are not covered (focused change). `report_inventory_movement_lines`, `product_availability` (stock_value) and similar are unchanged; `report_reorder` is revoked, and invoker functions over the nine tables fail for clients anyway.
- `recompute_production_bom_hash` is also executable by clients but reads/writes only through the now-locked tables (invoker), so it is inert for clients.
- A future table with cost data needs its own lockdown; the SQL test catalogue-guards the nine names only.

## 6. Rollout
1. Apply to an isolated / branch database first (never share a database with Production for the first run); run `supabase/tests/0127_*.test.sql` there.
2. Production only after explicit owner approval: re-verify the migration ledger and that `0127` is still unclaimed, then apply by name (not a bulk push).
3. Verify: (a) per table `select has_table_privilege('authenticated', 'public.<t>', 'SELECT')` is false for all nine, same for `anon`; (b) `select tablename from pg_policies where tablename in (...)` returns nothing; (c) `relrowsecurity` true; (d) `has_function_privilege('authenticated', oid, 'EXECUTE')` false and `service_role` true for the five functions; (e) application smoke: Reports (sales by product / pivot / reorder), Quotes list, Production tracking, a sync run.
4. Rollback: `supabase/rollback/0127_toolbox_cost_confidentiality_rollback.sql` restores the member read policies, SELECT for authenticated (anon on quotes / quote_lines) and function EXECUTE; it does not restore the accidental write / TRUNCATE grants.

## 7. Test matrix
- `supabase/tests/0127_toolbox_cost_confidentiality.test.sql` (run by CI's clean-bootstrap job; not runnable without Postgres locally): catalogue guard (7 privilege types x anon / authenticated, no PUBLIC, no column grants, RLS on, zero policies, service_role keeps CRUD; functions revoked from anon / authenticated / PUBLIC, kept for service_role); as Rep-like, estimator-like, owner, admin, other-org member and anon: `select *`, the per-column sensitive selects (cost, margin, WIP, wastage columns), insert / update / delete / truncate, the five functions all return 42501; defence in depth (SELECT re-granted, RLS shows zero rows); service role reads and writes all nine tables, runs the report functions and `recompute_product_hash`; unrelated tables and the activity_log / sales read policies unchanged.
- `src/supabase/__tests__/toolbox-cost-boundary.test.ts`: no user-JWT file queries the nine tables or the functions; REVIEWED-list gate for new user-JWT files; REVIEWED stays in step with the 0122 guard.
