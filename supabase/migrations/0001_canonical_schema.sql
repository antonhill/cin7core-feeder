-- Master Product Hub / Cin7 Core feeder — canonical schema (org-scoped)
-- SKU and code values are the stable business keys, scoped per organization.

-- ── Organizations & membership ───────────────────────────────────────
create table if not exists organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create type org_role as enum ('owner', 'admin', 'member');

create table if not exists org_members (
  org_id  uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role    org_role not null default 'member',
  primary key (org_id, user_id)
);

-- Helper used throughout RLS policies below.
create or replace function is_org_member(check_org_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members
    where org_id = check_org_id and user_id = auth.uid()
  );
$$;

-- ── Cin7 Core instance connections (managed via Settings UI) ─────────
-- application_key is stored app-side encrypted (AES-GCM, ENCRYPTION_KEY env var,
-- see src/cin7/crypto.ts) — Postgres only ever sees ciphertext, and only the
-- service role (server-side) reads this table at all.
create table if not exists cin7_instances (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations (id) on delete cascade,
  name                     text not null,
  account_id               text not null,
  application_key_encrypted text not null,
  base_url                 text not null default 'https://inventory.dearsystems.com/ExternalApi/v2',
  active                   boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists cin7_instances_org_idx on cin7_instances (org_id);

-- ── Reference tables ────────────────────────────────────────────────
create table if not exists uoms (
  org_id uuid not null references organizations (id) on delete cascade,
  code   text not null,
  name   text not null,
  primary key (org_id, code)
);

create table if not exists categories (
  org_id      uuid not null references organizations (id) on delete cascade,
  code        text not null,
  name        text not null,
  parent_code text,
  primary key (org_id, code),
  foreign key (org_id, parent_code) references categories (org_id, code)
);

-- ── Products ────────────────────────────────────────────────────────
create type product_type as enum ('raw', 'component', 'assembly', 'finished', 'placeholder');

create table if not exists products (
  org_id        uuid not null references organizations (id) on delete cascade,
  sku           text not null,
  name          text not null,
  description   text,
  category_code text,
  uom_code      text,
  barcode       text,
  type          product_type not null default 'component',
  tax_code      text,
  active        boolean not null default true,
  -- content_hash covers this product + its price tiers + its assembly BOM lines.
  -- Maintained by a trigger; the sync engine pushes only when it differs from
  -- sync_state.synced_hash for a given instance.
  content_hash  text,
  updated_at    timestamptz not null default now(),
  primary key (org_id, sku),
  foreign key (org_id, category_code) references categories (org_id, code),
  foreign key (org_id, uom_code) references uoms (org_id, code)
);

create table if not exists price_tiers (
  org_id      uuid not null references organizations (id) on delete cascade,
  product_sku text not null,
  tier_code   text not null,
  amount      numeric(14,4) not null,
  currency    text not null default 'ZAR',
  primary key (org_id, product_sku, tier_code),
  foreign key (org_id, product_sku) references products (org_id, sku) on delete cascade
);

-- ── Assembly BOM (flat) — matches Cin7 Core "AssemblyBOM" CSV template ──
-- Components are not FK-constrained to products: a component may be a
-- service line (e.g. "Labour", "Discount") that never becomes a stock
-- product. The import pipeline resolves/validates this at commit time.
create table if not exists assembly_bom_lines (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations (id) on delete cascade,
  product_sku               text not null,
  component_sku             text not null,
  component_name            text,
  quantity                  numeric(14,4) not null,
  wastage_quantity          numeric(14,4),
  wastage_percent           numeric(7,4),
  cost_percentage           numeric(7,4),
  price_tier                text,   -- service component only
  expense_account           text,   -- service component only
  estimated_unit_cost       numeric(14,4),
  foreign key (org_id, product_sku) references products (org_id, sku) on delete cascade,
  unique (org_id, product_sku, component_sku)
);

create index if not exists assembly_bom_product_idx on assembly_bom_lines (org_id, product_sku);

-- ── Production BOM (routed) — matches Cin7 Core "ProductionBOM" CSV template ──
-- One product can have multiple versions; a version has ordered operations;
-- each operation consumes components and/or resources.
create table if not exists production_bom_versions (
  org_id                       uuid not null references organizations (id) on delete cascade,
  product_sku                  text not null,
  version                      text not null,
  version_name                 text,
  version_default              boolean not null default false,
  min_quantity                 numeric(14,4),
  max_quantity                 numeric(14,4),
  deviation_percent            numeric(7,4),
  run_size                     numeric(14,4),
  quantity_to_produce          numeric(14,4) not null default 1,
  buffer_percent                numeric(7,4) not null default 0,
  production_instruction_url   text,
  ignore_cumulative_lead_time  boolean not null default false,
  production_lead_time         numeric(10,2),
  content_hash                 text,
  updated_at                   timestamptz not null default now(),
  primary key (org_id, product_sku, version),
  foreign key (org_id, product_sku) references products (org_id, sku) on delete cascade
);

create table if not exists production_bom_operations (
  org_id              uuid not null references organizations (id) on delete cascade,
  product_sku         text not null,
  version             text not null,
  operation_sequence   text not null,
  operation_type       text not null,
  operation_name       text,
  cycle_time           numeric(14,4),
  unit_per_cycle       numeric(14,4),
  work_centre_code     text,
  work_centre_name     text,
  previous_step        text,
  primary key (org_id, product_sku, version, operation_sequence),
  foreign key (org_id, product_sku, version) references production_bom_versions (org_id, product_sku, version) on delete cascade
);

create type production_item_type as enum ('Component', 'Resource');

create table if not exists production_bom_items (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations (id) on delete cascade,
  product_sku                 text not null,
  version                     text not null,
  operation_sequence          text not null,
  item_type                   production_item_type not null,
  -- component SKU (item_type = Component) or resource code (item_type = Resource)
  item_code                   text not null,
  item_name                   text,
  quantity                    numeric(14,4) not null,
  wastage_quantity            numeric(14,4),  -- stock components only
  wastage_percent             numeric(7,4),   -- stock components only
  cost_allocation_type        text,
  sales_value                 numeric(14,4),
  cost_of_wastage             numeric(14,4),
  delivery_to_location        text,
  delivery_to_bin             text,
  coman_price_tier            text,
  tracing                     text,
  issue_method_component      text,
  issue_method_parameter      numeric(14,4),
  operation_is_backflush      boolean not null default false,
  component_is_backflush      boolean not null default false,
  resource_cost_type          text,  -- resources only
  foreign key (org_id, product_sku, version, operation_sequence)
    references production_bom_operations (org_id, product_sku, version, operation_sequence) on delete cascade
);

create index if not exists production_bom_items_op_idx
  on production_bom_items (org_id, product_sku, version, operation_sequence);

-- ── Per-instance sync state (SKU -> Cin7 id map + last sync) ─────────
create table if not exists sync_state (
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid not null references cin7_instances (id) on delete cascade,
  sku            text not null,
  cin7_id        text,                   -- internal id returned by Cin7
  synced_hash    text,                   -- content_hash at last successful push
  last_synced_at timestamptz,
  last_status    text,                   -- created | updated | skipped | failed
  last_error     text,
  primary key (org_id, instance_id, sku),
  foreign key (org_id, sku) references products (org_id, sku) on delete cascade
);

create index if not exists sync_state_instance_idx on sync_state (org_id, instance_id);

-- ── CSV import tracking (staging before commit to canonical tables) ──
create type import_kind as enum ('products', 'assembly_bom', 'production_bom');
create type import_status as enum ('pending', 'validated', 'committed', 'failed');
create type import_row_status as enum ('valid', 'invalid', 'committed');

create table if not exists import_batches (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  kind        import_kind not null,
  filename    text not null,
  status      import_status not null default 'pending',
  row_count   integer not null default 0,
  error_count integer not null default 0,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now()
);

create table if not exists import_rows (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references import_batches (id) on delete cascade,
  row_number  integer not null,
  raw         jsonb not null,
  status      import_row_status not null default 'valid',
  errors      jsonb,
  unique (batch_id, row_number)
);

-- ── content_hash maintenance (products + price tiers + assembly BOM) ─
create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.uom_code,'') || '|' ||
      coalesce(p.barcode,'') || '|' || p.type::text || '|' ||
      coalesce(p.tax_code,'') || '|' || p.active::text || '|' ||
      coalesce((select string_agg(tier_code||':'||amount||':'||currency, ',' order by tier_code)
                from price_tiers where org_id = p.org_id and product_sku = p.sku), '') || '|' ||
      coalesce((select string_agg(component_sku||':'||quantity||':'||coalesce(cost_percentage,0), ',' order by component_sku)
                from assembly_bom_lines where org_id = p.org_id and product_sku = p.sku), '')
    ),
    updated_at = now()
  where p.org_id = p_org_id and p.sku = p_sku;
