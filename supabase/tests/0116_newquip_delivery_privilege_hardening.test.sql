-- Transactional test for migration 0116 (privilege hardening of the 0115 tables). BEGIN/ROLLBACK - leaves no rows.
-- Proves: anon has nothing; authenticated has SELECT only (no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER); PUBLIC has nothing; RLS still isolates organisations;
-- direct EXECUTE of the trigger functions is denied while the triggers still fire; the service role still works; no sequences were exposed.
begin;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.as_role(r text) returns void language plpgsql as $$
begin perform set_config('role', r, true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

-- ── catalogue assertions (privileges as recorded) ───────────────────────────
do $$
declare t text; p text;
begin
  foreach t in array array['newquip_quote_customers','newquip_company_profiles','newquip_quote_documents','newquip_quote_sends','newquip_quote_responses'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', 'public.' || t, p) then raise exception 'anon must not have % on %', p, t; end if;
      if p <> 'SELECT' and has_table_privilege('authenticated', 'public.' || t, p) then raise exception 'authenticated must not have % on %', p, t; end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then raise exception 'authenticated must keep SELECT on %', t; end if;
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || t, p) then raise exception 'service_role must have % on %', p, t; end if;
    end loop;
    -- PUBLIC (grantee 0) holds nothing, and column-level grants cannot sneak a write back
    if exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = ('public.' || t)::regclass and a.grantee = 0) then raise exception 'PUBLIC must hold no privilege on %', t; end if;
    if exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attacl is not null and a.attnum > 0) then raise exception 'unexpected column-level grants on %', t; end if;
    -- no sequence is owned by these tables (uuid defaults only), so there is nothing to expose
    if exists (select 1 from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S' where d.refobjid = ('public.' || t)::regclass) then raise exception 'unexpected sequence owned by %', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'RLS must stay enabled on %', t; end if;
    if (select count(*) from pg_policies where tablename = t) <> 1 or exists (select 1 from pg_policies where tablename = t and cmd <> 'SELECT') then raise exception 'exactly one SELECT policy expected on %', t; end if;
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['newquip_quotes_acceptance_flag_guard()','newquip_company_profiles_version()','newquip_company_profiles_guard()','newquip_quote_customers_guard()','newquip_quote_documents_guard()','newquip_quote_sends_guard()','newquip_quote_responses_guard()'] loop
    if has_function_privilege('anon', 'public.' || f, 'EXECUTE') then raise exception 'anon must not execute %', f; end if;
    if has_function_privilege('authenticated', 'public.' || f, 'EXECUTE') then raise exception 'authenticated must not execute %', f; end if;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = ('public.' || f)::regprocedure and a.grantee = 0) then raise exception 'PUBLIC must not execute %', f; end if;
  end loop;
end $$;

-- ── behaviour under each role ───────────────────────────────────────────────
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000016a1'), ('00000000-0000-0000-0000-0000000016a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000016b1', 'PH Org A'), ('00000000-0000-0000-0000-0000000016b2', 'PH Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000016b1', '00000000-0000-0000-0000-0000000016a1', 'member'), ('00000000-0000-0000-0000-0000000016b2', '00000000-0000-0000-0000-0000000016a2', 'member');
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values ('00000000-0000-0000-0000-0000000016c1', '00000000-0000-0000-0000-0000000016b1', 'PH-1', '{}', 'h1');

-- the SERVICE ROLE writes (this fires the guard / versioning triggers even though direct EXECUTE was revoked) ...
select pg_temp.as_role('service_role');
insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email)
  values ('00000000-0000-0000-0000-0000000016b1', '00000000-0000-0000-0000-0000000016c1', 1, 'cin7-1', '{}', repeat('a', 64), 'rep@x');
insert into newquip_company_profiles (org_id, profile, entered_by_email) values ('00000000-0000-0000-0000-0000000016b1', '{"legalName":"x"}', 'm@x');
do $$ begin
  if (select version from newquip_company_profiles where org_id = '00000000-0000-0000-0000-0000000016b1') <> 1 then raise exception 'the versioning trigger must still assign version 1'; end if;
