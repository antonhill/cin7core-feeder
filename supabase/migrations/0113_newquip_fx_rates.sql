-- NewQuip exchange-rate snapshots (additive; applies after 0112). NOT applied to hosted Supabase.
--
-- Supplier prices in Cin7 are held in the SUPPLIER'S currency. To compare suppliers and to estimate in rand, an authorised user records a dated exchange-rate
-- snapshot (ZAR per 1 unit of a foreign currency, with its source and effective time). Every snapshot is kept; the newest effective one is "current". The rate
-- actually used by a quotation is COPIED into that quotation's frozen cost estimate, so a later snapshot never changes an approved quotation. Append-only.
-- Nothing here calls Cin7 or an exchange-rate provider, and no existing row is modified.

create table if not exists newquip_fx_rates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  currency    text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'ZAR'),
  -- ZAR per 1 unit of `currency`, at most 6 decimals, strictly positive
  rate        numeric(18, 6) not null check (rate > 0),
  source      text not null check (length(btrim(source)) >= 3),
  as_of       timestamptz not null,
  entered_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  check (as_of <= created_at + interval '5 minutes')
);
create index if not exists newquip_fx_rates_lookup_idx on newquip_fx_rates (org_id, currency, as_of desc, created_at desc);

create or replace function newquip_fx_rates_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_fx_rates: rates are an audit record and are never updated or deleted'; end if;
  return old; -- cascade from a deleted organization
end;
$$;
create trigger newquip_fx_rates_guard_trg before update or delete on newquip_fx_rates for each row execute function newquip_fx_rates_guard();

alter table newquip_fx_rates enable row level security;
create policy "org members read newquip_fx_rates" on newquip_fx_rates for select using (is_org_member(org_id));
-- All writes go through the service role (server actions); no insert/update/delete policies are granted.
revoke all on newquip_fx_rates from anon, authenticated;
grant select on newquip_fx_rates to authenticated;
revoke all on function newquip_fx_rates_guard() from public, anon, authenticated;
