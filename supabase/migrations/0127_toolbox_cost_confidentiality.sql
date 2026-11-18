-- Toolbox cost / margin confidentiality. NOT applied to any database (local, branch or hosted). Needs explicit owner approval before it is applied anywhere.
--
-- WHY. Nine generic Toolbox tables hold cost and margin data and each carried a single policy `org members read <table>` = SELECT USING (is_org_member(org_id)), plus table-level SELECT for
-- `authenticated` (and for `anon` on quotes / quote_lines, row-hidden by RLS) and, through the accidental Supabase default ALL, INSERT/UPDATE/DELETE/TRUNCATE for `authenticated` (TRUNCATE ignores RLS).
-- So ANY organisation member - including a NewQuip Rep - could read average_cost, supplier_fixed_price, quote margin fields, WIP costs, BOM costs ... straight through PostgREST with the public anon key
-- and their own JWT, bypassing the application's role-based redaction. The report_* SQL functions that aggregate cost / margin were also executable by PUBLIC / anon / authenticated.
--
-- WHAT. The application NEVER reads or writes these tables, or calls these functions, with a user JWT: every path uses the service-role client (src/supabase/server.ts); the session / browser
-- clients touch only org_members, organizations, super_admins and rpc create_self_serve_org (guarded by src/supabase/__tests__/rep-isolation-client-boundary.test.ts). Role-aware row policies cannot work
-- (the application, not SQL, knows who is an estimator or a rep). So, following the 0122 pattern, WHOLE-TABLE lockdown for the nine tables:
--   1. REVOKE ALL on the table from PUBLIC, anon, authenticated    -> privilege layer: "permission denied for table".
--   2. keep ROW LEVEL SECURITY enabled and DROP every policy       -> RLS layer: even if a grant is ever re-added, no row is visible (default deny).
--   service_role (BYPASSRLS, grants untouched) keeps working.
--   3. REVOKE EXECUTE on the cost / margin-reading functions from PUBLIC, anon, authenticated and grant it explicitly to service_role.
--
-- WHY NOT COLUMN GRANTS. Postgres privileges are additive: a column-level REVOKE does not override an existing table-level SELECT grant, so restricting columns would first need a table-level revoke
-- anyway, then per-column grants for every non-sensitive column, breaking `select *` and needing maintenance with every new column. Since nothing legitimate reads these tables as a client, the
-- whole-table revoke is the smaller and safer change. (See docs/toolbox-cost-confidentiality-design.md.)
--
-- Tables: products, quotes, quote_lines, sale_lines, assembly_bom_lines, assembly_consumption_lines, production_bom_items, production_operations, production_orders.
-- Functions (every overload, resolved by name): report_sales_by_product, report_sales_pivot, report_sales_facts, report_reorder, recompute_product_hash.
-- Nothing else is changed: no other table, column, view, policy, trigger or row (customers, suppliers, sales, purchases, org_members, organizations, activity_log ... keep their access).
-- Idempotent: safe to re-run. Tables / functions that do not exist are skipped. No data change.
-- ROLLBACK: supabase/rollback/0127_toolbox_cost_confidentiality_rollback.sql.

do $$
declare
  t text;
  p text;
begin
  foreach t in array array['products','quotes','quote_lines','sale_lines','assembly_bom_lines','assembly_consumption_lines','production_bom_items','production_operations','production_orders'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p, t);
    end loop;
  end loop;
end $$;

do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and p.proname in ('report_sales_by_product','report_sales_pivot','report_sales_facts','report_reorder','recompute_product_hash') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
