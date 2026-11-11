-- Regression test for migration 0124: purchase_receipt_lines is keyed
-- (org_id, instance_id, cin7_purchase_id, card_id, product_sku).
-- Written for the live failure where Cin7's NIL CardID is shared by lines of
-- different purchase orders (PO-09694 already owned (nil, LBLINSTALLATIONNONIP);
-- PO-14939's lines for the same SKU could not be stored).
-- BEGIN/ROLLBACK: leaves no rows. Prints "ALL 0124 ... PASSED".

begin;

insert into organizations (id, name) values
  ('00000000-0000-0000-0000-0000000124a1', 'Receipt Key Org A'),
  ('00000000-0000-0000-0000-0000000124a2', 'Receipt Key Org B');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted) values
  ('00000000-0000-0000-0000-0000000124b1', '00000000-0000-0000-0000-0000000124a1', 'Inst A', 'acct', 'enc'),
  ('00000000-0000-0000-0000-0000000124b2', '00000000-0000-0000-0000-0000000124a2', 'Inst B', 'acct', 'enc');
insert into purchases (org_id, instance_id, cin7_purchase_id, order_number, status, combined_receiving_status) values
  ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-09694', 'PO-09694', 'INVOICED', 'NOT AVAILABLE'),
  ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-14939', 'PO-14939', 'INVOICED', 'NOT AVAILABLE'),
  -- Same Cin7 purchase id in a DIFFERENT tenant: must be fully independent.
  ('00000000-0000-0000-0000-0000000124a2', '00000000-0000-0000-0000-0000000124b2', 'po-09694', 'PO-09694', 'INVOICED', 'NOT AVAILABLE');

do $$
declare
  orgA uuid := '00000000-0000-0000-0000-0000000124a1';
  instA uuid := '00000000-0000-0000-0000-0000000124b1';
  orgB uuid := '00000000-0000-0000-0000-0000000124a2';
  instB uuid := '00000000-0000-0000-0000-0000000124b2';
  nil text := '00000000-0000-0000-0000-000000000000';
  n integer;
  total numeric;
  raised boolean;
  pkdef text;
  line_a jsonb := '[{"card_id":"00000000-0000-0000-0000-000000000000","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":276,"received_date":"2026-03-07","location":"Main","location_id":"l1"}]';
  line_b jsonb := '[{"card_id":"00000000-0000-0000-0000-000000000000","product_sku":"LBLINSTALLATIONNONIP","product_name":"Installation","quantity":380,"received_date":"2026-10-29","location":"Main","location_id":"l1"}]';
