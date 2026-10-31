-- Transactional test for migration 0119 (customer-level Rep isolation, database layer). BEGIN/ROLLBACK - leaves no rows.
-- Proves: OFF (default) changes nothing for any member; ON limits direct (authenticated) reads of quotation / response / approval / Project rows and NewQuip activity rows to organisation
-- owner/admin and EXPLICIT Estimator/Manager (+ Project Manager/Procurement for Project tables); implicit tier roles, Reps and plain members read nothing; other organisations never leak;
-- Toolbox activity rows are unaffected; the switch is audited, atomic, service_role-only and cannot be forged by a client.
begin;

create or replace function pg_temp.act_as(uid uuid, mail text default null) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', mail)::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$ begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$ begin perform set_config('role', 'service_role', true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin begin execute sql; exception when others then return; end; raise exception 'EXPECTED DENIAL but succeeded: %', label; end $$;
create or replace function pg_temp.seen(sql text) returns bigint language plpgsql as $$ declare n bigint; begin execute 'select count(*) from (' || sql || ') t' into n; return n; end $$;

-- organisations A (the NewQuip one) and B; users
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000019a1'), ('00000000-0000-0000-0000-0000000019a2'), ('00000000-0000-0000-0000-0000000019a3'), ('00000000-0000-0000-0000-0000000019a4'),
  ('00000000-0000-0000-0000-0000000019a5'), ('00000000-0000-0000-0000-0000000019a6'), ('00000000-0000-0000-0000-0000000019a7'), ('00000000-0000-0000-0000-0000000019a8');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000019b1', 'ISO Org A'), ('00000000-0000-0000-0000-0000000019b2', 'ISO Org B');
-- a1 admin | a2 explicit MANAGER | a3 explicit ESTIMATOR | a4 explicit REP only | a5 plain member (no explicit role: tier defaults only) | a6 explicit PROJECT_MANAGER | a7 explicit ADMINISTRATOR only | a8 admin of org B
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a1', 'admin'), ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a2', 'member'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a3', 'member'), ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a4', 'member'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a5', 'member'), ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a6', 'member'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a7', 'member'), ('00000000-0000-0000-0000-0000000019b2', '00000000-0000-0000-0000-0000000019a8', 'admin');
insert into org_functional_roles (org_id, user_id, user_email, role, assigned_by_email) values
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a2', 'mgr@x.test', 'MANAGER', 'adm@x.test'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a3', 'est@x.test', 'ESTIMATOR', 'adm@x.test'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a4', 'rep@x.test', 'REP', 'adm@x.test'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a6', 'pm@x.test', 'PROJECT_MANAGER', 'adm@x.test'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a7', 'adm7@x.test', 'ADMINISTRATOR', 'adm@x.test');

-- data in both organisations
insert into newquip_quotes (id, org_id, quote_ref, customer_name, site_name, draft, draft_hash) values
  ('00000000-0000-0000-0000-0000000019d1', '00000000-0000-0000-0000-0000000019b1', 'ISO-1', 'Cust A', 'Site', '{"estimator":{"costOverrides":{"x":1}}}', 'h1'),
  ('00000000-0000-0000-0000-0000000019d2', '00000000-0000-0000-0000-0000000019b2', 'ISO-2', 'Cust B', 'Site', '{}', 'h2');
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status) values
  ('00000000-0000-0000-0000-0000000019c1', '00000000-0000-0000-0000-0000000019b1', 'ISO-P1', 'P', 'Cust A', 1000, 1500, 'DRAFT'),
  ('00000000-0000-0000-0000-0000000019c2', '00000000-0000-0000-0000-0000000019b2', 'ISO-P2', 'P', 'Cust B', 1000, 1500, 'DRAFT');
insert into approval_requests (id, org_id, doc_type, doc_id, doc_ref, revision, digest, amount_cents, prepared_by_email) values
  ('00000000-0000-0000-0000-0000000019e1', '00000000-0000-0000-0000-0000000019b1', 'CLAIM', '00000000-0000-0000-0000-0000000019f1', 'c', 1, repeat('a',64), 1, 'p@x.test');
