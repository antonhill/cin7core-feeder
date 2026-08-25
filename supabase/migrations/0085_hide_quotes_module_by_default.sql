-- Quotation + Margin module: ship hidden by default.
--
-- QUOTES_MODULE (href /quotes) is registered in module-nav's MODULES, so without
-- this it would be ON for every org (disabled_modules only lists explicitly-
-- disabled hrefs) — surfacing a not-yet-finished "Quotes" tab (a placeholder page;
-- the interactive builder lands in Phase 2) to every org member on the next deploy.
--
-- Decided with Anton 2026-08-25: seed every EXISTING org's disabled_modules with
-- the href now, so nobody gets a half-built module turned on by surprise. Exactly
-- mirrors 0065 (Picking Calendar), including its accepted gap: a brand-new org
-- signing up after this ships is NOT covered — the self-serve org RPC (0076)
-- leaves disabled_modules defaulting to '{}' (every module on), so a new org
-- starts with Quotes enabled; a super-admin opts it in/out per org via /admin.
-- Same tradeoff Anton accepted for Picking Calendar rather than adding a new
-- default mechanism. When Phase 2 ships the real builder, re-enable per org there.
--
-- Idempotent (guarded by the NOT ... = any(...) check) and additive — safe to
-- re-run and it never removes an org's other disabled modules.
update organizations
set disabled_modules = array_append(disabled_modules, '/quotes')
where not ('/quotes' = any(disabled_modules));
