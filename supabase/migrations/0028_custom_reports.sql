-- Custom report builder — lets an org save its own dimension/measure
-- selections against a fixed per-source whitelist (see src/reports/custom/
-- sources.ts), rather than every report being hand-built. Config only, no
-- Cin7 write involved, so this is deliberately NOT gated by
-- requireWriteAllowed (src/lib/billing.ts) — that gate is narrowly scoped to
-- actions that push data to Cin7 (Import, Audit fixes), confirmed by reading
-- every call site before reusing/skipping it here.
create table if not exists custom_reports (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  name       text not null,
  source     text not null,
  dimensions text[] not null,
  measures   text[] not null,
  filters    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists custom_reports_org_idx on custom_reports (org_id);

alter table custom_reports enable row level security;

create policy "org members read custom_reports" on custom_reports for select using (is_org_member(org_id));
-- Modeled on cin7_instances' "for all" policy (0001_canonical_schema.sql) —
-- the one existing table in this schema an org member writes to directly
-- from the app, not just service-role sync code. A saved report definition
-- is the same class of thing: user-owned in-app config, not synced business
-- data.
create policy "org members manage custom_reports" on custom_reports for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Inventory Movement's per-line facts, exposed as its own function for the
-- custom report builder — same union-of-4-sources logic as the `movement`
-- CTE already inside report_inventory_movement (0027), just returned
-- unaggregated instead of pre-grouped by product. Added as a NEW function
-- rather than refactoring the existing one, so the already-shipped Phase 3
-- Inventory Movement report can't regress.
create or replace function report_inventory_movement_lines(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  product_sku text,
  product_name text,
  quantity numeric,
  source text,
  movement_date date
) language sql stable set search_path = public as $$
  select product_sku, product_name, quantity, 'purchases' as source, received_date as movement_date
  from purchase_receipt_lines
  where org_id = p_org_id
    and (p_instance_ids is null or instance_id = any (p_instance_ids))
    and (p_date_from is null or received_date >= p_date_from)
    and (p_date_to is null or received_date <= p_date_to)

  union all

  select product_sku, product_name, quantity, 'assembly_in' as source, completion_date as movement_date
  from assembly_builds
  where org_id = p_org_id
    and (p_instance_ids is null or instance_id = any (p_instance_ids))
    and (p_date_from is null or completion_date >= p_date_from)
    and (p_date_to is null or completion_date <= p_date_to)

  union all

  select product_sku, product_name, quantity, 'sales' as source, invoice_date as movement_date
  from sale_lines
  where org_id = p_org_id
    and (p_instance_ids is null or instance_id = any (p_instance_ids))
    and (p_date_from is null or invoice_date >= p_date_from)
    and (p_date_to is null or invoice_date <= p_date_to)

  union all

  select acl.product_sku, acl.product_name, acl.quantity, 'assembly_consumption' as source, ab.completion_date as movement_date
  from assembly_consumption_lines acl
  join assembly_builds ab
    on ab.org_id = acl.org_id and ab.instance_id = acl.instance_id and ab.cin7_task_id = acl.cin7_task_id
  where acl.org_id = p_org_id
    and (p_instance_ids is null or acl.instance_id = any (p_instance_ids))
    and (p_date_from is null or ab.completion_date >= p_date_from)
    and (p_date_to is null or ab.completion_date <= p_date_to);
$$;
