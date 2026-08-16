-- P3 (LBL brief): Picking Calendar — a week-view board offset N working
-- days before Ship By, sharing Shipping Calendar's own board component and
-- write-back action (updateOrderShipByAction's Cin7 write, reused unchanged
-- for Picking's own gated action). Card population reuses is_pick_today
-- (report_order_fulfillment, migrations 0061-0063) unchanged per the
-- brief's own instruction — no new qualification logic, no new report
-- columns needed at all.
--
-- offset_days is a per-org setting (default 1, range 0-7 per the brief),
-- mirroring purchase_planner_settings' shape (0051) exactly: a shared
-- business-policy default, not a personal preference, so writes are gated
-- to org admins at the application layer (requireOrgAdmin) rather than
-- here.
create table if not exists picking_calendar_settings (
  org_id      uuid primary key references organizations (id) on delete cascade,
  offset_days numeric not null default 1 check (offset_days >= 0 and offset_days <= 7),
  updated_at  timestamptz not null default now()
);

alter table picking_calendar_settings enable row level security;

create policy "org members read picking_calendar_settings" on picking_calendar_settings for select using (is_org_member(org_id));
create policy "org members manage picking_calendar_settings" on picking_calendar_settings for all
  using (is_org_member(org_id)) with check (is_org_member(org_id));

-- Off-by-default (brief requirement): unlike every other report under
-- /reports/*, Picking Calendar gets its OWN org-toggleable module entry
-- (PICKING_CALENDAR_MODULE, href /reports/picking-calendar) rather than
-- riding on the single "Reporting" toggle every other report shares — see
-- reports/layout.tsx's own comment on why that's normally the convention,
-- and PROJECT-NOTES.md for why this one report breaks it. Decided with
-- Anton 2026-08-16: seed every EXISTING org's disabled_modules with the new
-- href now (so nobody gets it turned on by surprise). This does NOT cover a
-- brand-new org signing up after this ships — disabled_modules there
-- defaults to '{}' (every module on) per src/app/signup/actions.ts, so a new
-- org starts with Picking Calendar enabled; a super-admin opts it in or out
-- per org via /admin, same as onboarding any other client-specific
-- capability today. Anton accepted that gap rather than adding a new
-- mechanism just for this one module's default.
update organizations
set disabled_modules = array_append(disabled_modules, '/reports/picking-calendar')
where not ('/reports/picking-calendar' = any(disabled_modules));
