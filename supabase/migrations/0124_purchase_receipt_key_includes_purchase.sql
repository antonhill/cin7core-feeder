-- Receipt-line primary key must include the purchase order.
--
-- Root cause (confirmed live 2026-11-11): purchase_receipt_lines was keyed
-- (org_id, instance_id, card_id, product_sku) (0025). Cin7 returns the NIL CardID
-- (00000000-0000-0000-0000-000000000000) on some receipt lines, so lines from
-- DIFFERENT purchase orders share the same (card_id, product_sku). The first PO to
-- store a (nil, SKU) pair owned it; every later PO carrying that SKU failed its whole
-- replace_purchase_detail transaction with a duplicate-key error on
-- purchase_receipt_lines_pkey and stayed unsynced (10 Lights by Linea POs).
--
-- Fix: add cin7_purchase_id to the key. The new key is a strict SUPERSET of the old
-- one, so every existing row already satisfies it — no row can be rejected, merged
-- or rewritten; only the index backing the constraint changes. Within one PO the key
-- is still unique, so the parser's (CardID, SKU) aggregation (#204) remains required.
--
-- Safety:
--   * Single transaction; ACCESS EXCLUSIVE on this one small table (~19k rows) for
--     the index build — milliseconds. No table rebuild, no data copied or dropped.
--   * The unique index is built BEFORE the old constraint is dropped, then promoted
--     with USING INDEX, so there is never a moment without a uniqueness guarantee.
--   * The block raises (rolling everything back) if the row count changes.
--   * Nothing references this key: no foreign keys, views or triggers point at
--     purchase_receipt_lines; its only writer is replace_purchase_detail (delete-by-PO
--     then insert, no ON CONFLICT), which needs no change.
--
-- ROLLBACK (manual; do not run blindly): restoring the old key is only possible while
-- no (org_id, instance_id, card_id, product_sku) is shared by two POs. Check first:
--   select org_id, instance_id, card_id, product_sku, count(*) from purchase_receipt_lines
--   group by 1,2,3,4 having count(*) > 1;
-- If that returns rows, those cross-PO rows must be resolved (a lossy step) before:
--   alter table purchase_receipt_lines drop constraint purchase_receipt_lines_pkey;
--   alter table purchase_receipt_lines add primary key (org_id, instance_id, card_id, product_sku);
-- The safer rollback is to leave the key as is: application code works with either key.

do $$
declare
  rows_before bigint;
  rows_after bigint;
begin
  select count(*) into rows_before from purchase_receipt_lines;

  create unique index purchase_receipt_lines_pkey_v2
    on purchase_receipt_lines (org_id, instance_id, cin7_purchase_id, card_id, product_sku);

  alter table purchase_receipt_lines drop constraint purchase_receipt_lines_pkey;
  alter table purchase_receipt_lines add constraint purchase_receipt_lines_pkey primary key using index purchase_receipt_lines_pkey_v2;

  select count(*) into rows_after from purchase_receipt_lines;
  if rows_after <> rows_before then
    raise exception 'purchase_receipt_lines row count changed during key migration (% -> %)', rows_before, rows_after;
  end if;
end $$;

comment on constraint purchase_receipt_lines_pkey on purchase_receipt_lines is
  'One row per (org, instance, purchase, CardID, SKU). Includes the purchase because Cin7 returns the nil CardID on lines of many different POs.';
