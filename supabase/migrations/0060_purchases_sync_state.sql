-- Phase 3.3b (purchases half): watermark tracking for /purchaseList, now
-- that a live probe (2026-08-15, Spark Demo instance) confirmed
-- `UpdatedSince` actually narrows the result set here (100 -> 1 row with a
-- 7-day cutoff) and the response carries a real `LastUpdatedDate` field —
-- see docs/PROJECT-NOTES.md's Phase 3.3b section for the full evidence,
-- including why assembly builds / production orders do NOT get the same
-- treatment (their list responses showed the identical row count across
-- every cutoff tested, with no last-modified field to fall back on either —
-- the exact "silently-ignored filter param" risk this needed to rule out
-- first). Mirrors sales_sync_state (0018_sales_reporting.sql) exactly.
create table if not exists purchases_sync_state (
  org_id              uuid not null references organizations (id) on delete cascade,
  instance_id         uuid not null references cin7_instances (id) on delete cascade,
  last_list_synced_at timestamptz,
  primary key (org_id, instance_id)
);

alter table purchases_sync_state enable row level security;

create policy "org members read purchases_sync_state" on purchases_sync_state for select using (is_org_member(org_id));
