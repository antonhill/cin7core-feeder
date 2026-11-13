-- Transactional test of supabase/rollback/0126_newquip_pricing_revisions_rollback.sql (BEGIN/ROLLBACK: nothing persists, the 0126 objects exist again afterwards for later tests).
-- Proves the rollback removes exactly the three 0126 objects, is idempotent, and leaves quotations, 0123 snapshots and the 0122/0127 posture untouched.
begin;

do $$
begin
  if to_regclass('public.newquip_pricing_revisions') is null then raise exception '0126 objects must exist before the rollback test'; end if;
  if (select count(*) from pg_proc where proname = 'newquip_apply_pricing_revision') <> 1 then raise exception 'apply function must exist before the rollback test'; end if;
end $$;

-- the rollback statements, verbatim from the rollback file
drop function if exists newquip_apply_pricing_revision(uuid, uuid, integer, text, jsonb, text, text, text, text, jsonb, jsonb, jsonb, text, text);
drop table if exists newquip_pricing_revisions;
drop function if exists newquip_pricing_revisions_guard();
-- idempotent: a second run raises nothing
drop function if exists newquip_apply_pricing_revision(uuid, uuid, integer, text, jsonb, text, text, text, text, jsonb, jsonb, jsonb, text, text);
drop table if exists newquip_pricing_revisions;
drop function if exists newquip_pricing_revisions_guard();

do $$
begin
  if to_regclass('public.newquip_pricing_revisions') is not null then raise exception 'rollback must drop newquip_pricing_revisions'; end if;
  if exists (select 1 from pg_proc where proname in ('newquip_apply_pricing_revision', 'newquip_pricing_revisions_guard')) then raise exception 'rollback must drop both 0126 functions'; end if;
  -- untouched neighbours
  if to_regclass('public.newquip_quotes') is null then raise exception 'newquip_quotes must be untouched'; end if;
  if to_regclass('public.newquip_indicative_price_snapshots') is null then raise exception '0123 snapshots table must be untouched'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'newquip_quotes') then raise exception '0122 posture must be untouched (no policy on newquip_quotes)'; end if;
  if has_table_privilege('authenticated', 'public.newquip_quotes', 'SELECT') or has_table_privilege('anon', 'public.newquip_quotes', 'SELECT') then raise exception '0122 posture must be untouched'; end if;
  if has_table_privilege('authenticated', 'public.products', 'SELECT') then raise exception '0127 posture must be untouched'; end if;
end $$;

select 'ALL 0126 ROLLBACK ASSERTIONS PASSED' as result;
rollback;
