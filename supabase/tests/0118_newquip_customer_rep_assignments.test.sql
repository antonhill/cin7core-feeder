-- Transactional test for migration 0118 (customer -> Rep assignments with append-only history). BEGIN/ROLLBACK - leaves no rows.
begin;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000018a1'), ('00000000-0000-0000-0000-0000000018a2'), ('00000000-0000-0000-0000-0000000018a3');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000018b1', 'CA Org A'), ('00000000-0000-0000-0000-0000000018b2', 'CA Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000018b1', '00000000-0000-0000-0000-0000000018a1', 'member'),
  ('00000000-0000-0000-0000-0000000018b1', '00000000-0000-0000-0000-0000000018a2', 'member'),
  ('00000000-0000-0000-0000-0000000018b2', '00000000-0000-0000-0000-0000000018a3', 'member');

-- an active assignment is created, and MULTIPLE Reps may be active on one customer
insert into customer_rep_assignments (id, org_id, cin7_customer_id, customer_name, rep_user_id, rep_email, assigned_by_email)
values ('00000000-0000-0000-0000-0000000018c1', '00000000-0000-0000-0000-0000000018b1', 'cust-1', 'Farm One', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test');
insert into customer_rep_assignments (id, org_id, cin7_customer_id, customer_name, rep_user_id, rep_email, assigned_by_email)
values ('00000000-0000-0000-0000-0000000018c2', '00000000-0000-0000-0000-0000000018b1', 'cust-1', 'Farm One', '00000000-0000-0000-0000-0000000018a2', 'rep2@x.test', 'mgr@x.test');
do $$ begin
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'cust-1' and ended_at is null) <> 2 then raise exception 'two Reps may be active on one customer'; end if;
end $$;

-- the same Rep cannot be actively assigned to the same customer twice
select pg_temp.expect_denied($q$insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values ('00000000-0000-0000-0000-0000000018b1', 'cust-1', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test')$q$, 'duplicate active assignment');
-- the cleared-selection marker is never a customer
select pg_temp.expect_denied($q$insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values ('00000000-0000-0000-0000-0000000018b1', '(cleared)', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test')$q$, 'cleared marker as customer');
-- an assignment is created active
select pg_temp.expect_denied($q$insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email, ended_at, ended_by_email, end_reason) values ('00000000-0000-0000-0000-0000000018b1', 'cust-9', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test', now(), 'm@x.test', 'created ended')$q$, 'created already ended');

-- identity columns are immutable
select pg_temp.expect_denied($q$update customer_rep_assignments set rep_user_id = '00000000-0000-0000-0000-0000000018a2' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'reassign by editing the Rep');
select pg_temp.expect_denied($q$update customer_rep_assignments set cin7_customer_id = 'cust-2' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'edit the customer');
-- ending needs the actor and a real reason, together
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = now() where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'end without actor/reason');
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = now(), ended_by_email = 'm@x.test', end_reason = 'x' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'end with a trivial reason');
-- a no-op update is not an end
select pg_temp.expect_denied($q$update customer_rep_assignments set assigned_reason = 'edited' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'edit the reason');

-- ending is one-way and leaves the other Rep untouched
update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'mgr@x.test', end_reason = 'customer reassigned' where id = '00000000-0000-0000-0000-0000000018c1';
do $$ begin
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'cust-1' and ended_at is null) <> 1 then raise exception 'ending one assignment leaves the other Rep active'; end if;
end $$;
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = null, ended_by_email = null, end_reason = null where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'reopen an ended assignment');
select pg_temp.expect_denied($q$update customer_rep_assignments set end_reason = 'changed my mind' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'rewrite an ended assignment');
-- history is never deleted
select pg_temp.expect_denied($q$delete from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'delete history');

-- the SAME Rep may be assigned again later: a NEW row, with the earlier period preserved
insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email)
values ('00000000-0000-0000-0000-0000000018b1', 'cust-1', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test');
do $$ begin
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'cust-1' and rep_user_id = '00000000-0000-0000-0000-0000000018a1') <> 2 then raise exception 'history keeps both periods'; end if;
end $$;

-- organisations are independent: the same Cin7 customer id in another organisation is unrelated
insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email)
values ('00000000-0000-0000-0000-0000000018b2', 'cust-1', '00000000-0000-0000-0000-0000000018a3', 'rep3@x.test', 'mgr@x.test');

-- CLIENTS read nothing: RLS is on with no policy, and no privilege is granted to anon / authenticated
do $$ begin
  if not (select relrowsecurity from pg_class where oid = 'customer_rep_assignments'::regclass) then raise exception 'RLS must be enabled'; end if;
  if exists (select 1 from pg_policies where tablename = 'customer_rep_assignments') then raise exception 'the table must have no client policy'; end if;
  if has_table_privilege('authenticated', 'customer_rep_assignments', 'SELECT') or has_table_privilege('anon', 'customer_rep_assignments', 'SELECT') then raise exception 'clients must have no SELECT'; end if;
  if has_table_privilege('authenticated', 'customer_rep_assignments', 'INSERT') or has_table_privilege('anon', 'customer_rep_assignments', 'INSERT') then raise exception 'clients must have no INSERT'; end if;
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000018a1');
select pg_temp.expect_denied($q$select count(*) from customer_rep_assignments$q$, 'a member reading assignments through the database API');
select pg_temp.expect_denied($q$insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values ('00000000-0000-0000-0000-0000000018b1', 'cust-7', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'rep1@x.test')$q$, 'a Rep assigning themselves through the database API');
select pg_temp.reset_role();

-- service_role has exactly what the server code needs: read, create, end - no delete, truncate, or edits to other columns
do $$ begin
  if not has_table_privilege('service_role', 'customer_rep_assignments', 'SELECT') then raise exception 'service role reads assignments'; end if;
  if not has_table_privilege('service_role', 'customer_rep_assignments', 'INSERT') then raise exception 'service role creates assignments'; end if;
  if has_table_privilege('service_role', 'customer_rep_assignments', 'DELETE') or has_table_privilege('service_role', 'customer_rep_assignments', 'TRUNCATE') then raise exception 'service role must not delete or truncate history'; end if;
  if has_table_privilege('service_role', 'customer_rep_assignments', 'REFERENCES') or has_table_privilege('service_role', 'customer_rep_assignments', 'TRIGGER') then raise exception 'excess service_role privileges'; end if;
  if has_table_privilege('service_role', 'customer_rep_assignments', 'UPDATE') then raise exception 'service role has no table-wide UPDATE (column grants only)'; end if;
  if not has_column_privilege('service_role', 'customer_rep_assignments', 'ended_at', 'UPDATE') then raise exception 'service role may end an assignment'; end if;
  if has_column_privilege('service_role', 'customer_rep_assignments', 'rep_user_id', 'UPDATE') or has_column_privilege('service_role', 'customer_rep_assignments', 'cin7_customer_id', 'UPDATE') then raise exception 'identity columns are not updatable'; end if;
end $$;

-- existing tables are untouched: this migration adds no policy anywhere else
do $$ begin
  if (select count(*) from pg_policies where tablename = 'customer_rep_assignments') <> 0 then raise exception 'no policy on the new table'; end if;
end $$;

select 'OK: 0118 customer rep assignments' as result;
rollback;
