-- Warehouse Performance: audited reversal of a finalised review, and a database-
-- enforced rule that a Final review always carries a score.
--
-- WHY. November 2026 reached status='final' with overall_score NULL and zero KPI
-- results: finalizeReviewAction never validated completeness, the scoring engine
-- (correctly) returns NULL when nothing is scored, and the 0092 CHECK only
-- required a snapshot + timestamp. The 0092 immutability trigger then made the
-- mistake permanent. This migration (a) records every finalisation/reversal in an
-- append-only trail, (b) adds the ONLY sanctioned Final -> Draft path, and (c)
-- moves finalisation into one atomic function that re-checks completeness itself.
--
-- MIGRATION NUMBER. 0121 is the next number above every migration claimed on any
-- branch at the time of writing (NewQuip streams use 0107-0120). Re-check at merge.
-- Touches only scorecard_* objects; nothing NewQuip or RWTSA reads or writes.

-- ── Audit trail (append-only) ────────────────────────────────────────────

create table if not exists scorecard_review_events (
  id                  uuid primary key default gen_random_uuid(),
  review_id           uuid not null references scorecard_reviews (id) on delete cascade,
  organization_id     uuid not null references organizations (id) on delete cascade,
  event_type          text not null check (event_type in ('finalised', 'finalisation_reversed')),
  previous_status     scorecard_review_status,
  new_status          scorecard_review_status not null,
  -- Who performed THIS event (the finaliser, or the person who reversed it).
  actor_user_id       uuid,
  -- Mandatory for a reversal.
  reason              text,
  -- For 'finalised': the score/snapshot written. For 'finalisation_reversed': the
  -- score/snapshot/submitter/date of the finalisation being reversed, so the
  -- original submission survives the review row being reset to draft.
  overall_score       numeric,
  original_finalised_by uuid,
  original_finalised_at timestamptz,
  definition_snapshot jsonb,
  occurred_at         timestamptz not null default now(),
  constraint scorecard_review_events_reversal_has_reason
    check (event_type <> 'finalisation_reversed' or (reason is not null and length(btrim(reason)) >= 5))
);

create index if not exists scorecard_review_events_review_idx on scorecard_review_events (review_id, occurred_at);

alter table scorecard_review_events enable row level security;
create policy "org members read scorecard_review_events" on scorecard_review_events for select using (is_org_member(organization_id));

