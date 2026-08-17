-- Security re-audit round 3, item 5 (RLS policy-intent audit): fixes a real,
-- directly-exploitable DB-level bypass. Four admin-only settings tables and
-- three service-only log/queue tables shipped with an `is_org_member` ALL
-- policy while every Server Action that writes them enforces `requireOrgAdmin`
-- (or, for the log/queue tables, never writes them from a client role at all)
-- -- meaning any ordinary org member could bypass the Server Action gate
-- entirely with a direct PostgREST call using their own valid session token.
-- Each admin-settings migration's own comment already stated the intended
-- design ("Write access gated to org admins at the application layer
-- (requireOrgAdmin)") but the policy itself never matched that intent -- this
-- migration makes the policy match the comment, following the already-correct
-- precedent set by `purchase_planner_settings` (0053) and `cin7_instances`.

-- Admin-only settings: keep the existing member-level SELECT policy (reads
-- are correctly member-level everywhere in the app), replace the ALL policy
-- so writes require is_org_admin instead of is_org_member.
drop policy if exists "org members manage ship_by_notification_settings" on ship_by_notification_settings;
create policy "org admins manage ship_by_notification_settings" on ship_by_notification_settings
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

drop policy if exists "org members manage ship_by_notification_reps" on ship_by_notification_reps;
create policy "org admins manage ship_by_notification_reps" on ship_by_notification_reps
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

drop policy if exists "org members manage bom_alert_settings" on bom_alert_settings;
create policy "org admins manage bom_alert_settings" on bom_alert_settings
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

drop policy if exists "org members manage picking_calendar_settings" on picking_calendar_settings;
create policy "org admins manage picking_calendar_settings" on picking_calendar_settings
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- Service-managed log/queue tables: no UI ever reads or writes these client-
-- side (confirmed by repo-wide search -- only src/lib/ship-by-notifications.ts
-- and src/lib/bom-alerts.ts, both service-role, touch them). Drop BOTH
-- policies entirely rather than tightening the write policy, matching the
-- billing_checkout_tokens (0077) precedent: RLS enabled, zero policies,
-- service-role only. This is strictly tighter than "admin-write, member-
-- read" -- there is no legitimate client-side reason to read an internal
-- notification-debounce/audit-trail row either.
drop policy if exists "org members manage ship_by_change_pending" on ship_by_change_pending;
drop policy if exists "org members read ship_by_change_pending" on ship_by_change_pending;

drop policy if exists "org members manage ship_by_change_notifications" on ship_by_change_notifications;
drop policy if exists "org members read ship_by_change_notifications" on ship_by_change_notifications;

drop policy if exists "org members manage bom_alert_notifications" on bom_alert_notifications;
drop policy if exists "org members read bom_alert_notifications" on bom_alert_notifications;

-- Defense in depth: the browser Supabase client is confirmed auth-only in
-- this app (every data table is read/written through Server Actions using
-- the service-role client) -- anon has no legitimate reason to touch any
-- public table, and RLS already returns false for anon on every policy here
-- (is_org_member/is_org_admin key off auth.uid(), null for anon). Revoking
-- the broad default grant removes an unaudited standing capability rather
-- than changing any actual behavior.
revoke all on all tables in schema public from anon;
