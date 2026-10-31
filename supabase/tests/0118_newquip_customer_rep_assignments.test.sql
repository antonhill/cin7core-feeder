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
do $$ begin
  if (select replaced_by_assignment_id from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018c1') is not null then raise exception 'a plain end names no successor'; end if;
end $$;
select pg_temp.expect_denied($q$update customer_rep_assignments set replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c2' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'attach a successor to an already-ended row');
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = null, ended_by_email = null, end_reason = null where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'reopen an ended assignment');
select pg_temp.expect_denied($q$update customer_rep_assignments set end_reason = 'changed my mind' where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'rewrite an ended assignment');
-- history is never deleted
select pg_temp.expect_denied($q$delete from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018c1'$q$, 'delete history');

-- the successor link is guarded: it must be ANOTHER Rep's assignment of the SAME customer in the SAME organisation (c2 = cust-1/a2 active; c3 = cust-8/a3 in org B; c4 = cust-8/a1 org A)
insert into customer_rep_assignments (id, org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values
  ('00000000-0000-0000-0000-0000000018c3', '00000000-0000-0000-0000-0000000018b2', 'cust-8', '00000000-0000-0000-0000-0000000018a3', 'rep3@x.test', 'mgr@x.test'),
  ('00000000-0000-0000-0000-0000000018c4', '00000000-0000-0000-0000-0000000018b1', 'cust-8', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test'),
  ('00000000-0000-0000-0000-0000000018c5', '00000000-0000-0000-0000-0000000018b1', 'cust-8', '00000000-0000-0000-0000-0000000018a2', 'rep2@x.test', 'mgr@x.test');
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'm@x.test', end_reason = 'moved', replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c3' where id = '00000000-0000-0000-0000-0000000018c4'$q$, 'successor in ANOTHER organisation');
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'm@x.test', end_reason = 'moved', replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c2' where id = '00000000-0000-0000-0000-0000000018c4'$q$, 'successor on a DIFFERENT customer');
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'm@x.test', end_reason = 'moved', replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c4' where id = '00000000-0000-0000-0000-0000000018c4'$q$, 'successor is itself');
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'm@x.test', end_reason = 'moved', replaced_by_assignment_id = gen_random_uuid() where id = '00000000-0000-0000-0000-0000000018c4'$q$, 'successor that does not exist');
select pg_temp.expect_denied($q$insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email, replaced_by_assignment_id) values ('00000000-0000-0000-0000-0000000018b1', 'cust-9', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test', '00000000-0000-0000-0000-0000000018c5')$q$, 'an ACTIVE row naming a successor');
select pg_temp.expect_denied($q$update customer_rep_assignments set replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c5' where id = '00000000-0000-0000-0000-0000000018c4'$q$, 'successor without ending');
update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'm@x.test', end_reason = 'moved', replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c5' where id = '00000000-0000-0000-0000-0000000018c4';
do $$ begin
  if (select replaced_by_assignment_id from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018c4') <> '00000000-0000-0000-0000-0000000018c5' then raise exception 'a valid successor is recorded'; end if;
end $$;
select pg_temp.expect_denied($q$update customer_rep_assignments set replaced_by_assignment_id = null where id = '00000000-0000-0000-0000-0000000018c4'$q$, 'erase the successor link');

-- the SAME Rep may be assigned again later: a NEW row, with the earlier period preserved
insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email)
values ('00000000-0000-0000-0000-0000000018b1', 'cust-1', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test');
do $$ begin
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'cust-1' and rep_user_id = '00000000-0000-0000-0000-0000000018a1') <> 2 then raise exception 'history keeps both periods'; end if;
end $$;

-- a successor must be ANOTHER Rep: the new (active) a1 row of cust-1 cannot name a1's own earlier, ended period as its successor
select pg_temp.expect_denied($q$update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = 'm@x.test', end_reason = 'moved', replaced_by_assignment_id = '00000000-0000-0000-0000-0000000018c1' where cin7_customer_id = 'cust-1' and rep_user_id = '00000000-0000-0000-0000-0000000018a1' and ended_at is null$q$, 'successor that is the same Rep');

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
  if not has_column_privilege('service_role', 'customer_rep_assignments', 'replaced_by_assignment_id', 'UPDATE') then raise exception 'service role records the successor when ending'; end if;
  if has_column_privilege('service_role', 'customer_rep_assignments', 'rep_user_id', 'UPDATE') or has_column_privilege('service_role', 'customer_rep_assignments', 'cin7_customer_id', 'UPDATE') then raise exception 'identity columns are not updatable'; end if;
end $$;

-- ══ ATOMIC REASSIGNMENT: customer_rep_reassign ═══════════════════════════════
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('role', 'service_role', true); end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000018a4'), ('00000000-0000-0000-0000-0000000018a5');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000018b1', '00000000-0000-0000-0000-0000000018a4', 'member'),
  ('00000000-0000-0000-0000-0000000018b1', '00000000-0000-0000-0000-0000000018a5', 'member');

-- Fixture: customer r1 has TWO active Reps (a1, a2); customer r2 has one (a1); customer r3 has a1 and a4.
insert into customer_rep_assignments (id, org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values
  ('00000000-0000-0000-0000-0000000018d1', '00000000-0000-0000-0000-0000000018b1', 'r1', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test'),
  ('00000000-0000-0000-0000-0000000018d2', '00000000-0000-0000-0000-0000000018b1', 'r1', '00000000-0000-0000-0000-0000000018a2', 'rep2@x.test', 'mgr@x.test'),
  ('00000000-0000-0000-0000-0000000018d3', '00000000-0000-0000-0000-0000000018b1', 'r2', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test'),
  ('00000000-0000-0000-0000-0000000018d4', '00000000-0000-0000-0000-0000000018b1', 'r3', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test'),
  ('00000000-0000-0000-0000-0000000018d5', '00000000-0000-0000-0000-0000000018b1', 'r3', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'mgr@x.test');

-- privileges: executable by service_role ONLY
do $$ begin
  if not has_function_privilege('service_role', 'customer_rep_reassign(uuid,text,text,uuid,uuid,text,text,text,text)', 'EXECUTE') then raise exception 'service_role runs the reassignment'; end if;
  if has_function_privilege('authenticated', 'customer_rep_reassign(uuid,text,text,uuid,uuid,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'customer_rep_reassign(uuid,text,text,uuid,uuid,text,text,text,text)', 'EXECUTE') then raise exception 'clients must not execute the reassignment'; end if;
  if (select prosecdef from pg_proc where proname = 'customer_rep_reassign') then raise exception 'the function must be SECURITY INVOKER (widens nothing)'; end if;
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000018a1');
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r2', 'Farm', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'rep1@x.test', null, 'self service')$q$, 'a member calling the reassignment through the database API');
select pg_temp.reset_role();

-- SUCCESS (run AS service_role, with only its narrow grants): ends ONLY a1's assignment of r1, creates a4's; a2's assignment is untouched
select pg_temp.as_service();
select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r1', 'Farm R1', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'Rep4@X.test', 'mgr@x.test', 'owner@x.test', 'territory change');
select pg_temp.reset_role();
do $$
declare e record; n record; o record;
begin
  select * into e from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d1';
  if e.ended_at is null or e.ended_by_email <> 'mgr@x.test' or e.end_reason <> 'territory change' then raise exception 'the intended assignment is ended with actor and reason'; end if;
  select * into n from customer_rep_assignments where org_id = '00000000-0000-0000-0000-0000000018b1' and cin7_customer_id = 'r1' and rep_user_id = '00000000-0000-0000-0000-0000000018a4' and ended_at is null;
  if not found then raise exception 'the replacement assignment exists and is active'; end if;
  if e.replaced_by_assignment_id is distinct from n.id then raise exception 'P1: the ended row records the exact NEW replacement assignment'; end if;
  if n.replaced_by_assignment_id is not null then raise exception 'the replacement itself names no successor'; end if;
  if n.rep_email <> 'rep4@x.test' or n.assigned_by_email <> 'mgr@x.test' or n.assigned_by_owner_email <> 'owner@x.test' or n.assigned_reason <> 'territory change' or n.customer_name <> 'Farm R1' then raise exception 'the replacement carries the audit fields'; end if;
  select * into o from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d2';
  if o.ended_at is not null or o.end_reason is not null or o.replaced_by_assignment_id is not null then raise exception 'an unrelated active Rep assignment must be untouched'; end if;
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r1') <> 3 then raise exception 'history: old (ended) + other Rep + replacement'; end if;
end $$;

-- REPLAY: the identical request again is refused (the old assignment is already ended) and creates NO duplicate
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r1', 'Farm R1', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'mgr@x.test', null, 'territory change')$q$, 'replayed reassignment');
do $$ begin
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r1' and ended_at is null) <> 2 then raise exception 'a replay must not change the active set (a2, a4)'; end if;
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r1') <> 3 then raise exception 'a replay must not add history rows'; end if;
  if (select replaced_by_assignment_id from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d1') is distinct from (select id from customer_rep_assignments where cin7_customer_id = 'r1' and rep_user_id = '00000000-0000-0000-0000-0000000018a4') then raise exception 'a replay must not change the recorded successor'; end if;
end $$;

-- ALREADY-ASSIGNED TARGET (several Reps per customer): r3 has a1 and a4; moving a1 -> a4 ends a1 and creates NOTHING (no duplicate active row)
do $$ declare r jsonb; begin
  r := customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r3', 'Farm R3', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'mgr@x.test', null, 'consolidating Reps');
  if (r->>'created')::boolean then raise exception 'must report created = false'; end if;
  if (r->'assigned'->>'id') <> '00000000-0000-0000-0000-0000000018d5' then raise exception 'must return the existing active assignment'; end if;
end $$;
do $$ begin
  if (select replaced_by_assignment_id from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d4') is distinct from '00000000-0000-0000-0000-0000000018d5'::uuid then raise exception 'P1: the ended row records the EXISTING target assignment as its successor'; end if;
  if (select replaced_by_assignment_id from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d5') is not null then raise exception 'the existing target row is not modified'; end if;
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r3' and ended_at is null) <> 1 then raise exception 'exactly one active Rep remains on r3'; end if;
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r3') <> 2 then raise exception 'no extra row was created'; end if;
end $$;

-- ATOMICITY: the replacement INSERT fails (rep_email check) AFTER the old assignment was updated inside the function: the WHOLE call rolls back, the old assignment stays active
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r2', 'Farm R2', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'x', 'mgr@x.test', null, 'will fail at insert')$q$, 'replacement insert failure');
do $$ begin
  if (select ended_at from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d3') is not null then raise exception 'ATOMICITY: the previous assignment must still be active after a failed reassignment'; end if;
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r2') <> 1 then raise exception 'ATOMICITY: no row may be added by a failed reassignment'; end if;
  if (select end_reason from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d3') is not null or (select replaced_by_assignment_id from customer_rep_assignments where id = '00000000-0000-0000-0000-0000000018d3') is not null then raise exception 'ATOMICITY: no end reason or successor link may survive a failed reassignment'; end if;
end $$;

-- the new Rep must belong to THIS organisation; nothing changes
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r2', 'Farm R2', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a3', 'rep3@x.test', 'mgr@x.test', null, 'target is in another org')$q$, 'a Rep from another organisation');
-- cross-organisation: org B cannot reassign org A's customer assignment, even naming its Rep
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b2', 'r2', 'Farm R2', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a3', 'rep3@x.test', 'mgr@x.test', null, 'cross organisation')$q$, 'cross-organisation reassignment');
-- input validation
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r2', 'Farm R2', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a1', 'rep1@x.test', 'mgr@x.test', null, 'same Rep')$q$, 'from = to');
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r2', 'Farm R2', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'mgr@x.test', null, 'x')$q$, 'trivial reason');
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', 'r2', 'Farm R2', '00000000-0000-0000-0000-0000000018a2', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'mgr@x.test', null, 'a2 is not assigned to r2')$q$, 'from-Rep not assigned to the customer');
select pg_temp.expect_denied($q$select customer_rep_reassign('00000000-0000-0000-0000-0000000018b1', '  ', 'Farm', '00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-0000000018a4', 'rep4@x.test', 'mgr@x.test', null, 'blank customer')$q$, 'blank customer');
do $$ begin
  if (select count(*) from customer_rep_assignments where cin7_customer_id = 'r2' and ended_at is null) <> 1 or (select count(*) from customer_rep_assignments where cin7_customer_id = 'r2') <> 1 then raise exception 'every refused reassignment leaves r2 exactly as it was'; end if;
end $$;

-- existing tables are untouched: this migration adds no policy anywhere else
do $$ begin
  if (select count(*) from pg_policies where tablename = 'customer_rep_assignments') <> 0 then raise exception 'no policy on the new table'; end if;
end $$;

select 'OK: 0118 customer rep assignments (incl. atomic reassignment)' as result;
rollback;
