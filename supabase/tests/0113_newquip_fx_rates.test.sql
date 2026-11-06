-- Transactional test for migration 0113 (exchange-rate snapshots). BEGIN/ROLLBACK - leaves no rows.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000013a1'), ('00000000-0000-0000-0000-0000000013a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000013b1', 'FX Org A'), ('00000000-0000-0000-0000-0000000013b2', 'FX Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000013b1', '00000000-0000-0000-0000-0000000013a1', 'member'), ('00000000-0000-0000-0000-0000000013b2', '00000000-0000-0000-0000-0000000013a2', 'member');

insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values
  ('00000000-0000-0000-0000-0000000013b1', 'USD', 17.5, 'SARB fixing 30 Oct', now() - interval '2 hours', 'est@x'),
  ('00000000-0000-0000-0000-0000000013b1', 'USD', 17.6, 'SARB fixing 30 Oct pm', now() - interval '1 hour', 'est@x'),
  ('00000000-0000-0000-0000-0000000013b2', 'EUR', 19.1, 'ECB reference', now(), 'x@y');
do $$ begin
  if (select rate from newquip_fx_rates where org_id = '00000000-0000-0000-0000-0000000013b1' order by as_of desc, created_at desc limit 1) <> 17.6 then raise exception 'newest effective rate is current'; end if;
  if (select count(*) from newquip_fx_rates where org_id = '00000000-0000-0000-0000-0000000013b1') <> 2 then raise exception 'every snapshot is kept'; end if;
end $$;

select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','ZAR',1,'self',now() - interval '1 hour','x')$q$, 'ZAR cannot have a rate');
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','usd',17,'lower case',now() - interval '1 hour','x')$q$, 'ISO code must be upper case');
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','US',17,'two letters',now() - interval '1 hour','x')$q$, 'ISO code is three letters');
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','USD',0,'zero',now() - interval '1 hour','x')$q$, 'rate must be positive');
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','USD',-1,'negative',now() - interval '1 hour','x')$q$, 'rate must be positive (negative)');
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','USD',17,' ',now() - interval '1 hour','x')$q$, 'a source is required');
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','USD',17,'future', now() + interval '3 days','x')$q$, 'a rate cannot be effective in the future');
select pg_temp.expect_denied($q$update newquip_fx_rates set rate = 1$q$, 'rates are never updated');
select pg_temp.expect_denied($q$delete from newquip_fx_rates$q$, 'rates are never deleted');

select pg_temp.act_as('00000000-0000-0000-0000-0000000013a1');
do $$ begin
  if (select count(*) from newquip_fx_rates) <> 2 then raise exception 'a member sees only their own organisation rates'; end if;
end $$;
select pg_temp.expect_denied($q$insert into newquip_fx_rates (org_id, currency, rate, source, as_of, entered_by_email) values ('00000000-0000-0000-0000-0000000013b1','USD',1,'client',now() - interval '1 hour','x')$q$, 'client insert');
select pg_temp.reset_role();
select 'OK: 0113 fx rates' as result;
rollback;