$$;

create or replace function trg_product_touch() returns trigger language plpgsql as $$
begin
  perform recompute_product_hash(coalesce(new.org_id, old.org_id), coalesce(new.sku, old.sku));
  return null;
end $$;

create or replace function trg_child_touch() returns trigger language plpgsql as $$
begin
  perform recompute_product_hash(coalesce(new.org_id, old.org_id), coalesce(new.product_sku, old.product_sku));
  return null;
end $$;

drop trigger if exists products_touch on products;
create trigger products_touch after insert or update of
  name, description, category_code, uom_code, barcode, type, tax_code, active
  on products for each row execute function trg_product_touch();

drop trigger if exists price_tiers_touch on price_tiers;
create trigger price_tiers_touch after insert or update or delete
  on price_tiers for each row execute function trg_child_touch();

drop trigger if exists assembly_bom_lines_touch on assembly_bom_lines;
create trigger assembly_bom_lines_touch after insert or update or delete
  on assembly_bom_lines for each row execute function trg_child_touch();

-- content_hash for production BOM versions (own hash: version + operations + items).
create or replace function recompute_production_bom_hash(p_org_id uuid, p_sku text, p_version text)
returns void language sql as $$
  update production_bom_versions v set
    content_hash = md5(
      coalesce(v.version_name,'') || '|' || v.version_default::text || '|' ||
      coalesce(v.quantity_to_produce,0)::text || '|' || coalesce(v.buffer_percent,0)::text || '|' ||
      coalesce((select string_agg(
                  o.operation_sequence||':'||o.operation_type||':'||coalesce(o.cycle_time,0)||':'||coalesce(o.work_centre_code,''),
                  ',' order by o.operation_sequence)
                from production_bom_operations o
                where o.org_id = v.org_id and o.product_sku = v.product_sku and o.version = v.version), '') || '|' ||
      coalesce((select string_agg(
                  i.operation_sequence||':'||i.item_type::text||':'||i.item_code||':'||i.quantity,
                  ',' order by i.operation_sequence, i.item_code)
                from production_bom_items i
                where i.org_id = v.org_id and i.product_sku = v.product_sku and i.version = v.version), '')
    ),
    updated_at = now()
  where v.org_id = p_org_id and v.product_sku = p_sku and v.version = p_version;
