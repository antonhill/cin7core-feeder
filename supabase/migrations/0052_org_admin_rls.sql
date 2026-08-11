-- Phase 0.3 / 0.4: DB-level admin-only RLS for privileged tables.
--
-- Two write policies claimed (by name / by their migration comment) to be
-- admin-only but actually checked is_org_member(org_id) — i.e. ANY org member:
--   * cin7_instances       "org admins manage instances"            (0001)
--   * purchase_planner_settings "org members manage ..."            (0051, comment says admin-only)
-- Both tables are written by the app only via the service-role client (which
-- bypasses RLS), so app behaviour is unchanged — this closes the gap where a
-- raw authenticated (anon-key) session could write/read these rows directly.
--
-- Audit of every other FOR ALL / write policy (2026-08-11): custom_reports
-- (0028) and pull_jobs (0047) are genuinely member-managed — their Server
-- Actions authorize with requireCurrentOrg(), so member-level RLS is correct,
-- not a mismatch. See docs/PROJECT-NOTES.md → "Authorization / RLS matrix".

-- Owner/admin membership check — mirrors is_org_member (0001) plus a role filter.
create or replace function is_org_admin(check_org_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members
    where org_id = check_org_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- cin7_instances: admin-only for EVERYTHING at the RLS layer. The app reads and
-- writes this table exclusively via the service-role client, so members lose no
-- functionality; a member with only an anon-key session can no longer read the
-- Account ID / encrypted application key or alter base_url directly. (The member
-- SELECT policy is defined in 0001 but was never present in production — this
-- also reconciles that drift.)
drop policy if exists "org members read instances" on cin7_instances;
drop policy if exists "org admins manage instances" on cin7_instances;
create policy "org admins manage instances" on cin7_instances for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- purchase_planner_settings: writes are a shared business-policy default that
-- only owners/admins should change (per 0051's own comment). SELECT stays
-- member-readable via the existing "org members read ..." policy.
drop policy if exists "org members manage purchase_planner_settings" on purchase_planner_settings;
create policy "org admins manage purchase_planner_settings" on purchase_planner_settings for all
  using (is_org_admin(org_id)) with check (is_org_admin(org_id));
