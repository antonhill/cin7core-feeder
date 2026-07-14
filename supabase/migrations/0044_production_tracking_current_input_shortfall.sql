-- Kanban board alert: surface a current-stage input shortfall (this
-- order's active operation received less of the previous stage's
-- semi-finished output than Cin7 expected) directly on the card, without
-- fetching the full per-operation detail. Mirrors the existing
-- current_operation_name/current_work_center_name convention — a
-- redundant, cheap-to-read copy of the current operation's own
-- InputProducts figures. Nullable: null means the current stage's BOM
-- doesn't define Inputs/Outputs at all (not tracked), distinct from 0
-- (tracked, genuinely no shortfall).
alter table production_orders
  add column if not exists current_input_expected_qty numeric,
  add column if not exists current_input_actual_qty numeric,
  add column if not exists current_input_wastage_qty numeric;
