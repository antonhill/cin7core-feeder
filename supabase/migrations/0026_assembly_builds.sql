-- Inventory Movement report, Phase 2 — Assembly Builds. Unlike Purchases,
-- both field shapes here were already confirmed live well before this
-- feature (see finished-goods.ts, used since 2026-07-06/07 by the existing
-- Assemblies report) — no new diagnostic round needed.
--
-- One completed build produces exactly one "in" movement (the finished
-- good itself: product_sku/quantity/completion_date, held directly on the
-- header row here — no separate line-item table needed since it's always
-- 1:1, unlike a purchase's several receiving batches) and zero or more
-- "out" movements (the components actually consumed, from PickLines — the
-- as-built actual consumption, not OrderLines' planned/estimated figures).
-- Only Status = "COMPLETED" builds represent real inventory movement;
-- DRAFT/IN PROGRESS haven't happened yet and VOIDED never will.

create table if not exists assembly_builds (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  cin7_task_id     text not null,
  assembly_number  text,
  product_sku      text,
  product_name     text,
  status           text,
  quantity         numeric,
  completion_date  date,
  detail_synced_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (org_id, instance_id, cin7_task_id)
);

create index if not exists assembly_builds_pending_detail_idx on assembly_builds (org_id, instance_id) where detail_synced_at is null;
create index if not exists assembly_builds_sku_idx on assembly_builds (org_id, product_sku);
create index if not exists assembly_builds_completion_date_idx on assembly_builds (org_id, completion_date);

-- One row per consumed batch line (PickLines) — the "out" movement ledger.
-- No stable natural key on a pick line (BatchSN can be null), so this is
-- keyed by position within the build's own PickLines array — safe because
-- syncAssemblyBuildDetails always deletes + reinserts a build's lines
-- wholesale on each (re-)fetch, same convention as sale_lines/
-- purchase_receipt_lines.
create table if not exists assembly_consumption_lines (
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid not null references cin7_instances (id) on delete cascade,
  cin7_task_id   text not null,
  line_number    int not null,
  product_sku    text,
  product_name   text,
  quantity       numeric,
  unit_cost      numeric,
  batch_sn       text,
  primary key (org_id, instance_id, cin7_task_id, line_number),
  foreign key (org_id, instance_id, cin7_task_id) references assembly_builds (org_id, instance_id, cin7_task_id) on delete cascade
);

create index if not exists assembly_consumption_lines_sku_idx on assembly_consumption_lines (org_id, product_sku);

alter table assembly_builds enable row level security;
alter table assembly_consumption_lines enable row level security;

create policy "org members read assembly_builds" on assembly_builds for select using (is_org_member(org_id));
create policy "org members read assembly_consumption_lines" on assembly_consumption_lines for select using (is_org_member(org_id));