begin
  -- 0. The key now includes the purchase.
  select pg_get_constraintdef(oid) into pkdef from pg_constraint where conrelid = 'purchase_receipt_lines'::regclass and contype = 'p';
  if pkdef <> 'PRIMARY KEY (org_id, instance_id, cin7_purchase_id, card_id, product_sku)' then
    raise exception 'unexpected primary key definition: %', pkdef;
  end if;

  -- 1. Two DIFFERENT POs can store the same (nil CardID, SKU) — the live failure.
  perform replace_purchase_detail(orgA, instA, 'po-09694', line_a, '[]'::jsonb, 'advanced-purchase', false);
  perform replace_purchase_detail(orgA, instA, 'po-14939', line_b, '[]'::jsonb, 'advanced-purchase', false);
  select count(*), sum(quantity) into n, total from purchase_receipt_lines where org_id = orgA and instance_id = instA and card_id = nil and product_sku = 'LBLINSTALLATIONNONIP';
  if n <> 2 or total <> 656 then raise exception 'cross-PO nil card: expected 2 rows totalling 656, got % rows totalling %', n, total; end if;

  -- 2. Per-PO quantities are exactly what each PO sent (no duplication, no cross-contamination).
  select quantity into total from purchase_receipt_lines where cin7_purchase_id = 'po-09694' and org_id = orgA;
  if total <> 276 then raise exception 'po-09694 quantity should be 276, got %', total; end if;
  select quantity into total from purchase_receipt_lines where cin7_purchase_id = 'po-14939' and org_id = orgA;
  if total <> 380 then raise exception 'po-14939 quantity should be 380, got %', total; end if;

  -- 3. Repeated synchronisation is idempotent: same rows, same totals, no duplicated quantity.
  perform replace_purchase_detail(orgA, instA, 'po-14939', line_b, '[]'::jsonb, 'advanced-purchase', false);
  perform replace_purchase_detail(orgA, instA, 'po-14939', line_b, '[]'::jsonb, 'advanced-purchase', false);
  perform replace_purchase_detail(orgA, instA, 'po-09694', line_a, '[]'::jsonb, 'advanced-purchase', false);
  select count(*), sum(quantity) into n, total from purchase_receipt_lines where org_id = orgA and instance_id = instA;
  if n <> 2 or total <> 656 then raise exception 'repeat sync: expected 2 rows totalling 656, got % rows totalling %', n, total; end if;

  -- 4. Replacement is scoped to ONE PO: changing po-14939 leaves po-09694 untouched.
  perform replace_purchase_detail(orgA, instA, 'po-14939',
    '[{"card_id":"00000000-0000-0000-0000-000000000000","product_sku":"LBLINSTALLATIONNONIP","quantity":400,"received_date":"2026-10-29","location":"Main","location_id":"l1"}]'::jsonb,
    '[]'::jsonb, 'advanced-purchase', false);
  select quantity into total from purchase_receipt_lines where cin7_purchase_id = 'po-14939' and org_id = orgA;
  if total <> 400 then raise exception 'replacement should update po-14939 to 400, got %', total; end if;
  select quantity into total from purchase_receipt_lines where cin7_purchase_id = 'po-09694' and org_id = orgA;
  if total <> 276 then raise exception 'replacing po-14939 must not touch po-09694 (got %)', total; end if;

  -- 5. Within ONE PO the key is still unique (so the parser aggregation from #204 stays required),
  --    and a failed call is atomic: the previous rows survive.
  raised := false;
  begin
    perform replace_purchase_detail(orgA, instA, 'po-14939',
      '[{"card_id":"00000000-0000-0000-0000-000000000000","product_sku":"S","quantity":1,"received_date":"2026-10-29","location":"Main","location_id":"l1"},
        {"card_id":"00000000-0000-0000-0000-000000000000","product_sku":"S","quantity":2,"received_date":"2026-10-29","location":"Main","location_id":"l1"}]'::jsonb,
      '[]'::jsonb, 'advanced-purchase', false);
  exception when unique_violation then
    raised := true;
  end;
  if not raised then raise exception 'duplicate key within one PO should still raise unique_violation'; end if;
  select quantity into total from purchase_receipt_lines where cin7_purchase_id = 'po-14939' and org_id = orgA and product_sku = 'LBLINSTALLATIONNONIP';
  if total is distinct from 400 then raise exception 'atomicity: po-14939 previous row must survive the failed call, got %', total; end if;

  -- 6. Tenant isolation: the same cin7_purchase_id + nil card + SKU in another org/instance is independent.
  perform replace_purchase_detail(orgB, instB, 'po-09694', line_a, '[]'::jsonb, 'advanced-purchase', false);
  select count(*) into n from purchase_receipt_lines where cin7_purchase_id = 'po-09694' and card_id = nil and product_sku = 'LBLINSTALLATIONNONIP';
  if n <> 2 then raise exception 'tenant isolation: expected one po-09694 row per org (2), got %', n; end if;
  select count(*) into n from purchase_receipt_lines where org_id = orgA and instance_id = instA;
  if n <> 2 then raise exception 'tenant isolation: org A rows must be unchanged by org B sync, got %', n; end if;

  -- 7. Referential integrity: a receipt for a purchase that does not exist is rejected...
  raised := false;
  begin
    insert into purchase_receipt_lines (org_id, instance_id, cin7_purchase_id, card_id, product_sku, quantity)
      values (orgA, instA, 'no-such-po', nil, 'X', 1);
  exception when foreign_key_violation then
    raised := true;
  end;
  if not raised then raise exception 'receipt for a nonexistent purchase should violate the foreign key'; end if;

  -- ...and deleting one purchase cascades ONLY its own receipt rows.
  delete from purchases where org_id = orgA and instance_id = instA and cin7_purchase_id = 'po-14939';
  select count(*) into n from purchase_receipt_lines where org_id = orgA and instance_id = instA;
  if n <> 1 then raise exception 'cascade: only po-09694 should remain in org A, got % rows', n; end if;
  select count(*) into n from purchase_receipt_lines where org_id = orgB and instance_id = instB;
  if n <> 1 then raise exception 'cascade must not touch another tenant, got % rows', n; end if;
end $$;

-- 8. The migration's own procedure preserves every existing row: replay the exact steps on a scratch
--    table that starts with the OLD key and holds rows, then confirm count and contents are unchanged
--    and the new key now accepts what the old one rejected.
create temp table scratch_receipts (
  org_id uuid not null, instance_id uuid not null, cin7_purchase_id text not null, card_id text not null, product_sku text not null,
  quantity numeric, constraint scratch_receipts_pkey primary key (org_id, instance_id, card_id, product_sku)
) on commit drop;
insert into scratch_receipts values
  ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-a', '00000000-0000-0000-0000-000000000000', 'S1', 5),
  ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-a', 'card-2', 'S1', 7),
  ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-b', 'card-3', 'S2', 9);

do $$
declare before_sum numeric; after_sum numeric; before_n bigint; after_n bigint; raised boolean := false; ok boolean := true;
begin
  select count(*), sum(quantity) into before_n, before_sum from scratch_receipts;

  create unique index scratch_receipts_pkey_v2 on scratch_receipts (org_id, instance_id, cin7_purchase_id, card_id, product_sku);
  alter table scratch_receipts drop constraint scratch_receipts_pkey;
  alter table scratch_receipts add constraint scratch_receipts_pkey primary key using index scratch_receipts_pkey_v2;

  select count(*), sum(quantity) into after_n, after_sum from scratch_receipts;
  if after_n <> before_n or after_sum <> before_sum then raise exception 'migration steps must preserve every row (% -> %, % -> %)', before_n, after_n, before_sum, after_sum; end if;

  -- Same (nil card, SKU) under a DIFFERENT PO is now allowed...
  insert into scratch_receipts values ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-c', '00000000-0000-0000-0000-000000000000', 'S1', 11);
  -- ...but the same key under the SAME PO is still rejected.
  begin
    insert into scratch_receipts values ('00000000-0000-0000-0000-0000000124a1', '00000000-0000-0000-0000-0000000124b1', 'po-c', '00000000-0000-0000-0000-000000000000', 'S1', 1);
  exception when unique_violation then raised := true;
  end;
  if not raised then raise exception 'same-PO duplicate must still be rejected after the key change'; end if;
end $$;

do $$ begin raise notice 'ALL 0124 PURCHASE_RECEIPT_KEY ASSERTIONS PASSED'; end $$;

rollback;
