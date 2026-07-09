-- Confirmed live 2026-07-09: a real sync run hit "duplicate key value
-- violates unique constraint purchase_receipt_lines_pkey" on a purchase
-- whose receiptLines array had two rows sharing the same CardID before
-- either ever reached the DB (no (org_id, instance_id, card_id) duplicate
-- exists in already-committed data — the PK correctly blocked it, which is
-- exactly why the insert failed atomically instead of silently dropping
-- one row). CardID evidently identifies a receiving *batch/transaction*,
-- which can cover more than one SKU, not a single line — widening the key
-- to (org_id, instance_id, card_id, product_sku) so a multi-SKU batch's
-- lines can all be stored.

alter table purchase_receipt_lines drop constraint purchase_receipt_lines_pkey;
alter table purchase_receipt_lines add primary key (org_id, instance_id, card_id, product_sku);
