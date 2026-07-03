-- Without this, re-importing the same ProductionBOM CSV duplicates item rows
-- instead of upserting, breaking the idempotent-reimport guarantee.
alter table production_bom_items
  add constraint production_bom_items_natural_key
  unique (org_id, product_sku, version, operation_sequence, item_type, item_code);
