-- Per-org module visibility, set by a super-admin on /admin. An empty array
-- (the default) means every module is visible/enabled — no existing org's
-- access changes until a super-admin deliberately disables something.
-- Modules are identified by their nav href (e.g. "/reports"), the same key
-- already used in src/app/module-nav.tsx — no separate module-key enum.
alter table organizations add column if not exists disabled_modules text[] not null default '{}';
