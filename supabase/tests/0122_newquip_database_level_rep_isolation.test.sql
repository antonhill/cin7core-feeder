-- Transactional test for migration 0122 (database-level Rep isolation). BEGIN/ROLLBACK - leaves no rows.
-- Proves, as REAL database roles with REAL JWT claims (set role + request.jwt.claims), that:
--   * a Rep, an Estimator, a Manager, an organisation admin, a member of ANOTHER organisation and ANON cannot read a single NewQuip / approval / Project / claim / role table directly
--     (SQLSTATE 42501 permission denied) - in particular not newquip_quotes.draft (cost basis) or accepted_baseline (internal margin sheet);
--   * they cannot write or TRUNCATE them either;
--   * the RLS layer is independently default-deny: even if SELECT were re-granted, no row (and no policy) exists for them;
--   * the SERVICE ROLE (the application's only path) still reads and writes everything;
--   * activity_log keeps its Toolbox rows for members but hides newquip.* / approvals.* / projects.* rows, and clients cannot write/truncate it;
--   * nothing else changed: unrelated Toolbox tables keep their grants.
-- Plus a catalogue guard: ANY table in the protected families (present or added by a later migration) must have no client privilege and no policy, so a future migration that forgets it fails CI.
begin;

create or replace function pg_temp.as_user(uid uuid, mail text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', mail)::text, true);
end $$;
create or replace function pg_temp.as_role(r text) returns void language plpgsql as $$
begin perform set_config('role', r, true); end $$;
-- the statement must fail with SQLSTATE 42501 (insufficient_privilege)
create or replace function pg_temp.expect_42501(sql text, label text) returns void language plpgsql as $$
declare st text;
begin
  begin execute sql; exception when others then get stacked diagnostics st = returned_sqlstate; if st = '42501' then return; end if; raise exception 'WRONG ERROR (%) for %, expected 42501 permission denied', st, label; end;
  raise exception 'EXPECTED permission denied but succeeded: %', label;
end $$;

-- ── fixtures (as the table owner) ───────────────────────────────────────────
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000022a1'), ('00000000-0000-0000-0000-0000000022a2'), ('00000000-0000-0000-0000-0000000022a3'),
  ('00000000-0000-0000-0000-0000000022a4'), ('00000000-0000-0000-0000-0000000022a5');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000022b1', 'RI Org A'), ('00000000-0000-0000-0000-0000000022b2', 'RI Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a1', 'member'),   -- Rep
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a2', 'member'),   -- Estimator
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a3', 'member'),   -- Manager
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a4', 'admin'),    -- organisation admin
  ('00000000-0000-0000-0000-0000000022b2', '00000000-0000-0000-0000-0000000022a5', 'member');   -- other organisation
select org_role_assign('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a1', 'rep@x', 'REP', 'admin@x');
select org_role_assign('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a2', 'est@x', 'ESTIMATOR', 'admin@x');
select org_role_assign('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022a3', 'mgr@x', 'MANAGER', 'admin@x');

insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash)
values ('00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022b1', 'RI-1',
        '{"estimator":{"costBasis":"LANDED","physicalCosts":{"P1":12345},"costOverrides":{"P1":99}}}', 'h1');
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000022d1', '00000000-0000-0000-0000-0000000022b1', 'RI-P1', 'P1', 'Cust', 100000, 1500, 'DRAFT');
insert into project_cost_entries (org_id, project_id, category, description, supplier, amount_cents, state, recorded_by_email)
values ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022d1', 'SUBCONTRACTOR', 'Erectors', 'Acme', 5000000, 'COMMITTED', 'm@x');
insert into activity_log (org_id, action, summary) values
  ('00000000-0000-0000-0000-0000000022b1', 'sync.products', 'toolbox row'),
  ('00000000-0000-0000-0000-0000000022b1', 'newquip.quote_returned', 'return reason mentions margin'),
  ('00000000-0000-0000-0000-0000000022b1', 'approvals.approve', 'approval audit'),
  ('00000000-0000-0000-0000-0000000022b1', 'projects.cost_recorded', 'cost entry audit');

-- ── 1. catalogue guard over the whole protected family ──────────────────────
do $$
declare t record; p text; n int := 0;
begin
  for t in select c.oid, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
           and (c.relname ~ '^(newquip_|approval_|project_|org_functional_|customer_rep_)' or c.relname = 'projects') loop
    n := n + 1;
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', t.oid, p) then raise exception '0122: anon holds % on %', p, t.relname; end if;
      if has_table_privilege('authenticated', t.oid, p) then raise exception '0122: authenticated holds % on %', p, t.relname; end if;
    end loop;
    -- no column-level grants either (the 0117 links table used to expose metadata columns)
    if exists (select 1 from pg_attribute a, aclexplode(a.attacl) x where a.attrelid = t.oid and a.attnum > 0 and a.attacl is not null and x.grantee in (0, (select oid from pg_roles where rolname = 'anon'), (select oid from pg_roles where rolname = 'authenticated'))) then
      raise exception '0122: a client role holds a column privilege on %', t.relname; end if;
    if exists (select 1 from pg_class c2, aclexplode(coalesce(c2.relacl, acldefault('r', c2.relowner))) a where c2.oid = t.oid and a.grantee = 0) then raise exception '0122: PUBLIC holds a privilege on %', t.relname; end if;
    if not (select relrowsecurity from pg_class where oid = t.oid) then raise exception '0122: RLS must stay enabled on %', t.relname; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.relname) then raise exception '0122: % must carry no policy (default deny)', t.relname; end if;
    if not has_table_privilege('service_role', t.oid, 'SELECT') then raise exception '0122: service_role must keep SELECT on %', t.relname; end if;
  end loop;
  if n < 30 then raise exception '0122: the family guard saw only % tables - the name patterns no longer match', n; end if;
