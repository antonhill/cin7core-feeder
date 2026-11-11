-- Regression test for replace_purchase_detail (migration 0074) and the
-- (card_id, product_sku) receipt key (0025), written for the duplicate-receipt
-- collision found on PO-14939 (four lines of one SKU in one batch:
-- 21+20+106+233 = 380) and PO-13609 (duplicates across three SKUs).
-- BEGIN/ROLLBACK: leaves no rows. Prints "ALL 0074 ... PASSED".
--
-- Proves, at the database level:
--   1. the aggregated shape the app now sends (one row per card+SKU, total
--      preserved) is accepted;
--   2. repeating the identical sync is idempotent (same rows, same totals);
--   3. a payload that still contains a duplicate (card_id, product_sku) key is
--      rejected with unique_violation AND the failed call is atomic — the
--      previous receipt lines, order lines and detail_synced_at are untouched.

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000074a1', 'PO Detail Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000074b1', '00000000-0000-0000-0000-0000000074a1', 'PO Detail Test Instance', 'acct', 'enc');
insert into purchases (org_id, instance_id, cin7_purchase_id, order_number, status, combined_receiving_status)
  values ('00000000-0000-0000-0000-0000000074a1', '00000000-0000-0000-0000-0000000074b1', 'po-14939', 'PO-14939', 'INVOICED', 'NOT AVAILABLE');

do $$
declare
  org  uuid := '00000000-0000-0000-0000-0000000074a1';
  inst uuid := '00000000-0000-0000-0000-0000000074b1';
  total numeric;
  n integer;
  synced_before timestamptz;
  synced_after timestamptz;
  raised boolean;
  good_lines jsonb := '[{"card_id":"card-1","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":380,"received_date":"2026-10-29","location":"Main","location_id":"loc-1"}]';
  good_orders jsonb := '[{"line_number":0,"product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":380}]';
  -- The pre-fix payload: the four raw lines, same (card_id, product_sku).
  dup_lines jsonb := '[
    {"card_id":"card-1","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":21,"received_date":"2026-10-29","location":"Main","location_id":"loc-1"},
    {"card_id":"card-1","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":20,"received_date":"2026-10-29","location":"Main","location_id":"loc-1"},
    {"card_id":"card-1","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":106,"received_date":"2026-10-29","location":"Main","location_id":"loc-1"},
    {"card_id":"card-1","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":233,"received_date":"2026-10-29","location":"Main","location_id":"loc-1"}]';
begin
  -- 1. Aggregated payload is accepted; total preserved; PO marked detail-synced.
  perform replace_purchase_detail(org, inst, 'po-14939', good_lines, good_orders, 'advanced-purchase', false);
  select count(*), coalesce(sum(quantity), 0) into n, total from purchase_receipt_lines where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if n <> 1 or total <> 380 then raise exception 'aggregated sync: expected 1 row totalling 380, got % rows totalling %', n, total; end if;
  select detail_synced_at into synced_before from purchases where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if synced_before is null then raise exception 'aggregated sync should mark the PO detail-synced'; end if;

  -- 2. Repeated identical sync is idempotent.
  perform replace_purchase_detail(org, inst, 'po-14939', good_lines, good_orders, 'advanced-purchase', false);
  select count(*), coalesce(sum(quantity), 0) into n, total from purchase_receipt_lines where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if n <> 1 or total <> 380 then raise exception 'repeat sync: expected 1 row totalling 380, got % rows totalling %', n, total; end if;
  select count(*) into n from purchase_order_lines where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if n <> 1 then raise exception 'repeat sync: expected 1 order line, got %', n; end if;
  select detail_synced_at into synced_before from purchases where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';

  -- 3. The un-aggregated payload violates the key and rolls the WHOLE call back.
  raised := false;
  begin
    perform replace_purchase_detail(org, inst, 'po-14939', dup_lines, '[{"line_number":0,"product_sku":"CHANGED","product_name":"x","quantity":1}]'::jsonb, 'advanced-purchase', false);
  exception when unique_violation then
    raised := true;
  end;
  if not raised then raise exception 'duplicate (card_id, product_sku) payload should raise unique_violation'; end if;

  select count(*), coalesce(sum(quantity), 0) into n, total from purchase_receipt_lines where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if n <> 1 or total <> 380 then raise exception 'atomicity: previous receipt lines must be untouched after the failed call, got % rows totalling %', n, total; end if;
  select count(*) into n from purchase_order_lines where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939' and product_sku = 'LBLINSTALLATIONNONIP';
  if n <> 1 then raise exception 'atomicity: previous order lines must be untouched after the failed call'; end if;
  select detail_synced_at into synced_after from purchases where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if synced_after is distinct from synced_before then raise exception 'atomicity: detail_synced_at must be unchanged after the failed call'; end if;

  -- 4. PO-13609 shape: duplicates across three SKUs, aggregated per SKU, are accepted.
  perform replace_purchase_detail(org, inst, 'po-14939',
    '[{"card_id":"c","product_sku":"A","quantity":12,"received_date":"2026-10-01","location":"Main","location_id":"l"},
      {"card_id":"c","product_sku":"B","quantity":5,"received_date":"2026-10-01","location":"Main","location_id":"l"},
      {"card_id":"c","product_sku":"C","quantity":5,"received_date":"2026-10-01","location":"Main","location_id":"l"}]'::jsonb,
    '[]'::jsonb, 'advanced-purchase', false);
  select count(*), coalesce(sum(quantity), 0) into n, total from purchase_receipt_lines where org_id = org and instance_id = inst and cin7_purchase_id = 'po-14939';
  if n <> 3 or total <> 22 then raise exception 'three-SKU shape: expected 3 rows totalling 22, got % rows totalling %', n, total; end if;
end $$;

do $$ begin raise notice 'ALL 0074 REPLACE_PURCHASE_DETAIL ASSERTIONS PASSED'; end $$;

rollback;
