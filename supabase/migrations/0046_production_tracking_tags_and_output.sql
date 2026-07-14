-- tags: Cin7's own Production Order Tags field (confirmed live 2026-07-14,
-- MO-00042: "Anton Hill Order: 23424324") — free-text, commonly used to
-- note which customer/sales order a production run is for. Displayed on
-- the Kanban card so that's identifiable at a glance without opening the
-- order.
--
-- actual_output_qty: the real finished-goods quantity actually produced,
-- from the terminal operation's own FinishedProducts.OutputQuantity — a
-- THIRD, later checkpoint distinct from the WIP Input/Output figures
-- already tracked (production_operations.input_actual_qty/output_qty),
-- only populated once the order's finished-good output is recorded.
-- Nullable: null means no operation on this order defines FinishedProducts
-- at all yet (not tracked), distinct from 0 (tracked, zero produced so far).
alter table production_orders
  add column if not exists tags text,
  add column if not exists actual_output_qty numeric;
