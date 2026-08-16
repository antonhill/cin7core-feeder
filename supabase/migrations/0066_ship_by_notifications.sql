-- P4 (LBL brief), Phase 1: Ship By Change Notifications. Confirmed live
-- 2026-08-16 (probeSalesRepField against a real LBL sale): Cin7's
-- SalesRepresentative is reliably present on the sale detail response, but
-- its value is inconsistent — sometimes a plain name, sometimes already an
-- email — so it's resolved through an explicit per-org mapping table rather
-- than trusted directly. No new Cin7 write: this only ever fires off the
-- existing whitelisted ShipBy write (updateOrderShipByAction /
-- updatePickingShipByAction), same as the brief's own ground rule 2.

-- Captured alongside location/customer_reference in syncSaleDetails
-- (src/sync/sync-sales.ts) — detail-only, same /sale?ID= call already made,
-- no new Cin7 API traffic.
alter table sales add column if not exists sales_rep text;

-- Per-org toggle + policy. Off by default per the brief's own requirement
-- 6 — a deliverability test against the client's real mail ingress has to
-- happen before this is ever switched on for an org. debounce_minutes
-- mirrors requirement 5's "anti-bombardment" window (default 15).
create table if not exists ship_by_notification_settings (
  org_id           uuid primary key references organizations (id) on delete cascade,
  enabled          boolean not null default false,
  cc_emails        text[] not null default '{}',
  debounce_minutes numeric not null default 15 check (debounce_minutes >= 0),
  -- Requirement 2's Phase 2 (detecting ship_by changes made directly in
  -- Cin7, via a cron sync-diff producer) is explicitly a stub in this
  -- migration — this flag exists so the pipeline has a place to plug a
  -- future producer into, but nothing sets or reads it yet. [DECISION] in
  -- the brief: whether Phase 2 ships to LBL at all — deferred, not resolved
  -- here.
  phase2_enabled   boolean not null default false,
  updated_at       timestamptz not null default now()
);

alter table ship_by_notification_settings enable row level security;
create policy "org members read ship_by_notification_settings" on ship_by_notification_settings for select using (is_org_member(org_id));
-- Write access gated to org admins at the application layer
-- (requireOrgAdmin) — same reasoning as purchase_planner_settings: this is
-- a shared org-wide policy, not a personal preference.
create policy "org members manage ship_by_notification_settings" on ship_by_notification_settings for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Rep name (the raw, inconsistent SalesRepresentative string from Cin7) ->
-- email, per org. Requirement 3's own fallback plan, needed unconditionally
-- since the live probe found the field isn't reliably an email on its own.
create table if not exists ship_by_notification_reps (
  org_id     uuid not null references organizations (id) on delete cascade,
  rep_name   text not null,
  email      text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, rep_name)
);

alter table ship_by_notification_reps enable row level security;
create policy "org members read ship_by_notification_reps" on ship_by_notification_reps for select using (is_org_member(org_id));
create policy "org members manage ship_by_notification_reps" on ship_by_notification_reps for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Debounce state (requirement 5): one row per sale currently "waiting out"
-- its anti-bombardment window. original_ship_by is set once, on the FIRST
-- change in a burst, and never overwritten by later changes in the same
-- window — the eventual email reports original_ship_by -> latest_ship_by
-- (the final date), not a chain of every intermediate value.
-- send_after is recomputed (pushed forward) on every change within the
-- window — a genuine sliding debounce, so a burst of edits doesn't fire
-- partway through. The cron flush (src/lib/ship-by-notifications.ts)
-- deletes a row once its notification has been sent.
create table if not exists ship_by_change_pending (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id     text not null,
  original_ship_by date,
  latest_ship_by   date not null,
  changed_by_email text,
  first_changed_at timestamptz not null default now(),
  send_after       timestamptz not null,
  primary key (org_id, instance_id, cin7_sale_id)
);

alter table ship_by_change_pending enable row level security;
create policy "org members read ship_by_change_pending" on ship_by_change_pending for select using (is_org_member(org_id));
-- Written only by the write-back Server Actions (service role) and read/
-- deleted only by the cron flush (also service role) — no direct user
-- write path exists, but RLS still needs a policy for the service-role
-- bypass to be intentional rather than an oversight; mirrors every other
-- table here.
create policy "org members manage ship_by_change_pending" on ship_by_change_pending for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Notification log (requirement 5's "log every notification... for the
-- deliverability test"). sent_at/provider_message_id are nullable — a
-- change with no resolvable recipients (no rep mapping AND no CC list)
-- still gets logged with an empty recipients array, so "we knew about this
-- change but nobody was notified" stays visible rather than silently
-- vanishing; likewise a Resend send failure is logged with `error` set
-- instead of being dropped.
create table if not exists ship_by_change_notifications (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  instance_id         uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id        text not null,
  old_ship_by         date,
  new_ship_by         date not null,
  changed_by_email    text,
  recipients          text[] not null default '{}',
  sent_at             timestamptz,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now()
);

alter table ship_by_change_notifications enable row level security;
create policy "org members read ship_by_change_notifications" on ship_by_change_notifications for select using (is_org_member(org_id));
create policy "org members manage ship_by_change_notifications" on ship_by_change_notifications for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

create index if not exists ship_by_change_notifications_org_idx on ship_by_change_notifications (org_id, created_at desc);

-- Atomic insert-or-extend-the-window upsert, same "preserve the first
-- value, race-safe in one round trip" shape as po_creation_claim/
-- try_acquire_sync_route_lock elsewhere in this schema. original_ship_by is
-- deliberately excluded from the ON CONFLICT UPDATE — it stays whatever it
-- was on the FIRST change in the current debounce window, while
-- latest_ship_by/changed_by_email/send_after always take the newest values,
-- which is exactly the sliding-window "collapse to one email carrying the
-- final date" behaviour requirement 5 asks for.
create or replace function record_ship_by_change_pending(
  p_org_id uuid,
  p_instance_id uuid,
  p_cin7_sale_id text,
  p_old_ship_by date,
  p_new_ship_by date,
  p_changed_by_email text,
  p_debounce_minutes numeric
) returns void language sql set search_path = public as $$
  insert into ship_by_change_pending (org_id, instance_id, cin7_sale_id, original_ship_by, latest_ship_by, changed_by_email, send_after)
  values (
    p_org_id, p_instance_id, p_cin7_sale_id, p_old_ship_by, p_new_ship_by, p_changed_by_email,
    now() + (p_debounce_minutes::text || ' minutes')::interval
  )
  on conflict (org_id, instance_id, cin7_sale_id) do update
    set latest_ship_by = excluded.latest_ship_by,
        changed_by_email = excluded.changed_by_email,
        send_after = excluded.send_after;
$$;