end $$;

-- ── 2. every role below is denied, on every protected table, for SELECT and writes ──
create or replace function pg_temp.deny_everything(label text) returns void language plpgsql as $$
declare t text;
begin
  foreach t in array array['newquip_quotes','newquip_quote_customers','newquip_quote_documents','newquip_quote_sends','newquip_quote_responses','newquip_response_links','newquip_response_reviews','newquip_response_evidence',
    'newquip_company_profiles','newquip_fx_rates','newquip_package_mappings','newquip_project_templates','newquip_project_template_versions',
    'approval_requests','approval_events','approval_notifications','approval_policies','approval_policy_events','approval_settings','org_functional_roles','org_functional_role_events',
    'projects','project_variations','project_variation_stages','project_variation_schedule_amendments','project_stages','project_stage_allocations','project_progress_events','project_opening_commitments',
    'project_milestone_confirmations','project_deliveries','project_delivery_allocations','project_delivery_events','project_cin7_links','project_cin7_sale_creations','project_cin7_sale_links',
    'project_claims','project_claim_lines','project_claim_cin7_postings','project_cost_entries'] loop
    perform pg_temp.expect_42501(format('select count(*) from %I', t), label || ' select ' || t);
    perform pg_temp.expect_42501(format('delete from %I', t), label || ' delete ' || t);
    perform pg_temp.expect_42501(format('truncate %I', t), label || ' truncate ' || t);
  end loop;
  -- the specific secrets, by column, the way PostgREST would ask for them
  perform pg_temp.expect_42501($q$select draft from newquip_quotes$q$, label || ' newquip_quotes.draft');
  perform pg_temp.expect_42501($q$select accepted_baseline from newquip_quotes$q$, label || ' newquip_quotes.accepted_baseline');
  perform pg_temp.expect_42501($q$select id from newquip_quotes where quote_ref = 'RI-1'$q$, label || ' newquip_quotes.id');
  perform pg_temp.expect_42501($q$update newquip_quotes set draft = '{}'$q$, label || ' update quote');
  perform pg_temp.expect_42501($q$insert into newquip_quotes (org_id, quote_ref, draft, draft_hash) values ('00000000-0000-0000-0000-0000000022b1', 'RI-X', '{}', 'x')$q$, label || ' insert quote');
  perform pg_temp.expect_42501($q$select amount_cents, supplier from project_cost_entries$q$, label || ' project_cost_entries');
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000022a1', 'rep@x');        select pg_temp.deny_everything('REP');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a2', 'est@x');        select pg_temp.deny_everything('ESTIMATOR');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a3', 'mgr@x');        select pg_temp.deny_everything('MANAGER');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a4', 'admin@x');       select pg_temp.deny_everything('ORG ADMIN');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a5', 'other@x');       select pg_temp.deny_everything('OTHER ORG MEMBER');
select pg_temp.as_role('postgres');
select pg_temp.as_role('anon');                                                  select pg_temp.deny_everything('ANON');
select pg_temp.as_role('postgres');

