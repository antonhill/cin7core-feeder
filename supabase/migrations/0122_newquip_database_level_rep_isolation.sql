-- NewQuip database-level Rep isolation. NOT applied to hosted Supabase (separate owner approval required).
--
-- WHY. Every NewQuip / approval / Project / claim table carried a single policy `SELECT USING (is_org_member(org_id))` for any signed-in organisation member, and `authenticated`
-- held SELECT (plus, on newquip_quotes and the project_* tables, the Supabase default ALL incl. TRUNCATE; `anon` held ALL on those too). So any member - including a Rep - could read
-- `newquip_quotes.draft` (estimator cost basis, physical costs, overrides), `accepted_baseline` (internal margin sheet), approval digests/reasons, Project cost entries ... straight through
-- PostgREST with the public anon key and their own JWT, bypassing the application's redaction. TRUNCATE is not subject to RLS at all.
--
-- WHAT. The application NEVER reads or writes these tables with a user JWT: every NewQuip/approval/Project/claim read and write, and the public customer portal, use the service-role
-- client (src/supabase/server.ts). The session (JWT) client reads only org_members / organizations. So client roles need no access whatsoever, and role-aware row policies cannot work anyway
-- (cost lives in jsonb columns; Rep/Estimator resolution depends on app settings - strict roles on/off, tier defaults - that SQL must not re-implement). Therefore, for the whole family:
--   1. REVOKE ALL on the table (and all column privileges) from PUBLIC, anon and authenticated   -> privilege layer: "permission denied for table".
--   2. DROP every policy and keep ROW LEVEL SECURITY enabled                                        -> RLS layer: even if a grant is ever re-added, no row is visible (default deny).
--   service_role (BYPASSRLS) is untouched, so every application path keeps working.
-- activity_log is shared with other Toolbox modules, so it is NOT revoked: its member SELECT policy is narrowed to hide the `newquip.* / approvals.* / projects.*` rows (return reasons,
-- approval audit, cost entries ...), and the client-role WRITE privileges (INSERT/UPDATE/DELETE/TRUNCATE/...) are removed (only the service role writes the log).
-- Nothing else is changed: no table, column, function, trigger, index or row is created, altered or deleted; Toolbox product/customer/quotes tables are untouched.
-- Idempotent: safe to re-run. Tables that do not exist yet (e.g. a branch that has not applied 0120) are skipped; tests/0122 fails CI if a later migration adds an unprotected family table.
-- ROLLBACK: supabase/rollback/0122_newquip_database_level_rep_isolation_rollback.sql.

do $$
declare
  t text;
  p text;
  fam text[] := array[
    -- quotations, delivery, customer responses, configuration
    'newquip_quotes','newquip_quote_customers','newquip_quote_documents','newquip_quote_sends','newquip_quote_responses',
    'newquip_response_links','newquip_response_reviews','newquip_response_evidence',
    'newquip_company_profiles','newquip_fx_rates','newquip_package_mappings','newquip_project_templates','newquip_project_template_versions',
    -- approvals and functional roles
    'approval_requests','approval_events','approval_notifications','approval_policies','approval_policy_events','approval_settings',
    'org_functional_roles','org_functional_role_events',
    -- projects, variations, deliveries, claims, costs
    'projects','project_variations','project_variation_stages','project_variation_schedule_amendments','project_stages','project_stage_allocations',
    'project_progress_events','project_opening_commitments','project_milestone_confirmations','project_deliveries','project_delivery_allocations','project_delivery_events',
    'project_cin7_links','project_cin7_sale_creations','project_cin7_sale_links','project_claims','project_claim_lines','project_claim_cin7_postings','project_cost_entries',
    -- held Slice 1A table (only if it has been applied)
    'customer_rep_assignments'];
begin
  foreach t in array fam loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p, t);
    end loop;
  end loop;
end $$;

-- activity_log (shared): hide NewQuip / approval / Project audit rows from client roles; client roles never write it.
do $$
begin
  if to_regclass('public.activity_log') is null then return; end if;
  alter table public.activity_log enable row level security;
  revoke insert, update, delete, truncate, references, trigger on table public.activity_log from public, anon, authenticated;
  revoke all on table public.activity_log from anon;
  drop policy if exists "org members read activity_log" on public.activity_log;
  create policy "org members read activity_log" on public.activity_log for select
    using (is_org_member(org_id) and action !~ '^(newquip|approvals|projects)\.');
end $$;
