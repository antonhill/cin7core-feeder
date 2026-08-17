-- Security re-audit P0-5/P0-6-class fix: reconstructs RLS on
-- category_instances (0037), which was enabled directly on production at
-- some point with no corresponding migration file ever committed — the
-- exact "manual live change with no migration" gap this re-audit is
-- specifically checking for. Confirmed live (2026-08-17) via
-- pg_class.relrowsecurity / pg_policy that production ALREADY has RLS
-- enabled and exactly one policy, "org admins manage category_instances",
-- for ALL commands using is_org_member(org_id) — this migration reproduces
-- that exact state so a blank project ends up identical, and is a genuine
-- no-op against production (`enable row level security` is idempotent;
-- `drop policy if exists` + recreate the same policy is the established
-- idiom this repo already uses for exactly this situation, see
-- 0060_drop_redundant_select_policies.sql).
--
-- category_instances is written only by syncInstanceSales (service-role
-- client) and read only by getReportFilterOptions (also always a
-- service-role client) — confirmed via repo-wide grep, no browser/client
-- component ever queries it directly. Service-role bypasses RLS
-- entirely, so this policy only matters as a backstop against the
-- anon/authenticated PostgREST roles, which have no legitimate reason to
-- reach this table at all.
alter table category_instances enable row level security;

drop policy if exists "org admins manage category_instances" on category_instances;
create policy "org admins manage category_instances" on category_instances for all using (is_org_member(org_id));
