-- Order Fulfillment Dashboard — extends the existing Sales sync (not a new
-- domain sync) with fields Cin7 already computes but this codebase never
-- fetched/stored, all confirmed live 2026-07-09 via
-- src/cin7/debug.ts's surveySaleFulfillmentFields:
--   - /saleList already carries CombinedPickingStatus/CombinedPackingStatus/
--     CombinedShippingStatus/CombinedPaymentStatus/Carrier/
--     CombinedTrackingNumbers/PaidAmount/SaleInvoicesTotalAmount/OrderStatus
--     alongside the FulFilmentStatus/ShipBy this codebase already fetched
--     but never persisted — all cheap, no new API calls, same list scan
--     Phase 1 already runs.
--   - GET /sale?ID= already carries Order.Lines[].BackorderQuantity and
--     Fulfilments[] (an array — confirmed live a sale can have more than
--     one) with nested Pick/Pack sub-objects, each with their own Lines[]
--     of actually-picked/packed quantities — same detail call Phase 2
--     already makes for invoice lines.
--
-- Real nuance confirmed live: invoicing does NOT wait for packing/shipping
-- on this account (a real order was CombinedInvoiceStatus=INVOICED while
-- CombinedPackingStatus=NOT PACKED) — the dashboard's bucket logic must
-- read the real status combinations directly, not assume a fixed
-- pick->pack->ship->invoice sequence. Also confirmed: Order.Lines[] is
-- sometimes empty even on a sale with real fulfilments (older/legacy
-- records) — absence just means no backorder data is available for that
-- sale, not that backorder is zero.
--
-- Widens sync scope: syncSalesList previously only fetched INVOICED sales
-- (fetchInvoicedSalesList) since that's all the revenue report needed —
-- the whole point of this dashboard is seeing orders BEFORE they're
-- invoiced (ready to pick, partially picked), so sync-sales.ts now fetches
-- every sale regardless of invoice status (fetchAllSalesList). Safe for
-- the existing Sales revenue report: sale_lines is still sourced only from
-- real Invoices[].Lines[], so an un-invoiced sale just has zero sale_lines
-- rows, same as always — this only adds more `sales` header rows and more
-- detail-phase fetches (the actual per-order data the dashboard needs).

alter table sales
  add column if not exists order_status text,
  add column if not exists combined_invoice_status text,
  add column if not exists combined_picking_status text,
  add column if not exists combined_packing_status text,
  add column if not exists combined_shipping_status text,
  add column if not exists combined_payment_status text,
  add column if not exists fulfilment_status text,
  add column if not exists ship_by date,
  add column if not exists carrier text,
  add column if not exists tracking_numbers text,
  add column if not exists paid_amount numeric,
  add column if not exists invoice_amount numeric;

create index if not exists sales_ship_by_idx on sales (org_id, ship_by);

-- Ordered quantities + backorder, one row per Order.Lines[] entry.
create table if not exists sale_order_lines (
  org_id             uuid not null references organizations (id) on delete cascade,
  instance_id        uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id       text not null,
  line_number        int not null,
  product_sku        text,
  product_name       text,
  quantity           numeric,
  backorder_quantity numeric,
  primary key (org_id, instance_id, cin7_sale_id, line_number),
  foreign key (org_id, instance_id, cin7_sale_id) references sales (org_id, instance_id, cin7_sale_id) on delete cascade
);
create index if not exists sale_order_lines_sku_idx on sale_order_lines (org_id, product_sku);

-- Actual picked/packed quantities, flattened across every Fulfilments[]
-- entry on the sale — what matters for "already picked" is the sum per
-- SKU, not which specific fulfilment record it came from.
create table if not exists sale_pick_pack_lines (
  org_id       uuid not null references organizations (id) on delete cascade,
  instance_id  uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id text not null,
  stage        text not null check (stage in ('pick', 'pack')),
  line_number  int not null,
  product_sku  text,
  product_name text,
  quantity     numeric,
  primary key (org_id, instance_id, cin7_sale_id, stage, line_number),
  foreign key (org_id, instance_id, cin7_sale_id) references sales (org_id, instance_id, cin7_sale_id) on delete cascade
);
create index if not exists sale_pick_pack_lines_sku_idx on sale_pick_pack_lines (org_id, product_sku);

alter table sale_order_lines enable row level security;
alter table sale_pick_pack_lines enable row level security;
create policy "org members read sale_order_lines" on sale_order_lines for select using (is_org_member(org_id));
create policy "org members read sale_pick_pack_lines" on sale_pick_pack_lines for select using (is_org_member(org_id));