$$;

create or replace function trg_production_bom_version_touch() returns trigger language plpgsql as $$
begin
  perform recompute_production_bom_hash(coalesce(new.org_id, old.org_id), coalesce(new.product_sku, old.product_sku), coalesce(new.version, old.version));
  return null;
end $$;

create or replace function trg_production_bom_child_touch() returns trigger language plpgsql as $$
begin
  perform recompute_production_bom_hash(coalesce(new.org_id, old.org_id), coalesce(new.product_sku, old.product_sku), coalesce(new.version, old.version));
  return null;
end $$;

drop trigger if exists production_bom_versions_touch on production_bom_versions;
create trigger production_bom_versions_touch after insert or update of
  version_name, version_default, quantity_to_produce, buffer_percent
  on production_bom_versions for each row execute function trg_production_bom_version_touch();

drop trigger if exists production_bom_operations_touch on production_bom_operations;
create trigger production_bom_operations_touch after insert or update or delete
  on production_bom_operations for each row execute function trg_production_bom_child_touch();

drop trigger if exists production_bom_items_touch on production_bom_items;
create trigger production_bom_items_touch after insert or update or delete
  on production_bom_items for each row execute function trg_production_bom_child_touch();

-- ── Row-level security (org-scoped; service role bypasses RLS) ───────
alter table organizations           enable row level security;
alter table org_members             enable row level security;
alter table cin7_instances          enable row level security;
alter table uoms                    enable row level security;
alter table categories              enable row level security;
alter table products                enable row level security;
alter table price_tiers             enable row level security;
alter table assembly_bom_lines      enable row level security;
alter table production_bom_versions enable row level security;
alter table production_bom_operations enable row level security;
alter table production_bom_items    enable row level security;
alter table sync_state              enable row level security;
alter table import_batches          enable row level security;
alter table import_rows             enable row level security;

create policy "members read own org" on organizations for select
  using (is_org_member(id));
create policy "members read own membership rows" on org_members for select
  using (is_org_member(org_id));

create policy "org members read instances" on cin7_instances for select
  using (is_org_member(org_id));
create policy "org admins manage instances" on cin7_instances for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

create policy "org members read uoms" on uoms for select using (is_org_member(org_id));
create policy "org members read categories" on categories for select using (is_org_member(org_id));
create policy "org members read products" on products for select using (is_org_member(org_id));
create policy "org members read price_tiers" on price_tiers for select using (is_org_member(org_id));
create policy "org members read assembly_bom_lines" on assembly_bom_lines for select using (is_org_member(org_id));
create policy "org members read production_bom_versions" on production_bom_versions for select using (is_org_member(org_id));
create policy "org members read production_bom_operations" on production_bom_operations for select using (is_org_member(org_id));
create policy "org members read production_bom_items" on production_bom_items for select using (is_org_member(org_id));
create policy "org members read sync_state" on sync_state for select using (is_org_member(org_id));
create policy "org members read import_batches" on import_batches for select using (is_org_member(org_id));
create policy "org members read import_rows" on import_rows for select using (
  exists (select 1 from import_batches b where b.id = batch_id and is_org_member(b.org_id))
);
