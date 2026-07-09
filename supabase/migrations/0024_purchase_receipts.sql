-- Inventory Movement report, Phase 1 — the "in" side, sourced from Cin7
-- Core's Purchase Orders. /purchaseList (already used by System Health) has
-- no line-item quantities at all; the actual received quantities only come
-- from the detail endpoint, and Cin7 has two purchase "kinds" with genuinely
-- different response shapes (confirmed live 2026-07-09, see debug.ts's
-- surveyPurchaseDetailFields, which found 3 of the first 5 real purchases on
-- a real account were the "Advanced" kind):
--   - classic:  GET /purchase?ID=          -> StockReceived.Lines[]
--   - advanced: GET /advanced-purchase?ID= -> PutAway[].Lines[] (its own
--     StockReceived is always present but empty on this account — the real
--     received-quantity data lives in PutAway instead)
-- Both shapes carry a `CardID` per received line that's the natural stable
-- key for a receiving batch-line (confirmed live: a 10-unit advanced-purchase
-- order split across two real receiving batches, 5 units each, each with its
-- own CardID/date) — used here as the row identity instead of a synthetic key.

create table if not exists purchases (
  org_id                    uuid not null references organizations (id) on delete cascade,
  instance_id               uuid not null references cin7_instances (id) on delete cascade,
  cin7_purchase_id          text not null,
  order_number              text,
  supplier_name             text,
  status                    text,
  combined_receiving_status text,
  order_date                date,
  -- Which endpoint actually served the last successful detail fetch —
  -- not itself re-checked every run; if the classic endpoint ever starts
  -- rejecting a previously-classic purchase, syncPurchaseDetails retries
  -- via advanced-purchase the same way the live diagnostic does.
  source                    text,
  detail_synced_at          timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (org_id, instance_id, cin7_purchase_id)
);

create index if not exists purchases_pending_detail_idx on purchases (org_id, instance_id) where detail_synced_at is null;

-- One row per received batch-line (a purchase can receive the same SKU
-- across several dates/batches, e.g. a partial delivery split) — this is
-- the actual "in" movement ledger the Inventory Movement report reads from.
create table if not exists purchase_receipt_lines (
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid not null references cin7_instances (id) on delete cascade,
  cin7_purchase_id text not null,
  card_id        text not null,
  product_sku    text,
  product_name   text,
  quantity       numeric,
  received_date  date,
  location       text,
  location_id    text,
  primary key (org_id, instance_id, card_id),
  foreign key (org_id, instance_id, cin7_purchase_id) references purchases (org_id, instance_id, cin7_purchase_id) on delete cascade
);

create index if not exists purchase_receipt_lines_sku_idx on purchase_receipt_lines (org_id, product_sku);
create index if not exists purchase_receipt_lines_date_idx on purchase_receipt_lines (org_id, received_date);

alter table purchases enable row level security;
alter table purchase_receipt_lines enable row level security;

create policy "org members read purchases" on purchases for select using (is_org_member(org_id));
create policy "org members read purchase_receipt_lines" on purchase_receipt_lines for select using (is_org_member(org_id));
