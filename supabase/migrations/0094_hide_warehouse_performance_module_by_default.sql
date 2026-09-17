-- Warehouse Performance module: ship hidden by default, exactly mirroring
-- 0065 (Picking Calendar) and 0085 (Quotes). WAREHOUSE_PERFORMANCE_MODULE
-- (href /warehouse-performance) is registered in module-nav's MODULES, so
-- without this it would be ON for every org on the next deploy — surfacing
-- an LBL-specific scorecard to organisations it was never built for.
--
-- No org id is hardcoded here or anywhere in this feature (see
-- 0092_warehouse_performance_scorecard.sql's own comment on
-- organization_scorecards). Enabling the module for LBL's actual
-- organisation, AND assigning it the "Lights by Linea — Warehouse
-- Performance" scorecard_definition via organization_scorecards, are both
-- separate, deliberate super-admin configuration steps after this deploys —
-- not something this migration can do, since it does not know LBL's real
-- organisation id.
--
-- Same accepted gap as 0065/0085: a brand-new org signing up after this
-- ships is NOT covered (disabled_modules defaults to '{}' on the self-serve
-- org RPC), so it starts with this module enabled; a super-admin opts it in
-- or out per org via /admin, same as onboarding any other client-specific
-- capability today.
update organizations
set disabled_modules = array_append(disabled_modules, '/warehouse-performance')
where not ('/warehouse-performance' = any(disabled_modules));
