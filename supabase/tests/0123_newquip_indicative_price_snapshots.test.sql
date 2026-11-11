-- Transactional test for migration 0123 (immutable indicative price snapshots + the atomic handoff function). BEGIN/ROLLBACK - leaves no rows.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000123a1');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000123b1', 'IP Org A'), ('00000000-0000-0000-0000-0000000123b2', 'IP Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123a1', 'member');
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values
  ('00000000-0000-0000-0000-0000000123c1', '00000000-0000-0000-0000-0000000123b1', 'IP-1', '{}', 'h1'),
  ('00000000-0000-0000-0000-0000000123c2', '00000000-0000-0000-0000-0000000123b1', 'IP-2', '{}', 'h2');

create or replace function pg_temp.handoff(p_org uuid, p_quote uuid, p_hash text, p_completeness text default 'complete') returns uuid language sql as $$
  select newquip_handoff_with_snapshot(p_org, p_quote, p_hash, 100000, 'Farmer Joe', 'rep@x',
    '{"customerSafe":{"totalCents":100000},"internal":{"cost":"secret"}}'::jsonb, repeat('a', 64), 100000, p_completeness,
    'newquip-grower-pricing', 'v1', 'newquip_master_workbook_snapshot', 'Master 05 Oct 2026', 'rep@x')
$$;

-- 1. happy path: ONE call stores the snapshot AND moves the quotation
select pg_temp.handoff('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c1', 'h1');
do $$ begin
  if (select state from newquip_quotes where quote_ref = 'IP-1') <> 'ESTIMATOR_REVIEW' then raise exception 'handoff must move the quotation to ESTIMATOR_REVIEW'; end if;
  if (select customer_confirmed_cents from newquip_quotes where quote_ref = 'IP-1') <> 100000 then raise exception 'confirmed amount lost'; end if;
  if (select count(*) from newquip_indicative_price_snapshots where quote_id = '00000000-0000-0000-0000-0000000123c1') <> 1 then raise exception 'exactly one snapshot expected'; end if;
  if (select seq from newquip_indicative_price_snapshots where quote_id = '00000000-0000-0000-0000-0000000123c1') <> 1 then raise exception 'first snapshot must be seq 1'; end if;
  if (select revision from newquip_indicative_price_snapshots where quote_id = '00000000-0000-0000-0000-0000000123c1') <> 1 then raise exception 'revision must come from the quotation'; end if;
end $$;

-- 2. a second call (double submit) or a stale draft hash changes NOTHING
select pg_temp.expect_denied($q$select pg_temp.handoff('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c1', 'h1')$q$, 'double handoff');
select pg_temp.expect_denied($q$select pg_temp.handoff('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c2', 'STALE')$q$, 'stale draft hash');
do $$ begin
  if (select state from newquip_quotes where quote_ref = 'IP-2') <> 'REP_DRAFT' then raise exception 'a refused handoff must leave the quotation untouched'; end if;
  if (select count(*) from newquip_indicative_price_snapshots) <> 1 then raise exception 'a refused handoff must store no snapshot'; end if;
end $$;
-- another organisation cannot hand off this quotation
select pg_temp.expect_denied($q$select pg_temp.handoff('00000000-0000-0000-0000-0000000123b2', '00000000-0000-0000-0000-0000000123c2', 'h2')$q$, 'cross-organisation handoff');

-- 3. ATOMIC: a failure after the snapshot insert point (invalid completeness violates the table CHECK) rolls the whole call back, state change included
select pg_temp.expect_denied($q$select pg_temp.handoff('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c2', 'h2', 'bogus')$q$, 'invalid snapshot');
do $$ begin
  if (select state from newquip_quotes where quote_ref = 'IP-2') <> 'REP_DRAFT' then raise exception 'ATOMICITY: the quotation moved although the snapshot could not be stored'; end if;
  if (select count(*) from newquip_indicative_price_snapshots where quote_id = '00000000-0000-0000-0000-0000000123c2') <> 0 then raise exception 'ATOMICITY: a snapshot exists for a handoff that failed'; end if;
