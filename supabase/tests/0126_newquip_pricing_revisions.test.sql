-- Transactional test for migration 0126 (immutable Estimator pricing revisions + the atomic apply function). BEGIN/ROLLBACK - leaves no rows.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000126a1');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000126b1', 'PR Org A'), ('00000000-0000-0000-0000-0000000126b2', 'PR Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126a1', 'member');
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values
  ('00000000-0000-0000-0000-0000000126c1', '00000000-0000-0000-0000-0000000126b1', 'PR-1', '{"estimator":{}}', 'h1'),
  ('00000000-0000-0000-0000-0000000126c2', '00000000-0000-0000-0000-0000000126b1', 'PR-2', '{"estimator":{}}', 'h2');
-- PR-1 is in estimator review with a recorded sign-off (a quotation is always created as REP_DRAFT)
update newquip_quotes set state = 'ESTIMATOR_REVIEW', customer_confirmed_cents = 100000, customer_confirmed_by = 'Farmer', customer_confirmed_at = now(), handoff_by_email = 'rep@x' where quote_ref = 'PR-1';
update newquip_quotes set estimator_signoff_hash = 'h1', estimator_signoff_by_email = 'est@x', estimator_signoff_at = now() where quote_ref = 'PR-1';

create or replace function pg_temp.apply_rev(p_org uuid, p_quote uuid, p_seq integer, p_hash text, p_new_hash text, p_kind text default 'ENABLED', p_reason text default 'Initial supplier pricing') returns uuid language sql as $$
  select newquip_apply_pricing_revision(p_org, p_quote, p_seq, p_hash,
    '{"estimator":{"pricing":{"revision":1,"secret":"cost"}}}'::jsonb, p_new_hash, p_kind, p_reason, 'legacy-poc-v1',
    case when p_kind = 'ENABLED' then null else '{"revision":1}'::jsonb end,
    case when p_kind = 'DISABLED' then null else '{"revision":2,"secret":"cost"}'::jsonb end,
    '[{"path":"skus.X.nativeUnitCostMicro","previous":1,"new":2}]'::jsonb, repeat('a', 64), 'est@x')
$$;

-- 1. happy path: ONE call stores the revision AND writes the draft, and withdraws the Estimator sign-off
select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 0, 'h1', 'h1b');
do $$ begin
  if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> 1 then raise exception 'exactly one revision expected'; end if;
  if (select seq from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> 1 then raise exception 'first revision must be seq 1'; end if;
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-1') <> 'h1b' then raise exception 'draft hash must be the new one'; end if;
  if (select draft -> 'estimator' -> 'pricing' ->> 'secret' from newquip_quotes where quote_ref = 'PR-1') <> 'cost' then raise exception 'the new draft must be stored'; end if;
  if (select estimator_signoff_hash from newquip_quotes where quote_ref = 'PR-1') is not null then raise exception 'sign-off must be withdrawn'; end if;
  if (select quote_revision from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> 1 then raise exception 'revision must come from the quotation'; end if;
end $$;

-- 2. a stale draft hash, a stale sequence (double submit) and another organisation change NOTHING
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 0, 'h1b', 'h1c', 'CHANGED')$q$, 'stale sequence');
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'STALE', 'x')$q$, 'stale draft hash');
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b2', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', 'x')$q$, 'cross-organisation');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-2') <> 'h2' then raise exception 'a refused change must leave the quotation untouched'; end if;
  if (select count(*) from newquip_pricing_revisions) <> 1 then raise exception 'a refused change must store no revision'; end if;
end $$;

-- 3. ATOMIC: a reason that violates the CHECK after the lock rolls the whole call back, the draft write included
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', 'h2b', 'ENABLED', 'x')$q$, 'reason too short');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-2') <> 'h2' then raise exception 'ATOMICITY: the draft changed although the revision could not be stored'; end if;
end $$;

-- 4. kinds are consistent with their values; a second revision is seq 2 and the first is kept
select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 1, 'h1b', 'h1c', 'CHANGED', 'Forward cover booked');
do $$ begin
  if (select array_agg(seq order by seq) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> array[1, 2] then raise exception 'seq must be 1 then 2'; end if;
end $$;
-- a kind that contradicts its values (ENABLED with a previous pricing) violates the table CHECK and changes nothing
select pg_temp.expect_denied($q$select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 2, 'h1c', '{"estimator":{}}'::jsonb, 'h1d', 'ENABLED', 'Bad kind', 'legacy-poc-v1', '{"revision":1}'::jsonb, '{"revision":2}'::jsonb, '[]'::jsonb, repeat('a', 64), 'est@x')$q$, 'kind/values mismatch');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-1') <> 'h1c' then raise exception 'ATOMICITY: a rejected revision changed the draft'; end if;
end $$;

-- 5. append-only: no update, no delete
select pg_temp.expect_denied($q$update newquip_pricing_revisions set reason = 'edited reason'$q$, 'revision update');
select pg_temp.expect_denied($q$update newquip_pricing_revisions set new_pricing = '{}'$q$, 'revision rewrite');
select pg_temp.expect_denied($q$delete from newquip_pricing_revisions$q$, 'revision delete');

-- 6. CONFIDENTIAL (an APPROVED quotation is refused by the function and proved at application level, where its CHECKed baseline can be built): a member of the owning organisation can read nothing and cannot call the function or write
select pg_temp.act_as('00000000-0000-0000-0000-0000000126a1');
select pg_temp.expect_denied($q$select count(*) from newquip_pricing_revisions$q$, 'member select');
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 2, 'h1c', 'h1d', 'CHANGED')$q$, 'member calling the function');
select pg_temp.expect_denied($q$delete from newquip_pricing_revisions$q$, 'member delete');
select pg_temp.expect_denied($q$truncate newquip_pricing_revisions$q$, 'member truncate');
select pg_temp.reset_role();

do $$ begin
  if not (has_table_privilege('service_role', 'newquip_pricing_revisions', 'SELECT') and has_table_privilege('service_role', 'newquip_pricing_revisions', 'INSERT')) then raise exception 'service_role must be able to read and insert revisions'; end if;
  if has_table_privilege('service_role', 'newquip_pricing_revisions', 'UPDATE') or has_table_privilege('service_role', 'newquip_pricing_revisions', 'DELETE')
     or has_table_privilege('service_role', 'newquip_pricing_revisions', 'TRUNCATE') then raise exception 'service_role must NOT hold UPDATE / DELETE / TRUNCATE'; end if;
  if has_table_privilege('authenticated', 'newquip_pricing_revisions', 'SELECT') or has_table_privilege('anon', 'newquip_pricing_revisions', 'SELECT') then raise exception 'members and anon must have no privilege'; end if;
end $$;

-- 7. deleting the organisation (the cascade) is the ONLY way rows go
delete from newquip_quotes where quote_ref in ('PR-1', 'PR-2');
delete from organizations where id = '00000000-0000-0000-0000-0000000126b1';
do $$ begin
  if exists (select 1 from newquip_pricing_revisions) then raise exception 'organisation deletion must cascade to its revisions'; end if;
end $$;

rollback;
