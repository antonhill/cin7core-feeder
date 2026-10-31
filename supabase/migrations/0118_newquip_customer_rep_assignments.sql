-- NewQuip customer-to-Rep assignments (Slice 1A). NOT applied to hosted Supabase (owner approval required).
-- Additive only: one new table, one guard function and one trigger. No existing table, column, policy, grant or row is touched, and older application code ignores all of it.
--
--   customer_rep_assignments   which Rep may SEE a Cin7 customer's quotations. APPEND-ONLY history: ending an assignment records who/when/why and never deletes the row.
--
-- Rules the database enforces (the application mirrors them):
--   * MULTIPLE active Reps per customer are allowed; the same Rep cannot be actively assigned to the same customer twice (partial unique index).
--   * An assignment is created ACTIVE and can only ever transition once, active -> ended, with a reason. An ended assignment never changes again; re-assigning the same
--     Rep later is a NEW row, so the history shows every period of access.
--   * Rows are never deleted (except by the cascade of deleting the whole organisation).
--   * Cin7 stays the customer master: `cin7_customer_id` is the Cin7 customer ID as captured on quotation snapshots (newquip_quote_customers). Nothing is written to Cin7.
--
-- This slice deliberately changes NO existing RLS policy and activates NO strict functional roles. The new table has RLS ENABLED and NO policy for clients: the assignment list is
-- readable only through authorised server code (service role), never through the browser/database API. Visibility of quotations is derived in application code
-- (src/lib/newquip-assignments); the existing org-wide read policies on other tables are unchanged and are addressed by the separate Slice 1B plan.
-- Rollback / recovery: `drop table customer_rep_assignments cascade; drop function customer_rep_assignments_guard();` returns the schema to 0117.

create table if not exists customer_rep_assignments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  cin7_customer_id text not null check (length(btrim(cin7_customer_id)) > 0 and cin7_customer_id <> '(cleared)'),
  -- Display only (the name Cin7 held when the assignment was made); never used for matching.
  customer_name text not null default '',
  rep_user_id uuid not null,
  rep_email   text not null check (length(btrim(rep_email)) > 3),
  assigned_by_email text not null check (length(btrim(assigned_by_email)) > 3),
  assigned_by_owner_email text,
  assigned_reason text not null default '',
  assigned_at timestamptz not null default clock_timestamp(),
  ended_at    timestamptz,
  ended_by_email text,
  end_reason  text,
  -- an ended assignment says who ended it and why; an active one carries neither
  check ((ended_at is null) = (ended_by_email is null)),
  check ((ended_at is null) = (end_reason is null)),
  check (ended_at is null or length(btrim(end_reason)) >= 3),
  check (ended_at is null or ended_at >= assigned_at),
  unique (id, org_id)
);

-- One ACTIVE assignment per (customer, Rep); many Reps may be active on one customer.
create unique index if not exists customer_rep_assignments_active_uq on customer_rep_assignments (org_id, cin7_customer_id, rep_user_id) where ended_at is null;
-- "my customers" and "who can see this customer" lookups
create index if not exists customer_rep_assignments_rep_idx on customer_rep_assignments (org_id, rep_user_id) where ended_at is null;
create index if not exists customer_rep_assignments_customer_idx on customer_rep_assignments (org_id, cin7_customer_id, assigned_at desc);

-- ── guard: append-only history ──────────────────────────────────────────────
create or replace function customer_rep_assignments_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'customer_rep_assignments: assignment history is never deleted; end the assignment instead'; end if;
    return old; -- cascade from deleting the whole organisation
  end if;
  if tg_op = 'INSERT' then
    if new.ended_at is not null then raise exception 'customer_rep_assignments: an assignment is created active'; end if;
    return new;
  end if;
  -- UPDATE: the only permitted change is the one-way end of an active assignment
  if old.ended_at is not null then raise exception 'customer_rep_assignments: an ended assignment never changes'; end if;
  if (to_jsonb(new) - 'ended_at' - 'ended_by_email' - 'end_reason') is distinct from (to_jsonb(old) - 'ended_at' - 'ended_by_email' - 'end_reason') then
    raise exception 'customer_rep_assignments: only ending an assignment may change it';
  end if;
  if new.ended_at is null then raise exception 'customer_rep_assignments: an update must end the assignment'; end if;
  return new;
end;
$$;
drop trigger if exists customer_rep_assignments_guard_trg on customer_rep_assignments;
create trigger customer_rep_assignments_guard_trg before insert or update or delete on customer_rep_assignments for each row execute function customer_rep_assignments_guard();

-- ── access ──────────────────────────────────────────────────────────────────
-- RLS on, NO policy: the browser / database API (anon, authenticated) can read nothing here. Only authorised server code reads and writes.
alter table customer_rep_assignments enable row level security;

-- service_role is also reset (Supabase default privileges give it TRUNCATE / REFERENCES / TRIGGER) and then granted only what the Server Actions use.
revoke all on customer_rep_assignments from public, anon, authenticated, service_role;
grant select, insert on customer_rep_assignments to service_role;
grant update (ended_at, ended_by_email, end_reason) on customer_rep_assignments to service_role;   -- ending an assignment; every other column is immutable
revoke all on function customer_rep_assignments_guard() from public, anon, authenticated;
