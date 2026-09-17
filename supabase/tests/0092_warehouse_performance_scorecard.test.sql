-- Transactional test for migration 0092 (Warehouse Performance Scorecard
-- generic engine). BEGIN/ROLLBACK: safe against any DB with 0092 applied,
-- leaves no rows. Expect it to print "ALL 0092 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000d1', 'Scorecard Test Org A');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000d2', 'Scorecard Test Org B');

-- --- RLS + grants posture ----------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from pg_tables
    where schemaname = 'public'
      and tablename in ('scorecard_definitions', 'scorecard_sections', 'scorecard_metric_definitions',
                         'organization_scorecards', 'scorecard_reviews', 'scorecard_metric_results', 'scorecard_actions')
      and rowsecurity;
  if n <> 7 then raise exception 'expected RLS enabled on all 7 scorecard tables, got %', n; end if;

  -- Template tables: exactly one SELECT policy, no write policy (writes go
  -- through service-role only, per 0092's own comment).
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_definitions';
  if n <> 1 then raise exception 'scorecard_definitions should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_definitions' and cmd = 'SELECT';
  if n <> 1 then raise exception 'scorecard_definitions policy should be SELECT-only, got % SELECT policies', n; end if;

  -- Org-scoped tables: also exactly one SELECT policy each (read-only RLS,
  -- same discipline as quotes/custom_reports — see 0092's own comment on
  -- why finalised-review immutability is safer with no client write path).
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_reviews';
  if n <> 1 then raise exception 'scorecard_reviews should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_metric_results';
  if n <> 1 then raise exception 'scorecard_metric_results should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_actions';
  if n <> 1 then raise exception 'scorecard_actions should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'organization_scorecards';
  if n <> 1 then raise exception 'organization_scorecards should have exactly 1 policy, got %', n; end if;
end $$;

-- --- Section weight-sum trigger ----------------------------------------------
do $$
declare
  def_id uuid;
begin
  insert into scorecard_definitions (name) values ('Weight Trigger Test Scorecard') returning id into def_id;

  -- Six sections summing to exactly 1.0, inserted in ONE statement -> succeeds.
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values
    (def_id, 'A', 0.20, 1), (def_id, 'B', 0.20, 2), (def_id, 'C', 0.20, 3),
    (def_id, 'D', 0.15, 4), (def_id, 'E', 0.15, 5), (def_id, 'F', 0.10, 6);

  -- Adding a seventh section without rebalancing breaks the sum -> must raise.
  begin
    insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values (def_id, 'G', 0.10, 7);
    raise exception 'expected the weight-sum trigger to reject an unbalanced INSERT, but it succeeded';
  exception when others then
    if sqlerrm not like '%must sum to 1.0%' then raise; end if;
  end;

  -- Updating one section's weight to break the sum -> must raise.
  begin
    update scorecard_sections set weight = 0.99 where scorecard_definition_id = def_id and name = 'A';
    raise exception 'expected the weight-sum trigger to reject an unbalanced UPDATE, but it succeeded';
  exception when others then
    if sqlerrm not like '%must sum to 1.0%' then raise; end if;
  end;

  -- Deleting one section without rebalancing the rest breaks the sum -> must raise.
  begin
    delete from scorecard_sections where scorecard_definition_id = def_id and name = 'F';
    raise exception 'expected the weight-sum trigger to reject an unbalancing DELETE, but it succeeded';
  exception when others then
    if sqlerrm not like '%must sum to 1.0%' then raise; end if;
  end;

  -- Deleting every section for a definition at once leaves nothing to
  -- validate, and must NOT raise (the cascade-delete-the-whole-definition
  -- case).
  delete from scorecard_sections where scorecard_definition_id = def_id;

  delete from scorecard_definitions where id = def_id;
end $$;

-- --- organization_scorecards: at most one ENABLED assignment per org --------
do $$
declare
  def1 uuid;
  def2 uuid;
  org uuid := '00000000-0000-0000-0000-0000000000d1';
begin
  insert into scorecard_definitions (name) values ('Org Assignment Test 1') returning id into def1;
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values (def1, 'Only', 1.0, 1);
  insert into scorecard_definitions (name) values ('Org Assignment Test 2') returning id into def2;
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values (def2, 'Only', 1.0, 1);

  insert into organization_scorecards (organization_id, scorecard_definition_id, enabled) values (org, def1, true);

  begin
    insert into organization_scorecards (organization_id, scorecard_definition_id, enabled) values (org, def2, true);
    raise exception 'expected a second ENABLED scorecard for the same org to be rejected, but it succeeded';
  exception when unique_violation then
    null; -- expected
  end;

  -- A DISABLED second assignment for the same org is fine (history/future use).
  insert into organization_scorecards (organization_id, scorecard_definition_id, enabled) values (org, def2, false);

  delete from organization_scorecards where organization_id = org;
  delete from scorecard_sections where scorecard_definition_id in (def1, def2);
  delete from scorecard_definitions where id in (def1, def2);
end $$;

-- --- Historical snapshot immutability (brief §11, non-negotiable) -----------
do $$
declare
  def_id uuid;
  section_id uuid;
  metric_id uuid;
  review_id uuid;
  result_id uuid;
  org uuid := '00000000-0000-0000-0000-0000000000d1';
begin
  insert into scorecard_definitions (name) values ('Immutability Test Scorecard') returning id into def_id;
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values (def_id, 'Only Section', 1.0, 1) returning id into section_id;
  insert into scorecard_metric_definitions (scorecard_section_id, category, name, evidence_source, scoring_method, metric_direction, display_order)
    values (section_id, 'Test', 'Test KPI', 'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1) returning id into metric_id;

  insert into scorecard_reviews (organization_id, scorecard_definition_id, review_period, status)
    values (org, def_id, '2026-09-01', 'draft') returning id into review_id;
  insert into scorecard_metric_results (review_id, metric_definition_id, score, status)
    values (review_id, metric_id, 8, 'acceptable') returning id into result_id;

  -- A draft review's own results CAN be edited freely.
  update scorecard_metric_results set score = 9, status = 'strong' where id = result_id;

  -- Finalising requires the snapshot + finalised_at (the CHECK constraint) —
  -- confirm the constraint itself blocks a status flip with no snapshot.
  begin
    update scorecard_reviews set status = 'final' where id = review_id;
    raise exception 'expected finalising without a snapshot/finalised_at to be rejected by the CHECK constraint, but it succeeded';
  exception when others then
    if sqlerrm not like '%scorecard_reviews_final_has_snapshot%' then raise; end if;
  end;

  update scorecard_reviews
    set status = 'final', overall_score = 9, definition_snapshot = '{"scorecardDefinitionId":"x"}'::jsonb, finalised_at = now()
    where id = review_id;

  -- Now the review is final: its own columns must be immutable.
  begin
    update scorecard_reviews set overall_score = 5 where id = review_id;
    raise exception 'expected mutating a finalised review''s overall_score to be rejected, but it succeeded';
  exception when others then
    if sqlerrm not like '%finalised review is immutable%' then raise; end if;
  end;

  -- And its metric_results must be immutable too — neither UPDATE...
  begin
    update scorecard_metric_results set score = 1 where id = result_id;
    raise exception 'expected mutating a finalised review''s metric result to be rejected, but it succeeded';
  exception when others then
    if sqlerrm not like '%is finalised and its results are immutable%' then raise; end if;
  end;

  -- ...nor DELETE.
  begin
    delete from scorecard_metric_results where id = result_id;
    raise exception 'expected deleting a finalised review''s metric result to be rejected, but it succeeded';
  exception when others then
    if sqlerrm not like '%is finalised and its results are immutable%' then raise; end if;
  end;

  -- Cleanup: cascading delete from scorecard_definitions removes everything
  -- below it (sections/metrics/reviews/results), even the finalised review —
  -- cascade delete is not blocked by the mutation-prevention triggers, only
  -- UPDATE/DELETE of the row's own content is.
  delete from scorecard_definitions where id = def_id;
end $$;

-- --- Not-Scored is a real, distinct state, not silently zero ----------------
do $$
declare
  def_id uuid;
  section_id uuid;
  metric_id uuid;
  review_id uuid;
  org uuid := '00000000-0000-0000-0000-0000000000d2';
begin
  insert into scorecard_definitions (name) values ('Null Score Test Scorecard') returning id into def_id;
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values (def_id, 'Only Section', 1.0, 1) returning id into section_id;
  insert into scorecard_metric_definitions (scorecard_section_id, category, name, evidence_source, scoring_method, metric_direction, display_order)
    values (section_id, 'Test', 'Test KPI', 'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1) returning id into metric_id;
  insert into scorecard_reviews (organization_id, scorecard_definition_id, review_period, status) values (org, def_id, '2026-09-01', 'draft') returning id into review_id;

  -- score = NULL ("Not Scored") is explicitly permitted, not coerced.
  insert into scorecard_metric_results (review_id, metric_definition_id, score, status) values (review_id, metric_id, null, 'not_scored');

  -- score = 11 (out of the 0-10 range) is rejected by the CHECK constraint.
  begin
    update scorecard_metric_results set score = 11 where metric_definition_id = metric_id;
    raise exception 'expected a score of 11 to be rejected by the 0-10 CHECK constraint, but it succeeded';
  exception when check_violation then
    null; -- expected
  end;

  delete from scorecard_definitions where id = def_id;
end $$;

do $$ begin raise notice 'ALL 0092 WAREHOUSE PERFORMANCE SCORECARD TESTS PASSED'; end $$;

rollback;
