-- Kanban card: "how many did it start with" — the Run's own Quantity
-- field, confirmed live on MO-00019's real response ("Quantity": 1 on the
-- Run object). Nullable — null until the first successful run-detail
-- fetch, same convention as the other run-derived columns on this table.
alter table production_orders add column if not exists planned_quantity numeric;
