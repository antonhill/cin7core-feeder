-- Transactional test for migration 0102 (NewQuip quotes + Project variations). BEGIN/ROLLBACK — leaves no rows.
-- Covers: RLS (member read / cross-org denial / no member writes), quote state machine, frozen accepted baseline,
-- one-time project link, variation lifecycle (decisions final, amount frozen, ACTIVE project only), and that the
-- ORIGINAL contract value is immutable once a project is active. Expect it to print "ALL 0102 ... PASSED".
begin;

grant select, insert, update, delete on newquip_quotes, project_variations to authenticated, anon;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
-- RLS with no UPDATE/DELETE policy filters the rows out: the statement succeeds but touches ZERO rows (it does not raise).
-- Passes if the statement raises OR changes nothing; fails only if it actually changed a row.
create or replace function pg_temp.expect_no_rows_changed(sql text, label text) returns void language plpgsql as $$
declare n bigint;
begin
  begin execute sql; get diagnostics n = row_count; exception when others then return; end;
  if n > 0 then raise exception 'EXPECTED NO ROWS CHANGED but % row(s) changed: %', n, label; end if;
end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000001a1'), ('00000000-0000-0000-0000-0000000001a2');
insert into organizations (id, name) values
  ('00000000-0000-0000-0000-0000000001b1', 'NQ Org A'),
  ('00000000-0000-0000-0000-0000000001b2', 'NQ Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000001a1', 'member'),
  ('00000000-0000-0000-0000-0000000001b2', '00000000-0000-0000-0000-0000000001a2', 'member');

insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000001c1', '00000000-0000-0000-0000-0000000001b1', 'P-1', 'Golden', 'Cust', 1000000000, 1500, 'DRAFT');
insert into project_stages (org_id, project_id, sort_order, name, value_cents)
values ('00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000001c1', 1, 'All', 1000000000);

-- original contract may be corrected while DRAFT, then is immutable once ACTIVE
update projects set original_contract_cents = 1000000000 where id = '00000000-0000-0000-0000-0000000001c1';
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000001c1';
select pg_temp.expect_denied($q$update projects set original_contract_cents = 1048000000 where id = '00000000-0000-0000-0000-0000000001c1'$q$, 'change original contract on an ACTIVE project');

-- ── quotes: created as REP_DRAFT only; state machine ─────────────────────────
select pg_temp.expect_denied($q$insert into newquip_quotes (org_id, quote_ref, state) values ('00000000-0000-0000-0000-0000000001b1', 'Q-0', 'ESTIMATOR_REVIEW')$q$, 'create quote past REP_DRAFT');
insert into newquip_quotes (id, org_id, quote_ref, customer_name, site_name, draft, draft_hash)
values ('00000000-0000-0000-0000-0000000001d1', '00000000-0000-0000-0000-0000000001b1', 'Q-1', 'Cust', 'Site', '{"a":1}', 'h1');
select pg_temp.expect_denied($q$update newquip_quotes set state = 'MANAGER_APPROVED_FINAL' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'skip estimator review');
update newquip_quotes set state = 'ESTIMATOR_REVIEW', customer_confirmed_cents = 5000000, customer_confirmed_by = 'Farmer', customer_confirmed_at = now(), handoff_by_email = 'rep@x'
  where id = '00000000-0000-0000-0000-0000000001d1';
select pg_temp.expect_denied($q$update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', approved_by_email = 'm@x', approved_at = now(), accepted_baseline = '{}', baseline_hash = 'b', contract_cents = 5000000
  where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'approve without estimator sign-off');
select pg_temp.expect_denied($q$update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', approved_by_email = 'm@x', approved_at = now(), accepted_baseline = '{}', baseline_hash = 'b', contract_cents = 4000000,
  estimator_signoff_hash = 'h1' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'approve when contract differs from the customer-confirmed amount');
select pg_temp.expect_denied($q$update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', approved_by_email = 'm@x', approved_at = now(), accepted_baseline = '{}', baseline_hash = 'b', contract_cents = 5000000,
  estimator_signoff_hash = 'stale' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'approve a draft that changed after sign-off');
select pg_temp.expect_denied($q$update newquip_quotes set project_id = '00000000-0000-0000-0000-0000000001c1' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'project link before acceptance');
update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', approved_by_email = 'm@x', approved_at = now(), accepted_baseline = '{"total":5000000}', baseline_hash = 'b', contract_cents = 5000000,
  estimator_signoff_hash = 'h1', estimator_signoff_by_email = 'e@x', estimator_signoff_at = now() where id = '00000000-0000-0000-0000-0000000001d1';