-- Audit trail hardening: Supabase's default privileges would give the browser roles write and TRUNCATE
-- on every new table. RLS already denies API writes (no write policy), but TRUNCATE bypasses row
-- triggers, so the append-only guarantee must not rely on RLS alone. Browser roles are read-only;
-- only the service role (the server actions' database functions) can write.
revoke all on table scorecard_review_events from anon, authenticated;
grant select on table scorecard_review_events to authenticated;

-- Append-only: no UPDATE ever; DELETE only when it is the cascade of the parent
-- review/organization being removed (trigger depth > 1), never a direct delete.
create or replace function prevent_scorecard_review_event_mutation() returns trigger language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    raise exception 'scorecard_review_events is append-only';
  end if;
  if TG_OP = 'DELETE' and pg_trigger_depth() <= 1 then
    raise exception 'scorecard_review_events is append-only';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger scorecard_review_events_append_only
  before update or delete on scorecard_review_events
  for each row execute function prevent_scorecard_review_event_mutation();

-- Backfill the original finalisations that predate this table so they stay
-- auditable (October 2026 and the November 2026 record). Idempotent.
insert into scorecard_review_events (review_id, organization_id, event_type, previous_status, new_status, actor_user_id, overall_score, original_finalised_by, original_finalised_at, definition_snapshot, occurred_at)
select r.id, r.organization_id, 'finalised', 'draft', 'final', r.finalised_by, r.overall_score, r.finalised_by, r.finalised_at, r.definition_snapshot, coalesce(r.finalised_at, now())
from scorecard_reviews r
where r.status = 'final'
  and not exists (select 1 from scorecard_review_events e where e.review_id = r.id);

-- ── A Final review must have a score ─────────────────────────────────────

-- NOT VALID: enforced for every new/updated row but does not fail on the existing
-- invalid November 2026 row; that row can only leave this state via the audited
-- reversal below. VALIDATE it once November has been corrected and resubmitted.
alter table scorecard_reviews
  add constraint scorecard_reviews_final_has_score
  check (status = 'draft' or overall_score is not null) not valid;

-- ── The one sanctioned Final -> Draft path ───────────────────────────────

-- Same protection as 0092, plus a single exception: a transaction-local setting
-- naming THIS review, set only inside scorecard_reverse_finalisation, permits
-- the transition to 'draft'. Any other mutation of a final review still raises.
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
    if new.status = 'draft' and current_setting('app.scorecard_reversal', true) = old.id::text then
      return new;
    end if;
    raise exception 'scorecard_reviews %: a finalised review is immutable', old.id;
  end if;
  return new;
end;
$$;

-- ── Atomic finalise ──────────────────────────────────────────────────────

create or replace function scorecard_finalise_review(
  p_review_id uuid,
  p_org_id uuid,
  p_actor uuid,
  p_overall_score numeric,
  p_snapshot jsonb
) returns void language plpgsql set search_path = public as $$
declare
  v_review scorecard_reviews%rowtype;
  v_expected int;
  v_bad int;
begin
  select * into v_review from scorecard_reviews where id = p_review_id and organization_id = p_org_id for update;
  if not found then
    raise exception 'review not found';
  end if;
  if v_review.status <> 'draft' then
    raise exception 'review is not a draft (status: %)', v_review.status;
  end if;
  if p_overall_score is null or p_overall_score < 0 or p_overall_score > 10 then
    raise exception 'cannot finalise: the overall score is required and must be between 0 and 10';
  end if;
  if p_snapshot is null then
    raise exception 'cannot finalise: the scorecard definition snapshot is required';
  end if;

  -- Hold the result rows so a concurrent save cannot change a score between this
  -- validation and the status flip (a blocked save then hits the final-review trigger).
  perform 1 from scorecard_metric_results where review_id = p_review_id for update;

  select count(*) into v_expected
  from scorecard_metric_definitions d
  join scorecard_sections s on s.id = d.scorecard_section_id
  where s.scorecard_definition_id = v_review.scorecard_definition_id and d.active;

  if v_expected = 0 then
    raise exception 'cannot finalise: the scorecard has no active KPIs';
  end if;

  -- Missing = no result row or NULL score. A score of 0 is a real score.
  select count(*) into v_bad
  from scorecard_metric_definitions d
  join scorecard_sections s on s.id = d.scorecard_section_id
  left join scorecard_metric_results r on r.metric_definition_id = d.id and r.review_id = p_review_id
  where s.scorecard_definition_id = v_review.scorecard_definition_id
    and d.active
    and (r.score is null or r.score < 0 or r.score > 10);

  if v_bad > 0 then
    raise exception 'cannot finalise: % of % KPIs are missing a valid score', v_bad, v_expected;
  end if;

  update scorecard_reviews
  set status = 'final', overall_score = p_overall_score, definition_snapshot = p_snapshot,
      finalised_by = p_actor, finalised_at = now(), updated_at = now()
  where id = p_review_id;

  insert into scorecard_review_events (review_id, organization_id, event_type, previous_status, new_status, actor_user_id, overall_score, original_finalised_by, original_finalised_at, definition_snapshot)
  values (p_review_id, p_org_id, 'finalised', 'draft', 'final', p_actor, p_overall_score, p_actor, now(), p_snapshot);
end;
$$;

-- ── Atomic, audited reversal ─────────────────────────────────────────────

create or replace function scorecard_reverse_finalisation(
  p_review_id uuid,
  p_org_id uuid,
  p_actor uuid,
  p_reason text
) returns void language plpgsql set search_path = public as $$
declare
  v_review scorecard_reviews%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'a reason of at least 5 characters is required';
  end if;

  -- Row lock: a repeated or concurrent reversal/finalise waits here, then sees the
  -- committed status and is refused below rather than acting on stale state.
  select * into v_review from scorecard_reviews where id = p_review_id and organization_id = p_org_id for update;
  if not found then
    raise exception 'review not found';
  end if;
  if v_review.status <> 'final' then
    raise exception 'review is not finalised (status: %)', v_review.status;
  end if;

  -- Audit first, capturing the finalisation being reversed.
  insert into scorecard_review_events (review_id, organization_id, event_type, previous_status, new_status, actor_user_id, reason, overall_score, original_finalised_by, original_finalised_at, definition_snapshot)
  values (p_review_id, p_org_id, 'finalisation_reversed', 'final', 'draft', p_actor, btrim(p_reason), v_review.overall_score, v_review.finalised_by, v_review.finalised_at, v_review.definition_snapshot);

  -- KPI result rows are deliberately NOT touched: every entered value survives.
  perform set_config('app.scorecard_reversal', p_review_id::text, true);
  update scorecard_reviews
  set status = 'draft', overall_score = null, definition_snapshot = null, finalised_by = null, finalised_at = null, updated_at = now()
  where id = p_review_id;
  perform set_config('app.scorecard_reversal', '', true);
end;
$$;

-- Callable by the service role only (the server actions); never by a browser session.
revoke all on function scorecard_finalise_review(uuid, uuid, uuid, numeric, jsonb) from public, anon, authenticated;
revoke all on function scorecard_reverse_finalisation(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function scorecard_finalise_review(uuid, uuid, uuid, numeric, jsonb) to service_role;
grant execute on function scorecard_reverse_finalisation(uuid, uuid, uuid, text) to service_role;
