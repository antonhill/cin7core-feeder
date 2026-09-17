-- Warehouse Performance Scorecard — generic scoring engine.
--
-- Built for Lights by Linea's Warehouse Review Scorecard, but deliberately
-- NOT LBL-specific: scorecard_definitions/sections/metric_definitions are
-- reusable templates, not org-scoped, so a second client can receive a
-- different scorecard later without duplicating this schema. Which org
-- actually sees a definition is organization_scorecards — see that table's
-- own comment for why no org id is hardcoded anywhere in this migration.
--
-- Evidence-source vs scoring-method split (see 0093's actions/UI): a metric
-- definition records BOTH (a) whether Toolbox or a reviewer supplies the
-- actual/evidence, and (b) whether the 0-10 score is derived by a configured
-- rule or entered/confirmed by a reviewer. These are independent axes — e.g.
-- Ship By compliance can have Toolbox calculate the % automatically while a
-- reviewer still assigns the score, because no percentage-to-score mapping
-- has been approved yet. Never invent a RULE scoring_config merely because a
-- metric's evidence happens to be AUTOMATED.

create type scorecard_review_status as enum ('draft', 'final');
create type scorecard_evidence_source as enum ('AUTOMATED', 'MANUAL');
create type scorecard_scoring_method as enum ('RULE', 'REVIEWER');
create type scorecard_metric_direction as enum ('HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'TARGET_RANGE', 'REVIEW_ONLY');
create type scorecard_action_status as enum ('open', 'completed');

-- ── Templates (not org-scoped) ────────────────────────────────────────────

create table if not exists scorecard_definitions (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  review_frequency text not null default 'monthly',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists scorecard_sections (
  id                      uuid primary key default gen_random_uuid(),
  scorecard_definition_id uuid not null references scorecard_definitions (id) on delete cascade,
  name                    text not null,
  -- Fraction of the overall score, not a percentage — 0.20 means 20%.
  -- Enforced to sum to 1.0 per definition by the trigger below, so the
  -- overall Warehouse Health Score can never be typed independently of its
  -- headline weights (brief §3: "Do not allow users to manually type the
  -- overall score").
  weight                  numeric not null check (weight > 0 and weight <= 1),
  display_order           int not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists scorecard_sections_definition_idx on scorecard_sections (scorecard_definition_id, display_order);

-- Statement-level check that every scorecard_definition's section weights
-- sum to 1.0 (within floating-point tolerance), re-evaluated after each
-- INSERT/UPDATE/DELETE statement against the definitions that statement
-- touched. Transition tables require a statement-level (not row-level)
-- trigger, and Postgres does not support deferring a statement-level
-- trigger — so any caller that rebalances several sections' weights at once
-- MUST do it in a single multi-row statement (one upsert call with an
-- array, not one UPDATE per row), the same discipline this codebase already
-- uses elsewhere for an atomic whole-array replace (e.g.
-- setOrgDisabledModules). The seed migration below inserts all six LBL
-- sections in one statement for exactly this reason.
-- Three separate functions, not one shared body: a transition-table name
-- (old_table/new_table) is only a valid identifier in the specific trigger
-- invocation that bound it, so a single body referencing both would fail
-- whenever fired by an INSERT-only or DELETE-only statement.
create or replace function check_scorecard_section_weights_on_upsert() returns trigger language plpgsql set search_path = public as $$
declare
  affected_ids uuid[];
  bad_id uuid;
  bad_total numeric;
begin
  select array_agg(distinct scorecard_definition_id) into affected_ids from new_table;
  if affected_ids is null then
    return null;
  end if;

  select scorecard_definition_id, sum(weight) into bad_id, bad_total
  from scorecard_sections
  where scorecard_definition_id = any (affected_ids)
  group by scorecard_definition_id
  having abs(sum(weight) - 1.0) > 0.0001
  limit 1;

  if bad_id is not null then
    raise exception 'scorecard_sections for definition % must sum to 1.0 (got %)', bad_id, bad_total;
  end if;

  return null;
end;
$$;

create or replace function check_scorecard_section_weights_on_delete() returns trigger language plpgsql set search_path = public as $$
declare
  affected_ids uuid[];
  bad_id uuid;
  bad_total numeric;
begin
  select array_agg(distinct scorecard_definition_id) into affected_ids from old_table;
  if affected_ids is null then
    return null;
  end if;

  -- A definition whose sections were ALL removed (e.g. cascaded from
  -- deleting the scorecard_definitions row itself) has no remaining group
  -- to check, which is correct — nothing left to be inconsistent.
  select scorecard_definition_id, sum(weight) into bad_id, bad_total
  from scorecard_sections
  where scorecard_definition_id = any (affected_ids)
  group by scorecard_definition_id
  having abs(sum(weight) - 1.0) > 0.0001
  limit 1;

  if bad_id is not null then
    raise exception 'scorecard_sections for definition % must sum to 1.0 (got %)', bad_id, bad_total;
  end if;

  return null;
end;
$$;

create trigger scorecard_section_weights_insert
  after insert on scorecard_sections
  referencing new table as new_table
  for each statement execute function check_scorecard_section_weights_on_upsert();

create trigger scorecard_section_weights_update
  after update on scorecard_sections
  referencing new table as new_table
  for each statement execute function check_scorecard_section_weights_on_upsert();

create trigger scorecard_section_weights_delete
  after delete on scorecard_sections
  referencing old table as old_table
  for each statement execute function check_scorecard_section_weights_on_delete();

create table if not exists scorecard_metric_definitions (
  id                  uuid primary key default gen_random_uuid(),
  scorecard_section_id uuid not null references scorecard_sections (id) on delete cascade,
  category            text not null,
  name                text not null,
  target_text         text,
  evidence_source      scorecard_evidence_source not null,
  scoring_method       scorecard_scoring_method not null,
  metric_direction     scorecard_metric_direction not null,
  -- Required and shaped only when scoring_method = 'RULE': {"bands": [{"min":
  -- <numeric threshold>, "score": <0-10>}, ...]}, evaluated against the
  -- evidence value using metric_direction to decide which way "min" compares.
  -- Null whenever scoring_method = 'REVIEWER' — never invented just because
  -- evidence_source happens to be AUTOMATED (see this migration's header).
  scoring_config       jsonb,
  -- Fraction of the section's own weight this KPI carries. Null = "equal
  -- weighting among this section's active metrics" (brief §6's default),
  -- resolved at score-computation time in application code, not stored here
  -- — so adding/retiring a KPI never requires rewriting every sibling's
  -- stored weight.
  weight               numeric check (weight is null or (weight > 0 and weight <= 1)),
  display_order        int not null default 0,
  active               boolean not null default true,
  -- Free-text provenance for a value pulled from the source workbook that
  -- could not be safely associated with certainty, or an operational
  -- comment from the workbook that doesn't correspond to a rule (brief
  -- §13/§16) — never turned into scoring logic, shown only as context.
  source_note          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint scorecard_metric_scoring_config_required
    check (scoring_method = 'REVIEWER' or (scoring_method = 'RULE' and scoring_config is not null))
);

create index if not exists scorecard_metric_definitions_section_idx on scorecard_metric_definitions (scorecard_section_id, display_order);

alter table scorecard_definitions enable row level security;
alter table scorecard_sections enable row level security;
alter table scorecard_metric_definitions enable row level security;

-- Read-only to any signed-in user, like quotes/custom_reports — these rows
-- are generic KPI definitions, not tenant data, so there is nothing to
-- scope by org. Writes go through the service role only, from a
-- super-admin-gated Server Action (brief §12: "alter master scorecard
-- definitions... only where consistent with existing architecture") — no
-- INSERT/UPDATE/DELETE policy exists here, matching category_instances'
-- service-role-only precedent for sensitive shared configuration.
create policy "authenticated users read scorecard_definitions" on scorecard_definitions for select using (auth.uid() is not null);
create policy "authenticated users read scorecard_sections" on scorecard_sections for select using (auth.uid() is not null);
create policy "authenticated users read scorecard_metric_definitions" on scorecard_metric_definitions for select using (auth.uid() is not null);

-- ── Org assignment (org-scoped) ───────────────────────────────────────────

-- Which scorecard(s) an organization has, and whether it's switched on.
-- Deliberately the ONLY place an org and a scorecard meet — no org id is
-- hardcoded anywhere in this feature (see Natas Sold's own note: a
-- hardcoded single-org constant is an explicitly non-reusable one-off, and
-- its own prescribed exit route if ever generalized is exactly this kind of
-- per-org table). Assigning Lights by Linea's actual organization row here
-- is a post-deploy super-admin configuration step, not a migration seed —
-- this migration does not know LBL's real organization id and must not
-- guess it.
create table if not exists organization_scorecards (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations (id) on delete cascade,
  scorecard_definition_id uuid not null references scorecard_definitions (id) on delete cascade,
  enabled                 boolean not null default true,
  settings                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, scorecard_definition_id)
);

-- At most one ENABLED scorecard per org at a time — Phase 1's dashboard
-- assumes a single active scorecard per organization; a disabled row can
-- coexist (e.g. kept for history) without violating this.
create unique index if not exists organization_scorecards_one_enabled_idx
  on organization_scorecards (organization_id) where enabled;

alter table organization_scorecards enable row level security;
create policy "org members read organization_scorecards" on organization_scorecards for select using (is_org_member(organization_id));

-- ── Reviews and results (org-scoped) ──────────────────────────────────────

create table if not exists scorecard_reviews (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations (id) on delete cascade,
  scorecard_definition_id uuid not null references scorecard_definitions (id) on delete cascade,
  -- First day of the reviewed month — "2026-09-01" for the September 2026
  -- review. A date column (not text) so ordering/comparison is trivial;
  -- always normalised to the 1st by application code.
  review_period           date not null,
  status                  scorecard_review_status not null default 'draft',
  -- Null while draft or while no KPI has a RULE/entered score yet — never
  -- coerced to 0 (brief §16/§21: a missing score must be visibly distinct
  -- from a poor one). Computed by the application scoring engine, never
  -- typed directly (brief §3/§14).
  overall_score           numeric check (overall_score is null or (overall_score >= 0 and overall_score <= 10)),
  -- Populated only at finalisation — the full effective KPI/section/weight/
  -- scoring-config snapshot this review's scores were computed against, so
  -- a later change to scorecard_metric_definitions can never rewrite
  -- history (brief §11, non-negotiable). See scorecard-snapshot.ts for the
  -- exact shape.
  definition_snapshot     jsonb,
  created_by              uuid,
  finalised_by            uuid,
  finalised_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, scorecard_definition_id, review_period),
  constraint scorecard_reviews_final_has_snapshot
    check (status = 'draft' or (definition_snapshot is not null and finalised_at is not null))
);

create index if not exists scorecard_reviews_org_period_idx on scorecard_reviews (organization_id, scorecard_definition_id, review_period desc);

-- Blocks the specific mutation this feature must never allow: once a review
-- is 'final', none of the columns a historical score depends on may change
-- again (brief §11's own words: "its KPI scores must not change ... its
-- overall Warehouse Health Score must not change"). Only scorecard_actions
-- linked to a finalised review, or activity elsewhere, may still evolve —
-- this trigger only touches scorecard_reviews itself.
create or replace function prevent_finalised_review_mutation() returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'final' and (
    new.overall_score is distinct from old.overall_score
    or new.definition_snapshot is distinct from old.definition_snapshot
    or new.scorecard_definition_id is distinct from old.scorecard_definition_id
    or new.review_period is distinct from old.review_period
    or new.organization_id is distinct from old.organization_id
    or new.status is distinct from old.status
  ) then
    raise exception 'scorecard_reviews %: a finalised review is immutable', old.id;
  end if;
  return new;
end;
$$;

create trigger scorecard_reviews_prevent_finalised_mutation
  before update on scorecard_reviews
  for each row execute function prevent_finalised_review_mutation();

create table if not exists scorecard_metric_results (
  id                    uuid primary key default gen_random_uuid(),
  review_id             uuid not null references scorecard_reviews (id) on delete cascade,
  metric_definition_id  uuid not null references scorecard_metric_definitions (id) on delete restrict,
  -- Numeric evidence (a percentage, a count, an age in days) when the
  -- metric has one; null for a purely qualitative manual assessment.
  actual_numeric        numeric,
  -- Free-text evidence/context when a number alone doesn't capture it, or
  -- the ONLY evidence for a REVIEW_ONLY metric.
  actual_text           text,
  -- Structured provenance for an AUTOMATED metric — eligible/matching/
  -- excluded counts, the query window, etc. (brief §13's evidence pattern).
  -- Null for a MANUAL metric, which has no computed provenance to show.
  evidence              jsonb,
  -- Null = Not Scored — never 0 (brief §5/§16/§21). Written only by the
  -- scoring engine (RULE) or a reviewer's explicit entry (REVIEWER), never
  -- typed independently of how it was derived.
  score                 numeric check (score is null or (score >= 0 and score <= 10)),
  -- Derived from score by the shared status-band function at write time —
  -- stored (not recomputed on read) so a finalised review's status can
  -- never drift if the bands are ever revisited. 'not_scored' when score
  -- is null.
  status                text not null default 'not_scored'
    check (status in ('strong', 'acceptable', 'needs_attention', 'serious_weakness', 'critical', 'not_scored')),
  comment               text,
  owner                 text,
  reviewer_id           uuid,
  calculated_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (review_id, metric_definition_id)
);

create index if not exists scorecard_metric_results_review_idx on scorecard_metric_results (review_id);

create or replace function prevent_finalised_result_mutation() returns trigger language plpgsql set search_path = public as $$
declare
  review_status scorecard_review_status;
begin
  select status into review_status from scorecard_reviews where id = coalesce(new.review_id, old.review_id);
  if review_status = 'final' then
    raise exception 'scorecard_metric_results for review %: the review is finalised and its results are immutable', coalesce(new.review_id, old.review_id);
  end if;
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger scorecard_metric_results_prevent_finalised_mutation
  before update or delete on scorecard_metric_results
  for each row execute function prevent_finalised_result_mutation();

alter table scorecard_reviews enable row level security;
alter table scorecard_metric_results enable row level security;
create policy "org members read scorecard_reviews" on scorecard_reviews for select using (is_org_member(organization_id));
create policy "org members read scorecard_metric_results" on scorecard_metric_results for select using (
  exists (select 1 from scorecard_reviews r where r.id = scorecard_metric_results.review_id and is_org_member(r.organization_id))
);

-- ── Corrective actions (org-scoped, generic to the scorecard engine) ─────

-- Deliberately new: the repo has no existing task/action-tracking mechanism
-- (no owner/due_date/status/completed_at table anywhere — confirmed by
-- exhaustive search before this migration was written) and activity_log is
-- append-only with no lifecycle, so it is the wrong fit for something that
-- must be openable, overdue-trackable and completable. Kept generic to the
-- scorecard engine (not warehouse-specific) per brief §10/§12.
create table if not exists scorecard_actions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  review_id        uuid references scorecard_reviews (id) on delete set null,
  metric_result_id uuid references scorecard_metric_results (id) on delete set null,
  title            text not null,
  description      text,
  owner            text,
  due_date         date,
  status           scorecard_action_status not null default 'open',
  completed_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint scorecard_actions_completed_at_matches_status
    check ((status = 'completed') = (completed_at is not null))
);

create index if not exists scorecard_actions_org_status_idx on scorecard_actions (organization_id, status, due_date);

alter table scorecard_actions enable row level security;
create policy "org members read scorecard_actions" on scorecard_actions for select using (is_org_member(organization_id));
