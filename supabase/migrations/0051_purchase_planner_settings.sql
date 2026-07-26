-- Settable per-org defaults for Purchase Planner's import-supplier stock
-- floor (Anton, 2026-07-26): a client asked for reorder-qty suggestions on
-- import/USD suppliers to target holding 4 months of sales history, but
-- flagged this won't be the same for every client — so it's a per-org
-- setting, not a hardcoded constant. `home_currency` drives which suppliers
-- even count as "import" (any supplier whose Currency differs from it);
-- `import_stock_months` is the target. `home_currency` defaults to null
-- (the floor is off) rather than guessing a currency for a client who
-- hasn't configured it — a wrong guess here would silently distort real
-- purchasing suggestions.
create table if not exists purchase_planner_settings (
  org_id              uuid primary key references organizations (id) on delete cascade,
  home_currency       text,
  import_stock_months numeric not null default 4,
  updated_at          timestamptz not null default now()
);

alter table purchase_planner_settings enable row level security;

create policy "org members read purchase_planner_settings" on purchase_planner_settings for select using (is_org_member(org_id));
-- Write access gated to org admins at the application layer (requireOrgAdmin)
-- rather than here — same reasoning as custom_reports' own "manage" policy,
-- but narrower in practice since only org owners/admins should change a
-- shared business-policy default that affects every user's suggested
-- quantities, not just their own.
create policy "org members manage purchase_planner_settings" on purchase_planner_settings for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));
