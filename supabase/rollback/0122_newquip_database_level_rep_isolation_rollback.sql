-- ROLLBACK for 0122_newquip_database_level_rep_isolation.sql. Run only with owner approval. Restores the pre-0122 CLIENT READ access (policy + SELECT) so any
-- direct member reads work again. It deliberately does NOT restore the accidental TRUNCATE/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER grants that anon and authenticated held on
-- newquip_quotes and the project_* tables (see the optional step C), because nothing ever needed them. It reverses ONLY 0122.
-- Re-running is safe.

-- A. restore the member read policies (exactly as before 0122)
do $$
declare t text;
begin
  foreach t in array array[
    'newquip_quotes','newquip_quote_customers','newquip_quote_documents','newquip_quote_sends','newquip_quote_responses','newquip_response_links','newquip_response_reviews','newquip_response_evidence',
    'newquip_company_profiles','newquip_fx_rates','newquip_package_mappings','newquip_project_templates','newquip_project_template_versions',
    'approval_requests','approval_events','approval_policies','org_functional_roles',
    'projects','project_variations','project_variation_stages','project_variation_schedule_amendments','project_stages','project_stage_allocations','project_progress_events',
    'project_opening_commitments','project_milestone_confirmations','project_deliveries','project_delivery_allocations','project_delivery_events','project_cin7_links','project_cin7_sale_creations',
    'project_cin7_sale_links','project_claims','project_claim_lines','project_claim_cin7_postings'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', 'org members read ' || t, t);
    execute format('create policy %I on public.%I for select using (is_org_member(org_id))', 'org members read ' || t, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
  -- admin-only reads
  foreach t in array array['approval_settings','approval_policy_events','project_cost_entries','org_functional_role_events'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', 'org admins read ' || t, t);
    execute format('create policy %I on public.%I for select using (is_org_admin(org_id))', 'org admins read ' || t, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;
drop policy if exists "recipients read approval_notifications" on approval_notifications;
create policy "recipients read approval_notifications" on approval_notifications for select
  using (is_org_member(org_id) and recipient_email = lower(coalesce((auth.jwt() ->> 'email'), '')));
grant select on approval_notifications to authenticated;

-- 0117 gave authenticated only these COLUMNS of newquip_response_links (never the token hash); restore exactly that, not the whole table.
revoke all on newquip_response_links from authenticated;
grant select (id, org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, environment, expires_at, created_by_email, created_at, revoked_at, revoked_reason, attempts)
  on newquip_response_links to authenticated;

-- B. activity_log: restore the org-wide member read policy (client write privileges stay removed - they were never usable under RLS and are not restored)
drop policy if exists "org members read activity_log" on activity_log;
create policy "org members read activity_log" on activity_log for select using (is_org_member(org_id));

-- C. (NOT recommended, not run) the pre-0122 state also had anon + authenticated ALL privileges on newquip_quotes and the project_* tables:
--   grant all on newquip_quotes, projects, ... to anon, authenticated;
