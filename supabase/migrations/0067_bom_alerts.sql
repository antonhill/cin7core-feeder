-- P5.1 (LBL brief): BOM alert on authorised SOs. When a sale transitions
-- INTO Cin7's AUTHORISED order_status and its lines include at least one
-- BOM/assembly product, notify a configured Warehouse Manager email — BOM
-- lines don't print on Cin7's own "Pick Available" flow, so this is the
-- interim measure until WMS expanded picking.
--
-- Detection lives entirely in phase 1 of syncSalesList
-- (src/sync/sync-sales.ts) — comparing the sale's prior order_status
-- against the new one from the cheap /saleList scan (both already synced
-- fields, no new Cin7 traffic for the transition check itself). Only a
-- genuine transition fires anything: a sale already AUTHORISED before this
-- feature existed has prior.order_status = 'AUTHORISED' too, so it never
-- qualifies — turning this on for an org does NOT burst-alert on the
-- existing backlog of already-authorised orders, only future transitions.
--
-- [VALIDATE-API] resolved 2026-08-16: Cin7's real field is `BillOfMaterial`
-- (boolean, GET /Product) — already confirmed live and in production use by
-- Data Audit (src/audit/product-audit.ts). [DECISION] resolved with Anton
-- 2026-08-16: the local `products` table is never pulled live from Cin7
-- (only pushed outward), so rather than build a new sync pipeline just for
-- this one boolean, the BOM check is a live call scoped to the handful of
-- SKUs on the one just-authorised sale (src/cin7/products.ts,
-- findBomSkus) — a low-frequency business event, not a list-view N+1.

-- Guards against re-alerting on the same authorisation across sync runs —
-- deliberately NOT reset if the sale later leaves and re-enters AUTHORISED
-- (e.g. voided and recreated); a second alert for a genuinely new
-- authorisation event is accepted as a rare, low-cost miss rather than
-- adding a second tracking column for it now.
alter table sales add column if not exists bom_alert_sent_at timestamptz;

-- Per-org toggle + recipient. Off by default, same "org-flagged off" spirit
-- as P4 — deliberately no debounce table here unlike P4's
-- ship_by_change_pending: this fires once per sale (guarded by
-- bom_alert_sent_at above), not repeatedly for the same sale in a short
-- window, so there's nothing to collapse.
create table if not exists bom_alert_settings (
  org_id                 uuid primary key references organizations (id) on delete cascade,
  enabled                boolean not null default false,
  warehouse_manager_email text,
  updated_at             timestamptz not null default now()
);

alter table bom_alert_settings enable row level security;
create policy "org members read bom_alert_settings" on bom_alert_settings for select using (is_org_member(org_id));
-- Write access gated to org admins at the application layer
-- (requireOrgAdmin) — same reasoning as every other settings table here.
create policy "org members manage bom_alert_settings" on bom_alert_settings for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Notification log, same "log unconditionally, even a failure" shape as
-- ship_by_change_notifications (0066) — sent_at/provider_message_id stay
-- null and `error` is set when the send itself fails, so a detected
-- transition is never silently unaccounted for.
create table if not exists bom_alert_notifications (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  instance_id         uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id        text not null,
  bom_skus            text[] not null default '{}',
  recipient           text,
  sent_at             timestamptz,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now()
);

alter table bom_alert_notifications enable row level security;
create policy "org members read bom_alert_notifications" on bom_alert_notifications for select using (is_org_member(org_id));
create policy "org members manage bom_alert_notifications" on bom_alert_notifications for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

create index if not exists bom_alert_notifications_org_idx on bom_alert_notifications (org_id, created_at desc);
