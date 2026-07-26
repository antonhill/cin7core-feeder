-- Tracks which (product, supplier, location) lines this app has already
-- created a real Cin7 Purchase Order for, so Supplier Planner can flag them
-- and avoid an accidental duplicate PO — Anton asked (2026-07-26) to
-- surface "already ordered, pending authorization" before a user re-selects
-- the same lines.
--
-- Cin7's own `on_order` figure (product_availability, already used
-- elsewhere in this report) does NOT reliably reflect a still-DRAFT PO —
-- every PO this app creates is deliberately left DRAFT (a human authorizes
-- it in Cin7), so there's a real window where a genuinely-created order
-- wouldn't show up as "on order" yet. This table is this app's own memory
-- of what it just wrote, not a replacement for Cin7's own on_order.
--
-- Whether a tracked line is still "pending" (not yet authorized) is
-- resolved at read time by joining cin7_purchase_id against the already-
-- synced `purchases` table's own `status` column (confirmed live to carry
-- DRAFT/AUTHORISED/VOIDED, src/cin7/purchases.ts) — not duplicated here,
-- since that would drift out of sync with Cin7's own real state.
create table if not exists supplier_plan_created_po_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  cin7_purchase_id text not null,
  order_number     text,
  supplier_id      text not null,
  location_id      text not null,
  product_sku      text not null,
  created_at       timestamptz not null default now()
);

create index if not exists supplier_plan_created_po_lines_lookup_idx
  on supplier_plan_created_po_lines (org_id, instance_id, product_sku, supplier_id, location_id);

alter table supplier_plan_created_po_lines enable row level security;

create policy "org members read supplier_plan_created_po_lines" on supplier_plan_created_po_lines for select using (is_org_member(org_id));
