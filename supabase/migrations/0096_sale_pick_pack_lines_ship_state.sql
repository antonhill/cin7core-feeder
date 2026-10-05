-- Persist the owning fulfilment's Ship state next to its pick/pack lines.
--
-- WHY: the Warehouse Performance "Invoiced but Not Shipped" queue was
-- qualifying on the order-level combined_shipping_status label, which says
-- nothing about WHICH quantity has shipped. SO-19948 (invoiced 8, shipped 8,
-- 1 unit backordered) showed up as "invoiced but not shipped" purely because
-- Cin7 labels the order PARTIALLY SHIPPED while the backorder is open.
--
-- WHAT THE LIVE CIN7 CONTRACT IS (verified 2026-10-05 against 9 real LBL
-- orders / 18 fulfilments through the read-only Ship-contract diagnostic,
-- PR #113): shipment is recorded PER FULFILMENT. Fulfilments[].Ship carries a
-- Status (AUTHORISED / VOIDED / DRAFT / NOT AVAILABLE observed) and Ship.Lines
-- that hold ONLY ShipmentDate, Carrier, Boxes, TrackingNumber, TrackingURL,
-- IsShipped — no SKU, no quantity, no pack-line identifier. In every sampled
-- AUTHORISED fulfilment the fulfilment's whole packed quantity equalled its
-- linked invoice's quantity and IsShipped was true. PARTIALLY AUTHORISED was
-- NOT observed; it must be treated as ambiguous until a safe quantity
-- derivation is proven (box identifiers were "1" on every line and cannot map
-- a shipped subset to pack lines).
--
-- Therefore two nullable columns, denormalised onto every pick/pack line of the
-- fulfilment exactly as the existing `status` column already is (no new table,
-- no new RLS — the table keeps its org_id/instance_id scoping and policies):
--   ship_status  the owning fulfilment's Ship.Status, verbatim.
--   shipped_at   the Ship line ShipmentDate, ONLY where IsShipped = true.
--
-- NULL ship_status means "not yet synced with ship state" and is UNKNOWN —
-- never "shipped" and never "unshipped". Existing rows are NULL until their
-- sale's detail is re-synced (a targeted backfill, not a full re-sync).
--
-- Additive and nullable: nothing reads these columns until a later migration
-- redefines the queue on them, so applying this migration alone changes no
-- behaviour.
--
-- NOTE: applied to production on 2026-10-05 (via the Supabase migration tool,
-- recorded as sale_pick_pack_lines_ship_state) AHEAD of the sync code that
-- populates it, so this file exists to keep the repo's migration history and a
-- clean bootstrap in step with production. It is idempotent (if not exists).

alter table sale_pick_pack_lines
  add column if not exists ship_status text,
  add column if not exists shipped_at date;

comment on column sale_pick_pack_lines.ship_status is
  'Owning fulfilment''s Cin7 Ship.Status (AUTHORISED / PARTIALLY AUTHORISED / VOIDED / DRAFT / NOT AVAILABLE ...), verbatim. NULL = not yet synced = UNKNOWN.';
comment on column sale_pick_pack_lines.shipped_at is
  'Ship line ShipmentDate where IsShipped = true for the owning fulfilment; NULL otherwise.';
