-- Reporting consolidator — sales pulled per-instance from Cin7 Core's
-- /saleList + /sale endpoints. Unlike products/customers/suppliers, a sale
-- is inherently instance-specific (a real transaction that happened in one
-- Cin7 instance), not canonical data pushed to multiple instances — so
-- there's no separate sync_state side table mapping a canonical row to a
-- per-instance cin7_id; a sale row already carries its own instance_id and
-- cin7_sale_id.
--
-- Two-phase sync (see src/sync/sync-sales.ts): /saleList is cheap and
-- paginated, but has no line items — line items (with per-line AverageCost,
-- Cin7's own COGS basis) only come from GET /sale?ID=<id>, one call per
-- sale. `sales.detail_synced_at` (null = not yet fetched) queues sales for
-- that second, rate-limited phase, since a large backfill can't finish
-- within a single sync run's time budget (Vercel's maxDuration).

create table if not exists sales (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id     text not null,
  order_number     text,
  invoice_number   text,
  invoice_date     date,
  customer_name    text,
  location         text,
  status           text,
  currency         text,
  -- Cin7's own "Updated" timestamp on /saleList — drives both the
  -- UpdatedSince incremental list sync and detecting when a previously
  -- detail-synced sale has changed and needs re-fetching.
  cin7_updated_at  timestamptz,
  detail_synced_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (org_id, instance_id, cin7_sale_id)
);

create index if not exists sales_invoice_date_idx on sales (org_id, invoice_date);
create index if not exists sales_pending_detail_idx on sales (org_id, instance_id) where detail_synced_at is null;

-- One row per invoice line. Keyed by invoice_number (not just line_number)
-- because a single Sale can carry more than one Invoice over its life
-- (e.g. partial shipments each invoiced separately) — Cin7's `Invoices` field
-- on GET /sale is an array, each with its own Lines[], InvoiceNumber and
-- InvoiceDate, so a line's real invoice number/date can differ from the
-- other invoices on the same sale.
create table if not exists sale_lines (
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id   text not null,
  invoice_number text not null,
  line_number    int not null,
  invoice_date   date,
  product_sku    text,
  product_name   text,
  quantity       numeric,
  price          numeric,
  discount       numeric,
  tax            numeric,
  total          numeric,
  average_cost   numeric,
  primary key (org_id, instance_id, cin7_sale_id, invoice_number, line_number),
  foreign key (org_id, instance_id, cin7_sale_id) references sales (org_id, instance_id, cin7_sale_id) on delete cascade
);

create index if not exists sale_lines_sku_idx on sale_lines (org_id, product_sku);
create index if not exists sale_lines_invoice_date_idx on sale_lines (org_id, invoice_date);

-- High-water mark per instance for /saleList?UpdatedSince= — separate from
-- the per-sale detail queue (sales.detail_synced_at) since the list scan
-- and the rate-limited detail fetch advance independently.
create table if not exists sales_sync_state (
  org_id              uuid not null references organizations (id) on delete cascade,
  instance_id         uuid not null references cin7_instances (id) on delete cascade,
  last_list_synced_at timestamptz,
  primary key (org_id, instance_id)
);

alter table sales enable row level security;
alter table sale_lines enable row level security;
alter table sales_sync_state enable row level security;

create policy "org members read sales" on sales for select using (is_org_member(org_id));
create policy "org members read sale_lines" on sale_lines for select using (is_org_member(org_id));
create policy "org members read sales_sync_state" on sales_sync_state for select using (is_org_member(org_id));