-- ── frozen accepted baseline ─────────────────────────────────────────────────
select pg_temp.expect_denied($q$update newquip_quotes set accepted_baseline = '{"total":1}' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'mutate accepted baseline');
select pg_temp.expect_denied($q$update newquip_quotes set draft = '{"a":2}' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'mutate draft of an accepted quote');
select pg_temp.expect_denied($q$update newquip_quotes set contract_cents = 1 where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'mutate contract value');
select pg_temp.expect_denied($q$update newquip_quotes set state = 'REP_DRAFT' where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'reopen an accepted quote');
select pg_temp.expect_denied($q$delete from newquip_quotes where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'delete an accepted quote');
update newquip_quotes set project_id = '00000000-0000-0000-0000-0000000001c1' where id = '00000000-0000-0000-0000-0000000001d1';
select pg_temp.expect_denied($q$update newquip_quotes set project_id = null where id = '00000000-0000-0000-0000-0000000001d1'$q$, 'unlink the project');

-- ── variations ───────────────────────────────────────────────────────────────
select pg_temp.expect_denied($q$insert into project_variations (org_id, project_id, code, title, amount_cents, status, raised_by_email, decided_by_email, decided_at)
  values ('00000000-0000-0000-0000-0000000001b1','00000000-0000-0000-0000-0000000001c1','V001','x',100,'APPROVED','e@x','m@x',now())$q$, 'create an already-approved variation');
select pg_temp.expect_denied($q$insert into project_variations (org_id, project_id, code, title, amount_cents, raised_by_email) values ('00000000-0000-0000-0000-0000000001b1','00000000-0000-0000-0000-0000000001c1','V001','x',0,'e@x')$q$, 'zero-value variation');
insert into project_variations (id, org_id, project_id, code, title, amount_cents, raised_by_email, priced_by_email)
values ('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001b1', '00000000-0000-0000-0000-0000000001c1', 'V001', 'Additional Ventilation', 48000000, 'e@x', 'e@x');
update project_variations set amount_cents = 48000000 where id = '00000000-0000-0000-0000-0000000001e1';
select pg_temp.expect_denied($q$update project_variations set status = 'APPROVED', amount_cents = 1, decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000001e1'$q$, 'decide at a different amount');
select pg_temp.expect_denied($q$update project_variations set status = 'REJECTED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000001e1'$q$, 'reject without a reason');
update project_variations set status = 'APPROVED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000001e1';
select pg_temp.expect_denied($q$update project_variations set status = 'REJECTED', decision_reason = 'changed mind', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000001e1'$q$, 'reverse an approved variation');
select pg_temp.expect_denied($q$update project_variations set amount_cents = 1 where id = '00000000-0000-0000-0000-0000000001e1'$q$, 're-price an approved variation');
select pg_temp.expect_denied($q$delete from project_variations where id = '00000000-0000-0000-0000-0000000001e1'$q$, 'delete a variation');
do $$ begin
  if (select original_contract_cents from projects where id = '00000000-0000-0000-0000-0000000001c1') <> 1000000000 then raise exception 'original contract moved'; end if;
  if (select sum(amount_cents) from project_variations where project_id = '00000000-0000-0000-0000-0000000001c1' and status = 'APPROVED') <> 48000000 then raise exception 'approved variation sum wrong'; end if;
end $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a1');
do $$ begin
  if (select count(*) from newquip_quotes) <> 1 then raise exception 'member A should see its own quote'; end if;
  if (select count(*) from project_variations) <> 1 then raise exception 'member A should see its variation'; end if;
end $$;
select pg_temp.expect_denied($q$insert into newquip_quotes (org_id, quote_ref) values ('00000000-0000-0000-0000-0000000001b1', 'Q-X')$q$, 'member insert quote');
select pg_temp.expect_no_rows_changed($q$update project_variations set title = 'y'$q$, 'member update variation');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000001a2');
do $$ begin
  if (select count(*) from newquip_quotes) <> 0 then raise exception 'org B must not see org A quotes'; end if;
  if (select count(*) from project_variations) <> 0 then raise exception 'org B must not see org A variations'; end if;
end $$;
select pg_temp.reset_role();

select 'ALL 0102 NEWQUIP QUOTES + VARIATIONS TESTS PASSED' as result;
rollback;
