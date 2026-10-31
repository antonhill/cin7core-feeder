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
-- REASSIGNMENT IS ATOMIC. `customer_rep_reassign(...)` ends ONE Rep's active assignment and creates the replacement in a SINGLE database transaction (one function call = one statement): if any
-- step fails - validation, the replacement insert, a constraint - the whole call rolls back and the previous assignment is exactly as it was. Concurrent changes to the same customer are
-- serialised by a per-customer advisory lock plus a row lock on the assignment being ended; only the intended Rep's row is ever touched, so other Reps assigned to the same customer are never
-- affected. The function is SECURITY INVOKER (it runs with service_role's own narrow privileges, so it widens nothing) and is executable by service_role only.
--
-- This slice deliberately changes NO existing RLS policy and activates NO strict functional roles. The new table has RLS ENABLED and NO policy for clients: the assignment list is
-- readable only through authorised server code (service role), never through the browser/database API. Visibility of quotations is derived in application code
-- (src/lib/newquip-assignments); the existing org-wide read policies on other tables are unchanged and are addressed by the separate Slice 1B plan.
-- Rollback / recovery: `drop function customer_rep_reassign(uuid, text, text, uuid, uuid, text, text, text, text); drop table customer_rep_assignments cascade; drop function customer_rep_assignments_guard();` returns the schema to 0117.

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
  -- Set ONLY by customer_rep_reassign, in the same statement that ends this row: the exact assignment that took over (a new row, or the target's already-active row). NULL for a plain end.
  replaced_by_assignment_id uuid,
  -- an ended assignment says who ended it and why; an active one carries neither
  check ((ended_at is null) = (ended_by_email is null)),
  check ((ended_at is null) = (end_reason is null)),
  check (ended_at is null or length(btrim(end_reason)) >= 3),
  check (ended_at is null or ended_at >= assigned_at),
  check (replaced_by_assignment_id is null or (ended_at is not null and replaced_by_assignment_id <> id)),
  unique (id, org_id),
  foreign key (replaced_by_assignment_id, org_id) references customer_rep_assignments (id, org_id)
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
  if (to_jsonb(new) - 'ended_at' - 'ended_by_email' - 'end_reason' - 'replaced_by_assignment_id') is distinct from (to_jsonb(old) - 'ended_at' - 'ended_by_email' - 'end_reason' - 'replaced_by_assignment_id') then
    raise exception 'customer_rep_assignments: only ending an assignment may change it';
  end if;
  if new.ended_at is null then raise exception 'customer_rep_assignments: an update must end the assignment'; end if;
  -- the successor must be ANOTHER Rep's assignment of the SAME customer in the SAME organisation
  if new.replaced_by_assignment_id is not null and not exists (
    select 1 from customer_rep_assignments t where t.id = new.replaced_by_assignment_id and t.org_id = new.org_id and t.cin7_customer_id = new.cin7_customer_id and t.rep_user_id <> new.rep_user_id
  ) then raise exception 'customer_rep_assignments: the replacing assignment must be another Rep''s assignment of the same customer'; end if;
  return new;
end;
$$;
drop trigger if exists customer_rep_assignments_guard_trg on customer_rep_assignments;
create trigger customer_rep_assignments_guard_trg before insert or update or delete on customer_rep_assignments for each row execute function customer_rep_assignments_guard();

-- ── atomic reassignment ─────────────────────────────────────────────────────
-- Ends p_from_user's ACTIVE assignment of the customer and gives p_to_user access, as ONE transaction; the ended row permanently records the exact successor (replaced_by_assignment_id). Returns {ended, assigned, created}. If p_to_user is ALREADY actively assigned
-- (several Reps per customer are allowed) the old assignment is ended and the existing one is returned (created = false): never a duplicate. Every raise below aborts the whole call.
create or replace function customer_rep_reassign(
  p_org uuid, p_customer text, p_customer_name text, p_from_user uuid, p_to_user uuid, p_to_email text, p_actor_email text, p_owner_email text, p_reason text
) returns jsonb language plpgsql set search_path = public as $$
declare
  v_customer text := btrim(coalesce(p_customer, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_from customer_rep_assignments%rowtype;
  v_ended customer_rep_assignments%rowtype;
  v_new customer_rep_assignments%rowtype;
  v_created boolean := false;
begin
  if p_org is null or p_from_user is null or p_to_user is null then raise exception 'customer_rep_reassign: the organisation and both Reps are required'; end if;
  if v_customer = '' then raise exception 'customer_rep_reassign: choose a customer'; end if;
  if p_from_user = p_to_user then raise exception 'customer_rep_reassign: choose a different Rep'; end if;
  if length(v_reason) < 3 then raise exception 'customer_rep_reassign: give a reason (at least 3 characters)'; end if;
  -- the new Rep must belong to THIS organisation (the application also validates the Rep role)
  if not exists (select 1 from org_members where org_id = p_org and user_id = p_to_user) then raise exception 'customer_rep_reassign: the new Rep is not a member of this organisation'; end if;
  -- serialise every reassignment of this customer (released automatically at commit or rollback)
  perform pg_advisory_xact_lock(hashtextextended('customer_rep_assignments:' || p_org::text || ':' || v_customer, 0));
  -- lock and read ONLY the assignment being ended
  select * into v_from from customer_rep_assignments where org_id = p_org and cin7_customer_id = v_customer and rep_user_id = p_from_user and ended_at is null for update;
  if not found then raise exception 'customer_rep_reassign: that Rep is not currently assigned to this customer'; end if;
  -- the replacement: the target's existing ACTIVE assignment, else a new one. It is settled BEFORE the old row is ended so the ending can name it.
  select * into v_new from customer_rep_assignments where org_id = p_org and cin7_customer_id = v_customer and rep_user_id = p_to_user and ended_at is null;
  if not found then
    insert into customer_rep_assignments (org_id, cin7_customer_id, customer_name, rep_user_id, rep_email, assigned_by_email, assigned_by_owner_email, assigned_reason)
      values (p_org, v_customer, coalesce(p_customer_name, ''), p_to_user, lower(btrim(coalesce(p_to_email, ''))), p_actor_email, p_owner_email, v_reason)
      returning * into v_new;
    v_created := true;
  end if;
  update customer_rep_assignments set ended_at = clock_timestamp(), ended_by_email = p_actor_email, end_reason = v_reason, replaced_by_assignment_id = v_new.id where id = v_from.id returning * into v_ended;
  return jsonb_build_object('ended', to_jsonb(v_ended), 'assigned', to_jsonb(v_new), 'created', v_created);
end;
$$;

-- ── access ──────────────────────────────────────────────────────────────────
-- RLS on, NO policy: the browser / database API (anon, authenticated) can read nothing here. Only authorised server code reads and writes.
alter table customer_rep_assignments enable row level security;

-- service_role is also reset (Supabase default privileges give it TRUNCATE / REFERENCES / TRIGGER) and then granted only what the Server Actions use.
revoke all on customer_rep_assignments from public, anon, authenticated, service_role;
grant select, insert on customer_rep_assignments to service_role;
grant update (ended_at, ended_by_email, end_reason, replaced_by_assignment_id) on customer_rep_assignments to service_role;   -- ending an assignment; every other column is immutable
revoke all on function customer_rep_assignments_guard() from public, anon, authenticated;
revoke all on function customer_rep_reassign(uuid, text, text, uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function customer_rep_reassign(uuid, text, text, uuid, uuid, text, text, text, text) to service_role;
