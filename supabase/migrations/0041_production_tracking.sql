-- Production Tracking report (Advanced Manufacturing) — visibility into
-- Cin7 Core Production Orders for clients running Advanced Manufacturing:
-- current stage/work centre, wastage per stage, WIP financial position,
-- and lateness. Confirmed live 2026-07-14 against the Spark Demo instance
-- that GET /production/order (the plan/BOM resource this codebase already
-- used for costing) carries NO per-operation progress field at all — the
-- real state lives on a wholly separate resource, GET
-- /production/order/run, found via the community Apiary spec
-- (github.com/nnhansg/dear-openapi) and confirmed live against a genuinely
-- in-progress order (MO-00019). See src/cin7/production-order-run.ts.
--
-- Deliberately narrower than a full field dump — scoped to what "current
-- stage / wastage per stage / WIP position / late orders" actually needs.
-- Not stored: per-component/per-resource line detail, more than the
-- latest Run per order, attachments/notes/output arrays.
create table if not exists production_orders (
  org_id                        uuid not null references organizations (id) on delete cascade,
  instance_id                   uuid not null references cin7_instances (id) on delete cascade,
  cin7_production_order_id      text not null,
  order_number                  text,
  product_sku                   text,
  product_name                  text,
  location_name                 text,
  -- orderList's own Status (IN PROGRESS/COMPLETED/etc, confirmed live) —
  -- kept regardless of value (unlike assembly_builds, which only keeps
  -- COMPLETED rows) since a late order that never started still needs to
  -- show as late, not be filtered out.
  list_status                   text,
  required_by_date              date,
  completion_date               date,
  -- Everything below is derived from the latest Run (/production/order/run)
  -- — null until the first successful run-detail fetch.
  run_status                    text,
  wip_account                   text,
  current_operation_name        text,
  current_work_center_name      text,
  current_operation_started_at  timestamptz,
  wip_actual_cost                numeric,
  run_synced_at                 timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, instance_id, cin7_production_order_id)
);

-- Drives Phase 2's "which open orders need a run-detail refresh" query —
-- see sync-production-runs.ts.
create index if not exists production_orders_open_idx on production_orders (org_id, instance_id, run_synced_at) where list_status not in ('COMPLETED', 'VOIDED');
create index if not exists production_orders_required_by_idx on production_orders (org_id, required_by_date);
create index if not exists production_orders_sku_idx on production_orders (org_id, product_sku);

-- One row per Operation in the latest Run — replaced (delete + reinsert)
-- wholesale on every run-detail refresh, same convention as
-- assembly_consumption_lines/sale_lines/purchase_receipt_lines.
create table if not exists production_operations (
  org_id                    uuid not null references organizations (id) on delete cascade,
  instance_id               uuid not null references cin7_instances (id) on delete cascade,
  cin7_production_order_id  text not null,
  operation_order           int not null,
  operation_name            text,
  work_center_name          text,
  status                    text,
  planned_time              numeric,
  actual_time               numeric,
  start_date                timestamptz,
  end_date                  timestamptz,
  -- Sum of ResourceCosts[].Cost for this operation — the ACTUAL GL-posted
  -- cost, distinct from Resources[].Cost (planned/standard cost, not
  -- stored here).
  actual_resource_cost      numeric,
  -- Sum of Components[].WastageQty for this operation — the ACTUAL
  -- consumption figure, distinct from /production/order's always-planned
  -- (and, on every real order checked so far, always-zero) wastage.
  wastage_qty               numeric,
  primary key (org_id, instance_id, cin7_production_order_id, operation_order),
  foreign key (org_id, instance_id, cin7_production_order_id) references production_orders (org_id, instance_id, cin7_production_order_id) on delete cascade
);

alter table production_orders enable row level security;
alter table production_operations enable row level security;

create policy "org members read production_orders" on production_orders for select using (is_org_member(org_id));
create policy "org members read production_operations" on production_operations for select using (is_org_member(org_id));
