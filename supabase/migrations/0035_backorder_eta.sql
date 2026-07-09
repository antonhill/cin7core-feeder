-- Backorder ETA: cross-references a still-backordered sale line against any
-- open (non-voided, non-drop-ship) purchase order carrying the same SKU, so
-- the Order Fulfillment Dashboard can show which PO it's expected on and
-- when. Confirmed live 2026-07-09 (surveyBackorderEtaFields) that Cin7 has
-- NO per-line expected-date field at all — only the purchase-order-level
-- RequiredBy, and it's frequently null even on open orders. This is exposed
-- honestly (null shows as "no ETA given") rather than hidden — still useful
-- for knowing WHICH open PO a SKU is coming on even without a date.
--
-- Widening sync-purchases.ts's list-phase filter (see sync-purchases.ts) to
-- include NOT RECEIVED orders means this table now needs `required_by` and
-- `is_drop_ship` for the first time; purchase_order_lines is new entirely —
-- the "ordered qty" side of a receipt was never stored, only the "actually
-- received" side (purchase_receipt_lines).

alter table purchases add column if not exists required_by date;
-- Drop-shipments (RelatedDropShipSaleTask present on the purchase detail
-- response) ship straight to the customer and never arrive in this
-- warehouse — confirmed live 2026-07-09 on a real order. Excluded from the
-- backorder-ETA cross-reference below regardless of RequiredBy, since
-- referencing one would tell a picker stock is "coming" when it never will.
alter table purchases add column if not exists is_drop_ship boolean not null default false;

-- One row per ordered line (mirrors sale_order_lines) — the "still coming"
-- counterpart to purchase_receipt_lines' "already received" ledger. Same
-- delete-then-reinsert-per-purchase convention as every other detail-synced
-- line table here.
create table if not exists purchase_order_lines (
  org_id            uuid not null references organizations (id) on delete cascade,
  instance_id       uuid not null references cin7_instances (id) on delete cascade,
  cin7_purchase_id  text not null,
  line_number       integer not null,
  product_sku       text,
  product_name      text,
  quantity          numeric,
  primary key (org_id, instance_id, cin7_purchase_id, line_number),
  foreign key (org_id, instance_id, cin7_purchase_id) references purchases (org_id, instance_id, cin7_purchase_id) on delete cascade
);

create index if not exists purchase_order_lines_sku_idx on purchase_order_lines (org_id, instance_id, product_sku);

alter table purchase_order_lines enable row level security;

create policy "org members read purchase_order_lines" on purchase_order_lines for select using (is_org_member(org_id));

-- Postgres won't let create-or-replace change a set-returning function's
-- column list — drop first since this adds new output columns (same
-- constraint hit extending report_order_fulfillment/_lines in 0034).
drop function if exists report_order_fulfillment_lines(uuid, uuid[]);

create function report_order_fulfillment_lines(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  cin7_sale_id text,
  product_sku text,
  product_name text,
  ordered_qty numeric,
  backorder_qty numeric,
  picked_qty numeric,
  packed_qty numeric,
  pickable_qty numeric,
  picked_from_locations text,
  suggested_pick_location text,
  suggested_pick_location_on_hand numeric,
  backorder_po_number text,
  backorder_eta date,
  backorder_po_outstanding_qty numeric
) language sql stable set search_path = public as $$
  with picked as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pick'
    group by cin7_sale_id, product_sku
  ),
  packed as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pack'
    group by cin7_sale_id, product_sku
  ),
  picked_locations as (
    select cin7_sale_id, product_sku, string_agg(distinct location, ', ' order by location) as locations
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pick'
      and location is not null
    group by cin7_sale_id, product_sku
  ),
  best_location as (
    select distinct on (instance_id, product_sku)
      instance_id, product_sku, location, on_hand
    from product_availability
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and on_hand > 0
    order by instance_id, product_sku, on_hand desc
  ),
  -- Ordered/received quantities, summed per (purchase, SKU) before diffing —
  -- a PO can list the same SKU across more than one line.
  purchase_ordered as (
    select org_id, instance_id, cin7_purchase_id, product_sku, sum(quantity) as ordered_qty
    from purchase_order_lines
    group by org_id, instance_id, cin7_purchase_id, product_sku
  ),
  purchase_received as (
    select org_id, instance_id, cin7_purchase_id, product_sku, sum(quantity) as received_qty
    from purchase_receipt_lines
    group by org_id, instance_id, cin7_purchase_id, product_sku
  ),
  purchase_outstanding as (
    select po.instance_id, po.product_sku, p.order_number, p.required_by,
      coalesce(po.ordered_qty, 0) - coalesce(pr.received_qty, 0) as outstanding_qty
    from purchase_ordered po
    join purchases p
      on p.org_id = po.org_id and p.instance_id = po.instance_id and p.cin7_purchase_id = po.cin7_purchase_id
    left join purchase_received pr
      on pr.org_id = po.org_id and pr.instance_id = po.instance_id and pr.cin7_purchase_id = po.cin7_purchase_id
      and pr.product_sku = po.product_sku
    where po.org_id = p_org_id
      and (p_instance_ids is null or po.instance_id = any (p_instance_ids))
      and p.is_drop_ship = false
      and p.combined_receiving_status in ('NOT RECEIVED', 'PARTIALLY RECEIVED')
  ),
  -- One suggested PO per (instance, SKU) — the earliest known ETA among
  -- every open PO still carrying outstanding qty for that SKU; POs with no
  -- RequiredBy at all sort last rather than being dropped; a picker still
  -- benefits from knowing an order exists, just without a date attached.
  backorder_eta as (
    select distinct on (instance_id, product_sku)
      instance_id, product_sku, order_number, required_by, outstanding_qty
    from purchase_outstanding
    where outstanding_qty > 0
    order by instance_id, product_sku, (required_by is null) asc, required_by asc
  )
  select
    ol.cin7_sale_id,
    ol.product_sku,
    ol.product_name,
    coalesce(ol.quantity, 0) as ordered_qty,
    coalesce(ol.backorder_quantity, 0) as backorder_qty,
    coalesce(pk.qty, 0) as picked_qty,
    coalesce(pa.qty, 0) as packed_qty,
    greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pk.qty, 0), 0) as pickable_qty,
    pl.locations as picked_from_locations,
    bl.location as suggested_pick_location,
    bl.on_hand as suggested_pick_location_on_hand,
    be.order_number as backorder_po_number,
    be.required_by as backorder_eta,
    be.outstanding_qty as backorder_po_outstanding_qty
  from sale_order_lines ol
  left join picked pk on pk.cin7_sale_id = ol.cin7_sale_id and pk.product_sku = ol.product_sku
  left join packed pa on pa.cin7_sale_id = ol.cin7_sale_id and pa.product_sku = ol.product_sku
  left join picked_locations pl on pl.cin7_sale_id = ol.cin7_sale_id and pl.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  left join backorder_eta be on be.instance_id = ol.instance_id and be.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
  order by ol.cin7_sale_id, ol.line_number;
$$;
