-- Tracks which instance(s) actually reported each category, so the Sales
-- report's Category filter can scope by instance without depending on
-- sale_lines (only populated once a sale's rate-limited detail sync has
-- finished — confirmed live 2026-07-11 to lag far enough behind that
-- deriving "which categories apply to instance X" from it came back empty
-- for most of an org's history, forcing a fallback to the full merged list
-- and defeating the whole point of scoping by instance).
--
-- categories itself stays merged-by-name/org-wide (Anton, 2026-07-11: two
-- different Cin7 accounts each having their own "Accessories" collapses
-- into one filter option) — this is purely an additional, accurate record
-- of provenance captured at the moment each instance's own category sync
-- runs, not a redesign of the categories table's own key.
create table if not exists category_instances (
  org_id      uuid not null,
  code        text not null,
  instance_id uuid not null references cin7_instances (id) on delete cascade,
  primary key (org_id, code, instance_id),
  foreign key (org_id, code) references categories (org_id, code) on delete cascade
);

create index if not exists category_instances_instance_idx on category_instances (org_id, instance_id);
