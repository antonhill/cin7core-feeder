-- P5.5 (LBL brief): Configurable Excel export. Persists the column-picker's
-- selection per (org, user) — genuinely new shape in this schema: every
-- existing *_settings table (purchase_planner_settings, picking_calendar_
-- settings, ship_by_notification_settings, bom_alert_settings) is org-wide
-- business policy keyed by org_id alone; this is a personal display
-- preference, so it's keyed by (org_id, user_id) instead. No dedicated
-- per-user preferences table existed anywhere in this schema before this.
create table if not exists order_fulfillment_export_columns (
  org_id     uuid not null references organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  columns    text[] not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

alter table order_fulfillment_export_columns enable row level security;
-- Same is_org_member gate as every other settings table here — the app
-- layer (exportOrderFulfillmentXlsxAction's own saveExportColumnsAction)
-- always scopes the upsert to requireModuleAccess's own resolved userId,
-- never a client-supplied one, so RLS beyond org membership isn't needed
-- for this to stay a genuinely per-user preference in practice.
create policy "org members read order_fulfillment_export_columns" on order_fulfillment_export_columns for select using (is_org_member(org_id));
create policy "org members manage order_fulfillment_export_columns" on order_fulfillment_export_columns for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));
