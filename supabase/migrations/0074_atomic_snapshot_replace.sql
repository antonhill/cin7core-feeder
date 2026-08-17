-- Security re-audit P0-7: ProductAvailability and purchase receipt/order
-- line sync both replace a snapshot via delete-then-insert as TWO (or, for
-- purchase detail, FOUR) separate, non-transactional PostgREST requests —
-- confirmed live in src/sync/sync-product-availability.ts and
-- src/sync/sync-purchases.ts's syncPurchaseDetails. A failure between the
-- delete and a later insert/update leaves the table empty (product
-- availability) or in a mixed fresh/stale state (purchase detail) rather
-- than preserving the previous snapshot, as the audit requires.
--
-- Fix: wrap each snapshot replacement in ONE Postgres function so it's ONE
-- transaction — a plain multi-statement `language plpgsql` function body
-- is already atomic (no explicit BEGIN/COMMIT needed; if any statement
-- raises, the whole function's effects roll back), so this needs no new
-- staging-table machinery, just moving the existing delete+insert(+update)
-- sequence server-side into a single call. Rows are passed in as jsonb and
-- expanded via jsonb_to_recordset — this codebase has no existing
-- multi-row-insert-via-RPC precedent to mirror, so this establishes one.
-- Same "service-role only, RLS on with no policies, revoke from
-- anon/authenticated" convention as every other write RPC here (see
-- po_creation_claim, 0055).

create or replace function replace_product_availability(p_org_id uuid, p_instance_id uuid, p_rows jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from product_availability where org_id = p_org_id and instance_id = p_instance_id;

  insert into product_availability (
    org_id, instance_id, product_sku, product_name, location, bin, batch_sn,
    expiry_date, on_hand, available, on_order, in_transit, allocated, stock_value,
    next_delivery_date, synced_at
  )
  select
    p_org_id, p_instance_id,
    r.product_sku, r.product_name, r.location, r.bin, r.batch_sn,
    r.expiry_date, r.on_hand, r.available, r.on_order, r.in_transit, r.allocated, r.stock_value,
    r.next_delivery_date, coalesce(r.synced_at, clock_timestamp())
  from jsonb_to_recordset(p_rows) as r(
    product_sku text, product_name text, location text, bin text, batch_sn text,
    expiry_date date, on_hand numeric, available numeric, on_order numeric,
    in_transit numeric, allocated numeric, stock_value numeric,
    next_delivery_date date, synced_at timestamptz
  );
end;
$$;

comment on function replace_product_availability(uuid, uuid, jsonb) is
  'P0-7 atomic snapshot replace: delete + reinsert this (org,instance)''s product_availability rows in one transaction, so a failed sync preserves the PREVIOUS snapshot instead of leaving the table empty.';

revoke all on function replace_product_availability(uuid, uuid, jsonb) from public;
revoke all on function replace_product_availability(uuid, uuid, jsonb) from anon, authenticated;

-- Same fix for purchase receipt/order line replacement — the 4-statement
-- chain in syncPurchaseDetails (delete+insert receipt lines, delete+insert
-- order lines, then update purchases.detail_synced_at) becomes one call.
-- detail_synced_at is set to clock_timestamp() only on success, matching
-- today's behavior where a purchase stays queued (detail_synced_at null)
-- until every step of a re-sync attempt actually completes.
create or replace function replace_purchase_detail(
  p_org_id uuid,
  p_instance_id uuid,
  p_cin7_purchase_id text,
  p_receipt_lines jsonb,
  p_order_lines jsonb,
  p_source text,
  p_is_drop_ship boolean
)
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from purchase_receipt_lines
    where org_id = p_org_id and instance_id = p_instance_id and cin7_purchase_id = p_cin7_purchase_id;

  insert into purchase_receipt_lines (org_id, instance_id, cin7_purchase_id, card_id, product_sku, product_name, quantity, received_date, location, location_id)
  select
    p_org_id, p_instance_id, p_cin7_purchase_id,
    r.card_id, r.product_sku, r.product_name, r.quantity, r.received_date, r.location, r.location_id
  from jsonb_to_recordset(p_receipt_lines) as r(
    card_id text, product_sku text, product_name text, quantity numeric, received_date date, location text, location_id text
  );

  delete from purchase_order_lines
    where org_id = p_org_id and instance_id = p_instance_id and cin7_purchase_id = p_cin7_purchase_id;

  insert into purchase_order_lines (org_id, instance_id, cin7_purchase_id, line_number, product_sku, product_name, quantity)
  select
    p_org_id, p_instance_id, p_cin7_purchase_id,
    o.line_number, o.product_sku, o.product_name, o.quantity
  from jsonb_to_recordset(p_order_lines) as o(
    line_number integer, product_sku text, product_name text, quantity numeric
  );

  update purchases
    set source = p_source, is_drop_ship = p_is_drop_ship, detail_synced_at = clock_timestamp()
    where org_id = p_org_id and instance_id = p_instance_id and cin7_purchase_id = p_cin7_purchase_id;
end;
$$;

comment on function replace_purchase_detail(uuid, uuid, text, jsonb, jsonb, text, boolean) is
  'P0-7 atomic snapshot replace: replaces one purchase''s receipt lines + order lines and marks it detail-synced, all in one transaction — a failure partway through (e.g. the order-lines insert) leaves the purchase''s PREVIOUS receipt/order lines and detail_synced_at=null (still queued for retry) instead of a mixed fresh/stale state.';

revoke all on function replace_purchase_detail(uuid, uuid, text, jsonb, jsonb, text, boolean) from public;
revoke all on function replace_purchase_detail(uuid, uuid, text, jsonb, jsonb, text, boolean) from anon, authenticated;