end $$;

-- 4. append-only: no update, no delete (even by the table owner / service path)
select pg_temp.expect_denied($q$update newquip_indicative_price_snapshots set total_ex_vat_cents = 1$q$, 'snapshot update');
select pg_temp.expect_denied($q$update newquip_indicative_price_snapshots set snapshot = '{}'$q$, 'snapshot rewrite');
select pg_temp.expect_denied($q$delete from newquip_indicative_price_snapshots$q$, 'snapshot delete');
-- a snapshot cannot be inserted directly for a quotation that is not editable, nor for another organisation's quotation
select pg_temp.expect_denied($q$insert into newquip_indicative_price_snapshots (org_id, quote_id, seq, revision, draft_hash, ruleset_id, ruleset_version, price_source_id, price_source_fingerprint, total_ex_vat_cents, completeness, snapshot, snapshot_hash, captured_by_email)
  values ('00000000-0000-0000-0000-0000000123b2', '00000000-0000-0000-0000-0000000123c1', 9, 1, 'h', 'r', 'v', 's', 'f', 1, 'complete', '{}', repeat('b', 64), 'x@x')$q$, 'cross-organisation insert');

-- 5. a returned quotation is handed off again: seq 2, and the first snapshot is kept
update newquip_quotes set state = 'REP_DRAFT', revision = 2, customer_confirmed_cents = null, customer_confirmed_by = null, customer_confirmed_at = null, handoff_by_email = null where quote_ref = 'IP-1';
select pg_temp.handoff('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c1', 'h1');
do $$ begin
  if (select array_agg(seq order by seq) from newquip_indicative_price_snapshots where quote_id = '00000000-0000-0000-0000-0000000123c1') <> array[1, 2] then raise exception 'seq must be 1 then 2'; end if;
  if (select revision from newquip_indicative_price_snapshots where quote_id = '00000000-0000-0000-0000-0000000123c1' and seq = 2) <> 2 then raise exception 'second snapshot must carry revision 2'; end if;
end $$;

-- 6. CONFIDENTIAL: a member of the owning organisation can read NOTHING from this table and cannot call the function or write to it
select pg_temp.act_as('00000000-0000-0000-0000-0000000123a1');
select pg_temp.expect_denied($q$select count(*) from newquip_indicative_price_snapshots$q$, 'member select (no privilege, no policy)');
select pg_temp.expect_denied($q$insert into newquip_indicative_price_snapshots (org_id, quote_id, seq, revision, draft_hash, ruleset_id, ruleset_version, price_source_id, price_source_fingerprint, total_ex_vat_cents, completeness, snapshot, snapshot_hash, captured_by_email)
  values ('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c2', 1, 1, 'h', 'r', 'v', 's', 'f', 1, 'complete', '{}', repeat('b', 64), 'x@x')$q$, 'member insert');
select pg_temp.expect_denied($q$select pg_temp.handoff('00000000-0000-0000-0000-0000000123b1', '00000000-0000-0000-0000-0000000123c2', 'h2')$q$, 'member calling the handoff function');
select pg_temp.expect_denied($q$delete from newquip_indicative_price_snapshots$q$, 'member delete');
select pg_temp.expect_denied($q$truncate newquip_indicative_price_snapshots$q$, 'member truncate');
select pg_temp.reset_role();

-- 7. deleting the organisation (the cascade) is the ONLY way rows go
delete from newquip_quotes where quote_ref = 'IP-2';
delete from organizations where id = '00000000-0000-0000-0000-0000000123b1';
do $$ begin
  if exists (select 1 from newquip_indicative_price_snapshots) then raise exception 'organisation deletion must cascade to its snapshots'; end if;
end $$;

rollback;
