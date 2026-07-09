-- Stock Health report — the "current stock level" side, sourced from Cin7
-- Core's Product Availability screen (`GET /ref/productavailability`).
--
-- Confirmed live 2026-07-09 (src/cin7/debug.ts's surveyProductAvailabilityFields):
--   - List key is `ProductAvailabilityList` (not documented in the community
--     spec's truncated sample response).
--   - `StockValue`/`Category` (assumed from the spec) do NOT exist on this
--     account's real response at all.
--   - `OnHand` is the real per-row quantity: `Available = OnHand - Allocated`
--     holds exactly across every row checked. `StockOnHand`, despite its
--     name, is actually a monetary VALUE field (its ratio to OnHand is a
--     constant ~237.614 across different locations of the same SKU, i.e.
--     StockOnHand = OnHand × unit cost) — this is what backs Cin7's own UI
--     "Stock Value" column, just named confusingly via the API. Both are
--     safe to sum per product: neither is a repeated per-SKU rollup.
--   - A product with zero stock everywhere still appears in the list with
--     no filter applied (confirmed: SKU "1SockPair" at "Branding"/"Cape Town"
--     both show OnHand=0, Available negative from outstanding allocations)
--     — so fetchAllProductAvailability deliberately never filters to
--     non-zero quantities, letting a real stockout surface in the report.
--
-- This is a live SNAPSHOT, not an event log like sales/purchases/assembly
-- builds — a location/bin/batch row simply stops being returned once its
-- stock hits zero-with-no-allocation, there's no stable ID to upsert
-- against and no "deleted" signal. Every sync run deletes all rows for
-- (org_id, instance_id) and reinserts the fresh snapshot wholesale (see
-- src/sync/sync-product-availability.ts) — the first sync in this codebase
-- to work this way, unlike every prior append-only/upsert-by-Cin7-ID sync.
create table if not exists product_availability (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete cascade,
  instance_id        uuid not null references cin7_instances (id) on delete cascade,
  product_sku        text,
  product_name       text,
  location           text,
  bin                text,
  batch_sn           text,
  expiry_date        date,
  on_hand            numeric,
  available          numeric,
  on_order           numeric,
  in_transit         numeric,
  allocated          numeric,
  -- Sourced from Cin7's `StockOnHand` field — a monetary value despite the
  -- name (see comment above), not a second quantity figure.
  stock_value        numeric,
  next_delivery_date date,
  synced_at          timestamptz not null default now()
);

create index if not exists product_availability_org_instance_idx on product_availability (org_id, instance_id);
create index if not exists product_availability_sku_idx on product_availability (org_id, product_sku);

alter table product_availability enable row level security;
create policy "org members read product_availability" on product_availability for select using (is_org_member(org_id));