end $$;
-- ... and the triggers still ENFORCE: append-only, even for the service role
select pg_temp.expect_denied($q$update newquip_quote_customers set cin7_customer_id = 'changed'$q$, 'service role updating an append-only snapshot');
select pg_temp.expect_denied($q$delete from newquip_company_profiles$q$, 'service role deleting a profile version');
select pg_temp.expect_denied($q$update newquip_quotes set requires_customer_acceptance = false where quote_ref = 'PH-1'$q$, 'service role flipping the acceptance flag');
select pg_temp.as_role('postgres');

-- ANON: nothing at all
select pg_temp.as_role('anon');
select pg_temp.expect_denied($q$select count(*) from newquip_quote_customers$q$, 'anon read customers');
select pg_temp.expect_denied($q$select count(*) from newquip_company_profiles$q$, 'anon read profiles');
select pg_temp.expect_denied($q$select count(*) from newquip_quote_documents$q$, 'anon read documents');
select pg_temp.expect_denied($q$select count(*) from newquip_quote_sends$q$, 'anon read sends');
select pg_temp.expect_denied($q$select count(*) from newquip_quote_responses$q$, 'anon read responses');
select pg_temp.expect_denied($q$insert into newquip_company_profiles (org_id, profile, entered_by_email) values ('00000000-0000-0000-0000-0000000016b1', '{}', 'x')$q$, 'anon insert');
select pg_temp.expect_denied($q$truncate newquip_quote_customers$q$, 'anon truncate');
select pg_temp.expect_denied($q$select newquip_quote_customers_guard()$q$, 'anon calling a trigger function');
select pg_temp.as_role('postgres');

-- AUTHENTICATED: SELECT only, organisation-scoped
select pg_temp.act_as('00000000-0000-0000-0000-0000000016a1');
do $$ begin
  if (select count(*) from newquip_quote_customers) <> 1 then raise exception 'a member must still read their own organisation''s snapshot'; end if;
  if (select count(*) from newquip_company_profiles) <> 1 then raise exception 'a member must still read their own organisation''s profile'; end if;
end $$;
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email) values ('00000000-0000-0000-0000-0000000016b1', '00000000-0000-0000-0000-0000000016c1', gen_random_uuid(), 'ACCEPTED', 'J', current_date, 'client write', 'x')$q$, 'authenticated insert');
select pg_temp.expect_denied($q$update newquip_quote_customers set reason = 'x'$q$, 'authenticated update');
select pg_temp.expect_denied($q$delete from newquip_quote_customers$q$, 'authenticated delete');
select pg_temp.expect_denied($q$truncate newquip_quote_customers$q$, 'authenticated truncate');
select pg_temp.expect_denied($q$truncate newquip_company_profiles, newquip_quote_documents, newquip_quote_sends, newquip_quote_responses$q$, 'authenticated truncate of the rest');
select pg_temp.expect_denied($q$select newquip_quote_sends_guard()$q$, 'authenticated calling a trigger function');
select pg_temp.expect_denied($q$select newquip_company_profiles_version()$q$, 'authenticated calling the versioning function');
select pg_temp.as_role('postgres');
select pg_temp.act_as('00000000-0000-0000-0000-0000000016a2');
do $$ begin
  if (select count(*) from newquip_quote_customers) <> 0 then raise exception 'org B must not read org A snapshots'; end if;
  if (select count(*) from newquip_company_profiles) <> 0 then raise exception 'org B must not read org A profiles'; end if;
end $$;
select pg_temp.as_role('postgres');

-- existing objects were not touched: the quotation the new rows hang off is unchanged and still frozen/guarded
do $$ begin
  if (select count(*) from newquip_quotes where quote_ref = 'PH-1' and requires_customer_acceptance = true and state = 'REP_DRAFT') <> 1 then raise exception 'quotation row changed'; end if;
end $$;

select 'OK: 0116 delivery privilege hardening' as result;
rollback;
