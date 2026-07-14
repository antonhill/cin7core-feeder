-- Production Tracking: Kanban board view — adds the columns needed for
-- work-centre column ordering and the two client asks (wastage carried
-- forward, cost value-add per stage). See src/reports/production-tracking
-- /build.ts's groupByWorkCentre/cumulativeCostThroughStage.
--
-- All nullable, no default — null means "not tracked for this stage" (no
-- Cin7 "Inputs and Outputs" configured on this BOM,
-- help.core.cin7.com/hc/en-us/articles/9034587837839), distinct from 0
-- ("configured, genuinely zero"). Most BOMs won't define Inputs/Outputs at
-- all (Cin7's own docs: "it is not necessary to include input/output in a
-- Production BOM") — the UI shows an honest "not tracked" rather than a
-- synthetic estimate when these stay null.
alter table production_orders add column if not exists current_operation_order int;

alter table production_operations add column if not exists actual_material_cost numeric;
alter table production_operations add column if not exists input_expected_qty numeric;
alter table production_operations add column if not exists input_actual_qty numeric;
alter table production_operations add column if not exists input_wastage_qty numeric;
alter table production_operations add column if not exists output_qty numeric;