insert into approval_requests (id, org_id, doc_type, doc_id, doc_ref, revision, digest, amount_cents, prepared_by_email) values
  ('00000000-0000-0000-0000-0000000019e2', '00000000-0000-0000-0000-0000000019b1', 'QUOTE', '00000000-0000-0000-0000-0000000019d1', 'q', 1, repeat('c',64), 1, 'p@x.test');
insert into approval_events (org_id, request_id, doc_type, doc_id, doc_ref, revision, action, actor_email, digest) values
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019e1', 'CLAIM', '00000000-0000-0000-0000-0000000019f1', 'c', 1, 'SUBMITTED', 'p@x.test', repeat('a',64)),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019e2', 'QUOTE', '00000000-0000-0000-0000-0000000019d1', 'q', 1, 'SUBMITTED', 'p@x.test', repeat('c',64));
insert into activity_log (org_id, actor_email, action, summary) values
  ('00000000-0000-0000-0000-0000000019b1', 'x@x.test', 'newquip.quote_created', 'NewQuip row'), ('00000000-0000-0000-0000-0000000019b1', 'x@x.test', 'approvals.decided', 'Approvals row'),
  ('00000000-0000-0000-0000-0000000019b1', 'x@x.test', 'projects.claim_approved', 'Projects row'), ('00000000-0000-0000-0000-0000000019b1', 'x@x.test', 'sync.completed', 'Toolbox row'),
  ('00000000-0000-0000-0000-0000000019b2', 'x@x.test', 'newquip.quote_created', 'Other org row');
insert into approval_notifications (id, org_id, request_id, kind, recipient_email, channel, subject, body, dedupe_key, status, sent_at)
  values ('00000000-0000-0000-0000-0000000019aa', '00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019e1', 'SUBMITTED', 'rep@x.test', 'IN_APP', 's', 'b', 'iso-n1', 'SENT', now());

-- the helper queries, as each user (counts of what a direct database-API read returns)
create or replace function pg_temp.matrix(uid uuid, mail text) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.act_as(uid, mail);
  r := pg_temp.seen('select 1 from newquip_quotes') || '/' || pg_temp.seen('select 1 from projects') || '/' || pg_temp.seen('select 1 from approval_requests') || '/'
       || pg_temp.seen($q$select 1 from activity_log where action like 'newquip.%' or action like 'approvals.%' or action like 'projects.%'$q$) || '/'
       || pg_temp.seen($q$select 1 from activity_log where action like 'sync.%'$q$) || '/' || pg_temp.seen('select 1 from approval_notifications') || '/' || pg_temp.seen('select 1 from approval_events');
  perform pg_temp.reset_role();
  return r;
end $$;
-- format: quotes/projects/approvals/namespaced-activity/toolbox-activity/own-notifications/approval-events

-- ── switch OFF (default, no settings row): EVERY org member reads exactly as before ──
do $$ begin
  if pg_temp.matrix('00000000-0000-0000-0000-0000000019a4', 'rep@x.test') <> '1/1/2/3/1/1/2' then raise exception 'OFF: a Rep keeps today''s org-wide read (got %)', pg_temp.matrix('00000000-0000-0000-0000-0000000019a4', 'rep@x.test'); end if;
  if pg_temp.matrix('00000000-0000-0000-0000-0000000019a5', 'p@x.test') <> '1/1/2/3/1/0/2' then raise exception 'OFF: a plain member keeps today''s read (got %)', pg_temp.matrix('00000000-0000-0000-0000-0000000019a5', 'p@x.test'); end if;
  if pg_temp.matrix('00000000-0000-0000-0000-0000000019a8', 'o@x.test') <> '1/1/0/1/0/0/0' then raise exception 'OFF: another organisation''s admin reads only its own (got %)', pg_temp.matrix('00000000-0000-0000-0000-0000000019a8', 'o@x.test'); end if;
  if newquip_isolation_on('00000000-0000-0000-0000-0000000019b1') then raise exception 'default must be OFF'; end if;
end $$;

