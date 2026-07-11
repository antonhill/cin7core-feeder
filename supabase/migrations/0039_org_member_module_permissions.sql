-- Per-user, per-org module access — nullable, unlike organizations'
-- disabled_modules (not-null, default '{}'). NULL means "unrestricted": the
-- user sees every module the org itself allows, which is what every existing
-- row gets on this migration — nobody loses access on deploy. A non-null
-- array is an explicit allow-list of module hrefs (same href keys as
-- module-nav.tsx's MODULES, matching organizations.disabled_modules'
-- existing convention), intersected with the org's own disabled_modules —
-- an org-wide disable always wins even if a user's own allow-list includes
-- that module. See src/app/module-nav.tsx's computeEffectiveDisabledModules.
alter table org_members add column if not exists allowed_modules text[];