-- ── 3. defence in depth: RLS alone is default-deny even if SELECT were (wrongly) re-granted ──
grant select on newquip_quotes, approval_events, project_cost_entries to authenticated, anon;
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a1', 'rep@x');
do $$ begin
  if (select count(*) from newquip_quotes) <> 0 then raise exception 'RLS must hide quotes from a Rep even with SELECT granted'; end if;
  if (select count(*) from approval_events) <> 0 then raise exception 'RLS must hide approval events even with SELECT granted'; end if;
  if (select count(*) from project_cost_entries) <> 0 then raise exception 'RLS must hide cost entries even with SELECT granted'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a4', 'admin@x');
do $$ begin if (select count(*) from newquip_quotes) <> 0 then raise exception 'RLS must hide quotes from an admin too (the app is the only reader)'; end if; end $$;
select pg_temp.as_role('anon');
do $$ begin if (select count(*) from newquip_quotes) <> 0 then raise exception 'RLS must hide quotes from anon even with SELECT granted'; end if; end $$;
select pg_temp.as_role('postgres');
revoke select on newquip_quotes, approval_events, project_cost_entries from authenticated, anon;

-- ── 4. the SERVICE ROLE (the application's path) is unaffected ──────────────
select pg_temp.as_role('service_role');
do $$ begin
  if (select draft #>> '{estimator,costBasis}' from newquip_quotes where quote_ref = 'RI-1') <> 'LANDED' then raise exception 'service role must still read the draft'; end if;
  if (select count(*) from project_cost_entries) <> 1 then raise exception 'service role must still read cost entries'; end if;
  if (select count(*) from org_functional_roles) <> 3 then raise exception 'service role must still read roles'; end if;
end $$;
update newquip_quotes set draft = draft || '{"touched":true}'::jsonb where quote_ref = 'RI-1';
insert into projects (org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status) values ('00000000-0000-0000-0000-0000000022b1', 'RI-P2', 'P2', 'Cust', 1, 1500, 'DRAFT');
insert into activity_log (org_id, action, summary) values ('00000000-0000-0000-0000-0000000022b1', 'newquip.service_write', 'ok');
select pg_temp.as_role('postgres');
do $$ begin if (select (draft ->> 'touched')::boolean from newquip_quotes where quote_ref = 'RI-1') is not true then raise exception 'service role write did not land'; end if; end $$;

-- ── 5. activity_log: Toolbox rows stay readable, NewQuip audit rows are hidden, no client writes ──
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a1', 'rep@x');
do $$ begin
  if (select count(*) from activity_log where action = 'sync.products') <> 1 then raise exception 'a member must still read the Toolbox activity rows of their own organisation'; end if;
  if (select count(*) from activity_log where action ~ '^(newquip|approvals|projects)\.') <> 0 then raise exception 'NewQuip / approval / Project audit rows must be hidden from members'; end if;
end $$;
select pg_temp.expect_42501($q$insert into activity_log (org_id, action, summary) values ('00000000-0000-0000-0000-0000000022b1', 'x', 'y')$q$, 'member insert into activity_log');
select pg_temp.expect_42501($q$update activity_log set summary = 'x'$q$, 'member update activity_log');
select pg_temp.expect_42501($q$delete from activity_log$q$, 'member delete activity_log');
select pg_temp.expect_42501($q$truncate activity_log$q$, 'member truncate activity_log');
select pg_temp.as_user('00000000-0000-0000-0000-0000000022a5', 'other@x');
do $$ begin if (select count(*) from activity_log) <> 0 then raise exception 'another organisation must see none of the activity'; end if; end $$;
select pg_temp.as_role('anon');
select pg_temp.expect_42501($q$select count(*) from activity_log$q$, 'anon read activity_log');
select pg_temp.as_role('postgres');

-- ── 6. nothing else changed: unrelated Toolbox tables keep their client read ──
-- (products / quotes / quote_lines / sale_lines are deliberately locked down by 0127 and are asserted in tests/0127_toolbox_cost_confidentiality.test.sql)
do $$
declare t text;
begin
  foreach t in array array['customers','org_members','organizations'] loop
    if to_regclass('public.' || t) is not null and not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then raise exception '0122 must not change access to %', t; end if;
  end loop;
end $$;

-- ── 7. the 0122 migration is idempotent (re-run the policy/privilege section on a clean state: no error, same result) ──
-- (the full file is replayed by CI bootstrap once; the revoke/drop statements are inherently re-runnable)
revoke all on table newquip_quotes from public, anon, authenticated;
do $$ begin if has_table_privilege('authenticated', 'newquip_quotes', 'SELECT') then raise exception 'still revoked'; end if; end $$;

select 'ALL 0122 REP DATABASE ISOLATION TESTS PASSED' as result;
rollback;