-- ── privileges of the switch: not callable or readable by clients; service_role only ──
do $$ begin
  if has_function_privilege('authenticated', 'newquip_set_rep_isolation(uuid,boolean,text,text,jsonb)', 'EXECUTE') or has_function_privilege('anon', 'newquip_set_rep_isolation(uuid,boolean,text,text,jsonb)', 'EXECUTE') then raise exception 'clients must not execute the switch'; end if;
  if not has_function_privilege('service_role', 'newquip_set_rep_isolation(uuid,boolean,text,text,jsonb)', 'EXECUTE') then raise exception 'service_role runs the switch'; end if;
  if has_table_privilege('authenticated', 'newquip_access_settings', 'SELECT') or has_table_privilege('authenticated', 'newquip_access_setting_events', 'SELECT') or has_table_privilege('anon', 'newquip_access_settings', 'INSERT') then raise exception 'clients have no privilege on the settings tables'; end if;
  if has_table_privilege('service_role', 'newquip_access_settings', 'DELETE') or has_table_privilege('service_role', 'newquip_access_setting_events', 'UPDATE') or has_table_privilege('service_role', 'newquip_access_setting_events', 'DELETE') then raise exception 'service_role cannot delete settings or edit the audit'; end if;
  if (select prosecdef from pg_proc where proname = 'newquip_set_rep_isolation') then raise exception 'the switch is SECURITY INVOKER'; end if;
  if exists (select 1 from pg_policies where tablename in ('newquip_access_settings', 'newquip_access_setting_events')) then raise exception 'the settings tables have no client policy'; end if;
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000019a4', 'rep@x.test');
select pg_temp.expect_denied($q$select newquip_set_rep_isolation('00000000-0000-0000-0000-0000000019b1', true, 'rep@x.test', 'I enable it myself', '{}')$q$, 'a Rep flipping the switch');
select pg_temp.expect_denied($q$update newquip_access_settings set rep_isolation_enabled = false$q$, 'a client editing the setting');
select pg_temp.expect_denied($q$insert into newquip_access_settings (org_id, rep_isolation_enabled) values ('00000000-0000-0000-0000-0000000019b1', false)$q$, 'a client inserting a setting');
select pg_temp.reset_role();

-- ── the switch (service_role): validation, atomic audit ──
select pg_temp.as_service();
select pg_temp.expect_denied($q$select newquip_set_rep_isolation('00000000-0000-0000-0000-0000000019b1', true, 'adm@x.test', 'no', '{}')$q$, 'trivial reason');
select pg_temp.expect_denied($q$select newquip_set_rep_isolation('00000000-0000-0000-0000-0000000019b1', true, 'x', 'a proper reason', '{}')$q$, 'no real actor');
select pg_temp.expect_denied($q$select newquip_set_rep_isolation('00000000-0000-0000-0000-0000000019ff', true, 'adm@x.test', 'unknown organisation', '{}')$q$, 'unknown org');
select pg_temp.reset_role();
do $$ begin
  if exists (select 1 from newquip_access_settings) or exists (select 1 from newquip_access_setting_events) then raise exception 'a refused switch change leaves no setting and no audit'; end if;
end $$;
select pg_temp.as_service();
select newquip_set_rep_isolation('00000000-0000-0000-0000-0000000019b1', true, 'adm@x.test', 'owner approved enforcement', '{"unassignedCustomers": 2}');
select pg_temp.reset_role();
do $$ begin
  if not newquip_isolation_on('00000000-0000-0000-0000-0000000019b1') then raise exception 'organisation A is now ON'; end if;
  if newquip_isolation_on('00000000-0000-0000-0000-0000000019b2') then raise exception 'organisation B is untouched'; end if;
  if (select count(*) from newquip_access_setting_events where org_id = '00000000-0000-0000-0000-0000000019b1' and enabled and actor_email = 'adm@x.test' and preflight->>'unassignedCustomers' = '2') <> 1 then raise exception 'the change is audited with actor, reason and preflight'; end if;
end $$;
select pg_temp.expect_denied($q$update newquip_access_setting_events set reason = 'rewritten'$q$, 'rewrite the audit');
select pg_temp.expect_denied($q$delete from newquip_access_setting_events$q$, 'delete the audit');

-- ── switch ON for organisation A ──
do $$ declare r text; begin
  -- quotes/projects/approvals/namespaced-activity/toolbox-activity/own-notifications
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a1', 'adm@x.test'); if r <> '1/1/2/3/1/0/2' then raise exception 'ON: the organisation admin keeps full read (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a2', 'mgr@x.test'); if r <> '1/1/2/3/1/0/2' then raise exception 'ON: an explicit Manager keeps full read (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a3', 'est@x.test'); if r <> '1/1/2/3/1/0/2' then raise exception 'ON: an explicit Estimator keeps full read (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a6', 'pm@x.test'); if r <> '0/1/1/1/1/0/1' then raise exception 'ON: a Project Manager reads Projects, claim approvals and projects.* activity but NOT quotations or NewQuip/approvals activity (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a4', 'rep@x.test'); if r <> '0/0/0/0/1/0/0' then raise exception 'ON: a Rep reads NO quotation, Project, approval, NewQuip activity or notification row directly, Toolbox activity unchanged (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a5', 'p@x.test'); if r <> '0/0/0/0/1/0/0' then raise exception 'ON: a plain member (tier-default roles only) reads none (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a7', 'adm7@x.test'); if r <> '0/0/0/0/1/0/0' then raise exception 'ON: an explicit Administrator who is not an organisation admin gets no commercial visibility (got %)', r; end if;
  r := pg_temp.matrix('00000000-0000-0000-0000-0000000019a8', 'o@x.test'); if r <> '1/1/0/1/0/0/0' then raise exception 'ON(A): organisation B is unaffected and never sees A (got %)', r; end if;
end $$;

-- the Rep named as a notification recipient still cannot read the notification row directly when ON (the server boundary filters and serves it)
do $$ begin
  perform pg_temp.act_as('00000000-0000-0000-0000-0000000019a4', 'rep@x.test');
  if pg_temp.seen('select 1 from approval_notifications') <> 0 then raise exception 'ON: the recipient Rep reads no notification row directly'; end if;
  perform pg_temp.reset_role();
end $$;

-- a user in organisation B holding the same explicit role names gains nothing in A, and an A user's role does not leak into B
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000019a9');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000019b2', '00000000-0000-0000-0000-0000000019a9', 'member');
insert into org_functional_roles (org_id, user_id, user_email, role, assigned_by_email) values ('00000000-0000-0000-0000-0000000019b2', '00000000-0000-0000-0000-0000000019a9', 'mgrb@x.test', 'MANAGER', 'x@x');
do $$ begin
  if pg_temp.matrix('00000000-0000-0000-0000-0000000019a9', 'mgrb@x.test') <> '1/1/0/1/0/0/0' then raise exception 'a Manager of B reads B only (got %)', pg_temp.matrix('00000000-0000-0000-0000-0000000019a9', 'mgrb@x.test'); end if;
end $$;

-- ── switch OFF again: everyone back to today's behaviour; the audit keeps both changes ──
select pg_temp.as_service();
select newquip_set_rep_isolation('00000000-0000-0000-0000-0000000019b1', false, 'adm@x.test', 'rolled back for testing', '{}');
select pg_temp.reset_role();
do $$ begin
  if pg_temp.matrix('00000000-0000-0000-0000-0000000019a4', 'rep@x.test') <> '1/1/2/3/1/1/2' then raise exception 'OFF again: the Rep reads as before'; end if;
  if (select count(*) from newquip_access_setting_events where org_id = '00000000-0000-0000-0000-0000000019b1') <> 2 then raise exception 'both changes are in the audit'; end if;
end $$;

-- the helpers answer false to a non-member (no cross-organisation probing) and the raw switch helper is not callable by clients
do $$ begin
  perform pg_temp.act_as('00000000-0000-0000-0000-0000000019a8', 'o@x.test');
  if newquip_quote_scope_ok('00000000-0000-0000-0000-0000000019b1') or newquip_project_scope_ok('00000000-0000-0000-0000-0000000019b1') then raise exception 'org B admin must get false for org A'; end if;
  perform pg_temp.reset_role();
  if has_function_privilege('authenticated', 'newquip_isolation_on(uuid)', 'EXECUTE') or has_function_privilege('anon', 'newquip_quote_scope_ok(uuid)', 'EXECUTE') then raise exception 'clients cannot call the raw switch helper, anon cannot call any helper'; end if;
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000019a4', 'rep@x.test');
select pg_temp.expect_denied($q$select newquip_isolation_on('00000000-0000-0000-0000-0000000019b1')$q$, 'a client reading the switch through the helper');
select pg_temp.reset_role();

-- ── catalogue: every restricted table carries the scope test; nothing else was re-scoped; writes are untouched ──
do $$
declare t text; q text;
begin
  foreach t in array array['newquip_quotes','newquip_quote_customers','newquip_quote_documents','newquip_quote_sends','newquip_quote_responses','newquip_response_reviews','newquip_response_evidence','newquip_response_links','approval_requests','approval_events'] loop
    select string_agg(qual, ' ') into q from pg_policies where tablename = t and cmd = 'SELECT';
    if q is null or q !~ 'newquip_quote_scope_ok' or q !~ 'is_org_member' then raise exception 'quotation-scope policy missing on %: %', t, q; end if;
  end loop;
  foreach t in array array['projects','project_cin7_links','project_cin7_sale_creations','project_cin7_sale_links','project_claim_cin7_postings','project_claim_lines','project_claims','project_deliveries','project_delivery_allocations','project_delivery_events','project_milestone_confirmations','project_opening_commitments','project_progress_events','project_stage_allocations','project_stages','project_variation_schedule_amendments','project_variation_stages','project_variations'] loop
    select string_agg(qual, ' ') into q from pg_policies where tablename = t and cmd = 'SELECT';
    if q is null or q !~ 'newquip_project_scope_ok' or q !~ 'is_org_member' then raise exception 'project-scope policy missing on %: %', t, q; end if;
  end loop;
  select string_agg(qual, ' ') into q from pg_policies where tablename = 'approval_notifications' and cmd = 'SELECT';
  if q is null or q !~ 'newquip_project_scope_ok' or q !~ 'recipient_email' then raise exception 'notification policy keeps its recipient test and gains the scope test: %', q; end if;
  select string_agg(qual, ' ') into q from pg_policies where tablename = 'activity_log' and cmd = 'SELECT';
  if q !~ 'newquip_quote_scope_ok' then raise exception 'activity_log policy'; end if;
  -- a table this migration must NOT touch keeps its original predicate
  select string_agg(qual, ' ') into q from pg_policies where tablename = 'newquip_fx_rates' and cmd = 'SELECT';
  if q ~ 'scope_ok' then raise exception 'organisation configuration tables are not re-scoped'; end if;
  select string_agg(qual, ' ') into q from pg_policies where tablename = 'project_cost_entries' and cmd = 'SELECT';
  if q ~ 'scope_ok' or q !~ 'is_org_admin' then raise exception 'the admin-only cost table is unchanged'; end if;
  -- no policy anywhere allows a client to WRITE the restricted tables (unchanged: none did)
  if exists (select 1 from pg_policies where tablename in ('newquip_quotes','newquip_quote_documents','newquip_quote_responses','projects','approval_requests') and cmd <> 'SELECT') then raise exception 'no client write policy on the restricted tables'; end if;
end $$;

-- a client cannot widen anything by writing the settings or roles tables
select pg_temp.act_as('00000000-0000-0000-0000-0000000019a4', 'rep@x.test');
select pg_temp.expect_denied($q$insert into org_functional_roles (org_id, user_id, user_email, role, assigned_by_email) values ('00000000-0000-0000-0000-0000000019b1','00000000-0000-0000-0000-0000000019a4','rep@x.test','MANAGER','rep@x.test')$q$, 'a Rep granting themselves Manager');
select pg_temp.reset_role();

select 'OK: 0119 Rep customer isolation (database layer)' as result;
rollback;
